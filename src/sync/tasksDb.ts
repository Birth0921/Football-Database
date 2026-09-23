import { query } from '../db/pool.js';
import { logger } from '../logger.js';

const log = logger.child({ mod: 'sync-db' });

export interface SyncTask {
  id: number;
  job_id: number | null;
  task_type: string;
  status: string;
  priority: number;
  attempts: number;
  max_attempts: number;
  scheduled_at: Date;
  payload: Record<string, unknown>;
  unique_key: string | null;
  last_error: string | null;
}

export interface EnqueueOptions {
  jobType?: string;
  priority?: number;
  maxAttempts?: number;
  uniqueKey?: string | null;
  scheduledAt?: Date;
}

/** Create (or reuse) a job of the given type and add tasks to it. */
export async function createJob(jobType: string, payload: Record<string, unknown> = {}, priority = 5): Promise<number> {
  const { rows } = await query<{ id: number }>(
    `INSERT INTO sync_jobs (job_type, status, priority, payload) VALUES ($1, 'pending', $2, $3::jsonb) RETURNING id`,
    [jobType, priority, JSON.stringify(payload)],
  );
  return rows[0].id;
}

export async function enqueueTask(
  taskType: string,
  payload: Record<string, unknown>,
  opts: EnqueueOptions & { jobId?: number } = {},
): Promise<{ id: number; reused: boolean }> {
  const uniqueKey = opts.uniqueKey ?? null;
  if (uniqueKey) {
    // idempotency: reuse an identical unfinished task instead of duplicating work
    const { rows } = await query<{ id: number }>(
      `SELECT id FROM sync_tasks WHERE unique_key = $1 AND status IN ('pending','running') LIMIT 1`,
      [uniqueKey],
    );
    if (rows[0]) return { id: rows[0].id, reused: true };
  }
  const { rows } = await query<{ id: number }>(
    `INSERT INTO sync_tasks (job_id, task_type, priority, max_attempts, scheduled_at, payload, unique_key)
     VALUES ($1, $2, $3, $4, COALESCE($5, now()), $6::jsonb, $7) RETURNING id`,
    [opts.jobId ?? null, taskType, opts.priority ?? 5, opts.maxAttempts ?? 5, opts.scheduledAt ?? null, JSON.stringify(payload), uniqueKey],
  );
  if (opts.jobId) {
    await query(`UPDATE sync_jobs SET total_tasks = total_tasks + 1, updated_at = now() WHERE id = $1`, [opts.jobId]);
  }
  return { id: rows[0].id, reused: false };
}

/** Claim up to `limit` due tasks (restart-safe via FOR UPDATE SKIP LOCKED). */
export async function claimTasks(limit: number): Promise<SyncTask[]> {
  const { rows } = await query<SyncTask>(
    `WITH claimed AS (
       SELECT id FROM sync_tasks
       WHERE status = 'pending' AND scheduled_at <= now()
       ORDER BY priority DESC, scheduled_at ASC
       LIMIT $1
       FOR UPDATE SKIP LOCKED
     )
     UPDATE sync_tasks t SET status = 'running', started_at = now(), attempts = t.attempts + 1, updated_at = now()
     FROM claimed c
     WHERE t.id = c.id
     RETURNING t.*`,
    [limit],
  );
  return rows as unknown as SyncTask[];
}

export async function completeTask(id: number): Promise<void> {
  await query(
    `UPDATE sync_tasks SET status='completed', completed_at=now(), updated_at=now(), last_error=NULL WHERE id=$1`,
    [id],
  );
}

export async function failTask(id: number, error: string, backoffSeconds: number): Promise<void> {
  await query(
    `UPDATE sync_tasks SET
       status = CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'pending' END,
       scheduled_at = now() + ($2 || ' seconds')::interval,
       last_error = $3, updated_at = now()
     WHERE id = $1`,
    [id, String(backoffSeconds), error.slice(0, 2000)],
  );
}

export async function skipTask(id: number, reason: string): Promise<void> {
  await query(`UPDATE sync_tasks SET status='skipped', last_error=$2, completed_at=now(), updated_at=now() WHERE id=$1`, [id, reason.slice(0, 500)]);
}

