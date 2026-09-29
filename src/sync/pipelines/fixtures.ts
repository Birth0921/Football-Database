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
import { config } from '../../config.js';
import { isCurrentImportSeason } from '../import-scope.js';
import { resolveScopedPair, ScopeSkipError } from '../scope-guard.js';

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
  /**
   * true when the pair was already imported once (historical window season or
   * the one-time current-season bootstrap) and was served from PostgreSQL with
   * no provider request. Continuous updates come from live/upcoming/recent sync.
   */
  alreadyImported?: boolean;
}

/** Import all fixtures for a competition/season (historical + current). */
export async function importFixturesForCompetitionSeason(competitionId: number, seasonId: number, opts: { fetchDetails?: boolean; force?: boolean } = {}): Promise<ImportFixturesResult> {
  const provider = await getProvider();
  const ids = await resolveScopedPair(competitionId, seasonId);

  // One-time import per pair: a historical window season is imported once and
  // the current season is bootstrapped once, after which only the
  // live/today/upcoming/recent windows are requested. `force` is reserved for
  // explicit operator CLI refreshes.
  const current = isCurrentImportSeason(ids.season_year);
  // A former current season that was bootstrapped counts as imported.
  const marker = current ? ids.current_bootstrapped_at : (ids.historical_imported_at ?? ids.current_bootstrapped_at);
  if (marker && !opts.force) {
    const existing = await queryOne<{ c: number }>(
      `SELECT count(*)::int AS c FROM fixtures WHERE competition_id = $1 AND season_id = $2`,
      [competitionId, seasonId],
    );
    return { imported: existing?.c ?? 0, changed: 0, completed: 0, enqueuedDetails: 0, alreadyImported: true };
  }

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
      const priority = isCurrentImportSeason(ids.season_year)
        ? (up.justCompleted ? 30 : up.completed ? 70 : 20)
        : 80;
      await enqueueTask({
        taskKey: `fixture-details:${up.fixtureId}`,
        taskType: 'fixture:details',
        params: {
          fixtureId: up.fixtureId,
          quotaClass: isCurrentImportSeason(ids.season_year) ? 'essential' : 'background',
        },
        priority,
        jobId: detailJobId,
      });
      result.enqueuedDetails += 1;
    }
    if (up.justCompleted) {
      await enqueueTask({
        taskKey: `postmatch:${up.fixtureId}`,
        taskType: 'fixture:postmatch',
        params: {
          fixtureId: up.fixtureId,
          quotaClass: isCurrentImportSeason(ids.season_year) ? 'essential' : 'background',
        },
        priority: isCurrentImportSeason(ids.season_year) ? 25 : 85,
      });
    }
    await invalidateFixture(up.fixtureId);
  }
  // Historical: marked imported even when empty (a finished season with no
  // fixtures has none to fetch). Current: only marked bootstrapped once the
  // provider actually returned fixtures; an empty answer (schedule not yet
  // published at the start of a new season) records the attempt so the
  // bootstrap is retried at most weekly instead of looping.
  const bootstrapped = !current || res.data.response.length > 0;
  await query(
    current
      ? (bootstrapped
        ? `UPDATE competition_seasons SET current_bootstrapped_at = now(), current_bootstrap_attempted_at = now(), updated_at = now()
            WHERE competition_id = $1 AND season_id = $2 AND import_scope = 'in_scope'`
        : `UPDATE competition_seasons SET current_bootstrap_attempted_at = now(), updated_at = now()
            WHERE competition_id = $1 AND season_id = $2 AND import_scope = 'in_scope'`)
      : `UPDATE competition_seasons SET historical_imported_at = now(), updated_at = now()
          WHERE competition_id = $1 AND season_id = $2 AND import_scope = 'in_scope'`,
    [competitionId, seasonId],
  );
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
export async function fetchFixtureDetails(fixtureId: number, quotaClass?: 'essential' | 'background'): Promise<{ events: number; teamStats: number; playerStats: number; lineups: number }> {
  const provider = await getProvider();
  const fx = await queryOne<{
    id: number; provider_fixture_id: string; competition_id: number; season_id: number;
    status_short: string; finalized: boolean;
  }>(
    `SELECT f.id, f.provider_fixture_id, f.competition_id, f.season_id, f.status_short, f.finalized
       FROM fixtures f
       JOIN competitions c ON c.id = f.competition_id
       JOIN seasons se ON se.id = f.season_id
       JOIN competition_seasons cs ON cs.competition_id = f.competition_id AND cs.season_id = f.season_id
      WHERE f.id = $1 AND c.active = TRUE AND c.import_tier BETWEEN 1 AND 3
        AND se.import_scope = 'in_scope' AND cs.import_scope = 'in_scope'`,
    [fixtureId],
  );
  if (!fx) throw new ScopeSkipError(`fixture ${fixtureId} not found or outside import scope`);
  if (fx.finalized) return { events: 0, teamStats: 0, playerStats: 0, lineups: 0 };

  const coverage = fx.competition_id && fx.season_id ? await getCoverage(fx.competition_id, fx.season_id) : null;
  const out = { events: 0, teamStats: 0, playerStats: 0, lineups: 0 };
  const pFixture = fx.provider_fixture_id;
  const quotaParams = quotaClass ? { quotaClass } : {};
  const live = ['1H', 'HT', '2H', 'ET', 'P'].includes(fx.status_short);

  if (!coverage || coverage.events !== false) {
    const res = await provider.get<AfEvent>('/fixtures/events', { fixture: pFixture, ...quotaParams });
    out.events = await replaceFixtureEvents(fixtureId, res.data.response as AfEvent[]);
  }
  if (!coverage || coverage.fixture_statistics !== false) {
    const res = await provider.get<AfTeamStatEntry>('/fixtures/statistics', { fixture: pFixture, ...quotaParams });
    out.teamStats = await upsertFixtureTeamStatistics(fixtureId, res.data.response as AfTeamStatEntry[]);
  }
  if ((!coverage || coverage.player_statistics !== false) && !live) {
    const res = await provider.get<AfPlayerStatEntry>('/fixtures/players', { fixture: pFixture, ...quotaParams });
    out.playerStats = await upsertPlayerMatchStatistics(fixtureId, res.data.response as AfPlayerStatEntry[]);
  }
  if (!coverage || coverage.lineups !== false) {
    const res = await provider.get<AfLineup>('/fixtures/lineups', { fixture: pFixture, ...quotaParams });
    out.lineups = await upsertLineups(fixtureId, res.data.response as AfLineup[]);
  }
  await invalidateFixture(fixtureId);
  return out;
}

