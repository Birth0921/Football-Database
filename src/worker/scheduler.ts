/**
 * Scheduler: recurring current-season automation at priority-aware cadences.
 * - live matches: fast polling only when matches are in play
 * - upcoming fixtures / post-match scan: moderate cadence
 * - metadata / injuries / transfers: slow cadence
 * Uses DB task keys (idempotent) + BullMQ dispatch; cron-like via setInterval
 * with run-once-per-window guards.
 */
import { registerAllHandlers } from '../sync/handlers.js';
import { enqueueTask, upsertJob } from '../sync/tasks.js';
import { dispatchDueTasks, getSyncQueue, startWorker, stopWorker } from '../sync/engine.js';
import { logger } from '../lib/logger.js';
import { config, ensureSecretsForProduction } from '../config.js';
import { queryOne } from '../lib/db.js';
import { reconcileQuota } from '../sync/quota-reconcile.js';

let lastQuotaReconcile = 0;

async function scheduleCycle(): Promise<void> {
  const now = Date.now();
  const windowKey = `cycle:${Math.floor(now / 60_000)}`;
  await upsertJob(windowKey, 'scheduler', {}, 10);

  // live sync: every minute when matches are likely in play, otherwise lazy
  const liveMatches = await queryOne<{ c: number }>(
    `SELECT count(*)::int AS c FROM fixtures WHERE status_short IN ('1H','HT','2H','ET','BT','P','INT')`,
  );
  const day = new Date().getUTCDay();
  const hour = new Date().getUTCHours();
  const matchWindow = hour >= 11 && hour <= 22; // typical kick-off window UTC
  if (matchWindow || (liveMatches?.c ?? 0) > 0 || day === 0 || day === 6) {
    await enqueueTask({
      taskKey: `live:sync:${Math.floor(now / (config.syncLiveIntervalSeconds * 1000))}`,
      taskType: 'live:sync',
      priority: 10,
    });
  }

  await enqueueTask({
    taskKey: `upcoming:sync:${Math.floor(now / (config.syncUpcomingIntervalSeconds * 1000))}`,
    taskType: 'upcoming:sync',
    params: { daysAhead: 7 },
    priority: 20,
  });

  await enqueueTask({
    taskKey: `postmatch:scan:${Math.floor(now / (config.syncPostmatchIntervalSeconds * 1000))}`,
    taskType: 'postmatch:scan',
    priority: 25,
  });

  await enqueueTask({
    taskKey: `metadata:refresh:${Math.floor(now / (config.syncMetadataIntervalSeconds * 1000))}`,
    taskType: 'season-window:enqueue',
    priority: 90,
  });

  await enqueueTask({
    taskKey: `stats:rollup:${Math.floor(now / 3600_000)}`,
    taskType: 'stats:recalculate:all',
    priority: 95,
    scheduledFor: new Date(now + 5 * 60_000),
  });

  // Reconcile quota with the provider's own counters every 15 minutes (live
  // mode). /status is quota-free, so this runs even in CRITICAL/EXHAUSTED.
  if (config.providerMode === 'live' && now - lastQuotaReconcile > 15 * 60_000) {
    lastQuotaReconcile = now;
    await reconcileQuota().catch((err) => logger.warn({ err: (err as Error).message }, 'quota reconcile failed'));
  }

  await dispatchDueTasks(30);
  logger.debug('scheduler cycle enqueued');
}

async function main(): Promise<void> {
  ensureSecretsForProduction();
  registerAllHandlers();
  await startWorker(1); // scheduler node also processes (safe: task claims are atomic)
  const queue = getSyncQueue();
  void queue;

  await scheduleCycle();
  const timer = setInterval(() => {
    void scheduleCycle().catch((err) => logger.error({ err: (err as Error).message }, 'scheduler cycle failed'));
  }, 30_000);

  logger.info('scheduler ready');

  const shutdown = async () => {
    clearInterval(timer);
    await stopWorker();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch((err) => {
  logger.error({ err }, 'scheduler failed to start');
  process.exit(1);
});
