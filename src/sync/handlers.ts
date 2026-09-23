import { config } from '../config.js';
import { logger } from '../logger.js';
import { query } from '../db/pool.js';
import { providerClient } from '../provider/client.js';
import { getCoverage, upsertCompetitionSeason, upsertPlayerTeamHistory, resolveCompetitionSeason } from '../repos/lookups.js';
import { upsertTeam, upsertTeamSeason } from '../repos/lookups.js';
import { upsertFixture, storeFixtureEvents, storeFixtureTeamStats, storePlayerMatchStats, storeLineups, storeStandings, storeInjuries, storeTransfers, storeOdds } from '../repos/fixtures.js';
import { mapCompetition, mapSeasons, mapCoverage, mapCountry } from '../mapping/leagues.js';
import { mapTeam } from '../mapping/teams.js';
import { mapFixture, mapEvents, mapTeamStats, mapPlayerMatchStats, mapLineups, mapStandings, mapInjuries, mapTransfers, mapOdds, mapPlayer, isLiveStatus } from '../mapping/fixtures.js';
import { recalcRefereeMatchStats, recalcRefereeSeasonStats, recalcRefereeCompetitionStats } from '../analytics/referee.js';
import { recalcLeagueStatistics } from '../analytics/league.js';
import { recalcTeamStatistics, updateStreaks } from '../analytics/team.js';
import { recalcPlayerSeasonStatistics } from '../analytics/player.js';
import { buildPredictionFeatures, rebuildUpcomingFeatures, invalidateFixtureCache } from '../analytics/features.js';
import { cacheSetJson, cacheDelPattern } from '../redis/client.js';
import type { CoverageRow } from '../mapping/leagues.js';
import type { AFFixtureResponse, AFLeague } from '../provider/types.js';
import type { SyncTask } from './tasksDb.js';
import { setSyncState } from './tasksDb.js';

const log = logger.child({ mod: 'sync-handlers' });

export type TaskHandler = (task: SyncTask) => Promise<Record<string, unknown> | void>;

export const taskHandlers: Record<string, TaskHandler> = {};
function handler(type: string, fn: TaskHandler): void {
  taskHandlers[type] = fn;
}

// ---------------------------------------------------------------------------
// IMPORT: leagues catalogue + seasons + coverage
// ---------------------------------------------------------------------------
handler('import.leagues', async (task) => {
  const res = await providerClient.get('leagues', {}, { priority: 'medium', rawEntityType: 'leagues' });
  const leagues = res.envelope.response as AFLeague[];
  let competitions = 0;
  let seasons = 0;
  for (const lg of leagues) {
    const competition = mapCompetition(lg);
    const seasonRows = mapSeasons(lg);
    for (const season of seasonRows) {
      await upsertCompetitionSeason(competition, season, mapCoverage(lg.seasons?.find((s) => s.year === season.year)?.coverage));
      seasons++;
    }
    competitions++;
  }
  log.info({ competitions, seasons }, 'leagues catalogue imported');
  return { competitions, seasons };
});

/** Import scope: configured league ids (or curated default) × [current-3 .. current] */
export async function importScope(): Promise<{ leagueIds: number[]; seasonYears: number[] }> {
  let leagueIds = config.import.leagueIds;
  if (!leagueIds.length) {
    // curated default scope: major competitions (kept explicit & documented)
    leagueIds = [39, 140, 135, 78, 61, 94, 88, 144, 143, 106, 253, 71, 119, 207, 218, 188, 179, 307, 292, 293];
  }
  const currentYear = new Date().getUTCMonth() >= 5 ? new Date().getUTCFullYear() : new Date().getUTCFullYear() - 1;
  const seasonYears: number[] = [];
  for (let i = 0; i <= config.import.previousSeasons; i++) seasonYears.push(currentYear - i);
  return { leagueIds, seasonYears };
}

