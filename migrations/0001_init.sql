-- ===========================================================================
-- Football Data Platform — initial schema
-- PostgreSQL 14+, UTC TIMESTAMPTZ everywhere, NULL when data is unavailable
-- (never fake zeros). Provider-specific/unmodeled fields live in JSONB.
-- ===========================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- Generic helpers
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS schema_migrations (
  id          BIGSERIAL PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Reference data
-- ---------------------------------------------------------------------------
CREATE TABLE countries (
  id            BIGSERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  code          TEXT,
  flag_url      TEXT,
  provider      TEXT NOT NULL DEFAULT 'api-football',
  provider_id   TEXT,
  raw           JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_countries_provider UNIQUE (provider, provider_id)
);
CREATE INDEX ix_countries_name ON countries (lower(name));

CREATE TABLE competitions (
  id            BIGSERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  code          TEXT,
  type          TEXT,                      -- league | cup | tournament ...
  country_id    BIGINT REFERENCES countries(id),
  logo_url      TEXT,
  flag_url      TEXT,
  is_national   BOOLEAN,
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  provider      TEXT NOT NULL DEFAULT 'api-football',
  provider_id   TEXT,
  raw           JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_competitions_provider UNIQUE (provider, provider_id)
);
CREATE INDEX ix_competitions_country ON competitions (country_id);
CREATE INDEX ix_competitions_name ON competitions (lower(name));

CREATE TABLE seasons (
  id            BIGSERIAL PRIMARY KEY,
  year          INT NOT NULL,              -- starting year, e.g. 2024 for 2024/25
  display_name  TEXT NOT NULL,             -- e.g. "2024/2025"
  start_date    DATE,
  end_date      DATE,
  is_current    BOOLEAN NOT NULL DEFAULT FALSE,
  provider      TEXT NOT NULL DEFAULT 'api-football',
  provider_id   TEXT,
  raw           JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_seasons_provider UNIQUE (provider, provider_id)
);
CREATE UNIQUE INDEX uq_seasons_year ON seasons (year);

CREATE TABLE competition_seasons (
  id              BIGSERIAL PRIMARY KEY,
  competition_id  BIGINT NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
  season_id       BIGINT NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
  is_current      BOOLEAN NOT NULL DEFAULT FALSE,
  import_scope    TEXT NOT NULL DEFAULT 'in_scope',  -- in_scope | out_of_scope
  provider        TEXT NOT NULL DEFAULT 'api-football',
  raw             JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_competition_season UNIQUE (competition_id, season_id)
);

-- Coverage flags: request only endpoints a competition/season actually supports
CREATE TABLE competition_season_coverage (
  id                        BIGSERIAL PRIMARY KEY,
  competition_season_id     BIGINT NOT NULL REFERENCES competition_seasons(id) ON DELETE CASCADE,
  fixtures_known            BOOLEAN NOT NULL DEFAULT FALSE,
  events                    BOOLEAN,
  lineups                   BOOLEAN,
  fixture_statistics        BOOLEAN,
  player_statistics         BOOLEAN,
  standings                 BOOLEAN,
  players                   BOOLEAN,
  top_scorers               BOOLEAN,
  top_assists               BOOLEAN,
  top_cards                 BOOLEAN,
  injuries                  BOOLEAN,
  sidelined                 BOOLEAN,
  predictions               BOOLEAN,
  odds                      BOOLEAN,
  referees                  BOOLEAN,
  detected_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  raw                       JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_coverage_cs UNIQUE (competition_season_id)
);

CREATE TABLE venues (
  id            BIGSERIAL PRIMARY KEY,
  name          TEXT,
  city          TEXT,
  address       TEXT,
  capacity      INT,
  surface       TEXT,
  image_url     TEXT,
  country_id    BIGINT REFERENCES countries(id),
  provider      TEXT NOT NULL DEFAULT 'api-football',
  provider_id   TEXT,
  raw           JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_venues_provider UNIQUE (provider, provider_id)
);

CREATE TABLE competition_rounds (
  id                    BIGSERIAL PRIMARY KEY,
  competition_season_id BIGINT NOT NULL REFERENCES competition_seasons(id) ON DELETE CASCADE,
  name                  TEXT NOT NULL,
  round_number          INT,
  raw                   JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_round UNIQUE (competition_season_id, name)
);

-- ---------------------------------------------------------------------------
-- Teams
-- ---------------------------------------------------------------------------
CREATE TABLE teams (
  id            BIGSERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  short_name    TEXT,
  code          TEXT,
  country_id    BIGINT REFERENCES countries(id),
  founded       INT,
  national_flag BOOLEAN,
  logo_url      TEXT,
  venue_id      BIGINT REFERENCES venues(id),
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  provider      TEXT NOT NULL DEFAULT 'api-football',
  provider_id   TEXT,
  raw           JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_teams_provider UNIQUE (provider, provider_id)
);
CREATE INDEX ix_teams_name ON teams (lower(name));
CREATE INDEX ix_teams_country ON teams (country_id);

CREATE TABLE team_seasons (
  id              BIGSERIAL PRIMARY KEY,
  team_id         BIGINT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  competition_id  BIGINT NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
  season_id       BIGINT NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
  raw             JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_team_season UNIQUE (team_id, competition_id, season_id)
);

CREATE TABLE team_coach_history (
  id            BIGSERIAL PRIMARY KEY,
  team_id       BIGINT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  coach_name    TEXT NOT NULL,
  nationality   TEXT,
  start_date    DATE,
  end_date      DATE,
  provider      TEXT NOT NULL DEFAULT 'api-football',
  provider_id   TEXT,
  raw           JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ix_team_coach_team ON team_coach_history (team_id, start_date);

-- ---------------------------------------------------------------------------
-- Players
-- ---------------------------------------------------------------------------
CREATE TABLE players (
  id              BIGSERIAL PRIMARY KEY,
  name            TEXT NOT NULL,
  first_name      TEXT,
  last_name       TEXT,
  date_of_birth   DATE,
  age             INT,
  nationality     TEXT,
  height_cm       INT,
  weight_kg       INT,
  position        TEXT,
  preferred_foot  TEXT,
  photo_url       TEXT,
  current_team_id BIGINT REFERENCES teams(id),
  active          BOOLEAN NOT NULL DEFAULT TRUE,
  provider        TEXT NOT NULL DEFAULT 'api-football',
  provider_id     TEXT,
  raw             JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_players_provider UNIQUE (provider, provider_id)
);
CREATE INDEX ix_players_name ON players (lower(name));
CREATE INDEX ix_players_team ON players (current_team_id);
CREATE INDEX ix_players_position ON players (position);

-- A player may appear for multiple teams in the same season; history rows keep
-- the actual spells. provider_history_id groups loan-return splits.
CREATE TABLE player_team_history (
  id                  BIGSERIAL PRIMARY KEY,
  player_id           BIGINT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  team_id             BIGINT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  season_id           BIGINT REFERENCES seasons(id),
  start_date          DATE,
  end_date            DATE,
  number              INT,
  position            TEXT,
  transfer_type       TEXT,        -- transfer | loan | loan_end | free | retired ...
  provider_history_id TEXT,
  provider            TEXT NOT NULL DEFAULT 'api-football',
  raw                 JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_player_team_history UNIQUE (player_id, team_id, start_date, provider_history_id)
);
CREATE INDEX ix_player_team_history_player ON player_team_history (player_id, season_id);

-- ---------------------------------------------------------------------------
-- Referees
-- ---------------------------------------------------------------------------
CREATE TABLE referees (
  id            BIGSERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  first_name    TEXT,
  last_name     TEXT,
  nationality   TEXT,
  photo_url     TEXT,
  provider      TEXT NOT NULL DEFAULT 'api-football',
  provider_id   TEXT,
  raw           JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_referees_provider UNIQUE (provider, provider_id)
);
CREATE INDEX ix_referees_name ON referees (lower(name));

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------
CREATE TABLE fixtures (
  id                    BIGSERIAL PRIMARY KEY,
  provider              TEXT NOT NULL DEFAULT 'api-football',
  provider_fixture_id   TEXT NOT NULL,
  competition_id        BIGINT REFERENCES competitions(id),
  season_id             BIGINT REFERENCES seasons(id),
  round                 TEXT,
  round_id              BIGINT REFERENCES competition_rounds(id),
  home_team_id          BIGINT REFERENCES teams(id),
  away_team_id          BIGINT REFERENCES teams(id),
  venue_id              BIGINT REFERENCES venues(id),
  referee_id            BIGINT REFERENCES referees(id),
  timezone              TEXT,
  kickoff_utc           TIMESTAMPTZ,
  status_short          TEXT,      -- NS, 1H, HT, 2H, ET, BT, P, FT, ABD, CAN, PST, SUSP, INT ...
  status_long           TEXT,
  status_elapsed        INT,
  status_extra          INT,
  postponed             BOOLEAN NOT NULL DEFAULT FALSE,
  home_score            INT,
  away_score            INT,
  home_score_ht         INT,
  away_score_ht         INT,
  home_score_et         INT,
  away_score_et         INT,
  home_score_pen        INT,
  away_score_pen        INT,
  neutral_venue         BOOLEAN,
  importance            TEXT,      -- league | cup | friendly ...
  finalized             BOOLEAN NOT NULL DEFAULT FALSE,
  finalized_at          TIMESTAMPTZ,
  data_hash             TEXT,      -- hash of normalized payload at last sync
  last_synced_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  provider_created_at   TIMESTAMPTZ,
  provider_updated_at   TIMESTAMPTZ,
  raw                   JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_fixtures_provider UNIQUE (provider, provider_fixture_id),
  CONSTRAINT ck_fixtures_teams
    CHECK (home_team_id IS NULL OR away_team_id IS NULL OR home_team_id <> away_team_id)
);
CREATE INDEX ix_fixtures_comp_season_date ON fixtures (competition_id, season_id, kickoff_utc);
CREATE INDEX ix_fixtures_home_date ON fixtures (home_team_id, kickoff_utc);
CREATE INDEX ix_fixtures_away_date ON fixtures (away_team_id, kickoff_utc);
CREATE INDEX ix_fixtures_status ON fixtures (status_short);
CREATE INDEX ix_fixtures_kickoff ON fixtures (kickoff_utc);
CREATE INDEX ix_fixtures_referee ON fixtures (referee_id);
CREATE INDEX ix_fixtures_finalized ON fixtures (finalized) WHERE finalized = FALSE;

CREATE TABLE fixture_periods (
  id            BIGSERIAL PRIMARY KEY,
  fixture_id    BIGINT NOT NULL REFERENCES fixtures(id) ON DELETE CASCADE,
  period        TEXT NOT NULL,       -- FIRST | SECOND | EXTRA | PENALTIES
  elapsed       INT,
  extra         INT,
  raw           JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_fixture_period UNIQUE (fixture_id, period)
);

-- Score lines per phase; kept separate so ET/PEN are never conflated with FT
CREATE TABLE fixture_scores (
  id                BIGSERIAL PRIMARY KEY,
  fixture_id        BIGINT NOT NULL REFERENCES fixtures(id) ON DELETE CASCADE,
  score_type        TEXT NOT NULL,   -- 1ST_HALF | 2ND_HALF | FULL_TIME | EXTRA_TIME | PENALTIES
  home_score        INT,
  away_score        INT,
  raw               JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_fixture_scores UNIQUE (fixture_id, score_type)
);

CREATE TABLE fixture_events (
  id                BIGSERIAL PRIMARY KEY,
  fixture_id        BIGINT NOT NULL REFERENCES fixtures(id) ON DELETE CASCADE,
  team_id           BIGINT REFERENCES teams(id),
  player_id         BIGINT REFERENCES players(id),
  assist_player_id  BIGINT REFERENCES players(id),
  event_type        TEXT NOT NULL,   -- Goal | Card | subst | Var ...
  event_detail      TEXT,
  comments          TEXT,
  elapsed           INT,
  extra             INT,
  time_label        TEXT,            -- raw provider time string ("90+4")
  is_home           BOOLEAN,
  provider_event_id TEXT,
  raw               JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_fixture_events UNIQUE (fixture_id, provider_event_id, elapsed, extra, event_type, event_detail, player_id)
);
CREATE INDEX ix_fixture_events_fixture ON fixture_events (fixture_id);
CREATE INDEX ix_fixture_events_team ON fixture_events (team_id);
CREATE INDEX ix_fixture_events_player ON fixture_events (player_id);

CREATE TABLE fixture_team_statistics (
  id                      BIGSERIAL PRIMARY KEY,
  fixture_id              BIGINT NOT NULL REFERENCES fixtures(id) ON DELETE CASCADE,
  team_id                 BIGINT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  is_home                 BOOLEAN NOT NULL,
  -- canonical statistics (NULL when provider does not supply them)
  shots_total             INT,
  shots_on_target         INT,
  shots_off_target        INT,
  shots_blocked           INT,
  shots_inside_box        INT,
  shots_outside_box       INT,
  goals                   INT,
  conceded_goals          INT,
  expected_goals          NUMERIC(8,3),
  possession_pct          NUMERIC(5,2),
  passes_total            INT,
  passes_accurate         INT,
  pass_accuracy_pct       NUMERIC(5,2),
  corners                 INT,
  offsides                INT,
  fouls                   INT,
  yellow_cards            INT,
  second_yellow_cards     INT,
  red_cards               INT,
  goalkeeper_saves        INT,
  crosses                 INT,
  crosses_accurate        INT,
  tackles                 INT,
  interceptions           INT,
  clearances              INT,
  blocks                  INT,
  duels_total             INT,
  duels_won               INT,
  aerials_total           INT,
  aerials_won             INT,
  dribbles_attempts       INT,
  dribbles_success        INT,
  penalties_scored        INT,
  penalties_missed        INT,
  -- anything the provider sent that we did not model
  extra_stats             JSONB NOT NULL DEFAULT '{}'::jsonb,
  raw                     JSONB NOT NULL DEFAULT '{}'::jsonb,
  provider_stat_key       TEXT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_fixture_team_stats UNIQUE (fixture_id, team_id)
);
CREATE INDEX ix_fixture_team_stats_fixture ON fixture_team_statistics (fixture_id);
CREATE INDEX ix_fixture_team_stats_team ON fixture_team_statistics (team_id);

CREATE TABLE player_match_statistics (
  id                    BIGSERIAL PRIMARY KEY,
  fixture_id            BIGINT NOT NULL REFERENCES fixtures(id) ON DELETE CASCADE,
  team_id               BIGINT REFERENCES teams(id) ON DELETE CASCADE,
  player_id             BIGINT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  minutes               INT,
  rating                NUMERIC(4,2),
  position              TEXT,
  captain               BOOLEAN,
  substitute            BOOLEAN,
  offsides              INT,
  shots_total           INT,
  shots_on_target       INT,
  goals                 INT,
  conceded_goals        INT,
  assists               INT,
  saves                 INT,
  passes_total          INT,
  passes_accurate       INT,
  key_passes            INT,
  tackles               INT,
  blocks                INT,
  interceptions         INT,
  clearances            INT,
  duels_total           INT,
  duels_won             INT,
  dribbles_attempts     INT,
  dribbles_success      INT,
  fouls_committed       INT,
  fouls_drawn           INT,
  yellow_cards          INT,
  second_yellow         INT,
  red_cards             INT,
  penalties_won         INT,
  penalties_committed   INT,
  penalty_goals         INT,
  penalty_missed        INT,
  penalty_saved         INT,
  clean_sheet           BOOLEAN,
  expected_goals        NUMERIC(8,3),
  expected_assists      NUMERIC(8,3),
  minutes_90_adjusted   NUMERIC(8,3),
  extra_stats           JSONB NOT NULL DEFAULT '{}'::jsonb,
  raw                   JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_player_match_stats UNIQUE (fixture_id, player_id)
);
CREATE INDEX ix_player_match_stats_fixture ON player_match_statistics (fixture_id);
CREATE INDEX ix_player_match_stats_player ON player_match_statistics (player_id);
CREATE INDEX ix_player_match_stats_team ON player_match_statistics (team_id);

-- ---------------------------------------------------------------------------
-- Lineups
-- ---------------------------------------------------------------------------
CREATE TABLE lineups (
  id                BIGSERIAL PRIMARY KEY,
  fixture_id        BIGINT NOT NULL REFERENCES fixtures(id) ON DELETE CASCADE,
  team_id           BIGINT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  formation         TEXT,
  coach_name        TEXT,
  coach_id          TEXT,
  raw               JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_lineups UNIQUE (fixture_id, team_id)
);

CREATE TABLE lineup_players (
  id            BIGSERIAL PRIMARY KEY,
  lineup_id     BIGINT NOT NULL REFERENCES lineups(id) ON DELETE CASCADE,
  player_id     BIGINT REFERENCES players(id),
  team_id       BIGINT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  number        INT,
  name          TEXT,
  position      TEXT,
  grid_position TEXT,
  is_starting   BOOLEAN NOT NULL DEFAULT FALSE,
  is_substitute BOOLEAN NOT NULL DEFAULT FALSE,
  captain       BOOLEAN,
  minutes       INT,
  raw           JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_lineup_players UNIQUE (lineup_id, player_id, number, name)
);
CREATE INDEX ix_lineup_players_player ON lineup_players (player_id);

-- ---------------------------------------------------------------------------
-- Standings
-- ---------------------------------------------------------------------------
CREATE TABLE standings (
  id                    BIGSERIAL PRIMARY KEY,
  competition_season_id BIGINT NOT NULL REFERENCES competition_seasons(id) ON DELETE CASCADE,
  group_name            TEXT,
  form                  TEXT,
  description           TEXT,
  raw                   JSONB NOT NULL DEFAULT '{}'::jsonb,
  fetched_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ix_standings_cs ON standings (competition_season_id);

CREATE TABLE standing_rows (
  id                BIGSERIAL PRIMARY KEY,
  standings_id      BIGINT NOT NULL REFERENCES standings(id) ON DELETE CASCADE,
  team_id           BIGINT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  rank              INT,
  points            INT,
  played            INT,
  wins              INT,
  draws             INT,
  losses            INT,
  goals_for         INT,
  goals_against     INT,
  goal_diff         INT,
  form              TEXT,
  description       TEXT,
  status            TEXT,
  all_stats         JSONB,       -- provider "all"/"home"/"away"/"goals_for"/"goals_against" split
  home_stats        JSONB,
  away_stats        JSONB,
  raw               JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_standing_rows UNIQUE (standings_id, team_id)
);
CREATE INDEX ix_standing_rows_team ON standing_rows (team_id);

-- ---------------------------------------------------------------------------
-- Injuries / availability
-- ---------------------------------------------------------------------------
CREATE TABLE sidelined_records (
  id                BIGSERIAL PRIMARY KEY,
  player_id         BIGINT REFERENCES players(id) ON DELETE CASCADE,
  team_id           BIGINT REFERENCES teams(id),
  competition_id    BIGINT REFERENCES competitions(id),
  season_id         BIGINT REFERENCES seasons(id),
  type              TEXT,        -- injury | suspension | illness | absence ...
  reason            TEXT,
  start_date        DATE,
  end_date          DATE,
  provider_endpoint TEXT,
  provider          TEXT NOT NULL DEFAULT 'api-football',
  provider_id       TEXT,
  raw               JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_sidelined_provider UNIQUE (provider, provider_id)
);
CREATE INDEX ix_sidelined_player ON sidelined_records (player_id, start_date);
CREATE INDEX ix_sidelined_team ON sidelined_records (team_id);

-- ---------------------------------------------------------------------------
-- Transfers
-- ---------------------------------------------------------------------------
CREATE TABLE transfers (
  id                  BIGSERIAL PRIMARY KEY,
  player_id           BIGINT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  from_team_id        BIGINT REFERENCES teams(id),
  to_team_id          BIGINT REFERENCES teams(id),
  transfer_date       DATE,
  transfer_type       TEXT,   -- transfer | loan | loan_end | free | swap | release ...
  fee_note            TEXT,
  provider_event_id   TEXT,
  provider            TEXT NOT NULL DEFAULT 'api-football',
  raw                 JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_transfers UNIQUE (player_id, from_team_id, to_team_id, transfer_date, transfer_type, provider_event_id)
);
CREATE INDEX ix_transfers_date ON transfers (transfer_date);

-- ---------------------------------------------------------------------------
-- Odds (kept separate from football statistics)
-- ---------------------------------------------------------------------------
CREATE TABLE bookmakers (
  id            BIGSERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  provider      TEXT NOT NULL DEFAULT 'api-football',
  provider_id   TEXT,
  raw           JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_bookmakers UNIQUE (provider, provider_id)
);

CREATE TABLE odds (
  id                BIGSERIAL PRIMARY KEY,
  fixture_id        BIGINT NOT NULL REFERENCES fixtures(id) ON DELETE CASCADE,
  bookmaker_id      BIGINT NOT NULL REFERENCES bookmakers(id) ON DELETE CASCADE,
  market_name       TEXT,
  market_id         TEXT,
  raw               JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_odds UNIQUE (fixture_id, bookmaker_id, market_id, market_name)
);

CREATE TABLE odds_values (
  id            BIGSERIAL PRIMARY KEY,
  odds_id       BIGINT NOT NULL REFERENCES odds(id) ON DELETE CASCADE,
  value_name    TEXT,
  value_id      TEXT,
  odds          NUMERIC(10,4),
  recorded_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  raw           JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_odds_values UNIQUE (odds_id, value_id, value_name)
);

-- ---------------------------------------------------------------------------
-- Season aggregates (players, referees)
-- ---------------------------------------------------------------------------
CREATE TABLE player_season_statistics (
  id                    BIGSERIAL PRIMARY KEY,
  player_id             BIGINT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  team_id               BIGINT REFERENCES teams(id) ON DELETE CASCADE,
  competition_id        BIGINT NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
  season_id             BIGINT NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
  appearances           INT,
  lineups               INT,
  minutes               INT,
  goals                 INT,
  assists               INT,
  conceded_goals        INT,
  saves                 INT,
  yellow_cards          INT,
  second_yellow         INT,
  red_cards             INT,
  shots_total           INT,
  shots_on_target       INT,
  key_passes            INT,
  passes_total          INT,
  passes_accurate       INT,
  tackles               INT,
  interceptions         INT,
  blocks                INT,
  clearances            INT,
  duels_total           INT,
  duels_won             INT,
  dribbles_attempts     INT,
  dribbles_success      INT,
  fouls_committed       INT,
  fouls_drawn           INT,
  offsides              INT,
  penalties_won         INT,
  penalties_committed   INT,
  penalty_goals         INT,
  penalty_missed        INT,
  clean_sheets          INT,
  expected_goals        NUMERIC(8,3),
  expected_assists      NUMERIC(8,3),
  is_provider_fetched   BOOLEAN NOT NULL DEFAULT FALSE,
  is_local_derived      BOOLEAN NOT NULL DEFAULT TRUE,
  raw                   JSONB NOT NULL DEFAULT '{}'::jsonb,
  calculated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_player_season_stats UNIQUE (player_id, team_id, competition_id, season_id)
);
CREATE INDEX ix_player_season_stats_player ON player_season_statistics (player_id, season_id);

CREATE TABLE referee_match_statistics (
  id                  BIGSERIAL PRIMARY KEY,
  referee_id          BIGINT NOT NULL REFERENCES referees(id) ON DELETE CASCADE,
  fixture_id          BIGINT NOT NULL REFERENCES fixtures(id) ON DELETE CASCADE,
  yellow_home         INT,
  yellow_away         INT,
  second_yellow       INT,
  red_cards           INT,
  fouls               INT,
  penalties           INT,
  matches             INT NOT NULL DEFAULT 1,
  is_local_derived    BOOLEAN NOT NULL DEFAULT TRUE,
  raw                 JSONB NOT NULL DEFAULT '{}'::jsonb,
  calculated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_referee_match_stats UNIQUE (referee_id, fixture_id)
);
CREATE INDEX ix_referee_match_stats_fixture ON referee_match_statistics (fixture_id);

CREATE TABLE referee_season_statistics (
  id                      BIGSERIAL PRIMARY KEY,
  referee_id              BIGINT NOT NULL REFERENCES referees(id) ON DELETE CASCADE,
  season_id               BIGINT NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
  competition_id          BIGINT NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
  matches                 INT NOT NULL DEFAULT 0,
  home_wins               INT,
  draws                   INT,
  away_wins               INT,
  yellow_cards            INT,
  yellow_per_match        NUMERIC(6,2),
  second_yellow           INT,
  red_cards               INT,
  red_per_match           NUMERIC(6,2),
  total_cards             INT,
  cards_per_match         NUMERIC(6,2),
  fouls                   INT,
  fouls_per_match         NUMERIC(6,2),
  penalties               INT,
  penalties_per_match     NUMERIC(6,2),
  home_cards              INT,
  away_cards              INT,
  home_cards_per_match    NUMERIC(6,2),
  away_cards_per_match    NUMERIC(6,2),
  last_5                  JSONB,
  last_10                 JSONB,
  last_20                 JSONB,
  is_local_derived        BOOLEAN NOT NULL DEFAULT TRUE,
  raw                     JSONB NOT NULL DEFAULT '{}'::jsonb,
  calculated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_referee_season_stats UNIQUE (referee_id, season_id, competition_id)
);

CREATE TABLE referee_competition_statistics (
  id                      BIGSERIAL PRIMARY KEY,
  referee_id              BIGINT NOT NULL REFERENCES referees(id) ON DELETE CASCADE,
  competition_id          BIGINT NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
  matches                 INT NOT NULL DEFAULT 0,
  yellow_per_match        NUMERIC(6,2),
  red_per_match           NUMERIC(6,2),
  cards_per_match         NUMERIC(6,2),
  fouls_per_match         NUMERIC(6,2),
  penalties_per_match     NUMERIC(6,2),
  home_cards_per_match    NUMERIC(6,2),
  away_cards_per_match    NUMERIC(6,2),
  aggregates              JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_local_derived        BOOLEAN NOT NULL DEFAULT TRUE,
  calculated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_referee_competition_stats UNIQUE (referee_id, competition_id)
);

-- ---------------------------------------------------------------------------
-- Derived analytics
-- ---------------------------------------------------------------------------
CREATE TABLE team_competition_season_stats (
  id                      BIGSERIAL PRIMARY KEY,
  team_id                 BIGINT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  competition_id          BIGINT NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
  season_id               BIGINT NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
  matches                 INT NOT NULL DEFAULT 0,
  wins                    INT, draws INT, losses INT,
  home_matches            INT, home_wins INT, home_draws INT, home_losses INT,
  away_matches            INT, away_wins INT, away_draws INT, away_losses INT,
  goals_for               INT, goals_against INT, goal_diff INT,
  avg_goals_scored        NUMERIC(6,2),
  avg_goals_conceded      NUMERIC(6,2),
  clean_sheets            INT,
  failed_to_score         INT,
  btts                    INT,
  yellow_cards            INT,
  red_cards               INT,
  total_cards             INT,
  fouls                   INT,
  corners                 INT,
  shots                   INT,
  shots_on_target         INT,
  possession_avg          NUMERIC(5,2),
  expected_goals          NUMERIC(8,3),
  last_5                  JSONB,
  last_10                 JSONB,
  last_20                 JSONB,
  home_form               JSONB,
  away_form               JSONB,
  streaks                 JSONB,
  is_local_derived        BOOLEAN NOT NULL DEFAULT TRUE,
  calculated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_team_cseason_stats UNIQUE (team_id, competition_id, season_id)
);
CREATE INDEX ix_team_cseason_stats_team ON team_competition_season_stats (team_id, season_id);

CREATE TABLE league_season_statistics (
  id                      BIGSERIAL PRIMARY KEY,
  competition_id          BIGINT NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
  season_id               BIGINT NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
  matches                 INT NOT NULL DEFAULT 0,
  completed_matches       INT,
  goals                   INT,
  goals_per_match         NUMERIC(6,2),
  home_goals              INT,
  away_goals              INT,
  home_wins               INT,
  draws                   INT,
  away_wins               INT,
  btts_pct                NUMERIC(5,2),
  clean_sheet_pct         NUMERIC(5,2),
  failed_to_score_pct     NUMERIC(5,2),
  yellow_cards            INT,
  yellow_per_match        NUMERIC(6,2),
  second_yellow           INT,
  red_cards               INT,
  red_per_match           NUMERIC(6,2),
  total_cards             INT,
  cards_per_match         NUMERIC(6,2),
  fouls                   INT,
  fouls_per_match         NUMERIC(6,2),
  penalties               INT,
  penalties_per_match     NUMERIC(6,2),
  corners                 INT,
  corners_per_match       NUMERIC(6,2),
  shots                   INT,
  shots_per_match         NUMERIC(6,2),
  shots_on_target         INT,
  sot_per_match           NUMERIC(6,2),
  possession_avg          NUMERIC(5,2),
  expected_goals          NUMERIC(8,3),
  is_local_derived        BOOLEAN NOT NULL DEFAULT TRUE,
  calculated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_league_season_stats UNIQUE (competition_id, season_id)
);

-- H2H snapshots per pair + season-scope-agnostic (all stored fixtures)
CREATE TABLE h2h_stats (
  id                      BIGSERIAL PRIMARY KEY,
  team_a_id               BIGINT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  team_b_id               BIGINT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  window_size             INT NOT NULL DEFAULT 20,
  fixtures_count          INT,
  a_wins                  INT,
  b_wins                  INT,
  draws                   INT,
  goals_a                 INT,
  goals_b                 INT,
  btts                    INT,
  clean_sheets_a          INT,
  clean_sheets_b          INT,
  cards_total             INT,
  corners_total           INT,
  last_meetings           JSONB,
  is_local_derived        BOOLEAN NOT NULL DEFAULT TRUE,
  calculated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_h2h UNIQUE (team_a_id, team_b_id, window_size),
  CONSTRAINT ck_h2h_teams CHECK (team_a_id <> team_b_id)
);

-- ---------------------------------------------------------------------------
-- Prediction features
-- ---------------------------------------------------------------------------
CREATE TABLE prediction_features (
  id                    BIGSERIAL PRIMARY KEY,
  fixture_id            BIGINT NOT NULL REFERENCES fixtures(id) ON DELETE CASCADE,
  competition_id        BIGINT REFERENCES competitions(id),
  season_id             BIGINT REFERENCES seasons(id),
  home_team_id          BIGINT REFERENCES teams(id),
  away_team_id          BIGINT REFERENCES teams(id),
  -- recent form summaries (W/D/L strings + points per game)
  home_form             JSONB,
  away_form             JSONB,
  home_home_form        JSONB,
  away_away_form        JSONB,
  -- rate features
  home_goals_avg        NUMERIC(6,3),
  away_goals_avg        NUMERIC(6,3),
  home_conceded_avg     NUMERIC(6,3),
  away_conceded_avg     NUMERIC(6,3),
  home_shots_avg        NUMERIC(6,2),
  away_shots_avg        NUMERIC(6,2),
  home_sot_avg          NUMERIC(6,2),
  away_sot_avg          NUMERIC(6,2),
  home_possession_avg   NUMERIC(5,2),
  away_possession_avg   NUMERIC(5,2),
  home_corners_avg      NUMERIC(6,2),
  away_corners_avg      NUMERIC(6,2),
  home_cards_avg        NUMERIC(6,2),
  away_cards_avg        NUMERIC(6,2),
  home_fouls_avg        NUMERIC(6,2),
  away_fouls_avg        NUMERIC(6,2),
  home_clean_sheet_rate NUMERIC(5,3),
  away_clean_sheet_rate NUMERIC(5,3),
  home_fts_rate         NUMERIC(5,3),
  away_fts_rate         NUMERIC(5,3),
  home_btts_rate        NUMERIC(5,3),
  away_btts_rate        NUMERIC(5,3),
  league_avg_goals      NUMERIC(6,3),
  league_avg_cards      NUMERIC(6,2),
  referee_id            BIGINT REFERENCES referees(id),
  referee_features      JSONB,
  home_team_stats       JSONB,
  away_team_stats       JSONB,
  league_stats          JSONB,
  player_availability   JSONB,
  h2h                   JSONB,
  lineups_available     JSONB,
  data_freshness        JSONB,
  raw                   JSONB NOT NULL DEFAULT '{}'::jsonb,
  calculated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_prediction_features UNIQUE (fixture_id)
);
CREATE INDEX ix_prediction_features_teams ON prediction_features (home_team_id, away_team_id);

-- ---------------------------------------------------------------------------
-- Raw provider storage + request log + quota
-- ---------------------------------------------------------------------------
CREATE TABLE raw_provider_payloads (
  id                    BIGSERIAL PRIMARY KEY,
  provider              TEXT NOT NULL DEFAULT 'api-football',
  endpoint              TEXT NOT NULL,
  request_param_hash    TEXT NOT NULL,
  request_params        JSONB,             -- never contains secrets
  entity_type           TEXT,
  provider_entity_id    TEXT,
  fixture_id            BIGINT,
  competition_id        BIGINT,
  season_id             BIGINT,
  response_json         JSONB NOT NULL,
  http_status           INT,
  response_hash         TEXT,
  fetched_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ix_raw_payloads_lookup ON raw_provider_payloads (provider, endpoint, request_param_hash);
CREATE INDEX ix_raw_payloads_entity ON raw_provider_payloads (entity_type, provider_entity_id);
CREATE INDEX ix_raw_payloads_fixture ON raw_provider_payloads (fixture_id);
CREATE INDEX ix_raw_payloads_time ON raw_provider_payloads (fetched_at);

CREATE TABLE provider_requests (
  id                    BIGSERIAL PRIMARY KEY,
  provider              TEXT NOT NULL DEFAULT 'api-football',
  endpoint              TEXT NOT NULL,
  http_method           TEXT NOT NULL DEFAULT 'GET',
  request_param_hash    TEXT,
  started_at            TIMESTAMPTZ NOT NULL,
  completed_at          TIMESTAMPTZ,
  duration_ms           INT,
  http_status           INT,
  success               BOOLEAN,
  cache_hit             BOOLEAN NOT NULL DEFAULT FALSE,
  daily_quota_remaining INT,
  minute_quota_remaining INT,
  sync_task             TEXT,
  error_message         TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ix_provider_requests_date ON provider_requests (started_at);
CREATE INDEX ix_provider_requests_endpoint ON provider_requests (endpoint);

CREATE TABLE provider_quota (
  id                BIGSERIAL PRIMARY KEY,
  provider          TEXT NOT NULL DEFAULT 'api-football',
  day               DATE NOT NULL,
  daily_limit       INT NOT NULL,
  daily_used        INT NOT NULL DEFAULT 0,
  daily_remaining   INT NOT NULL,
  minute_limit      INT NOT NULL,
  minute_used       INT NOT NULL DEFAULT 0,
  minute_remaining  INT NOT NULL,
  minute_window_start TIMESTAMPTZ NOT NULL DEFAULT now(),
  state             TEXT NOT NULL DEFAULT 'NORMAL',   -- NORMAL | CAUTION | CRITICAL
  last_updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  raw               JSONB NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT uq_provider_quota_day UNIQUE (provider, day)
);

-- ---------------------------------------------------------------------------
-- Sync engine
-- ---------------------------------------------------------------------------
CREATE TABLE sync_jobs (
  id                BIGSERIAL PRIMARY KEY,
  job_key           TEXT NOT NULL,
  kind              TEXT NOT NULL,     -- historical-import | live-sync | postmatch ...
  params            JSONB NOT NULL DEFAULT '{}'::jsonb,
  status            TEXT NOT NULL DEFAULT 'pending', -- pending | running | done | failed | canceled
  priority          INT NOT NULL DEFAULT 100,
  tasks_total       INT NOT NULL DEFAULT 0,
  tasks_done        INT NOT NULL DEFAULT 0,
  tasks_failed      INT NOT NULL DEFAULT 0,
  started_at        TIMESTAMPTZ,
  completed_at      TIMESTAMPTZ,
  error             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_sync_jobs_key UNIQUE (job_key)
);

CREATE TABLE sync_tasks (
  id                BIGSERIAL PRIMARY KEY,
  job_id            BIGINT REFERENCES sync_jobs(id) ON DELETE CASCADE,
  task_key          TEXT NOT NULL,
  task_type         TEXT NOT NULL,      -- fixtures:import, events:fetch, ...
  params            JSONB NOT NULL DEFAULT '{}'::jsonb,
  priority          INT NOT NULL DEFAULT 100,
  status            TEXT NOT NULL DEFAULT 'pending', -- pending | running | done | failed | skipped
  attempts          INT NOT NULL DEFAULT 0,
  max_attempts      INT NOT NULL DEFAULT 5,
  scheduled_for     TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at        TIMESTAMPTZ,
  completed_at      TIMESTAMPTZ,
  duration_ms       INT,
  result_summary    JSONB,
  last_error        TEXT,
  error_info        JSONB,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_sync_tasks_key UNIQUE (task_key)
);
CREATE INDEX ix_sync_tasks_dispatch ON sync_tasks (status, priority, scheduled_for);
CREATE INDEX ix_sync_tasks_job ON sync_tasks (job_id, status);

CREATE TABLE sync_state (
  id                BIGSERIAL PRIMARY KEY,
  state_key         TEXT NOT NULL,
  state             JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_sync_state_key UNIQUE (state_key)
);

-- ---------------------------------------------------------------------------
-- Our own API-key system
-- ---------------------------------------------------------------------------
CREATE TABLE api_clients (
  id                    BIGSERIAL PRIMARY KEY,
  name                  TEXT NOT NULL,
  description           TEXT,
  client_type           TEXT NOT NULL DEFAULT 'application', -- prediction_app | website | mobile | admin | internal
  active                BOOLEAN NOT NULL DEFAULT TRUE,
  rate_limit_per_minute INT NOT NULL DEFAULT 60,
  rate_limit_per_day    INT NOT NULL DEFAULT 10000,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_api_clients_name UNIQUE (name)
);

CREATE TABLE api_keys (
  id                BIGSERIAL PRIMARY KEY,
  client_id         BIGINT NOT NULL REFERENCES api_clients(id) ON DELETE CASCADE,
  key_prefix        TEXT NOT NULL,          -- e.g. pf_live_Ab12Cd34  (lookup handle)
  key_hash          TEXT NOT NULL,          -- sha256 hex of full key — raw key never stored
  scopes            TEXT[] NOT NULL DEFAULT '{}',
  label             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at      TIMESTAMPTZ,
  expires_at        TIMESTAMPTZ,
  revoked_at        TIMESTAMPTZ,
  revoked_reason    TEXT,
  rotated_from      BIGINT REFERENCES api_keys(id),
  grace_until       TIMESTAMPTZ,            -- during rotation: old key valid until
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_api_keys_prefix UNIQUE (key_prefix)
);
CREATE INDEX ix_api_keys_hash ON api_keys (key_hash);
CREATE INDEX ix_api_keys_client ON api_keys (client_id);

CREATE TABLE api_usage (
  id                  BIGSERIAL PRIMARY KEY,
  api_key_id          BIGINT REFERENCES api_keys(id) ON DELETE SET NULL,
  client_id           BIGINT REFERENCES api_clients(id) ON DELETE SET NULL,
  date                DATE NOT NULL DEFAULT (now() AT TIME ZONE 'utc')::date,
  endpoint            TEXT NOT NULL,
  requests            INT NOT NULL DEFAULT 1,
  successful_requests INT NOT NULL DEFAULT 0,
  failed_requests     INT NOT NULL DEFAULT 0,
  rate_limited_requests INT NOT NULL DEFAULT 0,
  last_used_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_api_usage UNIQUE (api_key_id, client_id, date, endpoint)
);
CREATE INDEX ix_api_usage_client_date ON api_usage (client_id, date);

CREATE TABLE api_audit_log (
  id            BIGSERIAL PRIMARY KEY,
  actor         TEXT NOT NULL,
  action        TEXT NOT NULL,      -- key.create | key.rotate | key.revoke | client.create | ...
  client_id     BIGINT,
  api_key_id    BIGINT,
  details       JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Data quality results
-- ---------------------------------------------------------------------------
CREATE TABLE data_quality_results (
  id            BIGSERIAL PRIMARY KEY,
  check_key     TEXT NOT NULL,
  status        TEXT NOT NULL,      -- PASS | WARN | FAIL
  message       TEXT,
  details       JSONB NOT NULL DEFAULT '{}'::jsonb,
  checked_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ix_data_quality_time ON data_quality_results (checked_at DESC);
