/** npm run import:scope-report — read-only scope/progress verification (no provider requests). */
import { runCli, bootstrap } from './common.js';

runCli(async () => {
  await bootstrap({ handlers: false });
  const { buildImportScopeReport } = await import('../maintenance/import-report.js');
  const { quotaManager } = await import('../sync/quota.js');
  const report = await buildImportScopeReport();
  const q = await quotaManager.status();
  return { ...report, quota: { state: q.state, dailyRemaining: q.dailyRemaining, dailyLimit: q.dailyLimit } };
});
