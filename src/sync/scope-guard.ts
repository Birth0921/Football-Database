/**
 * Import-scope guard for queued sync work.
 *
 * Every task that targets one competition/season pair (fixtures, coverage,
 * teams, standings, injuries, odds) or one fixture (details, post-match) must
 * reference data that is still inside the approved import scope:
 *   - competition active with import tier 1..3 (set only by the importer from
 *     the approved Tier 1–3 table; cleared by cleanupImportScope)
 *   - season year in IMPORT_SEASONS (exactly 2023–2026) and marked in_scope
 *   - competition_seasons pair marked in_scope
 *
 * Work that falls outside that scope can never succeed by retrying, so it is
 * treated as a PERMANENT skip: it is never enqueued, never retried, and stale
 * rows left behind by an older/wider scope are marked `skipped`.
 */
import { query, queryOne } from '../lib/db.js';
import { config } from '../config.js';

/** Task types whose params are `{ competitionId, seasonId }` (internal DB ids). */
export const PAIR_SCOPED_TASK_TYPES = [
  'fixtures:import',
  'coverage:discover',
  'teams:import',
  'standings:sync',
  'injuries:sync',
  'odds:sync',
] as const;

/** Task types whose params are `{ fixtureId }` (internal DB id). */
export const FIXTURE_SCOPED_TASK_TYPES = ['fixture:details', 'fixture:postmatch'] as const;

const pairTypes = new Set<string>(PAIR_SCOPED_TASK_TYPES);
const fixtureTypes = new Set<string>(FIXTURE_SCOPED_TASK_TYPES);

export const SCOPE_SKIP_PREFIX = 'skipped: outside approved import scope';

/**
 * An error that can never be fixed by retrying (missing or out-of-scope
 * target). The engine marks such tasks `skipped` instead of scheduling a retry.
 */
export class PermanentTaskError extends Error {
  readonly permanent = true;
  constructor(message: string) {
    super(message);
    this.name = 'PermanentTaskError';
  }
}

/** Target competition/season/fixture missing or outside the approved scope. */
export class ScopeSkipError extends PermanentTaskError {
  constructor(message: string) {
    super(message);
    this.name = 'ScopeSkipError';
  }
}

/**
 * Permanent errors: typed errors plus the legacy message shapes that older
 * builds threw, so tasks already queued on a running VPS are also stopped.
 */
export function isPermanentTaskError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  if ((err as { permanent?: unknown }).permanent === true) return true;
  const msg = String((err as { message?: unknown }).message ?? '');
  return /competition\/season (not found|outside import scope)/i.test(msg)
    || /competition_seasons row missing/i.test(msg)
    || /^fixture \d+ not found/i.test(msg);
}

/**
 * Scope parameters. $1 is a placeholder kept for positional stability; the
 * competition allowlist is enforced through `active`/`import_tier`, which only
 * the importer sets (from the Tier 1–3 table) and cleanupImportScope clears.
 */
function scopeParams(): [string, number[]] {
  return ['api-football', [...config.importSeasons]];
}

/** Shared WHERE clause for an in-scope pair ($1 = provider, $2 = seasons). */
const PAIR_SCOPE_SQL = `
  c.provider = $1::text
  AND c.active = TRUE
  AND c.import_tier BETWEEN 1 AND 3
  AND se.year = ANY($2::int[])
  AND se.import_scope = 'in_scope'
  AND cs.import_scope = 'in_scope'`;

export interface ScopedPair {
  competition_season_id: number;
  provider_id: string;
  season_year: number;
  historical_imported_at: string | null;
  current_bootstrapped_at: string | null;
}

