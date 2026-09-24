import { runCli, bootstrap, runTaskOnce } from './common.js';
runCli(async () => {
  await bootstrap();
  return runTaskOnce('cache:rebuild');
});
