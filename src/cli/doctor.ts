/** Environment doctor: verifies DB, Redis, provider access, migrations. */
import { runCli, parseArgs } from './common.js';
import { queryOne } from '../lib/db.js';
import { redisPing } from '../lib/redis.js';
import { getProvider } from '../provider/client.js';
import { config } from '../config.js';
import { runMigrations } from '../lib/migrate.js';

void parseArgs;
runCli(async () => {
  const report: Record<string, unknown> = {};
  report.providerMode = config.providerMode;
  try {
    await runMigrations({ statusOnly: true });
    const row = await queryOne<{ c: number }>(`SELECT count(*)::int AS c FROM schema_migrations`);
    report.database = { ok: true, migrationsApplied: row?.c ?? 0 };
  } catch (err) {
    report.database = { ok: false, error: (err as Error).message };
  }
  report.redis = { ok: await redisPing() };
  try {
    const provider = await getProvider();
    const verify = await provider.verifyCredentials();
    report.provider = verify;
  } catch (err) {
    report.provider = { ok: false, detail: (err as Error).message };
  }
  return report;
});
