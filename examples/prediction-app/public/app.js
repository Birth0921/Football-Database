/* Prediction app UI — talks only to its own server, which holds the API key. */
const state = { predictions: [], selected: null, timer: null };

const els = {
  status: document.getElementById('status-line'),
  dot: document.querySelector('.dot'),
  meta: document.getElementById('meta-line'),
  list: document.getElementById('fixtures'),
  detail: document.getElementById('detail'),
  competition: document.getElementById('competition'),
  limit: document.getElementById('limit'),
  refresh: document.getElementById('refresh'),
};

const pct = (v) => `${(v * 100).toFixed(1)}%`;
const num = (v, d = 2) => (v === null || v === undefined ? '—' : Number(v).toFixed(d));

function when(iso) {
  if (!iso) return 'TBC';
  const d = new Date(iso);
  return {
    date: d.toLocaleDateString(undefined, { day: '2-digit', month: 'short' }),
    time: d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }),
  };
}

async function api(url) {
  const res = await fetch(url);
  const body = await res.json().catch(() => ({ ok: false }));
  if (!res.ok || body.ok === false) {
    throw new Error(body?.error?.message || `request failed (${res.status})`);
  }
  return body;
}

async function loadStatus() {
  try {
    const s = await api('/api/status');
    const rl = s.rateLimit || {};
    els.dot.className = 'dot ok';
    els.status.innerHTML =
      `API <code>${s.api.baseUrl}</code> · key <code>${s.api.key}</code> · provider ${s.api.providerMode ?? '?'} · ` +
      `db ${s.database?.status ?? '?'} · redis ${s.redis?.status ?? '?'} · ` +
      `quota ${rl.remainingMinute ?? '?'}/min, ${rl.remainingDay ?? '?'}/day left · ` +
      `model ${s.model.trained ? 'trained + features' : 'features only'}`;
  } catch (err) {
    els.dot.className = 'dot bad';
    els.status.textContent = `API unreachable: ${err.message}`;
  }
}

function populateCompetitions() {
  const names = new Map();
  for (const p of state.predictions) if (p.competitionName) names.set(p.competitionName, p.competitionName);
  const current = els.competition.value;
  els.competition.innerHTML = '<option value="">All competitions</option>';
  for (const name of [...names].sort()) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    els.competition.appendChild(opt);
  }
  els.competition.value = names.has(current) ? current : '';
}

function visiblePredictions() {
  const comp = els.competition.value;
  return comp ? state.predictions.filter((p) => p.competitionName === comp) : state.predictions;
}

function renderList() {
  const rows = visiblePredictions();
  if (!rows.length) {
    els.list.innerHTML = '<p class="empty">No upcoming fixtures returned. Check that the platform has upcoming fixtures and that prediction features are built.</p>';
    return;
  }
  els.list.innerHTML = '';
  for (const p of rows) {
    const row = document.createElement('div');
    row.className = `row${state.selected === p.fixtureId ? ' selected' : ''}`;
    const w = when(p.kickoffUtc);
    const m = p.markets;
    row.innerHTML = `
      <div class="when"><strong>${w.time}</strong>${w.date} · ${p.competitionName ?? ''}</div>
      <div class="teams">
        <div class="name">${p.homeTeamName} <span>v</span> ${p.awayTeamName}</div>
        <div class="comp">${p.round ? `${p.round} · ` : ''}${p.seasonName ?? ''}</div>
        <div class="bar">
          <i class="h" style="width:${(m.home * 100).toFixed(1)}%"></i>
          <i class="d" style="width:${(m.draw * 100).toFixed(1)}%"></i>
          <i class="a" style="width:${(m.away * 100).toFixed(1)}%"></i>
        </div>
      </div>
      <div class="probs">
        <div><span>1</span><b>${pct(m.home)}</b></div>
        <div><span>X</span><b>${pct(m.draw)}</b></div>
        <div><span>2</span><b>${pct(m.away)}</b></div>
        <div><span>O2.5</span><b>${pct(m.over25)}</b></div>
      </div>
      <div class="xg"><strong>${num(p.lambdaHome, 2)}–${num(p.lambdaAway, 2)}</strong><small>xG ${num(m.expectedTotalGoals, 2)}</small></div>
    `;
    row.addEventListener('click', () => selectFixture(p.fixtureId));
    els.list.appendChild(row);
  }
}

