-- One-time cleanup of queued work that can never succeed: competition/season-
-- or fixture-scoped tasks whose target no longer exists or lies outside the
-- approved import scope (inactive/untiered competition, season not in
-- 2023–2026, pair marked out_of_scope). They are marked 'skipped' (never
-- retried). The worker/scheduler re-apply the same rule at runtime, including
-- the provider-ID allowlist, so this migration only needs the DB-visible rules.
UPDATE sync_tasks t
   SET status = 'skipped',
       completed_at = now(),
       last_error = 'skipped: outside approved import scope (migration 0005)',
       result_summary = jsonb_build_object('skipped', true, 'reason', 'out_of_scope'),
       updated_at = now()
 WHERE t.status IN ('pending', 'failed')
   AND t.task_type IN ('fixtures:import', 'coverage:discover', 'teams:import', 'standings:sync', 'injuries:sync', 'odds:sync')
   AND NOT EXISTS (
     SELECT 1
       FROM competition_seasons cs
       JOIN competitions c ON c.id = cs.competition_id
       JOIN seasons se ON se.id = cs.season_id
      WHERE (t.params->>'competitionId') ~ '^[0-9]{1,18}$'
        AND (t.params->>'seasonId') ~ '^[0-9]{1,18}$'
        AND cs.competition_id = (t.params->>'competitionId')::bigint
        AND cs.season_id = (t.params->>'seasonId')::bigint
        AND c.active = TRUE AND c.import_tier BETWEEN 1 AND 3
        AND se.year IN (2023, 2024, 2025, 2026)
        AND se.import_scope = 'in_scope' AND cs.import_scope = 'in_scope');

UPDATE sync_tasks t
   SET status = 'skipped',
       completed_at = now(),
       last_error = 'skipped: outside approved import scope (migration 0005)',
       result_summary = jsonb_build_object('skipped', true, 'reason', 'out_of_scope'),
       updated_at = now()
 WHERE t.status IN ('pending', 'failed')
   AND t.task_type IN ('fixture:details', 'fixture:postmatch')
   AND NOT EXISTS (
     SELECT 1
       FROM fixtures f
       JOIN competitions c ON c.id = f.competition_id
       JOIN seasons se ON se.id = f.season_id
       JOIN competition_seasons cs ON cs.competition_id = f.competition_id AND cs.season_id = f.season_id
      WHERE (t.params->>'fixtureId') ~ '^[0-9]{1,18}$'
        AND f.id = (t.params->>'fixtureId')::bigint
        AND c.active = TRUE AND c.import_tier BETWEEN 1 AND 3
        AND se.year IN (2023, 2024, 2025, 2026)
        AND se.import_scope = 'in_scope' AND cs.import_scope = 'in_scope');

-- Supports the recurring scope sweep (task_type + queued status).
CREATE INDEX IF NOT EXISTS ix_sync_tasks_type_status ON sync_tasks (task_type, status);
