/* Admin API-key dashboard.
   Authenticates with an admin token against OUR API (via the same-origin
   proxy). The browser never sees API-Football credentials, JWT secrets, or
   any managed Website key — rotation of the Website key happens entirely
   server-side and returns no secret. */
(() => {
  'use strict';

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  let token = sessionStorage.getItem('admin_token') || '';

  /* ---------------- helpers ---------------- */
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
  const fmt = (d) => (d ? new Date(d).toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' }) : '—');

  function toast(message, type = 'info') {
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.innerHTML = `<div>${esc(message)}</div>`;
    $('#toast-stack').appendChild(el);
    setTimeout(() => { el.classList.add('leaving'); setTimeout(() => el.remove(), 300); }, 4200);
  }

  async function api(path, opts = {}) {
    const res = await fetch(`/api/v1${path}`, {
      method: opts.method || 'GET',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const body = await res.json().catch(() => ({ ok: false }));
    if (!res.ok) throw new Error(body?.error?.message || `Request failed (HTTP ${res.status})`);
    return body;
  }

  function busy(btn, isBusy) {
    btn.disabled = isBusy;
    btn.classList.toggle('busy', Boolean(isBusy));
  }

  /* ---------------- confirm dialog (prefix only, never the full secret) ------ */
  let confirmResolve = null;
  function confirmDialog({ title, text, okLabel = 'Confirm', danger = false }) {
    $('#confirm-title').textContent = title;
    $('#confirm-text').textContent = text;
    const ok = $('#confirm-ok');
    ok.textContent = okLabel;
    ok.className = `btn ${danger ? 'btn-danger solid' : 'btn-primary'}`;
    $('#confirm-modal').showModal();
    return new Promise((resolve) => { confirmResolve = resolve; });
  }
  $('#confirm-ok').addEventListener('click', () => { $('#confirm-modal').close(); confirmResolve?.(true); });
  $('#confirm-cancel').addEventListener('click', () => { $('#confirm-modal').close(); confirmResolve?.(false); });
  $('#confirm-modal').addEventListener('cancel', (e) => { e.preventDefault(); $('#confirm-modal').close(); confirmResolve?.(false); });

  /* ---------------- one-time secret modal ---------------- */
  function showSecret(secret) {
    $('#secret-value').textContent = secret;
    $('#secret-modal').showModal();
  }
  $('#copy-secret').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText($('#secret-value').textContent); toast('Key copied to clipboard', 'success'); }
    catch { toast('Copy failed — select the key manually', 'error'); }
  });
  $('#close-secret').addEventListener('click', () => {
    $('#secret-value').textContent = ''; // never keep the secret around
    $('#secret-modal').close();
  });

  /* ---------------- login ---------------- */
  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#login-btn');
    busy(btn, true);
    $('#login-error').textContent = '';
    try {
      const body = await api('/admin/login', { method: 'POST', body: { username: $('#username').value, password: $('#password').value } });
      token = body.token;
      sessionStorage.setItem('admin_token', token);
      enterAdmin();
    } catch (err) {
      $('#login-error').textContent = err.message.includes('credentials') ? 'Invalid username or password.' : err.message;
    } finally {
      busy(btn, false);
    }
  });
  $('#logout-btn').addEventListener('click', () => {
    sessionStorage.removeItem('admin_token');
    token = '';
    location.reload();
  });

  function enterAdmin() {
    $('#login-view').hidden = true;
    $('#admin-view').hidden = false;
    $('#logout-btn').hidden = false;
    refresh();
  }

  /* ---------------- keys table ---------------- */
  function keyStatus(k) {
    if (k.revoked_at) return '<span class="status-pill revoked">revoked</span>';
    if (k.expires_at && new Date(k.expires_at) < new Date()) return '<span class="status-pill expired">expired</span>';
    return '<span class="status-pill active">active</span>';
  }

  function renderKeys(keys) {
    const wrap = $('#keys-wrap');
    if (!keys.length) {
      wrap.innerHTML = '<p class="panel-sub" style="padding:18px">No API keys yet — create one below.</p>';
      return;
    }
    wrap.innerHTML = `<table>
      <thead><tr>
        <th>Key</th><th>Client</th><th>Scopes</th><th>Created</th><th>Last used</th><th>Status</th><th>Actions</th>
      </tr></thead>
      <tbody>${keys.map((k) => {
        const isManaged = k.managed_role === 'website';
        const keyCell = isManaged
          ? `<span class="managed-chip">
               <span class="mc-title">Website</span>
               <span class="mc-sub">Read-only · Managed automatically</span>
             </span>`
          : `<code class="key-prefix">${esc(k.key_prefix)}…</code>${k.label ? `<div class="muted">${esc(k.label)}</div>` : ''}`;
        const actions = [];
        if (isManaged) {
          if (!k.revoked_at) {
            actions.push(`<button class="btn btn-sm" data-rotate-website="${k.id}" type="button">Rotate Key</button>`);
            actions.push(`<button class="btn btn-sm btn-danger" data-delete="${k.id}" data-prefix="${esc(k.key_prefix)}" type="button">Permanently Delete</button>`);
          }
        } else if (!k.revoked_at) {
          actions.push(`<button class="btn btn-sm" data-rotate="${k.id}" type="button">Rotate</button>`);
          actions.push(`<button class="btn btn-sm" data-revoke="${k.id}" type="button">Revoke</button>`);
          actions.push(`<button class="btn btn-sm btn-danger" data-delete="${k.id}" data-prefix="${esc(k.key_prefix)}" type="button">Permanently Delete</button>`);
        }
        return `<tr class="${isManaged ? 'managed-row' : ''}">
          <td>${keyCell}</td>
          <td>${esc(k.client_name ?? '')}</td>
          <td><span class="scopes">${(k.scopes || []).map((s) => `<span class="scope-chip">${esc(s)}</span>`).join('')}</span></td>
          <td>${fmt(k.created_at)}</td>
          <td>${fmt(k.last_used_at)}</td>
          <td>${keyStatus(k)}</td>
          <td><span class="actions-cell">${actions.join('') || '<span class="muted">—</span>'}</span></td>
        </tr>`;
      }).join('')}</tbody></table>`;

    $$('[data-rotate-website]', wrap).forEach((b) => b.addEventListener('click', () => rotateWebsiteKey(b)));
    $$('[data-rotate]', wrap).forEach((b) => b.addEventListener('click', () => rotateKey(b)));
    $$('[data-revoke]', wrap).forEach((b) => b.addEventListener('click', () => revokeKey(b)));
    $$('[data-delete]', wrap).forEach((b) => b.addEventListener('click', () => deleteKey(b)));
  }

  /* ---------------- actions ---------------- */
  async function rotateWebsiteKey(btn) {
    const ok = await confirmDialog({
      title: 'Rotate Website API key?',
      text: 'The system will create and verify a replacement key before removing the old one. ' +
        'The website keeps working throughout — no secret needs to be copied. This cannot be undone.',
      okLabel: 'Rotate key', danger: true,
    });
    if (!ok) return;
    busy(btn, true);
    try {
      await api(`/admin/api-keys/${btn.dataset.rotateWebsite}/rotate-website`, { method: 'POST', body: {} });
      toast('Website key rotated — the new key is already active', 'success');
      await refresh();
    } catch (err) {
      toast(`Rotation failed: ${err.message} — the existing key is untouched`, 'error');
    } finally {
      busy(btn, false);
    }
  }

  async function rotateKey(btn) {
    const ok = await confirmDialog({
      title: 'Rotate this API key?',
      text: 'A replacement key will be created and shown once. The old key stays valid for a 24-hour grace period.',
      okLabel: 'Rotate key',
    });
    if (!ok) return;
    busy(btn, true);
    try {
      const body = await api(`/admin/api-keys/${btn.dataset.rotate}/rotate`, { method: 'POST', body: { grace_hours: 24 } });
      showSecret(body.data.api_key); // ONE TIME only
      toast('Key rotated — save the new key now', 'success');
      await refresh();
    } catch (err) {
      toast(`Rotation failed: ${err.message}`, 'error');
    } finally {
      busy(btn, false);
    }
  }

  async function revokeKey(btn) {
    const ok = await confirmDialog({
      title: 'Revoke this API key?',
      text: 'The key stops authenticating immediately. This can be undone by creating a new key.',
      okLabel: 'Revoke', danger: true,
    });
    if (!ok) return;
    busy(btn, true);
    try {
      await api(`/admin/api-keys/${btn.dataset.revoke}/revoke`, { method: 'POST', body: { reason: 'revoked via admin UI' } });
      toast('Key revoked', 'success');
      await refresh();
    } catch (err) {
      toast(`Revoke failed: ${err.message}`, 'error');
    } finally {
      busy(btn, false);
    }
  }

  async function deleteKey(btn) {
    const prefix = btn.dataset.prefix || '';
    const ok = await confirmDialog({
      title: 'Permanently delete this API key?',
      text: `${prefix}… will be removed forever. It stops authenticating immediately and cannot be recovered.`,
      okLabel: 'Delete permanently', danger: true,
    });
    if (!ok) return;
    busy(btn, true);
    try {
      const body = await api(`/admin/api-keys/${btn.dataset.delete}`, { method: 'DELETE' });
      toast(body.data?.deleted ? 'API key permanently deleted' : 'Key was already gone', 'success');
      await refresh();
    } catch (err) {
      toast(`Delete failed: ${err.message}`, 'error');
    } finally {
      busy(btn, false);
    }
  }

  /* ---------------- forms ---------------- */
  $('#client-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#client-create');
    busy(btn, true);
    try {
      await api('/admin/clients', {
        method: 'POST',
        body: {
          name: $('#client-name').value.trim(),
          client_type: $('#client-type').value.trim() || undefined,
          rate_limit_per_minute: Number($('#client-rlm').value || 60),
          rate_limit_per_day: Number($('#client-rld').value || 10000),
        },
      });
      toast('Client created', 'success');
      $('#client-name').value = '';
      await refresh();
    } catch (err) {
      toast(`Create failed: ${err.message}`, 'error');
    } finally {
      busy(btn, false);
    }
  });

  $('#key-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#key-create');
    const scopes = $$('#scope-box input:checked').map((i) => i.value);
    if (!scopes.length) { toast('Select at least one scope', 'error'); return; }
    if (!$('#key-client').value) { toast('Select a client first', 'error'); return; }
    busy(btn, true);
    try {
      const body = await api('/admin/api-keys', {
        method: 'POST',
        body: {
          client_id: Number($('#key-client').value),
          scopes,
          label: $('#key-label').value.trim() || undefined,
          expires_in_days: $('#key-expires').value ? Number($('#key-expires').value) : null,
        },
      });
      showSecret(body.data.api_key); // ONE TIME only
      toast('API key created — save it now', 'success');
      await refresh();
    } catch (err) {
      toast(`Create failed: ${err.message}`, 'error');
    } finally {
      busy(btn, false);
    }
  });

  /* ---------------- refresh ---------------- */
  async function refresh() {
    const btn = $('#refresh-btn');
    busy(btn, true);
    $('#keys-wrap').innerHTML = '<div style="padding:18px"><div class="skel-line" style="width:55%"></div><div class="skel-line" style="width:40%;margin-top:10px"></div><div class="skel-line" style="width:65%;margin-top:10px"></div></div>';
    try {
      const body = await api('/admin/api-keys');
      const { keys, clients, scopes } = body.data;
      $('#key-client').innerHTML = '<option value="">Select client…</option>' +
        clients.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
      $('#scope-box').innerHTML = scopes.map((s) =>
        `<label><input type="checkbox" value="${s}" ${s.endsWith(':read') && s !== 'admin:read' ? 'checked' : ''}/> ${s}</label>`).join('');
      renderKeys(keys);

      const usage = await api('/admin/usage');
      $('#usage-wrap').innerHTML = `<table>
        <thead><tr><th>Date</th><th>Client</th><th>Endpoint</th><th>Requests</th><th>2xx</th><th>Failed</th><th>Rate-limited</th></tr></thead>
        <tbody>${(usage.data || []).map((u) => `<tr>
          <td>${esc(u.date)}</td><td>${esc(u.client_name ?? '—')}</td><td><code class="key-prefix">${esc(u.endpoint)}</code></td>
          <td>${u.requests ?? 0}</td><td>${u.successful_requests ?? 0}</td><td>${u.failed_requests ?? 0}</td><td>${u.rate_limited_requests ?? 0}</td>
        </tr>`).join('') || '<tr><td colspan="7" class="muted" style="padding:16px">No usage recorded yet.</td></tr>'}</tbody></table>`;
    } catch (err) {
      $('#keys-wrap').innerHTML = `<p class="panel-sub" style="padding:18px" role="alert">Could not load API keys: ${esc(err.message)}</p>`;
    } finally {
      busy(btn, false);
    }
  }
  $('#refresh-btn').addEventListener('click', () => refresh());

  /* ---------------- boot ---------------- */
  if (token) {
    api('/admin/api-keys').then(enterAdmin).catch(() => {
      sessionStorage.removeItem('admin_token');
      token = '';
    });
  }
})();