/** Create the full historical import plan as resumable tasks. */
export async function planHistoricalImport(jobId?: number): Promise<{ tasks: number }> {
  const { leagueIds, seasonYears } = await importScope();
  const currentYear = seasonYears[0];
  const detailYears = new Set<number>();
  for (let i = 0; i < config.import.historicalDetailSeasons; i++) detailYears.add(currentYear - i);

  let count = 0;
  const { enqueueTask } = await import('./tasksDb.js');
  for (const leagueId of leagueIds) {
    for (const year of seasonYears) {
      const t = await enqueueTask(
        'cs.bootstrap',
        { leagueId, seasonYear: year, withDetail: detailYears.has(year) },
        { jobId, priority: 3, uniqueKey: `cs.bootstrap:${leagueId}:${year}` },
      );
      if (!t.reused) count++;
    }
  }
  return { tasks: count };
}

/** Bootstrap one competition-season: coverage → fixtures/teams/standings/details tasks. */
handler('cs.bootstrap', async (task) => {
  const { leagueId, seasonYear, withDetail } = task.payload as { leagueId: number; seasonYear: number; withDetail: boolean };

  // 1. competition season + coverage
  const res = await providerClient.get('leagues', { id: leagueId, season: seasonYear }, { priority: 'medium', syncTaskId: task.id, rawEntityType: 'league' });
  const league = (res.envelope.response as AFLeague[])[0];
  if (!league) {
    log.warn({ leagueId, seasonYear }, 'league/season not found at provider — skipping');
    return { skipped: true };
  }
  const csRef = await upsertCompetitionSeason(mapCompetition(league), mapSeasons(league)[0], mapCoverage(league.seasons?.[0]?.coverage));
  const coverage = await getCoverage(csRef.competitionSeasonId);

  const { enqueueTask } = await import('./tasksDb.js');
  const base = { competitionSeasonId: csRef.competitionSeasonId, leagueId, seasonYear };

  // 2. core data tasks
  await enqueueTask('cs.fixtures', base, { priority: 3, uniqueKey: `cs.fixtures:${leagueId}:${seasonYear}` });
  await enqueueTask('cs.teams', base, { priority: 3, uniqueKey: `cs.teams:${leagueId}:${seasonYear}` });
  if (coverage?.standings) {
    await enqueueTask('cs.standings', base, { priority: 3, uniqueKey: `cs.standings:${leagueId}:${seasonYear}` });
  }
  if (coverage?.injuries) {
    await enqueueTask('cs.injuries', base, { priority: 2, uniqueKey: `cs.injuries:${leagueId}:${seasonYear}` });
  }
  if (coverage?.topScorers || coverage?.topAssists || coverage?.topCards) {
    await enqueueTask('cs.toplists', base, { priority: 2, uniqueKey: `cs.toplists:${leagueId}:${seasonYear}` });
  }
  if (withDetail && coverage?.players) {
    await enqueueTask('cs.players', base, { priority: 2, uniqueKey: `cs.players:${leagueId}:${seasonYear}` });
  }
  await enqueueTask('cs.stats', base, { priority: 4, uniqueKey: `cs.stats:${leagueId}:${seasonYear}`, scheduledAt: new Date(Date.now() + 60_000) });
  if (csRef.competitionSeasonId) {
    await enqueueTask('cs.finalize', base, { priority: 4, uniqueKey: `cs.finalize:${leagueId}:${seasonYear}`, scheduledAt: new Date(Date.now() + 90_000) });
  }
  return { competitionSeasonId: csRef.competitionSeasonId };
});

// ---------------------------------------------------------------------------
// CS-LEVEL FETCHES
// ---------------------------------------------------------------------------
handler('cs.fixtures', async (task) => {
  const { leagueId, seasonYear } = task.payload as { leagueId: number; seasonYear: number };
  const cs = await resolveCompetitionSeason(leagueId, seasonYear);
  if (!cs) throw new Error(`competition_season missing for league ${leagueId} season ${seasonYear}`);

  const res = await providerClient.get('fixtures', { league: leagueId, season: seasonYear }, { priority: 'medium', syncTaskId: task.id, rawEntityType: 'fixtures' });
  const fixtures = res.envelope.response as AFFixtureResponse[];
  let stored = 0;
  const { enqueueTask } = await import('./tasksDb.js');
  const detailDepthYears = await detailSeasonYears();

  for (const f of fixtures) {
    const row = mapFixture(f);
    const { id, changed } = await upsertFixture(row);
    stored++;
    // queue per-fixture deep fetch for finished fixtures of detail seasons
    if (row.isFinished && detailDepthYears.has(seasonYear)) {
      await enqueueFixtureDetail(id, leagueId, seasonYear, enqueueTask, task.id);
    }
    // current season: schedule finalize for any finished fixture not yet finalized
    if (row.isFinished && changed) {
      await enqueueTask('postmatch.finalize', { fixtureId: id, leagueId, seasonYear }, { priority: 7, uniqueKey: `postmatch:${id}` });
    }
  }
  log.info({ leagueId, seasonYear, fixtures: stored }, 'cs fixtures imported');
  return { fixtures: stored };
});

