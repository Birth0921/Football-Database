-- Read-only access for external consumers (e.g. a prediction app that trains
-- models on the warehouse) + a stable training view.
--
-- WHY: the REST API is the supported path for live predictions (it is cached,
-- rate-limited and quota-aware). Bulk model training, however, is happier
-- reading history directly. That consumer must never be able to change
-- anything, so it gets its own LOGIN role with SELECT only.
--
-- AFTER THIS MIGRATION (operator step — the password is never stored in git):
--   ALTER ROLE football_readonly PASSWORD '<strong-secret>';
-- Then give the app: TRAIN_DATABASE_URL=postgres://football_readonly:<secret>@host:5432/db?sslmode=require
--
-- On managed providers that forbid CREATE ROLE, the block below notices and
-- continues; create the role through the provider console and re-run
-- `npm run database:migrate` to apply the grants.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'football_readonly') THEN
    BEGIN
      CREATE ROLE football_readonly LOGIN;
      RAISE NOTICE 'created role football_readonly — set its password now: ALTER ROLE football_readonly PASSWORD ''<secret>'';';
    EXCEPTION
      WHEN insufficient_privilege THEN
        RAISE NOTICE 'cannot create role football_readonly (insufficient privilege) — create it via your provider console, then re-run migrations to apply the grants';
    END;
  END IF;
END $$;

-- Stable contract for consumers: completed matches with human-readable names.
-- Point-in-time features are NOT included — they must be computed by the
-- consumer with a strictly-before-kickoff window (see
-- examples/prediction-app/src/training/dataset.ts) to avoid look-ahead leakage.
CREATE OR REPLACE VIEW prediction_training_matches AS
SELECT f.id                 AS fixture_id,
       f.competition_id,
       c.name               AS competition_name,
       f.season_id,
       se.year              AS season_year,
       se.display_name      AS season_name,
       f.kickoff_utc,
       f.round,
       f.status_short,
       f.home_team_id,
       ht.name              AS home_team,
       f.away_team_id,
       at.name              AS away_team,
       f.home_score,
       f.away_score,
       f.home_score_ht,
       f.away_score_ht,
       f.venue_id,
       f.referee_id,
       f.finalized,
       f.last_synced_at
  FROM fixtures f
  JOIN competitions c  ON c.id = f.competition_id
  JOIN seasons se      ON se.id = f.season_id
  LEFT JOIN teams ht   ON ht.id = f.home_team_id
  LEFT JOIN teams at   ON at.id = f.away_team_id
 WHERE f.home_score IS NOT NULL
   AND f.away_score IS NOT NULL;

COMMENT ON VIEW prediction_training_matches IS
  'Read-only consumer contract: completed matches with team/competition names. No pre-match features — compute those point-in-time to avoid leakage.';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'football_readonly') THEN
    EXECUTE format('GRANT CONNECT ON DATABASE %I TO football_readonly', current_database());
    EXECUTE 'GRANT USAGE ON SCHEMA public TO football_readonly';
    EXECUTE 'GRANT SELECT ON ALL TABLES IN SCHEMA public TO football_readonly';
    EXECUTE 'GRANT SELECT ON prediction_training_matches TO football_readonly';
    -- tables created by future migrations stay readable
    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO football_readonly';
    RAISE NOTICE 'granted read-only access to football_readonly';
  ELSE
    RAISE NOTICE 'skipping grants — role football_readonly does not exist yet';
  END IF;
END $$;
