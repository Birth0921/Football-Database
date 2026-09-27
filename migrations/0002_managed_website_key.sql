-- 0002: managed Website API key support + safe permanent key deletion.
--
-- - api_keys.managed_role marks automatically managed keys ('website').
--   A partial unique index guarantees AT MOST ONE website-managed key row.
-- - managed_key_secrets stores the website key's raw value encrypted at rest
--   (AES-256-GCM, key derived from JWT_SECRET) so the Website server can use
--   and re-resolve the key across restarts WITHOUT regenerating it. The
--   api_keys table itself still stores only the sha256 hash — the raw key is
--   never stored in the clear anywhere.
-- - api_keys.rotated_from self-FK becomes ON DELETE SET NULL so any key can be
--   physically deleted without FK violations (permanent deletion support).

ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS managed_role TEXT;

DROP INDEX IF EXISTS uq_api_keys_managed_role_website;
CREATE UNIQUE INDEX uq_api_keys_managed_role_website
  ON api_keys (managed_role)
  WHERE managed_role = 'website';

ALTER TABLE api_keys DROP CONSTRAINT IF EXISTS api_keys_rotated_from_fkey;
ALTER TABLE api_keys ADD CONSTRAINT api_keys_rotated_from_fkey
  FOREIGN KEY (rotated_from) REFERENCES api_keys(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS managed_key_secrets (
  api_key_id  BIGINT PRIMARY KEY REFERENCES api_keys(id) ON DELETE CASCADE,
  enc_text    TEXT NOT NULL,              -- v1:<iv>:<tag>:<ciphertext> (AES-256-GCM)
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
