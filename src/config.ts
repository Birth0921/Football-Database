import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  // Our API
  API_PORT: z.coerce.number().int().default(3000),
  API_HOST: z.string().default('0.0.0.0'),
  API_BASE_URL: z.string().default('http://localhost:3000'),
  DEFAULT_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().default(120),
  DEFAULT_RATE_LIMIT_PER_DAY: z.coerce.number().int().default(50000),

  // Secrets
  ADMIN_TOKEN: z.string().optional(),
  API_KEY_PEPPER: z.string().optional(),
  JWT_SECRET: z.string().optional(),

  // Provider
  API_FOOTBALL_KEY: z.string().optional(),
  API_FOOTBALL_BASE_URL: z.string().default('https://v3.football.api-sports.io'),
  PROVIDER_DAILY_LIMIT: z.coerce.number().int().default(75000),
  PROVIDER_MINUTE_LIMIT: z.coerce.number().int().default(500),
  PROVIDER_MAX_RPS: z.coerce.number().default(3),

  // Datastores
  DATABASE_URL: z.string().default('postgresql://postgres:postgres@localhost:5432/football'),
  REDIS_URL: z.string().default('redis://localhost:6379'),

  // Import scope
  IMPORT_LEAGUE_IDS: z.string().default(''),
  IMPORT_PREVIOUS_SEASONS: z.coerce.number().int().min(0).max(10).default(3),
  HISTORICAL_DETAIL_SEASONS: z.coerce.number().int().min(0).max(10).default(2),

  // Workers
  SYNC_INLINE: z
    .string()
    .default('true')
    .transform((v) => v !== 'false' && v !== '0'),
  WORKER_CONCURRENCY: z.coerce.number().int().default(4),
  LIVE_POLL_SECONDS: z.coerce.number().int().default(60),
  SCHEDULER_ENABLED: z
    .string()
    .default('true')
    .transform((v) => v !== 'false' && v !== '0'),

  LOG_LEVEL: z.string().default('info'),
  NODE_ENV: z.string().default('development'),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error('Invalid environment configuration:', parsed.error.flatten());
  process.exit(1);
}

const env = parsed.data;

export const config = {
  api: {
    port: env.API_PORT,
    host: env.API_HOST,
    baseUrl: env.API_BASE_URL.replace(/\/$/, ''),
    defaultRateLimitPerMinute: env.DEFAULT_RATE_LIMIT_PER_MINUTE,
    defaultRateLimitPerDay: env.DEFAULT_RATE_LIMIT_PER_DAY,
  },
  secrets: {
    adminToken: env.ADMIN_TOKEN,
    apiPepper: env.API_KEY_PEPPER || env.JWT_SECRET || env.ADMIN_TOKEN || '',
    jwtSecret: env.JWT_SECRET || env.ADMIN_TOKEN || '',
  },
  provider: {
    key: env.API_FOOTBALL_KEY || '',
    baseUrl: env.API_FOOTBALL_BASE_URL.replace(/\/$/, ''),
    dailyLimit: env.PROVIDER_DAILY_LIMIT,
    minuteLimit: env.PROVIDER_MINUTE_LIMIT,
    maxRps: env.PROVIDER_MAX_RPS,
  },
  db: {
    url: env.DATABASE_URL,
  },
  redis: {
    url: env.REDIS_URL,
  },
  import: {
    leagueIds: env.IMPORT_LEAGUE_IDS
      ? env.IMPORT_LEAGUE_IDS.split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => Number.isFinite(n))
      : [],
    previousSeasons: env.IMPORT_PREVIOUS_SEASONS,
    historicalDetailSeasons: env.HISTORICAL_DETAIL_SEASONS,
  },
  workers: {
    syncInline: env.SYNC_INLINE,
    concurrency: env.WORKER_CONCURRENCY,
    livePollSeconds: env.LIVE_POLL_SECONDS,
    schedulerEnabled: env.SCHEDULER_ENABLED,
  },
  logLevel: env.LOG_LEVEL,
  isProd: env.NODE_ENV === 'production',
} as const;

/** All secrets that must never leak into logs/responses. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const secret of [config.provider.key, config.secrets.adminToken, config.secrets.apiPepper, config.secrets.jwtSecret]) {
    if (secret && secret.length >= 8) {
      out = out.split(secret).join('***REDACTED***');
    }
  }
  return out;
}
