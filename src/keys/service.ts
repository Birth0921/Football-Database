/**
 * Our own API-key system: secure generation, hashing (never store raw keys),
 * one-time display, scopes, rotation with grace period, revocation.
 */
import crypto from 'node:crypto';
import { query, queryOne } from '../lib/db.js';
import { ForbiddenError, NotFoundError } from '../types.js';

export const ALL_SCOPES = [
  'fixtures:read',
  'teams:read',
  'players:read',
  'referees:read',
  'standings:read',
  'statistics:read',
  'predictions:read',
  'admin:read',
  'admin:write',
] as const;
export type Scope = (typeof ALL_SCOPES)[number];

export const KEY_PREFIX = 'pf_live_';

export function hashKey(rawKey: string): string {
  return crypto.createHash('sha256').update(rawKey).digest('hex');
}

export interface GeneratedKey {
  rawKey: string; // shown ONE TIME only
  keyPrefix: string;
  keyHash: string;
}

export function generateRawKey(): GeneratedKey {
  const secret = crypto.randomBytes(32).toString('base64url');
  const handle = crypto.randomBytes(6).toString('hex');
  const rawKey = `${KEY_PREFIX}${handle}_${secret}`;
  return { rawKey, keyPrefix: `${KEY_PREFIX}${handle}`, keyHash: hashKey(rawKey) };
}

export interface ApiClientInput {
  name: string;
  description?: string;
  clientType?: string;
  rateLimitPerMinute?: number;
  rateLimitPerDay?: number;
}

export async function createClient(input: ApiClientInput, actor = 'cli'): Promise<{ id: number; name: string }> {
  const row = await queryOne<{ id: number; name: string }>(
    `INSERT INTO api_clients (name, description, client_type, rate_limit_per_minute, rate_limit_per_day)
     VALUES ($1, $2, COALESCE($3, 'application'), COALESCE($4, 60), COALESCE($5, 10000))
     ON CONFLICT (name) DO UPDATE SET
       description = COALESCE(EXCLUDED.description, api_clients.description),
       client_type = COALESCE(EXCLUDED.client_type, api_clients.client_type),
       rate_limit_per_minute = COALESCE($4, api_clients.rate_limit_per_minute),
       rate_limit_per_day = COALESCE($5, api_clients.rate_limit_per_day),
       updated_at = now()
     RETURNING id, name`,
    [input.name, input.description ?? null, input.clientType ?? null, input.rateLimitPerMinute ?? null, input.rateLimitPerDay ?? null],
  );
  await audit(actor, 'client.create', { clientId: row!.id, name: input.name });
  return row!;
}

export interface CreateKeyInput {
  clientName?: string;
  clientId?: number;
  scopes: string[];
  label?: string;
  expiresInDays?: number | null;
  rotatedFrom?: number | null;
}

