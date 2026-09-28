/**
 * Explicit production import scope.
 *
 * API-Football exposes more than 1,200 leagues/cups. The importer must never
 * treat that catalogue as an allowlist. Only IDs in this table (or the exact
 * named aliases below, for provider catalogue renames) may be imported.
 *
 * Tiers are operational priorities, not provider metadata:
 *   1 = global/international and top-flight competitions
 *   2 = established second divisions and major regional competitions
 *   3 = approved third divisions and women's domestic competitions
 */
export type ImportTier = 1 | 2 | 3;

const TIER_1_IDS = [
  // FIFA / UEFA / continental national-team competitions
  1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 13,
  // UEFA Women's Champions League, Women's Nations League, FIFA Club World Cup
  525, 7985, 8141,
  // Europe's top flights
  39, 61, 78, 88, 94, 135, 140, 144, 179, 203, 207, 218,
  // Major non-European top flights
  71, 128, 253, 262, 270, 281, 293, 299, 307,
  // Approved women's top flights / national competitions
  44, 82, 222, 254,
] as const;

const TIER_2_IDS = [
  // England, France, Germany, Italy, Netherlands, Portugal, Spain
  40, 62, 79, 89, 95, 136, 141,
  // Scotland, Denmark, Norway, Sweden, Austria, Switzerland, Greece, Czechia,
  // Croatia, Russia, Ukraine
  120, 104, 114, 180, 181, 119, 208, 219, 209, 204, 197, 210, 236, 237, 243,
  // North and South America / Asia
  72, 129, 240, 271, 263, 308,
  // approved women's second divisions / continental club competitions
  45, 83, 223, 255,
] as const;

const TIER_3_IDS = [
  // England, France, Germany, Italy, Netherlands, Portugal, Spain
  41, 42, 63, 80, 90, 96, 137, 142,
  // Scotland, Denmark, Norway, Sweden, Austria, Switzerland, Czechia, Ukraine
  121, 105, 115, 182, 220, 211, 198, 244,
  // North and South America
  73, 130, 241, 272, 264,
  // approved women's third-tier competitions
  46, 84, 224, 256,
] as const;

const REAL_TIERS = new Map<number, ImportTier>([
  ...TIER_1_IDS.map((id) => [id, 1] as const),
  ...TIER_2_IDS.map((id) => [id, 2] as const),
  ...TIER_3_IDS.map((id) => [id, 3] as const),
]);

// Synthetic provider data is used only by local tests. Keeping its IDs out of
// REAL_TIERS ensures a live API-Football response can never import them.
const SYNTHETIC_TIERS = new Map<number, ImportTier>([
  [39, 1], [140, 1], [40, 2], [758, 3],
]);

function normalizeName(value: unknown): string {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[\u2019']s\b/g, 's')
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Exact aliases for competitions whose provider IDs have changed historically. */
const NAMED_TIERS = new Map<string, ImportTier>([
  ['world cup', 1],
  ['fifa world cup', 1],
  ['world cup women', 1],
  ['fifa womens world cup', 1],
  ['fifa world cup women', 1],
  ['womens world cup', 1],
  ['champions league', 1],
  ['uefa champions league', 1],
  ['womens champions league', 1],
  ['uefa womens champions league', 1],
  ['uefa champions league women', 1],
  ['nations league', 1],
  ['uefa nations league', 1],
  ['womens nations league', 1],
  ['uefa womens nations league', 1],
  ['fifa club world cup', 1],
  ['club world cup', 1],
  ['womens club world cup', 1],
  ['europa league', 1],
  ['uefa europa league', 1],
  ['conference league', 1],
  ['uefa europa conference league', 1],
  ['copa america', 1],
  ['copa libertadores', 1],
  ['copa sudamericana', 1],
]);

export const APPROVED_COMPETITION_IDS = [...REAL_TIERS.keys()].sort((a, b) => a - b);

export function importTierForCompetition(input: { id?: unknown; name?: unknown }, allowSynthetic = false): ImportTier | null {
  const id = Number(input.id);
  if (Number.isInteger(id)) {
    const real = REAL_TIERS.get(id);
    if (real) return real;
    if (allowSynthetic) {
      const synthetic = SYNTHETIC_TIERS.get(id);
      if (synthetic) return synthetic;
    }
  }
  return NAMED_TIERS.get(normalizeName(input.name)) ?? null;
}

export function isApprovedCompetition(input: { id?: unknown; name?: unknown }, allowSynthetic = false): boolean {
  return importTierForCompetition(input, allowSynthetic) !== null;
}

export function approvedProviderIds(allowSynthetic = false): string[] {
  const ids = allowSynthetic ? [...new Set([...REAL_TIERS.keys(), ...SYNTHETIC_TIERS.keys()])] : [...REAL_TIERS.keys()];
  return ids.map(String);
}

export function historicalImportSeasons(seasons: readonly number[]): number[] {
  return seasons.filter((year) => year !== 2026);
}

export function isImportSeason(year: unknown, seasons: readonly number[]): year is number {
  return Number.isInteger(year) && seasons.includes(Number(year));
}

export function isCurrentImportSeason(year: unknown): boolean {
  return Number(year) === 2026;
}

export { normalizeName };
