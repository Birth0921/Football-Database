import { Redis } from 'ioredis';
import { config } from '../config.js';
import { logger } from '../logger.js';

const log = logger.child({ mod: 'redis' });

let client: Redis | null = null;
let available: boolean | null = null;

/** Lazy singleton. Returns null when Redis is unreachable so callers can fall back to DB. */
export function getRedis(): Redis | null {
  if (client) return client;
  try {
    client = new Redis(config.redis.url, {
      lazyConnect: true,
      maxRetriesPerRequest: 2,
      enableOfflineQueue: false,
    });
    client.on('error', (err) => {
      if (available !== false) log.warn({ err: err.message }, 'redis error');
      available = false;
    });
    client.on('ready', () => {
      available = true;
      log.info('redis connected');
    });
    void client.connect().catch((err) => {
      available = false;
      log.warn({ err: err.message }, 'redis connect failed — running without cache');
    });
    return client;
  } catch (err) {
    available = false;
    log.warn({ err: err instanceof Error ? err.message : err }, 'redis init failed');
    return null;
  }
}

export async function redisPing(): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
  const start = Date.now();
  const redis = getRedis();
  if (!redis) return { ok: false, latencyMs: Date.now() - start, error: 'redis client unavailable' };
  try {
    if (redis.status !== 'ready') {
      // wait (bounded) for the lazy connection to establish
      await new Promise<void>((resolve) => {
        const onReady = () => { cleanup(); resolve(); };
        const cleanup = () => { redis.off('ready', onReady); clearTimeout(timer); };
        const timer = setTimeout(() => { cleanup(); resolve(); }, 2500);
        redis.once('ready', onReady);
      });
    }
    const pong = await redis.ping();
    available = true;
    return { ok: pong === 'PONG', latencyMs: Date.now() - start };
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - start, error: err instanceof Error ? err.message : String(err) };
  }
}

export function redisAvailable(): boolean | null {
  return available;
}

// ---------- JSON cache helpers (PostgreSQL remains the source of truth) ----------

export async function cacheGetJson<T>(key: string): Promise<T | null> {
  const redis = getRedis();
  if (!redis) return null;
  try {
    const raw = await redis.get(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export async function cacheSetJson(key: string, value: unknown, ttlSeconds: number): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  try {
    await redis.set(key, JSON.stringify(value), 'EX', Math.max(1, Math.floor(ttlSeconds)));
  } catch (err) {
    log.debug({ err: err instanceof Error ? err.message : err }, 'cache set failed');
  }
}

export async function cacheDel(...keys: string[]): Promise<void> {
  const redis = getRedis();
  if (!redis || keys.length === 0) return;
  try {
    await redis.del(...keys);
  } catch {
    /* non-fatal */
  }
}

export async function cacheDelPattern(pattern: string): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  try {
    let cursor = '0';
    do {
      const [next, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
      cursor = next;
      if (keys.length) await redis.del(...keys);
    } while (cursor !== '0');
  } catch {
    /* non-fatal */
  }
}

/** Fixed-window counter; returns current count. */
export async function counterIncr(key: string, windowSeconds: number): Promise<number> {
  const redis = getRedis();
  if (!redis) return 0;
  try {
    const n = await redis.incr(key);
    if (n === 1) await redis.expire(key, windowSeconds);
    return n;
  } catch {
    return Number.MAX_SAFE_INTEGER; // fail closed if redis broken
  }
}

export async function counterGet(key: string): Promise<number> {
  const redis = getRedis();
  if (!redis) return 0;
  try {
    const n = await redis.get(key);
    return n ? parseInt(n, 10) : 0;
  } catch {
    return 0;
  }
}

/** Best-effort distributed lock. */
export async function acquireLock(key: string, ttlSeconds: number): Promise<boolean> {
  const redis = getRedis();
  if (!redis) return true; // single-node fallback: always allow
  try {
    const ok = await redis.set(key, String(process.pid), 'EX', ttlSeconds, 'NX');
    return ok === 'OK';
  } catch {
    return true;
  }
}

export async function releaseLock(key: string): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  try {
    await redis.del(key);
  } catch {
    /* ignore */
  }
}
