/**
 * Response types for the Football Data Platform REST API (`/api/v1`).
 *
 * Fields mirror the platform's PostgreSQL columns (snake_case). PostgreSQL
 * returns `bigint`/`numeric` as JSON strings, so most numeric fields arrive as
 * strings — {@link FootballApiClient} converts them to numbers automatically
 * (`coerceNumbers`, enabled by default), which is why they are typed as numbers
 * here. Timestamps stay ISO-8601 strings.
 */

export interface Pagination {
  page: number;
  per_page: number;
  total: number;
  total_pages: number;
}

export interface Envelope<T> {
  ok: true;
  data: T;
  /** True when the response was served from the Redis cache. */
  cached?: boolean;
}

export interface Paginated<T> {
  ok: true;
  data: T[];
  pagination: Pagination;
  cached?: boolean;
}

/**
 * Health endpoints are returned unwrapped (no `data` envelope), so they have
 * their own types: `GET /health` → HealthStatus, etc.
 */
export interface HealthStatus {
  ok: boolean;
  status: string;
  time?: string;
  providerMode?: 'live' | 'mock';
  [key: string]: unknown;
}

export interface ServiceHealth {
  ok: boolean;
  status: string;
  [key: string]: unknown;
}

export interface ProviderHealth {
  ok: boolean;
  mode: 'live' | 'mock';
  quota: Record<string, unknown>;
  failedRequestsLastHour?: number;
  [key: string]: unknown;
}

export interface DataQualityHealth {
  ok: boolean;
  status: 'PASS' | 'FAIL' | string;
  checks?: Array<Record<string, unknown>>;
  summary?: Record<string, number>;
  [key: string]: unknown;
}

export interface Competition {
  id: number;
  name: string;
  code?: string | null;
  type?: string | null;
  country_name?: string | null;
  logo_url?: string | null;
  [key: string]: unknown;
}

export interface CompetitionSeason {
  id: number;
  year: number;
  display_name?: string | null;
  is_current?: boolean;
  coverage?: Record<string, boolean | null> | null;
  [key: string]: unknown;
}

export interface Team {
  id: number;
  name: string;
  short_name?: string | null;
  code?: string | null;
  country_id?: number | null;
  founded?: number | null;
  logo_url?: string | null;
  venue_id?: number | null;
  [key: string]: unknown;
}

export interface Player {
  id: number;
  name: string;
  position?: string | null;
  nationality?: string | null;
  date_of_birth?: string | null;
  age?: number | null;
  current_team_id?: number | null;
  [key: string]: unknown;
}

export interface Referee {
  id: number;
  name: string;
  nationality?: string | null;
  [key: string]: unknown;
}

export interface Fixture {
  id: number;
  provider_fixture_id?: number | string | null;
  competition_id: number | null;
  season_id: number | null;
  round?: string | null;
  home_team_id: number | null;
  away_team_id: number | null;
  venue_id?: number | null;
  referee_id?: number | null;
  timezone?: string | null;
  kickoff_utc: string | null;
  status_short: string;
  status_long?: string | null;
  status_elapsed?: number | null;
  home_score?: number | null;
  away_score?: number | null;
  home_score_ht?: number | null;
  away_score_ht?: number | null;
  finalized?: boolean;
  last_synced_at?: string | null;
  [key: string]: unknown;
}

export interface FixtureEvent {
  id: number;
  fixture_id: number;
  event_type?: string | null;
  event_detail?: string | null;
  elapsed?: number | null;
  team_id?: number | null;
  player_id?: number | null;
  [key: string]: unknown;
}

export interface Lineup {
  id: number;
  fixture_id: number;
  team_id?: number | null;
  formation?: string | null;
  coach_name?: string | null;
  [key: string]: unknown;
}

export interface StandingRow {
  rank?: number | null;
  team_id?: number | null;
  points?: number | null;
  played?: number | null;
  wins?: number | null;
  draws?: number | null;
  losses?: number | null;
  goals_for?: number | null;
  goals_against?: number | null;
  goal_diff?: number | null;
  form?: string | null;
  [key: string]: unknown;
}

export interface Standings {
  standings?: unknown;
  rows: StandingRow[];
}

export interface TeamSeasonStats {
  team_id: number;
  competition_id?: number | null;
  season_id?: number | null;
  matches?: number | null;
  wins?: number | null;
  draws?: number | null;
  losses?: number | null;
  goals_for?: number | null;
  goals_against?: number | null;
  avg_goals_scored?: number | null;
  avg_goals_conceded?: number | null;
  clean_sheets?: number | null;
  failed_to_score?: number | null;
  btts?: number | null;
  shots?: number | null;
  shots_on_target?: number | null;
  corners?: number | null;
  yellow_cards?: number | null;
  red_cards?: number | null;
  fouls?: number | null;
  possession_avg?: number | null;
  expected_goals?: number | null;
  last_5?: string[] | null;
  last_10?: string[] | null;
  home_form?: string[] | null;
  away_form?: string[] | null;
  [key: string]: unknown;
}

