import { runCli, bootstrap, runTaskOnce, parseArgs } from './common.js';
const args = parseArgs();
runCli(async () => {
  await bootstrap();
  return runTaskOnce('prediction-features:rebuild', {
    upcomingOnly: Boolean(args.upcoming),
    fixtureId: args.fixture ? Number(args.fixture) : undefined,
  });
});
