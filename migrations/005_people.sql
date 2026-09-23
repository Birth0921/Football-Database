-- 005: Availability (injuries/sidelined) and transfers.

CREATE TABLE IF NOT EXISTS sidelined_records (
  id                    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider              TEXT NOT NULL DEFAULT 'api-football',
  provider_source       TEXT NOT NULL,          -- 'injuries' | 'sidelined'
  player_id             BIGINT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  team_id               BIGINT REFERENCES teams(id) ON DELETE SET NULL,
  fixture_id            BIGINT REFERENCES fixtures(id) ON DELETE SET NULL,
  competition_season_id BIGINT REFERENCES competition_seasons(id) ON DELETE SET NULL,
  record_type           TEXT NOT NULL,          -- 'injury' | 'suspension' | 'missing' | 'unavailable'
  reason                TEXT,
  start_date            DATE,
  end_date              DATE,
  dedupe_key            TEXT NOT NULL,
  raw                   JSONB,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS sidelined_records_unique ON sidelined_records (dedupe_key);
CREATE INDEX IF NOT EXISTS sidelined_records_player_idx ON sidelined_records (player_id, end_date DESC);
CREATE INDEX IF NOT EXISTS sidelined_records_team_idx ON sidelined_records (team_id);

CREATE TABLE IF NOT EXISTS transfers (
  id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider            TEXT NOT NULL DEFAULT 'api-football',
  provider_transfer_id BIGINT,
  player_id           BIGINT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  source_team_id      BIGINT REFERENCES teams(id),
  destination_team_id BIGINT REFERENCES teams(id),
  transfer_date       DATE,
  transfer_type       TEXT,                     -- 'Free' | 'N/A' | 'Loan' | '€ 100M' | ...
  is_loan             BOOLEAN NOT NULL DEFAULT FALSE,
  fee                 TEXT,
  raw                 JSONB,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS transfers_unique
  ON transfers (player_id, coalesce(transfer_date, DATE '1900-01-01'), coalesce(source_team_id, -1), coalesce(destination_team_id, -1));
CREATE INDEX IF NOT EXISTS transfers_player_idx ON transfers (player_id, transfer_date DESC);
CREATE INDEX IF NOT EXISTS transfers_team_idx ON transfers (destination_team_id, transfer_date DESC);

-- ============ REFEREE STATISTICS (derived locally from stored fixtures/events) ============
CREATE TABLE IF NOT EXISTS referee_match_statistics (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  referee_id        BIGINT NOT NULL REFERENCES referees(id) ON DELETE CASCADE,
  fixture_id        BIGINT NOT NULL UNIQUE REFERENCES fixtures(id) ON DELETE CASCADE,
  competition_id    BIGINT REFERENCES competitions(id),
  competition_season_id BIGINT REFERENCES competition_seasons(id),
  match_date        DATE,
  home_team_id      BIGINT REFERENCES teams(id),
  away_team_id      BIGINT REFERENCES teams(id),
  home_wins         BOOLEAN NOT NULL DEFAULT FALSE,
  draws             BOOLEAN NOT NULL DEFAULT FALSE,
  away_wins         BOOLEAN NOT NULL DEFAULT FALSE,
  home_goals        INTEGER,
  away_goals        INTEGER,
  yellow_cards      INTEGER NOT NULL DEFAULT 0,
  second_yellow_cards INTEGER NOT NULL DEFAULT 0,
  red_cards         INTEGER NOT NULL DEFAULT 0,
  total_cards       INTEGER NOT NULL DEFAULT 0,
  home_team_cards   INTEGER NOT NULL DEFAULT 0,
  away_team_cards   INTEGER NOT NULL DEFAULT 0,
  fouls             INTEGER,
  penalties         INTEGER NOT NULL DEFAULT 0,
  corners           INTEGER,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS referee_match_stats_referee_idx ON referee_match_statistics (referee_id, match_date DESC);

CREATE TABLE IF NOT EXISTS referee_season_statistics (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  referee_id        BIGINT NOT NULL REFERENCES referees(id) ON DELETE CASCADE,
  competition_season_id BIGINT NOT NULL REFERENCES competition_seasons(id) ON DELETE CASCADE,
  matches           INTEGER NOT NULL DEFAULT 0,
  home_wins         INTEGER NOT NULL DEFAULT 0,
  draws             INTEGER NOT NULL DEFAULT 0,
  away_wins         INTEGER NOT NULL DEFAULT 0,
  yellow_cards      INTEGER NOT NULL DEFAULT 0,
  yellow_cards_per_match NUMERIC(6,3),
  second_yellow_cards INTEGER NOT NULL DEFAULT 0,
  red_cards         INTEGER NOT NULL DEFAULT 0,
  red_cards_per_match NUMERIC(6,3),
  total_cards       INTEGER NOT NULL DEFAULT 0,
  cards_per_match   NUMERIC(6,3),
  fouls             INTEGER,
  fouls_per_match   NUMERIC(6,3),
  penalties         INTEGER NOT NULL DEFAULT 0,
  penalties_per_match NUMERIC(6,3),
  home_team_cards   INTEGER NOT NULL DEFAULT 0,
  away_team_cards   INTEGER NOT NULL DEFAULT 0,
  home_cards_per_match NUMERIC(6,3),
  away_cards_per_match NUMERIC(6,3),
  corners           INTEGER,
  goals             INTEGER,
  last5             JSONB,
  last10            JSONB,
  last20            JSONB,
  last_calculated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS referee_season_stats_unique ON referee_season_statistics (referee_id, competition_season_id);

CREATE TABLE IF NOT EXISTS referee_competition_statistics (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  referee_id        BIGINT NOT NULL REFERENCES referees(id) ON DELETE CASCADE,
  competition_id    BIGINT NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
  matches           INTEGER NOT NULL DEFAULT 0,
  yellow_cards      INTEGER NOT NULL DEFAULT 0,
  red_cards         INTEGER NOT NULL DEFAULT 0,
  total_cards       INTEGER NOT NULL DEFAULT 0,
  cards_per_match   NUMERIC(6,3),
  fouls             INTEGER,
  fouls_per_match   NUMERIC(6,3),
  penalties         INTEGER NOT NULL DEFAULT 0,
  penalties_per_match NUMERIC(6,3),
  goals             INTEGER,
  last_calculated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS referee_competition_stats_unique ON referee_competition_statistics (referee_id, competition_id);

-- ============ ODDS (kept strictly separate from football statistics) ============
CREATE TABLE IF NOT EXISTS bookmakers (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider     TEXT NOT NULL DEFAULT 'api-football',
  provider_id  BIGINT NOT NULL,
  name         TEXT NOT NULL,
  logo_url     TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS bookmakers_provider_pid ON bookmakers (provider, provider_id);

CREATE TABLE IF NOT EXISTS odds (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  fixture_id    BIGINT NOT NULL REFERENCES fixtures(id) ON DELETE CASCADE,
  bookmaker_id  BIGINT NOT NULL REFERENCES bookmakers(id) ON DELETE CASCADE,
  market        TEXT NOT NULL,                 -- bet name: 'Match Winner', 'Over/Under', ...
  provider_updated_at TIMESTAMPTZ,
  raw           JSONB,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS odds_unique ON odds (fixture_id, bookmaker_id, market);

CREATE TABLE IF NOT EXISTS odds_values (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  odds_id       BIGINT NOT NULL REFERENCES odds(id) ON DELETE CASCADE,
  label         TEXT NOT NULL,                 -- 'Home' | 'Draw' | 'Away' | 'Over' | ...
  selection_name TEXT NOT NULL,                -- provider value.value e.g. 'Over 2.5'
  odd_value     NUMERIC(10,3) NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS odds_values_unique ON odds_values (odds_id, label, selection_name);
