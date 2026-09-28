/** API middleware: our own API-key auth, admin JWT auth, error handling. */
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import crypto from 'node:crypto';
import { config } from '../config.js';
import {
  authenticateApiKey, checkRateLimit, recordUsage, touchKeyUsage,
  type KeyRecord,
} from '../keys/service.js';
import { AppError, ForbiddenError, TooManyRequestsError, UnauthorizedError } from '../types.js';
import { logger } from '../lib/logger.js';

declare module 'express-serve-static-core' {
  interface Request {
    apiKeyRecord?: KeyRecord;
  }
}

function asyncHandler(fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}
export { asyncHandler };

/** Public routes (no API key): health + docs + admin password login. Everything else needs X-API-Key.
 * NOTE: paths here are router-relative (the middleware runs inside the /api/v1 router). */
const PUBLIC_PATHS = new Set([
  '/health', '/health/database', '/health/redis', '/health/provider',
  '/health/data', '/openapi.json', '/docs', '/admin/login',
]);

export function apiKeyAuth(scopeFor: (req: Request) => string | undefined): RequestHandler {
  return asyncHandler(async (req, res, next) => {
    const path = req.path.replace(/\/$/, '') || '/';
    if (PUBLIC_PATHS.has(path)) return next();

    // Admin routes may authenticate with an admin Bearer token instead of an API key
    const hasBearer = (req.header('authorization') ?? '').startsWith('Bearer ');
    if (path.startsWith('/admin') && hasBearer && !req.header('x-api-key')) return next();

    const rawKey = String(req.header('x-api-key') ?? '');
    if (!rawKey) return next(new UnauthorizedError('missing X-API-Key header'));

    const result = await authenticateApiKey(rawKey, scopeFor(req));
    if (!result.ok || !result.key) {
      await recordUsage({ apiKeyId: null, clientId: null, endpoint: req.path, success: false, rateLimited: false });
      logger.warn({ path: req.path, reason: result.reason }, 'api key rejected');
      return next(new UnauthorizedError(`invalid api key${result.reason ? ` (${result.reason})` : ''}`));
    }
    if (result.scopeOk === false) {
      await recordUsage({ apiKeyId: result.key.id, clientId: result.key.client_id, endpoint: req.path, success: false, rateLimited: false });
      return next(new ForbiddenError(`missing required scope for ${req.method} ${req.path}`));
    }

    const rl = await checkRateLimit(result.key);
    if (!rl.allowed) {
      await recordUsage({ apiKeyId: result.key.id, clientId: result.key.client_id, endpoint: req.path, success: false, rateLimited: true });
      res.setHeader('Retry-After', String(rl.retryAfterSeconds));
      return next(new TooManyRequestsError(`rate limit exceeded — retry in ${rl.retryAfterSeconds}s`));
    }

    req.apiKeyRecord = result.key;
    await touchKeyUsage(result.key.id);
    res.setHeader('X-RateLimit-Remaining-Minute', String(Math.max(0, (result.key.rate_limit_per_minute ?? 60) - rl.perMinute)));
    res.setHeader('X-RateLimit-Remaining-Day', String(Math.max(0, (result.key.rate_limit_per_day ?? 10000) - rl.perDay)));
    next();
  });
}

export function recordUsageAfter(): RequestHandler {
  return (req, res, next) => {
    res.on('finish', () => {
      const key = req.apiKeyRecord;
      if (!key) return;
      void recordUsage({
        apiKeyId: key.id,
        clientId: key.client_id,
        endpoint: req.path,
        success: res.statusCode < 400,
        rateLimited: res.statusCode === 429,
      });
    });
    next();
  };
}

// ---------------------------------------------------------------------------
// Admin auth — HMAC-signed stateless token (JWT-like) + constant-time compare
// ---------------------------------------------------------------------------
export interface AdminClaims {
  sub: string;
  exp: number;
}

function signAdmin(claims: AdminClaims): string {
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const sig = crypto.createHmac('sha256', config.jwtSecret || 'dev-secret').update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function verifyAdminToken(token: string): AdminClaims | null {
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = crypto.createHmac('sha256', config.jwtSecret || 'dev-secret').update(body).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const claims = JSON.parse(Buffer.from(body, 'base64url').toString()) as AdminClaims;
    if (claims.exp < Date.now()) return null;
    return claims;
  } catch {
    return null;
  }
}

export function adminLoginHandler(): RequestHandler {
  return asyncHandler(async (req, res) => {
    const { username, password } = (req.body ?? {}) as { username?: string; password?: string };
    const userOk = username === config.adminUser;
    const passBuf = Buffer.from(password ?? '');
    const expected = Buffer.from(config.adminPassword);
    const passOk = passBuf.length === expected.length && crypto.timingSafeEqual(passBuf, expected);
    if (!userOk || !passOk || !config.adminPassword) {
      throw new UnauthorizedError('invalid admin credentials');
    }
    const claims: AdminClaims = { sub: config.adminUser, exp: Date.now() + 12 * 36e5 };
    res.json({ ok: true, token: signAdmin(claims), expiresAt: new Date(claims.exp).toISOString() });
  });
}

export function requireAdmin(): RequestHandler {
  return asyncHandler(async (req, res, next) => {
    // API-key with admin:write scope may also administer (for CLI-issued keys)
    const key = req.apiKeyRecord;
    if (key && ((key.scopes ?? []).includes('admin:write') || (key.scopes ?? []).includes('admin:read'))) {
      return next();
    }
    const auth = req.header('authorization') ?? '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : String(req.header('x-admin-token') ?? '');
    const claims = token ? verifyAdminToken(token) : null;
    if (!claims) return next(new UnauthorizedError('admin authentication required'));
    next();
  });
}

// ---------------------------------------------------------------------------
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  const e = err instanceof AppError ? err : null;
  const status = e?.statusCode ?? 500;
  const message = e ? e.message : 'internal server error';
  if (!e) logger.error({ err: String((err as Error)?.stack ?? err), path: req.path }, 'unhandled API error');
  res.status(status).json({
    ok: false,
    error: { code: e?.code ?? 'INTERNAL', message, details: e?.details ?? undefined },
  });
}

export function pagination(req: Request): { page: number; perPage: number; offset: number } {
  const page = Math.max(1, Number(req.query.page ?? 1) || 1);
  const perPage = Math.min(100, Math.max(1, Number(req.query.per_page ?? 25) || 25));
  return { page, perPage, offset: (page - 1) * perPage };
}

export function paginated<T>(data: T[], total: number, page: number, perPage: number) {
  return {
    ok: true,
    data,
    pagination: { page, per_page: perPage, total, total_pages: Math.max(1, Math.ceil(total / perPage)) },
  };
}
