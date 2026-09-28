-- 0003: quota-aware task deferral + provider quota reconciliation.
--
-- sync_tasks.quota_defers counts how often a task was deferred because of
-- provider-quota policy (never burns failure attempts); used for exponential
-- backoff so deferred tasks are not rapidly retried.
--
-- provider_quota.reconciled_at records when the counters were last
-- synchronised with the authoritative provider /status response.

ALTER TABLE sync_tasks ADD COLUMN IF NOT EXISTS quota_defers INT NOT NULL DEFAULT 0;

ALTER TABLE provider_quota ADD COLUMN IF NOT EXISTS reconciled_at TIMESTAMPTZ;
