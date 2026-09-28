/**
 * Fixtures pipeline: fixture lists (historical/current/live), per-fixture
 * details (events, team statistics, player statistics, lineups), and the
 * post-match pipeline trigger. Historical completed fixtures are treated as
 * immutable and are not re-downloaded unless data is missing/changed.
 */
import { getProvider } from '../../provider/client.js';
import { query, queryOne } from '../../lib/db.js';
import {
  replaceFixtureEvents, resolveRefereeByName, s, upsertFixture, upsertFixtureTeamStatistics,
  upsertLineups, upsertPlayerMatchStatistics, upsertTeam,
} from '../../provider/mapper.js';
import type { AfEvent, AfFixture, AfLineup, AfPlayerStatEntry, AfTeamStatEntry } from '../../provider/types.js';
import { enqueueTask, upsertJob } from '../tasks.js';
import { getCoverage } from './metadata.js';
import { COMPLETED_STATUSES } from '../../types.js';
import { logger } from '../../lib/logger.js';
import { invalidateFixture } from '../../lib/cache.js';

async function resolveFixtureIds(f: AfFixture) {
  const competition = f.league?.id != null
    ? await queryOne<{ id: number }>(`SELECT id FROM competitions WHERE provider_id = $1`, [String(f.league.id)])
    : null;
  const season = f.league?.season != null
    ? await queryOne<{ id: number }>(`SELECT id FROM seasons WHERE year = $1`, [Number(f.league.season)])
    : null;
  const homeTeamId = f.teams?.home?.id != null
    ? await queryOne<{ id: number }>(`SELECT id FROM teams WHERE provider_id = $1`, [String(f.teams.home.id)])
    : null;
  const awayTeamId = f.teams?.away?.id != null
    ? await queryOne<{ id: number }>(`SELECT id FROM teams WHERE provider_id = $1`, [String(f.teams.away.id)])
    : null;
  // teams may not be imported yet (fixtures before teams) — upsert minimal rows
  let h = homeTeamId?.id ?? null;
  let a = awayTeamId?.id ?? null;
  if (!h && f.teams?.home?.id != null) {
    h = await upsertTeam({ id: f.teams.home.id, name: f.teams.home.name, logo: f.teams.home.logo, raw: f.teams.home });
  }
  if (!a && f.teams?.away?.id != null) {
    a = await upsertTeam({ id: f.teams.away.id, name: f.teams.away.name, logo: f.teams.away.logo, raw: f.teams.away });
  }
  const refereeId = await resolveRefereeByName(s(f.referee));
  const venueRow = f.venue?.id != null
    ? await queryOne<{ id: number }>(`SELECT id FROM venues WHERE provider_id = $1`, [String(f.venue.id)])
    : null;
  let venueId = venueRow?.id ?? null;
  if (!venueId && f.venue?.name) {
    const { upsertVenue } = await import('../../provider/mapper.js');
    venueId = await upsertVenue({ id: f.venue.id ?? null, name: f.venue.name, city: f.venue.city ?? null });
  }
  return { competitionId: competition?.id ?? null, seasonId: season?.id ?? null, homeTeamId: h, awayTeamId: a, venueId, refereeId };
}

export interface ImportFixturesResult {
  imported: number;
  changed: number;
  completed: number;
  enqueuedDetails: number;
}

/** Import all fixtures for a competition/season (historical + current). */
export async function importFixturesForCompetitionSeason(competitionId: number, seasonId: number, opts: { fetchDetails?: boolean } = {}): Promise<ImportFixturesResult> {
  const provider = await getProvider();
  const ids = await queryOne<{ provider_id: string; season_year: number }>(
    `SELECT c.provider_id, se.year AS season_year FROM competitions c, seasons se WHERE c.id = $1 AND se.id = $2`,
    [competitionId, seasonId],
  );
  if (!ids) throw new Error(`competition/season not found: ${competitionId}/${seasonId}`);

  const res = await provider.get<AfFixture>('/fixtures', { league: ids.provider_id, season: ids.season_year });
  const result: ImportFixturesResult = { imported: 0, changed: 0, completed: 0, enqueuedDetails: 0 };
  const detailJobId = opts.fetchDetails === false ? null : await upsertJob(`fixture-details:${competitionId}:${seasonId}`, 'fixture-details', {}, 60);

  for (const f of res.data.response) {
    const resolved = await resolveFixtureIds(f);
    const up = await upsertFixture(f, resolved);
    if (!up) continue;
    result.imported += 1;
    if (up.changed) result.changed += 1;
    if (up.completed) result.completed += 1;

    // Historical completed + already fully populated → skip details (immutable).
    const needDetails = await fixtureNeedsDetails(up.fixtureId, up.completed);
    if (needDetails && detailJobId !== null) {
      const priority = up.justCompleted ? 30 : up.completed ? 70 : 20;
      await enqueueTask({
        taskKey: `fixture-details:${up.fixtureId}`,
        taskType: 'fixture:details',
        params: { fixtureId: up.fixtureId },
        priority,
        jobId: detailJobId,
      });
      result.enqueuedDetails += 1;
    }
    if (up.justCompleted) {
      await enqueueTask({
        taskKey: `postmatch:${up.fixtureId}`,
        taskType: 'fixture:postmatch',
        params: { fixtureId: up.fixtureId },
        priority: 25,
      });
    }
    await invalidateFixture(up.fixtureId);
  }
  logger.info({ competitionId, seasonId, ...result }, 'fixtures imported');
  return result;
}

