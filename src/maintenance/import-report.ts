/**
 * Read-only verification report for the approved import scope. Makes no
 * provider requests and changes nothing.
 */
import { query, queryOne } from '../lib/db.js';
import { config } from '../config.js';
import { PAIR_SCOPED_TASK_TYPES, FIXTURE_SCOPED_TASK_TYPES } from '../sync/scope-guard.js';

/** Required major competitions (API-Football IDs). */
export const REQUIRED_COMPETITIONS: { providerId: string; name: string }[] = [
  { providerId: '2', name: 'UEFA Champions League' },
  { providerId: '525', name: "UEFA Women's Champions League" },
  { providerId: '5', name: 'UEFA Nations League' },
  { providerId: '1', name: 'FIFA World Cup' },
  { providerId: '8', name: "FIFA Women's World Cup" },
];

export interface ImportScopeReport {
  competitions: {
    active: number;
    byTier: Record<string, number>;
    byGender: Record<string, number>;
    byTeamType: Record<string, number>;
    outsideTier1to3Active: number;
    required: { providerId: string; name: string; present: boolean; active: boolean }[];
  };
  seasons: { inScope: number[]; outOfScopeRows: number; current: number };
  competitionSeasons: {
    inScope: number;
    byYear: Record<string, number>;
    outOfScopeYearsInScope: number;
    historicalImported: number;
    historicalPending: number;
    currentBootstrapped: number;
    currentPending: number;
  };
  fixtures: { total: number; byYear: Record<string, number>; outsideScope: number; upcoming7d: number; live: number };
  tasks: {
    byStatus: Record<string, number>;
    queuedOutOfScope: number;
    pendingWithRetries: number;
    quotaDeferredPending: number;
    failed: number;
  };
}

function toMap(rows: { k: string | number | null; c: number }[]): Record<string, number> {
  return Object.fromEntries(rows.map((r) => [String(r.k ?? 'unknown'), Number(r.c)]));
}

