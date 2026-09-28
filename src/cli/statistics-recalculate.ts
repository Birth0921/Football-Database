import { runCli, bootstrap, runTaskOnce, parseArgs } from './common.js';
const args = parseArgs();
runCli(async () => {
  await bootstrap();
  const params: Record<string, unknown> = {};
  if (args.team) params.teamId = Number(args.team);
  if (args.competition) params.competitionId = Number(args.competition);
  if (args.season) params.seasonId = Number(args.season);
  if (args.fixture) params.fixtureId = Number(args.fixture);
  return runTaskOnce('stats:recalculate:all', params);
});
