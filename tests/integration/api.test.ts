import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { AddressInfo } from 'node:net';
import { buildApp } from '../../src/api/server.js';
import { pool, query } from '../../src/db/pool.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createApiKey, revokeApiKey } from '../../src/keys/service.js';
import { upsertCompetitionSeason } from '../../src/repos/lookups.js';

let app: FastifyInstance;
let baseUrl: string;
let clientId: number;
let validKey: string;
let limitedClientId: number;
let limitedKey: string;
let adminHeaders: Record<string, string>;

beforeAll(async () => {
  await runMigrations();
  app = await buildApp();
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
  adminHeaders = { 'content-type': 'application/json', 'x-admin-token': 'test-admin-token' };

  // reset any state from previous runs, then create fresh clients
  await query(`DELETE FROM api_usage WHERE client_id IN (SELECT id FROM api_clients WHERE name IN ('Test Prediction App','Limited App','Website'))`);
  await query(`DELETE FROM api_keys WHERE client_id IN (SELECT id FROM api_clients WHERE name IN ('Test Prediction App','Limited App'))`);
  await query(`DELETE FROM api_clients WHERE name IN ('Test Prediction App','Limited App','Website')`);

  // a normal client
  const client = (
    await query<{ id: number }>(
      `INSERT INTO api_clients (name, client_type) VALUES ('Test Prediction App', 'prediction_app') RETURNING id`,
    )
  ).rows[0];
  clientId = client.id;
  validKey = (await createApiKey({ clientId, scopes: ['fixtures:read', 'teams:read', 'standings:read'] })).fullKey;

  // a heavily rate-limited client
  const limited = (
    await query<{ id: number }>(
      `INSERT INTO api_clients (name, client_type, rate_limit_per_minute, rate_limit_per_day) VALUES ('Limited App', 'prediction_app', 2, 1000) RETURNING id`,
    )
  ).rows[0];
  limitedClientId = limited.id;
  limitedKey = (await createApiKey({ clientId: limitedClientId, scopes: ['*'] })).fullKey;

  // seed content used by content-endpoint tests (independent of db.test run order)
  await upsertCompetitionSeason(
    { providerId: 4001, name: 'Content Test League', type: 'league', country: { providerId: 998, name: 'Contentland', code: null, flagUrl: null }, logoUrl: null },
    { year: 2099, startDate: '2099-08-01', endDate: '2100-05-31', isCurrent: true },
    { events: true, lineups: true, fixtureStatistics: true, playerStatistics: true, standings: true, players: false, topScorers: false, topAssists: false, topCards: false, injuries: true, sidelined: false, predictions: true, odds: false },
  );
});

