/**
 * Prediction features — computed locally and cached; the prediction app reads
 * them from OUR API. No model is trained here (per spec), only reliable inputs.
 */
import { query, queryOne } from '../lib/db.js';
import { computeH2H } from './leagues.js';
import { cacheSet, cacheKeys, CACHE_TTL } from '../lib/cache.js';

function rate(total: number | null, matches: number, digits = 3): number | null {
  if (total == null || matches <= 0) return null;
  return Math.round((total / matches) * 10 ** digits) / 10 ** digits;
}

interface TeamFormRow {
  form: string[];
  pointsPerGame: number | null;
  matches: number;
}

async function teamForm(teamId: number, competitionId: number | null, seasonId: number | null, opts: { homeOnly?: boolean; awayOnly?: boolean; last?: number } = {}): Promise<TeamFormRow> {
  const rows = await query<{ home_team_id: number; home_score: number | null; away_score: number | null }>(
    `SELECT home_team_id, home_score, away_score
       FROM fixtures
      WHERE (home_team_id = $1 OR away_team_id = $1)
        AND ($2::bigint IS NULL OR competition_id = $2)
        AND ($3::bigint IS NULL OR season_id = $3)
        AND status_short IN ('FT','AET','PEN')
        AND ($4::boolean IS NOT TRUE OR home_team_id = $1)
        AND ($5::boolean IS NOT TRUE OR away_team_id = $1)
      ORDER BY kickoff_utc DESC NULLS LAST
      LIMIT $6`,
    [teamId, competitionId, seasonId, opts.homeOnly ?? false, opts.awayOnly ?? false, opts.last ?? 10],
  );
  const form: string[] = [];
  let points = 0;
  for (const r of rows) {
    if (r.home_score == null || r.away_score == null) continue;
    const isHome = r.home_team_id === teamId;
    const scored = isHome ? r.home_score : r.away_score;
    const conceded = isHome ? r.away_score : r.home_score;
    if (scored > conceded) {
      form.push('W');
      points += 3;
    } else if (scored < conceded) form.push('L');
    else {
      form.push('D');
      points += 1;
    }
  }
  return { form: form.reverse(), pointsPerGame: rows.length ? Math.round((points / rows.length) * 100) / 100 : null, matches: rows.length };
}

async function teamRates(teamId: number, competitionId: number | null, seasonId: number | null) {
  const row = await queryOne<Record<string, number | string | null>>(
    `SELECT
        count(DISTINCT f.id)::int AS matches,
        avg(CASE WHEN f.home_team_id = $1 THEN f.home_score ELSE f.away_score END)::text AS goals_avg,
        avg(CASE WHEN f.home_team_id = $1 THEN f.away_score ELSE f.home_score END)::text AS conceded_avg,
        count(*) FILTER (WHERE (CASE WHEN f.home_team_id = $1 THEN f.away_score ELSE f.home_score END) = 0)::int AS clean_sheets,
        count(*) FILTER (WHERE (CASE WHEN f.home_team_id = $1 THEN f.home_score ELSE f.away_score END) = 0)::int AS fts,
        count(*) FILTER (WHERE f.home_score > 0 AND f.away_score > 0)::int AS btts
       FROM fixtures f
      WHERE (f.home_team_id = $1 OR f.away_team_id = $1)
        AND ($2::bigint IS NULL OR f.competition_id = $2)
        AND ($3::bigint IS NULL OR f.season_id = $3)
        AND f.status_short IN ('FT','AET','PEN')`,
    [teamId, competitionId, seasonId],
  );
  const statRow = await queryOne<Record<string, number | string | null>>(
    `SELECT
        avg(t.shots_total)::text AS shots_avg,
        avg(t.shots_on_target)::text AS sot_avg,
        avg(t.possession_pct)::text AS possession_avg,
        avg(t.corners)::text AS corners_avg,
        avg(coalesce(t.yellow_cards,0) + coalesce(t.red_cards,0))::text AS cards_avg,
        avg(t.fouls)::text AS fouls_avg
       FROM fixture_team_statistics t JOIN fixtures f ON f.id = t.fixture_id
      WHERE t.team_id = $1
        AND ($2::bigint IS NULL OR f.competition_id = $2)
        AND ($3::bigint IS NULL OR f.season_id = $3)
        AND f.status_short IN ('FT','AET','PEN')`,
    [teamId, competitionId, seasonId],
  );
  const matches = Number(row?.matches ?? 0);
  const f = (v: unknown) => (v == null ? null : Math.round(Number(v) * 1000) / 1000);
  return {
    matches,
    goalsAvg: f(row?.goals_avg),
    concededAvg: f(row?.conceded_avg),
    shotsAvg: f(statRow?.shots_avg),
    sotAvg: f(statRow?.sot_avg),
    possessionAvg: f(statRow?.possession_avg),
    cornersAvg: f(statRow?.corners_avg),
    cardsAvg: f(statRow?.cards_avg),
    foulsAvg: f(statRow?.fouls_avg),
    cleanSheetRate: rate(Number(row?.clean_sheets ?? 0), matches),
    ftsRate: rate(Number(row?.fts ?? 0), matches),
    bttsRate: rate(Number(row?.btts ?? 0), matches),
  };
}

