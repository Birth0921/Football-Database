import { runCli, bootstrap, parseArgs } from './common.js';
const args = parseArgs();
runCli(async () => {
  await bootstrap({ handlers: false });
  const keys = await import('../keys/service.js');
  const scopes = String(args.scopes ?? 'fixtures:read,teams:read,players:read,standings:read,statistics:read,predictions:read')
    .split(',').map((s) => s.trim()).filter(Boolean);
  const created = await keys.createKey({
    clientName: String(args.client ?? 'Prediction App'),
    scopes,
    label: args.label ? String(args.label) : undefined,
    expiresInDays: args.expires ? Number(args.expires) : null,
  }, 'cli');
  const client = await (await import('../lib/db.js')).queryOne(`SELECT name FROM api_clients WHERE id = $1`, [created.clientId]);
  process.stdout.write(`\nClient: ${client?.name}\nAPI Key:\n${created.rawKey}\n\nIMPORTANT:\nSave this key now.\nIt will not be displayed again.\n\n`);
  return { id: created.id, keyPrefix: created.keyPrefix, clientId: created.clientId, scopes };
});
