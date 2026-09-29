/**
 * Persistent, restart-safe, resumable, idempotent task queue stored in PostgreSQL.
 * BullMQ (Redis) provides scheduling/execution transport; this table is the
 * source of truth, so a crash never restarts an import from zero.
 */
import { query, queryOne } from '../lib/db.js';
import type { SyncTaskRow } from '../types.js';
import { isScopedTaskType, isTaskInScope, SCOPE_SKIP_PREFIX } from './scope-guard.js';

export interface EnqueueTaskInput {
  taskKey: string;
  taskType: string;
  params?: Record<string, unknown>;
  priority?: number;
  jobId?: number | null;
  scheduledFor?: Date;
  maxAttempts?: number;
}

export async function upsertJob(jobKey: string, kind: string, params: Record<string, unknown> = {}, priority = 100): Promise<number> {
  const row = await queryOne<{ id: number }>(
    `INSERT INTO sync_jobs (job_key, kind, params, priority, status)
     VALUES ($1, $2, $3, $4, 'pending')
     ON CONFLICT (job_key) DO UPDATE SET params = EXCLUDED.params, updated_at = now()
     RETURNING id`,
    [jobKey, kind, JSON.stringify(params), priority],
  );
  return row!.id;
}

/**
 * Idempotent enqueue (one row per task_key). Competition/season- and
 * fixture-scoped tasks are only accepted when their target is inside the
 * approved import scope; otherwise nothing is queued, any queued row with the
 * same key is marked `skipped`, and 0 is returned.
 */
export async function enqueueTask(input: EnqueueTaskInput): Promise<number> {
  if (isScopedTaskType(input.taskType) && !(await isTaskInScope(input.taskType, input.params ?? {}))) {
    await query(
      `UPDATE sync_tasks
          SET status = 'skipped', completed_at = now(), last_error = $2, updated_at = now()
        WHERE task_key = $1 AND status IN ('pending', 'failed')`,
      [input.taskKey, `${SCOPE_SKIP_PREFIX} (rejected at enqueue)`],
    );
    return 0;
  }
  const row = await queryOne<{ id: number }>(
    `INSERT INTO sync_tasks (job_id, task_key, task_type, params, priority, scheduled_for, max_attempts, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')
     ON CONFLICT (task_key) DO UPDATE SET
       -- A running task must not be reset by an overlapping scheduler cycle;
       -- done tasks are immutable, while failed/pending tasks may be resumed.
       scheduled_for = CASE
         WHEN sync_tasks.status IN ('done', 'running') OR sync_tasks.scheduled_for > now() THEN sync_tasks.scheduled_for
         ELSE EXCLUDED.scheduled_for
       END,
       status = CASE WHEN sync_tasks.status IN ('done', 'running') THEN sync_tasks.status ELSE 'pending' END,
       attempts = CASE
         WHEN sync_tasks.status IN ('done', 'running') OR sync_tasks.scheduled_for > now() THEN sync_tasks.attempts
         ELSE 0
       END,
       params = CASE WHEN sync_tasks.status IN ('done', 'running') THEN sync_tasks.params ELSE EXCLUDED.params END,
       priority = CASE WHEN sync_tasks.status IN ('done', 'running') THEN sync_tasks.priority ELSE EXCLUDED.priority END,
       updated_at = now()
     RETURNING id`,
    [
      input.jobId ?? null,
      input.taskKey,
      input.taskType,
      JSON.stringify(input.params ?? {}),
      input.priority ?? 100,
      input.scheduledFor ?? new Date(),
      input.maxAttempts ?? 5,
    ],
  );
  return Number(row!.id);
}

export async function enqueueTasks(inputs: EnqueueTaskInput[]): Promise<number> {
  let count = 0;
  for (const i of inputs) count += (await enqueueTask(i)) ? 1 : 0;
  return count;
}

/** Atomically claim due tasks (FOR UPDATE SKIP LOCKED → safe with multiple workers). */
export async function claimDueTasks(limit: number, opts: { includeDeferred?: boolean } = {}): Promise<SyncTaskRow[]> {
  const rows = await query<SyncTaskRow>(
    `WITH claimed AS (
       SELECT id FROM sync_tasks
        WHERE status IN ('pending', 'failed')
          AND attempts < max_attempts
          AND scheduled_for <= now() + interval '1 second'
        ORDER BY priority ASC, scheduled_for ASC
        LIMIT $1
        FOR UPDATE SKIP LOCKED
     )
     UPDATE sync_tasks t
        SET status = 'running', started_at = now(), attempts = t.attempts + 1, updated_at = now()
       FROM claimed
      WHERE t.id = claimed.id
      RETURNING t.*`,
    [limit],
  );
  void opts;
  // UPDATE … RETURNING does not preserve the CTE's ORDER BY: restore strict
  // priority order so live/current work in a batch always runs first.
  return rows.sort((a, b) =>
    Number(a.priority) - Number(b.priority)
    || new Date(a.scheduled_for).getTime() - new Date(b.scheduled_for).getTime()
    || Number(a.id) - Number(b.id));
}

export async function claimTaskById(id: number): Promise<SyncTaskRow | null> {
  const rows = await query<SyncTaskRow>(
    `UPDATE sync_tasks
        SET status = 'running', started_at = now(), attempts = attempts + 1, updated_at = now()
      WHERE id = $1 AND status IN ('pending', 'failed') AND attempts < max_attempts
      RETURNING *`,
    [id],
  );
  return rows[0] ?? null;
}

