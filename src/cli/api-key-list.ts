import { runCli, bootstrap } from './common.js';
runCli(async () => {
  await bootstrap({ handlers: false });
  const keys = await import('../keys/service.js');
  const list = (await keys.listKeys()).map((k) => ({
    id: k.id, client: k.client_name, key_prefix: k.key_prefix, scopes: k.scopes,
    created_at: k.created_at, last_used_at: k.last_used_at, expires_at: k.expires_at, revoked_at: k.revoked_at,
  }));
  return { clients: await keys.listClients(), keys: list };
});
