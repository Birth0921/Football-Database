import { runCli, shutdown } from './common.js';
import { runMigrations } from '../lib/migrate.js';
import { parseArgs } from './common.js';
import { query } from '../lib/db.js';

const args = parseArgs();
if (args.status) {
  runCli(async () => {
    await runMigrations({ statusOnly: true });
    const rows = await query(`SELECT name, applied_at FROM schema_migrations ORDER BY id`);
    return { applied: rows };
  });
} else {
  runCli(async () => {
    await runMigrations();
    const rows = await query(`SELECT name, applied_at FROM schema_migrations ORDER BY id`);
    return { migrations: rows };
  });
}
void shutdown;
