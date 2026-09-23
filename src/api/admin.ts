import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { query } from '../db/pool.js';
import { ok, fail, parsePaging, pageInfo } from '../util/http.js';
import { toCamel, toCamelList } from './shape.js';
import { adminGuard } from './auth.js';
import { createApiKey, revokeApiKey, rotateApiKey, ALL_SCOPES, purgeExpiredGraceKeys } from '../keys/service.js';
import { config } from '../config.js';
import { syncStats, failedTasks, retryFailedTasks } from '../sync/tasksDb.js';

export function registerAdminRoutes(app: FastifyInstance): void {
  const guard = async (req: FastifyRequest, reply: FastifyReply) => {
    adminGuard(req, reply);
  };

  // ---------------- clients ----------------
  app.get('/admin/clients', { preHandler: guard, config: { scope: undefined } }, async () => {
    const { rows } = await query<Record<string, unknown>>(
      `SELECT c.*, count(k.id) FILTER (WHERE k.revoked_at IS NULL OR k.revoked_at > now()) AS active_keys
       FROM api_clients c LEFT JOIN api_keys k ON k.client_id = c.id
       GROUP BY c.id ORDER BY c.id`,
    );
    return ok(toCamelList(rows));
  });

  app.post('/admin/clients', { preHandler: guard, config: { scope: undefined } }, async (req, reply) => {
    const b = req.body as { name?: string; description?: string; clientType?: string; rateLimitPerMinute?: number; rateLimitPerDay?: number };
    if (!b?.name) return fail(400, 'name is required');
    const { rows } = await query<Record<string, unknown>>(
      `INSERT INTO api_clients (name, description, client_type, rate_limit_per_minute, rate_limit_per_day)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [
        b.name,
        b.description ?? null,
        b.clientType ?? 'other',
        b.rateLimitPerMinute ?? config.api.defaultRateLimitPerMinute,
        b.rateLimitPerDay ?? config.api.defaultRateLimitPerDay,
      ],
    );
    reply.code(201);
    return ok(toCamel(rows[0]));
  });

  app.patch('/admin/clients/:id', { preHandler: guard, config: { scope: undefined } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = req.body as { active?: boolean; rateLimitPerMinute?: number; rateLimitPerDay?: number; description?: string };
    const { rows } = await query<Record<string, unknown>>(
      `UPDATE api_clients SET
         active = COALESCE($2, active),
         rate_limit_per_minute = COALESCE($3, rate_limit_per_minute),
         rate_limit_per_day = COALESCE($4, rate_limit_per_day),
         description = COALESCE($5, description),
         updated_at = now()
       WHERE id = $1 RETURNING *`,
      [Number(id), b.active ?? null, b.rateLimitPerMinute ?? null, b.rateLimitPerDay ?? null, b.description ?? null],
    );
    if (!rows[0]) return fail(404, 'client not found');
    return ok(toCamel(rows[0]));
  });

  // ---------------- keys ----------------
  app.get('/admin/api-keys', { preHandler: guard, config: { scope: undefined } }, async (req) => {
    const { page, perPage, offset } = parsePaging(req.query as Record<string, unknown>);
    const { rows } = await query<Record<string, unknown>>(
      `SELECT k.id, k.client_id, k.key_prefix, k.scopes, k.created_at, k.last_used_at, k.expires_at,
              k.revoked_at, k.revoked_reason, k.grace_expires_at, k.rotation_of_key_id,
              c.name AS client_name, c.client_type
       FROM api_keys k JOIN api_clients c ON c.id = k.client_id
       ORDER BY k.created_at DESC LIMIT $1 OFFSET $2`,
      [perPage, offset],
    );
    const total = (await query<{ n: string }>(`SELECT count(*)::text AS n FROM api_keys`)).rows[0].n;
    return ok(toCamelList(rows), { pagination: pageInfo(page, perPage, parseInt(total, 10)), scopes: ALL_SCOPES });
  });

  app.post('/admin/api-keys', { preHandler: guard, config: { scope: undefined } }, async (req, reply) => {
    const b = req.body as { clientId?: number; clientName?: string; scopes?: string[]; expiresInDays?: number };
    if (!b?.scopes?.length) return fail(400, 'scopes are required', { available: ALL_SCOPES });
    const invalid = b.scopes.filter((s) => !(ALL_SCOPES as readonly string[]).includes(s) && s !== '*');
    if (invalid.length) return fail(400, `unknown scopes: ${invalid.join(', ')}`, { available: ALL_SCOPES });

    let clientId = b.clientId;
    if (!clientId && b.clientName) {
      clientId = (await query<{ id: number }>(`SELECT id FROM api_clients WHERE lower(name) = lower($1)`, [b.clientName])).rows[0]?.id;
    }
    if (!clientId) return fail(404, 'client not found — pass clientId or clientName');
    const client = (await query<{ active: boolean }>(`SELECT active FROM api_clients WHERE id = $1`, [clientId])).rows[0];
    if (!client) return fail(404, 'client not found');
    if (!client.active) return fail(400, 'client is disabled — enable it first');

    const created = await createApiKey({ clientId, scopes: b.scopes, expiresInDays: b.expiresInDays });
    reply.code(201);
    return ok({
      keyId: created.keyId,
      apiKey: created.fullKey, // shown ONCE — never stored in plaintext
      prefix: created.prefix,
      scopes: created.scopes,
      expiresAt: created.expiresAt,
      warning: 'Save this key now. It will not be displayed again.',
    });
  });

  app.post('/admin/api-keys/:id/rotate', { preHandler: guard, config: { scope: undefined } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as { graceHours?: number };
    try {
      const created = await rotateApiKey(Number(id), b.graceHours ?? 24);
      reply.code(201);
      return ok({
        keyId: created.keyId,
        apiKey: created.fullKey,
        prefix: created.prefix,
        scopes: created.scopes,
        graceHours: b.graceHours ?? 24,
        warning: 'Save this key now. It will not be displayed again. Old key remains valid for the grace period.',
      });
    } catch (err) {
      return fail(404, err instanceof Error ? err.message : 'rotation failed');
    }
  });

  app.post('/admin/api-keys/:id/revoke', { preHandler: guard, config: { scope: undefined } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as { reason?: string };
    await revokeApiKey(Number(id), b.reason);
    return ok({ revoked: true, keyId: Number(id) });
  });

  // ---------------- usage ----------------
  app.get('/admin/usage', { preHandler: guard, config: { scope: undefined } }, async (req) => {
    const q = req.query as Record<string, unknown>;
    const days = Math.min(90, Math.max(1, Number(q.days ?? 7)));
    const { rows } = await query<Record<string, unknown>>(
      `SELECT c.name AS client, u.day, sum(u.requests)::int AS requests,
              sum(u.successful_requests)::int AS successful, sum(u.failed_requests)::int AS failed,
              sum(u.rate_limited_requests)::int AS rate_limited
       FROM api_usage u JOIN api_clients c ON c.id = u.client_id
       WHERE u.day >= current_date - ($1::int - 1)
       GROUP BY c.name, u.day ORDER BY u.day DESC, requests DESC`,
      [days],
    );
    const perClient = (
      await query<Record<string, unknown>>(
        `SELECT c.name AS client, sum(u.requests)::int AS requests, max(u.last_used_at) AS last_used
         FROM api_usage u JOIN api_clients c ON c.id = u.client_id
         WHERE u.day >= current_date - ($1::int - 1) GROUP BY c.name ORDER BY requests DESC`,
        [days],
      )
    ).rows;
    return ok({ perDay: toCamelList(rows), perClient: toCamelList(perClient), windowDays: days });
  });

  // ---------------- platform ops ----------------
  app.get('/admin/sync', { preHandler: guard, config: { scope: undefined } }, async () => {
    const stats = await syncStats();
    const failed = await failedTasks(20);
    return ok({
      stats,
      failed: failed.map((f) => ({
        id: f.id, type: f.task_type, attempts: f.attempts, maxAttempts: f.max_attempts,
        error: f.last_error, scheduledAt: f.scheduled_at, payload: f.payload,
      })),
    });
  });

  app.post('/admin/sync/retry-failed', { preHandler: guard, config: { scope: undefined } }, async () => {
    const n = await retryFailedTasks();
    const purged = await purgeExpiredGraceKeys();
    return ok({ retried: n, purgedGraceKeys: purged });
  });

  // ---------------- admin HTML UI ----------------
  app.get('/admin/api-keys/ui', { config: { scope: undefined } }, async (_req, reply) => {
    reply.type('text/html');
    return adminUiHtml();
  });
}

function adminUiHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Football Platform — API Keys</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { font-family: ui-sans-serif, system-ui, sans-serif; background:#0b1020; color:#e7ecf5; margin:0; padding:24px; }
  h1 { font-size: 1.4rem; margin: 0 0 4px; }
  .sub { color:#8fa0bf; margin-bottom:20px; font-size: .9rem; }
  .card { background:#121a30; border:1px solid #22304f; border-radius:12px; padding:16px; margin-bottom:16px; }
  .row { display:flex; gap:12px; flex-wrap:wrap; align-items:flex-end; }
  label { display:block; font-size:.75rem; color:#8fa0bf; margin-bottom:4px; text-transform:uppercase; letter-spacing:.05em; }
  input, select { background:#0b1020; border:1px solid #2c3c61; color:#e7ecf5; border-radius:8px; padding:8px 10px; min-width:180px; }
  button { background:#2563eb; border:none; color:white; padding:9px 14px; border-radius:8px; cursor:pointer; font-weight:600; }
  button.secondary { background:#1e293b; }
  button.danger { background:#dc2626; }
  table { width:100%; border-collapse:collapse; font-size:.85rem; }
  th, td { text-align:left; padding:8px 10px; border-bottom:1px solid #1d2a47; vertical-align:top; }
  th { color:#8fa0bf; font-weight:600; text-transform:uppercase; font-size:.7rem; letter-spacing:.05em; }
  .pill { display:inline-block; padding:2px 8px; border-radius:999px; font-size:.7rem; font-weight:700; }
  .pill.active { background:#052e16; color:#4ade80; }
  .pill.revoked { background:#450a0a; color:#f87171; }
  .pill.grace { background:#422006; color:#fbbf24; }
  .secret { font-family: ui-monospace, monospace; background:#052e16; border:1px solid #16a34a; color:#4ade80; padding:10px; border-radius:8px; word-break: break-all; }
  .warn { color:#fbbf24; font-size:.8rem; margin-top:6px; }
  .scopes { color:#8fa0bf; font-size:.75rem; }
  #msg { margin-top:10px; font-size:.85rem; }
  .err { color:#f87171; } .okc { color:#4ade80; }
</style>
</head>
<body>
<h1>🔑 API Key Management</h1>
<div class="sub">Football Data Platform · Admin</div>

<div class="card">
  <label>Admin token</label>
  <div class="row">
    <input id="token" type="password" placeholder="ADMIN_TOKEN" style="min-width:320px">
    <button class="secondary" onclick="loadAll()">Connect</button>
  </div>
  <div id="msg"></div>
</div>

<div class="card">
  <h2 style="font-size:1rem;margin:0 0 12px">Create API key</h2>
  <div class="row">
    <div><label>Client</label><select id="client"></select></div>
    <div><label>Scopes (ctrl-click multi)</label><select id="scopes" multiple size="5">
      <option value="fixtures:read">fixtures:read</option><option value="teams:read">teams:read</option>
      <option value="players:read">players:read</option><option value="referees:read">referees:read</option>
      <option value="standings:read">standings:read</option><option value="statistics:read">statistics:read</option>
      <option value="predictions:read">predictions:read</option>
    </select></div>
    <div><label>Expires (days, blank=never)</label><input id="exp" type="number" min="1" style="width:120px"></div>
    <button onclick="createKey()">Generate key</button>
  </div>
  <div id="secret"></div>
</div>

<div class="card">
  <h2 style="font-size:1rem;margin:0 0 12px">Clients</h2>
  <div class="row" style="margin-bottom:10px">
    <input id="newClientName" placeholder="New client name e.g. Prediction App">
    <select id="newClientType"><option>prediction_app</option><option>website</option><option>mobile_app</option><option>internal_service</option><option>other</option></select>
    <button onclick="createClient()">Create client</button>
  </div>
  <table id="clientsTable"><thead><tr><th>ID</th><th>Name</th><th>Type</th><th>Active</th><th>Rates</th><th>Active keys</th><th></th></tr></thead><tbody></tbody></table>
</div>

<div class="card">
  <h2 style="font-size:1rem;margin:0 0 12px">API keys</h2>
  <table id="keysTable"><thead><tr><th>ID</th><th>Client</th><th>Prefix</th><th>Scopes</th><th>Status</th><th>Created</th><th>Last used</th><th>Expires</th><th></th></tr></thead><tbody></tbody></table>
</div>

<script>
let TOKEN = sessionStorage.getItem('adminToken') || '';
function h(s){ return String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
async function api(path, opts={}) {
  const res = await fetch(path, { ...opts, headers: { 'content-type':'application/json', 'x-admin-token': TOKEN, ...(opts.headers||{}) } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error?.message || res.statusText);
  return body.data;
}
function msg(t, cls='okc'){ document.getElementById('msg').innerHTML = '<span class="'+cls+'">'+h(t)+'</span>'; }
async function loadAll(){
  TOKEN = document.getElementById('token').value.trim() || TOKEN;
  sessionStorage.setItem('adminToken', TOKEN);
  try {
    const clients = await api('/admin/clients');
    const cs = document.getElementById('client'); cs.innerHTML = clients.map(c=>'<option value="'+c.id+'">'+h(c.name)+'</option>').join('');
    document.querySelector('#clientsTable tbody').innerHTML = clients.map(c =>
      '<tr><td>'+c.id+'</td><td>'+h(c.name)+'</td><td>'+h(c.clientType)+'</td>'+
      '<td><span class="pill '+(c.active?'active':'revoked')+'">'+(c.active?'active':'disabled')+'</span></td>'+
      '<td>'+c.rateLimitPerMinute+'/min · '+c.rateLimitPerDay+'/day</td><td>'+c.activeKeys+'</td>'+
      '<td><button class="secondary" onclick="toggleClient('+c.id+','+(!c.active)+')">'+(c.active?'Disable':'Enable')+'</button></td></tr>').join('');
    const keys = await api('/admin/api-keys?perPage=100');
    document.querySelector('#keysTable tbody').innerHTML = keys.map(k => {
      const status = k.revokedAt ? (k.graceExpiresAt && new Date(k.revokedAt) > new Date() ? '<span class="pill grace">grace</span>' : '<span class="pill revoked">revoked</span>') : '<span class="pill active">active</span>';
      return '<tr><td>'+k.id+'</td><td>'+h(k.clientName)+'</td><td><code>'+h(k.keyPrefix)+'…</code></td>'+
        '<td class="scopes">'+h((k.scopes||[]).join(', '))+'</td><td>'+status+'</td>'+
        '<td>'+(k.createdAt||'').slice(0,10)+'</td><td>'+(k.lastUsedAt? k.lastUsedAt.slice(0,16).replace('T',' ') : 'never')+'</td>'+
        '<td>'+(k.expiresAt? k.expiresAt.slice(0,10) : 'never')+'</td>'+
        '<td><button class="secondary" onclick="rotate('+k.id+')">Rotate</button> <button class="danger" onclick="revoke('+k.id+')">Revoke</button></td></tr>';
    }).join('');
    msg('Connected.');
  } catch(e){ msg(e.message, 'err'); }
}
async function createClient(){
  try {
    const name = document.getElementById('newClientName').value.trim();
    const type = document.getElementById('newClientType').value;
    if (!name) return msg('Client name required', 'err');
    await api('/admin/clients', { method:'POST', body: JSON.stringify({ name, clientType: type }) });
    document.getElementById('newClientName').value='';
    loadAll();
  } catch(e){ msg(e.message, 'err'); }
}
async function toggleClient(id, active){
  try { await api('/admin/clients/'+id, { method:'PATCH', body: JSON.stringify({ active }) }); loadAll(); } catch(e){ msg(e.message, 'err'); }
}
async function createKey(){
  try {
    const clientId = Number(document.getElementById('client').value);
    const scopes = [...document.getElementById('scopes').selectedOptions].map(o=>o.value);
    const expiresInDays = document.getElementById('exp').value ? Number(document.getElementById('exp').value) : undefined;
    const res = await api('/admin/api-keys', { method:'POST', body: JSON.stringify({ clientId, scopes, expiresInDays }) });
    document.getElementById('secret').innerHTML = '<div class="secret">'+h(res.apiKey)+'</div><div class="warn">⚠️ '+h(res.warning)+'</div>';
    loadAll();
  } catch(e){ msg(e.message, 'err'); }
}
async function rotate(id){
  try {
    const res = await api('/admin/api-keys/'+id+'/rotate', { method:'POST', body: JSON.stringify({ graceHours: 24 }) });
    document.getElementById('secret').innerHTML = '<div class="secret">'+h(res.apiKey)+'</div><div class="warn">⚠️ '+h(res.warning)+'</div>';
    loadAll();
  } catch(e){ msg(e.message, 'err'); }
}
async function revoke(id){
  try { await api('/admin/api-keys/'+id+'/revoke', { method:'POST', body: JSON.stringify({ reason:'manual revocation from admin UI' }) }); loadAll(); } catch(e){ msg(e.message, 'err'); }
}
if (TOKEN) { document.getElementById('token').value = TOKEN; setTimeout(loadAll, 0); }
</script>
</body>
</html>`;
}
