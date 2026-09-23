import crypto from 'node:crypto';

export function sha256(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

/** Deterministic hash of request parameters for caching/idempotency. */
export function paramsHash(endpoint: string, params: Record<string, unknown>): string {
  const stable = Object.keys(params)
    .sort()
    .map((k) => `${k}=${String(params[k])}`)
    .join('&');
  return sha256(`${endpoint}?${stable}`).slice(0, 40);
}

/** Content hash of a payload (for change detection). */
export function contentHash(value: unknown): string {
  return sha256(JSON.stringify(value));
}

/** Stable event identity for idempotent event storage. */
export function eventKey(parts: (string | number | null | undefined)[]): string {
  return sha256(parts.map((p) => (p === null || p === undefined ? '' : String(p))).join('|')).slice(0, 32);
}

/** Normalize referee-style names: "Michael Oliver, England" -> { name, country } */
export function splitNameCountry(raw: string | null | undefined): { name: string; country: string | null } {
  if (!raw) return { name: '', country: null };
  const [name, ...rest] = raw.split(',');
  return { name: name.trim(), country: rest.join(',').trim() || null };
}

export function nameKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

export function parseHeightToInt(height: string | number | null | undefined): number | null {
  if (height === null || height === undefined) return null;
  const s = String(height).trim();
  if (!s || s === '0 cm') return null;
  const m = s.match(/^(\d+)\s*cm$/);
  if (m) return parseInt(m[1], 10);
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : null;
}

export function parseWeightToInt(weight: string | number | null | undefined): number | null {
  if (weight === null || weight === undefined) return null;
  const s = String(weight).trim();
  if (!s || s === '0 kg') return null;
  const m = s.match(/^(\d+)\s*kg$/);
  if (m) return parseInt(m[1], 10);
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : null;
}

export function parsePossession(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const s = String(value).replace('%', '').trim();
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export function parseNumeric(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function parseIntOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = parseInt(String(value), 10);
  return Number.isFinite(n) ? n : null;
}

export function dateOrNull(value: unknown): string | null {
  if (!value || typeof value !== 'string') return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : value.slice(0, 10);
}

export function toDateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
