/**
 * Tests for the official client SDK (`sdk/typescript`).
 *
 * The client is what every external application (prediction app, dashboard,
 * bot) uses, so these tests pin down the behaviour those apps rely on:
 *
 *  - keys travel in `X-API-Key`, never in the URL
 *  - 401/403/404 are terminal, 429/5xx are retried with backoff
 *  - `Retry-After` is honoured on 429
 *  - pagination helpers walk every page
 *  - PostgreSQL numeric strings arrive as numbers
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import type { Express } from 'express';
import { createApp } from '../src/api/app.js';
import { createClient, createKey } from '../src/keys/service.js';
import { closePool, query } from '../src/lib/db.js';
import { closeRedis, getRedis } from '../src/lib/redis.js';
import { buildPredictionFeature } from '../src/stats/predictions.js';
import {
  FootballDataClient,
  AuthenticationError,
  NotFoundError,
  RateLimitError,
  PermissionError,
  ServerError,
  coerceNumbers,
  redactKey,
} from '../sdk/typescript/src/index.js';

let app: Express;
let server: http.Server;
let baseUrl = '';
let readerKey = '';
let fixturesOnlyKey = '';
let limitedKey = '';
let fixtureId = 0;

const suffix = () => Math.random().toString(36).slice(2, 8);

async function seed(): Promise<void> {
  const s = suffix();
  const comp = await query<{ id: number }>(
    `INSERT INTO competitions (name, provider_id, type, active, import_tier) VALUES ($1, $2, 'League', TRUE, 2) RETURNING id`,
    [`SDK Test League ${s}`, `sdk-league-${s}`],
  );
  const competitionId = Number(comp[0].id);
  const season = await query<{ id: number }>(
    `INSERT INTO seasons (year, display_name, provider_id, import_scope) VALUES (2091, '2091/92', $1, 'in_scope') RETURNING id`,
    [`sdk-season-${s}`],
  );
  const seasonId = Number(season[0].id);
  await query(
    `INSERT INTO competition_seasons (competition_id, season_id, is_current, import_scope) VALUES ($1, $2, TRUE, 'in_scope')`,
    [competitionId, seasonId],
  );
  const teamIds: number[] = [];
  for (const name of ['SDK Alpha', 'SDK Beta']) {
    const t = await query<{ id: number }>(`INSERT INTO teams (name, provider_id) VALUES ($1, $2) RETURNING id`, [
      name,
      `sdk-team-${s}-${name}`,
    ]);
    teamIds.push(Number(t[0].id));
  }

  const ids: number[] = [];
  for (let i = 0; i < 7; i += 1) {
    const f = await query<{ id: number }>(
      `INSERT INTO fixtures (provider_fixture_id, competition_id, season_id, home_team_id, away_team_id,
                             kickoff_utc, status_short)
       VALUES ($1, $2, $3, $4, $5, $6, 'NS') RETURNING id`,
      [`sdk-fx-${s}-${i}`, competitionId, seasonId, teamIds[0], teamIds[1], new Date(Date.now() + (i + 1) * 3_600_000)],
    );
    ids.push(Number(f[0].id));
  }

  // one finished match so team statistics exist for the feature builder
  await query(
    `INSERT INTO fixtures (provider_fixture_id, competition_id, season_id, home_team_id, away_team_id,
                           kickoff_utc, status_short, home_score, away_score)
     VALUES ($1, $2, $3, $4, $5, $6, 'FT', 2, 1)`,
    [`sdk-fx-done-${s}`, competitionId, seasonId, teamIds[0], teamIds[1], new Date(Date.now() - 86_400_000)],
  );

  fixtureId = ids[0];
  await buildPredictionFeature(fixtureId);
}

beforeAll(async () => {
  await seed();
  // The platform caches responses in Redis keyed by id; the cache is shared
  // with the development database, so clear it before asserting on fresh rows.
  await getRedis().flushdb();

  const readerName = `SDK Reader ${suffix()}`;
  await createClient({ name: readerName, rateLimitPerMinute: 1000, rateLimitPerDay: 100_000 });
  readerKey = (
    await createKey({
      clientName: readerName,
      scopes: [
        'fixtures:read',
        'teams:read',
        'players:read',
        'referees:read',
        'standings:read',
        'statistics:read',
        'predictions:read',
      ],
    })
  ).rawKey;

  const fixturesOnlyName = `SDK Fixtures Only ${suffix()}`;
  await createClient({ name: fixturesOnlyName, rateLimitPerMinute: 1000, rateLimitPerDay: 100_000 });
  fixturesOnlyKey = (await createKey({ clientName: fixturesOnlyName, scopes: ['fixtures:read'] })).rawKey;

  const limitedName = `SDK Limited ${suffix()}`;
  await createClient({ name: limitedName, rateLimitPerMinute: 2, rateLimitPerDay: 100_000 });
  limitedKey = (await createKey({ clientName: limitedName, scopes: ['fixtures:read', 'predictions:read'] })).rawKey;

  app = createApp();
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const address = server.address();
  baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/api/v1`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closeRedis();
  await closePool();
});

function client(
  overrides: { apiKey?: string; maxRetries?: number; retryBaseMs?: number; perPage?: number } = {},
): FootballDataClient {
  return new FootballDataClient({
    baseUrl,
    apiKey: overrides.apiKey ?? readerKey,
    maxRetries: overrides.maxRetries ?? 0,
    retryBaseMs: overrides.retryBaseMs ?? 10,
    perPage: overrides.perPage ?? 3,
  });
}

describe('authentication', () => {
  it('reads the platform with a valid key', async () => {
    const api = client();
    const health = await api.health();
    expect(health.ok).toBe(true);
    expect(['live', 'mock']).toContain(health.providerMode);
  });

  it('sends the key in X-API-Key and never in the URL', async () => {
    const seen: Array<{ url: string; apiKeyHeader: string | null }> = [];
    const api = new FootballDataClient({
      baseUrl,
      apiKey: readerKey,
      fetch: async (input, init) => {
        const url = typeof input === 'string' ? input : String(input);
        const headers = new Headers(init?.headers as Record<string, string> | undefined);
        seen.push({ url, apiKeyHeader: headers.get('x-api-key') });
        return new Response(
          JSON.stringify({ ok: true, data: [], pagination: { page: 1, per_page: 3, total: 0, total_pages: 1 } }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      },
    });
    await api.fixturesUpcoming({ per_page: 3 });
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toContain('/fixtures/upcoming?per_page=3');
    expect(seen[0].url).not.toContain(readerKey);
    expect(seen[0].apiKeyHeader).toBe(readerKey);
  });

  it('rejects a malformed key and does not retry (401 is terminal)', async () => {
    const api = client({ apiKey: 'not-a-platform-key', maxRetries: 3 });
    const started = Date.now();
    await expect(api.fixturesUpcoming()).rejects.toBeInstanceOf(AuthenticationError);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('rejects a key without the required scope with 403', async () => {
    const api = client({ apiKey: fixturesOnlyKey });
    await expect(api.predictionFeatures(fixtureId)).rejects.toBeInstanceOf(PermissionError);
  });

  it('exposes rate-limit headers after each call', async () => {
    const api = client();
    await api.fixturesUpcoming({ per_page: 1 });
    expect(api.rateLimit.remainingMinute).toBeTypeOf('number');
    expect(api.rateLimit.remainingDay).toBeTypeOf('number');
  });

  it('surfaces 429 as RateLimitError with a retry hint', async () => {
    const api = client({ apiKey: limitedKey });
    await api.fixturesUpcoming({ per_page: 1 });
    await api.fixturesUpcoming({ per_page: 1 });
    const err = (await api.fixturesUpcoming({ per_page: 1 }).catch((e: unknown) => e)) as RateLimitError;
    expect(err).toBeInstanceOf(RateLimitError);
    expect(err.retryAfterSeconds).toBeGreaterThan(0);
  });
});

describe('prediction features', () => {
  it('returns model-ready features with numeric values', async () => {
    const api = client();
    const { data } = await api.predictionFeatures(fixtureId);
    expect(data.fixture_id).toBe(fixtureId);
    expect(data.home_goals_avg === null || typeof data.home_goals_avg === 'number').toBe(true);
    expect(data.league_avg_goals === null || typeof data.league_avg_goals === 'number').toBe(true);
    expect(Array.isArray(data.player_availability)).toBe(true);
  });

  it('returns 404 for a fixture without features', async () => {
    const api = client();
    await expect(api.predictionFeatures(9_999_999)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('batch-fetches features and collects failures instead of throwing', async () => {
    const api = client();
    const { features, failures } = await api.predictionFeaturesBatch([fixtureId, 9_999_999], { concurrency: 2 });
    expect(features).toHaveLength(1);
    expect(failures).toHaveLength(1);
    expect(failures[0].fixtureId).toBe(9_999_999);
  });
});

describe('pagination', () => {
  it('iterate() follows every page', async () => {
    const api = client({ perPage: 3 });
    const ids: number[] = [];
    for await (const fixture of api.iterate<{ id: number }>('/fixtures/upcoming')) ids.push(fixture.id);
    expect(ids.length).toBeGreaterThanOrEqual(7);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('all() collects a full listing', async () => {
    const api = client({ perPage: 5 });
    const all = await api.all<{ id: number }>('/fixtures/upcoming');
    expect(all.length).toBeGreaterThanOrEqual(7);
  });
});

describe('retry behaviour', () => {
  it('retries 429 and honours Retry-After', async () => {
    let hits = 0;
    const srv = http.createServer((_req, res) => {
      hits += 1;
      if (hits <= 2) {
        res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '0' });
        res.end(JSON.stringify({ ok: false, error: { code: 'RATE_LIMITED', message: 'slow down' } }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({ ok: true, data: [{ id: 1 }], pagination: { page: 1, per_page: 3, total: 1, total_pages: 1 } }),
      );
    });
    await new Promise<void>((resolve) => srv.listen(0, resolve));
    const port = (srv.address() as { port: number }).port;

    const attempts: number[] = [];
    const api = new FootballDataClient({
      baseUrl: `http://127.0.0.1:${port}`,
      apiKey: readerKey,
      maxRetries: 3,
      retryBaseMs: 10,
      onRetry: ({ attempt }) => attempts.push(attempt),
    });
    const result = await api.fixturesUpcoming();
    expect(result.data).toHaveLength(1);
    expect(hits).toBe(3);
    expect(attempts).toEqual([1, 2]);
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  });

  it('retries 5xx up to maxRetries, then throws ServerError', async () => {
    let hits = 0;
    const srv = http.createServer((_req, res) => {
      hits += 1;
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: { code: 'INTERNAL', message: 'boom' } }));
    });
    await new Promise<void>((resolve) => srv.listen(0, resolve));
    const port = (srv.address() as { port: number }).port;
    const api = new FootballDataClient({
      baseUrl: `http://127.0.0.1:${port}`,
      apiKey: readerKey,
      maxRetries: 2,
      retryBaseMs: 5,
    });
    await expect(api.fixturesUpcoming()).rejects.toBeInstanceOf(ServerError);
    expect(hits).toBe(3); // initial call + 2 retries
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  });

  it('never retries 401', async () => {
    let authHits = 0;
    const srv = http.createServer((_req, res) => {
      authHits += 1;
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: { code: 'UNAUTHORIZED', message: 'nope' } }));
    });
    await new Promise<void>((resolve) => srv.listen(0, resolve));
    const port = (srv.address() as { port: number }).port;
    const api = new FootballDataClient({
      baseUrl: `http://127.0.0.1:${port}`,
      apiKey: readerKey,
      maxRetries: 3,
      retryBaseMs: 5,
    });
    await expect(api.fixturesUpcoming()).rejects.toBeInstanceOf(AuthenticationError);
    expect(authHits).toBe(1);
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  });
});

describe('helpers', () => {
  it('coerces numeric strings but keeps dates and protected codes as strings', () => {
    const out = coerceNumbers(
      { id: '37', avg: '1.333', name: '2023/24', code: '007', nested: { n: '2' }, list: ['1', 'x'] },
      new Set(['code']),
    );
    expect(out).toEqual({ id: 37, avg: 1.333, name: '2023/24', code: '007', nested: { n: 2 }, list: [1, 'x'] });
  });

  it('redacts keys for logs', () => {
    expect(redactKey('pf_live_abcdef123456_supersecret')).toBe('pf_live_abcdef123456_****');
  });
});
