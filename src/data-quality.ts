/** Data-quality checks (spec §46) with results persisted for /health/data. */
import { query, queryOne } from './lib/db.js';
import { config } from './config.js';

export interface QualityCheck {
  key: string;
  status: 'PASS' | 'WARN' | 'FAIL';
  message: string;
  details?: unknown;
}

export async function runDataQualityChecks(opts: { persist?: boolean } = {}): Promise<{
  checks: QualityCheck[];
  passed: number;
  warnings: number;
  failed: number;
}> {
  const checks: QualityCheck[] = [];

  const badFixtures = await queryOne<{ c: number }>(
    `SELECT count(*)::int AS c FROM fixtures WHERE home_team_id IS NOT NULL AND away_team_id IS NOT NULL AND home_team_id = away_team_id`,
  );
  checks.push({
    key: 'fixtures_teams_distinct',
    status: (badFixtures?.c ?? 0) === 0 ? 'PASS' : 'FAIL',
    message: `${badFixtures?.c ?? 0} fixtures with home = away`,
  });

  const badCompleted = await queryOne<{ c: number }>(
    `SELECT count(*)::int AS c FROM fixtures
      WHERE status_short IN ('FT','AET','PEN') AND home_score IS NULL AND away_score IS NULL`,
  );
  checks.push({
    key: 'completed_fixtures_have_scores',
    status: (badCompleted?.c ?? 0) === 0 ? 'PASS' : 'WARN',
    message: `${badCompleted?.c ?? 0} completed fixtures without any score`,
  });

  const orphanEvents = await queryOne<{ c: number }>(
    `SELECT count(*)::int AS c FROM fixture_events e LEFT JOIN fixtures f ON f.id = e.fixture_id WHERE f.id IS NULL`,
  );
  checks.push({
    key: 'events_reference_fixtures',
    status: (orphanEvents?.c ?? 0) === 0 ? 'PASS' : 'FAIL',
    message: `${orphanEvents?.c ?? 0} orphan fixture events`,
  });

  const orphanPlayerStats = await queryOne<{ c: number }>(
    `SELECT count(*)::int AS c FROM player_match_statistics ps LEFT JOIN players p ON p.id = ps.player_id WHERE p.id IS NULL`,
  );
  checks.push({
    key: 'player_stats_reference_players',
    status: (orphanPlayerStats?.c ?? 0) === 0 ? 'PASS' : 'FAIL',
    message: `${orphanPlayerStats?.c ?? 0} player-match-stat rows without player`,
  });

  const dupProviderFixtures = await queryOne<{ c: number }>(
    `SELECT count(*)::int AS c FROM (
       SELECT provider, provider_fixture_id FROM fixtures GROUP BY provider, provider_fixture_id HAVING count(*) > 1) d`,
  );
  checks.push({
    key: 'provider_fixture_ids_unique',
    status: (dupProviderFixtures?.c ?? 0) === 0 ? 'PASS' : 'FAIL',
    message: `${dupProviderFixtures?.c ?? 0} duplicate provider fixture ids`,
  });

  const badStandings = await queryOne<{ c: number }>(
    `SELECT count(*)::int AS c FROM standing_rows sr LEFT JOIN standings s ON s.id = sr.standings_id WHERE s.id IS NULL`,
  );
  checks.push({
    key: 'standings_reference_competition_season',
    status: (badStandings?.c ?? 0) === 0 ? 'PASS' : 'FAIL',
    message: `${badStandings?.c ?? 0} orphan standing rows`,
  });

  const inconsistentPoints = await queryOne<{ c: number }>(
    `SELECT count(*)::int AS c FROM standing_rows
      WHERE points IS NOT NULL AND played IS NOT NULL AND wins IS NOT NULL AND draws IS NOT NULL
        AND (wins + draws + losses) > played`,
  );
  checks.push({
    key: 'standings_internally_consistent',
    status: (inconsistentPoints?.c ?? 0) === 0 ? 'PASS' : 'WARN',
    message: `${inconsistentPoints?.c ?? 0} standing rows with w+d+l > played`,
  });

  const inconsistentAggregates = await queryOne<{ c: number }>(
    `SELECT count(*)::int AS c FROM team_competition_season_stats
      WHERE matches > 0 AND (wins + draws + losses) <> matches`,
  );
  checks.push({
    key: 'team_stats_aggregates_consistent',
    status: (inconsistentAggregates?.c ?? 0) === 0 ? 'PASS' : 'WARN',
    message: `${inconsistentAggregates?.c ?? 0} team-season rows with wins+draws+losses != matches`,
  });

  const keysWithoutHash = await queryOne<{ c: number }>(
    `SELECT count(*)::int AS c FROM api_keys WHERE key_hash IS NULL OR length(key_hash) < 32`,
  );
  checks.push({
    key: 'api_keys_hashed_only',
    status: (keysWithoutHash?.c ?? 0) === 0 ? 'PASS' : 'FAIL',
    message: `${keysWithoutHash?.c ?? 0} api keys without secure hash`,
  });

  const outOfScopeCompetitions = await queryOne<{ c: number }>(
    `SELECT count(*)::int AS c FROM competitions
      WHERE active = TRUE AND (import_tier IS NULL OR import_tier NOT BETWEEN 1 AND 3)`,
  );
  checks.push({
    key: 'approved_competition_scope',
    status: (outOfScopeCompetitions?.c ?? 0) === 0 ? 'PASS' : 'FAIL',
    message: `${outOfScopeCompetitions?.c ?? 0} active competitions outside approved Tier 1–3 scope`,
  });

  const outOfScopeSeasons = await queryOne<{ c: number }>(
    `SELECT count(*)::int AS c FROM seasons WHERE import_scope = 'in_scope' AND NOT (year = ANY($1::int[]))`,
    [config.importSeasons],
  );
  checks.push({
    key: 'approved_season_scope',
    status: (outOfScopeSeasons?.c ?? 0) === 0 ? 'PASS' : 'FAIL',
    message: `${outOfScopeSeasons?.c ?? 0} in-scope seasons outside ${config.importSeasons.join(', ')}`,
  });

  const scopedFixtures = await queryOne<{ c: number }>(
    `SELECT count(*)::int AS c FROM fixtures f
       JOIN competitions c ON c.id = f.competition_id
       JOIN seasons se ON se.id = f.season_id
       JOIN competition_seasons cs ON cs.competition_id = f.competition_id AND cs.season_id = f.season_id
      WHERE c.active = TRUE AND c.import_tier BETWEEN 1 AND 3
        AND se.import_scope = 'in_scope' AND cs.import_scope = 'in_scope'`,
  );
  checks.push({
    key: 'scoped_fixture_data_available',
    status: (scopedFixtures?.c ?? 0) > 0 ? 'PASS' : 'WARN',
    message: `${scopedFixtures?.c ?? 0} fixtures in the approved competition/season scope`,
  });

  const passed = checks.filter((c) => c.status === 'PASS').length;
  const warnings = checks.filter((c) => c.status === 'WARN').length;
  const failed = checks.filter((c) => c.status === 'FAIL').length;

  if (opts.persist !== false) {
    for (const c of checks) {
      await query(
        `INSERT INTO data_quality_results (check_key, status, message, details) VALUES ($1, $2, $3, $4)`,
        [c.key, c.status, c.message, JSON.stringify(c.details ?? {})],
      );
    }
  }
  return { checks, passed, warnings, failed };
}