async function detailSeasonYears(): Promise<Set<number>> {
  const { seasonYears } = await importScope();
  const years = new Set<number>();
  for (let i = 0; i < config.import.historicalDetailSeasons; i++) years.add(seasonYears[0] - i);
  return years;
}

export async function enqueueFixtureDetail(
  fixtureInternalId: number,
  leagueId: number,
  seasonYear: number,
  enqueue: typeof import('./tasksDb.js').enqueueTask,
  parentTaskId?: number,
): Promise<void> {
  const cs = await resolveCompetitionSeason(leagueId, seasonYear);
  const coverage = cs ? await getCoverage(cs.competitionSeasonId) : null;
  await enqueue(
    'fixture.details',
    { fixtureId: fixtureInternalId, leagueId, seasonYear, coverage },
    { priority: seasonYear === (await importScope()).seasonYears[0] ? 5 : 3, uniqueKey: `fixture.details:${fixtureInternalId}` },
  );
  void parentTaskId;
}

handler('fixture.details', async (task) => {
  const { fixtureId, leagueId, seasonYear } = task.payload as { fixtureId: number; leagueId: number; seasonYear: number };
  const cs = await resolveCompetitionSeason(leagueId, seasonYear);
  const coverage = task.payload.coverage as CoverageRow | undefined ?? (cs ? await getCoverage(cs.competitionSeasonId) : null);
  const providerFixtureId = (
    await query<{ provider_id: string }>(`SELECT provider_id FROM fixtures WHERE id = $1`, [fixtureId])
  ).rows[0]?.provider_id;
  if (!providerFixtureId) throw new Error(`fixture ${fixtureId} has no provider id`);
  const fx = { id: providerFixtureId };

  let fetched = 0;
  if (coverage?.events) {
    const ev = await providerClient.get('fixtures/events', fx, { priority: 'low', syncTaskId: task.id, rawEntityType: 'fixture_events' });
    await storeFixtureEvents(fixtureId, mapEvents(Number(providerFixtureId), ev.envelope.response as never));
    fetched++;
  }
  if (coverage?.fixtureStatistics) {
    const st = await providerClient.get('fixtures/statistics', fx, { priority: 'low', syncTaskId: task.id, rawEntityType: 'fixture_stats' });
    await storeFixtureTeamStats(fixtureId, mapTeamStats(st.envelope.response as never));
    fetched++;
  }
  if (coverage?.lineups) {
    const lu = await providerClient.get('fixtures/lineups', fx, { priority: 'low', syncTaskId: task.id, rawEntityType: 'fixture_lineups' });
    await storeLineups(fixtureId, mapLineups(lu.envelope.response as never));
    fetched++;
  }
  if (coverage?.playerStatistics) {
    const ps = await providerClient.get('fixtures/players', fx, { priority: 'low', syncTaskId: task.id, rawEntityType: 'fixture_playerstats' });
    await storePlayerMatchStats(fixtureId, mapPlayerMatchStats(ps.envelope.response as never), { competitionSeasonId: cs?.competitionSeasonId });
    fetched++;
  }
  return { fetched };
});

handler('cs.teams', async (task) => {
  const { leagueId, seasonYear } = task.payload as { leagueId: number; seasonYear: number };
  const cs = await resolveCompetitionSeason(leagueId, seasonYear);
  if (!cs) throw new Error('cs missing');
  const res = await providerClient.get('teams', { league: leagueId, season: seasonYear }, { priority: 'medium', syncTaskId: task.id, rawEntityType: 'teams' });
  const { enqueueTask } = await import('./tasksDb.js');
  let n = 0;
  for (const raw of res.envelope.response as { team: Parameters<typeof mapTeam>[0] }[]) {
    const teamId = await upsertTeam(mapTeam(raw.team));
    await upsertTeamSeason(teamId, cs.competitionSeasonId);
    await enqueueTask('team.meta', { teamId, providerTeamId: raw.team.id }, { priority: 2, uniqueKey: `team.meta:${raw.team.id}` });
    n++;
  }
  return { teams: n };
});

