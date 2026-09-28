import { runCli, bootstrap } from './common.js';
runCli(async () => {
  await bootstrap({ handlers: false });
  const { runDataQualityChecks } = await import('../data-quality.js');
  const result = await runDataQualityChecks({ persist: true });
  if (result.failed > 0) process.exitCode = 2;
  return result;
});
