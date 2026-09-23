import { config } from '../config.js';
import { logger } from '../logger.js';
import { claimTasks, finishTask, requeueStaleRunning, type SyncTask } from './tasksDb.js';
import { taskHandlers } from './handlers.js';
import { acquireLock, releaseLock } from '../redis/client.js';

const log = logger.child({ mod: 'sync-worker' });

let running = false;
let activeCount = 0;
const MIN_PRIORITY_FOR_INLINE = 0;

/** Execute a single task with full error/backoff handling. */
export async function executeTask(task: SyncTask): Promise<boolean> {
  const handler = taskHandlers[task.task_type];
  if (!handler) {
    await finishTask(task, 'failed', `no handler registered for task type ${task.task_type}`, 3600);
    return false;
  }
  try {
    const result = await handler(task);
    await finishTask(task, 'completed');
    log.debug({ taskId: task.id, type: task.task_type, result }, 'task completed');
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const attemptsLeft = task.max_attempts - task.attempts;
    const backoff = Math.min(3600, 30 * 2 ** Math.max(0, task.attempts - 1));
    await finishTask(task, 'failed', message, backoff);
    log.warn({ taskId: task.id, type: task.task_type, err: message, attemptsLeft, backoff }, 'task failed');
    return false;
  }
}

/** Run the due tasks now (used by the daemon loop and by CLI inline mode). */
export async function runDueTasks(limit = config.workers.concurrency * 2): Promise<{ claimed: number; ok: number; failed: number }> {
  const tasks = await claimTasks(limit);
  let ok = 0;
  let failed = 0;
  // bounded concurrency
  const queue = [...tasks];
  const workers: Promise<void>[] = [];
  for (let i = 0; i < Math.min(config.workers.concurrency, Math.max(1, queue.length)); i++) {
    workers.push(
      (async () => {
        for (;;) {
          const task = queue.shift();
          if (!task) return;
          activeCount++;
          const success = await executeTask(task);
          activeCount--;
          success ? ok++ : failed++;
        }
      })(),
    );
  }
  await Promise.all(workers);
  return { claimed: tasks.length, ok, failed };
}

/** Daemon loop for the worker process. */
export async function startWorkerLoop(): Promise<void> {
  if (running) return;
  running = true;
  log.info({ concurrency: config.workers.concurrency }, 'sync worker loop started');
  let tick = 0;
  for (;;) {
    try {
      tick++;
      if (tick % 20 === 0) await requeueStaleRunning(15);
      const lockOk = await acquireLock('sync-worker:loop-lock', 15);
      if (lockOk) {
        await runDueTasks();
        releaseLock('sync-worker:loop-lock');
      } else {
        await new Promise((r) => setTimeout(r, 3000));
      }
      await new Promise((r) => setTimeout(r, 1000));
    } catch (err) {
      log.error({ err: err instanceof Error ? err.message : err }, 'worker loop error');
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

export function workerStats(): { active: number } {
  return { active: activeCount };
}

export { MIN_PRIORITY_FOR_INLINE };
