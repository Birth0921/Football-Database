import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { verifyApiKey, type KeyVerification } from '../keys/service.js';
import { counterIncr } from '../redis/client.js';
import { query } from '../db/pool.js';
import { todayKey } from '../provider/quota.js';
import { config } from '../config.js';
import { logger } from '../logger.js';

const log = logger.child({ mod: 'api-auth' });

declare module 'fastify' {
  interface FastifyContextConfig {
    /** Required API-key scope for this route; undefined = public. */
    scope?: string;
  }
  interface FastifyRequest {
    apiKey?: KeyVerification;
  }
}

export interface ScopeRouteOptions {
  config?: { scope?: string };
}

function scopeMatches(granted: string[], required: string | undefined): boolean {
  if (!required) return true;
  return granted.includes('*') || granted.includes(required);
}

async function recordUsage(v: KeyVerification, endpoint: string, outcome: 'ok' | 'failed' | 'rate_limited'): Promise<void> {
  if (!v.keyId || !v.clientId) return;
  // fire-and-forget: usage tracking must never block or fail requests
  void query(
    `INSERT INTO api_usage (api_key_id, client_id, day, endpoint, requests, successful_requests, failed_requests, rate_limited_requests, last_used_at)
     VALUES ($1, $2, $3, $4, 1, $5, $6, $7, now())
     ON CONFLICT (api_key_id, day, endpoint) DO UPDATE SET
       requests = api_usage.requests + 1,
       successful_requests = api_usage.successful_requests + $5,
       failed_requests = api_usage.failed_requests + $6,
       rate_limited_requests = api_usage.rate_limited_requests + $7,
       last_used_at = now(), updated_at = now()`,
    [v.keyId, v.clientId, todayKey(), endpoint, outcome === 'ok' ? 1 : 0, outcome === 'failed' ? 1 : 0, outcome === 'rate_limited' ? 1 : 0],
  ).catch((err) => log.debug({ err: err.message }, 'usage recording failed'));
  void query(`UPDATE api_keys SET last_used_at = now() WHERE id = $1`, [v.keyId]).catch(() => {});
}

export function registerAuthPreHandler(app: FastifyInstance): void {
  app.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
    const scope = (reply.routeOptions?.config as { scope?: string } | undefined)?.scope;
    if (!scope) return; // public route (health/docs/root)
    const presented = req.headers['x-api-key'];
    const v = await verifyApiKey(typeof presented === 'string' ? presented : undefined);

    if (!v.ok) {
      await recordUsage(v, req.url, 'failed');
      const status = v.status === 'revoked' || v.status === 'expired' || v.status === 'client_disabled' ? 403 : 401;
      reply.code(status).send({
        success: false,
        error: { status, message: `API key rejected: ${v.status}`, reason: v.reason },
      });
      return reply;
    }

    if (!scopeMatches(v.scopes ?? [], scope)) {
      await recordUsage(v, req.url, 'failed');
      reply.code(403).send({
        success: false,
        error: { status: 403, message: `insufficient scope: requires '${scope}'` },
      });
      return reply;
    }

    // per-client rate limits (Redis-backed counters; fail-closed when Redis broken)
    const minuteCount = await counterIncr(`rl:${v.clientId}:m:${Math.floor(Date.now() / 60_000)}`, 60);
    const dayCount = await counterIncr(`rl:${v.clientId}:d:${todayKey()}`, 86_400);
    if (minuteCount > (v.rateLimitPerMinute ?? 120) || dayCount > (v.rateLimitPerDay ?? 50_000)) {
      await recordUsage(v, req.url, 'rate_limited');
      reply.code(429).send({
        success: false,
        error: { status: 429, message: 'rate limit exceeded for this API client' },
      });
      return reply;
    }

    req.apiKey = v;
    await recordUsage(v, req.url, 'ok');
  });
}

export function adminGuard(req: FastifyRequest, reply: FastifyReply): boolean {
  const token = req.headers['x-admin-token'] ?? (req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : undefined);
  if (!config.secrets.adminToken) {
    reply.code(503).send({ success: false, error: { status: 503, message: 'admin interface disabled: ADMIN_TOKEN not configured' } });
    return false;
  }
  if (typeof token !== 'string' || token !== config.secrets.adminToken) {
    reply.code(401).send({ success: false, error: { status: 401, message: 'admin token required (X-Admin-Token or Authorization: Bearer)' } });
    return false;
  }
  return true;
}
