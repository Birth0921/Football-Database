import type { AFCoverage, AFLeague } from '../provider/types.js';

export interface CountryRow {
  providerId: number | null;
  name: string;
  code: string | null;
  flagUrl: string | null;
}

export interface CompetitionRow {
  providerId: number;
  name: string;
  type: string;
  country: CountryRow | null;
  logoUrl: string | null;
}

export interface SeasonRow { year: number; startDate: string | null; endDate: string | null; isCurrent: boolean }

export interface CoverageRow {
  events: boolean; lineups: boolean; fixtureStatistics: boolean; playerStatistics: boolean;
  standings: boolean; players: boolean; topScorers: boolean; topAssists: boolean; topCards: boolean;
  injuries: boolean; sidelined: boolean; predictions: boolean; odds: boolean;
}

export function mapCountry(raw: { id?: number | null; name?: string; code?: string | null; flag?: string | null } | undefined | null, fallbackName?: string): CountryRow | null {
  if (!raw || !raw.name) {
    if (fallbackName) return { providerId: null, name: fallbackName, code: null, flagUrl: null };
    return null;
  }
  return { providerId: raw.id ?? null, name: raw.name, code: raw.code ?? null, flagUrl: raw.flag ?? null };
}

export function mapCompetition(league: AFLeague): CompetitionRow {
  return {
    providerId: league.id,
    name: league.name,
    type: league.type === 'cup' ? 'cup' : 'league',
    country: mapCountry(league.country),
    logoUrl: league.logo ?? null,
  };
}

export function mapSeasons(league: AFLeague): SeasonRow[] {
  return (league.seasons ?? []).map((s) => ({
    year: s.year,
    startDate: s.start ?? null,
    endDate: s.end ?? null,
    isCurrent: Boolean(s.current),
  }));
}

export function mapCoverage(c: AFCoverage | undefined | null): CoverageRow {
  return {
    events: Boolean(c?.events),
    lineups: Boolean(c?.lineups),
    fixtureStatistics: Boolean(c?.statistics_fixtures),
    playerStatistics: Boolean(c?.statistics_players),
    standings: Boolean(c?.standings),
    players: Boolean(c?.players),
    topScorers: Boolean(c?.top_scorers),
    topAssists: Boolean(c?.top_assists),
    topCards: Boolean(c?.top_cards),
    injuries: Boolean(c?.injuries),
    sidelined: Boolean(c?.sidelined),
    predictions: Boolean(c?.predictions),
    odds: Boolean(c?.odds),
  };
}