/** team metadata: coaches + transfers (low priority, quota-aware). */
handler('team.meta', async (task) => {
  const { teamId, providerTeamId } = task.payload as { teamId: number; providerTeamId: number };
  const { mapCoach } = await import('../mapping/fixtures.js');
  const { upsertCoach } = await import('../repos/lookups.js');
  const ch = await providerClient.get('coachs', { team: providerTeamId }, { priority: 'low', syncTaskId: task.id, rawEntityType: 'coachs' });
  let coaches = 0;
  for (const raw of ch.envelope.response as Parameters<typeof mapCoach>[0][]) {
    await upsertCoach(mapCoach(raw));
    coaches++;
  }
  // transfers
  const tr = await providerClient.get('transfers', { team: providerTeamId }, { priority: 'low', syncTaskId: task.id, rawEntityType: 'transfers' });
  let transfers = 0;
  for (const t of tr.envelope.response as Parameters<typeof mapTransfers>[0][]) {
    const rows = mapTransfers(t);
    await storeTransfers(rows);
    transfers += rows.length;
  }
  await setSyncState(`team.meta:${providerTeamId}`, { teamId, transfers, at: new Date().toISOString() });
  return { coaches, transfers };
});

handler('cs.standings', async (task) => {
  const { leagueId, seasonYear } = task.payload as { leagueId: number; seasonYear: number };
  const cs = await resolveCompetitionSeason(leagueId, seasonYear);
  if (!cs) throw new Error('cs missing');
  const res = await providerClient.get('standings', { league: leagueId, season: seasonYear }, { priority: 'medium', syncTaskId: task.id, rawEntityType: 'standings' });
  let stored = 0;
  for (const leagueBlock of res.envelope.response as { league?: { standings?: Parameters<typeof mapStandings>[0][][]; seasons?: { year: number; current?: boolean }[] } }[]) {
    for (const group of leagueBlock.league?.standings ?? []) {
      stored += await storeStandings(cs.competitionSeasonId, mapStandings(group.flat()), null);
    }
  }
  return { rows: stored };
});

handler('cs.injuries', async (task) => {
  const { leagueId, seasonYear } = task.payload as { leagueId: number; seasonYear: number };
  const res = await providerClient.get('injuries', { league: leagueId, season: seasonYear }, { priority: 'low', syncTaskId: task.id, rawEntityType: 'injuries' });
  const rows = mapInjuries(res.envelope.response as never);
  await storeInjuries(rows);
  return { injuries: rows.length };
});

handler('cs.toplists', async (task) => {
  const { leagueId, seasonYear } = task.payload as { leagueId: number; seasonYear: number };
  const cs = await resolveCompetitionSeason(leagueId, seasonYear);
  const coverage = cs ? await getCoverage(cs.competitionSeasonId) : null;
  let players = 0;
  const endpoints: [string, boolean][] = [
    ['topscorers', Boolean(coverage?.topScorers)],
    ['topassists', Boolean(coverage?.topAssists)],
    ['topyellowcards', Boolean(coverage?.topCards)],
    ['topredcards', Boolean(coverage?.topCards)],
  ];
  for (const [endpoint, enabled] of endpoints) {
    if (!enabled) continue;
    const res = await providerClient.get(endpoint, { league: leagueId, season: seasonYear }, { priority: 'low', syncTaskId: task.id, rawEntityType: endpoint });
    for (const entry of res.envelope.response as { player: Parameters<typeof mapPlayer>[0]; statistics: { team?: { id: number } }[] }[]) {
      const playerId = await (await import('../repos/lookups.js')).upsertPlayer(mapPlayer(entry.player));
      for (const stat of entry.statistics ?? []) {
        if (stat.team?.id) {
          const teamId = (await query<{ id: number }>(`SELECT id FROM teams WHERE provider='api-football' AND provider_id=$1`, [stat.team.id])).rows[0]?.id;
          if (teamId) await upsertPlayerTeamHistory(playerId, teamId, cs?.competitionSeasonId ?? null);
        }
      }
      players++;
    }
  }
  return { players };
});

