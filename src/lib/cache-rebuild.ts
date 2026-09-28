/** Warm/rebuild Redis cache from PostgreSQL (source of truth). */
import { cacheSet, cacheKeys, CACHE_TTL } from './cache.js';
import { query } from './db.js';

export async function rebuildCache(): Promise<{ warmed: number }> {
  let warmed = 0;

  const live = await query(`SELECT * FROM fixtures WHERE status_short IN ('1H','HT','2H','ET','BT','P','INT')`);
  await cacheSet(cacheKeys.live(), live, CACHE_TTL.liveFixtures);
  warmed += 1;

  const upcoming = await query(
    `SELECT * FROM fixtures WHERE status_short = 'NS' AND kickoff_utc > now() ORDER BY kickoff_utc ASC LIMIT 200`,
  );
  await cacheSet(cacheKeys.upcoming(), upcoming, CACHE_TTL.upcomingFixtures);
  warmed += 1;

  const standings = await query(
    `SELECT cs.competition_id, cs.season_id, s.id AS standings_id, json_agg(sr.*) AS rows
       FROM standings s
       JOIN competition_seasons cs ON cs.id = s.competition_season_id
       LEFT JOIN standing_rows sr ON sr.standings_id = s.id
      GROUP BY cs.competition_id, cs.season_id, s.id`,
  );
  for (const row of standings) {
    await cacheSet(cacheKeys.standings({ competitionId: row.competition_id, seasonId: row.season_id }), row, CACHE_TTL.standings);
    warmed += 1;
  }

  const teams = await query(`SELECT * FROM team_competition_season_stats`);
  for (const t of teams) {
    await cacheSet(cacheKeys.teamStats(Number((t as { team_id: number }).team_id)), t, CACHE_TTL.teamStats);
    warmed += 1;
  }

  const referees = await query(`SELECT * FROM referee_season_statistics`);
  for (const r of referees) {
    await cacheSet(cacheKeys.refereeStats(Number((r as { referee_id: number }).referee_id)), r, CACHE_TTL.refereeStats);
    warmed += 1;
  }

  const predictions = await query(`SELECT * FROM prediction_features`);
  for (const p of predictions) {
    await cacheSet(cacheKeys.prediction(Number((p as { fixture_id: number }).fixture_id)), p, CACHE_TTL.predictionFeatures);
    warmed += 1;
  }

  return { warmed };
}
