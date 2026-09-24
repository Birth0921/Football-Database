import { runCli, bootstrap, runTaskOnce } from './common.js';
runCli(async () => {
  await bootstrap();
  return runTaskOnce('seasons:import');
});