export async function buildPredictionFeature(fixtureId: number): Promise<{ fixtureId: number; built: boolean }> {
  const fx = await queryOne<{
    id: number; competition_id: number | null; season_id: number | null;
    home_team_id: number | null; away_team_id: number | null; referee_id: number | null;
    kickoff_utc: Date | null; status_short: string;
  }>(`SELECT id, competition_id, season_id, home_team_id, away_team_id, referee_id, kickoff_utc, status_short FROM fixtures WHERE id = $1`, [fixtureId]);
  if (!fx?.home_team_id || !fx.away_team_id) return { fixtureId, built: false };

  const [homeForm, awayForm, homeHome, awayAway, homeRates, awayRates] = await Promise.all([
    teamForm(fx.home_team_id, fx.competition_id, fx.season_id, { last: 10 }),
    teamForm(fx.away_team_id, fx.competition_id, fx.season_id, { last: 10 }),
    teamForm(fx.home_team_id, fx.competition_id, fx.season_id, { homeOnly: true, last: 5 }),
    teamForm(fx.away_team_id, fx.competition_id, fx.season_id, { awayOnly: true, last: 5 }),
    teamRates(fx.home_team_id, fx.competition_id, fx.season_id),
    teamRates(fx.away_team_id, fx.competition_id, fx.season_id),
  ]);

  const league = await queryOne<Record<string, number | string | null>>(
    `SELECT goals_per_match::text AS goals, cards_per_match::text AS cards, matches::int AS matches
       FROM league_season_statistics WHERE competition_id = $1 AND season_id = $2`,
    [fx.competition_id, fx.season_id],
  );

  const refereeFeatures = fx.referee_id
    ? await queryOne<Record<string, number | string | null>>(
        `SELECT matches, yellow_per_match::text AS yellow_per_match, red_per_match::text AS red_per_match,
                cards_per_match::text AS cards_per_match, fouls_per_match::text AS fouls_per_match,
                penalties_per_match::text AS penalties_per_match,
                home_cards_per_match::text AS home_cards_per_match, away_cards_per_match::text AS away_cards_per_match
           FROM referee_season_statistics WHERE referee_id = $1 AND season_id = $2 AND competition_id = $3`,
        [fx.referee_id, fx.season_id, fx.competition_id],
      ) ?? null
    : null;

  const availability = await query<{ team_id: number | null; player_id: number | null; type: string | null; reason: string | null; start_date: string | null; end_date: string | null }>(
    `SELECT team_id, player_id, type, reason, start_date::text, end_date::text
       FROM sidelined_records
      WHERE team_id = ANY($1)
        AND (end_date IS NULL OR end_date >= CURRENT_DATE)`,
    [[fx.home_team_id, fx.away_team_id]],
  );

  const h2h = await computeH2H(fx.home_team_id, fx.away_team_id, 20);

  const lineups = await query<{ team_id: number; formation: string | null; coach_name: string | null }>(
    `SELECT team_id, formation, coach_name FROM lineups WHERE fixture_id = $1`,
    [fixtureId],
  );

  const teamStats = async (teamId: number) =>
    queryOne(`SELECT * FROM team_competition_season_stats WHERE team_id = $1 AND competition_id = $2 AND season_id = $3`, [teamId, fx.competition_id, fx.season_id]) ?? null;

  const dataFreshness = {
    generatedAt: new Date().toISOString(),
    fixtureLastSyncedAt: (await queryOne<{ last_synced_at: Date }>(`SELECT last_synced_at FROM fixtures WHERE id = $1`, [fixtureId]))?.last_synced_at ?? null,
  };

  await query(
    `INSERT INTO prediction_features
       (fixture_id, competition_id, season_id, home_team_id, away_team_id,
        home_form, away_form, home_home_form, away_away_form,
        home_goals_avg, away_goals_avg, home_conceded_avg, away_conceded_avg,
        home_shots_avg, away_shots_avg, home_sot_avg, away_sot_avg,
        home_possession_avg, away_possession_avg, home_corners_avg, away_corners_avg,
        home_cards_avg, away_cards_avg, home_fouls_avg, away_fouls_avg,
        home_clean_sheet_rate, away_clean_sheet_rate, home_fts_rate, away_fts_rate,
        home_btts_rate, away_btts_rate,
        league_avg_goals, league_avg_cards,
        referee_id, referee_features, home_team_stats, away_team_stats, league_stats,
        player_availability, h2h, lineups_available, data_freshness, calculated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,
             $26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37,$38,$39,$40,$41,$42, now())
     ON CONFLICT (fixture_id) DO UPDATE SET
       home_form = EXCLUDED.home_form, away_form = EXCLUDED.away_form,
       home_home_form = EXCLUDED.home_home_form, away_away_form = EXCLUDED.away_away_form,
       home_goals_avg = EXCLUDED.home_goals_avg, away_goals_avg = EXCLUDED.away_goals_avg,
       home_conceded_avg = EXCLUDED.home_conceded_avg, away_conceded_avg = EXCLUDED.away_conceded_avg,
       home_shots_avg = EXCLUDED.home_shots_avg, away_shots_avg = EXCLUDED.away_shots_avg,
       home_sot_avg = EXCLUDED.home_sot_avg, away_sot_avg = EXCLUDED.away_sot_avg,
       home_possession_avg = EXCLUDED.home_possession_avg, away_possession_avg = EXCLUDED.away_possession_avg,
       home_corners_avg = EXCLUDED.home_corners_avg, away_corners_avg = EXCLUDED.away_corners_avg,
       home_cards_avg = EXCLUDED.home_cards_avg, away_cards_avg = EXCLUDED.away_cards_avg,
       home_fouls_avg = EXCLUDED.home_fouls_avg, away_fouls_avg = EXCLUDED.away_fouls_avg,
       home_clean_sheet_rate = EXCLUDED.home_clean_sheet_rate, away_clean_sheet_rate = EXCLUDED.away_clean_sheet_rate,
       home_fts_rate = EXCLUDED.home_fts_rate, away_fts_rate = EXCLUDED.away_fts_rate,
       home_btts_rate = EXCLUDED.home_btts_rate, away_btts_rate = EXCLUDED.away_btts_rate,
       league_avg_goals = EXCLUDED.league_avg_goals, league_avg_cards = EXCLUDED.league_avg_cards,
       referee_id = EXCLUDED.referee_id, referee_features = EXCLUDED.referee_features,
       home_team_stats = EXCLUDED.home_team_stats, away_team_stats = EXCLUDED.away_team_stats,
       league_stats = EXCLUDED.league_stats, player_availability = EXCLUDED.player_availability,
       h2h = EXCLUDED.h2h, lineups_available = EXCLUDED.lineups_available,
       data_freshness = EXCLUDED.data_freshness, calculated_at = now(), updated_at = now()`,
    [
      fixtureId, fx.competition_id, fx.season_id, fx.home_team_id, fx.away_team_id,
      JSON.stringify(homeForm), JSON.stringify(awayForm), JSON.stringify(homeHome), JSON.stringify(awayAway),
      homeRates.goalsAvg, awayRates.goalsAvg, homeRates.concededAvg, awayRates.concededAvg,
      homeRates.shotsAvg, awayRates.shotsAvg, homeRates.sotAvg, awayRates.sotAvg,
      homeRates.possessionAvg, awayRates.possessionAvg, homeRates.cornersAvg, awayRates.cornersAvg,
      homeRates.cardsAvg, awayRates.cardsAvg, homeRates.foulsAvg, awayRates.foulsAvg,
      homeRates.cleanSheetRate, awayRates.cleanSheetRate, homeRates.ftsRate, awayRates.ftsRate,
      homeRates.bttsRate, awayRates.bttsRate,
      league?.goals != null ? Number(league.goals).toFixed(3) : null,
      league?.cards != null ? Number(league.cards).toFixed(2) : null,
      fx.referee_id,
      refereeFeatures ? JSON.stringify(refereeFeatures) : null,
      JSON.stringify(await teamStats(fx.home_team_id)),
      JSON.stringify(await teamStats(fx.away_team_id)),
      league ? JSON.stringify(league) : null,
      JSON.stringify(availability),
      JSON.stringify(h2h),
      JSON.stringify(lineups),
      JSON.stringify(dataFreshness),
    ],
  );

  await cacheSet(cacheKeys.prediction(fixtureId), { fixtureId, builtAt: dataFreshness.generatedAt }, CACHE_TTL.predictionFeatures);
  return { fixtureId, built: true };
}

export async function rebuildPredictionFeatures(upcomingOnly = false): Promise<{ features: number }> {
  const rows = await query<{ id: number }>(
    upcomingOnly
      ? `SELECT id FROM fixtures WHERE status_short = 'NS' AND kickoff_utc > now() ORDER BY kickoff_utc ASC`
      : `SELECT id FROM fixtures WHERE home_team_id IS NOT NULL AND away_team_id IS NOT NULL`,
  );
  for (const r of rows) await buildPredictionFeature(r.id);
  return { features: rows.length };
}