/** Full season player list (expensive, paginated) — only for detail seasons with coverage. */
handler('cs.players', async (task) => {
  const { leagueId, seasonYear } = task.payload as { leagueId: number; seasonYear: number };
  const cs = await resolveCompetitionSeason(leagueId, seasonYear);
  if (!cs) throw new Error('cs missing');
  const pages = await providerClient.getAllPages('players', { league: leagueId, season: seasonYear }, { priority: 'low', syncTaskId: task.id, rawEntityType: 'players' });
  let players = 0;
  for (const page of pages) {
    for (const entry of page.response as { player: Parameters<typeof mapPlayer>[0]; statistics: { team?: { id: number } }[] }[]) {
      const playerId = await (await import('../repos/lookups.js')).upsertPlayer(mapPlayer(entry.player));
      for (const stat of entry.statistics ?? []) {
        if (stat.team?.id) {
          const teamId = (await query<{ id: number }>(`SELECT id FROM teams WHERE provider='api-football' AND provider_id=$1`, [stat.team.id])).rows[0]?.id;
          if (teamId) await upsertPlayerTeamHistory(playerId, teamId, cs.competitionSeasonId);
        }
      }
      players++;
    }
  }
  return { players };
});

// ---------------------------------------------------------------------------
// LOCAL RECALCULATIONS (no provider quota)
// ---------------------------------------------------------------------------
handler('cs.stats', async (task) => {
  const { leagueId, seasonYear } = task.payload as { leagueId: number; seasonYear: number };
  const cs = await resolveCompetitionSeason(leagueId, seasonYear);
  if (!cs) throw new Error('cs missing');
  await recalcLeagueStatistics(cs.competitionSeasonId);
  await recalcTeamStatistics(cs.competitionSeasonId);
  await updateStreaks(cs.competitionSeasonId);
  await recalcPlayerSeasonStatistics(cs.competitionSeasonId);
  await recalcRefereeMatchStats(cs.competitionSeasonId);
  await recalcRefereeSeasonStats(cs.competitionSeasonId);
  await recalcRefereeCompetitionStats();
  return { competitionSeasonId: cs.competitionSeasonId };
});

handler('cs.finalize', async (task) => {
  const { leagueId, seasonYear } = task.payload as { leagueId: number; seasonYear: number };
  const cs = await resolveCompetitionSeason(leagueId, seasonYear);
  if (!cs) throw new Error('cs missing');
  await rebuildUpcomingFeatures(cs.competitionSeasonId);
  await warmCacheForSeason(cs.competitionSeasonId);
  return { competitionSeasonId: cs.competitionSeasonId };
});

