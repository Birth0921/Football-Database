/**
 * All-in-one platform process: API + worker + scheduler.
 * Convenient for single-container deployments and the live preview.
 * For horizontal scaling, run `server` and `worker` as separate processes.
 */
import { logger } from './logger.js';
import { runMigrations } from './db/migrate.js';

const log = logger.child({ mod: 'platform' });

async function main(): Promise<void> {
  log.info('booting platform (migrations → API → worker → scheduler)');
  const mig = await runMigrations();
  log.info({ applied: mig.applied.length }, 'migrations ensured');

  const { startScheduler } = await import('./sync/scheduler.js');
  const { startWorkerLoop } = await import('./sync/worker.js');
  const { startApi } = await import('./api/server.js');

  await startScheduler();
  // worker loop runs detached; API keeps the process alive
  void startWorkerLoop().catch((err) => log.error({ err: err instanceof Error ? err.message : err }, 'worker loop crashed'));
  await startApi();
}

void main().catch((err) => {
  log.error({ err: err instanceof Error ? err.message : err }, 'platform failed to start');
  process.exit(1);
});
