/** OpenAPI 3.0 document for our REST API (served at /api/v1/openapi.json). */
const refId = { name: 'id', in: 'path', required: true, schema: { type: 'integer' } } as const;
const refPage = { name: 'page', in: 'query', schema: { type: 'integer' } } as const;

export const openapiDoc = {
  openapi: '3.0.3',
  info: {
    title: 'Football Data API',
    version: '1.0.0',
    description:
      'Our football data platform REST API. Authenticate with `X-API-Key` (platform-issued keys, e.g. `pf_live_...`). ' +
      'The external provider key (API_FOOTBALL_KEY) is never exposed through this API.',
  },
  servers: [{ url: '/api/v1' }],
  components: {
    securitySchemes: {
      apiKey: { type: 'apiKey', in: 'header', name: 'X-API-Key' },
      adminToken: { type: 'http', scheme: 'bearer', description: 'Admin token from POST /admin/login (or an API key with admin:write)' },
    },
    schemas: {
      Error: { type: 'object', properties: { ok: { type: 'boolean' }, error: { type: 'object' } } },
      Pagination: {
        type: 'object',
        properties: {
          page: { type: 'integer' },
          per_page: { type: 'integer' },
          total: { type: 'integer' },
          total_pages: { type: 'integer' },
        },
      },
    },
  },
  security: [{ apiKey: [] }],
  paths: {
    '/health': { get: { tags: ['health'], summary: 'Liveness', security: [], responses: { '200': { description: 'OK' } } } },
    '/health/database': { get: { tags: ['health'], summary: 'PostgreSQL connectivity', security: [], responses: { '200': { description: 'OK' } } } },
    '/health/redis': { get: { tags: ['health'], summary: 'Redis connectivity', security: [], responses: { '200': { description: 'OK' } } } },
    '/health/provider': { get: { tags: ['health'], summary: 'Provider credential/quota status', security: [], responses: { '200': { description: 'OK' } } } },
    '/health/data': { get: { tags: ['health'], summary: 'Data-quality status', security: [], responses: { '200': { description: 'OK' } } } },
    '/competitions': { get: { tags: ['competitions'], summary: 'List competitions', parameters: [refPage, { name: 'country', in: 'query', schema: { type: 'string' } }], responses: { '200': { description: 'OK' } } } },
    '/competitions/{id}': { get: { tags: ['competitions'], summary: 'Competition detail', parameters: [refId], responses: { '200': { description: 'OK' } } } },
    '/competitions/{id}/seasons': { get: { tags: ['competitions'], summary: 'Seasons of a competition', parameters: [refId], responses: { '200': { description: 'OK' } } } },
    '/competitions/{id}/statistics': { get: { tags: ['statistics'], summary: 'Competition/season analytics', parameters: [refId, { name: 'season_id', in: 'query', schema: { type: 'integer' }, required: true }], responses: { '200': { description: 'OK' } } } },
    '/teams': { get: { tags: ['teams'], summary: 'List teams', parameters: [refPage, { name: 'competition_id', in: 'query', schema: { type: 'integer' } }, { name: 'season_id', in: 'query', schema: { type: 'integer' } }], responses: { '200': { description: 'OK' } } } },
    '/teams/{id}': { get: { tags: ['teams'], summary: 'Team detail', parameters: [refId], responses: { '200': { description: 'OK' } } } },
    '/teams/{id}/statistics': { get: { tags: ['statistics'], summary: 'Team statistics', parameters: [refId, { name: 'competition_id', in: 'query', schema: { type: 'integer' }, required: true }, { name: 'season_id', in: 'query', schema: { type: 'integer' }, required: true }], responses: { '200': { description: 'OK' } } } },
    '/players': { get: { tags: ['players'], summary: 'List players', parameters: [refPage, { name: 'team_id', in: 'query', schema: { type: 'integer' } }, { name: 'name', in: 'query', schema: { type: 'string' } }], responses: { '200': { description: 'OK' } } } },
    '/players/{id}': { get: { tags: ['players'], summary: 'Player detail', parameters: [refId], responses: { '200': { description: 'OK' } } } },
    '/players/{id}/statistics': { get: { tags: ['statistics'], summary: 'Player statistics', parameters: [refId, { name: 'competition_id', in: 'query', schema: { type: 'integer' } }, { name: 'season_id', in: 'query', schema: { type: 'integer' } }], responses: { '200': { description: 'OK' } } } },
    '/referees': { get: { tags: ['referees'], summary: 'List referees', parameters: [refPage], responses: { '200': { description: 'OK' } } } },
    '/referees/{id}': { get: { tags: ['referees'], summary: 'Referee detail', parameters: [refId], responses: { '200': { description: 'OK' } } } },
    '/referees/{id}/statistics': { get: { tags: ['statistics'], summary: 'Referee statistics', parameters: [refId, { name: 'competition_id', in: 'query', schema: { type: 'integer' } }, { name: 'season_id', in: 'query', schema: { type: 'integer' } }], responses: { '200': { description: 'OK' } } } },
    '/fixtures': { get: { tags: ['fixtures'], summary: 'List fixtures', parameters: [refPage, { name: 'competition_id', in: 'query', schema: { type: 'integer' } }, { name: 'season_id', in: 'query', schema: { type: 'integer' } }, { name: 'team_id', in: 'query', schema: { type: 'integer' } }, { name: 'status', in: 'query', schema: { type: 'string' } }, { name: 'from', in: 'query', schema: { type: 'string', format: 'date' } }, { name: 'to', in: 'query', schema: { type: 'string', format: 'date' } }], responses: { '200': { description: 'OK' } } } },
    '/fixtures/upcoming': { get: { tags: ['fixtures'], summary: 'Upcoming fixtures', parameters: [refPage], responses: { '200': { description: 'OK' } } } },
    '/fixtures/live': { get: { tags: ['fixtures'], summary: 'Live fixtures', responses: { '200': { description: 'OK' } } } },
    '/fixtures/finished': { get: { tags: ['fixtures'], summary: 'Finished fixtures', parameters: [refPage, { name: 'date', in: 'query', schema: { type: 'string', format: 'date' } }], responses: { '200': { description: 'OK' } } } },
    '/fixtures/{id}': { get: { tags: ['fixtures'], summary: 'Fixture detail', parameters: [refId], responses: { '200': { description: 'OK' } } } },
    '/fixtures/{id}/events': { get: { tags: ['fixtures'], summary: 'Fixture events', parameters: [refId], responses: { '200': { description: 'OK' } } } },
    '/fixtures/{id}/statistics': { get: { tags: ['fixtures'], summary: 'Fixture team statistics', parameters: [refId], responses: { '200': { description: 'OK' } } } },
    '/fixtures/{id}/lineups': { get: { tags: ['fixtures'], summary: 'Fixture lineups', parameters: [refId], responses: { '200': { description: 'OK' } } } },
    '/fixtures/{id}/players': { get: { tags: ['fixtures'], summary: 'Fixture player statistics', parameters: [refId], responses: { '200': { description: 'OK' } } } },
    '/standings': { get: { tags: ['standings'], summary: 'Standings', parameters: [{ name: 'competition_id', in: 'query', schema: { type: 'integer' }, required: true }, { name: 'season_id', in: 'query', schema: { type: 'integer' }, required: true }], responses: { '200': { description: 'OK' } } } },
    '/predictions/features/{fixtureId}': { get: { tags: ['predictions'], summary: 'Prediction features for a fixture', parameters: [refId], responses: { '200': { description: 'OK' } } } },
  },
};

