/**
 * Website + admin UI server.
 *
 * - Serves the public website (fixtures, standings, teams, referees, predictions)
 *   and the admin API-key dashboard (/admin/api-keys).
 * - ALL football data comes from OUR REST API via a server-side proxy.
 *   The browser never sees any credential and never calls API-Football.
 * - The proxy authenticates with the MANAGED WEBSITE KEY: exactly one
 *   auto-provisioned, read-only key (see src/keys/website-key.ts). The raw
 *   key lives only server-side (encrypted at rest); it is NOT regenerated on
 *   restart, and it is never hardcoded in the frontend.
 * - Self-healing: if the managed key is missing/revoked/deleted (e.g. an
 *   admin deleted it), the proxy detects the auth failure, provisions a
 *   replacement (advisory-locked, verified) and retries once — no manual
 *   secret copying, no infinite loops.
 */
import express from 'express';
import path from 'node:path';
import { config, ensureSecretsForProduction } from '../config.js';
import { logger } from '../lib/logger.js';
import { ensureWebsiteKey, resolveWebsiteKey, type ResolvedWebsiteKey } from '../keys/website-key.js';

// Where the website proxy finds OUR api. Defaults to the local API port;
// set API_INTERNAL_URL when the API runs as a separate host/service.
const API_BASE =
  process.env.API_INTERNAL_URL?.replace(/\/$/, '') || `http://127.0.0.1:${config.apiPort}`;

// ---------------------------------------------------------------------------
// Managed Website key resolution (server-side only)
// ---------------------------------------------------------------------------
let cachedSiteKey: ResolvedWebsiteKey | null = null;
let lastEnsureAttempt = 0;
const ENSURE_THROTTLE_MS = 10_000; // safety valve: never hammer provisioning

async function getSiteKey(): Promise<ResolvedWebsiteKey> {
  // explicit override for operators (static, never in the frontend)
  if (process.env.SITE_API_KEY) {
    return { record: { id: -1 } as never, rawKey: process.env.SITE_API_KEY };
  }
  if (cachedSiteKey) return cachedSiteKey;
  const resolved = await resolveWebsiteKey();
  if (resolved) {
    cachedSiteKey = resolved;
    return resolved;
  }
  const now = Date.now();
  if (now - lastEnsureAttempt < ENSURE_THROTTLE_MS) {
    throw new Error('website key provisioning throttled (recent attempt failed)');
  }
  lastEnsureAttempt = now;
  cachedSiteKey = await ensureWebsiteKey('web-proxy');
  return cachedSiteKey;
}

function invalidateSiteKey(): void {
  cachedSiteKey = null;
}

async function main(): Promise<void> {
  ensureSecretsForProduction();
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '256kb' }));

  // Provision/verify the managed Website key at startup (no rotation, ever).
  if (!process.env.SITE_API_KEY) {
    try {
      const key = await ensureWebsiteKey('web-boot');
      logger.info({ keyId: key.record.id, keyPrefix: key.record.key_prefix }, 'managed website key ready');
    } catch (err) {
      // non-fatal: the proxy provisions lazily when the credential is required
      logger.warn({ err: (err as Error).message }, 'website key not ready at boot (will provision on demand)');
    }
  }

  // ---- API proxy: browser → OUR API (managed key attached server-side) ----
  app.use('/api', async (req, res) => {
    const sendJson = (code: number, body: unknown) => {
      res.status(code).setHeader('content-type', 'application/json');
      res.send(typeof body === 'string' ? body : JSON.stringify(body));
    };
    try {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      const incomingKey = req.header('x-api-key');
      const bearer = req.header('authorization');
      let usedManagedKey = false;
      if (incomingKey) headers['x-api-key'] = incomingKey;
      else if (bearer) headers['authorization'] = bearer;
      else {
        // anonymous website traffic → managed key, with self-healing recovery
        let siteKey: ResolvedWebsiteKey;
        try {
          siteKey = await getSiteKey();
        } catch {
          sendJson(502, { ok: false, error: { code: 'SITE_CREDENTIAL_UNAVAILABLE', message: 'The data service credential is temporarily unavailable. Please try again shortly.' } });
          return;
        }
        headers['x-api-key'] = siteKey.rawKey;
        usedManagedKey = true;
      }

      const qs = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
      const target = `${API_BASE}/api${req.path}${qs}`;
      const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : JSON.stringify(req.body ?? {});

      let response = await fetch(target, { method: req.method, headers, body });

      // Self-healing: managed key rejected (deleted/revoked/rotated elsewhere)
      // → provision a replacement (verified) and retry ONCE.
      if (response.status === 401 && usedManagedKey) {
        invalidateSiteKey();
        try {
          const fresh = await getSiteKey();
          headers['x-api-key'] = fresh.rawKey;
          response = await fetch(target, { method: req.method, headers, body });
        } catch {
          sendJson(502, { ok: false, error: { code: 'SITE_CREDENTIAL_UNAVAILABLE', message: 'The data service credential is temporarily unavailable. Please try again shortly.' } });
          return;
        }
      }

      const text = await response.text();
      res.status(response.status);
      const retryAfter = response.headers.get('retry-after');
      if (retryAfter) res.setHeader('Retry-After', retryAfter);
      res.setHeader('content-type', response.headers.get('content-type') ?? 'application/json');
      res.send(text);
    } catch (err) {
      res.status(502).json({ ok: false, error: { code: 'API_UNAVAILABLE', message: 'API unreachable — please try again.' } });
    }
  });

  const staticDir = path.resolve(process.cwd(), 'src/web/public');
  app.use('/admin', express.static(path.join(staticDir, 'admin')));
  app.use(express.static(staticDir));
  app.get('/', (_req, res) => res.sendFile(path.join(staticDir, 'index.html')));
  app.get('/admin', (_req, res) => res.redirect('/admin/'));
  app.get('/admin/api-keys', (_req, res) => res.sendFile(path.join(staticDir, 'admin', 'index.html')));

  app.listen(config.webPort, config.apiHost, () => {
    // eslint-disable-next-line no-console
    console.log(`Website listening on http://${config.apiHost}:${config.webPort} (admin at /admin/api-keys)`);
    logger.info({ port: config.webPort }, 'web server listening');
  });
}

main().catch((err) => {
  logger.error({ err }, 'web server failed to start');
  process.exit(1);
});
