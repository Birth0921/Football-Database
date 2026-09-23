/**
 * Worker process: runs the sync task loop + scheduler.
 * Run with: npm run worker
 */
import { logger } from '../logger.js';
import { startWorkerLoop } from '../sync/worker.js';
import { startScheduler } from '../sync/scheduler.js';

const log = logger.child({ mod: 'worker-main' });

async function main(): Promise<void> {
  log.info('starting worker + scheduler');
  await startScheduler();
  await startWorkerLoop();
}

void main().catch((err) => {
  log.error({ err: err instanceof Error ? err.message : err }, 'worker crashed');
  process.exit(1);
});
