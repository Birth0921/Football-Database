import { runCli, bootstrap, parseArgs } from './common.js';
const args = parseArgs();
runCli(async () => {
  await bootstrap({ handlers: false });
  const keys = await import('../keys/service.js');
  const target = String(args.key ?? args._[0] ?? '');
  if (!target) throw new Error('usage: npm run api-key:rotate -- --key <key-prefix-or-id> [--grace-hours 24]');
  const rotated = await keys.rotateKey(target, { graceHours: Number(args['grace-hours'] ?? 24) }, 'cli');
  process.stdout.write(`\nRotated. New API Key (shown once):\n${rotated.rawKey}\nOld key valid until: ${rotated.oldKeyValidUntil ?? 'revoked immediately'}\n\n`);
  return { id: rotated.id, keyPrefix: rotated.keyPrefix, oldKeyValidUntil: rotated.oldKeyValidUntil };
});
