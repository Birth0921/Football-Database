/**
 * Controlled reset of the IMPORTED football dataset (clean-rebuild step 1).
 *
 * Removes provider-imported football data and all import/queue state so the
 * approved Tier 1–3 / 2023–2026 importer can rebuild from a known-clean state.
 *
 * Guarantees:
 *   - never DROPs the database, schema or any table; row DELETEs only
 *   - never touches protected application/configuration tables (API clients,
 *     API keys, managed website key secrets, API usage/audit, migrations,
 *     provider quota ledger)
 *   - every table in the schema must be classified as RESET or PROTECTED;
 *     an unknown table aborts the reset (new tables must be classified first)
 *   - deletion order is validated against the LIVE foreign-key catalogue
 *     (children before parents) and aborts if a protected table references a
 *     reset table
 *   - single transaction with EXCLUSIVE table locks and a lock timeout;
 *     protected table row counts are compared before/after inside the
 *     transaction and the reset is rolled back if anything changed
 *   - identity sequences are NOT restarted, so no new row can collide with a
 *     stale cached/queued reference to an old id
 *   - idempotent: running it on an already-clean dataset deletes 0 rows
 */
import type { PoolClient } from 'pg';
import { query, withTransaction } from '../lib/db.js';
import { cacheDelPattern } from '../lib/cache.js';
import { logger } from '../lib/logger.js';

/**
 * Imported football data + import/queue state, ordered CHILDREN FIRST.
 * The order is re-validated against the live FK catalogue on every run.
 */
export const RESET_TABLES = [
  // fixture detail / derived rows
  'odds_values',
  'odds',
  'lineup_players',
  'lineups',
  'fixture_events',
  'fixture_periods',
  'fixture_scores',
  'fixture_team_statistics',
  'player_match_statistics',
  'referee_match_statistics',
  'prediction_features',
  'standing_rows',
  'standings',
  'sidelined_records',
  'transfers',
  'h2h_stats',
  'team_coach_history',
  'team_competition_season_stats',
  'team_seasons',
  'player_season_statistics',
  'player_team_history',
  'referee_competition_statistics',
  'referee_season_statistics',
  'league_season_statistics',
  // fixtures, then the entities they reference
  'fixtures',
  'competition_rounds',
  'competition_season_coverage',
  'competition_seasons',
  'players',
  'teams',
  'referees',
  'venues',
  'bookmakers',
  'competitions',
  'seasons',
  'countries',
  // provider payload archive + import bookkeeping + queue state
  'raw_provider_payloads',
  'data_quality_results',
  'sync_state',
  'sync_tasks',
  'sync_jobs',
] as const;

/** Application/configuration tables that must never be modified. */
export const PROTECTED_TABLES = [
  'api_clients',
  'api_keys',
  'managed_key_secrets',
  'api_usage',
  'api_audit_log',
  'schema_migrations',
  // Provider quota ledger: real API-Football usage is never reset or faked.
  'provider_quota',
  'provider_requests',
] as const;

/** Redis cache prefixes holding football API responses (never config). */
export const FOOTBALL_CACHE_PATTERNS = [
  'fdp:competitions*',
  'fdp:fixtures*',
  'fdp:standings*',
  'fdp:teams*',
  'fdp:players*',
  'fdp:referees*',
  'fdp:predictions*',
];

export const RESET_CONFIRM_PHRASE = 'reset-imported-football-data';

export interface ResetPlan {
  tables: { table: string; rows: number }[];
  totalRows: number;
  protectedTables: { table: string; rows: number }[];
}

export interface ResetResult extends ResetPlan {
  mode: 'dry-run' | 'executed';
  deleted: { table: string; rows: number }[];
  totalDeleted: number;
  protectedUnchanged: boolean;
  cacheCleared: boolean;
  queueDrained: boolean;
  durationMs: number;
}

export interface FkEdge { child: string; parent: string }

