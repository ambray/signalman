-- v0.4.x (WS6 M8) — Postgres path. Mirrors the SQLite-side
-- 0072_target_kind_cloud.sqlite.sql which has to recreate the table
-- because SQLite can't modify a CHECK constraint in place.

ALTER TABLE target DROP CONSTRAINT IF EXISTS target_kind_check;
ALTER TABLE target
  ADD CONSTRAINT target_kind_check
  CHECK (kind IN ('vm_test', 'vm_demo', 'docker_test', 'docker_demo', 'k8s_test', 'k8s_demo', 'cloud_vm', 'cloud_stack'));