async function fixtureNeedsDetails(fixtureId: number, completed: boolean): Promise<boolean> {
  const row = await queryOne<{
    finalized: boolean;
    event_count: number;
    team_stat_count: number;
    player_stat_count: number;
    lineup_count: number;
  }>(
    `SELECT f.finalized,
            (SELECT count(*) FROM fixture_events e WHERE e.fixture_id = f.id)::int AS event_count,
            (SELECT count(*) FROM fixture_team_statistics t WHERE t.fixture_id = f.id)::int AS team_stat_count,
            (SELECT count(*) FROM player_match_statistics p WHERE p.fixture_id = f.id)::int AS player_stat_count,
            (SELECT count(*) FROM lineups l WHERE l.fixture_id = f.id)::int AS lineup_count
       FROM fixtures f WHERE f.id = $1`,
    [fixtureId],
  );
  if (!row) return true;
  if (completed && row.finalized && row.event_count > 0 && row.team_stat_count > 0) return false;
  return row.event_count === 0 || row.team_stat_count === 0 || row.lineup_count === 0;
}

/** Fetch events/statistics/players/lineups for one fixture (respects coverage). */
export async function fetchFixtureDetails(fixtureId: number): Promise<{ events: number; teamStats: number; playerStats: number; lineups: number }> {
  const provider = await getProvider();
  const fx = await queryOne<{
    id: number; provider_fixture_id: string; competition_id: number | null; season_id: number | null;
    status_short: string; finalized: boolean;
  }>(`SELECT id, provider_fixture_id, competition_id, season_id, status_short, finalized FROM fixtures WHERE id = $1`, [fixtureId]);
  if (!fx) throw new Error(`fixture ${fixtureId} not found`);
  if (fx.finalized) return { events: 0, teamStats: 0, playerStats: 0, lineups: 0 };

  const coverage = fx.competition_id && fx.season_id ? await getCoverage(fx.competition_id, fx.season_id) : null;
  const out = { events: 0, teamStats: 0, playerStats: 0, lineups: 0 };
  const pFixture = fx.provider_fixture_id;
  const live = ['1H', 'HT', '2H', 'ET', 'P'].includes(fx.status_short);

  if (!coverage || coverage.events !== false) {
    const res = await provider.get<AfEvent>('/fixtures/events', { fixture: pFixture });
    out.events = await replaceFixtureEvents(fixtureId, res.data.response as AfEvent[]);
  }
  if (!coverage || coverage.fixture_statistics !== false) {
    const res = await provider.get<AfTeamStatEntry>('/fixtures/statistics', { fixture: pFixture });
    out.teamStats = await upsertFixtureTeamStatistics(fixtureId, res.data.response as AfTeamStatEntry[]);
  }
  if ((!coverage || coverage.player_statistics !== false) && !live) {
    const res = await provider.get<AfPlayerStatEntry>('/fixtures/players', { fixture: pFixture });
    out.playerStats = await upsertPlayerMatchStatistics(fixtureId, res.data.response as AfPlayerStatEntry[]);
  }
  if (!coverage || coverage.lineups !== false) {
    const res = await provider.get<AfLineup>('/fixtures/lineups', { fixture: pFixture });
    out.lineups = await upsertLineups(fixtureId, res.data.response as AfLineup[]);
  }
  await invalidateFixture(fixtureId);
  return out;
}

/** Live sync: find live fixtures, refresh scores/status/events cheaply. */
export async function syncLiveFixtures(): Promise<{ live: number; updated: number; finalized: number }> {
  const provider = await getProvider();
  const res = await provider.get<AfFixture>('/fixtures', { live: 'all' });
  let updated = 0;
  let finalized = 0;
  for (const f of res.data.response) {
    const resolved = await resolveFixtureIds(f);
    const up = await upsertFixture(f, resolved);
    if (!up) continue;
    if (up.changed) {
      updated += 1;
      // important events refresh while live
      await fetchFixtureEventsOnly(up.fixtureId, f.id);
    }
    if (up.justCompleted) {
      finalized += 1;
      await enqueueTask({ taskKey: `postmatch:${up.fixtureId}`, taskType: 'fixture:postmatch', params: { fixtureId: up.fixtureId }, priority: 25 });
    }
    await invalidateFixture(up.fixtureId);
  }
  return { live: res.data.results, updated, finalized };
}