/** Bound an optional Redis step so an unavailable Redis never hangs the CLI. */
async function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function listTables(client?: PoolClient): Promise<string[]> {
  const sql = `SELECT table_name FROM information_schema.tables
                WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY 1`;
  const rows = client ? (await client.query<{ table_name: string }>(sql)).rows : await query<{ table_name: string }>(sql);
  return rows.map((r) => r.table_name);
}

async function listForeignKeys(client?: PoolClient): Promise<FkEdge[]> {
  const sql = `SELECT DISTINCT cl.relname AS child, pcl.relname AS parent
                 FROM pg_constraint con
                 JOIN pg_class cl ON cl.oid = con.conrelid
                 JOIN pg_class pcl ON pcl.oid = con.confrelid
                 JOIN pg_namespace ns ON ns.oid = cl.relnamespace
                WHERE con.contype = 'f' AND ns.nspname = 'public'`;
  return client ? (await client.query<FkEdge>(sql)).rows : await query<FkEdge>(sql);
}

/**
 * Pure validation of table classification + delete order against a set of
 * tables and FK edges. Throws on any violation.
 */
export function assertResetPlanValid(
  tables: readonly string[],
  edges: readonly FkEdge[],
  resetOrder: readonly string[] = RESET_TABLES,
  protectedTables: readonly string[] = PROTECTED_TABLES,
): void {
  const reset = new Set<string>(resetOrder);
  const protectedSet = new Set<string>(protectedTables);
  for (const t of reset) if (protectedSet.has(t)) throw new Error(`table ${t} is both reset and protected`);
  const present = new Set(tables);
  const unclassified = tables.filter((t) => !reset.has(t) && !protectedSet.has(t));
  if (unclassified.length) {
    throw new Error(`reset aborted: unclassified tables ${unclassified.join(', ')} — classify them in RESET_TABLES or PROTECTED_TABLES first`);
  }
  const missing = [...reset].filter((t) => !present.has(t));
  if (missing.length) throw new Error(`reset aborted: expected tables missing: ${missing.join(', ')} (run migrations first)`);

  const order = new Map<string, number>(resetOrder.map((t, i) => [t, i]));
  for (const { child, parent } of edges) {
    if (child === parent) continue;
    if (protectedSet.has(child) && reset.has(parent)) {
      throw new Error(`reset aborted: protected table ${child} references reset table ${parent}`);
    }
    if (reset.has(child) && reset.has(parent) && order.get(child)! > order.get(parent)!) {
      throw new Error(`reset aborted: ${child} references ${parent} but would be deleted after it`);
    }
  }
}

/** Validate the classification and delete order against the LIVE schema. */
export async function validateResetSchema(client?: PoolClient): Promise<void> {
  assertResetPlanValid(await listTables(client), await listForeignKeys(client));
}

async function countRows(tables: readonly string[], client?: PoolClient): Promise<{ table: string; rows: number }[]> {
  const out: { table: string; rows: number }[] = [];
  for (const t of tables) {
    const sql = `SELECT count(*)::bigint AS c FROM "${t}"`;
    const rows = client ? (await client.query<{ c: string }>(sql)).rows : await query<{ c: string }>(sql);
    out.push({ table: t, rows: Number(rows[0]?.c ?? 0) });
  }
  return out;
}

/** Row counts that a reset WOULD delete, plus protected counts (read-only). */
export async function planImportedDataReset(): Promise<ResetPlan> {
  await validateResetSchema();
  const tables = await countRows(RESET_TABLES);
  const protectedTables = await countRows(PROTECTED_TABLES);
  return { tables, totalRows: tables.reduce((s, t) => s + t.rows, 0), protectedTables };
}

export interface ResetOptions {
  /** Must be exactly RESET_CONFIRM_PHRASE to execute; otherwise a dry run. */
  confirm?: string;
  /** Required (true) when NODE_ENV=production. */
  production?: boolean;
  nodeEnv?: string;
  /** Lock wait before aborting (workers must be stopped). */
  lockTimeoutMs?: number;
  /** Skip Redis cache/queue cleanup (tests without Redis). */
  skipRedis?: boolean;
}

