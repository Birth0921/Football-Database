/* Football Data Platform — public website.
   Vanilla JS, no dependencies. Consumes OUR API only, via the same-origin
   proxy (/api/v1) — the browser holds NO API key and never calls the
   external provider. */
(() => {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  const LIVE = ['1H', 'HT', '2H', 'ET', 'BT', 'P', 'INT'];
  const FINISHED = ['FT', 'AET', 'PEN'];

  /* ---------------- helpers ---------------- */
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));

  function toast(message, type = 'info') {
    const stack = $('#toast-stack');
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.innerHTML = `<div class="toast-msg">${esc(message)}</div>`;
    stack.appendChild(el);
    setTimeout(() => {
      el.classList.add('leaving');
      setTimeout(() => el.remove(), 300);
    }, 4200);
  }

  async function api(path) {
    let res;
    try {
      res = await fetch(`/api/v1${path}`, { headers: { Accept: 'application/json' } });
    } catch {
      throw new Error('Network error — could not reach the data service.');
    }
    const body = await res.json().catch(() => ({ ok: false }));
    if (!res.ok) throw new Error(body?.error?.message || `Request failed (HTTP ${res.status})`);
    return body;
  }

  const skeleton = (n = 4) => $('#tpl-skeleton-card').innerHTML.repeat(n);

  function stateCard({ icon = '📋', title, message, retry, cls = '' }) {
    return `<div class="state-card ${cls}" role="status">
      <div class="state-icon" aria-hidden="true">${icon}</div>
      <h3>${esc(title)}</h3>
      <p>${esc(message)}</p>
      ${retry ? '<button class="btn" data-retry type="button">Retry</button>' : ''}
    </div>`;
  }

  function bindRetry(container, fn) {
    $$('[data-retry]', container).forEach((btn) => btn.addEventListener('click', () => fn()));
  }

  function teamLogo(name, logo) {
    if (logo) {
      const initials = esc(String(name ?? '?').split(/\s+/).map((w) => w[0]).join('').slice(0, 3).toUpperCase());
      return `<img class="team-logo" src="${esc(logo)}" alt="" loading="lazy"
        onerror="this.outerHTML='<span class=\\'team-logo-fallback\\'>${initials}</span>'" />`;
    }
    const initials = esc(String(name ?? '?').split(/\s+/).map((w) => w[0]).join('').slice(0, 3).toUpperCase() || '?');
    return `<span class="team-logo-fallback" aria-hidden="true">${initials}</span>`;
  }

  function fmtKickoff(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    const today = new Date();
    const sameDay = d.toDateString() === today.toDateString();
    const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (sameDay) return `Today · ${time}`;
    const tomorrow = new Date(today); tomorrow.setDate(today.getDate() + 1);
    if (d.toDateString() === tomorrow.toDateString()) return `Tomorrow · ${time}`;
    return `${d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })} · ${time}`;
  }

  /* ---------------- fixtures ---------------- */
  let fixtureSegment = 'live';

  function fixtureCard(f) {
    const isLive = LIVE.includes(f.status_short);
    const isFinished = FINISHED.includes(f.status_short);
    const hasScore = f.home_score != null || f.away_score != null;
    const homeWins = isFinished && f.home_score != null && f.away_score != null && f.home_score > f.away_score;
    const awayWins = isFinished && f.home_score != null && f.away_score != null && f.away_score > f.home_score;
    const statusLabel = isLive
      ? `LIVE${f.status_elapsed ? ` ${f.status_elapsed}'` : ''}`
      : isFinished ? (f.status_short === 'FT' ? 'FULL TIME' : f.status_short) : 'UPCOMING';

    const teamRow = (side, name, logo, score, winner) => `
      <div class="fixture-team ${winner ? 'is-winner' : ''}">
        ${teamLogo(name, logo)}
        <span class="t-name">${esc(name ?? 'TBD')}</span>
        ${hasScore ? `<span class="t-score">${score ?? '–'}</span>` : ''}
      </div>`;

    return `<article class="fixture-card ${isLive ? 'is-live' : ''}">
      <div class="fixture-meta">
        <span class="fixture-comp" title="${esc(f.competition_name ?? '')}${f.season_name ? ` · ${esc(f.season_name)}` : ''}">
          <span aria-hidden="true">🏆</span> <span class="comp-name">${esc(f.competition_name ?? 'Competition')}</span>
        </span>
        <span class="badge ${isLive ? 'live' : isFinished ? 'ft' : 'ns'}">${esc(statusLabel)}</span>
      </div>
      <div class="fixture-teams">
        ${teamRow('home', f.home_team_name, f.home_team_logo, f.home_score, homeWins)}
        ${hasScore ? '' : '<div class="fixture-vs">VS</div>'}
        ${teamRow('away', f.away_team_name, f.away_team_logo, f.away_score, awayWins)}
      </div>
      <div class="fixture-foot">
        <span class="kickoff">${isLive ? '<span class="live-dot" style="background:var(--danger);display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:6px;animation:pulse 1.6s ease infinite"></span>' : '🕒 '}${esc(fmtKickoff(f.kickoff_utc))}</span>
        <span>${f.venue_name ? `📍 ${esc(f.venue_name)}` : ''}</span>
      </div>
    </article>`;
  }

  async function loadFixtures({ silent = false } = {}) {
    const list = $('#fixture-list');
    const refreshBtn = $('#fixtures-refresh');
    if (!silent) list.innerHTML = skeleton(6);
    refreshBtn.classList.add('busy');
    refreshBtn.disabled = true;
    try {
      let data;
      if (fixtureSegment === 'live') data = (await api('/fixtures/live')).data ?? [];
      else if (fixtureSegment === 'upcoming') data = (await api('/fixtures/upcoming?per_page=18')).data ?? [];
      else data = (await api('/fixtures/finished?per_page=18')).data ?? [];

      if (!data.length) {
        const msgs = {
          live: 'There are currently no matches being played.',
          upcoming: 'There are currently no upcoming fixtures scheduled.',
          finished: 'No finished fixtures for today yet.',
        };
        list.innerHTML = stateCard({ icon: '⚽', title: 'No fixtures available', message: msgs[fixtureSegment] });
      } else {
        list.innerHTML = data.map(fixtureCard).join('');
      }
    } catch (err) {
      if (!silent) {
        list.innerHTML = stateCard({
          icon: '⚠️', cls: 'error',
          title: 'Unable to load fixtures',
          message: "We're having trouble connecting to the data service. Please try again.",
          retry: true,
        });
        bindRetry(list, () => loadFixtures());
      }
    } finally {
      refreshBtn.classList.remove('busy');
      refreshBtn.disabled = false;
    }
  }

  $$('#fixture-toggle .seg-btn').forEach((btn) => btn.addEventListener('click', () => {
    fixtureSegment = btn.dataset.seg;
    $$('#fixture-toggle .seg-btn').forEach((b) => {
      const active = b === btn;
      b.classList.toggle('active', active);
      b.setAttribute('aria-selected', String(active));
    });
    loadFixtures();
  }));
  $('#fixtures-refresh').addEventListener('click', () => {
    loadFixtures();
    toast('Fixtures refreshed', 'success');
  });

  /* ---------------- hero status ---------------- */
  async function loadStatus() {
    const dot = $('#status-dot');
    const text = $('#status-text');
    try {
      const [health, dataHealth] = await Promise.all([
        api('/health').catch(() => null),
        api('/health/data').catch(() => null),
      ]);
      if (!health) throw new Error();
      const mode = health.providerMode === 'live' ? 'live provider' : 'mock data mode';
      const checks = dataHealth?.summary;
      const quality = checks ? ` · ${checks.passed}/${checks.passed + checks.failed} quality checks` : '';
      dot.className = 'status-dot ok';
      text.textContent = `Data service online · ${mode}${quality}`;
    } catch {
      dot.className = 'status-dot err';
      text.textContent = 'Data service unreachable — retrying shortly';
    }
  }

  /* ---------------- competitions ---------------- */
  async function loadCompetitions() {
    const wrap = $('#competition-list');
    wrap.innerHTML = skeleton(6);
    try {
      const body = await api('/competitions?per_page=100');
      const rows = body.data ?? [];
      if (!rows.length) {
        wrap.innerHTML = stateCard({ icon: '🏆', title: 'No competitions', message: 'There are currently no competitions in the database.' });
        return;
      }
      wrap.innerHTML = rows.map((c) => `
        <button class="comp-card" data-comp="${c.id}" data-name="${esc(c.name)}" type="button">
          ${c.logo_url
            ? `<img class="comp-logo" src="${esc(c.logo_url)}" alt="" loading="lazy" onerror="this.style.display='none'" />`
            : '<span class="comp-fallback" aria-hidden="true">⚽</span>'}
          <span>
            <span class="c-name">${esc(c.name)}</span>
            <span class="c-meta">${esc(c.country_name ?? '—')} · ${esc((c.type ?? '—').toLowerCase())}</span>
          </span>
        </button>`).join('');
      $$('.comp-card', wrap).forEach((card) => card.addEventListener('click', () => showSeasons(card.dataset.comp, card.dataset.name)));

      const sel = $('#standings-comp');
      sel.innerHTML = '<option value="">Select competition…</option>' +
        rows.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
    } catch (err) {
      wrap.innerHTML = stateCard({
        icon: '⚠️', cls: 'error', title: 'Unable to load competitions',
        message: "We're having trouble connecting to the data service. Please try again.", retry: true,
      });
      bindRetry(wrap, loadCompetitions);
    }
  }

  async function showSeasons(compId, compName) {
    const modal = $('#seasons-modal');
    const body = $('#seasons-modal-body');
    $('#seasons-modal-comp').textContent = compName;
    body.innerHTML = skeleton(2);
    modal.showModal();
    try {
      const seasons = (await api(`/competitions/${compId}/seasons`)).data ?? [];
      if (!seasons.length) {
        body.innerHTML = '<p class="panel-sub">No seasons recorded for this competition.</p>';
        return;
      }
      body.innerHTML = seasons
        .sort((a, b) => (b.year ?? 0) - (a.year ?? 0))
        .map((s) => `<span class="chip ${s.linked_current || s.is_current ? 'current' : ''}">${esc(s.display_name)}${s.import_scope === 'in_scope' ? '' : ' · archived'}</span>`)
        .join('');
    } catch {
      body.innerHTML = stateCard({ icon: '⚠️', cls: 'error', title: 'Unable to load seasons', message: 'Please try again.' });
    }
  }
  $$('[data-close-modal]').forEach((btn) => btn.addEventListener('click', () => $(`#${btn.dataset.closeModal}`).close()));

  /* ---------------- standings ---------------- */
  $('#standings-comp').addEventListener('change', async (e) => {
    const seasonSel = $('#standings-season');
    seasonSel.disabled = true;
    seasonSel.innerHTML = '<option value="">Select season…</option>';
    if (!e.target.value) return;
    try {
      const seasons = (await api(`/competitions/${e.target.value}/seasons`)).data ?? [];
      seasonSel.innerHTML = '<option value="">Select season…</option>' +
        seasons.sort((a, b) => (b.year ?? 0) - (a.year ?? 0))
          .filter((s) => s.import_scope !== 'out_of_scope')
          .map((s) => `<option value="${s.id}">${esc(s.display_name)}</option>`).join('');
      seasonSel.disabled = false;
    } catch {
      toast('Could not load seasons for this competition', 'error');
    }
  });

  function formChips(form) {
    return String(form ?? '').split(/[^WDL]/).filter(Boolean).slice(-5)
      .map((c) => `<span class="form-chip ${c}">${c}</span>`).join('');
  }

  async function loadStandings() {
    const c = $('#standings-comp').value;
    const s = $('#standings-season').value;
    if (!c || !s) { toast('Select a competition and season first', 'info'); return; }
    const wrap = $('#standings-result');
    const btn = $('#standings-load');
    btn.disabled = true;
    wrap.innerHTML = `<div class="table-wrap"><table aria-busy="true"><tbody>
      <tr><td><div class="skel-line w60"></div></td><td><div class="skel-line w30"></div></td><td><div class="skel-line w30"></div></td></tr>
      <tr><td><div class="skel-line w40"></div></td><td><div class="skel-line w30"></div></td><td><div class="skel-line w30"></div></td></tr>
    </tbody></table></div>`;
    try {
      const body = await api(`/standings?competition_id=${c}&season_id=${s}`);
      const rows = body.data?.rows ?? [];
      if (!rows.length) {
        wrap.innerHTML = stateCard({ icon: '📊', title: 'No standings available', message: 'There are currently no standings for this competition and season (coverage may not include it).' });
        return;
      }
      wrap.innerHTML = `<div class="table-wrap"><table>
        <thead><tr><th>#</th><th>Team</th><th>P</th><th>W</th><th>D</th><th>L</th><th>GF</th><th>GA</th><th>GD</th><th>Pts</th><th>Form</th></tr></thead>
        <tbody>${rows.map((r) => `<tr>
          <td>${r.rank ?? ''}</td>
          <td><span class="team-cell">${teamLogo(r.team_name, r.logo_url)} ${esc(r.team_name ?? '')}</span></td>
          <td>${r.played ?? ''}</td><td>${r.wins ?? ''}</td><td>${r.draws ?? ''}</td><td>${r.losses ?? ''}</td>
          <td>${r.goals_for ?? ''}</td><td>${r.goals_against ?? ''}</td><td>${r.goal_diff ?? ''}</td>
          <td><b class="pts">${r.points ?? ''}</b></td><td>${formChips(r.form)}</td>
        </tr>`).join('')}</tbody></table></div>`;
    } catch (err) {
      wrap.innerHTML = stateCard({
        icon: '⚠️', cls: 'error', title: 'Unable to load standings',
        message: "We're having trouble connecting to the data service. Please try again.", retry: true,
      });
      bindRetry(wrap, loadStandings);
    } finally {
      btn.disabled = false;
    }
  }
  $('#standings-load').addEventListener('click', loadStandings);

  /* ---------------- teams ---------------- */
  async function loadTeams() {
    const wrap = $('#teams-result');
    const q = $('#team-search').value.trim();
    wrap.innerHTML = `<div class="table-wrap"><table aria-busy="true"><tbody>
      <tr><td><div class="skel-line w60"></div></td><td><div class="skel-line w30"></div></td></tr>
      <tr><td><div class="skel-line w40"></div></td><td><div class="skel-line w30"></div></td></tr>
    </tbody></table></div>`;
    try {
      const body = await api(`/teams?per_page=50${q ? `&name=${encodeURIComponent(q)}` : ''}`);
      const rows = body.data ?? [];
      if (!rows.length) {
        wrap.innerHTML = stateCard({ icon: '🔎', title: 'No teams found', message: `No teams match “${q}”. Try a different search.` });
        return;
      }
      wrap.innerHTML = `<div class="table-wrap"><table>
        <thead><tr><th>Team</th><th>Code</th><th>Founded</th></tr></thead>
        <tbody>${rows.map((t) => `<tr>
          <td><span class="team-cell">${teamLogo(t.name, t.logo_url)} ${esc(t.name)}</span></td>
          <td>${esc(t.code ?? '—')}</td><td>${t.founded ?? '—'}</td>
        </tr>`).join('')}</tbody></table></div>`;
    } catch (err) {
      wrap.innerHTML = stateCard({
        icon: '⚠️', cls: 'error', title: 'Unable to load teams',
        message: "We're having trouble connecting to the data service. Please try again.", retry: true,
      });
      bindRetry(wrap, loadTeams);
    }
  }
  $('#team-form').addEventListener('submit', (e) => { e.preventDefault(); loadTeams(); });

  /* ---------------- referees ---------------- */
  async function loadReferees() {
    const wrap = $('#referees-result');
    wrap.innerHTML = `<div class="table-wrap"><table aria-busy="true"><tbody>
      <tr><td><div class="skel-line w60"></div></td><td><div class="skel-line w30"></div></td></tr>
      <tr><td><div class="skel-line w40"></div></td><td><div class="skel-line w30"></div></td></tr>
    </tbody></table></div>`;
    try {
      const body = await api('/referees?per_page=50');
      const rows = body.data ?? [];
      if (!rows.length) {
        wrap.innerHTML = stateCard({ icon: '🟨', title: 'No referees', message: 'There are currently no referees in the database.' });
        return;
      }
      wrap.innerHTML = `<div class="table-wrap"><table>
        <thead><tr><th>Referee</th><th>Nationality</th></tr></thead>
        <tbody>${rows.map((r) => `<tr class="clickable" data-ref="${r.id}" tabindex="0" role="button" aria-label="View analytics for ${esc(r.name)}">
          <td>${esc(r.name)}</td><td>${esc(r.nationality ?? '—')}</td>
        </tr>`).join('')}</tbody></table></div>`;
      $$('tr[data-ref]', wrap).forEach((tr) => {
        const open = () => showReferee(tr.dataset.ref, tr);
        tr.addEventListener('click', open);
        tr.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
      });
    } catch (err) {
      wrap.innerHTML = stateCard({
        icon: '⚠️', cls: 'error', title: 'Unable to load referees',
        message: "We're having trouble connecting to the data service. Please try again.", retry: true,
      });
      bindRetry(wrap, loadReferees);
    }
  }

  async function showReferee(id, tr) {
    const detail = $('#referee-detail');
    $$('#referees-result tr').forEach((r) => r.classList.remove('active-row'));
    tr.classList.add('active-row');
    detail.innerHTML = `<div class="kv-grid">${'<div class="kv-item"><div class="k">Loading</div><div class="v"><div class="skel-line w40"></div></div></div>'.repeat(4)}</div>`;
    try {
      const body = await api(`/referees/${id}/statistics`);
      const season = (body.data?.season || [])[0] ?? {};
      const kv = [
        ['Matches', season.matches], ['Cards / match', season.cards_per_match],
        ['Yellow / match', season.yellow_per_match], ['Red / match', season.red_per_match],
        ['Fouls / match', season.fouls_per_match], ['Penalties / match', season.penalties_per_match],
        ['Home cards / match', season.home_cards_per_match], ['Away cards / match', season.away_cards_per_match],
      ];
      detail.innerHTML = `<h3 style="margin-bottom:4px">Referee analytics</h3>
        <p class="panel-sub" style="margin:0 0 4px">Computed locally from stored fixtures.</p>
        <div class="kv-grid">${kv.map(([k, v]) => `<div class="kv-item"><div class="k">${k}</div><div class="v">${v ?? '—'}</div></div>`).join('')}</div>`;
    } catch {
      detail.innerHTML = stateCard({ icon: '⚠️', cls: 'error', title: 'Unable to load referee analytics', message: 'Please try again.', retry: true });
      bindRetry(detail, () => showReferee(id, tr));
    }
  }

  /* ---------------- navigation ---------------- */
  function activateTab(name) {
    $$('.site-nav button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
    $$('.tab').forEach((t) => t.classList.toggle('active', t.id === name));
    $('#site-nav').classList.remove('open');
    $('#nav-toggle').setAttribute('aria-expanded', 'false');
  }
  $$('.site-nav button').forEach((btn) => btn.addEventListener('click', () => activateTab(btn.dataset.tab)));
  $$('[data-goto-tab]').forEach((a) => a.addEventListener('click', (e) => {
    e.preventDefault();
    activateTab(a.dataset.gotoTab);
    document.getElementById('fixtures-panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }));
  $('#nav-toggle').addEventListener('click', () => {
    const nav = $('#site-nav');
    const open = nav.classList.toggle('open');
    $('#nav-toggle').setAttribute('aria-expanded', String(open));
  });

  /* ---------------- boot ---------------- */
  loadFixtures();
  loadStatus();
  loadCompetitions();
  loadReferees();
  loadTeams();
  setInterval(() => { loadFixtures({ silent: true }); loadStatus(); }, 60_000);
})();
