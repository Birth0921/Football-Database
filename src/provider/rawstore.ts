import { query } from '../lib/db.js';
import { paramStringHash, sha256, safeParams } from '../lib/hash.js';

export interface RawStoreInput {
  endpoint: string;
  params: Record<string, unknown>;
  entityType?: string;
  providerEntityId?: string | number | null;
  fixtureId?: number | null;
  competitionId?: number | null;
  seasonId?: number | null;
  responseJson: unknown;
  httpStatus: number;
}

/** Persist a provider response so it can be replayed without calling the API again. */
export async function storeRawPayload(input: RawStoreInput): Promise<void> {
  const paramHash = paramStringHash(input.params);
  const responseHash = sha256(JSON.stringify(input.responseJson));
  await query(
    `INSERT INTO raw_provider_payloads
      (provider, endpoint, request_param_hash, request_params, entity_type, provider_entity_id,
       fixture_id, competition_id, season_id, response_json, http_status, response_hash)
     VALUES ('api-football', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      input.endpoint,
      paramHash,
      JSON.stringify(safeParams(input.params)),
      input.entityType ?? null,
      input.providerEntityId != null ? String(input.providerEntityId) : null,
      input.fixtureId ?? null,
      input.competitionId ?? null,
      input.seasonId ?? null,
      JSON.stringify(input.responseJson),
      input.httpStatus,
      responseHash,
    ],
  );
}

export interface ReplayResult<T> {
  endpoint: string;
  params: Record<string, unknown>;
  errors: unknown[];
  results: number;
  paging: { current: number; total: number };
  response: T[];
}

/** Load the most recent raw payload for an endpoint+params (mock/replay mode). */
export async function loadRawPayload<T>(
  endpoint: string,
  params: Record<string, unknown>,
): Promise<ReplayResult<T> | null> {
  const paramHash = paramStringHash(params);
  const rows = await query<{ response_json: ReplayResult<T> | T[] | { response: T[] } }>(
    `SELECT response_json FROM raw_provider_payloads
      WHERE provider = 'api-football' AND endpoint = $1 AND request_param_hash = $2
      ORDER BY fetched_at DESC LIMIT 1`,
    [endpoint, paramHash],
  );
  const raw = rows[0]?.response_json;
  if (!raw) return null;
  if (Array.isArray(raw)) {
    return {
      endpoint,
      params: safeParams(params),
      errors: [],
      results: raw.length,
      paging: { current: 1, total: 1 },
      response: raw,
    };
  }
  const asResult = raw as ReplayResult<T>;
  if (asResult && Array.isArray(asResult.response)) return asResult;
  return null;
}