// ---------------------------------------------------------------------------
// POST-MATCH PIPELINE
// ---------------------------------------------------------------------------
handler('postmatch.finalize', async (task) => {
  const { fixtureId, leagueId, seasonYear } = task.payload as { fixtureId: number; leagueId?: number; seasonYear?: number };
  const fx = (
    await query<{ provider_id: string; competition_provider_id: string; season_year: number; competition_season_id: number; status_short: string | null; finalized_at: Date | null }>(
      `SELECT f.provider_id::text, c.provider_id::text AS competition_provider_id, f.season_year,
              f.competition_season_id, f.status_short, f.finalized_at
       FROM fixtures f JOIN competitions c ON c.id = f.competition_id WHERE f.id = $1`,
      [fixtureId],
    )
  ).rows[0];
  if (!fx) throw new Error(`fixture ${fixtureId} missing`);
  if (fx.finalized_at) return { alreadyFinalized: true };

  const leagueIdResolved = leagueId ?? Number(fx.competition_provider_id);
  const seasonYearResolved = seasonYear ?? fx.season_year;
  const cs = await resolveCompetitionSeason(leagueIdResolved, seasonYearResolved);
  const coverage = cs ? await getCoverage(cs.competitionSeasonId) : null;

  // fetch final details (re-fetch is intentional: final events/stats may have been corrected by provider)
  const params = { id: fx.provider_id };
  if (coverage?.events) {
    const ev = await providerClient.get('fixtures/events', params, { priority: 'high', syncTaskId: task.id, cacheTtlSeconds: 0, rawEntityType: 'fixture_events' });
    await storeFixtureEvents(fixtureId, mapEvents(Number(fx.provider_id), ev.envelope.response as never));
  }
  if (coverage?.fixtureStatistics) {
    const st = await providerClient.get('fixtures/statistics', params, { priority: 'high', syncTaskId: task.id, cacheTtlSeconds: 0, rawEntityType: 'fixture_stats' });
    await storeFixtureTeamStats(fixtureId, mapTeamStats(st.envelope.response as never));
  }
  if (coverage?.lineups) {
    const lu = await providerClient.get('fixtures/lineups', params, { priority: 'high', syncTaskId: task.id, cacheTtlSeconds: 0, rawEntityType: 'fixture_lineups' });
    await storeLineups(fixtureId, mapLineups(lu.envelope.response as never));
  }
  if (coverage?.playerStatistics) {
    const ps = await providerClient.get('fixtures/players', params, { priority: 'high', syncTaskId: task.id, cacheTtlSeconds: 0, rawEntityType: 'fixture_playerstats' });
    await storePlayerMatchStats(fixtureId, mapPlayerMatchStats(ps.envelope.response as never), { competitionSeasonId: cs?.competitionSeasonId });
  }

  // mark finalized
  await query(`UPDATE fixtures SET finalized_at = now() WHERE id = $1 AND finalized_at IS NULL`, [fixtureId]);

  // refresh derived data affected by this result
  if (cs) {
    await recalcLeagueStatistics(cs.competitionSeasonId);
    await recalcTeamStatistics(cs.competitionSeasonId);
    await updateStreaks(cs.competitionSeasonId);
    await recalcPlayerSeasonStatistics(cs.competitionSeasonId);
    await recalcRefereeMatchStats(cs.competitionSeasonId);
    await recalcRefereeSeasonStats(cs.competitionSeasonId);
    await recalcRefereeCompetitionStats();
  }

  await invalidateFixtureCache(fixtureId);
  await buildPredictionFeatures(fixtureId);
  if (cs) await warmCacheForSeason(cs.competitionSeasonId);
  log.info({ fixtureId }, 'post-match pipeline completed');
  return { finalized: true };
});

// ---------------------------------------------------------------------------
// CURRENT-SEASON SYNC
// ---------------------------------------------------------------------------
handler('sync.live', async (task) => {
  const res = await providerClient.get('fixtures', { live: 'all' }, { priority: 'live', syncTaskId: task.id, cacheTtlSeconds: 30, rawEntityType: 'live' });
  const fixtures = res.envelope.response as AFFixtureResponse[];
  const liveIds: number[] = [];
  const { enqueueTask } = await import('./tasksDb.js');
  for (const f of fixtures) {
    const row = mapFixture(f);
    const { id, changed } = await upsertFixture(row);
    liveIds.push(id);
    if (row.isFinished && changed) {
      await enqueueTask('postmatch.finalize', { fixtureId: id }, { priority: 8, uniqueKey: `postmatch:${id}` });
    }
  }
  // cache the live list for our API
  await cacheSetJson('live:fixtures', { fixtureIds: liveIds, at: new Date().toISOString() }, 120);
  await setSyncState('sync.live', { at: new Date().toISOString(), live: liveIds.length });
  return { live: liveIds.length };
});

handler('sync.upcoming', async (task) => {
  const { leagueId, seasonYear } = (task.payload ?? {}) as { leagueId?: number; seasonYear?: number };
  const { enqueueTask } = await import('./tasksDb.js');
  const current = await currentSeasons();
  const seasons = leagueId && seasonYear ? [{ leagueId, seasonYear }] : current;
  let stored = 0;
  for (const s of seasons) {
    const res = await providerClient.get(
      'fixtures',
      { league: s.leagueId, season: s.seasonYear, next: 50 },
      { priority: 'high', syncTaskId: task.id, cacheTtlSeconds: 300, rawEntityType: 'upcoming' },
    );
    for (const f of res.envelope.response as AFFixtureResponse[]) {
      await upsertFixture(mapFixture(f));
      stored++;
    }
  }
  await rebuildUpcomingFeatures();
  return { stored };
});

