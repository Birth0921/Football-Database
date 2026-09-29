/**
 * Scheduler: recurring current-season automation at priority-aware cadences.
 * - live matches: fast polling only when matches are in play
 * - upcoming fixtures / post-match scan: moderate cadence
 * - metadata / injuries / transfers: slow cadence
 * Uses DB task keys (idempotent); cron-like via setInterval.
 * with run-once-per-window guards.
 */
import { registerAllHandlers } from '../sync/handlers.js';
import { enqueueTask, upsertJob } from '../sync/tasks.js';
import { logger } from '../lib/logger.js';
import { config, ensureSecretsForProduction } from '../config.js';
import { queryOne } from '../lib/db.js';
import { reconcileQuota } from '../sync/quota-reconcile.js';
import { skipOutOfScopeTasks } from '../sync/scope-guard.js';

let lastQuotaReconcile = 0;
let bootstrapTaskKey: string | null = null;
let lastScopeSweep = 0;
let lastSeasonSeen: number | null = null;

/**
 * Automatic rolling-window transition. The current season is the UTC year,
 * read on every cycle, so at 00:00 UTC on 1 January (or on the first cycle
 * after a restart) a single `season-transition:<year>` task is queued. Its
 * handler refreshes the approved catalogue — which re-scopes the window
 * (new season in, oldest season out_of_scope with its data retained),
 * promotes the former current season to historical without re-importing it,
 * and queues the bootstrap for the new current season only. The task key is
 * unique per year, so restarts never repeat a completed transition.
 */
async function ensureSeasonTransition(): Promise<void> {
  const season = config.currentImportSeason;
  if (lastSeasonSeen === season) return;
  lastSeasonSeen = season;
  await enqueueTask({
    taskKey: `season-transition:${season}`,
    taskType: 'season-window:enqueue',
    params: { season, window: config.importSeasons },
    priority: 15,
  });
  logger.info({ season, window: config.importSeasons }, 'rolling season window checked');
}

/**
 * Stop stale queued work (e.g. `teams:import` for a competition/season that no
 * longer exists or left the approved scope). Runs at startup and every five
 * minutes; cheap single UPDATE, no provider requests.
 */
async function sweepOutOfScopeTasks(now: number): Promise<void> {
  if (now - lastScopeSweep < 5 * 60_000) return;
  lastScopeSweep = now;
  const res = await skipOutOfScopeTasks();
  if (res.skipped > 0) logger.info(res, 'skipped stale tasks outside the approved import scope');
}

async function scheduleCycle(): Promise<void> {
  const now = Date.now();
  const windowKey = `cycle:${Math.floor(now / 60_000)}`;
  await upsertJob(windowKey, 'scheduler', {}, 10);
  await sweepOutOfScopeTasks(now).catch((err) => logger.warn({ err: (err as Error).message }, 'scope sweep failed'));
  await ensureSeasonTransition().catch((err) => logger.warn({ err: (err as Error).message }, 'season transition check failed'));

  // A clean production database has no in-scope pairs after migrations. Queue
  // one current refresh so the handler can initialise metadata and populate
  // the public website without requiring a manual historical import.
  const scope = await queryOne<{ c: number }>(
    `SELECT count(*)::int AS c
       FROM competition_seasons cs
       JOIN competitions c ON c.id = cs.competition_id
       JOIN seasons se ON se.id = cs.season_id
      WHERE cs.import_scope = 'in_scope'
        AND c.active = TRUE AND c.import_tier BETWEEN 1 AND 3
        AND se.year = $1`,
    [config.currentImportSeason],
  );
  if ((scope?.c ?? 0) === 0) {
    const key = `bootstrap:current:${new Date().toISOString().slice(0, 10)}`;
    // set the guard before awaiting the insert because interval callbacks can
    // overlap while a provider request is in flight.
    if (bootstrapTaskKey !== key) {
      bootstrapTaskKey = key;
      await enqueueTask({
        taskKey: key,
        taskType: 'current:sync',
        params: { daysAhead: 7 },
        priority: 10,
      });
      logger.info('current data bootstrap queued');
    }
    return;
  }

  // live sync: every minute when matches are likely in play, otherwise lazy
  const liveMatches = await queryOne<{ c: number }>(
    `SELECT count(*)::int AS c
       FROM fixtures f
       JOIN competitions c ON c.id = f.competition_id
       JOIN seasons se ON se.id = f.season_id
       JOIN competition_seasons cs ON cs.competition_id = f.competition_id AND cs.season_id = f.season_id
      WHERE f.status_short IN ('1H','HT','2H','ET','BT','P','INT')
        AND c.active = TRUE AND c.import_tier BETWEEN 1 AND 3
        AND se.year = ANY($1::int[]) AND se.import_scope = 'in_scope' AND cs.import_scope = 'in_scope'`,
    [config.importSeasons],
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
    params: { daysAhead: 7, daysBack: 0 },
    priority: 20,
  });

  // Reconcile the previous two days once per UTC day. This is separate from
  // the 15-minute upcoming window so the normal task does not duplicate date
  // requests.
  await enqueueTask({
    taskKey: `recent:sync:${new Date(now).toISOString().slice(0, 10)}`,
    taskType: 'upcoming:sync',
    params: { daysAhead: 0, daysBack: 2 },
    priority: 22,
  });

  await enqueueTask({
    taskKey: `postmatch:scan:${Math.floor(now / (config.syncPostmatchIntervalSeconds * 1000))}`,
    taskType: 'postmatch:scan',
    params: { sinceDays: 3 },
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

  logger.debug('scheduler cycle enqueued');
}

async function main(): Promise<void> {
  ensureSecretsForProduction();
  await scheduleCycle();
  const timer = setInterval(() => {
    void scheduleCycle().catch((err) => logger.error({ err: (err as Error).message }, 'scheduler cycle failed'));
  }, 30_000);

  logger.info('scheduler ready');

  const shutdown = async () => {
    clearInterval(timer);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch((err) => {
  logger.error({ err }, 'scheduler failed to start');
  process.exit(1);
});
