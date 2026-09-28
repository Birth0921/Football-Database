import { runCli, bootstrap, parseArgs } from './common.js';
const args = parseArgs();
runCli(async () => {
  await bootstrap({ handlers: false });
  const keys = await import('../keys/service.js');
  const target = String(args.key ?? args._[0] ?? '');
  if (!target) throw new Error('usage: npm run api-key:revoke -- --key <key-prefix-or-id>');
  await keys.revokeKey(target, String(args.reason ?? 'revoked via CLI'), 'cli');
  return { revoked: target };
});
