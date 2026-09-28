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
import { queryOne } from '../lib/db.js';
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
  registerHandler('fixtures:import', async (p, task) => {
    const competitionId = Number(p.competitionId);
    const seasonId = Number(p.seasonId);
    const res = await importFixturesForCompetitionSeason(competitionId, seasonId, { fetchDetails: p.fetchDetails !== false });
    // Chain per-pair follow-up work ONLY when the pair actually HAS fixtures —
    // empty pairs never burn provider requests on coverage probes/teams/squads.
    if (res.imported > 0) {
      const followUps = [
        { taskKey: `coverage:${competitionId}:${seasonId}`, taskType: 'coverage:discover', priority: 40 },
        { taskKey: `teams:${competitionId}:${seasonId}`, taskType: 'teams:import', priority: 45 },
        { taskKey: `standings:sync:${competitionId}:${seasonId}`, taskType: 'standings:sync', priority: 60 },
        { taskKey: `injuries:sync:${competitionId}:${seasonId}`, taskType: 'injuries:sync', priority: 75 },
        { taskKey: `odds:sync:${competitionId}:${seasonId}`, taskType: 'odds:sync', priority: 85 },
      ];
      for (const f of followUps) {
        await enqueueTask({ ...f, params: { competitionId, seasonId }, jobId: task.job_id ?? null });
      }
    }
    return { ...res, chainedFollowUps: res.imported > 0 };
  });
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
  registerHandler('historical:import', async () => {
    // 1. competitions/seasons (single /leagues request), 2. fixture imports per
    // in-scope pair. Coverage/teams/standings/injuries/odds are CHAINED by the
    // fixtures:import handler — only for pairs that actually have fixtures —
    // so empty pairs cost exactly ONE request instead of 6+.
    const meta = await importCompetitions();
    const enq = await enqueueSeasonWindowTasks();
    await enqueueTask({ taskKey: 'transfers:sync:all', taskType: 'transfers:sync', params: {}, priority: 80 });
    await enqueueTask({ taskKey: 'stats:recalculate:all', taskType: 'stats:recalculate:all', params: {}, priority: 90, scheduledFor: new Date(Date.now() + 60_000) });
    return { meta, enqueued: enq, fixtureTasks: enq.tasks };
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
    // A fresh deployment has migrations but no competition/season scope yet.
    // Initialise just the metadata needed for a current refresh instead of
    // leaving the public website empty until somebody runs the full historical
    // bootstrap manually. This remains idempotent and does not import history.
    const scope = await queryOne<{ c: number }>(
      `SELECT count(*)::int AS c FROM competition_seasons WHERE import_scope = 'in_scope'`,
    );
    if ((scope?.c ?? 0) === 0) await importCompetitions();

    // high-priority current-season refresh cycle
    await syncUpcomingFixtures(7);
    const live = await syncLiveFixtures();
    await enqueuePostMatchTasks(50);
    return { live };
  });
}
