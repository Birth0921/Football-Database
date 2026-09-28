/**
 * Managed Website API key: exactly one automatically managed key with
 * read-only public scopes, used by the Website server-side proxy.
 *
 * Design:
 * - The key record lives in the normal api_keys system (sha256 hash only).
 * - The raw key is additionally stored ENCRYPTED (AES-256-GCM, key derived
 *   from JWT_SECRET) in managed_key_secrets so the Website can re-resolve it
 *   across restarts without regenerating (no new key per restart).
 * - api_keys.managed_role = 'website' + a partial UNIQUE index guarantee at
 *   most one managed Website key row; creation/rotation run inside a
 *   transaction guarded by a Postgres advisory lock, so concurrent workers
 *   can never create duplicates.
 * - Provisioning happens on Website startup and lazily when the proxy hits an
 *   auth failure (recovery after admin deletion). There is NO periodic
 *   rotation — only manual rotation on demand from the Admin UI.
 */
import crypto from 'node:crypto';
import { query, queryOne, withTransaction } from '../lib/db.js';
import type { PoolClient } from 'pg';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';
import {
  ALL_SCOPES, authenticateApiKey, createClient, generateRawKey,
  type KeyRecord,
} from './service.js';
import { ForbiddenError, NotFoundError } from '../types.js';

/** Read-only public scopes — the Website key can have NOTHING else. */
export const WEBSITE_SCOPES = [
  'fixtures:read',
  'teams:read',
  'players:read',
  'referees:read',
  'standings:read',
  'statistics:read',
  'predictions:read',
] as const;

export const WEBSITE_CLIENT_NAME = 'Website';
const WEBSITE_LOCK_ID = 772_345_917;

// ---------------------------------------------------------------------------
// Encryption at rest (AES-256-GCM, key derived from JWT_SECRET)
// ---------------------------------------------------------------------------
function derivedKey(): Buffer {
  if (!config.jwtSecret) throw new Error('JWT_SECRET required for managed key encryption');
  return crypto.scryptSync(config.jwtSecret, 'fdbl:managed-key:v1', 32);
}

function encryptSecret(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', derivedKey(), iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`;
}

