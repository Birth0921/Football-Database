import type { AFTeam, AFVenue } from '../provider/types.js';
import { parseIntOrNull } from '../util/hash.js';
import type { CountryRow } from './leagues.js';

export interface VenueRow {
  providerId: number | null;
  name: string | null;
  address: string | null;
  city: string | null;
  country: CountryRow | null;
  capacity: number | null;
  surface: string | null;
  imageUrl: string | null;
}

export interface TeamRow {
  providerId: number;
  name: string;
  shortName: string | null;
  code: string | null;
  country: CountryRow | null;
  founded: number | null;
  logoUrl: string | null;
  isNational: boolean;
  venue: VenueRow | null;
}

export function mapVenue(v: AFVenue | null | undefined): VenueRow | null {
  if (!v) return null;
  const hasAny = v.name || v.city || v.address || v.id;
  if (!hasAny) return null;
  return {
    providerId: v.id ?? null,
    name: v.name ?? null,
    address: v.address ?? null,
    city: v.city ?? null,
    country: v.country ? { providerId: null, name: v.country, code: null, flagUrl: null } : null,
    capacity: parseIntOrNull(v.capacity),
    surface: v.surface ?? null,
    imageUrl: v.image ?? null,
  };
}

export function mapTeam(t: AFTeam): TeamRow {
  return {
    providerId: t.id,
    name: t.name,
    shortName: null,
    code: t.code ?? null,
    country: t.country ? { providerId: null, name: t.country, code: null, flagUrl: null } : null,
    founded: parseIntOrNull(t.founded),
    logoUrl: t.logo ?? null,
    isNational: Boolean(t.national),
    venue: mapVenue(t.venue),
  };
}
