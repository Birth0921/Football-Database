import { runCli, bootstrap } from './common.js';
runCli(async () => {
  await bootstrap({ handlers: false });
  const { quotaManager } = await import('../sync/quota.js');
  const status = await quotaManager.status();
  const recent = await (await import('../lib/db.js')).query(
    `SELECT endpoint, count(*) AS calls, sum((success IS NOT TRUE)::int) AS failures
       FROM provider_requests WHERE started_at > now() - interval '24 hours'
      GROUP BY endpoint ORDER BY calls DESC LIMIT 20`);
  return { quota: status, providerMode: (await import('../config.js')).config.providerMode, recent };
});
