-- Rolling 4-season window support.
-- current_bootstrap_attempted_at: last one-time bootstrap attempt of a current
-- season pair. A bootstrap that returned no fixtures (schedule not published
-- yet at the start of a new season) is retried at most weekly; once fixtures
-- exist current_bootstrapped_at is set and the pair is never bootstrapped again.
ALTER TABLE competition_seasons
  ADD COLUMN IF NOT EXISTS current_bootstrap_attempted_at TIMESTAMPTZ;

-- A former current season that was bootstrapped is already imported: carry
-- the marker so it is never re-imported in full as "historical".
UPDATE competition_seasons cs
   SET historical_imported_at = cs.current_bootstrapped_at
  FROM seasons se
 WHERE se.id = cs.season_id
   AND se.year <> EXTRACT(YEAR FROM (now() AT TIME ZONE 'utc'))::int
   AND cs.historical_imported_at IS NULL
   AND cs.current_bootstrapped_at IS NOT NULL;
