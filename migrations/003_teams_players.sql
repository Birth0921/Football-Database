-- 003: Teams and players.

CREATE TABLE IF NOT EXISTS teams (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider     TEXT NOT NULL DEFAULT 'api-football',
  provider_id  BIGINT NOT NULL,
  name         TEXT NOT NULL,
  short_name   TEXT,
  code         TEXT,
  country_id   BIGINT REFERENCES countries(id),
  founded      INTEGER,
  logo_url     TEXT,
  is_national  BOOLEAN NOT NULL DEFAULT FALSE,
  venue_id     BIGINT REFERENCES venues(id),
  raw          JSONB,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS teams_provider_pid ON teams (provider, provider_id);

-- team participation in a competition season
CREATE TABLE IF NOT EXISTS team_seasons (
  id                    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  team_id               BIGINT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  competition_season_id BIGINT NOT NULL REFERENCES competition_seasons(id) ON DELETE CASCADE,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS team_seasons_unique ON team_seasons (team_id, competition_season_id);

CREATE TABLE IF NOT EXISTS coaches (
  id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider            TEXT NOT NULL DEFAULT 'api-football',
  provider_id         BIGINT,
  firstname           TEXT,
  lastname            TEXT,
  name                TEXT,
  age                 INTEGER,
  birth_date          DATE,
  birth_place         TEXT,
  country_id          BIGINT REFERENCES countries(id),
  photo_url           TEXT,
  team_id             BIGINT REFERENCES teams(id),
  career              JSONB,
  raw                 JSONB,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS coaches_provider_pid ON coaches (provider, coalesce(provider_id, -1));

CREATE TABLE IF NOT EXISTS team_coach_history (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  coach_id     BIGINT NOT NULL REFERENCES coaches(id) ON DELETE CASCADE,
  team_id      BIGINT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  start_date   DATE,
  end_date     DATE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS team_coach_history_unique
  ON team_coach_history (coach_id, team_id, coalesce(start_date, DATE '1900-01-01'));

CREATE TABLE IF NOT EXISTS players (
  id                    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider              TEXT NOT NULL DEFAULT 'api-football',
  provider_id           BIGINT NOT NULL,
  firstname             TEXT,
  lastname              TEXT,
  name                  TEXT NOT NULL,
  nationality_country_id BIGINT REFERENCES countries(id),
  birth_date            DATE,
  birth_place           TEXT,
  birth_country_id      BIGINT REFERENCES countries(id),
  age                   INTEGER,
  height_cm             INTEGER,
  weight_kg             INTEGER,
  injured               BOOLEAN,
  photo_url             TEXT,
  raw                   JSONB,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS players_provider_pid ON players (provider, provider_id);

CREATE TABLE IF NOT EXISTS referees (
  id                    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider              TEXT NOT NULL DEFAULT 'api-football',
  provider_id           BIGINT,
  name                  TEXT NOT NULL,
  name_key              TEXT NOT NULL,   -- normalized lowercase identity (provider gives no numeric id)
  firstname             TEXT,
  lastname              TEXT,
  nationality_country_id BIGINT REFERENCES countries(id),
  photo_url             TEXT,
  raw                   JSONB,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS referees_provider_name ON referees (provider, name_key);

-- a player may play for multiple teams in the same season
CREATE TABLE IF NOT EXISTS player_team_history (
  id                    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  player_id             BIGINT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  team_id               BIGINT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  competition_season_id BIGINT REFERENCES competition_seasons(id),
  team_type             TEXT,             -- 'club' | 'national'
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS player_team_history_unique
  ON player_team_history (player_id, team_id, coalesce(competition_season_id, -1));
