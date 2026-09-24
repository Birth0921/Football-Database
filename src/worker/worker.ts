/**
 * Background worker: BullMQ sync worker + periodic DB-task dispatcher.
 * Restart-safe: all state lives in sync_tasks / sync_jobs (PostgreSQL).
 */
import { registerAllHandlers } from '../sync/handlers.js';
import { startWorker, stopWorker, dispatchDueTasks, getSyncQueue } from '../sync/engine.js';
import { logger } from '../lib/logger.js';
import { config, ensureSecretsForProduction } from '../config.js';

async function main(): Promise<void> {
  ensureSecretsForProduction();
  registerAllHandlers();
  await startWorker(2);

  // periodic sweep: picks up queued tasks (also after crashes / grace re-dispatch)
  const sweep = setInterval(() => {
    void dispatchDueTasks(10).catch((err) => logger.warn({ err: (err as Error).message }, 'dispatch sweep failed'));
  }, 5000);
  void dispatchDueTasks(50);

  logger.info({ providerMode: config.providerMode }, 'worker ready');

  const shutdown = async () => {
    clearInterval(sweep);
    await stopWorker();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch((err) => {
  logger.error({ err }, 'worker failed to start');
  process.exit(1);
});

export { getSyncQueue };
