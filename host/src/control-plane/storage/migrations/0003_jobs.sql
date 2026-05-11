-- Job queue for the submit-mode CLI / runner registration path
-- (PR 8a). A job is a unit of work submitted by an HTTP client (the
-- `signalman release build --remote` CLI, the future hosted-dashboard
-- UI, etc.) and claimed by a registered worker.
--
-- Lifecycle:
--   pending → claimed → running → succeeded
--                              \→ failed
--
-- Atomic claim is implemented at the repo layer with BEGIN IMMEDIATE
-- + UPDATE-with-WHERE on status='pending'. Postgres impl will use
-- SELECT ... FOR UPDATE SKIP LOCKED.
--
-- `kind` is a free-form identifier (e.g. 'release.build', 'noop'); the
-- worker dispatches on it. v0.3.0 ships `noop` and a stubbed
-- `release.build` (real remote build executor lands in PR 8b).

CREATE TABLE job (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES org (id),
  kind          TEXT NOT NULL,
  input         TEXT NOT NULL DEFAULT '{}',  -- JSON
  status        TEXT NOT NULL CHECK (status IN ('pending', 'claimed', 'running', 'succeeded', 'failed')),
  result        TEXT,                         -- JSON, set on success
  error         TEXT,                         -- string, set on failure
  claimed_by    TEXT,
  claimed_at    TEXT,
  started_at    TEXT,
  completed_at  TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  deleted_at    TEXT
);
CREATE INDEX job_pending_idx ON job (status, created_at)
  WHERE deleted_at IS NULL AND status = 'pending';
CREATE INDEX job_org_idx ON job (org_id, created_at) WHERE deleted_at IS NULL;
