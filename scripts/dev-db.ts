/**
 * Local development PostgreSQL via embedded-postgres (no system packages).
 * Usage:
 *   npm run devdb:start            # initialise (if needed) and run in foreground
 *   npm run devdb:start -- --port 5432
 * In production use a managed PostgreSQL and set DATABASE_URL instead.
 *
 * A local Redis is expected at REDIS_URL (see README "Local services").
 */
import EmbeddedPostgres from 'embedded-postgres';
import path from 'node:path';
import fs from 'node:fs';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const portIdx = args.indexOf('--port');
  const port = portIdx >= 0 ? Number(args[portIdx + 1]) : 5432;
  const dataDir = path.resolve(process.cwd(), '.devdata/pg');

  const pg = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: 'postgres',
    password: 'password',
    port,
    persistent: true,
  });

  if (!fs.existsSync(path.join(dataDir, 'PG_VERSION'))) {
    console.log('[devdb] initialising cluster at', dataDir);
    await pg.initialise();
  }
  console.log(`[devdb] starting postgres on 127.0.0.1:${port}`);
  await pg.start();
  try {
    await pg.createDatabase('football');
    console.log('[devdb] database "football" ready');
  } catch {
    console.log('[devdb] database "football" already exists');
  }
  console.log(`[devdb] DATABASE_URL=postgres://postgres:password@127.0.0.1:${port}/football`);
  console.log('[devdb] running — press Ctrl+C to stop');

  const stop = async () => {
    console.log('[devdb] stopping…');
    await pg.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void stop());
  process.on('SIGTERM', () => void stop());
}

main().catch((err) => {
  console.error('[devdb] failed:', err);
  process.exit(1);
});