export async function createKey(input: CreateKeyInput, actor = 'cli'): Promise<{ id: number; rawKey: string; keyPrefix: string; clientId: number }> {
  let clientId = input.clientId ?? null;
  if (!clientId && input.clientName) {
    clientId = (await createClient({ name: input.clientName }, actor)).id;
  }
  if (!clientId) throw new NotFoundError('client not found — pass --client or --client-id');

  for (const sc of input.scopes) {
    if (!(ALL_SCOPES as readonly string[]).includes(sc)) {
      throw new ForbiddenError(`unknown scope '${sc}'. Valid: ${ALL_SCOPES.join(', ')}`);
    }
  }

  const gen = generateRawKey();
  const expiresAt = input.expiresInDays ? new Date(Date.now() + input.expiresInDays * 864e5).toISOString() : null;
  const row = await queryOne<{ id: number }>(
    `INSERT INTO api_keys (client_id, key_prefix, key_hash, scopes, label, expires_at, rotated_from)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [clientId, gen.keyPrefix, gen.keyHash, input.scopes, input.label ?? null, expiresAt, input.rotatedFrom ?? null],
  );
  await audit(actor, 'key.create', { clientId, apiKeyId: row!.id, keyPrefix: gen.keyPrefix, scopes: input.scopes });
  return { id: row!.id, rawKey: gen.rawKey, keyPrefix: gen.keyPrefix, clientId };
}

export async function rotateKey(
  keyIdOrPrefix: string | number,
  opts: { graceHours?: number } = {},
  actor = 'cli',
): Promise<{ id: number; rawKey: string; keyPrefix: string; clientId: number; oldKeyValidUntil: string | null }> {
  const old = await findKeyRecord(keyIdOrPrefix);
  if (!old) throw new NotFoundError(`api key '${keyIdOrPrefix}' not found`);
  if (old.revoked_at) throw new ForbiddenError('cannot rotate a revoked key');

  const graceHours = opts.graceHours ?? 24;
  const graceUntil = new Date(Date.now() + graceHours * 36e5).toISOString();
  await query(`UPDATE api_keys SET grace_until = $2, updated_at = now() WHERE id = $1`, [old.id, graceUntil]);

  const created = await createKey(
    {
      clientId: old.client_id,
      scopes: old.scopes,
      label: old.label ? `${old.label} (rotated)` : 'rotated',
      rotatedFrom: old.id,
    },
    actor,
  );

  if (graceHours <= 0) {
    await query(`UPDATE api_keys SET revoked_at = now(), revoked_reason = 'rotated (no grace)', grace_until = NULL, updated_at = now() WHERE id = $1`, [old.id]);
  }
  await audit(actor, 'key.rotate', { apiKeyId: old.id, newApiKeyId: created.id, graceUntil: graceHours > 0 ? graceUntil : null });
  return { id: created.id, rawKey: created.rawKey, keyPrefix: created.keyPrefix, clientId: created.clientId, oldKeyValidUntil: graceHours > 0 ? graceUntil : null };
}

export async function revokeKey(keyIdOrPrefix: string | number, reason = 'revoked by admin', actor = 'cli'): Promise<void> {
  const old = await findKeyRecord(keyIdOrPrefix);
  if (!old) throw new NotFoundError(`api key '${keyIdOrPrefix}' not found`);
  await query(`UPDATE api_keys SET revoked_at = now(), revoked_reason = $2, updated_at = now() WHERE id = $1`, [old.id, reason]);
  await audit(actor, 'key.revoke', { apiKeyId: old.id, reason });
}

export interface KeyRecord {
  id: number;
  client_id: number;
  key_prefix: string;
  key_hash: string;
  scopes: string[];
  label: string | null;
  created_at: Date;
  last_used_at: Date | null;
  expires_at: Date | null;
  revoked_at: Date | null;
  grace_until: Date | null;
  rotated_from: number | null;
  client_name?: string;
  client_active?: boolean;
  rate_limit_per_minute?: number;
  rate_limit_per_day?: number;
}

async function findKeyRecord(keyIdOrPrefix: string | number): Promise<KeyRecord | null> {
  if (typeof keyIdOrPrefix === 'number' || /^\d+$/.test(String(keyIdOrPrefix))) {
    return queryOne<KeyRecord>(`SELECT k.*, c.name AS client_name, c.active AS client_active FROM api_keys k JOIN api_clients c ON c.id = k.client_id WHERE k.id = $1`, [Number(keyIdOrPrefix)]);
  }
  return queryOne<KeyRecord>(`SELECT k.*, c.name AS client_name, c.active AS client_active FROM api_keys k JOIN api_clients c ON c.id = k.client_id WHERE k.key_prefix = $1`, [String(keyIdOrPrefix)]);
}

export interface AuthResult {
  ok: boolean;
  reason?: string;
  key?: KeyRecord;
  scopeOk?: boolean;
}

/** Full authentication pipeline per spec §10. */
export async function authenticateApiKey(rawKey: string, requiredScope?: string): Promise<AuthResult> {
  if (!rawKey || !rawKey.startsWith(KEY_PREFIX)) return { ok: false, reason: 'invalid key format' };
  const underscore = rawKey.indexOf('_', KEY_PREFIX.length);
  const keyPrefix = underscore > 0 ? rawKey.slice(0, underscore) : rawKey.slice(0, KEY_PREFIX.length + 12);
  const record = await queryOne<KeyRecord>(
    `SELECT k.*, c.name AS client_name, c.active AS client_active, c.rate_limit_per_minute, c.rate_limit_per_day
       FROM api_keys k JOIN api_clients c ON c.id = k.client_id
      WHERE k.key_prefix = $1`,
    [keyPrefix],
  );
  if (!record) return { ok: false, reason: 'unknown key' };
  // constant-time-ish hash comparison
  const expected = record.key_hash;
  const actual = hashKey(rawKey);
  const matches = expected.length === actual.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(actual));
  const now = new Date();
  if (!matches) return { ok: false, reason: 'key hash mismatch' };
  // Revocation is always immediate (even inside a rotation grace window).
  if (record.revoked_at) return { ok: false, reason: 'key revoked', key: record };
  // grace_until = rotation grace: key dies automatically once the window closes.
  if (record.grace_until && new Date(record.grace_until) < now) {
    return { ok: false, reason: 'rotation grace period ended', key: record };
  }
  if (record.expires_at && new Date(record.expires_at) < now) return { ok: false, reason: 'key expired', key: record };
  if (record.client_active === false) return { ok: false, reason: 'client disabled', key: record };
  let scopeOk = true;
  if (requiredScope && !(record.scopes ?? []).includes(requiredScope)) {
    // admin:write implies admin:read
    const implied = requiredScope === 'admin:read' && (record.scopes ?? []).includes('admin:write');
    if (!implied) scopeOk = false;
  }
  return { ok: true, key: record, scopeOk };
}

export async function touchKeyUsage(keyId: number): Promise<void> {
  await query(`UPDATE api_keys SET last_used_at = now() WHERE id = $1`, [keyId]);
}

export interface UsageHit {
  apiKeyId: number | null;
  clientId: number | null;
  endpoint: string;
  success: boolean;
  rateLimited: boolean;
}

export async function recordUsage(hit: UsageHit): Promise<void> {
  await query(
    `INSERT INTO api_usage (api_key_id, client_id, date, endpoint, requests, successful_requests, failed_requests, rate_limited_requests, last_used_at)
     VALUES ($1, $2, (now() AT TIME ZONE 'utc')::date, $3, 1, $4, $5, $6, now())
     ON CONFLICT (api_key_id, client_id, date, endpoint) DO UPDATE SET
       requests = api_usage.requests + 1,
       successful_requests = api_usage.successful_requests + $4,
       failed_requests = api_usage.failed_requests + $5,
       rate_limited_requests = api_usage.rate_limited_requests + $6,
       last_used_at = now()`,
    [hit.apiKeyId, hit.clientId, hit.endpoint, hit.success ? 1 : 0, hit.success ? 0 : 1, hit.rateLimited ? 1 : 0],
  );
}

/** In-process + DB rate limiting per key (per-minute and per-day). */
const minuteBuckets = new Map<string, { count: number; windowStart: number }>();

export async function checkRateLimit(key: KeyRecord): Promise<{ allowed: boolean; perMinute: number; perDay: number; retryAfterSeconds: number }> {
  const nowMs = Date.now();
  const bucketKey = `${key.id}`;
  const bucket = minuteBuckets.get(bucketKey);
  const perMinuteLimit = key.rate_limit_per_minute ?? 60;
  const perDayLimit = key.rate_limit_per_day ?? 10000;

  if (!bucket || nowMs - bucket.windowStart >= 60_000) {
    minuteBuckets.set(bucketKey, { count: 1, windowStart: nowMs });
  } else {
    bucket.count += 1;
  }
  const current = minuteBuckets.get(bucketKey)!;

  const dayRow = await queryOne<{ requests: number }>(
    `SELECT coalesce(sum(requests), 0)::int AS requests FROM api_usage
      WHERE (api_key_id = $1 OR ($1::bigint IS NULL AND client_id = $2))
        AND date = (now() AT TIME ZONE 'utc')::date`,
    [key.id, key.client_id],
  );
  const perDay = dayRow?.requests ?? 0;

  if (current.count > perMinuteLimit) {
    return { allowed: false, perMinute: current.count, perDay, retryAfterSeconds: Math.ceil((60_000 - (nowMs - current.windowStart)) / 1000) };
  }
  if (perDay >= perDayLimit) {
    return { allowed: false, perMinute: current.count, perDay, retryAfterSeconds: 3600 };
  }
  return { allowed: true, perMinute: current.count, perDay, retryAfterSeconds: 0 };
}

export async function listKeys(): Promise<KeyRecord[]> {
  return query<KeyRecord>(
    `SELECT k.*, c.name AS client_name, c.active AS client_active, c.rate_limit_per_minute, c.rate_limit_per_day
       FROM api_keys k JOIN api_clients c ON c.id = k.client_id
      ORDER BY k.created_at DESC`,
  );
}

export async function listClients(): Promise<unknown[]> {
  return query(
    `SELECT c.*, count(k.id) FILTER (WHERE k.revoked_at IS NULL) AS active_keys
       FROM api_clients c LEFT JOIN api_keys k ON k.client_id = c.id
      GROUP BY c.id ORDER BY c.created_at ASC`,
  );
}

export async function usageReport(): Promise<unknown[]> {
  return query(
    `SELECT u.date, u.endpoint, c.name AS client_name, k.key_prefix,
            sum(u.requests) AS requests, sum(u.successful_requests) AS successful_requests,
            sum(u.failed_requests) AS failed_requests, sum(u.rate_limited_requests) AS rate_limited_requests,
            max(u.last_used_at) AS last_used_at
       FROM api_usage u
       LEFT JOIN api_clients c ON c.id = u.client_id
       LEFT JOIN api_keys k ON k.id = u.api_key_id
      GROUP BY u.date, u.endpoint, c.name, k.key_prefix
      ORDER BY u.date DESC, requests DESC
      LIMIT 200`,
  );
}

export async function updateClientLimits(clientId: number, ratePerMinute?: number, ratePerDay?: number, active?: boolean): Promise<void> {
  await query(
    `UPDATE api_clients SET
       rate_limit_per_minute = COALESCE($2, rate_limit_per_minute),
       rate_limit_per_day = COALESCE($3, rate_limit_per_day),
       active = COALESCE($4, active),
       updated_at = now()
     WHERE id = $1`,
    [clientId, ratePerMinute ?? null, ratePerDay ?? null, active ?? null],
  );
}

async function audit(actor: string, action: string, details: Record<string, unknown>): Promise<void> {
  await query(
    `INSERT INTO api_audit_log (actor, action, client_id, api_key_id, details) VALUES ($1, $2, $3, $4, $5)`,
    [actor, action, (details.clientId as number) ?? null, (details.apiKeyId as number) ?? null, JSON.stringify(details)],
  );
}
