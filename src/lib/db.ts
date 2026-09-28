import { Pool, PoolClient, QueryResultRow } from 'pg';
import { config } from '../config.js';
import { logger } from './logger.js';

export const pool = new Pool({
  connectionString: config.databaseUrl,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

pool.on('error', (err) => {
  logger.error({ err }, 'postgres pool error');
});

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const started = Date.now();
  const res = await pool.query<T>(text, params as never[]);
  const ms = Date.now() - started;
  if (ms > 500) logger.warn({ ms, text: text.slice(0, 120) }, 'slow query');
  return res.rows;
}

export async function queryOne<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T | null> {
  const rows = await query<T>(text, params);
  return rows[0] ?? null;
}

export async function execute(text: string, params: unknown[] = []): Promise<number> {
  const res = await pool.query(text, params as never[]);
  return res.rowCount ?? 0;
}

export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* ignore */
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function txQuery<T extends QueryResultRow = QueryResultRow>(
  client: PoolClient,
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const res = await client.query<T>(text, params as never[]);
  return res.rows;
}

/** Build an INSERT ... ON CONFLICT upsert. */
export function upsertSql(
  table: string,
  columns: string[],
  conflictColumns: string[],
  updateColumns?: string[],
): string {
  const updates = (updateColumns ?? columns.filter((c) => !conflictColumns.includes(c))).filter(
    (c) => c !== 'id' && c !== 'created_at',
  );
  const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');
  const setClause =
    updates.length > 0
      ? updates.map((c) => `${c} = EXCLUDED.${c}`).join(', ')
      : `${columns[columns.length - 1]} = EXCLUDED.${columns[columns.length - 1]}`;
  return `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})
    ON CONFLICT (${conflictColumns.join(', ')}) DO UPDATE SET ${setClause}, updated_at = now()`;
}

export async function closePool(): Promise<void> {
  await pool.end();
}
