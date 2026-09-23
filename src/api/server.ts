import Fastify, { type FastifyInstance, type FastifyBaseLogger } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { registerAuthPreHandler } from './auth.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerContentRoutes } from './routes/content.js';
import { registerStatisticsRoutes } from './routes/statistics.js';
import { registerPredictionRoutes } from './routes/predictions.js';
import { registerAdminRoutes } from './admin.js';
import { ok } from '../util/http.js';

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    loggerInstance: logger.child({ mod: 'api' }) as unknown as FastifyBaseLogger,
    trustProxy: true,
    bodyLimit: 1024 * 1024,
    disableRequestLogging: false,
  }) as unknown as FastifyInstance;

  await app.register(cors, { origin: true });
  await app.register(rateLimit, {
    global: false, // per-client limits are enforced in auth.ts against Redis
  });

  await app.register(swagger, {
    openapi: {
      info: {
        title: 'Football Data Platform API',
        description:
          'Normalized football data (competitions, teams, players, referees, fixtures, statistics, standings) plus prediction features. ' +
          'Authenticate with your platform API key via the X-API-Key header. This API never exposes the upstream API-Football key.',
        version: '1.0.0',
      },
      servers: [{ url: config.api.baseUrl }],
      tags: [
        { name: 'health' }, { name: 'competitions' }, { name: 'teams' }, { name: 'players' },
        { name: 'referees' }, { name: 'fixtures' }, { name: 'standings' }, { name: 'statistics' },
        { name: 'predictions' }, { name: 'admin' },
      ],
      components: {
        securitySchemes: {
          ApiKeyAuth: { type: 'apiKey', in: 'header', name: 'X-API-Key' },
          AdminToken: { type: 'apiKey', in: 'header', name: 'X-Admin-Token' },
        },
      },
      security: [{ ApiKeyAuth: [] }],
    },
  });
  await app.register(swaggerUi, {
    routePrefix: '/docs',
    uiConfig: { docExpansion: 'none', deepLinking: true },
  });

  registerAuthPreHandler(app);

  // Centralized status mapping: error envelopes carry their HTTP status.
  app.addHook('preSerialization', async (_req, reply, payload) => {
    if (payload && typeof payload === 'object' && (payload as Record<string, unknown>).success === false) {
      const err = (payload as Record<string, unknown>).error as Record<string, unknown> | undefined;
      const status = typeof err?.status === 'number' ? err.status : undefined;
      if (status && status >= 400 && status < 600) reply.code(status);
    }
    return payload;
  });

  app.get('/', { config: { scope: undefined } }, async () =>
    ok({
      service: 'football-data-platform',
      version: '1.0.0',
      docs: '/docs',
      health: '/health',
      authentication: 'X-API-Key header',
    }),
  );

  registerHealthRoutes(app);
  registerContentRoutes(app);
  registerStatisticsRoutes(app);
  registerPredictionRoutes(app);
  registerAdminRoutes(app);

  // structured 404 + error envelopes
  app.setNotFoundHandler(async (_req, reply) => {
    reply.code(404).send({ success: false, error: { status: 404, message: 'not found' } });
  });
  app.setErrorHandler(async (err: Error & { statusCode?: number }, req, reply) => {
    const status = typeof err.statusCode === 'number' ? err.statusCode : 500;
    if (status >= 500) req.log.error({ err: err.message, url: req.url }, 'unhandled API error');
    reply.code(status).send({
      success: false,
      error: { status, message: status >= 500 ? 'internal server error' : err.message },
    });
  });

  return app;
}

export async function startApi(): Promise<FastifyInstance> {
  const app = await buildApp();
  await app.listen({ port: config.api.port, host: config.api.host });
  return app;
}

// Run directly: node src/api/server.ts
if (process.argv[1]?.includes('server')) {
  startApi().catch((err) => {
    logger.error({ err: err instanceof Error ? err.message : err }, 'API failed to start');
    process.exit(1);
  });
}