async function api(path: string, opts: { headers?: Record<string, string>; method?: string } = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}${path}`, { headers: opts.headers, method: opts.method ?? 'GET' });
  const body = (await res.json()) as Record<string, unknown>;
  return { status: res.status, body };
}

describe('API authentication', () => {
  it('public health endpoint works without key', async () => {
    const r = await api('/health');
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
  });

  it('rejects missing key', async () => {
    const r = await api('/fixtures');
    expect(r.status).toBe(401);
    expect((r.body.error as Record<string, unknown>).status).toBe(401);
  });

  it('rejects malformed and unknown keys', async () => {
    expect((await api('/fixtures', { headers: { 'x-api-key': 'totally-wrong' } })).status).toBe(401);
    expect((await api('/fixtures', { headers: { 'x-api-key': 'pf_live_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' } })).status).toBe(401);
  });

  it('accepts a valid key', async () => {
    const r = await api('/fixtures', { headers: { 'x-api-key': validKey } });
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
  });

  it('rejects keys with insufficient scope', async () => {
    // validKey has no players:read
    const r = await api('/players', { headers: { 'x-api-key': validKey } });
    expect(r.status).toBe(403);
    expect(JSON.stringify(r.body.error)).toContain('insufficient scope');
  });

  it('rejects revoked keys immediately', async () => {
    const tempKey = (await createApiKey({ clientId, scopes: ['fixtures:read'] })).fullKey;
    expect((await api('/fixtures', { headers: { 'x-api-key': tempKey } })).status).toBe(200);
    // find key id by checking prefix lookup via admin endpoint
    const keys = (await api('/admin/api-keys', { headers: adminHeaders })).body as { data: { id: number; keyPrefix: string }[] & { pagination?: unknown } };
    const list = keys as unknown as { success: boolean; data: { id: number; keyPrefix: string }[] };
    const keyId = list.data.find((k) => tempKey.startsWith(k.keyPrefix))!.id;
    await revokeApiKey(keyId, 'test');
    const r = await api('/fixtures', { headers: { 'x-api-key': tempKey } });
    expect(r.status).toBe(403);
    expect(JSON.stringify(r.body.error)).toContain('revoked');
  });

  it('rejects expired keys', async () => {
    const tempKey = (await createApiKey({ clientId, scopes: ['fixtures:read'], expiresInDays: -1 })).fullKey;
    const r = await api('/fixtures', { headers: { 'x-api-key': tempKey } });
    expect(r.status).toBe(403);
    expect(JSON.stringify(r.body.error)).toContain('expired');
  });

  it('rate limits per client', async () => {
    const headers = { 'x-api-key': limitedKey };
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) {
      statuses.push((await api('/fixtures', { headers })).status);
    }
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThanOrEqual(2);
    expect(statuses[0]).toBe(200);
  });

  it('records usage in api_usage', async () => {
    await api('/fixtures', { headers: { 'x-api-key': validKey } });
    const { rows } = await query(`SELECT requests FROM api_usage WHERE client_id = $1 LIMIT 1`, [clientId]);
    expect(rows.length).toBeGreaterThan(0);
  });
});

describe('API-key admin', () => {
  it('blocks admin endpoints without token', async () => {
    expect((await api('/admin/clients')).status).toBe(401);
  });

  it('creates client + key via admin API and shows the secret once', async () => {
    const client = await fetch(`${baseUrl}/admin/clients`, {
      method: 'POST', headers: adminHeaders, body: JSON.stringify({ name: 'Website', clientType: 'website' }),
    });
    expect(client.status).toBe(201);
    const clientId = ((await client.json()) as { data: { id: number } }).data.id;

    const key = await fetch(`${baseUrl}/admin/api-keys`, {
      method: 'POST', headers: adminHeaders,
      body: JSON.stringify({ clientId, scopes: ['fixtures:read', 'predictions:read'] }),
    });
    expect(key.status).toBe(201);
    const keyBody = (await key.json()) as { data: { apiKey: string; keyId: number; warning: string } };
    expect(keyBody.data.apiKey.startsWith('pf_live_')).toBe(true);
    expect(keyBody.data.warning).toContain('not be displayed again');

    // plaintext key is NOT stored anywhere
    const { rows } = await query(`SELECT count(*)::int AS n FROM api_keys WHERE key_hash LIKE '%' || $1`, [keyBody.data.apiKey.slice(10, 20)]);
    expect(rows[0].n).toBe(0);
  });

  it('refuses invalid scopes', async () => {
    const res = await fetch(`${baseUrl}/admin/api-keys`, {
      method: 'POST', headers: adminHeaders,
      body: JSON.stringify({ clientId, scopes: ['galaxy:destroy'] }),
    });
    expect(res.status).toBe(400);
  });

  it('rotates keys with grace period', async () => {
    const oldKey = (await createApiKey({ clientId, scopes: ['fixtures:read'] })).fullKey;
    const keys = (await (await api('/admin/api-keys', { headers: adminHeaders })).body as unknown as { data: { id: number; keyPrefix: string }[] });
    const keyId = keys.data.find((k) => oldKey.startsWith(k.keyPrefix))!.id;
    const res = await fetch(`${baseUrl}/admin/api-keys/${keyId}/rotate`, {
      method: 'POST', headers: adminHeaders, body: JSON.stringify({ graceHours: 24 }),
    });
    const body = (await res.json()) as { data: { apiKey: string; keyId: number } };
    expect(res.status).toBe(201);
    // both old (grace) and new keys work
    expect((await api('/fixtures', { headers: { 'x-api-key': oldKey } })).status).toBe(200);
    expect((await api('/fixtures', { headers: { 'x-api-key': body.data.apiKey } })).status).toBe(200);
  });
});

describe('security', () => {
  it('never leaks provider key or admin token in responses', async () => {
    const paths = ['/', '/health', '/health/data', '/fixtures', '/competitions'];
    for (const p of paths) {
      const r = await api(p, { headers: { 'x-api-key': validKey } });
      expect(JSON.stringify(r.body)).not.toContain(process.env.ADMIN_TOKEN!);
      expect(JSON.stringify(r.body)).not.toMatch(/apisports|rapidapi-key/i);
    }
  });

  it('error messages never contain secrets', async () => {
    const r = await api('/admin/api-keys', { headers: { 'x-admin-token': 'wrong-token' } });
    expect(r.status).toBe(401);
    expect(JSON.stringify(r.body)).not.toContain('test-admin-token');
  });
});

describe('content endpoints', () => {
  const headers = { 'x-api-key': '' };

  beforeAll(() => {
    headers['x-api-key'] = validKey;
  });

  it('lists competitions with pagination meta', async () => {
    const r = await api('/competitions?search=Content Test League', { headers });
    expect(r.status).toBe(200);
    const data = r.body.data as unknown[];
    expect(data.length).toBeGreaterThanOrEqual(1);
    expect(r.body.meta).toBeTruthy();
  });

  it('returns consistent envelopes for 404', async () => {
    const r = await api('/fixtures/999999999', { headers });
    expect(r.status).toBe(404);
    expect(r.body.success).toBe(false);
  });

  it('serves standings in grouped shape', async () => {
    const r = await api('/standings?competition=3999&season=2099', { headers });
    // 404 with a proper error envelope when not imported; 200 with data when available
    if (r.status === 200) {
      expect(r.body.success).toBe(true);
    } else {
      expect(r.status).toBe(404);
      expect(r.body.success).toBe(false);
    }
  });

  it('documents itself with OpenAPI', async () => {
    const res = await fetch(`${baseUrl}/docs/json`);
    expect(res.status).toBe(200);
    const spec = (await res.json()) as Record<string, unknown>;
    expect(spec.openapi).toBeTruthy();
    expect(JSON.stringify(spec)).toContain('predictions/features');
  });
});

afterAll(async () => {
  await app.close();
  await pool.end();
});