export async function markTaskDone(id: number, attempt: number, summary: unknown, durationMs: number): Promise<void> {
  await query(
    `UPDATE sync_tasks
        SET status = 'done', completed_at = now(), duration_ms = $3, result_summary = $4, last_error = NULL, updated_at = now()
      WHERE id = $1 AND status = 'running' AND attempts = $2`,
    [id, attempt, durationMs, JSON.stringify(summary ?? {})],
  );
}

export async function markTaskFailed(id: number, attempt: number, error: Error, durationMs: number): Promise<SyncTaskRow | null> {
  const rows = await query<SyncTaskRow>(
    `UPDATE sync_tasks
        SET status = CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'pending' END,
            last_error = $3,
            error_info = $4,
            duration_ms = $5,
            scheduled_for = now() + (interval '5 seconds' * power(3, LEAST(attempts, 6))),
            updated_at = now()
      WHERE id = $1
        AND status = 'running'
        AND attempts = $2
      RETURNING *`,
    [id, attempt, String(error.message).slice(0, 1000), JSON.stringify({ name: error.name, stack: String(error.stack ?? '').slice(0, 2000) }), durationMs],
  );
  return rows[0] ?? null;
}

/** Permanently skip a task (missing/out-of-scope target): never retried. */
export async function markTaskSkipped(id: number, attempt: number, reason: string, durationMs: number): Promise<SyncTaskRow | null> {
  const rows = await query<SyncTaskRow>(
    `UPDATE sync_tasks
        SET status = 'skipped', completed_at = now(), duration_ms = $4,
            last_error = $3,
            result_summary = jsonb_build_object('skipped', true, 'reason', $3::text),
            updated_at = now()
      WHERE id = $1
        AND status = 'running'
        AND attempts = $2
      RETURNING *`,
    [id, attempt, reason.slice(0, 1000), durationMs],
  );
  return rows[0] ?? null;
}

export async function retryFailedTasks(taskKeys?: string[]): Promise<number> {
  if (taskKeys && taskKeys.length) {
    const res = await query(
      `UPDATE sync_tasks SET status = 'pending', attempts = 0, scheduled_for = now(), updated_at = now()
        WHERE task_key = ANY($1) AND status = 'failed'`,
      [taskKeys],
    );
    return res.length;
  }
  await query(
    `UPDATE sync_tasks SET status = 'pending', attempts = 0, scheduled_for = now(), updated_at = now()
      WHERE status = 'failed'`,
  );
  const row = await queryOne<{ c: number }>(`SELECT count(*)::int AS c FROM sync_tasks WHERE status = 'failed'`);
  return row?.c ?? 0;
}

/**
 * Defer a task because of provider-quota policy: back to pending with a
 * future scheduled_for (exponential backoff), the claim's attempt increment
 * is rolled back so quota deferrals NEVER burn failure retries.
 */
export async function deferTaskForQuota(id: number, attempt: number, delaySeconds: number, reason: string): Promise<void> {
  await query(
    `UPDATE sync_tasks
        SET status = 'pending',
            attempts = GREATEST(attempts - 1, 0),
            quota_defers = coalesce(quota_defers, 0) + 1,
            scheduled_for = now() + ($3 || ' seconds')::interval,
            last_error = $4,
            updated_at = now()
      WHERE id = $1
        AND status = 'running'
        AND attempts = $2`,
    [id, attempt, String(Math.max(1, Math.round(delaySeconds))), reason.slice(0, 500)],
  );
}

/**
 * Crash recovery: tasks claimed but never finished (process died) go back to
 * pending. A crash must never strand work or force an import restart.
 */
export async function requeueStuckTasks(olderThanMinutes = 2): Promise<number> {
  const rows = await query(
    `UPDATE sync_tasks
        SET status = 'pending', started_at = NULL, last_error = COALESCE(last_error, 'requeued after stuck running state'),
            scheduled_for = now(), updated_at = now()
      WHERE status = 'running' AND started_at < now() - ($1 || ' minutes')::interval
      RETURNING id`,
    [olderThanMinutes],
  );
  return rows.length;
}

export async function listFailedTasks(limit = 50): Promise<SyncTaskRow[]> {
  return query<SyncTaskRow>(
    `SELECT * FROM sync_tasks WHERE status = 'failed' OR (last_error IS NOT NULL AND status = 'pending' AND attempts >= max_attempts)
      ORDER BY updated_at DESC LIMIT $1`,
    [limit],
  );
}

export async function getTaskByKey(taskKey: string): Promise<SyncTaskRow | null> {
  return queryOne<SyncTaskRow>(`SELECT * FROM sync_tasks WHERE task_key = $1`, [taskKey]);
}

export async function syncSummary(): Promise<{ pending: number; running: number; done: number; failed: number }> {
  const rows = await query<{ status: string; c: number }>(
    `SELECT status, count(*)::int AS c FROM sync_tasks GROUP BY status`,
  );
  const out = { pending: 0, running: 0, done: 0, failed: 0 };
  for (const r of rows) (out as Record<string, number>)[r.status] = r.c;
  return out;
}
