/**
 * Background worker: periodic PostgreSQL task dispatcher.
 * Restart-safe: all task state lives in sync_tasks / sync_jobs.
 * Redis is used by the application as a cache, not as the task transport.
 */
import { registerAllHandlers } from '../sync/handlers.js';
import { dispatchDueTasks } from '../sync/engine.js';
import { logger } from '../lib/logger.js';
import { config, ensureSecretsForProduction } from '../config.js';

async function main(): Promise<void> {
  ensureSecretsForProduction();
  registerAllHandlers();
  let sweeping = false;

  const sweep = async (limit: number): Promise<void> => {
    if (sweeping) return;
    sweeping = true;
    try {
      await dispatchDueTasks(limit);
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'dispatch sweep failed');
    } finally {
      sweeping = false;
    }
  };

  // The worker owns execution. Claims are atomic in PostgreSQL and tasks are
  // processed with bounded concurrency to keep memory/CPU/provider pressure
  // predictable on the 1-vCPU VPS.
  void sweep(20);
  const sweepTimer = setInterval(() => {
    void sweep(10);
  }, config.workerSweepIntervalSeconds * 1000);

  logger.info({ providerMode: config.providerMode }, 'worker ready');

  const shutdown = async () => {
    clearInterval(sweepTimer);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch((err) => {
  logger.error({ err }, 'worker failed to start');
  process.exit(1);
});