handler('sync.standings', async (task) => {
  const current = await currentSeasons();
  let rows = 0;
  for (const s of current) {
    const cs = await resolveCompetitionSeason(s.leagueId, s.seasonYear);
    const coverage = cs ? await getCoverage(cs.competitionSeasonId) : null;
    if (!coverage?.standings) continue;
    const res = await providerClient.get('standings', { league: s.leagueId, season: s.seasonYear }, { priority: 'medium', syncTaskId: task.id, cacheTtlSeconds: 120, rawEntityType: 'standings' });
    for (const leagueBlock of res.envelope.response as { league?: { standings?: Parameters<typeof mapStandings>[0][][] } }[]) {
      for (const group of leagueBlock.league?.standings ?? []) {
        rows += await storeStandings(cs!.competitionSeasonId, mapStandings(group.flat()), null);
      }
    }
    await cacheDelPattern(`api:standings:${cs!.competitionSeasonId}*`);
  }
  return { rows };
});

handler('sync.injuries', async (task) => {
  const current = await currentSeasons();
  let n = 0;
  for (const s of current) {
    const res = await providerClient.get('injuries', { league: s.leagueId, season: s.seasonYear }, { priority: 'low', syncTaskId: task.id, cacheTtlSeconds: 300, rawEntityType: 'injuries' });
    const rows = mapInjuries(res.envelope.response as never);
    await storeInjuries(rows);
    n += rows.length;
  }
  return { injuries: n };
});

handler('features.rebuild', async () => {
  const n = await rebuildUpcomingFeatures();
  return { rebuilt: n };
});

handler('cache.warm', async () => {
  const current = await currentSeasons();
  for (const s of current) {
    const cs = await resolveCompetitionSeason(s.leagueId, s.seasonYear);
    if (cs) await warmCacheForSeason(cs.competitionSeasonId);
  }
  return {};
});

/** Warm Redis with API-shaped data for a competition season. */
export async function warmCacheForSeason(competitionSeasonId: number): Promise<void> {
  try {
    const standings = (
      await query(
        `SELECT sr.*, t.name AS team_name FROM standing_rows sr
         JOIN standings st ON st.id = sr.standings_id
         JOIN teams t ON t.id = sr.team_id
         WHERE st.competition_season_id = $1 ORDER BY sr.rank`,
        [competitionSeasonId],
      )
    ).rows;
    await cacheSetJson(`api:standings:${competitionSeasonId}:default`, standings, 900);
  } catch (err) {
    log.debug({ err: err instanceof Error ? err.message : err }, 'cache warm failed (non-fatal)');
  }
}

/** Current (running) competition seasons from DB. */
export async function currentSeasons(): Promise<{ leagueId: number; seasonYear: number }[]> {
  const { rows } = await query<{ provider_id: string; year: number }>(
    `SELECT cs.provider_id::text, s.year FROM competition_seasons cs
     JOIN seasons s ON s.id = cs.season_id
     WHERE cs.is_current = TRUE AND cs.provider = 'api-football'
       AND cs.provider_id = ANY($1::bigint[])`,
    [(await importScope()).leagueIds],
  );
  return rows.map((r) => ({ leagueId: Number(r.provider_id), seasonYear: r.year }));
}

/** Find finished fixtures that have not been finalized yet → post-match pipeline. */
export async function pendingFinalizations(limit = 200): Promise<number[]> {
  const { rows } = await query<{ id: number }>(
    `SELECT id FROM fixtures WHERE is_finished AND finalized_at IS NULL ORDER BY kickoff_at DESC LIMIT $1`,
    [limit],
  );
  return rows.map((r) => r.id);
}

/** Identify fixtures likely live (kickoff within window, not finished). */
export async function potentiallyLiveCount(): Promise<number> {
  const { rows } = await query<{ n: string }>(
    `SELECT count(*)::text AS n FROM fixtures
     WHERE is_finished = FALSE AND cancelled = FALSE AND postponed = FALSE
       AND kickoff_at BETWEEN now() - interval '3 hours' AND now() + interval '5 hours'`,
  );
  return parseInt(rows[0]?.n ?? '0', 10);
}

export { isLiveStatus };
