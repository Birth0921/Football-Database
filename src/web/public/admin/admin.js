/* Admin API-key dashboard. Uses admin token against OUR API (via proxy). */
const $ = (s) => document.querySelector(s);
let token = sessionStorage.getItem('admin_token') || '';

async function api(path, opts = {}) {
  const res = await fetch(`/api/v1${path}`, {
    method: opts.method || 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const body = await res.json().catch(() => ({ ok: false }));
  if (!res.ok) throw new Error(body?.error?.message || `HTTP ${res.status}`);
  return body;
}

function showSecret(secret) {
  $('#secret-value').textContent = secret;
  $('#secret-modal').classList.add('show');
}
$('#copy-secret').addEventListener('click', () => navigator.clipboard.writeText($('#secret-value').textContent));
$('#close-secret').addEventListener('click', () => {
  $('#secret-value').textContent = ''; // never keep the secret around
  $('#secret-modal').classList.remove('show');
});

$('#login-btn').addEventListener('click', async () => {
  try {
    const body = await api('/admin/login', { method: 'POST', body: { username: $('#username').value, password: $('#password').value } });
    token = body.token;
    sessionStorage.setItem('admin_token', token);
    enterAdmin();
  } catch (err) {
    $('#login-error').textContent = err.message;
  }
});

function enterAdmin() {
  $('#login-view').style.display = 'none';
  $('#admin-view').style.display = 'block';
  refresh();
}

async function refresh() {
  const body = await api('/admin/api-keys');
  const { keys, clients, scopes } = body.data;
  $('#key-client').innerHTML = '<option value="">Select client…</option>' +
    clients.map((c) => `<option value="${c.id}">${c.name}</option>`).join('');
  $('#scope-box').innerHTML = scopes.map((s) =>
    `<label><input type="checkbox" value="${s}" ${s.endsWith(':read') && s !== 'admin:read' ? 'checked' : ''}/> ${s}</label>`).join('');
  $('#keys-table tbody').innerHTML = keys.map((k) => {
    const status = k.revoked_at ? `<span class="danger">revoked</span>` : k.expires_at && new Date(k.expires_at) < new Date() ? 'expired' : '<span class="ok">active</span>';
    return `<tr>
      <td><code>${k.key_prefix}</code></td><td>${k.client_name ?? ''}</td>
      <td class="muted">${(k.scopes || []).join(', ')}</td>
      <td>${fmt(k.created_at)}</td><td>${fmt(k.last_used_at)}</td><td>${fmt(k.expires_at)}</td>
      <td>${status}</td>
      <td class="row">
        ${k.revoked_at ? '' : `<button data-rotate="${k.id}">Rotate</button><button class="danger" data-revoke="${k.id}">Revoke</button>`}
      </td></tr>`;
  }).join('');
  $$('[data-rotate]').forEach((b) => b.addEventListener('click', () => rotateKey(b.dataset.rotate)));
  $$('[data-revoke]').forEach((b) => b.addEventListener('click', () => revokeKey(b.dataset.revoke)));

  const usage = await api('/admin/usage');
  $('#usage-table tbody').innerHTML = usage.data.map((u) => `<tr>
    <td>${u.date}</td><td>${u.client_name ?? ''}</td><td><code>${u.endpoint}</code></td>
    <td>${u.requests}</td><td>${u.successful_requests}</td><td>${u.failed_requests}</td><td>${u.rate_limited_requests}</td></tr>`).join('') ||
    '<tr><td colspan="7">No usage recorded yet.</td></tr>';
}

const $$ = (s) => [...document.querySelectorAll(s)];
const fmt = (d) => (d ? new Date(d).toLocaleString() : '—');

$('#client-create').addEventListener('click', async () => {
  try {
    await api('/admin/clients', { method: 'POST', body: {
      name: $('#client-name').value.trim(),
      client_type: $('#client-type').value.trim(),
      rate_limit_per_minute: Number($('#client-rlm').value || 60),
      rate_limit_per_day: Number($('#client-rld').value || 10000),
    } });
    refresh();
  } catch (err) { alert(err.message); }
});

$('#key-create').addEventListener('click', async () => {
  try {
    const scopes = $$('#scope-box input:checked').map((i) => i.value);
    const body = await api('/admin/api-keys', { method: 'POST', body: {
      client_id: Number($('#key-client').value),
      scopes,
      label: $('#key-label').value.trim() || undefined,
      expires_in_days: $('#key-expires').value ? Number($('#key-expires').value) : null,
    } });
    showSecret(body.data.api_key); // ONE TIME only
    refresh();
  } catch (err) { alert(err.message); }
});

async function rotateKey(id) {
  if (!confirm('Rotate this key? The old key stays valid for a 24h grace period.')) return;
  try {
    const body = await api(`/admin/api-keys/${id}/rotate`, { method: 'POST', body: { grace_hours: 24 } });
    showSecret(body.data.api_key);
    refresh();
  } catch (err) { alert(err.message); }
}

async function revokeKey(id) {
  if (!confirm('Revoke this key immediately?')) return;
  try {
    await api(`/admin/api-keys/${id}/revoke`, { method: 'POST', body: { reason: 'revoked via admin UI' } });
    refresh();
  } catch (err) { alert(err.message); }
}

document.querySelector('nav button').addEventListener('click', () => { location.href = '/'; });

if (token) {
  api('/admin/api-keys').then(enterAdmin).catch(() => { sessionStorage.removeItem('admin_token'); token = ''; });
}