export interface LeagueSeasonStats {
  matches?: number | null;
  goals?: number | null;
  goals_per_match?: number | null;
  home_goals?: number | null;
  away_goals?: number | null;
  home_goals_per_match?: number | null;
  away_goals_per_match?: number | null;
  home_wins?: number | null;
  draws?: number | null;
  away_wins?: number | null;
  btts_percent?: number | null;
  cards?: number | null;
  corners?: number | null;
  [key: string]: unknown;
}

export interface RefereeFeatures {
  matches?: number | null;
  cards_per_match?: number | null;
  yellow_per_match?: number | null;
  red_per_match?: number | null;
  fouls_per_match?: number | null;
  penalties_per_match?: number | null;
  home_cards_per_match?: number | null;
  away_cards_per_match?: number | null;
  [key: string]: unknown;
}

export interface FormSplit {
  form: string[];
  matches: number;
  pointsPerGame: number | null;
}

export interface HeadToHeadMeeting {
  kickoff?: string;
  home_team_id?: number;
  away_team_id?: number;
  home_score?: number | null;
  away_score?: number | null;
  [key: string]: unknown;
}

export interface HeadToHead {
  teamAId?: number;
  teamBId?: number;
  fixturesCount?: number;
  windowSize?: number;
  aWins?: number;
  bWins?: number;
  draws?: number;
  goalsA?: number;
  goalsB?: number;
  btts?: number;
  cardsTotal?: number;
  cornersTotal?: number;
  cleanSheetsA?: number;
  cleanSheetsB?: number;
  lastMeetings?: HeadToHeadMeeting[];
  [key: string]: unknown;
}

export interface PlayerAvailabilityEntry {
  player_id?: number | null;
  team_id?: number | null;
  type?: string | null;
  reason?: string | null;
  start_date?: string | null;
  end_date?: string | null;
  [key: string]: unknown;
}

/**
 * Everything a prediction model needs for one fixture, pre-computed by the
 * platform (`GET /predictions/features/:fixtureId`).
 *
 * IMPORTANT — leakage: for fixtures that have already kicked off these features
 * are computed from the *current* database state and therefore include the
 * match itself. Train on point-in-time data (see the read-only training script
 * in `examples/prediction-app`), predict on these features only before kickoff.
 */
export interface PredictionFeatures {
  id: number;
  fixture_id: number;
  competition_id: number | null;
  season_id: number | null;
  home_team_id: number | null;
  away_team_id: number | null;

  home_form: FormSplit | null;
  away_form: FormSplit | null;
  home_home_form: FormSplit | null;
  away_away_form: FormSplit | null;

  home_goals_avg: number | null;
  away_goals_avg: number | null;
  home_conceded_avg: number | null;
  away_conceded_avg: number | null;
  home_shots_avg: number | null;
  away_shots_avg: number | null;
  home_sot_avg: number | null;
  away_sot_avg: number | null;
  home_possession_avg: number | null;
  away_possession_avg: number | null;
  home_corners_avg: number | null;
  away_corners_avg: number | null;
  home_cards_avg: number | null;
  away_cards_avg: number | null;
  home_fouls_avg: number | null;
  away_fouls_avg: number | null;

  home_clean_sheet_rate: number | null;
  away_clean_sheet_rate: number | null;
  home_fts_rate: number | null;
  away_fts_rate: number | null;
  home_btts_rate: number | null;
  away_btts_rate: number | null;

  league_avg_goals: number | null;
  league_avg_cards: number | null;

  referee_id: number | null;
  referee_features: RefereeFeatures | null;

  home_team_stats: TeamSeasonStats | null;
  away_team_stats: TeamSeasonStats | null;
  league_stats: LeagueSeasonStats | null;

  player_availability: PlayerAvailabilityEntry[];
  h2h: HeadToHead | null;
  lineups_available: unknown[];

  /** When the platform computed these features and how fresh the inputs are. */
  data_freshness: { generatedAt?: string; fixtureLastSyncedAt?: string } | null;
  calculated_at?: string | null;

  /** The fixture these features belong to (added by the API response). */
  fixture?: Fixture;
  [key: string]: unknown;
}

/** Query parameters accepted by the fixture list endpoints. */
export interface FixtureQuery {
  competition_id?: number;
  season_id?: number;
  team_id?: number;
  status?: string;
  from?: string;
  to?: string;
  date?: string;
  page?: number;
  per_page?: number;
}

export interface TeamQuery {
  competition_id?: number;
  season_id?: number;
  name?: string;
  page?: number;
  per_page?: number;
}

export interface PlayerQuery {
  team_id?: number;
  name?: string;
  page?: number;
  per_page?: number;
}

export interface PageQuery {
  page?: number;
  per_page?: number;
}
