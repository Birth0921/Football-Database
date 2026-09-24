/** League (competition+season) analytics — derived locally. */
import { query, queryOne } from '../lib/db.js';

function per(a: number, m: number): number {
  return m > 0 ? Math.round((a / m) * 100) / 100 : 0;
}

function pct(a: number, m: number): number {
  return m > 0 ? Math.round((a / m) * 10000) / 100 : 0;
}

export async function recalculateLeagueForFixture(fixtureId: number): Promise<{ ok: boolean }> {
  const fx = await queryOne<{ competition_id: number | null; season_id: number | null; status_short: string }>(
    `SELECT competition_id, season_id, status_short FROM fixtures WHERE id = $1`,
    [fixtureId],
  );
  if (!fx?.competition_id || !fx.season_id) return { ok: false };
  if (!['FT', 'AET', 'PEN'].includes(fx.status_short)) return { ok: false };
  await recalculateLeagueSeason(fx.competition_id, fx.season_id);
  return { ok: true };
}

export async function recalculateLeagueSeason(competitionId: number, seasonId: number): Promise<void> {
  const base = await queryOne<{
    matches: number; completed: number; goals: number; home_goals: number; away_goals: number;
    home_wins: number; draws: number; away_wins: number;
  }>(
    `SELECT
        count(*)::int AS matches,
        count(*) FILTER (WHERE status_short IN ('FT','AET','PEN'))::int AS completed,
        coalesce(sum(CASE WHEN status_short IN ('FT','AET','PEN') THEN coalesce(home_score,0) + coalesce(away_score,0) ELSE 0 END),0)::int AS goals,
        coalesce(sum(CASE WHEN status_short IN ('FT','AET','PEN') THEN coalesce(home_score,0) ELSE 0 END),0)::int AS home_goals,
        coalesce(sum(CASE WHEN status_short IN ('FT','AET','PEN') THEN coalesce(away_score,0) ELSE 0 END),0)::int AS away_goals,
        count(*) FILTER (WHERE status_short IN ('FT','AET','PEN') AND home_score > away_score)::int AS home_wins,
        count(*) FILTER (WHERE status_short IN ('FT','AET','PEN') AND home_score = away_score)::int AS draws,
        count(*) FILTER (WHERE status_short IN ('FT','AET','PEN') AND home_score < away_score)::int AS away_wins
       FROM fixtures WHERE competition_id = $1 AND season_id = $2`,
    [competitionId, seasonId],
  );
  const out = await queryOne<{
    btts: number; cs: number; fts: number;
  }>(
    `SELECT
        count(*) FILTER (WHERE home_score > 0 AND away_score > 0)::int AS btts,
        count(*) FILTER (WHERE home_score = 0 OR away_score = 0)::int AS cs,
        count(*) FILTER (WHERE home_score = 0 OR away_score = 0)::int AS fts
       FROM fixtures WHERE competition_id = $1 AND season_id = $2 AND status_short IN ('FT','AET','PEN')`,
    [competitionId, seasonId],
  );
  const team = await queryOne<Record<string, number | string | null>>(
    `SELECT
        coalesce(sum(t.yellow_cards),0)::int AS yellow,
        coalesce(sum(t.second_yellow_cards),0)::int AS second_yellow,
        coalesce(sum(t.red_cards),0)::int AS red,
        coalesce(sum(t.fouls),0)::int AS fouls,
        coalesce(sum(t.corners),0)::int AS corners,
        coalesce(sum(t.shots_total),0)::int AS shots,
        coalesce(sum(t.shots_on_target),0)::int AS sot,
        avg(t.possession_pct)::text AS possession,
        sum(t.expected_goals)::text AS xg
       FROM fixture_team_statistics t JOIN fixtures f ON f.id = t.fixture_id
      WHERE f.competition_id = $1 AND f.season_id = $2 AND f.status_short IN ('FT','AET','PEN')`,
    [competitionId, seasonId],
  );
  // penalties counted from events
  const pens = await queryOne<{ penalties: number }>(
    `SELECT count(*)::int AS penalties
       FROM fixture_events e JOIN fixtures f ON f.id = e.fixture_id
      WHERE f.competition_id = $1 AND f.season_id = $2 AND f.status_short IN ('FT','AET','PEN')
        AND e.event_type = 'Goal' AND coalesce(e.event_detail,'') ILIKE '%penalty%'`,
    [competitionId, seasonId],
  );

  const m = base?.completed ?? 0;
  const cards = Number(team?.yellow ?? 0) + Number(team?.second_yellow ?? 0) + Number(team?.red ?? 0);

  await query(
    `INSERT INTO league_season_statistics
       (competition_id, season_id, matches, completed_matches, goals, goals_per_match, home_goals, away_goals,
        home_wins, draws, away_wins, btts_pct, clean_sheet_pct, failed_to_score_pct,
        yellow_cards, yellow_per_match, second_yellow, red_cards, red_per_match, total_cards, cards_per_match,
        fouls, fouls_per_match, penalties, penalties_per_match, corners, corners_per_match,
        shots, shots_per_match, shots_on_target, sot_per_match, possession_avg, expected_goals,
        is_local_derived, calculated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33, TRUE, now())
     ON CONFLICT (competition_id, season_id) DO UPDATE SET
       matches = EXCLUDED.matches, completed_matches = EXCLUDED.completed_matches,
       goals = EXCLUDED.goals, goals_per_match = EXCLUDED.goals_per_match,
       home_goals = EXCLUDED.home_goals, away_goals = EXCLUDED.away_goals,
       home_wins = EXCLUDED.home_wins, draws = EXCLUDED.draws, away_wins = EXCLUDED.away_wins,
       btts_pct = EXCLUDED.btts_pct, clean_sheet_pct = EXCLUDED.clean_sheet_pct, failed_to_score_pct = EXCLUDED.failed_to_score_pct,
       yellow_cards = EXCLUDED.yellow_cards, yellow_per_match = EXCLUDED.yellow_per_match,
       second_yellow = EXCLUDED.second_yellow, red_cards = EXCLUDED.red_cards, red_per_match = EXCLUDED.red_per_match,
       total_cards = EXCLUDED.total_cards, cards_per_match = EXCLUDED.cards_per_match,
       fouls = EXCLUDED.fouls, fouls_per_match = EXCLUDED.fouls_per_match,
       penalties = EXCLUDED.penalties, penalties_per_match = EXCLUDED.penalties_per_match,
       corners = EXCLUDED.corners, corners_per_match = EXCLUDED.corners_per_match,
       shots = EXCLUDED.shots, shots_per_match = EXCLUDED.shots_per_match,
       shots_on_target = EXCLUDED.shots_on_target, sot_per_match = EXCLUDED.sot_per_match,
       possession_avg = EXCLUDED.possession_avg, expected_goals = EXCLUDED.expected_goals,
       is_local_derived = TRUE, calculated_at = now(), updated_at = now()`,
    [
      competitionId, seasonId,
      base?.matches ?? 0, m,
      base?.goals ?? 0, per(base?.goals ?? 0, m),
      base?.home_goals ?? 0, base?.away_goals ?? 0,
      base?.home_wins ?? 0, base?.draws ?? 0, base?.away_wins ?? 0,
      pct(out?.btts ?? 0, m), pct(out?.cs ?? 0, m), pct(out?.fts ?? 0, m),
      Number(team?.yellow ?? 0), per(Number(team?.yellow ?? 0), m),
      Number(team?.second_yellow ?? 0), Number(team?.red ?? 0), per(Number(team?.red ?? 0), m),
      cards, per(cards, m),
      Number(team?.fouls ?? 0), per(Number(team?.fouls ?? 0), m),
      pens?.penalties ?? 0, per(pens?.penalties ?? 0, m),
      Number(team?.corners ?? 0), per(Number(team?.corners ?? 0), m),
      Number(team?.shots ?? 0), per(Number(team?.shots ?? 0), m),
      Number(team?.sot ?? 0), per(Number(team?.sot ?? 0), m),
      team?.possession != null ? Number(team.possession).toFixed(2) : null,
      team?.xg != null ? Number(team.xg).toFixed(3) : null,
    ],
  );
}

