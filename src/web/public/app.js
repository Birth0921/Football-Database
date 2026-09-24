/* Football Data Platform — public website. Consumes OUR API only (via proxy). */
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

async function api(path) {
  const res = await fetch(`/api/v1${path}`, { headers: { Accept: 'application/json' } });
  const body = await res.json().catch(() => ({ ok: false }));
  if (!res.ok) throw new Error(body?.error?.message || `HTTP ${res.status}`);
  return body;
}

$$('nav button').forEach((btn) => {
  btn.addEventListener('click', () => {
    $$('nav button').forEach((b) => b.classList.remove('active'));
    $$('.tab').forEach((t) => t.classList.remove('active'));
    btn.classList.add('active');
    $(`#${btn.dataset.tab}`).classList.add('active');
  });
});

function fixtureCard(f) {
  const live = ['1H', 'HT', '2H', 'ET', 'BT', 'P', 'INT'].includes(f.status_short);
  const score = f.home_score != null || f.away_score != null
    ? `${f.home_score ?? '–'} : ${f.away_score ?? '–'}`
    : 'vs';
  const when = f.kickoff_utc ? new Date(f.kickoff_utc).toLocaleString() : '';
  return `<div class="fixture-card">
    <div>
      <div>${f.home_team_name ?? 'TBD'} <b>vs</b> ${f.away_team_name ?? 'TBD'}</div>
      <div class="meta">${f.competition_name ?? ''} · ${when}</div>
    </div>
    <div style="text-align:right">
      <div class="score">${score}</div>
      <span class="badge ${live ? 'live' : ''}">${f.status_short}${f.status_elapsed ? ` ${f.status_elapsed}'` : ''}</span>
    </div>
  </div>`;
}

async function loadFixtures() {
  try {
    const [live, upcoming] = await Promise.all([api('/fixtures/live'), api('/fixtures/upcoming?per_page=15')]);
    $('#live-list').innerHTML = (live.data || []).map(fixtureCard).join('') || '<div class="note">No live matches right now.</div>';
    $('#upcoming-list').innerHTML = (upcoming.data || []).map(fixtureCard).join('') || '<div class="note">No upcoming fixtures.</div>';
  } catch (err) {
    $('#live-list').innerHTML = `<div class="note">Error: ${err.message}</div>`;
  }
}

async function loadCompetitions() {
  const body = await api('/competitions?per_page=100');
  const rows = (body.data || []).map((c) =>
    `<tr class="clickable" data-comp="${c.id}"><td>${c.name}</td><td>${c.country_name ?? '—'}</td><td>${c.type ?? '—'}</td></tr>`).join('');
  $('#competitions-table tbody').innerHTML = rows;
  const sel = $('#standings-comp');
  sel.innerHTML = '<option value="">Select competition…</option>' + (body.data || []).map((c) => `<option value="${c.id}">${c.name}</option>`).join('');
  $$('#competitions-table tr.clickable').forEach((tr) => tr.addEventListener('click', async () => {
    const seasons = await api(`/competitions/${tr.dataset.comp}/seasons`);
    alert(`${tr.children[0].textContent}\n\nSeasons: ${(seasons.data || []).map((s) => s.display_name).join(', ') || 'none'}`);
  }));
}

$('#standings-comp').addEventListener('change', async (e) => {
  const sel = $('#standings-season');
  if (!e.target.value) return;
  const body = await api(`/competitions/${e.target.value}/seasons`);
  sel.innerHTML = '<option value="">Select season…</option>' + (body.data || []).map((s) => `<option value="${s.id}">${s.display_name}</option>`).join('');
});

$('#standings-load').addEventListener('click', async () => {
  const c = $('#standings-comp').value;
  const s = $('#standings-season').value;
  if (!c || !s) return;
  try {
    const body = await api(`/standings?competition_id=${c}&season_id=${s}`);
    const rows = (body.data?.rows || []).map((r) => `<tr>
      <td>${r.rank ?? ''}</td><td>${r.team_name ?? ''}</td><td>${r.played ?? ''}</td><td>${r.wins ?? ''}</td>
      <td>${r.draws ?? ''}</td><td>${r.losses ?? ''}</td><td>${r.goals_for ?? ''}</td><td>${r.goals_against ?? ''}</td>
      <td>${r.goal_diff ?? ''}</td><td><b>${r.points ?? ''}</b></td><td class="form">${r.form ?? ''}</td></tr>`).join('');
    $('#standings-table tbody').innerHTML = rows || '<tr><td colspan="11">No standings (coverage may not include this competition/season).</td></tr>';
  } catch (err) {
    $('#standings-table tbody').innerHTML = `<tr><td colspan="11">Error: ${err.message}</td></tr>`;
  }
});

$('#team-load').addEventListener('click', async () => {
  const q = $('#team-search').value.trim();
  const body = await api(`/teams?per_page=50${q ? `&name=${encodeURIComponent(q)}` : ''}`);
  $('#teams-table tbody').innerHTML = (body.data || []).map((t) =>
    `<tr><td>${t.name}</td><td>${t.code ?? '—'}</td><td>${t.founded ?? '—'}</td></tr>`).join('') || '<tr><td colspan="3">No teams.</td></tr>';
});

async function loadReferees() {
  const body = await api('/referees?per_page=50');
  $('#referees-table tbody').innerHTML = (body.data || []).map((r) =>
    `<tr class="clickable" data-ref="${r.id}"><td>${r.name}</td><td>${r.nationality ?? '—'}</td></tr>`).join('') || '<tr><td colspan="2">No referees.</td></tr>';
  $$('#referees-table tr.clickable').forEach((tr) => tr.addEventListener('click', async () => {
    const body = await api(`/referees/${tr.dataset.ref}/statistics`);
    const season = (body.data?.season || [])[0] || {};
    const kv = [
      ['Matches', season.matches], ['Cards / match', season.cards_per_match],
      ['Yellow / match', season.yellow_per_match], ['Red / match', season.red_per_match],
      ['Fouls / match', season.fouls_per_match], ['Penalties / match', season.penalties_per_match],
      ['Home cards / match', season.home_cards_per_match], ['Away cards / match', season.away_cards_per_match],
    ];
    $('#referee-detail').innerHTML = `<h3>Referee analytics</h3><div class="kv">${kv.map(([label, v]) =>
      `<div class="item"><div class="label">${label}</div><div class="value">${v ?? '—'}</div></div>`).join('')}</div>`;
  }));
}

loadFixtures();
loadCompetitions();
loadReferees();
$('#team-load').click();
setInterval(loadFixtures, 60_000);
