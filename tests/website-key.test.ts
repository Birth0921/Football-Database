/**
 * Managed Website key tests: provisioning, exactly-one invariant under
 * concurrency, read-only scopes, restart stability, recovery after deletion,
 * and safe manual rotation (replacement verified before the old key dies).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { closePool, query, queryOne } from '../src/lib/db.js';
import { closeRedis } from '../src/lib/redis.js';
import { authenticateApiKey, createClient, createKey } from '../src/keys/service.js';
import {
  WEBSITE_SCOPES, ensureWebsiteKey, resolveWebsiteKey, rotateWebsiteKey,
  getManagedWebsiteKeyRecord, websiteScopesAreReadOnly,
} from '../src/keys/website-key.js';

async function wipeManagedKeys(): Promise<void> {
  await query(`DELETE FROM api_keys WHERE managed_role = 'website'`);
}

beforeAll(async () => {
  await wipeManagedKeys();
});

afterAll(async () => {
  await closeRedis();
  await closePool();
});

describe('managed website key provisioning', () => {
  it('creates exactly one managed key with ONLY read-only public scopes when missing', async () => {
    const { record, rawKey } = await ensureWebsiteKey('test');
    expect(record.managed_role).toBe('website');
    expect([...record.scopes].sort()).toEqual([...WEBSITE_SCOPES].sort());
    expect(record.scopes).not.toContain('admin:read');
    expect(record.scopes).not.toContain('admin:write');
    expect(websiteScopesAreReadOnly(record.scopes)).toBe(true);
    // the key authenticates against the normal API-key pipeline
    const auth = await authenticateApiKey(rawKey, 'fixtures:read');
    expect(auth.ok).toBe(true);
    const adminAuth = await authenticateApiKey(rawKey, 'admin:read');
    expect(adminAuth.ok && adminAuth.scopeOk).toBe(false); // no admin access, ever
    // exactly one managed row + one encrypted secret, no raw key anywhere in api_keys
    const rows = await query(`SELECT * FROM api_keys WHERE managed_role = 'website'`);
    expect(rows.length).toBe(1);
    expect(JSON.stringify(rows)).not.toContain(rawKey);
    const secrets = await query(`SELECT * FROM managed_key_secrets`);
    expect(secrets.length).toBe(1);
    expect(JSON.stringify(secrets)).not.toContain(rawKey); // encrypted at rest
  });

  it('does NOT generate a new key on restart — resolve/ensure reuse the existing key', async () => {
    const first = await getManagedWebsiteKeyRecord();
    const resolved = await resolveWebsiteKey();
    expect(Number(resolved!.record.id)).toBe(Number(first!.id));
    const again = await ensureWebsiteKey('test-restart');
    expect(Number(again.record.id)).toBe(Number(first!.id));
    const count = await queryOne<{ c: number }>(`SELECT count(*)::int AS c FROM api_keys WHERE managed_role = 'website'`);
    expect(count!.c).toBe(1);
  });

  it('never creates duplicates under concurrent provisioning', async () => {
    await wipeManagedKeys();
    const results = await Promise.all(Array.from({ length: 8 }, () => ensureWebsiteKey('test-concurrent')));
    const ids = new Set(results.map((r) => r.record.id));
    expect(new Set(results.map((r) => Number(r.record.id))).size).toBe(1); // advisory lock + unique index: exactly one key
    const count = await queryOne<{ c: number }>(`SELECT count(*)::int AS c FROM api_keys WHERE managed_role = 'website'`);
    expect(count!.c).toBe(1);
  });
});

describe('managed website key recovery', () => {
  it('re-provisions when an admin permanently deletes the managed key', async () => {
    const before = await getManagedWebsiteKeyRecord();
    await query(`DELETE FROM api_keys WHERE id = $1`, [before!.id]); // admin-style permanent deletion
    expect(await resolveWebsiteKey()).toBeNull(); // detected missing
    const replacement = await ensureWebsiteKey('test-recovery');
    expect(Number(replacement.record.id)).not.toBe(Number(before!.id));
    const auth = await authenticateApiKey(replacement.rawKey, 'predictions:read');
    expect(auth.ok).toBe(true);
    // and it does not flap: ensuring again keeps the same key
    const stable = await ensureWebsiteKey('test-recovery-2');
    expect(Number(stable.record.id)).toBe(Number(replacement.record.id));
  });
});

describe('manual website key rotation (on demand only)', () => {
  it('creates + verifies the replacement BEFORE deleting the old key', async () => {
    const oldKey = await getManagedWebsiteKeyRecord();
    const oldResolved = await resolveWebsiteKey();
    const rotated = await rotateWebsiteKey('test');
    expect(rotated.id).not.toBe(Number(oldKey!.id));
    // old key physically gone, exactly one managed row, new key works
    const oldRow = await queryOne(`SELECT id FROM api_keys WHERE id = $1`, [oldKey!.id]);
    expect(oldRow).toBeNull();
    const managed = await getManagedWebsiteKeyRecord();
    expect(Number(managed!.id)).toBe(rotated.id);
    expect(managed!.scopes.sort()).toEqual([...WEBSITE_SCOPES].sort());
    const resolved = await resolveWebsiteKey();
    expect(Number(resolved!.record.id)).toBe(rotated.id);
    expect(resolved!.rawKey).not.toBe(oldResolved!.rawKey);
    const auth = await authenticateApiKey(resolved!.rawKey, 'standings:read');
    expect(auth.ok).toBe(true);
    // the old key no longer authenticates (hash row physically removed)
    const oldAuth = await authenticateApiKey(oldResolved!.rawKey, 'fixtures:read');
    expect(oldAuth.ok).toBe(false);
  });

  it('FAILED rotation preserves the old working key', async () => {
    const before = await getManagedWebsiteKeyRecord();
    const beforeResolved = await resolveWebsiteKey();
    const countBefore = await queryOne<{ c: number }>(`SELECT count(*)::int AS c FROM api_keys`);
    await expect(
      rotateWebsiteKey('test', async () => false), // verification fails
    ).rejects.toThrow(/verification/i);
    // old key untouched and still authenticating; nothing extra created
    const after = await getManagedWebsiteKeyRecord();
    expect(Number(after!.id)).toBe(Number(before!.id));
    const countAfter = await queryOne<{ c: number }>(`SELECT count(*)::int AS c FROM api_keys`);
    expect(countAfter!.c).toBe(countBefore!.c);
    const auth = await authenticateApiKey(beforeResolved!.rawKey, 'fixtures:read');
    expect(auth.ok).toBe(true);
  });

  it('rotation raw secret is never returned to callers or logged', async () => {
    const rotated = await rotateWebsiteKey('test');
    expect(JSON.stringify(rotated)).not.toMatch(/pf_live_[A-Za-z0-9]+_[A-Za-z0-9_-]{10,}/); // prefix only
    const audit = await query(`SELECT details FROM api_audit_log WHERE action = 'key.website.rotate' ORDER BY id DESC LIMIT 1`);
    expect(JSON.stringify(audit)).not.toMatch(/pf_live_[A-Za-z0-9_]{20,}/);
  });
});

describe('website key isolation from other clients', () => {
  it('unrelated keys are never marked managed and the managed key stays unique', async () => {
    const other = await createKey({ clientName: 'Website Isolation Test Client', scopes: ['fixtures:read'] });
    expect(other.id).toBeTruthy();
    const managedCount = await queryOne<{ c: number }>(
      `SELECT count(*)::int AS c FROM api_keys WHERE managed_role = 'website'`,
    );
    expect(managedCount!.c).toBe(1);
    const otherRow = await queryOne<{ managed_role: string | null }>(`SELECT managed_role FROM api_keys WHERE id = $1`, [other.id]);
    expect(otherRow!.managed_role).toBeNull();
  });
});

void createClient;