function asId(value: unknown): number | null {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/** Look up an in-scope pair; `null` when missing, unsupported or out of scope. */
export async function findScopedPair(competitionId: unknown, seasonId: unknown): Promise<ScopedPair | null> {
  const c = asId(competitionId);
  const s = asId(seasonId);
  if (c === null || s === null) return null;
  const [ids, years] = scopeParams();
  return queryOne<ScopedPair>(
    `SELECT cs.id AS competition_season_id, c.provider_id, se.year AS season_year, cs.historical_imported_at, cs.current_bootstrapped_at
       FROM competition_seasons cs
       JOIN competitions c ON c.id = cs.competition_id
       JOIN seasons se ON se.id = cs.season_id
      WHERE cs.competition_id = $3 AND cs.season_id = $4
        AND ${PAIR_SCOPE_SQL}`,
    [ids, years, c, s],
  );
}

/** Resolve an in-scope pair or throw a permanent ScopeSkipError. */
export async function resolveScopedPair(competitionId: unknown, seasonId: unknown): Promise<ScopedPair> {
  const pair = await findScopedPair(competitionId, seasonId);
  if (!pair) {
    throw new ScopeSkipError(`competition/season not found or outside import scope: ${String(competitionId)}/${String(seasonId)}`);
  }
  return pair;
}

export async function isFixtureInScope(fixtureId: unknown): Promise<boolean> {
  const id = asId(fixtureId);
  if (id === null) return false;
  const [ids, years] = scopeParams();
  const row = await queryOne<{ id: number }>(
    `SELECT f.id
       FROM fixtures f
       JOIN competitions c ON c.id = f.competition_id
       JOIN seasons se ON se.id = f.season_id
       JOIN competition_seasons cs ON cs.competition_id = f.competition_id AND cs.season_id = f.season_id
      WHERE f.id = $3 AND ${PAIR_SCOPE_SQL}`,
    [ids, years, id],
  );
  return row !== null;
}

/**
 * Whether a task of this type/params may be queued. Unscoped task types
 * (live/upcoming/scheduler/stat roll-ups) are always allowed.
 */
export async function isTaskInScope(taskType: string, params: Record<string, unknown> = {}): Promise<boolean> {
  if (pairTypes.has(taskType)) return (await findScopedPair(params.competitionId, params.seasonId)) !== null;
  if (fixtureTypes.has(taskType)) return isFixtureInScope(params.fixtureId);
  return true;
}

export function isScopedTaskType(taskType: string): boolean {
  return pairTypes.has(taskType) || fixtureTypes.has(taskType);
}

/**
 * Mark every queued (pending/failed) pair- or fixture-scoped task whose target
 * is missing or outside the approved scope as `skipped`. Idempotent; running
 * and done tasks are left alone (a running task will hit ScopeSkipError and be
 * skipped by the engine itself). Returns the number of rows skipped.
 */
export async function skipOutOfScopeTasks(): Promise<{ skipped: number; byType: Record<string, number> }> {
  const [ids, years] = scopeParams();
  const rows = await query<{ task_type: string }>(
    `UPDATE sync_tasks t
        SET status = 'skipped',
            completed_at = now(),
            last_error = $5,
            result_summary = jsonb_build_object('skipped', true, 'reason', 'out_of_scope'),
            updated_at = now()
      WHERE t.status IN ('pending', 'failed')
        AND (
          (t.task_type = ANY($3::text[]) AND NOT EXISTS (
             SELECT 1
               FROM competition_seasons cs
               JOIN competitions c ON c.id = cs.competition_id
               JOIN seasons se ON se.id = cs.season_id
              WHERE (t.params->>'competitionId') ~ '^[0-9]{1,18}$'
                AND (t.params->>'seasonId') ~ '^[0-9]{1,18}$'
                AND cs.competition_id = (t.params->>'competitionId')::bigint
                AND cs.season_id = (t.params->>'seasonId')::bigint
                AND ${PAIR_SCOPE_SQL}))
          OR
          (t.task_type = ANY($4::text[]) AND NOT EXISTS (
             SELECT 1
               FROM fixtures f
               JOIN competitions c ON c.id = f.competition_id
               JOIN seasons se ON se.id = f.season_id
               JOIN competition_seasons cs ON cs.competition_id = f.competition_id AND cs.season_id = f.season_id
              WHERE (t.params->>'fixtureId') ~ '^[0-9]{1,18}$'
                AND f.id = (t.params->>'fixtureId')::bigint
                AND ${PAIR_SCOPE_SQL}))
        )
      RETURNING t.task_type`,
    [ids, years, [...PAIR_SCOPED_TASK_TYPES], [...FIXTURE_SCOPED_TASK_TYPES], `${SCOPE_SKIP_PREFIX} (competition/season or fixture missing, unsupported, or season not in ${years.join(',')})`],
  );
  const byType: Record<string, number> = {};
  for (const r of rows) byType[r.task_type] = (byType[r.task_type] ?? 0) + 1;
  return { skipped: rows.length, byType };
}
