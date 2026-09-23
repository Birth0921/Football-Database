import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from './pool.js';
import { logger } from '../logger.js';

const log = logger.child({ mod: 'migrate' });

/** Locate the migrations directory whether running from src (tsx) or dist. */
function migrationsDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, '../../migrations'),
    path.resolve(here, '../../../migrations'), // dist/db -> root
    path.resolve(process.cwd(), 'migrations'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  throw new Error(`migrations directory not found (tried ${candidates.join(', ')})`);
}

export async function runMigrations(): Promise<{ applied: string[]; skipped: string[] }> {
  const dir = migrationsDir();
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();

  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  const { rows } = await pool.query<{ name: string }>('SELECT name FROM schema_migrations');
  const applied = new Set(rows.map((r) => r.name));

  const appliedNow: string[] = [];
  const skipped: string[] = [];

  for (const file of files) {
    if (applied.has(file)) {
      skipped.push(file);
      continue;
    }
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      await client.query('COMMIT');
      appliedNow.push(file);
      log.info({ migration: file }, 'migration applied');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      log.error({ migration: file, err: err instanceof Error ? err.message : err }, 'migration failed');
      throw err;
    } finally {
      client.release();
    }
  }
  return { applied: appliedNow, skipped };
}

/** Allow CLI invocation: npm run cli -- database:migrate */
if (process.argv[1] && process.argv[1].endsWith('migrate-only')) {
  runMigrations()
    .then((r) => {
      // eslint-disable-next-line no-console
      console.log(`Applied ${r.applied.length} migration(s).`);
      process.exit(0);
    })
    .catch((e) => {
      // eslint-disable-next-line no-console
      console.error(e);
      process.exit(1);
    });
}
