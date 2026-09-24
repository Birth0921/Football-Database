/**
 * API-key system tests: generation, hashing (never raw), auth pipeline,
 * revocation, rotation with grace, expiration, scopes.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import {
  createClient, createKey, generateRawKey, hashKey, authenticateApiKey, revokeKey, rotateKey,
  KEY_PREFIX,
} from '../src/keys/service.js';
import { closePool, query, queryOne } from '../src/lib/db.js';
import { closeRedis } from '../src/lib/redis.js';

const suffix = crypto.randomBytes(4).toString('hex');

beforeAll(async () => {
  await createClient({ name: `Test Client ${suffix}`, rateLimitPerMinute: 1000, rateLimitPerDay: 100000 });
});

afterAll(async () => {
  await closeRedis();
  await closePool();
});

describe('API key generation', () => {
  it('generates long unpredictable keys with identifiable prefix', () => {
    const a = generateRawKey();
    const b = generateRawKey();
    expect(a.rawKey.startsWith(KEY_PREFIX)).toBe(true);
    expect(a.rawKey.length).toBeGreaterThan(40);
    expect(a.rawKey).not.toBe(b.rawKey);
    expect(a.keyHash).toBe(hashKey(a.rawKey));
    expect(a.keyHash).not.toContain(a.rawKey);
  });

  it('never stores the raw key in the database', async () => {
    const created = await createKey({ clientName: `Test Client ${suffix}`, scopes: ['fixtures:read'] });
    const rows = await query(`SELECT * FROM api_keys WHERE id = $1`, [created.id]);
    const dump = JSON.stringify(rows);
    expect(dump).not.toContain(created.rawKey);
    expect(dump).not.toContain(created.rawKey.slice(20));
    expect(dump).toContain(created.keyPrefix);
  });

  it('rejects unknown scopes', async () => {
    await expect(createKey({ clientName: `Test Client ${suffix}`, scopes: ['nope:read'] })).rejects.toThrow(/unknown scope/);
  });
});

describe('API key authentication', () => {
  it('authenticates a valid key and enforces scopes', async () => {
    const created = await createKey({ clientName: `Test Client ${suffix}`, scopes: ['fixtures:read'] });
    const ok = await authenticateApiKey(created.rawKey, 'fixtures:read');
    expect(ok.ok).toBe(true);
    expect(ok.scopeOk).toBe(true);
    const wrongScope = await authenticateApiKey(created.rawKey, 'admin:write');
    expect(wrongScope.ok).toBe(true);
    expect(wrongScope.scopeOk).toBe(false);
  });

  it('rejects invalid keys', async () => {
    const r1 = await authenticateApiKey('pf_live_bogus_key', 'fixtures:read');
    expect(r1.ok).toBe(false);
    const r2 = await authenticateApiKey('not-a-key', 'fixtures:read');
    expect(r2.ok).toBe(false);
  });

  it('rejects a tampered key even when prefix matches', async () => {
    const created = await createKey({ clientName: `Test Client ${suffix}`, scopes: ['fixtures:read'] });
    const tampered = created.rawKey.slice(0, -2) + 'xx';
    const r = await authenticateApiKey(tampered, 'fixtures:read');
    expect(r.ok).toBe(false);
  });

  it('rejects revoked keys immediately but keeps usage history', async () => {
    const created = await createKey({ clientName: `Test Client ${suffix}`, scopes: ['fixtures:read'] });
    const before = await authenticateApiKey(created.rawKey);
    expect(before.ok).toBe(true);
    await revokeKey(created.id, 'test revoke');
    const after = await authenticateApiKey(created.rawKey);
    expect(after.ok).toBe(false);
    expect(after.reason).toMatch(/revoked/);
    const still = await queryOne(`SELECT * FROM api_keys WHERE id = $1`, [created.id]);
    expect(still).not.toBeNull();
  });

  it('rejects expired keys', async () => {
    const created = await createKey({ clientName: `Test Client ${suffix}`, scopes: ['fixtures:read'], expiresInDays: 1 });
    await query(`UPDATE api_keys SET expires_at = now() - interval '1 hour' WHERE id = $1`, [created.id]);
    const r = await authenticateApiKey(created.rawKey);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/expired/);
  });

  it('admin:write implies admin:read', async () => {
    const created = await createKey({ clientName: `Test Client ${suffix}`, scopes: ['admin:write'] });
    const r = await authenticateApiKey(created.rawKey, 'admin:read');
    expect(r.ok).toBe(true);
    expect(r.scopeOk).toBe(true);
  });

  it('rejects keys of disabled clients', async () => {
    await createClient({ name: `Disabled Client ${suffix}` });
    const created = await createKey({ clientName: `Disabled Client ${suffix}`, scopes: ['fixtures:read'] });
    await query(`UPDATE api_clients SET active = FALSE WHERE name = $1`, [`Disabled Client ${suffix}`]);
    const r = await authenticateApiKey(created.rawKey);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/disabled/);
  });
});

describe('API key rotation', () => {
  it('creates a replacement key and keeps the old one during the grace period', async () => {
    const created = await createKey({ clientName: `Test Client ${suffix}`, scopes: ['fixtures:read', 'predictions:read'] });
    const rotated = await rotateKey(created.id, { graceHours: 24 });
    expect(rotated.rawKey.startsWith(KEY_PREFIX)).toBe(true);
    expect(rotated.rawKey).not.toBe(created.rawKey);
    expect(rotated.oldKeyValidUntil).not.toBeNull();

    // old key still valid during grace
    const oldOk = await authenticateApiKey(created.rawKey, 'fixtures:read');
    expect(oldOk.ok).toBe(true);
    // new key valid
    const newOk = await authenticateApiKey(rotated.rawKey, 'fixtures:read');
    expect(newOk.ok).toBe(true);

    // after grace + revocation, old key dies
    await revokeKey(created.id, 'grace over');
    const after = await authenticateApiKey(created.rawKey);
    expect(after.ok).toBe(false);
  });

  it('can revoke the old key immediately (grace 0)', async () => {
    const created = await createKey({ clientName: `Test Client ${suffix}`, scopes: ['fixtures:read'] });
    const rotated = await rotateKey(created.id, { graceHours: 0 });
    const old = await authenticateApiKey(created.rawKey);
    expect(old.ok).toBe(false);
    const fresh = await authenticateApiKey(rotated.rawKey);
    expect(fresh.ok).toBe(true);
  });
});

describe('usage tracking', () => {
  it('records usage rows per key/day/endpoint', async () => {
    const { recordUsage } = await import('../src/keys/service.js');
    const created = await createKey({ clientName: `Test Client ${suffix}`, scopes: ['fixtures:read'] });
    await recordUsage({ apiKeyId: created.id, clientId: created.clientId, endpoint: '/api/v1/fixtures', success: true, rateLimited: false });
    await recordUsage({ apiKeyId: created.id, clientId: created.clientId, endpoint: '/api/v1/fixtures', success: false, rateLimited: true });
    const row = await queryOne<{ requests: number; failed_requests: number; rate_limited_requests: number }>(
      `SELECT requests, failed_requests, rate_limited_requests FROM api_usage
        WHERE api_key_id = $1 AND endpoint = '/api/v1/fixtures'`,
      [created.id],
    );
    expect(row?.requests).toBe(2);
    expect(row?.failed_requests).toBe(1);
    expect(row?.rate_limited_requests).toBe(1);
  });
});
