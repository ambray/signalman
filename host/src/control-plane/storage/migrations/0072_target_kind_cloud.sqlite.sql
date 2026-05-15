-- v0.4.x (WS6 M8) — SQLite path.
--
-- Extend `target.kind` CHECK to include the two new cloud-routed
-- kinds:
--   * cloud_vm    — pinned to a CloudInstanceHandle. Deploy routes
--                   through the connection_descriptor produced by
--                   signalman_cloud_connection_descriptor (today:
--                   public_mtls only; SSM/Bastion tunneling drivers
--                   are v0.3.x).
--   * cloud_stack — pinned to an OpenTofu stack. Deploy = re-apply
--                   the stack with per-release variables overridden
--                   (release_tag, release_id, release_commit_sha,
--                   plus an optional image_var_name override).
--
-- Append-only: existing rows are unaffected. The 0050_target_kind_k8s
-- table-recreate dance is reused because SQLite can't modify a CHECK
-- constraint in place. The Postgres counterpart
-- (0072_target_kind_cloud.pg.sql) is a simple
-- DROP/ADD CONSTRAINT.

CREATE TABLE target_new (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL REFERENCES org (id),
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('vm_test', 'vm_demo', 'docker_test', 'docker_demo', 'k8s_test', 'k8s_demo', 'cloud_vm', 'cloud_stack')),
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