async function fetchFixtureEventsOnly(fixtureId: number, providerFixtureId: number): Promise<void> {
  const provider = await getProvider();
  const res = await provider.get<AfEvent>('/fixtures/events', { fixture: String(providerFixtureId) });
  await replaceFixtureEvents(fixtureId, res.data.response as AfEvent[]);
}

/**
 * Post-match pipeline: final events/statistics/players/lineups → referee/team/
 * player/competition statistics → prediction features → cache → finalize.
 */
export async function runPostMatchPipeline(fixtureId: number): Promise<{ finalized: boolean; stats: Record<string, unknown> }> {
  const fx = await queryOne<{ id: number; status_short: string; finalized: boolean }>(
    `SELECT id, status_short, finalized FROM fixtures WHERE id = $1`,
    [fixtureId],
  );
  if (!fx) throw new Error(`fixture ${fixtureId} not found`);
  if (fx.finalized) return { finalized: true, stats: {} };

  // Reuse already-imported details; only re-fetch when something is missing
  // (historical completed fixtures stay mostly immutable).
  const needDetails = await fixtureNeedsDetails(fixtureId, COMPLETED_STATUSES.has(fx.status_short as never));
  const details = needDetails
    ? await fetchFixtureDetails(fixtureId)
    : { events: 0, teamStats: 0, playerStats: 0, lineups: 0, reused: true };
  const completed = COMPLETED_STATUSES.has(fx.status_short as never);

  const { recalculateRefereeForFixture } = await import('../../stats/referees.js');
  const { recalculateTeamForFixture } = await import('../../stats/teams.js');
  const { recalculatePlayersForFixture } = await import('../../stats/players.js');
  const { recalculateLeagueForFixture } = await import('../../stats/leagues.js');
  const { buildPredictionFeature } = await import('../../stats/predictions.js');

  const stats: Record<string, unknown> = { details };
  stats.referee = await recalculateRefereeForFixture(fixtureId);
  stats.team = await recalculateTeamForFixture(fixtureId);
  stats.players = await recalculatePlayersForFixture(fixtureId);
  stats.league = await recalculateLeagueForFixture(fixtureId);
  stats.prediction = await buildPredictionFeature(fixtureId);

  if (completed) {
    await query(`UPDATE fixtures SET finalized = TRUE, finalized_at = now() WHERE id = $1`, [fixtureId]);
    stats.finalized = true;
  }
  await invalidateFixture(fixtureId);
  return { finalized: completed, stats };
}

/** Refresh upcoming fixture lists (near-term priority). */
/**
 * Upcoming-fixtures sync: ONE request per day (`/fixtures?date=…` returns every
 * league's fixtures for that date) instead of one request per league — a full
 * 7-day window costs 7 requests regardless of how many leagues are in scope.
 * Results are filtered to configured in-scope competition/season pairs;
 * upserts are idempotent and raw payloads are stored as usual.
 */
export async function syncUpcomingFixtures(daysAhead = 7): Promise<{ fixtures: number; requests: number }> {
  const provider = await getProvider();
  const pairs = await query<{ provider_id: string; year: number }>(
    `SELECT DISTINCT c.provider_id, se.year
       FROM competition_seasons cs
       JOIN competitions c ON c.id = cs.competition_id
       JOIN seasons se ON se.id = cs.season_id
      WHERE cs.import_scope = 'in_scope'`,
  );
  const inScope = new Set(pairs.map((r) => `${r.provider_id}:${r.year}`));
  let count = 0;
  let requests = 0;
  for (let d = 0; d < Math.max(1, Math.min(daysAhead, 14)); d++) {
    const date = new Date(Date.now() + d * 864e5).toISOString().slice(0, 10);
    const res = await provider.get<AfFixture>('/fixtures', { date });
    requests += 1;
    for (const f of res.data.response) {
      const key = `${f.league?.id ?? ''}:${f.league?.season ?? ''}`;
      if (!inScope.has(key)) continue; // stay within the configured import scope
      const resolved = await resolveFixtureIds(f);
      const up = await upsertFixture(f, resolved);
      if (up) count += 1;
    }
  }
  return { fixtures: count, requests };
}

/** Finished-but-not-finalized fixtures → post-match tasks. */
export async function enqueuePostMatchTasks(limit = 50): Promise<{ tasks: number }> {
  const rows = await query<{ id: number }>(
    `SELECT id FROM fixtures
      WHERE finalized = FALSE AND status_short IN ('FT', 'AET', 'PEN')
      ORDER BY kickoff_utc DESC NULLS LAST LIMIT $1`,
    [limit],
  );
  for (const r of rows) {
    await enqueueTask({ taskKey: `postmatch:${r.id}`, taskType: 'fixture:postmatch', params: { fixtureId: r.id }, priority: 25 });
  }
  return { tasks: rows.length };
}
