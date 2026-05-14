-- v0.3.0-6 sub-task 1 (WS2 reserved block 0050-0059) — SQLite path.
--
-- Extend `target.kind` CHECK to include the new Kubernetes-routed
-- kinds `k8s_test` and `k8s_demo`. Append-only: existing rows are
-- unaffected.
--
-- SQLite cannot modify a CHECK constraint in place, so we use the
-- recommended "create new, copy, drop old, rename" dance. The
-- Postgres counterpart (`0050_target_kind_k8s.pg.sql`) is far
-- simpler — `ALTER TABLE target DROP CONSTRAINT / ADD CONSTRAINT`
-- — and the migration loader splits dialect-specific files via the
-- `.sqlite.sql` / `.pg.sql` suffixes.

CREATE TABLE target_new (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL REFERENCES org (id),
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('vm_test', 'vm_demo', 'docker_test', 'docker_demo', 'k8s_test', 'k8s_demo')),
  connection  TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  deleted_at  TEXT
);

INSERT INTO target_new (id, org_id, name, kind, connection, created_at, updated_at, deleted_at)
SELECT id, org_id, name, kind, connection, created_at, updated_at, deleted_at FROM target;

DROP TABLE target;

ALTER TABLE target_new RENAME TO target;

CREATE UNIQUE INDEX target_org_name_unique ON target (org_id, name) WHERE deleted_at IS NULL;