export async function buildImportScopeReport(): Promise<ImportScopeReport> {
  const years = [...config.importSeasons];
  const activeWhere = `c.active = TRUE AND c.import_tier BETWEEN 1 AND 3`;

  const active = await queryOne<{ c: number }>(`SELECT count(*)::int AS c FROM competitions c WHERE ${activeWhere}`);
  const byTier = await query<{ k: number; c: number }>(`SELECT import_tier AS k, count(*)::int AS c FROM competitions c WHERE ${activeWhere} GROUP BY 1 ORDER BY 1`);
  const byGender = await query<{ k: string; c: number }>(`SELECT gender AS k, count(*)::int AS c FROM competitions c WHERE ${activeWhere} GROUP BY 1 ORDER BY 1`);
  const byTeamType = await query<{ k: string; c: number }>(`SELECT team_type AS k, count(*)::int AS c FROM competitions c WHERE ${activeWhere} GROUP BY 1 ORDER BY 1`);
  const outside = await queryOne<{ c: number }>(`SELECT count(*)::int AS c FROM competitions WHERE active = TRUE AND (import_tier IS NULL OR import_tier NOT BETWEEN 1 AND 3)`);
  const reqRows = await query<{ provider_id: string; active: boolean; import_tier: number | null }>(
    `SELECT provider_id, active, import_tier FROM competitions WHERE provider = 'api-football' AND provider_id = ANY($1::text[])`,
    [REQUIRED_COMPETITIONS.map((r) => r.providerId)],
  );
  const reqMap = new Map(reqRows.map((r) => [r.provider_id, r]));

  const inScopeSeasons = await query<{ year: number }>(`SELECT year FROM seasons WHERE import_scope = 'in_scope' AND year = ANY($1::int[]) ORDER BY year`, [years]);
  const outSeasons = await queryOne<{ c: number }>(`SELECT count(*)::int AS c FROM seasons WHERE NOT (year = ANY($1::int[]))`, [years]);

  const pairBase = `FROM competition_seasons cs JOIN competitions c ON c.id = cs.competition_id JOIN seasons se ON se.id = cs.season_id
                    WHERE cs.import_scope = 'in_scope' AND ${activeWhere}`;
  const pairs = await queryOne<{ total: number; hist_done: number; hist_pending: number; cur_done: number; cur_pending: number; bad_years: number }>(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE se.year <> $2 AND cs.historical_imported_at IS NOT NULL)::int AS hist_done,
            count(*) FILTER (WHERE se.year <> $2 AND cs.historical_imported_at IS NULL)::int AS hist_pending,
            count(*) FILTER (WHERE se.year = $2 AND cs.current_bootstrapped_at IS NOT NULL)::int AS cur_done,
            count(*) FILTER (WHERE se.year = $2 AND cs.current_bootstrapped_at IS NULL)::int AS cur_pending,
            count(*) FILTER (WHERE NOT (se.year = ANY($1::int[])))::int AS bad_years
       ${pairBase}`,
    [years, config.currentImportSeason],
  );
  const pairsByYear = await query<{ k: number; c: number }>(`SELECT se.year AS k, count(*)::int AS c ${pairBase} GROUP BY 1 ORDER BY 1`);

  const fxTotal = await queryOne<{ c: number }>(`SELECT count(*)::int AS c FROM fixtures`);
  const fxByYear = await query<{ k: number; c: number }>(`SELECT se.year AS k, count(*)::int AS c FROM fixtures f JOIN seasons se ON se.id = f.season_id GROUP BY 1 ORDER BY 1`);
  const fxOutside = await queryOne<{ c: number }>(
    `SELECT count(*)::int AS c
       FROM fixtures f
       LEFT JOIN competitions c ON c.id = f.competition_id
       LEFT JOIN seasons se ON se.id = f.season_id
       LEFT JOIN competition_seasons cs ON cs.competition_id = f.competition_id AND cs.season_id = f.season_id
      WHERE NOT (coalesce(c.active, FALSE) AND coalesce(c.import_tier, 0) BETWEEN 1 AND 3
                 AND coalesce(se.year, 0) = ANY($1::int[]) AND coalesce(cs.import_scope, '') = 'in_scope')`,
    [years],
  );
  const fxUpcoming = await queryOne<{ c: number }>(`SELECT count(*)::int AS c FROM fixtures WHERE kickoff_utc >= now() AND kickoff_utc < now() + interval '7 days'`);
  const fxLive = await queryOne<{ c: number }>(`SELECT count(*)::int AS c FROM fixtures WHERE status_short IN ('1H','HT','2H','ET','BT','P','INT')`);

  const taskStatus = await query<{ k: string; c: number }>(`SELECT status AS k, count(*)::int AS c FROM sync_tasks GROUP BY 1 ORDER BY 1`);
  const queuedOut = await queryOne<{ c: number }>(
    `SELECT count(*)::int AS c
       FROM sync_tasks t
      WHERE t.status IN ('pending', 'failed', 'running')
        AND (
          (t.task_type = ANY($2::text[]) AND NOT EXISTS (
             SELECT 1 FROM competition_seasons cs
               JOIN competitions c ON c.id = cs.competition_id
               JOIN seasons se ON se.id = cs.season_id
              WHERE (t.params->>'competitionId') ~ '^[0-9]{1,18}$' AND (t.params->>'seasonId') ~ '^[0-9]{1,18}$'
                AND cs.competition_id = (t.params->>'competitionId')::bigint AND cs.season_id = (t.params->>'seasonId')::bigint
                AND ${activeWhere} AND se.year = ANY($1::int[]) AND se.import_scope = 'in_scope' AND cs.import_scope = 'in_scope'))
          OR
          (t.task_type = ANY($3::text[]) AND NOT EXISTS (
             SELECT 1 FROM fixtures f
               JOIN competitions c ON c.id = f.competition_id
               JOIN seasons se ON se.id = f.season_id
               JOIN competition_seasons cs ON cs.competition_id = f.competition_id AND cs.season_id = f.season_id
              WHERE (t.params->>'fixtureId') ~ '^[0-9]{1,18}$' AND f.id = (t.params->>'fixtureId')::bigint
                AND ${activeWhere} AND se.year = ANY($1::int[]) AND se.import_scope = 'in_scope' AND cs.import_scope = 'in_scope'))
        )`,
    [years, [...PAIR_SCOPED_TASK_TYPES], [...FIXTURE_SCOPED_TASK_TYPES]],
  );
  const retries = await queryOne<{ c: number }>(`SELECT count(*)::int AS c FROM sync_tasks WHERE status = 'pending' AND attempts >= 2`);
  const deferred = await queryOne<{ c: number }>(`SELECT count(*)::int AS c FROM sync_tasks WHERE status = 'pending' AND coalesce(quota_defers, 0) > 0`);
  const failed = await queryOne<{ c: number }>(`SELECT count(*)::int AS c FROM sync_tasks WHERE status = 'failed'`);

  return {
    competitions: {
      active: active?.c ?? 0,
      byTier: toMap(byTier),
      byGender: toMap(byGender),
      byTeamType: toMap(byTeamType),
      outsideTier1to3Active: outside?.c ?? 0,
      required: REQUIRED_COMPETITIONS.map((r) => ({
        ...r,
        present: reqMap.has(r.providerId),
        active: Boolean(reqMap.get(r.providerId)?.active && reqMap.get(r.providerId)?.import_tier),
      })),
    },
    seasons: { inScope: inScopeSeasons.map((r) => r.year), outOfScopeRows: outSeasons?.c ?? 0, current: config.currentImportSeason },
    competitionSeasons: {
      inScope: pairs?.total ?? 0,
      byYear: toMap(pairsByYear),
      outOfScopeYearsInScope: pairs?.bad_years ?? 0,
      historicalImported: pairs?.hist_done ?? 0,
      historicalPending: pairs?.hist_pending ?? 0,
      currentBootstrapped: pairs?.cur_done ?? 0,
      currentPending: pairs?.cur_pending ?? 0,
    },
    fixtures: {
      total: fxTotal?.c ?? 0,
      byYear: toMap(fxByYear),
      outsideScope: fxOutside?.c ?? 0,
      upcoming7d: fxUpcoming?.c ?? 0,
      live: fxLive?.c ?? 0,
    },
    tasks: {
      byStatus: toMap(taskStatus),
      queuedOutOfScope: queuedOut?.c ?? 0,
      pendingWithRetries: retries?.c ?? 0,
      quotaDeferredPending: deferred?.c ?? 0,
      failed: failed?.c ?? 0,
    },
  };
}
