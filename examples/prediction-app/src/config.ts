/**
 * Configuration for the demo prediction app.
 *
 * Only two variables are required to run: the base URL of your platform API and
 * a platform-issued API key. The database variable is optional and only used by
 * `npm run train` (read-only role).
 */
import fs from 'node:fs';
import path from 'node:path';

/** Minimal .env loader so the demo runs without extra dependencies. */
export function loadDotEnv(cwd = process.cwd()): void {
  const file = path.resolve(cwd, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) continue;
    let value = rawValue.trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

export interface AppConfig {
  port: number;
  host: string;
  apiBaseUrl: string;
  apiKey: string;
  modelPath: string;
  trainDatabaseUrl: string | null;
  rho: number;
  maxGoals: number;
  trainedWeight: number;
  xgWeight: number;
  venueWeight: number;
  shrinkageK: number;
  concurrency: number;
  defaultLimit: number;
  refreshSeconds: number;
}

function num(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): AppConfig {
  return {
    port: num(env, 'PORT', 3000),
    host: env.HOST ?? '0.0.0.0',
    apiBaseUrl: (env.FOOTBALL_API_BASE_URL ?? 'http://localhost:4000/api/v1').replace(/\/+$/, ''),
    apiKey: env.FOOTBALL_API_KEY ?? '',
    modelPath: path.resolve(cwd, env.PREDICTION_MODEL_PATH ?? 'model/poisson-model.json'),
    trainDatabaseUrl: env.TRAIN_DATABASE_URL?.trim() ? env.TRAIN_DATABASE_URL : null,
    rho: num(env, 'PREDICTION_RHO', 0),
    maxGoals: num(env, 'PREDICTION_MAX_GOALS', 10),
    trainedWeight: num(env, 'PREDICTION_TRAINED_WEIGHT', 0.5),
    xgWeight: num(env, 'PREDICTION_XG_WEIGHT', 0.5),
    venueWeight: num(env, 'PREDICTION_VENUE_WEIGHT', 0.35),
    shrinkageK: num(env, 'PREDICTION_SHRINKAGE_K', 6),
    concurrency: num(env, 'PREDICTION_CONCURRENCY', 4),
    defaultLimit: num(env, 'PREDICTION_DEFAULT_LIMIT', 24),
    refreshSeconds: num(env, 'PREDICTION_REFRESH_SECONDS', 300),
  };
}

export function requireApiConfig(config: AppConfig): void {
  const problems: string[] = [];
  if (!config.apiBaseUrl) problems.push('FOOTBALL_API_BASE_URL is not set');
  if (!config.apiKey) problems.push('FOOTBALL_API_KEY is not set (create one with: npm run api-key:create)');
  if (config.apiKey && !config.apiKey.startsWith('pf_live_')) {
    problems.push('FOOTBALL_API_KEY does not look like a platform key (expected pf_live_…)');
  }
  if (process.env.API_FOOTBALL_KEY) {
    problems.push('API_FOOTBALL_KEY is set in this process — the prediction app must never hold the provider key');
  }
  if (problems.length) {
    throw new Error(`Prediction app configuration invalid:\n- ${problems.join('\n- ')}`);
  }
}
