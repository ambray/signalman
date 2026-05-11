-- Persist the parsed signalman.build.yaml alongside each release so the
-- deploy executor (PR 4) can re-read declared health probes, and future
-- PRs (install grammar) can re-read other declarations, without
-- recloning the source tree.
--
-- Stored as JSON in a TEXT column for SQLite/Postgres portability.
-- Nullable for backfill compatibility with releases built before this
-- migration (only relevant in long-lived dev databases; the v0.2
-- catalog is local-only and resets are cheap).

ALTER TABLE release ADD COLUMN build_yaml_json TEXT;