export async function recalculateAllLeagues(): Promise<{ leagues: number }> {
  const rows = await query<{ competition_id: number; season_id: number }>(
    `SELECT DISTINCT competition_id, season_id FROM fixtures
      WHERE competition_id IS NOT NULL AND season_id IS NOT NULL AND status_short IN ('FT','AET','PEN')`,
  );
  for (const r of rows) await recalculateLeagueSeason(r.competition_id, r.season_id);
  return { leagues: rows.length };
}

/** H2H — computed from stored fixtures (last N meetings). */
export interface H2HResult {
  teamAId: number;
  teamBId: number;
  windowSize: number;
  fixturesCount: number;
  aWins: number;
  bWins: number;
  draws: number;
  goalsA: number;
  goalsB: number;
  btts: number;
  cleanSheetsA: number;
  cleanSheetsB: number;
  cardsTotal: number | null;
  cornersTotal: number | null;
  lastMeetings: unknown[];
}

export async function computeH2H(teamAId: number, teamBId: number, windowSize = 20): Promise<H2HResult> {
  const rows = await query<{
    id: number; home_team_id: number; away_team_id: number; home_score: number | null; away_score: number | null;
    kickoff_utc: Date | null; competition_id: number | null;
  }>(
    `SELECT f.id, f.home_team_id, f.away_team_id, f.home_score, f.away_score, f.kickoff_utc, f.competition_id
       FROM fixtures f
      WHERE ((f.home_team_id = $1 AND f.away_team_id = $2) OR (f.home_team_id = $2 AND f.away_team_id = $1))
        AND f.status_short IN ('FT','AET','PEN')
      ORDER BY f.kickoff_utc DESC NULLS LAST
      LIMIT $3`,
    [teamAId, teamBId, windowSize],
  );

  let aWins = 0, bWins = 0, draws = 0, goalsA = 0, goalsB = 0, btts = 0, csA = 0, csB = 0;
  const lastMeetings: unknown[] = [];
  for (const r of rows) {
    if (r.home_score == null || r.away_score == null) continue;
    const aIsHome = r.home_team_id === teamAId;
    const ga = aIsHome ? r.home_score : r.away_score;
    const gb = aIsHome ? r.away_score : r.home_score;
    goalsA += ga;
    goalsB += gb;
    if (ga > gb) aWins += 1;
    else if (ga < gb) bWins += 1;
    else draws += 1;
    if (ga > 0 && gb > 0) btts += 1;
    if (gb === 0) csA += 1;
    if (ga === 0) csB += 1;
    lastMeetings.push({ fixtureId: r.id, homeTeamId: r.home_team_id, awayTeamId: r.away_team_id, homeScore: r.home_score, awayScore: r.away_score, kickoff: r.kickoff_utc, competitionId: r.competition_id });
  }

  const cards = await queryOne<{ cards: number | null; corners: number | null }>(
    `SELECT sum(t.yellow_cards + coalesce(t.second_yellow_cards,0) + coalesce(t.red_cards,0))::int AS cards,
            sum(t.corners)::int AS corners
       FROM fixture_team_statistics t
      WHERE t.fixture_id = ANY($1)`,
    [rows.map((r) => r.id)],
  );

  const result: H2HResult = {
    teamAId, teamBId, windowSize,
    fixturesCount: rows.length, aWins, bWins, draws,
    goalsA, goalsB, btts, cleanSheetsA: csA, cleanSheetsB: csB,
    cardsTotal: cards?.cards ?? null,
    cornersTotal: cards?.corners ?? null,
    lastMeetings,
  };

  for (const [a, b] of [[teamAId, teamBId], [teamBId, teamAId]] as [number, number][]) {
    await query(
      `INSERT INTO h2h_stats
         (team_a_id, team_b_id, window_size, fixtures_count, a_wins, b_wins, draws, goals_a, goals_b,
          btts, clean_sheets_a, clean_sheets_b, cards_total, corners_total, last_meetings)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       ON CONFLICT (team_a_id, team_b_id, window_size) DO UPDATE SET
         fixtures_count = EXCLUDED.fixtures_count, a_wins = EXCLUDED.a_wins, b_wins = EXCLUDED.b_wins,
         draws = EXCLUDED.draws, goals_a = EXCLUDED.goals_a, goals_b = EXCLUDED.goals_b,
         btts = EXCLUDED.btts, clean_sheets_a = EXCLUDED.clean_sheets_a, clean_sheets_b = EXCLUDED.clean_sheets_b,
         cards_total = EXCLUDED.cards_total, corners_total = EXCLUDED.corners_total,
         last_meetings = EXCLUDED.last_meetings, calculated_at = now(), updated_at = now()`,
      [
        a, b, windowSize, result.fixturesCount,
        a === teamAId ? aWins : bWins, a === teamAId ? bWins : aWins, draws,
        a === teamAId ? goalsA : goalsB, a === teamAId ? goalsB : goalsA,
        btts, a === teamAId ? csA : csB, a === teamAId ? csB : csA,
        result.cardsTotal, result.cornersTotal, JSON.stringify(lastMeetings),
      ],
    );
  }
  return result;
}

export async function rebuildAllH2H(): Promise<{ pairs: number }> {
  const pairs = await query<{ a: number; b: number }>(
    `SELECT DISTINCT least(home_team_id, away_team_id) AS a, greatest(home_team_id, away_team_id) AS b
       FROM fixtures WHERE home_team_id IS NOT NULL AND away_team_id IS NOT NULL AND status_short IN ('FT','AET','PEN')`,
  );
  for (const p of pairs) await computeH2H(p.a, p.b);
  return { pairs: pairs.length };
}
