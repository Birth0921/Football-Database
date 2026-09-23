/** Row snake_case -> camelCase for API responses. */
export function toCamel<T = Record<string, unknown>>(row: Record<string, unknown> | null | undefined): T | null {
  if (!row) return null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (k === 'key_hash' || k === 'key_prefix' && false) continue; // never leak hash; prefix is not secret but filtered upstream
    const camel = k.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
    out[camel] = v instanceof Date ? v.toISOString() : v;
  }
  return out as T;
}

export function toCamelList<T = Record<string, unknown>>(rows: Record<string, unknown>[]): T[] {
  return rows.map((r) => toCamel<T>(r) as T);
}

/** Human status bucket for fixtures. */
export function statusBucket(short: string | null | undefined, isFinished: boolean): 'scheduled' | 'live' | 'finished' | 'postponed' | 'cancelled' {
  if (!short) return 'scheduled';
  if (['FT', 'AET', 'PEN'].includes(short)) return 'finished';
  if (isFinished) return 'finished';
  if (['1H', '2H', 'HT', 'ET', 'BT', 'P', 'LIVE'].includes(short)) return 'live';
  if (short === 'PST') return 'postponed';
  if (['CANC', 'ABD', 'SUSP', 'INT', 'AWD', 'WO'].includes(short)) return 'cancelled';
  return 'scheduled';
}
