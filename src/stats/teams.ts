/** Team analytics per competition+season — derived locally. */
import { query, queryOne } from '../lib/db.js';

function per(a: number, m: number): number {
  return m > 0 ? Math.round((a / m) * 100) / 100 : 0;
}

export async function recalculateTeamForFixture(fixtureId: number): Promise<{ teams: number }> {
  const fx = await queryOne<{ id: number; competition_id: number | null; season_id: number | null; status_short: string }>(
    `SELECT id, competition_id, season_id, status_short FROM fixtures WHERE id = $1`,
    [fixtureId],
  );
  if (!fx || !fx.competition_id || !fx.season_id) return { teams: 0 };
  if (!['FT', 'AET', 'PEN'].includes(fx.status_short)) return { teams: 0 };
  const teams = await query<{ home_team_id: number | null; away_team_id: number | null }>(
    `SELECT home_team_id, away_team_id FROM fixtures WHERE id = $1`,
    [fixtureId],
  );
  const ids = [...new Set([teams[0]?.home_team_id, teams[0]?.away_team_id].filter((x): x is number => x != null))];
  for (const teamId of ids) {
    await recalculateTeamSeason(teamId, fx.competition_id, fx.season_id);
  }
  return { teams: ids.length };
}

export async function recalculateTeamSeason(teamId: number, competitionId: number, seasonId: number): Promise<void> {
  const rows = await query<{
    home_team_id: number; home_score: number | null; away_score: number | null; ht_h: number | null; ht_a: number | null;
    kickoff_utc: Date | null;
  }>(
    `SELECT f.home_team_id, f.home_score, f.away_score, f.home_score_ht AS ht_h, f.away_score_ht AS ht_a, f.kickoff_utc
       FROM fixtures f
      WHERE f.competition_id = $2 AND f.season_id = $3
        AND (f.home_team_id = $1 OR f.away_team_id = $1)
        AND f.status_short IN ('FT','AET','PEN')
      ORDER BY f.kickoff_utc ASC`,
    [teamId, competitionId, seasonId],
  );

  let matches = 0, wins = 0, draws = 0, losses = 0;
  let homeMatches = 0, homeWins = 0, homeDraws = 0, homeLosses = 0;
  let awayMatches = 0, awayWins = 0, awayDraws = 0, awayLosses = 0;
  let gf = 0, ga = 0, cs = 0, fts = 0, btts = 0;
  const form: string[] = [];
  const homeForm: string[] = [];
  const awayForm: string[] = [];

  for (const r of rows) {
    if (r.home_score == null || r.away_score == null) continue;
    const isHome = r.home_team_id === teamId;
    const scored = isHome ? r.home_score : r.away_score;
    const conceded = isHome ? r.away_score : r.home_score;
    const oppScored = conceded;
    matches += 1;
    gf += scored;
    ga += conceded;
    if (conceded === 0) cs += 1;
    if (scored === 0) fts += 1;
    if (scored > 0 && oppScored > 0) btts += 1;
    let res = 'D';
    if (scored > conceded) {
      wins += 1;
      res = 'W';
    } else if (scored < conceded) {
      losses += 1;
      res = 'L';
    } else draws += 1;
    form.push(res);
    if (isHome) {
      homeMatches += 1;
      homeForm.push(res);
      if (res === 'W') homeWins += 1;
      else if (res === 'L') homeLosses += 1;
      else homeDraws += 1;
    } else {
      awayMatches += 1;
      awayForm.push(res);
      if (res === 'W') awayWins += 1;
      else if (res === 'L') awayLosses += 1;
      else awayDraws += 1;
    }
  }

  const totals = await queryOne<{
    yellow: number | null; red: number | null; fouls: number | null; corners: number | null;
    shots: number | null; sot: number | null; xg: string | null; poss: string | null;
  }>(
    `SELECT sum(yellow_cards) AS yellow, sum(coalesce(second_yellow_cards,0) + red_cards) AS red,
            sum(fouls) AS fouls, sum(corners) AS corners,
            sum(shots_total) AS shots, sum(shots_on_target) AS sot,
            sum(expected_goals)::text AS xg, avg(possession_pct)::text AS poss
       FROM fixture_team_statistics t
       JOIN fixtures f ON f.id = t.fixture_id
      WHERE t.team_id = $1 AND f.competition_id = $2 AND f.season_id = $3`,
    [teamId, competitionId, seasonId],
  );

  const streaks = computeStreaks(form);

  await query(
    `INSERT INTO team_competition_season_stats
       (team_id, competition_id, season_id, matches, wins, draws, losses,
        home_matches, home_wins, home_draws, home_losses, away_matches, away_wins, away_draws, away_losses,
        goals_for, goals_against, goal_diff, avg_goals_scored, avg_goals_conceded,
        clean_sheets, failed_to_score, btts, yellow_cards, red_cards, total_cards,
        fouls, corners, shots, shots_on_target, possession_avg, expected_goals,
        last_5, last_10, last_20, home_form, away_form, streaks)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
             $21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37,$38)
     ON CONFLICT (team_id, competition_id, season_id) DO UPDATE SET
       matches = EXCLUDED.matches, wins = EXCLUDED.wins, draws = EXCLUDED.draws, losses = EXCLUDED.losses,
       home_matches = EXCLUDED.home_matches, home_wins = EXCLUDED.home_wins, home_draws = EXCLUDED.home_draws, home_losses = EXCLUDED.home_losses,
       away_matches = EXCLUDED.away_matches, away_wins = EXCLUDED.away_wins, away_draws = EXCLUDED.away_draws, away_losses = EXCLUDED.away_losses,
       goals_for = EXCLUDED.goals_for, goals_against = EXCLUDED.goals_against, goal_diff = EXCLUDED.goal_diff,
       avg_goals_scored = EXCLUDED.avg_goals_scored, avg_goals_conceded = EXCLUDED.avg_goals_conceded,
       clean_sheets = EXCLUDED.clean_sheets, failed_to_score = EXCLUDED.failed_to_score, btts = EXCLUDED.btts,
       yellow_cards = EXCLUDED.yellow_cards, red_cards = EXCLUDED.red_cards, total_cards = EXCLUDED.total_cards,
       fouls = EXCLUDED.fouls, corners = EXCLUDED.corners, shots = EXCLUDED.shots, shots_on_target = EXCLUDED.shots_on_target,
       possession_avg = EXCLUDED.possession_avg, expected_goals = EXCLUDED.expected_goals,
       last_5 = EXCLUDED.last_5, last_10 = EXCLUDED.last_10, last_20 = EXCLUDED.last_20,
       home_form = EXCLUDED.home_form, away_form = EXCLUDED.away_form, streaks = EXCLUDED.streaks,
       calculated_at = now(), updated_at = now()`,
    [
      teamId, competitionId, seasonId, matches, wins, draws, losses,
      homeMatches, homeWins, homeDraws, homeLosses, awayMatches, awayWins, awayDraws, awayLosses,
      gf, ga, gf - ga,
      matches ? Math.round((gf / matches) * 100) / 100 : 0,
      matches ? Math.round((ga / matches) * 100) / 100 : 0,
      cs, fts, btts,
      Number(totals?.yellow ?? 0), Number(totals?.red ?? 0),
      Number(totals?.yellow ?? 0) + Number(totals?.red ?? 0),
      Number(totals?.fouls ?? 0), Number(totals?.corners ?? 0),
      Number(totals?.shots ?? 0), Number(totals?.sot ?? 0),
      totals?.poss != null ? Number(totals.poss).toFixed(2) : null,
      totals?.xg != null ? Number(totals.xg).toFixed(3) : null,
      JSON.stringify(form.slice(-5)), JSON.stringify(form.slice(-10)), JSON.stringify(form.slice(-20)),
      JSON.stringify(homeForm.slice(-5)), JSON.stringify(awayForm.slice(-5)), JSON.stringify(streaks),
    ],
  );
}

