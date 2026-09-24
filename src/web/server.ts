/**
 * Website + admin UI server.
 *
 * - Serves the public website (fixtures, standings, teams, referees, predictions)
 *   and the admin API-key dashboard (/admin/api-keys).
 * - ALL football data comes from OUR REST API via a server-side proxy that
 *   attaches our own site API key. The browser never sees the provider key and
 *   never calls API-Football.
 */
import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { config, ensureSecretsForProduction } from '../config.js';
import { logger } from '../lib/logger.js';
import { createClient, createKey, listKeys } from '../keys/service.js';

// Where the website proxy finds OUR api. Defaults to the local API port;
// set API_INTERNAL_URL when the API runs as a separate host/service.
const API_BASE =
  process.env.API_INTERNAL_URL?.replace(/\/$/, '') || `http://127.0.0.1:${config.apiPort}`;

async function resolveSiteApiKey(): Promise<string> {
  if (process.env.SITE_API_KEY) return process.env.SITE_API_KEY;
  // Dev convenience: provision/reuse a Website client key once, stored outside git.
  const keyFile = path.resolve(process.cwd(), '.website-api-key');
  if (fs.existsSync(keyFile)) {
    const saved = fs.readFileSync(keyFile, 'utf8').trim();
    if (saved.startsWith('pf_live_')) return saved;
  }
  await createClient({ name: 'Website', description: 'Built-in website client (auto-provisioned)', clientType: 'website' }, 'web-boot');
  const created = await createKey(
    { clientName: 'Website', scopes: ['fixtures:read', 'teams:read', 'players:read', 'referees:read', 'standings:read', 'statistics:read', 'predictions:read'], label: 'site' },
    'web-boot',
  );
  fs.writeFileSync(keyFile, `${created.rawKey}\n`, { mode: 0o600 });
  logger.info({ keyPrefix: created.keyPrefix }, 'website API key provisioned (stored in .website-api-key, gitignored)');
  // sanity: ensure old keys still listed
  await listKeys();
  return created.rawKey;
}

async function main(): Promise<void> {
  ensureSecretsForProduction();
  const siteKey = await resolveSiteApiKey();
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '256kb' }));

  // ---- API proxy: browser → OUR API (site key injected server-side) -------
  app.use('/api', async (req, res) => {
    try {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      const incomingKey = req.header('x-api-key');
      const bearer = req.header('authorization');
      if (incomingKey) headers['x-api-key'] = incomingKey;
      else if (bearer) headers['authorization'] = bearer;
      else headers['x-api-key'] = siteKey;

      const target = `${API_BASE}/api${req.path}${req.path.includes('?') ? '' : req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : ''}`;
      const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : JSON.stringify(req.body ?? {});
      const response = await fetch(target, { method: req.method, headers, body });
      const text = await response.text();
      res.status(response.status);
      const retryAfter = response.headers.get('retry-after');
      if (retryAfter) res.setHeader('Retry-After', retryAfter);
      res.setHeader('content-type', response.headers.get('content-type') ?? 'application/json');
      res.send(text);
    } catch (err) {
      res.status(502).json({ ok: false, error: { code: 'API_UNAVAILABLE', message: `API unreachable: ${(err as Error).message}` } });
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
