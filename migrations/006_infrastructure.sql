-- 001: Platform infrastructure — own API key system, raw provider storage,
-- provider request log, sync engine tables.

-- ============ API CLIENTS / KEYS / USAGE (our own key system) ============
CREATE TABLE IF NOT EXISTS api_clients (
  id                      BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name                    TEXT NOT NULL,
  description             TEXT,
  client_type             TEXT NOT NULL DEFAULT 'service'
                          CHECK (client_type IN ('prediction_app','website','mobile_app','admin_dashboard','internal_service','other')),
  active                  BOOLEAN NOT NULL DEFAULT TRUE,
  rate_limit_per_minute   INTEGER NOT NULL DEFAULT 120,
  rate_limit_per_day      INTEGER NOT NULL DEFAULT 50000,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS api_clients_name_key ON api_clients (lower(name));

CREATE TABLE IF NOT EXISTS api_keys (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  client_id       BIGINT NOT NULL REFERENCES api_clients(id) ON DELETE CASCADE,
  key_prefix      TEXT NOT NULL,
  key_hash        TEXT NOT NULL,
  scopes          TEXT[] NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at    TIMESTAMPTZ,
  expires_at      TIMESTAMPTZ,
  revoked_at      TIMESTAMPTZ,
  revoked_reason  TEXT,
  grace_expires_at TIMESTAMPTZ,          -- rotation grace window (old key stays valid until then)
  rotation_of_key_id BIGINT REFERENCES api_keys(id),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS api_keys_prefix_key ON api_keys (key_prefix);
CREATE UNIQUE INDEX IF NOT EXISTS api_keys_hash_key ON api_keys (key_hash);
CREATE INDEX IF NOT EXISTS api_keys_client_idx ON api_keys (client_id);

CREATE TABLE IF NOT EXISTS api_usage (
  id                    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  api_key_id            BIGINT NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  client_id             BIGINT NOT NULL REFERENCES api_clients(id) ON DELETE CASCADE,
  day                   DATE NOT NULL,
  endpoint              TEXT NOT NULL,
  requests              BIGINT NOT NULL DEFAULT 0,
  successful_requests   BIGINT NOT NULL DEFAULT 0,
  failed_requests       BIGINT NOT NULL DEFAULT 0,
  rate_limited_requests BIGINT NOT NULL DEFAULT 0,
  last_used_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS api_usage_key_day_endpoint ON api_usage (api_key_id, day, endpoint);
CREATE INDEX IF NOT EXISTS api_usage_client_day_idx ON api_usage (client_id, day);

-- ============ SYNC ENGINE ============
CREATE TABLE IF NOT EXISTS sync_jobs (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job_type        TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','running','completed','failed','cancelled')),
  priority        INTEGER NOT NULL DEFAULT 5,
  total_tasks     INTEGER NOT NULL DEFAULT 0,
  completed_tasks INTEGER NOT NULL DEFAULT 0,
  failed_tasks    INTEGER NOT NULL DEFAULT 0,
  payload         JSONB NOT NULL DEFAULT '{}'::jsonb,
  started_at      TIMESTAMPTZ,
  finished_at     TIMESTAMPTZ,
  last_error      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sync_jobs_status_idx ON sync_jobs (status, priority DESC);

CREATE TABLE IF NOT EXISTS sync_tasks (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job_id         BIGINT REFERENCES sync_jobs(id),
  task_type      TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','running','completed','failed','skipped')),
  priority       INTEGER NOT NULL DEFAULT 5,
  attempts       INTEGER NOT NULL DEFAULT 0,
  max_attempts   INTEGER NOT NULL DEFAULT 5,
  scheduled_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  payload        JSONB NOT NULL DEFAULT '{}'::jsonb,
  unique_key     TEXT,
  last_error     TEXT,
  started_at     TIMESTAMPTZ,
  completed_at   TIMESTAMPTZ,
  dedupe_hash    TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- idempotency: an unfinished task with the same unique key never duplicates
CREATE UNIQUE INDEX IF NOT EXISTS sync_tasks_unique_key_active
  ON sync_tasks (unique_key) WHERE status IN ('pending','running');
CREATE INDEX IF NOT EXISTS sync_tasks_claim_idx
  ON sync_tasks (priority DESC, scheduled_at ASC) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS sync_tasks_status_idx ON sync_tasks (status, scheduled_at);
CREATE INDEX IF NOT EXISTS sync_tasks_job_idx ON sync_tasks (job_id, status);

CREATE TABLE IF NOT EXISTS sync_state (
  key         TEXT PRIMARY KEY,
  value       JSONB NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- ============ RAW PROVIDER PAYLOADS (reprocessing without provider calls) ============
CREATE TABLE IF NOT EXISTS raw_provider_payloads (
  id                    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider              TEXT NOT NULL DEFAULT 'api-football',
  endpoint              TEXT NOT NULL,
  params                JSONB NOT NULL DEFAULT '{}'::jsonb,
  params_hash           TEXT NOT NULL,
  entity_type           TEXT,
  provider_entity_id    BIGINT,
  fixture_id            BIGINT REFERENCES fixtures(id),
  competition_season_id BIGINT REFERENCES competition_seasons(id),
  response              JSONB NOT NULL,
  http_status           INTEGER,
  response_hash         TEXT,
  fetched_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS raw_payloads_provider_params
  ON raw_provider_payloads (provider, params_hash);
CREATE INDEX IF NOT EXISTS raw_payloads_entity_idx ON raw_provider_payloads (provider, entity_type, provider_entity_id, fetched_at DESC);
CREATE INDEX IF NOT EXISTS raw_payloads_fetched_idx ON raw_provider_payloads (fetched_at DESC);

-- ============ PROVIDER REQUEST LOG ============
CREATE TABLE IF NOT EXISTS provider_requests (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider          TEXT NOT NULL DEFAULT 'api-football',
  endpoint          TEXT NOT NULL,
  method            TEXT NOT NULL DEFAULT 'GET',
  params            JSONB NOT NULL DEFAULT '{}'::jsonb,
  params_hash       TEXT NOT NULL,
  started_at        TIMESTAMPTZ NOT NULL,
  completed_at      TIMESTAMPTZ,
  duration_ms       INTEGER,
  http_status       INTEGER,
  success           BOOLEAN,
  cache_hit         BOOLEAN NOT NULL DEFAULT FALSE,
  daily_quota_remaining  BIGINT,
  minute_quota_remaining BIGINT,
  sync_task_id      BIGINT REFERENCES sync_tasks(id),
  error             TEXT
);
CREATE INDEX IF NOT EXISTS provider_requests_day_idx ON provider_requests (started_at DESC);
CREATE INDEX IF NOT EXISTS provider_requests_endpoint_idx ON provider_requests (endpoint, started_at DESC);

