import crypto from 'node:crypto';
import { query } from '../db/pool.js';
import { config } from '../config.js';
import { sha256 } from '../util/hash.js';

export const KEY_PREFIX = 'pf_live_';
export const ALL_SCOPES = [
  'fixtures:read', 'teams:read', 'players:read', 'referees:read', 'standings:read',
  'statistics:read', 'predictions:read', 'admin:read', 'admin:write',
] as const;
export type Scope = (typeof ALL_SCOPES)[number] | '*';

function pepper(): string {
  const p = config.secrets.apiPepper;
  if (!p) {
    throw new Error('API_KEY_PEPPER/ADMIN_TOKEN missing: refusing to generate or verify API keys with an ephemeral secret');
  }
  return p;
}

/** HMAC-SHA256 hash of the full key with the server pepper. */
export function hashKey(fullKey: string): string {
  return crypto.createHmac('sha256', pepper()).update(fullKey).digest('hex');
}

/** Cryptographically secure random key: pf_live_<43 base64url chars>. */
export function generateSecret(): { fullKey: string; prefix: string } {
  const secret = crypto.randomBytes(32).toString('base64url'); // 43 chars, ~192 bits entropy
  const fullKey = `${KEY_PREFIX}${secret}`;
  const prefix = fullKey.slice(0, 12); // identification only, never secret
  return { fullKey, prefix };
}

export interface CreatedKey {
  keyId: number;
  fullKey: string; // displayed ONCE
  prefix: string;
  scopes: string[];
  expiresAt: Date | null;
}

export async function createApiKey(opts: {
  clientId: number;
  scopes: string[];
  expiresInDays?: number;
  rotationOfKeyId?: number;
}): Promise<CreatedKey> {
  const { fullKey, prefix } = generateSecret();
  const expiresAt = opts.expiresInDays ? new Date(Date.now() + opts.expiresInDays * 86_400_000) : null;
  const { rows } = await query<{ id: number }>(
    `INSERT INTO api_keys (client_id, key_prefix, key_hash, scopes, expires_at, rotation_of_key_id)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [opts.clientId, prefix, hashKey(fullKey), opts.scopes, expiresAt, opts.rotationOfKeyId ?? null],
  );
  return { keyId: rows[0].id, fullKey, prefix, scopes: opts.scopes, expiresAt };
}

export interface KeyVerification {
  ok: boolean;
  status: 'valid' | 'invalid' | 'revoked' | 'expired' | 'client_disabled' | 'not_found';
  keyId?: number;
  clientId?: number;
  scopes?: string[];
  rateLimitPerMinute?: number;
  rateLimitPerDay?: number;
  clientName?: string;
  reason?: string;
}

/**
 * Verify a presented key: prefix lookup -> constant-time hash compare ->
 * revoked/expired/client-status checks. Never logs the key.
 */
export async function verifyApiKey(presented: string | undefined | null): Promise<KeyVerification> {
  if (!presented || !presented.startsWith(KEY_PREFIX) || presented.length < 20) {
    return { ok: false, status: 'invalid', reason: 'malformed key' };
  }
  const prefix = presented.slice(0, 12);
  const { rows } = await query<{
    id: number; client_id: number; key_hash: string; scopes: string[]; revoked_at: Date | null; expires_at: Date | null;
    client_active: boolean; rate_limit_per_minute: number; rate_limit_per_day: number; client_name: string;
  }>(
    `SELECT k.id, k.client_id, k.key_hash, k.scopes, k.revoked_at, k.expires_at,
            c.active AS client_active, c.rate_limit_per_minute, c.rate_limit_per_day, c.name AS client_name
     FROM api_keys k JOIN api_clients c ON c.id = k.client_id
     WHERE k.key_prefix = $1 LIMIT 1`,
    [prefix],
  );
  const row = rows[0];
  if (!row) return { ok: false, status: 'not_found', reason: 'unknown key prefix' };

  const presentedHash = hashKey(presented);
  const expected = Buffer.from(row.key_hash, 'hex');
  const actual = Buffer.from(presentedHash, 'hex');
  const hashOk = expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  if (!hashOk) return { ok: false, status: 'invalid', reason: 'hash mismatch' };

  if (row.revoked_at && row.revoked_at.getTime() <= Date.now()) {
    return { ok: false, status: 'revoked', keyId: row.id, clientId: row.client_id, reason: 'key revoked' };
  }
  if (row.expires_at && row.expires_at.getTime() <= Date.now()) {
    return { ok: false, status: 'expired', keyId: row.id, clientId: row.client_id, reason: 'key expired' };
  }
  if (!row.client_active) {
    return { ok: false, status: 'client_disabled', keyId: row.id, clientId: row.client_id, reason: 'client disabled' };
  }
  return {
    ok: true,
    status: 'valid',
    keyId: row.id,
    clientId: row.client_id,
    scopes: row.scopes,
    rateLimitPerMinute: row.rate_limit_per_minute,
    rateLimitPerDay: row.rate_limit_per_day,
    clientName: row.client_name,
  };
}

/** Rotate: new key immediately, old key valid for a grace window then auto-revoked. */
export async function rotateApiKey(keyId: number, graceHours = 24): Promise<CreatedKey> {
  const { rows } = await query<{ client_id: number; scopes: string[]; expires_at: Date | null }>(
    `SELECT client_id, scopes, expires_at FROM api_keys WHERE id = $1`,
    [keyId],
  );
  const old = rows[0];
  if (!old) throw new Error(`key ${keyId} not found`);
  const created = await createApiKey({ clientId: old.client_id, scopes: old.scopes, rotationOfKeyId: keyId });
  // keep old key valid until grace end (revoked_at in the future is still accepted)
  await query(`UPDATE api_keys SET revoked_at = now() + ($2 || ' hours')::interval, grace_expires_at = now() + ($2 || ' hours')::interval, updated_at = now() WHERE id = $1`, [keyId, String(graceHours)]);
  await query(
    `INSERT INTO sync_state (key, value, updated_at) VALUES ($1, $2::jsonb, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [`rotation:${keyId}`, { replacedBy: created.keyId, at: new Date().toISOString() }],
  );
  return created;
}

export async function revokeApiKey(keyId: number, reason?: string): Promise<void> {
  await query(`UPDATE api_keys SET revoked_at = now(), revoked_reason = $2, updated_at = now() WHERE id = $1 AND (revoked_at IS NULL OR revoked_at > now())`, [keyId, reason ?? 'manual revocation']);
}

/** Purge grace-expired rotated keys (scheduled). */
export async function purgeExpiredGraceKeys(): Promise<number> {
  const { rowCount } = await query(
    `UPDATE api_keys SET revoked_at = now() WHERE grace_expires_at IS NOT NULL AND grace_expires_at <= now() AND (revoked_at IS NULL OR revoked_at > now())`,
  );
  return rowCount ?? 0;
}

export function fingerprint(fullKey: string): string {
  return sha256(fullKey).slice(0, 8);
}
