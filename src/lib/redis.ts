import { Redis } from 'ioredis';
import type { Redis as RedisClient } from 'ioredis';
import { config } from '../config.js';
import { logger } from './logger.js';

let redis: RedisClient | null = null;

export function getRedis(): RedisClient {
  if (!redis) {
    redis = new Redis(config.redisUrl, {
      maxRetriesPerRequest: 3,
      lazyConnect: false,
      enableReadyCheck: true,
    });
    redis.on('error', (err: Error) => logger.warn({ err: err.message }, 'redis error'));
  }
  return redis;
}

export async function redisPing(): Promise<boolean> {
  try {
    const pong = await getRedis().ping();
    return pong === 'PONG';
  } catch {
    return false;
  }
}

export async function closeRedis(): Promise<void> {
  if (redis) {
    await redis.quit().catch(() => undefined);
    redis = null;
  }
}

/** Try redis; on failure fall back to DB/degraded behavior. */
export async function safeRedis<T>(fn: (r: RedisClient) => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn(getRedis());
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'redis unavailable, using fallback');
    return fallback;
  }
}
