import { runCli, bootstrap, runTaskOnce } from './common.js';
runCli(async () => {
  await bootstrap();
  const result = await runTaskOnce('competitions:import');
  await runTaskOnce('seasons:import', {}, `cli:seasons:${Date.now()}`);
  return result;
});