function decryptSecret(enc: string): string {
  const [version, ivB64, tagB64, ctB64] = enc.split(':');
  if (version !== 'v1' || !ivB64 || !tagB64 || !ctB64) throw new Error('malformed managed secret');
  const decipher = crypto.createDecipheriv('aes-256-gcm', derivedKey(), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString('utf8');
}

// ---------------------------------------------------------------------------
// Key lookup helpers
// ---------------------------------------------------------------------------
const keyRecordSql = `
  SELECT k.*, c.name AS client_name, c.active AS client_active,
         c.rate_limit_per_minute, c.rate_limit_per_day
    FROM api_keys k JOIN api_clients c ON c.id = k.client_id
   WHERE k.managed_role = 'website'
   ORDER BY k.id DESC LIMIT 1`;

/** The managed Website key row, whatever its state (may be revoked/expired). */
export async function getManagedWebsiteKeyRecord(): Promise<KeyRecord | null> {
  return queryOne<KeyRecord>(keyRecordSql);
}

function isValidWebsiteRecord(k: KeyRecord | null): k is KeyRecord {
  if (!k) return false;
  if (k.revoked_at) return false;
  if (k.expires_at && new Date(k.expires_at) < new Date()) return false;
  if (k.grace_until && new Date(k.grace_until) < new Date()) return false;
  if (k.client_active === false) return false;
  if (!(k.scopes ?? []).length) return false;
  return true;
}

export interface ResolvedWebsiteKey {
  record: KeyRecord;
  rawKey: string;
}

/**
 * Resolve the managed Website key WITHOUT creating anything:
 * valid managed key + decryptable secret + successful authentication.
 * Returns null when the system must (re)provision.
 */
export async function resolveWebsiteKey(): Promise<ResolvedWebsiteKey | null> {
  const record = await getManagedWebsiteKeyRecord();
  if (!isValidWebsiteRecord(record)) return null;
  if (record.scopes.some((sc) => !(WEBSITE_SCOPES as readonly string[]).includes(sc))) return null;
  const secret = await queryOne<{ enc_text: string }>(
    `SELECT enc_text FROM managed_key_secrets WHERE api_key_id = $1`, [record.id],
  );
  if (!secret) return null;
  let rawKey: string;
  try {
    rawKey = decryptSecret(secret.enc_text);
  } catch {
    return null; // e.g. JWT_SECRET rotated — provision a replacement
  }
  const auth = await authenticateApiKey(rawKey, 'fixtures:read');
  if (!auth.ok || !auth.key || auth.key.id !== record.id) return null;
  return { record, rawKey };
}

// ---------------------------------------------------------------------------
// Provisioning (advisory-locked, exactly-once)
// ---------------------------------------------------------------------------
async function insertWebsiteKey(client: PoolClient, clientId: number, label: string): Promise<{ id: number; rawKey: string; keyPrefix: string }> {
  const gen = generateRawKey();
  const res = await client.query(
    `INSERT INTO api_keys (client_id, key_prefix, key_hash, scopes, label, managed_role)
     VALUES ($1, $2, $3, $4, $5, 'website') RETURNING id`,
    [clientId, gen.keyPrefix, gen.keyHash, [...WEBSITE_SCOPES], label],
  );
  const id = Number(res.rows[0].id);
  await client.query(
    `INSERT INTO managed_key_secrets (api_key_id, enc_text) VALUES ($1, $2)`,
    [id, encryptSecret(gen.rawKey)],
  );
  return { id, rawKey: gen.rawKey, keyPrefix: gen.keyPrefix };
}

/**
 * Ensure exactly one valid managed Website key exists; create it if missing.
 * Safe under concurrency (advisory lock) and idempotent. Also cleans up an
 * invalid/stale managed row (revoked/expired/corrupt secret) by physically
 * deleting it before inserting the replacement — the partial unique index
 * allows only one 'website' row.
 */
export async function ensureWebsiteKey(actor = 'website-boot'): Promise<ResolvedWebsiteKey> {
  const existing = await resolveWebsiteKey();
  if (existing) return existing;

  return withTransaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock($1)', [WEBSITE_LOCK_ID]);

    // re-check inside the lock (another worker may have just created one)
    const currentRes = await client.query(
      `SELECT k.*, c.name AS client_name, c.active AS client_active
         FROM api_keys k JOIN api_clients c ON c.id = k.client_id
        WHERE k.managed_role = 'website' ORDER BY k.id DESC LIMIT 1`,
    );
    const current = (currentRes.rows[0] ?? null) as (KeyRecord | null);
    if (isValidWebsiteRecord(current) && current.scopes.every((sc) => (WEBSITE_SCOPES as readonly string[]).includes(sc))) {
      const secretRes = await client.query(
        `SELECT enc_text FROM managed_key_secrets WHERE api_key_id = $1`, [current.id],
      );
      const secret = secretRes.rows[0] as { enc_text: string } | undefined;
      if (secret) {
        try {
          const rawKey = decryptSecret(secret.enc_text);
          const auth = await authenticateApiKey(rawKey, 'fixtures:read');
          if (auth.ok && auth.key?.id === current.id) return { record: current, rawKey };
        } catch { /* fall through to re-provision */ }
      }
    }

    // stale/invalid managed row → remove it (its secret cascades)
    if (current) {
      await client.query(`DELETE FROM api_keys WHERE id = $1`, [current.id]);
      logger.info({ oldKeyId: current.id }, 'stale managed website key replaced');
    }

    const clientId = (await createClient({
      name: WEBSITE_CLIENT_NAME,
      description: 'Built-in website client (auto-provisioned, read-only)',
      clientType: 'website',
      rateLimitPerMinute: 240,
      rateLimitPerDay: 100000,
    }, actor)).id;

    const created = await insertWebsiteKey(client, clientId, 'Website (managed)');

    await client.query(
      `INSERT INTO api_audit_log (actor, action, client_id, api_key_id, details)
       VALUES ($1, 'key.website.provision', $2, $3, $4)`,
      [actor, clientId, created.id, JSON.stringify({ keyPrefix: created.keyPrefix, scopes: [...WEBSITE_SCOPES] })],
    );
    logger.info({ keyId: created.id, keyPrefix: created.keyPrefix }, 'managed website key provisioned');
    const recordRes = await client.query(
      `SELECT k.*, c.name AS client_name, c.active AS client_active,
              c.rate_limit_per_minute, c.rate_limit_per_day
         FROM api_keys k JOIN api_clients c ON c.id = k.client_id WHERE k.id = $1`,
      [created.id],
    );
    const record = recordRes.rows[0] as KeyRecord;
    return { record, rawKey: created.rawKey };
  });
}

