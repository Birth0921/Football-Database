/**
 * Demo prediction app.
 *
 * This is deliberately a *server-side* app: the browser talks to this process,
 * and this process talks to the platform API with the `pf_live_…` key. The key
 * never reaches the browser, and the browser never needs CORS access to the API.
 *
 * Routes
 *   GET /                       UI
 *   GET /api/status             connection, model source, remaining quota
 *   GET /api/upcoming?limit=    scored upcoming fixtures
 *   GET /api/predict/:id        one fixture with the full score grid
 *
 * Run: npm install && cp .env.example .env && npm run dev
 */
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FootballDataClient,
  RateLimitError,
  redactKey,
} from '@football-data-platform/client';
import { loadConfig, loadDotEnv, requireApiConfig } from './config.js';
import { PredictionService } from './predict/index.js';
import { TrainedModel } from './predict/trained-model.js';

loadDotEnv();
const config = loadConfig();
requireApiConfig(config);

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(here, '../public');

const client = new FootballDataClient({
  baseUrl: config.apiBaseUrl,
  apiKey: config.apiKey,
  timeoutMs: 15_000,
  maxRetries: 3,
  perPage: 50,
  onRetry: ({ attempt, waitMs, error }) => {
    console.warn(`[api] retry ${attempt} in ${waitMs}ms — ${error.code}: ${error.message}`);
  },
});

const trainedModel = TrainedModel.load(config.modelPath);
const service = new PredictionService(client, {
  rho: 0,
  maxGoals: config.maxGoals,
  trainedWeight: config.trainedWeight,
  xgWeight: config.xgWeight,
  venueWeight: config.venueWeight,
  shrinkageK: config.shrinkageK,
  trainedModel,
});

console.log(`[app] platform API : ${config.apiBaseUrl}`);
console.log(`[app] api key      : ${redactKey(config.apiKey)}`);
console.log(`[app] trained model: ${trainedModel ? config.modelPath : 'none (feature-only mode)'}`);

// Tiny in-process cache: the platform already caches, this just protects the
// per-minute quota when several browser tabs are open.
const cache = new Map<string, { value: unknown; expires: number }>();
function cached<T>(key: string, ttlMs: number, producer: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return Promise.resolve(hit.value as T);
  return producer().then((value) => {
    cache.set(key, { value, expires: Date.now() + ttlMs });
    return value;
  });
}

const app = express();
app.disable('x-powered-by');

app.get('/api/status', async (_req, res) => {
  try {
    const [health, database, redis] = await Promise.all([
      client.health(),
      client.healthDatabase().catch(() => null),
      client.healthRedis().catch(() => null),
    ]);
    res.json({
      ok: true,
      api: { baseUrl: config.apiBaseUrl, providerMode: health.providerMode ?? null, key: redactKey(config.apiKey) },
      database: database ?? null,
      redis: redis ?? null,
      model: trainedModel
        ? { trained: true, generatedAt: trainedModel.file.generatedAt, competitions: Object.keys(trainedModel.file.competitions) }
        : { trained: false, note: 'run `npm run train` to fit team strengths on the read-only database' },
      rateLimit: client.rateLimit,
      scopes: 'fixtures:read, teams:read, players:read, referees:read, standings:read, statistics:read, predictions:read',
    });
  } catch (err) {
    res.status(502).json({ ok: false, error: { code: 'UPSTREAM', message: (err as Error).message } });
  }
});

app.get('/api/upcoming', async (req, res) => {
  const limit = Math.min(60, Math.max(1, Number(req.query.limit ?? config.defaultLimit) || config.defaultLimit));
  const competitionId = req.query.competition_id ? Number(req.query.competition_id) : undefined;
  const refresh = req.query.refresh === '1';
  const key = `upcoming:${limit}:${competitionId ?? 'all'}`;
  try {
    const batch = refresh
      ? await service.predictUpcoming({ limit, competitionId, concurrency: config.concurrency })
      : await cached(key, 60_000, () => service.predictUpcoming({ limit, competitionId, concurrency: config.concurrency }));
    res.json({ ok: true, ...batch });
  } catch (err) {
    const status = err instanceof RateLimitError ? 429 : 502;
    res.status(status).json({ ok: false, error: { code: (err as Error).name, message: (err as Error).message } });
  }
});

app.get('/api/predict/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: { code: 'VALIDATION', message: 'invalid fixture id' } });
  try {
    const prediction = await cached(`predict:${id}:v1`, 60_000, () => service.predictFixture(id));
    return res.json({ ok: true, data: prediction });
  } catch (err) {
    const status = err instanceof RateLimitError ? 429 : 502;
    return res.status(status).json({ ok: false, error: { code: (err as Error).name, message: (err as Error).message } });
  }
});

app.use(express.static(publicDir, { maxAge: '1h', index: 'index.html' }));

app.listen(config.port, config.host, () => {
  console.log(`[app] prediction UI on http://${config.host}:${config.port}`);
});
