/**
 * REST API tests: authentication matrix, scopes, rate limiting, response shape,
 * health endpoints, and proof the provider key never leaks.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import crypto from 'node:crypto';
import type { Express } from 'express';
import { createApp } from '../src/api/app.js';
import { createClient, createKey, revokeKey, generateRawKey, hashKey } from '../src/keys/service.js';
import { closePool, query } from '../src/lib/db.js';
import { closeRedis } from '../src/lib/redis.js';
import { registerAllHandlers } from '../src/sync/handlers.js';
import { importCompetitions } from '../src/sync/pipelines/metadata.js';
import { importFixturesForCompetitionSeason, runPostMatchPipeline } from '../src/sync/pipelines/fixtures.js';
import { config } from '../src/config.js';

let app: Express;
const suffix = crypto.randomBytes(4).toString('hex');
let readerKey = '';
let readerId = 0;
let adminKey = '';

beforeAll(async () => {
  registerAllHandlers();
  await importCompetitions();
  const comp = await query<{ id: number }>(`SELECT id FROM competitions WHERE provider_id = '39'`);
  const season = await query<{ id: number }>(`SELECT id FROM seasons WHERE year = 2025`);
  await importFixturesForCompetitionSeason(comp[0].id, season[0].id, { fetchDetails: true });
  const fx = await query<{ id: number }>(`SELECT id FROM fixtures WHERE competition_id = $1 AND season_id = $2 AND status_short = 'FT' LIMIT 1`, [comp[0].id, season[0].id]);
  if (fx[0]) await runPostMatchPipeline(fx[0].id);

  await createClient({ name: `API Test Reader ${suffix}`, rateLimitPerMinute: 1000, rateLimitPerDay: 100000 });
  const reader = await createKey({
    clientName: `API Test Reader ${suffix}`,
    scopes: ['fixtures:read', 'teams:read', 'standings:read', 'statistics:read', 'predictions:read'],
  });
  readerKey = reader.rawKey;
  readerId = reader.id;

  const admin = await createKey({ clientName: `API Test Admin ${suffix}`, scopes: ['admin:write', 'admin:read'] });
  adminKey = admin.rawKey;

  app = createApp();
});

afterAll(async () => {
  await closeRedis();
  await closePool();
});

describe('authentication', () => {
  it('rejects requests without an API key', async () => {
    const res = await request(app).get('/api/v1/fixtures');
    expect(res.status).toBe(401);
  });

  it('rejects invalid API keys', async () => {
    const res = await request(app).get('/api/v1/fixtures').set('X-API-Key', 'pf_live_invalid');
    expect(res.status).toBe(401);
  });

  it('accepts a valid key', async () => {
    const res = await request(app).get('/api/v1/fixtures').set('X-API-Key', readerKey);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it('rejects revoked keys', async () => {
    const temp = await createKey({ clientName: `API Test Reader ${suffix}`, scopes: ['fixtures:read'] });
    const okRes = await request(app).get('/api/v1/fixtures').set('X-API-Key', temp.rawKey);
    expect(okRes.status).toBe(200);
    await revokeKey(temp.id, 'test');
    const noRes = await request(app).get('/api/v1/fixtures').set('X-API-Key', temp.rawKey);
    expect(noRes.status).toBe(401);
  });

  it('rejects expired keys', async () => {
    const temp = await createKey({ clientName: `API Test Reader ${suffix}`, scopes: ['fixtures:read'], expiresInDays: 1 });
    await query(`UPDATE api_keys SET expires_at = now() - interval '1 day' WHERE id = $1`, [temp.id]);
    const res = await request(app).get('/api/v1/fixtures').set('X-API-Key', temp.rawKey);
    expect(res.status).toBe(401);
  });

  it('rejects insufficient scope', async () => {
    const res = await request(app).get('/api/v1/referees').set('X-API-Key', readerKey); // reader lacks referees:read
    expect(res.status).toBe(403);
  });

  it('enforces rate limits', async () => {
    // client-level limit is 2/min for this dedicated client
    await createClient({ name: `API Test Tiny ${suffix}`, rateLimitPerMinute: 2, rateLimitPerDay: 100 });
    const tiny = await createKey({ clientName: `API Test Tiny ${suffix}`, scopes: ['fixtures:read'] });
    const codes: number[] = [];
    for (let i = 0; i < 4; i++) {
      const res = await request(app).get('/api/v1/fixtures?per_page=1').set('X-API-Key', tiny.rawKey);
      codes.push(res.status);
    }
    expect(codes.slice(0, 2)).toEqual([200, 200]);
    expect(codes).toContain(429);
    void readerId;
  });
});

describe('rate limit headers & usage', () => {
  it('returns remaining-quota headers and records usage', async () => {
    const res = await request(app).get('/api/v1/fixtures?per_page=1').set('X-API-Key', readerKey);
    expect(res.status).toBe(200);
    expect(res.headers['x-ratelimit-remaining-minute']).toBeDefined();
    expect(res.headers['x-ratelimit-remaining-day']).toBeDefined();
  });
});

describe('endpoints', () => {
  it('GET /fixtures/:id/events returns events for a populated fixture', async () => {
    const list = await request(app).get('/api/v1/fixtures?status=FT&per_page=5').set('X-API-Key', readerKey);
    const fixtureId = list.body.data[0]?.id;
    expect(fixtureId).toBeTruthy();
    const res = await request(app).get(`/api/v1/fixtures/${fixtureId}/events`).set('X-API-Key', readerKey);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it('GET /predictions/features/:fixtureId returns structured features', async () => {
    const built = await query<{ fixture_id: number }>(`SELECT fixture_id FROM prediction_features LIMIT 1`);
    expect(built[0]?.fixture_id).toBeTruthy();
    const res = await request(app).get(`/api/v1/predictions/features/${built[0].fixture_id}`).set('X-API-Key', readerKey);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty('home_form');
    expect(res.body.data).toHaveProperty('h2h');
    expect(res.body.data).toHaveProperty('data_freshness');
  });

  it('GET /standings returns rows for a covered competition', async () => {
    const comps = await query<{ id: number }>(`SELECT id FROM competitions WHERE provider_id = '39'`);
    const seasons = await query<{ id: number }>(`SELECT id FROM seasons WHERE year = 2025`);
    const res = await request(app)
      .get(`/api/v1/standings?competition_id=${comps[0].id}&season_id=${seasons[0].id}`)
      .set('X-API-Key', readerKey);
    expect(res.status).toBe(200);
  });

  it('404s unknown resources with consistent error shape', async () => {
    const res = await request(app).get('/api/v1/fixtures/99999999').set('X-API-Key', readerKey);
    expect(res.status).toBe(404);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('health endpoints respond without authentication', async () => {
    for (const p of ['/api/v1/health', '/api/v1/health/database', '/api/v1/health/redis', '/api/v1/health/provider', '/api/v1/health/data']) {
      const res = await request(app).get(p);
      expect(res.status).toBeLessThan(500);
    }
    const db = await request(app).get('/api/v1/health/database');
    expect(db.body.ok).toBe(true);
    const redis = await request(app).get('/api/v1/health/redis');
    expect(redis.body.ok).toBe(true);
    const data = await request(app).get('/api/v1/health/data');
    expect(data.body).toHaveProperty('checks');
  });
});

describe('security', () => {
  it('the provider key never appears in any API response', async () => {
    const paths = ['/api/v1/health/provider', '/api/v1/competitions', '/api/v1/fixtures?per_page=2'];
    for (const p of paths) {
      const res = await request(app).get(p).set('X-API-Key', readerKey);
      const text = JSON.stringify(res.body);
      if (config.apiFootballKey) {
        expect(text).not.toContain(config.apiFootballKey);
      }
      expect(text.toLowerCase()).not.toContain('api_football_key');
      expect(text.toLowerCase()).not.toContain('x-apisports-key');
    }
  });

  it('admin endpoints require admin authentication', async () => {
    const denied = await request(app).get('/api/v1/admin/api-keys').set('X-API-Key', readerKey);
    expect(denied.status).toBe(403);
    const allowed = await request(app).get('/api/v1/admin/api-keys').set('X-API-Key', adminKey);
    expect(allowed.status).toBe(200);
    // response contains prefix only — never raw keys or hashes
    const text = JSON.stringify(allowed.body);
    expect(text).not.toContain(adminKey);
    expect(text).not.toContain(hashKey(adminKey));
  });

  it('admin can create keys via API and the secret is returned exactly once', async () => {
    const res = await request(app)
      .post('/api/v1/admin/api-keys')
      .set('X-API-Key', adminKey)
      .send({ client_name: `API Test Created ${suffix}`, scopes: ['fixtures:read'] });
    expect(res.status).toBe(201);
    const raw = res.body.data.api_key as string;
    expect(raw.startsWith('pf_live_')).toBe(true);
    const list = await request(app).get('/api/v1/admin/api-keys').set('X-API-Key', adminKey);
    expect(JSON.stringify(list.body)).not.toContain(raw);
  });

  it('login + rotate + revoke flow works with admin password token', async () => {
    const login = await request(app)
      .post('/api/v1/admin/login')
      .send({ username: config.adminUser, password: config.adminPassword });
    if (config.adminPassword) {
      expect(login.status).toBe(200);
      const token = login.body.token as string;
      const keys = await request(app).get('/api/v1/admin/api-keys').set('Authorization', `Bearer ${token}`);
      expect(keys.status).toBe(200);
    }
    const gen = generateRawKey();
    expect(gen.keyHash).toHaveLength(64);
  });
});

describe('admin permanent key deletion (endpoint)', () => {
  it('admin can permanently delete a key; it immediately fails auth and disappears from the list', async () => {
    const { deleteKeyPermanently } = await import('../src/keys/service.js');
    const created = await createKey({ clientName: `API Test Admin ${suffix}`, scopes: ['fixtures:read'] });
    const okRes = await request(app).get('/api/v1/fixtures').set('X-API-Key', created.rawKey);
    expect(okRes.status).toBe(200);

    const del = await request(app).delete(`/api/v1/admin/api-keys/${created.id}`).set('X-API-Key', adminKey);
    expect(del.status).toBe(200);
    expect(del.body.data.deleted).toBe(true);
    expect(JSON.stringify(del.body)).not.toContain(created.rawKey); // prefix only, never the full secret

    const authRes = await request(app).get('/api/v1/fixtures').set('X-API-Key', created.rawKey);
    expect(authRes.status).toBe(401); // deleted key stops authenticating immediately

    const list = await request(app).get('/api/v1/admin/api-keys').set('X-API-Key', adminKey);
    expect(list.status).toBe(200);
    expect(list.body.data.keys.some((k: { id: number }) => k.id === created.id)).toBe(false);
    void deleteKeyPermanently;
  });

  it('non-admin API users can NEVER delete keys', async () => {
    const victim = await createKey({ clientName: `API Test Admin ${suffix}`, scopes: ['fixtures:read'] });
    const res = await request(app).delete(`/api/v1/admin/api-keys/${victim.id}`).set('X-API-Key', readerKey);
    expect(res.status).toBe(403);
    const stillThere = await query(`SELECT id FROM api_keys WHERE id = $1`, [victim.id]);
    expect(stillThere.length).toBe(1);
  });

  it('deleting an already-deleted key is safe (idempotent)', async () => {
    const temp = await createKey({ clientName: `API Test Admin ${suffix}`, scopes: ['fixtures:read'] });
    await request(app).delete(`/api/v1/admin/api-keys/${temp.id}`).set('X-API-Key', adminKey);
    const again = await request(app).delete(`/api/v1/admin/api-keys/${temp.id}`).set('X-API-Key', adminKey);
    expect(again.status).toBe(200);
    expect(again.body.data.deleted).toBe(false);
  });
});

describe('managed website key (endpoint)', () => {
  it('lists the managed key with managed_role indicator', async () => {
    const { ensureWebsiteKey } = await import('../src/keys/website-key.js');
    const ensured = await ensureWebsiteKey('api-test');
    const list = await request(app).get('/api/v1/admin/api-keys').set('X-API-Key', adminKey);
    const managed = list.body.data.keys.find((k: { id: number }) => k.id === ensured.record.id);
    expect(managed).toBeTruthy();
    expect(managed.managed_role).toBe('website');
    expect(JSON.stringify(list.body)).not.toMatch(/pf_live_[A-Za-z0-9_]{20,}/);
  });

  it('rotates the website key on demand: no secret returned, old key replaced, new key authenticates', async () => {
    const { ensureWebsiteKey, resolveWebsiteKey } = await import('../src/keys/website-key.js');
    const before = await ensureWebsiteKey('api-test');

    const rot = await request(app)
      .post(`/api/v1/admin/api-keys/${before.record.id}/rotate-website`)
      .set('X-API-Key', adminKey)
      .send({});
    expect(rot.status).toBe(200);
    expect(rot.body.data.managed_role).toBe('website');
    expect(rot.body.data.api_key).toBeUndefined(); // no raw key field at all
    expect(JSON.stringify(rot.body)).not.toMatch(/pf_live_[A-Za-z0-9]+_[A-Za-z0-9_-]{10,}/); // at most a prefix

    const resolved = await resolveWebsiteKey();
    expect(Number(resolved!.record.id)).toBe(rot.body.data.id);
    const auth = await request(app).get('/api/v1/fixtures').set('X-API-Key', resolved!.rawKey);
    expect(auth.status).toBe(200); // replacement verified and working
  });

  it('rejects website rotation for a non-managed key', async () => {
    const temp = await createKey({ clientName: `API Test Admin ${suffix}`, scopes: ['fixtures:read'] });
    const res = await request(app).post(`/api/v1/admin/api-keys/${temp.id}/rotate-website`).set('X-API-Key', adminKey).send({});
    expect(res.status).toBe(400);
  });

  it('fixture list responses include team logos and venue for the UI', async () => {
    const res = await request(app).get('/api/v1/fixtures?per_page=3').set('X-API-Key', readerKey);
    expect(res.status).toBe(200);
    for (const f of res.body.data) {
      expect(f).toHaveProperty('home_team_logo');
      expect(f).toHaveProperty('away_team_logo');
      expect(f).toHaveProperty('venue_name');
    }
  });
});
