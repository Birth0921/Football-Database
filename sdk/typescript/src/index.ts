/**
 * @football-data-platform/client
 *
 * Official client for the Football Data Platform REST API.
 * Authenticates with platform-issued `pf_live_…` keys only.
 */
export {
  FootballDataClient,
  FootballApiClient,
  Client,
} from './client.js';
export type {
  FootballDataClientOptions,
  RateLimitSnapshot,
} from './client.js';

export {
  FootballApiError,
  AuthenticationError,
  PermissionError,
  NotFoundError,
  RateLimitError,
  ServerError,
  ValidationError,
  NetworkError,
  errorFromResponse,
} from './errors.js';
export type { FootballApiErrorOptions } from './errors.js';

export { coerceNumbers, toQuery, redactKey, looksLikePlatformKey } from './util.js';

export type {
  Competition,
  CompetitionSeason,
  Envelope,
  Fixture,
  FixtureEvent,
  FixtureQuery,
  FormSplit,
  HeadToHead,
  HeadToHeadMeeting,
  HealthStatus,
  ServiceHealth,
  ProviderHealth,
  DataQualityHealth,
  LeagueSeasonStats,
  Lineup,
  PageQuery,
  Paginated,
  Pagination,
  Player,
  PlayerAvailabilityEntry,
  PlayerQuery,
  PredictionFeatures,
  Referee,
  RefereeFeatures,
  Standings,
  StandingRow,
  Team,
  TeamQuery,
  TeamSeasonStats,
} from './types.js';
