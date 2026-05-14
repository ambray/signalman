-- v0.3.0-6 sub-task 1 (WS2 reserved block 0050-0059) — Postgres path.
--
-- The SQLite counterpart of this migration (0050_target_kind_k8s.sqlite.sql)
-- has to recreate the `target` table because SQLite cannot modify a
-- CHECK constraint in place. Postgres can; this file just rewrites
-- the constraint, which is far less invasive (no FK gymnastics).
--
-- The constraint is named after the table+column pair, which is
-- Postgres's default naming when no explicit constraint name is
-- given in the CREATE TABLE — matches the implicit name PG gave
-- the original CHECK in 0001_init.sql.

ALTER TABLE target DROP CONSTRAINT IF EXISTS target_kind_check;
ALTER TABLE target
  ADD CONSTRAINT target_kind_check
  CHECK (kind IN ('vm_test', 'vm_demo', 'docker_test', 'docker_demo', 'k8s_test', 'k8s_demo'));
