-- Competition profile (both genders and both team types are in scope; the
-- values are informational and let audits prove the men/women and
-- club/national mix) plus a one-time bootstrap marker for the CURRENT season.
ALTER TABLE competitions
  ADD COLUMN IF NOT EXISTS gender TEXT,
  ADD COLUMN IF NOT EXISTS team_type TEXT;

ALTER TABLE competitions DROP CONSTRAINT IF EXISTS ck_competitions_gender;
ALTER TABLE competitions
  ADD CONSTRAINT ck_competitions_gender CHECK (gender IS NULL OR gender IN ('men', 'women'));
ALTER TABLE competitions DROP CONSTRAINT IF EXISTS ck_competitions_team_type;
ALTER TABLE competitions
  ADD CONSTRAINT ck_competitions_team_type CHECK (team_type IS NULL OR team_type IN ('club', 'national'));

-- 2026 fixtures already played before continuous sync started are imported
-- exactly once per competition; afterwards only live/today/upcoming/recent
-- windows are requested (never a repeated full-season import).
ALTER TABLE competition_seasons
  ADD COLUMN IF NOT EXISTS current_bootstrapped_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS ix_competition_seasons_import_markers
  ON competition_seasons (import_scope, historical_imported_at, current_bootstrapped_at);