function computeStreaks(form: string[]): Record<string, number> {
  let unbeaten = 0, winless = 0, wins = 0, losses = 0;
  for (let i = form.length - 1; i >= 0; i--) {
    const r = form[i];
    if (r !== 'L') unbeaten += 1;
    else break;
  }
  for (let i = form.length - 1; i >= 0; i--) {
    const r = form[i];
    if (r !== 'W') winless += 1;
    else break;
  }
  for (let i = form.length - 1; i >= 0; i--) {
    if (form[i] === 'W') wins += 1;
    else break;
  }
  for (let i = form.length - 1; i >= 0; i--) {
    if (form[i] === 'L') losses += 1;
    else break;
  }
  return { unbeaten, winless, wins, losses };
}

export async function recalculateAllTeams(): Promise<{ teams: number }> {
  const rows = await query<{ team_id: number; competition_id: number; season_id: number }>(
    `SELECT DISTINCT f.competition_id, f.season_id,
            unnest(ARRAY[f.home_team_id, f.away_team_id]) AS team_id
       FROM fixtures f
      WHERE f.status_short IN ('FT','AET','PEN') AND f.competition_id IS NOT NULL AND f.season_id IS NOT NULL`,
  );
  const seen = new Set<string>();
  for (const r of rows) {
    if (!r.team_id) continue;
    const key = `${r.team_id}:${r.competition_id}:${r.season_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    await recalculateTeamSeason(r.team_id, r.competition_id, r.season_id);
  }
  return { teams: seen.size };
}

void per;