/** Live sync: find live fixtures, refresh scores/status/events cheaply. */
export async function syncLiveFixtures(): Promise<{ live: number; updated: number; finalized: number }> {
  const provider = await getProvider();
  const pairs = await query<{ provider_id: string; year: number }>(
    `SELECT DISTINCT c.provider_id, se.year
       FROM competition_seasons cs
       JOIN competitions c ON c.id = cs.competition_id
       JOIN seasons se ON se.id = cs.season_id
      WHERE cs.import_scope = 'in_scope'
        AND c.active = TRUE AND c.import_tier BETWEEN 1 AND 3
        AND se.import_scope = 'in_scope' AND se.year = ANY($1::int[])`,
    [config.importSeasons],
  );
  const inScope = new Set(pairs.map((r) => `${r.provider_id}:${r.year}`));
  if (inScope.size === 0) return { live: 0, updated: 0, finalized: 0 };

  // Snapshot fixtures we currently believe are live. A fixture disappears from
  // /fixtures?live=all as soon as the provider marks it FT/AET/PEN (or otherwise
  // leaves the live set), so without an exact-ID reconciliation its last local
  // state can remain stuck forever at e.g. 2H 90'.
  const locallyLive = await query<{ id: number; provider_fixture_id: string }>(
    `SELECT f.id, f.provider_fixture_id
       FROM fixtures f
       JOIN competitions c ON c.id = f.competition_id
       JOIN seasons se ON se.id = f.season_id
       JOIN competition_seasons cs
         ON cs.competition_id = f.competition_id AND cs.season_id = f.season_id
      WHERE f.status_short IN ('1H','HT','2H','ET','BT','P','INT')
        AND c.active = TRUE AND c.import_tier BETWEEN 1 AND 3
        AND se.year = ANY($1::int[])
        AND se.import_scope = 'in_scope'
        AND cs.import_scope = 'in_scope'`,
    [config.importSeasons],
  );

  const res = await provider.get<AfFixture>('/fixtures', { live: 'all' });
  const providerLiveIds = new Set(
    res.data.response
      .filter((f) => inScope.has(`${f.league?.id ?? ''}:${f.league?.season ?? ''}`))
      .flatMap((f) => f.id != null ? [String(f.id)] : []),
  );

  let live = 0;
  let updated = 0;
  let finalized = 0;

  const processFixture = async (f: AfFixture, refreshLiveEvents: boolean): Promise<void> => {
    const key = `${f.league?.id ?? ''}:${f.league?.season ?? ''}`;
    if (!inScope.has(key)) return;

    const resolved = await resolveFixtureIds(f);
    const up = await upsertFixture(f, resolved);
    if (!up) return;

    if (up.changed) {
      updated += 1;
      if (refreshLiveEvents && f.id != null) {
        await fetchFixtureEventsOnly(up.fixtureId, f.id);
      }
    }
    if (up.justCompleted) {
      finalized += 1;
      await enqueueTask({
        taskKey: `postmatch:${up.fixtureId}`,
        taskType: 'fixture:postmatch',
        params: { fixtureId: up.fixtureId, quotaClass: 'essential' },
        priority: 25,
      });
    }
    await invalidateFixture(up.fixtureId);
  };

  for (const f of res.data.response) {
    const key = `${f.league?.id ?? ''}:${f.league?.season ?? ''}`;
    if (!inScope.has(key)) continue;
    live += 1;
    await processFixture(f, true);
  }

  // Reconcile fixtures that were locally live but vanished from live=all.
  // Fetching by exact provider ID captures the terminal status instead of
  // guessing why the fixture left the live feed.
  for (const local of locallyLive) {
    if (providerLiveIds.has(String(local.provider_fixture_id))) continue;
    const current = await provider.get<AfFixture>('/fixtures', {
      id: String(local.provider_fixture_id),
    });
    const fixture = current.data.response[0];
    if (fixture) await processFixture(fixture, false);
  }

  return { live, updated, finalized };
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
export async function runPostMatchPipeline(fixtureId: number, quotaClass?: 'essential' | 'background'): Promise<{ finalized: boolean; stats: Record<string, unknown> }> {
  const fx = await queryOne<{ id: number; status_short: string; finalized: boolean }>(
    `SELECT f.id, f.status_short, f.finalized
       FROM fixtures f
       JOIN competitions c ON c.id = f.competition_id
       JOIN seasons se ON se.id = f.season_id
       JOIN competition_seasons cs ON cs.competition_id = f.competition_id AND cs.season_id = f.season_id
      WHERE f.id = $1 AND c.active = TRUE AND c.import_tier BETWEEN 1 AND 3
        AND se.import_scope = 'in_scope' AND cs.import_scope = 'in_scope'`,
    [fixtureId],
  );
  if (!fx) throw new ScopeSkipError(`fixture ${fixtureId} not found or outside import scope`);
  if (fx.finalized) return { finalized: true, stats: {} };

  // Reuse already-imported details; only re-fetch when something is missing
  // (historical completed fixtures stay mostly immutable).
  const needDetails = await fixtureNeedsDetails(fixtureId, COMPLETED_STATUSES.has(fx.status_short as never));
  const details = needDetails
    ? await fetchFixtureDetails(fixtureId, quotaClass)
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
 * Results are filtered to approved competitions × rolling-window seasons
 * (a date request costs the same; an August–May season keeps syncing after
 * the January rollover until its last match);
 * upserts are idempotent and raw payloads are stored as usual. `daysBack`
 * is reserved for the daily recently-finished reconciliation and is zero for
 * the normal upcoming task so the provider request count stays predictable.
 */
export async function syncUpcomingFixtures(daysAhead = 7, daysBack = 0): Promise<{ fixtures: number; requests: number }> {
  const provider = await getProvider();
  const pairs = await query<{ provider_id: string; year: number }>(
    `SELECT DISTINCT c.provider_id, se.year
       FROM competition_seasons cs
       JOIN competitions c ON c.id = cs.competition_id
       JOIN seasons se ON se.id = cs.season_id
      WHERE cs.import_scope = 'in_scope'
        AND c.active = TRUE AND c.import_tier BETWEEN 1 AND 3
        AND se.import_scope = 'in_scope' AND se.year = ANY($1::int[])`,
    [config.importSeasons],
  );
  const inScope = new Set(pairs.map((r) => `${r.provider_id}:${r.year}`));
  if (inScope.size === 0) return { fixtures: 0, requests: 0 };
  let count = 0;
  let requests = 0;
  const back = Math.min(Math.max(0, daysBack), 7);
  const ahead = Math.min(Math.max(0, daysAhead), 14);
  if (back === 0 && ahead === 0) return { fixtures: 0, requests: 0 };
  for (let d = -back; d < ahead; d++) {
    const date = new Date(Date.now() + d * 864e5).toISOString().slice(0, 10);
    const res = await provider.get<AfFixture>('/fixtures', { date });
    requests += 1;
    for (const f of res.data.response) {
      const key = `${f.league?.id ?? ''}:${f.league?.season ?? ''}`;
      if (!inScope.has(key)) continue; // approved competitions, rolling-window seasons only
      const resolved = await resolveFixtureIds(f);
      const up = await upsertFixture(f, resolved);
      if (up) count += 1;
    }
  }
  return { fixtures: count, requests };
}

/** Finished-but-not-finalized fixtures → post-match tasks. */
export async function enqueuePostMatchTasks(limit = 50, sinceDays = 0): Promise<{ tasks: number }> {
  const rows = await query<{ id: number }>(
    `SELECT f.id FROM fixtures f
      JOIN competitions c ON c.id = f.competition_id
      JOIN seasons se ON se.id = f.season_id
      WHERE f.finalized = FALSE AND f.status_short IN ('FT', 'AET', 'PEN')
        AND c.active = TRUE AND c.import_tier BETWEEN 1 AND 3
        AND se.year = ANY($2::int[]) AND se.import_scope = 'in_scope'
        AND ($3 = 0 OR f.kickoff_utc >= now() - ($3 || ' days')::interval)
      ORDER BY f.kickoff_utc DESC NULLS LAST LIMIT $1`,
    [limit, config.importSeasons, Math.min(Math.max(0, sinceDays), 30)],
  );
  for (const r of rows) {
    await enqueueTask({
      taskKey: `postmatch:${r.id}`,
      taskType: 'fixture:postmatch',
      params: { fixtureId: r.id, quotaClass: 'essential' },
      priority: 25,
    });
  }
  return { tasks: rows.length };
}
