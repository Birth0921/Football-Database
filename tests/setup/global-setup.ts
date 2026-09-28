/**
 * Vitest global setup: run tests against a dedicated `football_test` database
 * (created on demand) so the development database is never touched. The test
 * database is wiped before every run for deterministic, idempotent re-runs.
 */
import { Pool, Client } from 'pg';
import fs from 'node:fs';
import path from 'node:path';

function loadDotEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  const p = path.resolve(process.cwd(), '.env');
  if (!fs.existsSync(p)) return out;
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
  return out;
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  const env = { ...loadDotEnv(), ...process.env };
  const base = env.DATABASE_URL ?? 'postgres://postgres:password@127.0.0.1:5432/football';
  // derive the test database URL from the configured one
  const testUrl = base.replace(/\/([A-Za-z0-9_]+)(\?|$)/, '/football_test$2');
  // workers inherit this — all test code connects to football_test
  process.env.DATABASE_URL = testUrl;

  const admin = new Client({ connectionString: base.replace(/\/([A-Za-z0-9_]+)(\?|$)/, '/postgres$2') });
  await admin.connect();
  try {
    await admin.query('CREATE DATABASE football_test').catch(() => undefined);
  } finally {
    await admin.end();
  }

  const pool = new Pool({ connectionString: testUrl });
  try {
    const { runMigrations } = await import('../../src/lib/migrate.js');
    const { closePool } = await import('../../src/lib/db.js');
    await runMigrations();
    await closePool();

    await pool.query(`
      DO $$
      DECLARE r RECORD;
      BEGIN
        FOR r IN (SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'schema_migrations') LOOP
          EXECUTE format('TRUNCATE TABLE public.%I RESTART IDENTITY CASCADE', r.tablename);
        END LOOP;
      END $$;
    `);
    // eslint-disable-next-line no-console
    console.log('[test-setup] football_test database ready (cleaned)');
  } finally {
    await pool.end();
  }

  return async () => {
    /* nothing to tear down */
  };
}
