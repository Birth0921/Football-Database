import { runCli, bootstrap, runTaskOnce, parseArgs } from './common.js';
const args = parseArgs();
runCli(async () => {
  await bootstrap();
  const fixtureId = Number(args.fixture ?? args._[0]);
  if (!fixtureId) throw new Error('usage: npm run fixture:sync -- --fixture <id> [--postmatch]');
  const details = await runTaskOnce('fixture:details', { fixtureId }, `cli:fixture:${fixtureId}:${Date.now()}`);
  if (args.postmatch) {
    await runTaskOnce('fixture:postmatch', { fixtureId }, `cli:postmatch:${fixtureId}:${Date.now()}`);
  }
  return { fixtureId, details };
});
