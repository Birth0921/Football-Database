import fs from 'node:fs';
import path from 'node:path';
import { pool, queryOne } from './db.js';
import { logger } from './logger.js';

const MIGRATIONS_DIR = path.resolve(process.cwd(), 'migrations');

export async function runMigrations(opts: { statusOnly?: boolean } = {}): Promise<void> {
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id BIGSERIAL PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);

  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const applied = new Set(
    (await queryOne<{ names: string[] }>(
      `SELECT coalesce(array_agg(name), '{}') AS names FROM schema_migrations`,
    ))?.names ?? [],
  );

  for (const file of files) {
    if (applied.has(file)) {
      logger.info({ migration: file }, 'migration already applied');
      continue;
    }
    if (opts.statusOnly) {
      logger.warn({ migration: file }, 'migration pending');
      continue;
    }
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      await client.query('COMMIT');
      logger.info({ migration: file }, 'migration applied');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      logger.error({ migration: file, err }, 'migration failed');
      throw err;
    } finally {
      client.release();
    }
  }
}
