-- WS6 milestone 3 — runners table.
--
-- The job queue (0003_jobs.sql) tracks WORK but has no view of which
-- workers are alive. Operators asked for `signalman runner list` to
-- see registered workers and their last-seen timestamps so they can
-- diagnose "is anyone polling the queue?" and "did builder-mac-01
-- drop off?".
--
-- Shape:
--   * `last_seen_at` is updated on every heartbeat POST (default
--     30s cadence; configurable per worker).
--   * "Stale" is computed at read time from `last_seen_at` plus a
--     threshold (90s by default). Stored derived state would need a
--     background sweeper; reading-time computation is simpler and
--     just as accurate from the operator's perspective.
--   * Deregistration is a soft-delete (deleted_at IS NOT NULL),
--     consistent with the rest of the schema.
--   * `meta` is a JSON column for hostname, version, etc — diagnostic
--     only; not used by the queue dispatcher.
--
-- Same SQL applies to SQLite and Postgres (per the 0001_init.sql
-- conventions header).

CREATE TABLE runner (
  id             TEXT PRIMARY KEY,
  org_id         TEXT NOT NULL REFERENCES org (id),
  name           TEXT NOT NULL,
  last_seen_at   TEXT NOT NULL,
  registered_at  TEXT NOT NULL,
  meta           TEXT,                 -- JSON; nullable
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  deleted_at     TEXT
);

-- Active-name uniqueness per org. Re-registering an existing worker
-- under the same name reuses its row (upsert at the repo layer)
-- rather than failing; the unique index is here to prevent two
-- distinct rows ever sharing a (org_id, name) tuple while both are
-- active.
CREATE UNIQUE INDEX runner_unique_active_name_idx ON runner (org_id, name)
  WHERE deleted_at IS NULL;

-- Recency-ordered scan by org. `runner list` reads `ORDER BY
-- last_seen_at DESC` so this index covers the common path.
CREATE INDEX runner_org_idx ON runner (org_id, last_seen_at DESC)
  WHERE deleted_at IS NULL;