function scoreGrid(p) {
  const size = 6; // show 0–5 goals
  let html = '<table class="grid"><tr><td class="head"></td>';
  for (let a = 0; a < size; a += 1) html += `<td class="head">${a}</td>`;
  html += '</tr>';
  const max = Math.max(...p.grid.matrix.flat().slice(0, size * size));
  for (let h = 0; h < size; h += 1) {
    html += `<tr><td class="head">${h}</td>`;
    for (let a = 0; a < size; a += 1) {
      const p2 = p.grid.matrix[h][a];
      const alpha = max > 0 ? 0.12 + (p2 / max) * 0.88 : 0;
      const isBest = p.markets.mostLikelyScoreline.home === h && p.markets.mostLikelyScoreline.away === a;
      html += `<td style="background:rgba(77,163,255,${alpha.toFixed(2)});${isBest ? 'outline:1px solid #ffc857;' : ''}" title="${h}-${a}: ${pct(p2)}">${(p2 * 100).toFixed(0)}</td>`;
    }
    html += '</tr>';
  }
  return `${html}</table>`;
}

function renderDetail(p) {
  const m = p.markets;
  const i = p.inputs;
  const chips = [
    `xG ${num(p.lambdaHome)} – ${num(p.lambdaAway)}`,
    `O2.5 ${pct(m.over25)}`,
    `U2.5 ${pct(m.under25)}`,
    `BTTS ${pct(m.btts)}`,
    `1X ${pct(m.doubleChanceHomeOrDraw)}`,
    `X2 ${pct(m.doubleChanceAwayOrDraw)}`,
    `Top score ${m.mostLikelyScoreline.home}-${m.mostLikelyScoreline.away} (${pct(m.mostLikelyScoreline.probability)})`,
  ];
  const row = (label, home, away) =>
    `<tr><th>${label}</th><td class="num">${home ?? '—'}</td><td class="num">${away ?? '—'}</td></tr>`;

  els.detail.innerHTML = `
    <div class="panel-head"><h2>Fixture detail</h2><span class="meta">#${p.fixtureId}</span></div>
    <h3>${p.homeTeamName} v ${p.awayTeamName}</h3>
    <p class="kick">${p.kickoffUtc ? new Date(p.kickoffUtc).toLocaleString() : 'kickoff TBC'} · ${p.competitionName ?? ''} ${p.seasonName ?? ''} ${p.round ? `· ${p.round}` : ''}</p>
    <div class="chips">${chips.map((c) => `<span class="chip">${c.replace(/ ([\d.]+%)$/, ' <b>$1</b>')}</span>`).join('')}</div>

    <table>
      <tr><th>Market</th><th style="text-align:right">Probability</th><th style="text-align:right">Fair odds</th></tr>
      <tr><td>Home win</td><td class="num">${pct(m.home)}</td><td class="num">${num(m.fairOdds.home)}</td></tr>
      <tr><td>Draw</td><td class="num">${pct(m.draw)}</td><td class="num">${num(m.fairOdds.draw)}</td></tr>
      <tr><td>Away win</td><td class="num">${pct(m.away)}</td><td class="num">${num(m.fairOdds.away)}</td></tr>
    </table>

    <h4 style="margin:16px 0 4px;font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:#c3cde8">Model inputs</h4>
    <table>
      <tr><th>Input</th><th style="text-align:right">Home</th><th style="text-align:right">Away</th></tr>
      ${row('Attack strength', num(p.strengths.home.attack), num(p.strengths.away.attack))}
      ${row('Defence (conceded)', num(p.strengths.home.defence), num(p.strengths.away.defence))}
      ${row('Sample (matches)', p.strengths.home.matches, p.strengths.away.matches)}
      ${row('Goals / match', num(i.homeGoalsAvg), num(i.awayGoalsAvg))}
      ${row('Conceded / match', num(i.homeConcededAvg), num(i.awayConcededAvg))}
      ${row('Recent form', i.homeForm.slice(-5).join(' ') || '—', i.awayForm.slice(-5).join(' ') || '—')}
      ${row('League avg goals', num(i.leagueAvgGoals), num(i.leagueAvgGoals))}
    </table>
    <p class="notes">
      Attack/defence are ratios to the league average (1.00 = average), shrunk
      toward 1.00 by sample size (weight ${num(p.strengths.home.shrinkage, 2)} /
      ${num(p.strengths.away.shrinkage, 2)}); λ is a multiplicative Poisson model.
      ${i.h2h ? `H2H: ${i.h2h.meetings ?? 0} meetings (${i.h2h.homeWins ?? 0}-${i.h2h.draws ?? 0}-${i.h2h.awayWins ?? 0}).` : ''}
      ${i.referee?.cardsPerMatch ? `Referee averages ${num(i.referee.cardsPerMatch, 1)} cards/match.` : ''}
      ${i.unavailablePlayers ? `${i.unavailablePlayers} availability record(s) in the dataset.` : ''}
      ${i.lineupsKnown ? 'Lineups known.' : 'Lineups not published yet.'}
    </p>

    <h4 style="margin:16px 0 4px;font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:#c3cde8">Score grid</h4>
    ${scoreGrid(p)}

    <ul class="notes">
      <li>λ source: <b>${p.model.source}</b>${p.model.blendWeightTrained !== undefined ? ` (trained weight ${p.model.blendWeightTrained})` : ''} · ρ ${p.model.rho}</li>
      <li>League baseline: ${num(p.model.baseline.homeGoalsPerMatch)} home / ${num(p.model.baseline.awayGoalsPerMatch)} away goals per match (${p.model.baseline.source})</li>
      ${p.model.notes.map((n) => `<li>${n}</li>`).join('')}
      <li>Features generated ${p.freshness.featuresGeneratedAt ? new Date(p.freshness.featuresGeneratedAt).toLocaleString() : 'unknown'}${p.freshness.cached ? ' (served from platform cache)' : ''}</li>
    </ul>
  `;
}