export async function resetImportedData(opts: ResetOptions = {}): Promise<ResetResult> {
  const t0 = Date.now();
  const execute = opts.confirm === RESET_CONFIRM_PHRASE;
  const nodeEnv = opts.nodeEnv ?? process.env.NODE_ENV ?? 'development';
  if (execute && nodeEnv === 'production' && opts.production !== true) {
    throw new Error('refusing to reset in production without --production (in addition to --confirm)');
  }

  if (!execute) {
    const plan = await planImportedDataReset();
    return {
      ...plan, mode: 'dry-run', deleted: [], totalDeleted: 0, protectedUnchanged: true,
      cacheCleared: false, queueDrained: false, durationMs: Date.now() - t0,
    };
  }

  const lockTimeout = Math.max(1000, Math.min(opts.lockTimeoutMs ?? 15_000, 120_000));
  const outcome = await withTransaction(async (client) => {
    await client.query(`SET LOCAL lock_timeout = '${lockTimeout}ms'`);
    await client.query(`SET LOCAL statement_timeout = '30min'`);
    await validateResetSchema(client);

    // Block concurrent writers (a still-running worker/scheduler) for the
    // whole reset; readers (the public API) keep working until commit.
    await client.query(`LOCK TABLE ${RESET_TABLES.map((t) => `"${t}"`).join(', ')} IN EXCLUSIVE MODE`);

    const before = await countRows(RESET_TABLES, client);
    const protectedBefore = await countRows(PROTECTED_TABLES, client);
    const deleted: { table: string; rows: number }[] = [];
    for (const t of RESET_TABLES) {
      const res = await client.query(`DELETE FROM "${t}"`);
      deleted.push({ table: t, rows: res.rowCount ?? 0 });
    }
    const protectedAfter = await countRows(PROTECTED_TABLES, client);
    const unchanged = protectedBefore.every((p, i) => p.rows === protectedAfter[i].rows);
    if (!unchanged) throw new Error('reset rolled back: a protected table changed during the reset');
    const leftover = (await countRows(RESET_TABLES, client)).filter((t) => t.rows > 0);
    if (leftover.length) throw new Error(`reset rolled back: rows remain in ${leftover.map((t) => t.table).join(', ')}`);
    return { before, protectedBefore, deleted };
  });

  let cacheCleared = false;
  let queueDrained = false;
  if (!opts.skipRedis) {
    try {
      await withTimeout(cacheDelPattern(...FOOTBALL_CACHE_PATTERNS), 10_000, 'football cache clear');
      cacheCleared = true;
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'football cache clear failed (entries expire by TTL)');
    }
    try {
      // Waiting/delayed BullMQ jobs point at deleted task ids; remove them.
      // Completed/failed job history and Redis configuration are untouched.
      const { getSyncQueue, stopWorker } = await import('../sync/engine.js');
      try {
        await withTimeout(getSyncQueue().drain(true), 10_000, 'sync queue drain');
        queueDrained = true;
      } finally {
        await withTimeout(stopWorker(), 5_000, 'sync queue close').catch(() => undefined);
      }
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'sync queue drain failed (stale jobs are ignored by the worker)');
    }
  }

  const totalDeleted = outcome.deleted.reduce((s, t) => s + t.rows, 0);
  const result: ResetResult = {
    mode: 'executed',
    tables: outcome.before,
    totalRows: outcome.before.reduce((s, t) => s + t.rows, 0),
    protectedTables: outcome.protectedBefore,
    deleted: outcome.deleted,
    totalDeleted,
    protectedUnchanged: true,
    cacheCleared,
    queueDrained,
    durationMs: Date.now() - t0,
  };
  logger.info({ totalDeleted, durationMs: result.durationMs }, 'imported football data reset completed');
  return result;
}
