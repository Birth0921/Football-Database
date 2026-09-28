-- Strict importer scope: only approved competitions and 2023–2026 seasons.
-- Existing rows are retained but marked inactive/out_of_scope so shared teams,
-- players and historical audit data remain safe.
ALTER TABLE competitions
  ADD COLUMN IF NOT EXISTS import_tier SMALLINT;

ALTER TABLE seasons
  ADD COLUMN IF NOT EXISTS import_scope TEXT NOT NULL DEFAULT 'in_scope';

ALTER TABLE competition_seasons
  ADD COLUMN IF NOT EXISTS historical_imported_at TIMESTAMPTZ;

ALTER TABLE seasons
  DROP CONSTRAINT IF EXISTS ck_seasons_import_scope;
ALTER TABLE seasons
  ADD CONSTRAINT ck_seasons_import_scope CHECK (import_scope IN ('in_scope', 'out_of_scope'));

ALTER TABLE competitions
  DROP CONSTRAINT IF EXISTS ck_competitions_import_tier;
ALTER TABLE competitions
  ADD CONSTRAINT ck_competitions_import_tier CHECK (import_tier IS NULL OR import_tier BETWEEN 1 AND 3);

CREATE INDEX IF NOT EXISTS ix_competitions_import_scope
  ON competitions (active, import_tier, provider_id);
CREATE INDEX IF NOT EXISTS ix_seasons_import_scope
  ON seasons (import_scope, year);

-- Do not let stale rows outside the fixed season window remain importable.
UPDATE seasons
   SET import_scope = CASE WHEN year IN (2023, 2024, 2025, 2026) THEN 'in_scope' ELSE 'out_of_scope' END,
       is_current = (year = 2026),
       updated_at = now();
UPDATE competition_seasons cs
   SET import_scope = CASE WHEN se.year IN (2023, 2024, 2025, 2026) THEN 'in_scope' ELSE 'out_of_scope' END,
       is_current = (se.year = 2026),
       updated_at = now()
  FROM seasons se
 WHERE se.id = cs.season_id;
