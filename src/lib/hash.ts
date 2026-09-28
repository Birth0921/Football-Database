import crypto from 'node:crypto';

export function sha256(input: string | Buffer | object): string {
  const data = typeof input === 'object' && !Buffer.isBuffer(input) ? stableStringify(input) : input;
  return crypto.createHash('sha256').update(data as string | Buffer).digest('hex');
}

/** Deterministic JSON stringify (sorted keys) for hashing request params. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortValue((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

export function paramStringHash(params: Record<string, unknown>): string {
  const filtered: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) {
    if (/key|secret|token|password/i.test(k)) continue; // never hash secrets into stored params
    if (v === undefined || v === null || v === '') continue;
    filtered[k] = v;
  }
  return sha256(stableStringify(filtered));
}

export function safeParams(params: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) {
    if (/key|secret|token|password/i.test(k)) continue;
    if (v === undefined) continue;
    out[k] = v;
  }
  return out;
}

/** Normalized-payload hash used to skip re-writing unchanged fixtures. */
export function dataHash(payload: unknown): string {
  return sha256(stableStringify(payload));
}
