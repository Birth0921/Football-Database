/** Task handler registry — all sync task types the engine can execute. */
import { registerHandler } from './engine.js';
import { discoverCoverage, importCompetitions, importTeamsAndSquads, importSeasonsCli, enqueueSeasonWindowTasks } from './pipelines/metadata.js';
import {
  importFixturesForCompetitionSeason, fetchFixtureDetails, syncLiveFixtures,
  runPostMatchPipeline, syncUpcomingFixtures, enqueuePostMatchTasks,
} from './pipelines/fixtures.js';
import { syncStandings, syncInjuries, syncTransfers, syncOdds } from './pipelines/misc.js';
import { recalculateAllReferees, recalculateRefereeForFixture } from '../stats/referees.js';
import { recalculateAllTeams, recalculateTeamForFixture, recalculateTeamSeason } from '../stats/teams.js';
import { recalculateAllPlayers, recalculatePlayersForFixture } from '../stats/players.js';
import { recalculateAllLeagues, recalculateLeagueSeason, rebuildAllH2H } from '../stats/leagues.js';
import { rebuildPredictionFeatures, buildPredictionFeature } from '../stats/predictions.js';
import { enqueueTask } from './tasks.js';
import { query } from '../lib/db.js';
import { rebuildCache } from '../lib/cache-rebuild.js';

let registered = false;

export function registerAllHandlers(): void {
  if (registered) return;
  registered = true;

  // ---- metadata -----------------------------------------------------------
  registerHandler('competitions:import', async () => importCompetitions());
  registerHandler('seasons:import', async () => importSeasonsCli());
  registerHandler('coverage:discover', async (p) =>
    discoverCoverage(Number(p.competitionId), Number(p.seasonId)));
  registerHandler('teams:import', async (p) =>
    importTeamsAndSquads(Number(p.competitionId), Number(p.seasonId)));
  registerHandler('season-window:enqueue', async () => enqueueSeasonWindowTasks());

  // ---- fixtures -----------------------------------------------------------
  registerHandler('fixtures:import', async (p) =>
    importFixturesForCompetitionSeason(Number(p.competitionId), Number(p.seasonId), { fetchDetails: p.fetchDetails !== false }));
  registerHandler('fixture:details', async (p) => fetchFixtureDetails(Number(p.fixtureId)));
  registerHandler('fixture:postmatch', async (p) => runPostMatchPipeline(Number(p.fixtureId)));
  registerHandler('live:sync', async () => syncLiveFixtures());
  registerHandler('upcoming:sync', async (p) => syncUpcomingFixtures(Number(p.daysAhead ?? 7)));
  registerHandler('postmatch:scan', async (p) => enqueuePostMatchTasks(Number(p.limit ?? 50)));

  // ---- supporting data ----------------------------------------------------
  registerHandler('standings:sync', async (p) => syncStandings(Number(p.competitionId), Number(p.seasonId)));
  registerHandler('injuries:sync', async (p) => syncInjuries(Number(p.competitionId), Number(p.seasonId)));
  registerHandler('transfers:sync', async (p) => syncTransfers(p.teamProviderId ? String(p.teamProviderId) : undefined));
  registerHandler('odds:sync', async (p) => syncOdds(Number(p.competitionId), Number(p.seasonId)));

  // ---- derived statistics -------------------------------------------------
  registerHandler('referees:recalculate', async (p) =>
    p.fixtureId ? recalculateRefereeForFixture(Number(p.fixtureId)) : recalculateAllReferees());
  registerHandler('teams:recalculate', async (p) => {
    if (p.teamId && p.competitionId && p.seasonId) {
      await recalculateTeamSeason(Number(p.teamId), Number(p.competitionId), Number(p.seasonId));
      return { teams: 1 };
    }
    return recalculateAllTeams();
  });
  registerHandler('players:recalculate', async (p) =>
    p.fixtureId ? recalculatePlayersForFixture(Number(p.fixtureId)) : recalculateAllPlayers());
  registerHandler('leagues:recalculate', async (p) => {
    if (p.competitionId && p.seasonId) {
      await recalculateLeagueSeason(Number(p.competitionId), Number(p.seasonId));
      return { leagues: 1 };
    }
    return recalculateAllLeagues();
  });
  registerHandler('h2h:rebuild', async () => rebuildAllH2H());
  registerHandler('prediction-features:rebuild', async (p) =>
    p.fixtureId ? buildPredictionFeature(Number(p.fixtureId)) : rebuildPredictionFeatures(Boolean(p.upcomingOnly)));
  registerHandler('cache:rebuild', async () => rebuildCache());

  // ---- whole-window orchestration -----------------------------------------
  registerHandler('historical:import', async (p) => {
    // 1. competitions/seasons, 2. coverage+teams, 3. fixtures → details (via tasks)
    const meta = await importCompetitions();
    const enq = await enqueueSeasonWindowTasks();
    const rows = await query<{ competition_id: number; season_id: number; year: number }>(
      `SELECT cs.competition_id, cs.season_id, se.year
         FROM competition_seasons cs JOIN seasons se ON se.id = cs.season_id
        WHERE cs.import_scope = 'in_scope'`,
    );
    let fixtureTasks = 0;
    for (const r of rows) {
      await enqueueTask({
        taskKey: `fixtures:import:${r.competition_id}:${r.season_id}`,
        taskType: 'fixtures:import',
        params: { competitionId: r.competition_id, seasonId: r.season_id },
        priority: 55,
      });
      await enqueueTask({
        taskKey: `standings:sync:${r.competition_id}:${r.season_id}`,
        taskType: 'standings:sync',
        params: { competitionId: r.competition_id, seasonId: r.season_id },
        priority: 60,
      });
      await enqueueTask({
        taskKey: `injuries:sync:${r.competition_id}:${r.season_id}`,
        taskType: 'injuries:sync',
        params: { competitionId: r.competition_id, seasonId: r.season_id },
        priority: 75,
      });
      await enqueueTask({
        taskKey: `odds:sync:${r.competition_id}:${r.season_id}`,
        taskType: 'odds:sync',
        params: { competitionId: r.competition_id, seasonId: r.season_id },
        priority: 85,
      });
      fixtureTasks += 4;
    }
    await enqueueTask({ taskKey: 'transfers:sync:all', taskType: 'transfers:sync', params: {}, priority: 80 });
    await enqueueTask({ taskKey: 'stats:recalculate:all', taskType: 'stats:recalculate:all', params: {}, priority: 90, scheduledFor: new Date(Date.now() + 60_000) });
    return { meta, enqueued: enq, fixtureTasks };
  });

  registerHandler('stats:recalculate:all', async () => {
    const players = await recalculateAllPlayers();
    const teams = await recalculateAllTeams();
    const leagues = await recalculateAllLeagues();
    const referees = await recalculateAllReferees();
    const h2h = await rebuildAllH2H();
    const features = await rebuildPredictionFeatures(false);
    const cache = await rebuildCache();
    return { players, teams, leagues, referees, h2h, features, cache };
  });

  registerHandler('current:sync', async () => {
    // high-priority current-season refresh cycle
    await syncUpcomingFixtures(7);
    const live = await syncLiveFixtures();
    await enqueuePostMatchTasks(50);
    return { live };
  });
}
