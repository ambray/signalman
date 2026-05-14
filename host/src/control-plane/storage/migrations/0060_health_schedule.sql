-- v0.4.0-3 (Epic 3, sub-task WS3): scheduled health checks.
--
-- Periodic re-runs of `health check` against deployed targets without
-- an operator pulling the trigger. Pairs with audit-log retention so
-- flapping health is queryable historically and (once Epic 2 webhooks
-- land) with the event dispatcher for on-failure notifications.
--
-- A schedule is per-target and references one or more probe names from
-- the target's active release's `signalman.build.yaml`. The scheduler
-- loop wakes once per minute, finds schedules whose `last_run_at`
-- (or `created_at` if never run) is older than `interval_seconds`, and
-- invokes the existing probe runner against the target's current
-- active deployment. Results land in `health_check` like operator-
-- triggered runs.
--
-- `probe_ids_json` is a JSON array of probe names (the `name` field on
-- a Probe in build.yaml). An empty array means "all declared probes on
-- the active release" — matches the CLI's `health check` default.
--
-- `active` is INTEGER 0/1 (per the portability convention in
-- 0001_init.sql) so operators can disable a schedule without dropping
-- its row. The scheduler skips rows where active=0; soft-delete
-- (deleted_at IS NOT NULL) hides them from list queries entirely.

CREATE TABLE health_schedule (
  id                TEXT PRIMARY KEY,
  org_id            TEXT NOT NULL REFERENCES org (id),
  target_id         TEXT NOT NULL REFERENCES target (id),
  interval_seconds  INTEGER NOT NULL CHECK (interval_seconds >= 60),
  probe_ids_json    TEXT NOT NULL DEFAULT '[]',  -- JSON array of probe names
  last_run_at       TEXT,
  active            INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  deleted_at        TEXT
);
CREATE INDEX health_schedule_org_idx ON health_schedule (org_id) WHERE deleted_at IS NULL;
CREATE INDEX health_schedule_target_idx ON health_schedule (target_id) WHERE deleted_at IS NULL;
-- Partial index lets the scheduler's "find due" query stay sargable
-- without scanning soft-deleted or disabled rows.
CREATE INDEX health_schedule_due_idx
  ON health_schedule (last_run_at)
  WHERE deleted_at IS NULL AND active = 1;