async function updateJobCounters(jobId: number | null): Promise<void> {
  if (!jobId) return;
  await query(
    `UPDATE sync_jobs SET
       completed_tasks = (SELECT count(*) FROM sync_tasks WHERE job_id = $1 AND status = 'completed'),
       failed_tasks = (SELECT count(*) FROM sync_tasks WHERE job_id = $1 AND status = 'failed'),
       status = CASE
         WHEN (SELECT count(*) FROM sync_tasks WHERE job_id = $1 AND status IN ('pending','running')) = 0
           THEN CASE WHEN (SELECT count(*) FROM sync_tasks WHERE job_id=$1 AND status='failed') > 0 THEN 'failed' ELSE 'completed' END
         ELSE 'running' END,
       started_at = COALESCE(started_at, now()),
       finished_at = CASE
         WHEN (SELECT count(*) FROM sync_tasks WHERE job_id = $1 AND status IN ('pending','running')) = 0 THEN now()
         ELSE finished_at END,
       last_error = (SELECT last_error FROM sync_tasks WHERE job_id = $1 AND status='failed' ORDER BY updated_at DESC LIMIT 1),
       updated_at = now()
     WHERE id = $1`,
    [jobId],
  );
}

/** Mark task finished and refresh its job rollups. */
export async function finishTask(task: { id: number; job_id: number | null }, status: 'completed' | 'failed' | 'skipped', error?: string, backoffSeconds = 30): Promise<void> {
  if (status === 'completed') await completeTask(task.id);
  else if (status === 'skipped') await skipTask(task.id, error ?? 'skipped');
  else await failTask(task.id, error ?? 'unknown error', backoffSeconds);
  await updateJobCounters(task.job_id);
}

export async function setSyncState(key: string, value: Record<string, unknown>): Promise<void> {
  await query(
    `INSERT INTO sync_state (key, value, updated_at) VALUES ($1, $2::jsonb, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, JSON.stringify(value)],
  );
}

export async function getSyncState<T = Record<string, unknown>>(key: string): Promise<T | null> {
  const { rows } = await query<{ value: T }>(`SELECT value FROM sync_state WHERE key = $1`, [key]);
  return rows[0]?.value ?? null;
}

/** Requeue tasks stuck in 'running' (e.g. after a crash). */
export async function requeueStaleRunning(olderThanMinutes = 15): Promise<number> {
  const { rowCount } = await query(
    `UPDATE sync_tasks SET status='pending', scheduled_at = now(), updated_at = now()
     WHERE status='running' AND started_at < now() - ($1 || ' minutes')::interval`,
    [String(olderThanMinutes)],
  );
  if (rowCount) log.warn({ requeued: rowCount }, 'requeued stale running tasks');
  return rowCount ?? 0;
}

export async function failedTasks(limit = 50): Promise<SyncTask[]> {
  const { rows } = await query<SyncTask>(
    `SELECT * FROM sync_tasks WHERE status='failed' ORDER BY updated_at DESC LIMIT $1`,
    [limit],
  );
  return rows as unknown as SyncTask[];
}

export async function retryFailedTasks(): Promise<number> {
  const { rowCount } = await query(
    `UPDATE sync_tasks SET status='pending', attempts=0, scheduled_at=now(), updated_at=now() WHERE status='failed'`,
  );
  return rowCount ?? 0;
}

export async function syncStats(): Promise<{ pending: number; running: number; failed: number; completed: number; skipped: number }> {
  const { rows } = await query<Record<string, string>>(
    `SELECT
       count(*) FILTER (WHERE status='pending')::text AS pending,
       count(*) FILTER (WHERE status='running')::text AS running,
       count(*) FILTER (WHERE status='failed')::text AS failed,
       count(*) FILTER (WHERE status='completed')::text AS completed,
       count(*) FILTER (WHERE status='skipped')::text AS skipped
     FROM sync_tasks`,
  );
  const r = rows[0] ?? {};
  return {
    pending: parseInt(r.pending ?? '0', 10),
    running: parseInt(r.running ?? '0', 10),
    failed: parseInt(r.failed ?? '0', 10),
    completed: parseInt(r.completed ?? '0', 10),
    skipped: parseInt(r.skipped ?? '0', 10),
  };
}