async function selectFixture(id) {
  state.selected = id;
  renderList();
  els.detail.innerHTML = '<div class="panel-head"><h2>Fixture detail</h2></div><p class="empty">Loading…</p>';
  try {
    const { data } = await api(`/api/predict/${id}`);
    renderDetail(data);
  } catch (err) {
    els.detail.innerHTML = `<div class="panel-head"><h2>Fixture detail</h2></div><p class="error">${err.message}</p>`;
  }
}

async function loadUpcoming(force = false) {
  els.list.innerHTML = '<p class="empty">Loading…</p>';
  const params = new URLSearchParams({ limit: els.limit.value });
  if (force) params.set('refresh', '1');
  try {
    const body = await api(`/api/upcoming?${params}`);
    state.predictions = body.predictions ?? [];
    populateCompetitions();
    const rl = body.meta?.rateLimit ?? {};
    els.meta.textContent =
      `${state.predictions.length} scored · ${body.meta?.modelSource ?? 'features'} · ` +
      `quota ${rl.remainingMinute ?? '?'}/min left${body.skipped?.length ? ` · ${body.skipped.length} skipped` : ''}`;
    renderList();
    if (state.selected && !state.predictions.some((p) => p.fixtureId === state.selected)) {
      state.selected = null;
    }
  } catch (err) {
    els.list.innerHTML = `<p class="error">Could not load fixtures: ${err.message}</p>`;
    els.meta.textContent = '';
  }
}

els.refresh.addEventListener('click', () => {
  loadUpcoming(true);
  loadStatus();
});
els.limit.addEventListener('change', () => loadUpcoming());
els.competition.addEventListener('change', renderList);

(async function init() {
  await loadStatus();
  await loadUpcoming();
  state.timer = setInterval(() => loadUpcoming(), 5 * 60_000);
})();
