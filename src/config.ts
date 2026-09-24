import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/** Minimal .env loader (no dependency) — existing env vars always win. */
function loadDotEnv(): void {
  const p = path.resolve(process.cwd(), '.env');
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const key = m[1];
    let val = m[2];
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}
loadDotEnv();

function num(name: string, def: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

function str(name: string, def: string): string {
  const v = process.env[name];
  return v === undefined || v === '' ? def : v;
}

function bool(name: string, def: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

export const config = {
  nodeEnv: str('NODE_ENV', 'development'),
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://postgres:password@127.0.0.1:5432/football',
  redisUrl: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379',
  apiPort: num('API_PORT', 4000),
  apiHost: str('API_HOST', '0.0.0.0'),
  webPort: num('WEB_PORT', 8080),
  publicBaseUrl: str('PUBLIC_BASE_URL', 'http://localhost:4000'),
  jwtSecret: str('JWT_SECRET', ''),
  adminUser: str('ADMIN_USER', 'admin'),
  adminPassword: str('ADMIN_PASSWORD', ''),
  apiFootballKey: process.env.API_FOOTBALL_KEY ?? '',
  apiFootballBaseUrl: str('API_FOOTBALL_BASE_URL', 'https://v3.football.api-sports.io'),
  providerDailyQuota: num('PROVIDER_DAILY_QUOTA', 75000),
  providerMinuteLimit: num('PROVIDER_MINUTE_LIMIT', 300),
  historicalSeasonsBack: num('HISTORICAL_SEASONS_BACK', 3),
  syncLiveIntervalSeconds: num('SYNC_LIVE_INTERVAL_SECONDS', 60),
  syncUpcomingIntervalSeconds: num('SYNC_UPCOMING_INTERVAL_SECONDS', 900),
  syncPostmatchIntervalSeconds: num('SYNC_POSTMATCH_INTERVAL_SECONDS', 300),
  syncMetadataIntervalSeconds: num('SYNC_METADATA_INTERVAL_SECONDS', 21600),
  replayFromRaw: bool('REPLAY_FROM_RAW', true),
  logLevel: str('LOG_LEVEL', 'info'),
  get providerMode(): 'live' | 'mock' {
    return this.apiFootballKey.length > 0 ? 'live' : 'mock';
  },
};

/** Secrets that must never appear in logs, payloads, or responses. */
export const SECRET_VALUES: string[] = [
  config.apiFootballKey,
  config.jwtSecret,
  config.adminPassword,
].filter((s): s is string => Boolean(s && s.length >= 6));

export function redactSecrets(text: string): string {
  let out = text;
  for (const s of SECRET_VALUES) out = out.split(s).join('***REDACTED***');
  return out;
}

export function ensureSecretsForProduction(): void {
  const problems: string[] = [];
  if (config.nodeEnv === 'production') {
    if (config.jwtSecret.length < 16) problems.push('JWT_SECRET must be set (>=16 chars)');
    if (config.adminPassword.length < 8) problems.push('ADMIN_PASSWORD must be set (>=8 chars)');
    if (!process.env.DATABASE_URL) problems.push('DATABASE_URL must be set');
    if (!process.env.REDIS_URL) problems.push('REDIS_URL must be set');
  }
  if (problems.length) {
    throw new Error(`Configuration invalid:\n- ${problems.join('\n- ')}`);
  }
}

export function randomSecret(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('hex');
}
