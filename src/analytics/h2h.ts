import { query, type QueryResultRow } from '../db/pool.js';

export interface H2HSummary {
  lastN: number;
  matches: number;
  homeWins: number; // from perspective of teamA
  draws: number;
  awayWins: number;
  teamAGoals: number;
  teamBGoals: number;
  btts: number;
  cleanSheets: number;
  totalCards: number | null;
  totalCorners: number | null;
  recent: H2HMatch[];
}

export interface H2HMatch extends QueryResultRow {
  fixtureId: number;
  date: string | null;
  competition: string | null;
  homeTeamId: number;
  awayTeamId: number;
  homeScore: number | null;
  awayScore: number | null;
}

/** Head-to-head computed locally from stored fixtures — never an external request. */
export async function computeH2H(teamAId: number, teamBId: number, lastN = 10, competitionId?: number): Promise<H2HSummary> {
  const { rows } = await query<H2HMatch & { winner_team_id: number | null; home_score: number | null; away_score: number | null }>(
    `SELECT f.id AS "fixtureId", f.kickoff_at AS date, c.name AS competition,
            f.home_team_id AS "homeTeamId", f.away_team_id AS "awayTeamId",
            f.home_score AS "homeScore", f.away_score AS "awayScore",
            f.winner_team_id
     FROM fixtures f
     JOIN competitions c ON c.id = f.competition_id
     WHERE f.is_finished
       AND ((f.home_team_id = $1 AND f.away_team_id = $2) OR (f.home_team_id = $2 AND f.away_team_id = $1))
       ${competitionId ? 'AND f.competition_id = $3' : ''}
     ORDER BY f.kickoff_at DESC NULLS LAST
     LIMIT ${Math.min(50, Math.max(1, lastN))}`,
    competitionId ? [teamAId, teamBId, competitionId] : [teamAId, teamBId],
  );

  const matches = rows.length;
  let teamAWins = 0, draws = 0, teamBWins = 0, teamAGoals = 0, teamBGoals = 0, btts = 0, cleanSheets = 0;

  for (const m of rows) {
    const aScore = m.homeTeamId === teamAId ? m.home_score : m.away_score;
    const bScore = m.homeTeamId === teamAId ? m.away_score : m.home_score;
    if (aScore !== null) teamAGoals += aScore;
    if (bScore !== null) teamBGoals += bScore;
    if (aScore !== null && bScore !== null && aScore > 0 && bScore > 0) btts++;
    if (bScore === 0 || aScore === 0) cleanSheets++;
    if (m.winner_team_id === teamAId) teamAWins++;
    else if (m.winner_team_id === null) draws++;
    else teamBWins++;
  }

  const cardsRow = await query<{ total: string | null }>(
    `SELECT COALESCE(SUM(fts.yellow_cards + fts.red_cards), 0)::text AS total
     FROM fixture_team_statistics fts
     WHERE fts.fixture_id = ANY($1::bigint[])`,
    [rows.map((r) => r.fixtureId)],
  );
  const cornersRow = await query<{ total: string | null }>(
    `SELECT COALESCE(SUM(fts.corners), 0)::text AS total
     FROM fixture_team_statistics fts
     WHERE fts.fixture_id = ANY($1::bigint[])`,
    [rows.map((r) => r.fixtureId)],
  );

  return {
    lastN,
    matches,
    homeWins: teamAWins,
    draws,
    awayWins: teamBWins,
    teamAGoals,
    teamBGoals,
    btts,
    cleanSheets,
    totalCards: cardsRow.rows[0]?.total ? parseInt(cardsRow.rows[0].total, 10) : null,
    totalCorners: cornersRow.rows[0]?.total ? parseInt(cornersRow.rows[0].total, 10) : null,
    recent: rows.map((r) => ({
      fixtureId: r.fixtureId,
      date: r.date,
      competition: r.competition,
      homeTeamId: r.homeTeamId,
      awayTeamId: r.awayTeamId,
      homeScore: r.homeScore,
      awayScore: r.awayScore,
    })),
  };
}
