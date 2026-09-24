import { getRedis, safeRedis } from './redis.js';
import { logger } from './logger.js';

export const CACHE_TTL = {
  liveFixtures: 30,
  upcomingFixtures: 300,
  fixtureDetail: 120,
  standings: 600,
  teamStats: 900,
  playerStats: 900,
  refereeStats: 900,
  competitionStats: 900,
  predictionFeatures: 300,
  lists: 600,
  health: 15,
} as const;

const DISABLED = process.env.CACHE_DISABLED === 'true';

export async function cacheGet<T>(key: string): Promise<T | null> {
  if (DISABLED) return null;
  return safeRedis(async (r) => {
    const raw = await r.get(key);
    return raw ? (JSON.parse(raw) as T) : null;
  }, null);
}

export async function cacheSet(key: string, value: unknown, ttlSeconds: number): Promise<void> {
  if (DISABLED) return;
  await safeRedis(async (r) => {
    await r.set(key, JSON.stringify(value), 'EX', ttlSeconds);
    return null;
  }, null);
}

export async function cacheDel(...keys: string[]): Promise<void> {
  if (DISABLED || keys.length === 0) return;
  await safeRedis(async (r) => {
    await r.del(...keys);
    return null;
  }, null);
}

export async function cacheDelPattern(...patterns: string[]): Promise<void> {
  if (DISABLED) return;
  await safeRedis(async (r) => {
    for (const pattern of patterns) {
      const stream = r.scanStream({ match: pattern, count: 200 });
      const keys: string[] = [];
      for await (const batch of stream) keys.push(...(batch as string[]));
      if (keys.length) await r.del(...keys);
    }
    return null;
  }, null);
}

/** Invalidate cache entries affected by fixture / stat updates. */
export async function invalidateFixture(fixtureId: number): Promise<void> {
  await cacheDelPattern(
    'fdp:fixtures:*',
    'fdp:standings:*',
    'fdp:teams:*',
    'fdp:players:*',
    'fdp:referees:*',
    'fdp:competitions:*',
    `fdp:predictions:${fixtureId}`,
  );
  logger.debug({ fixtureId }, 'cache invalidated');
}

export const cacheKeys = {
  fixturesList: (filters: Record<string, unknown>) => `fdp:fixtures:list:${JSON.stringify(filters)}`,
  fixture: (id: number) => `fdp:fixtures:${id}`,
  fixtureEvents: (id: number) => `fdp:fixtures:${id}:events`,
  fixtureStats: (id: number) => `fdp:fixtures:${id}:stats`,
  fixtureLineups: (id: number) => `fdp:fixtures:${id}:lineups`,
  fixturePlayers: (id: number) => `fdp:fixtures:${id}:players`,
  standings: (f: Record<string, unknown>) => `fdp:standings:${JSON.stringify(f)}`,
  team: (id: number) => `fdp:teams:${id}`,
  teamStats: (id: number) => `fdp:teams:${id}:stats`,
  player: (id: number) => `fdp:players:${id}`,
  playerStats: (id: number) => `fdp:players:${id}:stats`,
  referee: (id: number) => `fdp:referees:${id}`,
  refereeStats: (id: number) => `fdp:referees:${id}:stats`,
  competitions: () => `fdp:competitions:list`,
  competition: (id: number) => `fdp:competitions:${id}`,
  competitionStats: (id: number) => `fdp:competitions:${id}:stats`,
  prediction: (fixtureId: number) => `fdp:predictions:${fixtureId}`,
  live: () => `fdp:fixtures:live`,
  upcoming: () => `fdp:fixtures:upcoming`,
  finished: (day: string) => `fdp:fixtures:finished:${day}`,
};
