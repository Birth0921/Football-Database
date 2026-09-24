/** API server entrypoint. */
import { createApp } from './app.js';
import { config, ensureSecretsForProduction } from '../config.js';
import { logger } from '../lib/logger.js';
import { registerAllHandlers } from '../sync/handlers.js';

async function main(): Promise<void> {
  ensureSecretsForProduction();
  registerAllHandlers();
  const app = createApp();
  app.listen(config.apiPort, config.apiHost, () => {
    logger.info({ port: config.apiPort, host: config.apiHost, providerMode: config.providerMode }, 'API server listening');
    // eslint-disable-next-line no-console
    console.log(`API listening on http://${config.apiHost}:${config.apiPort}/api/v1 (docs at /api/v1/docs)`);
  });
}

main().catch((err) => {
  logger.error({ err }, 'API server failed to start');
  process.exit(1);
});
