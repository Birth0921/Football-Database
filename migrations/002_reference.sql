-- 002: Reference data — countries, venues, competitions, seasons,
-- competition/season join, coverage matrix, rounds.

CREATE TABLE IF NOT EXISTS countries (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider     TEXT NOT NULL DEFAULT 'api-football',
  provider_id  BIGINT,
  name         TEXT NOT NULL,
  code         TEXT,
  flag_url     TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS countries_provider_pid ON countries (provider, coalesce(provider_id, -1));
CREATE UNIQUE INDEX IF NOT EXISTS countries_provider_name ON countries (provider, lower(name));

CREATE TABLE IF NOT EXISTS venues (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider     TEXT NOT NULL DEFAULT 'api-football',
  provider_id  BIGINT,
  name         TEXT,
  address      TEXT,
  city         TEXT,
  country_id   BIGINT REFERENCES countries(id),
  capacity     BIGINT,
  surface      TEXT,
  image_url    TEXT,
  raw          JSONB,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS venues_provider_pid ON venues (provider, coalesce(provider_id, -1));

CREATE TABLE IF NOT EXISTS competitions (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider      TEXT NOT NULL DEFAULT 'api-football',
  provider_id   BIGINT NOT NULL,
  name          TEXT NOT NULL,
  type          TEXT CHECK (type IN ('league','cup')),
  country_id    BIGINT REFERENCES countries(id),
  logo_url      TEXT,
  raw           JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS competitions_provider_pid ON competitions (provider, provider_id);

CREATE TABLE IF NOT EXISTS seasons (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  year         INTEGER NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS seasons_year_key ON seasons (year);

CREATE TABLE IF NOT EXISTS competition_seasons (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  competition_id BIGINT NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
  season_id      BIGINT NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
  provider       TEXT NOT NULL DEFAULT 'api-football',
  provider_id    BIGINT,
  start_date     DATE,
  end_date       DATE,
  is_current     BOOLEAN NOT NULL DEFAULT FALSE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS competition_seasons_unique ON competition_seasons (competition_id, season_id);

CREATE TABLE IF NOT EXISTS competition_season_coverage (
  id                    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  competition_season_id BIGINT NOT NULL UNIQUE REFERENCES competition_seasons(id) ON DELETE CASCADE,
  events                BOOLEAN NOT NULL DEFAULT FALSE,
  lineups               BOOLEAN NOT NULL DEFAULT FALSE,
  fixture_statistics    BOOLEAN NOT NULL DEFAULT FALSE,
  player_statistics     BOOLEAN NOT NULL DEFAULT FALSE,
  standings             BOOLEAN NOT NULL DEFAULT FALSE,
  players               BOOLEAN NOT NULL DEFAULT FALSE,
  top_scorers           BOOLEAN NOT NULL DEFAULT FALSE,
  top_assists           BOOLEAN NOT NULL DEFAULT FALSE,
  top_cards             BOOLEAN NOT NULL DEFAULT FALSE,
  injuries              BOOLEAN NOT NULL DEFAULT FALSE,
  sidelined             BOOLEAN NOT NULL DEFAULT FALSE,
  predictions           BOOLEAN NOT NULL DEFAULT FALSE,
  odds                  BOOLEAN NOT NULL DEFAULT FALSE,
  raw                   JSONB,
  fetched_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS competition_rounds (
  id                    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  competition_season_id BIGINT NOT NULL REFERENCES competition_seasons(id) ON DELETE CASCADE,
  name                  TEXT NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS competition_rounds_unique ON competition_rounds (competition_season_id, name);
