/**
 * Sync engine executor. Handlers are pure task processors; the engine adds:
 * retries with exponential backoff, retry limits, idempotent re-runs, structured
 * failure records, and BullMQ integration (Redis-backed queue) on top of the
 * PostgreSQL task table (source of truth → restart-safe + resumable).
 */
import { Queue, Worker, Job } from 'bullmq';
import { logger } from '../lib/logger.js';
import { config } from '../config.js';

/** BullMQ requires maxRetriesPerRequest = null on its blocking connections. */
function bullConnection() {
  return { url: config.redisUrl, maxRetriesPerRequest: null as null };
}
import type { SyncTaskRow } from '../types.js';
import { claimDueTasks, claimTaskById, deferTaskForQuota, markTaskDone, markTaskFailed, markTaskSkipped, requeueStuckTasks } from './tasks.js';
import { isPermanentTaskError, isScopedTaskType, isTaskInScope, SCOPE_SKIP_PREFIX } from './scope-guard.js';
import { quotaManager } from './quota.js';

export type TaskHandler = (params: Record<string, unknown>, task: SyncTaskRow) => Promise<unknown>;

const handlers = new Map<string, TaskHandler>();

export function registerHandler(taskType: string, handler: TaskHandler): void {
  handlers.set(taskType, handler);
}

export function getHandler(taskType: string): TaskHandler | undefined {
  return handlers.get(taskType);
}

export function registeredTaskTypes(): string[] {
  return [...handlers.keys()].sort();
}

export async function processTask(task: SyncTaskRow): Promise<boolean> {
  const handler = handlers.get(task.task_type);
  const log = logger.child({ task: task.task_key, type: task.task_type, attempt: task.attempts });
  const t0 = Date.now();
  (globalThis as { __syncTaskKey?: string }).__syncTaskKey = task.task_key;
  (globalThis as { __syncTaskType?: string }).__syncTaskType = task.task_type;
  const requestedClass = task.params?.quotaClass;
  const taskClass = requestedClass === 'essential' || requestedClass === 'background'
    ? requestedClass
    : task.task_type;
  try {
    if (!handler) {
      throw new Error(`No handler registered for task type '${task.task_type}'`);
    }
    // Quota policy gate: essential (live/upcoming) sync keeps running while
    // quota is low; background work is deferred with exponential backoff and
    // never burns failure attempts. A task may explicitly downgrade a shared
    // handler, e.g. historical fixture details.
    // Scope gate BEFORE the quota gate: a task whose competition/season or
    // fixture no longer exists (or left the approved scope) is skipped
    // permanently — it must not be deferred, retried or reach the provider.
    if (isScopedTaskType(task.task_type) && !(await isTaskInScope(task.task_type, task.params ?? {}))) {
      await markTaskSkipped(task.id, `${SCOPE_SKIP_PREFIX}: ${task.task_key}`, Date.now() - t0);
      log.warn('task skipped permanently: target missing or outside approved import scope');
      return true;
    }
    const gate = await quotaManager.allows(taskClass);
    if (!gate.allowed) {
      const delay = quotaManager.deferDelaySeconds(Number(task.quota_defers ?? 0));
      await deferTaskForQuota(task.id, delay, `deferred: provider quota ${gate.state} (${gate.dailyRemaining} requests remaining)`);
      log.info({ state: gate.state, class: gate.class, remaining: gate.dailyRemaining, deferredSeconds: delay }, 'task deferred for provider quota (rescheduled with backoff)');
      return true;
    }
    const summary = await handler(task.params ?? {}, task);
    await markTaskDone(task.id, summary, Date.now() - t0);
    log.info({ summary }, 'task done');
    return true;
  } catch (err) {
    const e = err as Error;
    if (isPermanentTaskError(e)) {
      await markTaskSkipped(task.id, `skipped (permanent): ${e.message}`, Date.now() - t0);
      log.warn({ err: e.message }, 'task skipped permanently (not retryable)');
      return true;
    }
    const failed = await markTaskFailed(task.id, e, Date.now() - t0);
    log.error({ err: e.message, status: failed.status, attempts: failed.attempts }, 'task failed');
    return false;
  } finally {
    delete (globalThis as { __syncTaskKey?: string }).__syncTaskKey;
    delete (globalThis as { __syncTaskType?: string }).__syncTaskType;
  }
}

let syncQueue: Queue | null = null;

export function getSyncQueue(): Queue {
  if (!syncQueue) {
    syncQueue = new Queue('sync', {
      connection: bullConnection(),
      defaultJobOptions: {
        removeOnComplete: 1000,
        removeOnFail: 5000,
        attempts: 1, // retries are managed by the DB task row (exponential backoff)
      },
    });
  }
  return syncQueue;
}

/** Push a DB task onto the BullMQ transport. */
export async function dispatchTask(taskId: number): Promise<void> {
  try {
    await getSyncQueue().add('sync-task', { taskId }, { jobId: `task-${taskId}` });
  } catch (err) {
    logger.warn({ err: (err as Error).message, taskId }, 'bullmq dispatch failed — DB dispatcher will pick it up');
  }
}

/** Enqueue all due DB tasks that have not been dispatched. */
export async function dispatchDueTasks(limit = 20): Promise<number> {
  await requeueStuckTasks(2).catch(() => 0);
  const tasks = await claimDueTasks(limit);
  for (const t of tasks) {
    // reset claim — BullMQ worker will claim via claimTaskById for exactly-once semantics
    const ok = await processIfClaimable(t);
    void ok;
  }
  return tasks.length;
}

async function processIfClaimable(task: SyncTaskRow): Promise<void> {
  // task already claimed by claimDueTasks (status running, attempts bumped)
  await processTask(task);
}

let worker: Worker | null = null;

export async function startWorker(concurrency = 2): Promise<Worker> {
  if (worker) return worker;
  worker = new Worker(
    'sync',
    async (job: Job<{ taskId: number }>) => {
      const claimed = await claimTaskById(job.data.taskId);
      if (!claimed) {
        logger.debug({ taskId: job.data.taskId }, 'task not claimable (already done/running)');
        return;
      }
      await processTask(claimed);
    },
    { connection: bullConnection(), concurrency },
  );
  worker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, err: err.message }, 'bullmq job failed');
  });
  logger.info({ concurrency }, 'sync worker started');
  return worker;
}

export async function stopWorker(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
  }
  if (syncQueue) {
    await syncQueue.close();
    syncQueue = null;
  }
}

/** Run a one-shot drain of due tasks (CLI `current:sync` etc.). */
export async function drainDueTasks(max = 10_000): Promise<{ processed: number; succeeded: number }> {
  let processed = 0;
  let succeeded = 0;
  await requeueStuckTasks(2).catch(() => 0);
  while (processed < max) {
    const batch = await claimDueTasks(Math.min(5, max - processed));
    if (batch.length === 0) break;
    for (const t of batch) {
      const ok = await processTask(t);
      processed += 1;
      if (ok) succeeded += 1;
    }
  }
  return { processed, succeeded };
}

export function taskTypeAvailable(): string[] {
  return registeredTaskTypes();
}

export const engineConfig = {
  providerMode: config.providerMode,
};
