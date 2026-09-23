import type { FastifyInstance } from 'fastify';
import { query } from '../../db/pool.js';
import { ok, fail } from '../../util/http.js';
import { cacheGetJson, cacheSetJson } from '../../redis/client.js';
import { buildPredictionFeatures } from '../../analytics/features.js';

/**
 * GET /predictions/features/:fixtureId
 * Full prediction feature set for a fixture — built locally (no API-Football calls
 * at request time). Served from Redis cache -> prediction_features table -> on-demand build.
 */
export function registerPredictionRoutes(app: FastifyInstance): void {
  app.get('/predictions/features/:fixtureId', { config: { scope: 'predictions:read' } }, async (req, reply) => {
    const { fixtureId } = req.params as { fixtureId: string };
    const id = Number(fixtureId);
    const cacheKey = `features:fixture:${id}`;

    const cached = await cacheGetJson<Record<string, unknown>>(cacheKey);
    if (cached) return ok(cached, { source: 'redis' });

    const stored = (
      await query<Record<string, unknown>>(
        `SELECT features, version, computed_at FROM prediction_features WHERE fixture_id = $1`,
        [id],
      )
    ).rows[0];
    if (stored) {
      const features = typeof stored.features === 'string' ? JSON.parse(stored.features as string) : stored.features;
      return ok(features, { source: 'database', computedAt: stored.computed_at, version: stored.version });
    }

    // upcoming fixture with no features yet? build once on demand (local data only)
    const exists = (
      await query<{ kickoff_at: Date }>(`SELECT kickoff_at FROM fixtures WHERE id = $1`, [id])
    ).rows[0];
    if (!exists) return fail(404, 'fixture not found');
    const built = await buildPredictionFeatures(id, { persist: true });
    if (!built) return fail(404, 'fixture data incomplete');
    return ok(built, { source: 'computed' });
  });
}
