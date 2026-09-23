import { config } from '../config.js';
import { logger } from '../logger.js';
import { enqueueTask } from './tasksDb.js';
import { potentiallyLiveCount, pendingFinalizations, taskHandlers } from './handlers.js';
import { acquireLock, releaseLock, cacheGetJson } from '../redis/client.js';
import { providerClient } from '../provider/client.js';
import { runMigrations } from '../db/migrate.js';

const log = logger.child({ mod: 'scheduler' });

interface ScheduleRule {
  name: string;
  everyMs: number;
  taskType: string;
  payload?: Record<string, unknown>;
  priority: number;
  guard?: () => Promise<boolean>;
}

const rules: ScheduleRule[] = [
  {
    name: 'live',
    everyMs: config.workers.livePollSeconds * 1000,
    taskType: 'sync.live',
    priority: 10,
    // do not burn quota when nothing is on the pitch
    guard: async () => (await potentiallyLiveCount()) > 0,
  },
  {
    name: 'upcoming',
    everyMs: 15 * 60 * 1000,
    taskType: 'sync.upcoming',
    priority: 7,
  },
  {
    name: 'finalizations',
    everyMs: 5 * 60 * 1000,
    taskType: 'sync.finalize-pending',
    priority: 8,
  },
  {
    name: 'standings',
    everyMs: 2 * 60 * 60 * 1000,
    taskType: 'sync.standings',
    priority: 6,
  },
  {
    name: 'injuries',
    everyMs: 12 * 60 * 60 * 1000,
    taskType: 'sync.injuries',
    priority: 4,
  },
  {
    name: 'features-rebuild',
    everyMs: 30 * 60 * 1000,
    taskType: 'features.rebuild',
    priority: 5,
  },
  {
    name: 'cache-warm',
    everyMs: 60 * 60 * 1000,
    taskType: 'cache.warm',
    priority: 3,
  },
  {
    name: 'quota-status',
    everyMs: 30 * 60 * 1000,
    taskType: 'sync.quota-status',
    priority: 2,
  },
];

async function schedulerTick(): Promise<void> {
  for (const rule of rules) {
    const lockKey = `scheduler:${rule.name}`;
    if (!(await acquireLock(lockKey, Math.floor(rule.everyMs / 1000) - 1))) continue;
    try {
      if (rule.guard && !(await rule.guard())) {
        log.debug({ rule: rule.name }, 'skipped by guard');
        continue;
      }
      await enqueueTask(rule.taskType, rule.payload ?? {}, { priority: rule.priority, uniqueKey: `sched:${rule.name}:${Date.now()}` });
      log.debug({ rule: rule.name }, 'scheduled');
    } finally {
      releaseLock(lockKey);
    }
  }
}

/** Extra handlers owned by the scheduler process. */
export function registerSchedulerHandlers(): void {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { taskHandlers } = require('./handlers.js') as typeof import('./handlers.js');
  taskHandlers['sync.finalize-pending'] = async () => {
    const { enqueueTask } = await import('./tasksDb.js');
    const ids = await pendingFinalizations(200);
    for (const fixtureId of ids) {
      await enqueueTask('postmatch.finalize', { fixtureId }, { priority: 7, uniqueKey: `postmatch:${fixtureId}` });
    }
    return { pending: ids.length };
  };
  taskHandlers['sync.quota-status'] = async () => {
    const status = await providerClient.checkStatus();
    return status;
  };
}

export async function startScheduler(): Promise<void> {
  if (!config.workers.schedulerEnabled) {
    log.info('scheduler disabled (SCHEDULER_ENABLED=false)');
    return;
  }
  registerSchedulerHandlers();
  // scheduler table markers rely on migrations having run
  await runMigrations().catch((err) => log.warn({ err: err instanceof Error ? err.message : err }, 'scheduler: migrations already applied or failed'));
  log.info({ rules: rules.map((r) => r.name) }, 'scheduler started');
  void (async () => {
    for (;;) {
      try {
        await schedulerTick();
      } catch (err) {
        log.error({ err: err instanceof Error ? err.message : err }, 'scheduler tick failed');
      }
      await new Promise((r) => setTimeout(r, 30_000));
    }
  })();
}

/** Used in tests / one-shot invocations. */
export async function scheduleOnce(name: string): Promise<boolean> {
  const rule = rules.find((r) => r.name === name);
  if (!rule) return false;
  if (rule.guard && !(await rule.guard())) return false;
  await enqueueTask(rule.taskType, rule.payload ?? {}, { priority: rule.priority });
  return true;
}

export async function lastLiveSnapshot(): Promise<{ fixtureIds: number[]; at: string } | null> {
  return cacheGetJson<{ fixtureIds: number[]; at: string }>('live:fixtures');
}
