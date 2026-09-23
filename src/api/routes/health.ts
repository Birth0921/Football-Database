import type { FastifyInstance } from 'fastify';
import { query } from '../../db/pool.js';
import { checkDatabase } from '../../db/pool.js';
import { redisPing } from '../../redis/client.js';
import { providerClient } from '../../provider/client.js';
import { quotaManager } from '../../provider/quota.js';
import { ok, fail } from '../../util/http.js';
import { toCamel } from '../shape.js';
import { syncStats } from '../../sync/tasksDb.js';

export function registerHealthRoutes(app: FastifyInstance): void {
  app.get('/health', { config: { scope: undefined } }, async () => {
    let db = await checkDatabase();
    let redis = await redisPing();
    if (!redis.ok) redis = await redisPing(); // lazy connect may need one retry
    const overall = db.ok; // Redis optional; DB mandatory
    return ok({
      status: overall ? 'healthy' : 'degraded',
      uptimeSeconds: Math.round(process.uptime()),
      version: '1.0.0',
      services: { database: db.ok ? 'up' : 'down', redis: redis.ok ? 'up' : 'down', providerKey: providerClient.hasKey ? 'configured' : 'missing' },
    });
  });

  app.get('/health/database', { config: { scope: undefined } }, async () => {
    const db = await checkDatabase();
    if (!db.ok) return fail(503, 'database unavailable', { latencyMs: db.latencyMs, error: db.error });
    return ok({ status: 'up', latencyMs: db.latencyMs, version: db.version?.split(' ').slice(0, 2).join(' ') });
  });

  app.get('/health/redis', { config: { scope: undefined } }, async () => {
    const redis = await redisPing();
    if (!redis.ok) return fail(503, 'redis unavailable', { latencyMs: redis.latencyMs, error: redis.error });
    return ok({ status: 'up', latencyMs: redis.latencyMs });
  });

  app.get('/health/provider', { config: { scope: undefined } }, async (req) => {
    const quota = await quotaManager.snapshot();
    let account: unknown = null;
    if (req.query && (req.query as Record<string, string>).refresh === '1' && providerClient.hasKey) {
      const st = await providerClient.checkStatus();
      account = st.account ?? null;
    }
    return ok({
      provider: 'api-football',
      keyConfigured: providerClient.hasKey,
      quota,
      account,
    });
  });

  app.get('/health/data', { config: { scope: undefined } }, async () => {
    const { rows } = await query<Record<string, string>>(
      `SELECT
        (SELECT count(*) FROM countries)::text AS countries,
        (SELECT count(*) FROM competitions)::text AS competitions,
        (SELECT count(*) FROM competition_seasons)::text AS "competitionSeasons",
        (SELECT count(*) FROM teams)::text AS teams,
        (SELECT count(*) FROM players)::text AS players,
        (SELECT count(*) FROM referees)::text AS referees,
        (SELECT count(*) FROM fixtures)::text AS fixtures,
        (SELECT count(*) FROM fixtures WHERE is_finished)::text AS "fixturesFinished",
        (SELECT count(*) FROM fixture_events)::text AS events,
        (SELECT count(*) FROM fixture_team_statistics)::text AS "teamStatRecords",
        (SELECT count(*) FROM player_match_statistics)::text AS "playerStatRecords",
        (SELECT count(*) FROM standings)::text AS standings,
        (SELECT count(*) FROM sidelined_records)::text AS "sidelinedRecords",
        (SELECT count(*) FROM transfers)::text AS transfers,
        (SELECT count(*) FROM prediction_features)::text AS "predictionFeatures"`,
    );
    const counts = Object.fromEntries(Object.entries(rows[0] ?? {}).map(([k, v]) => [k, parseInt(v, 10)]));

    // data quality checks (spec section 46)
    const quality = await runQualityChecks();
    const sync = await syncStats();
    return ok({ counts, quality, sync });
  });
}

export async function runQualityChecks(): Promise<{ check: string; passed: boolean; violations: number; sample?: unknown }[]> {
  const checks: { sql: string; check: string }[] = [
    { check: 'home_team_equals_away', sql: `SELECT count(*)::int AS n FROM fixtures WHERE home_team_id = away_team_id` },
    { check: 'finished_fixture_missing_scores', sql: `SELECT count(*)::int AS n FROM fixtures WHERE is_finished AND (home_score IS NULL OR away_score IS NULL)` },
    { check: 'finished_fixture_zero_scores_possible', sql: `SELECT count(*)::int AS n FROM fixtures WHERE is_finished AND status_short='FT' AND home_score IS NOT NULL AND away_score IS NOT NULL` },
    { check: 'events_without_fixture', sql: `SELECT count(*)::int AS n FROM fixture_events e LEFT JOIN fixtures f ON f.id = e.fixture_id WHERE f.id IS NULL` },
    { check: 'player_stats_without_player', sql: `SELECT count(*)::int AS n FROM player_match_statistics p LEFT JOIN players pl ON pl.id = p.player_id WHERE pl.id IS NULL` },
    { check: 'standings_rows_without_team', sql: `SELECT count(*)::int AS n FROM standing_rows sr LEFT JOIN teams t ON t.id = sr.team_id WHERE t.id IS NULL` },
    { check: 'duplicate_provider_fixtures', sql: `SELECT count(*)::int AS n FROM (SELECT provider, provider_id FROM fixtures GROUP BY provider, provider_id HAVING count(*) > 1) d` },
    { check: 'aggregate_totals_inconsistent', sql: `SELECT count(*)::int AS n FROM team_statistics WHERE matches IS NOT NULL AND wins + draws + losses <> matches` },
    { check: 'fixtures_without_competition_season', sql: `SELECT count(*)::int AS n FROM fixtures f LEFT JOIN competition_seasons cs ON cs.id = f.competition_season_id WHERE cs.id IS NULL` },
  ];
  const results: { check: string; passed: boolean; violations: number; sample?: unknown }[] = [];
  for (const c of checks) {
    try {
      const { rows } = await query<{ n: number }>(c.sql);
      const violations = rows[0]?.n ?? 0;
      results.push({ check: c.check, passed: violations === 0, violations });
    } catch (err) {
      results.push({ check: c.check, passed: false, violations: -1, sample: err instanceof Error ? err.message : err });
    }
  }
  void toCamel;
  return results;
}