// ---------------------------------------------------------------------------
// Manual rotation (Admin UI, on demand only)
// ---------------------------------------------------------------------------
export interface RotationResult {
  id: number;
  keyPrefix: string;
}

/**
 * Safely rotate the managed Website key:
 *  1. create the replacement (same read-only scopes)
 *  2. VERIFY it authenticates (injectable for tests)
 *  3. atomically switch managed_role to the replacement
 *  4. physically delete the old key
 * On ANY failure the transaction rolls back — the old working key survives.
 * The new raw key is never returned: it stays server-side (encrypted secret).
 */
export async function rotateWebsiteKey(
  actor = 'admin-ui',
  verify: (rawKey: string) => Promise<boolean> = async (rawKey) => {
    const auth = await authenticateApiKey(rawKey, 'fixtures:read');
    return auth.ok && auth.scopeOk !== false;
  },
): Promise<RotationResult> {
  const old = await getManagedWebsiteKeyRecord();
  if (!old) throw new NotFoundError('managed website key not found');
  if (old.revoked_at) throw new ForbiddenError('cannot rotate a revoked website key');

  // ---- phase 1: create the replacement (unmanaged — nothing is switched yet)
  const created = await withTransaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock($1)', [WEBSITE_LOCK_ID]);
    const gen = generateRawKey();
    const res = await client.query(
      `INSERT INTO api_keys (client_id, key_prefix, key_hash, scopes, label, rotated_from, managed_role)
       VALUES ($1, $2, $3, $4, $5, $6, NULL) RETURNING id`,
      [old.client_id, gen.keyPrefix, gen.keyHash, [...WEBSITE_SCOPES], 'Website (managed)', old.id],
    );
    const id = Number(res.rows[0].id);
    await client.query(
      `INSERT INTO managed_key_secrets (api_key_id, enc_text) VALUES ($1, $2)
       ON CONFLICT (api_key_id) DO UPDATE SET enc_text = EXCLUDED.enc_text, updated_at = now()`,
      [id, encryptSecret(gen.rawKey)],
    );
    return { id, rawKey: gen.rawKey, keyPrefix: gen.keyPrefix };
  });

  // ---- phase 2: VERIFY the replacement through the real auth pipeline.
  // Runs AFTER the create commits so the row is visible; if this fails the
  // old working key was never touched.
  let verified = false;
  try {
    verified = await verify(created.rawKey);
  } catch {
    verified = false;
  }
  if (!verified) {
    await query(`DELETE FROM api_keys WHERE id = $1 AND managed_role IS NULL`, [created.id]); // orphan cleanup
    throw new Error('website key rotation aborted: replacement key failed verification');
  }

  // ---- phase 3: atomically switch managed_role to the replacement and
  // physically delete every superseded managed key.
  await withTransaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock($1)', [WEBSITE_LOCK_ID]);
    const cleared = await client.query(
      `UPDATE api_keys SET managed_role = NULL, updated_at = now()
        WHERE managed_role = 'website' AND id <> $1 RETURNING id`,
      [created.id],
    );
    if (cleared.rows.length > 0) {
      await client.query(
        `DELETE FROM api_keys WHERE id = ANY($1::bigint[])`,
        [cleared.rows.map((r: { id: number }) => r.id)],
      );
    }
    await client.query(`UPDATE api_keys SET managed_role = 'website', updated_at = now() WHERE id = $1`, [created.id]);
    await client.query(
      `INSERT INTO api_audit_log (actor, action, client_id, api_key_id, details)
       VALUES ($1, 'key.website.rotate', $2, $3, $4)`,
      [actor, old.client_id, created.id, JSON.stringify({ oldKeyId: old.id, oldKeyPrefix: old.key_prefix, newKeyPrefix: created.keyPrefix })],
    );
  });
  logger.info({ oldKeyId: old.id, newKeyId: created.id }, 'managed website key rotated');
  return { id: created.id, keyPrefix: created.keyPrefix };
}

/** Scope sanity for exports/tests. */
export function websiteScopesAreReadOnly(scopes: string[]): boolean {
  return scopes.length > 0 && scopes.every((sc) => (ALL_SCOPES as readonly string[]).includes(sc) && sc.endsWith(':read') && !sc.startsWith('admin:'));
}
