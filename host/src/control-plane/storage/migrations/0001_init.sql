-- Signalman control-plane initial schema.
-- See docs/design/meta-build-system.md §4.
--
-- Conventions for SQLite/Postgres portability:
--   * IDs are TEXT (ULIDs).
--   * Timestamps are TEXT in ISO-8601 UTC ('2026-05-10T12:34:56.789Z').
--   * Booleans are INTEGER 0/1 with CHECK constraints.
--   * JSON columns are TEXT; consumers parse on read.
--   * Soft-delete via deleted_at; queries must filter `deleted_at IS NULL`.
--
-- This migration is idempotent within a fresh database; the migration
-- runner records its application in the `_migrations` ledger.

-- ── Migration ledger ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS _migrations (
  version    INTEGER PRIMARY KEY,
  name       TEXT    NOT NULL,
  applied_at TEXT    NOT NULL
);

-- ── Tenancy ─────────────────────────────────────────────────────────
CREATE TABLE org (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  tier       TEXT NOT NULL DEFAULT 'free' CHECK (tier IN ('free', 'paid')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE UNIQUE INDEX org_name_unique ON org (name) WHERE deleted_at IS NULL;

CREATE TABLE api_key (
  id         TEXT PRIMARY KEY,
  org_id     TEXT NOT NULL REFERENCES org (id),
  prefix     TEXT NOT NULL,
  hash       TEXT NOT NULL,
  name       TEXT NOT NULL,
  expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX api_key_org_idx ON api_key (org_id) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX api_key_prefix_unique ON api_key (prefix) WHERE deleted_at IS NULL;

-- ── Products and releases ───────────────────────────────────────────
CREATE TABLE product (
  id               TEXT NOT NULL PRIMARY KEY,
  org_id           TEXT NOT NULL REFERENCES org (id),
  name             TEXT NOT NULL,
  repo_url         TEXT NOT NULL,
  build_yaml_path  TEXT NOT NULL DEFAULT 'signalman.build.yaml',
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  deleted_at       TEXT
);
CREATE UNIQUE INDEX product_org_name_unique ON product (org_id, name) WHERE deleted_at IS NULL;

CREATE TABLE release (
  id                  TEXT PRIMARY KEY,
  org_id              TEXT NOT NULL REFERENCES org (id),
  product_id          TEXT NOT NULL REFERENCES product (id),
  tag                 TEXT NOT NULL,
  commit_sha          TEXT NOT NULL,
  manifest_sha256     TEXT,
  signed_by           TEXT,
  built_at            TEXT,
  built_by_runner_id  TEXT,
  status              TEXT NOT NULL CHECK (status IN ('building', 'ready', 'failed')),
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  deleted_at          TEXT
);
CREATE INDEX release_product_idx ON release (product_id) WHERE deleted_at IS NULL;
CREATE INDEX release_status_idx ON release (status) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX release_product_tag_unique ON release (product_id, tag) WHERE deleted_at IS NULL;

CREATE TABLE artifact (
  id          TEXT PRIMARY KEY,
  release_id  TEXT NOT NULL REFERENCES release (id),
  component   TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('blob', 'image_ref')),
  sha256      TEXT,
  size_bytes  INTEGER,
  blob_uri    TEXT,
  image_ref   TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  deleted_at  TEXT
);
CREATE INDEX artifact_release_idx ON artifact (release_id) WHERE deleted_at IS NULL;
CREATE INDEX artifact_sha256_idx ON artifact (sha256) WHERE deleted_at IS NULL AND sha256 IS NOT NULL;

-- ── Targets and deployments ─────────────────────────────────────────
CREATE TABLE target (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL REFERENCES org (id),
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('vm_test', 'vm_demo', 'docker_test', 'docker_demo')),
  connection  TEXT NOT NULL,  -- JSON
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  deleted_at  TEXT
);
CREATE UNIQUE INDEX target_org_name_unique ON target (org_id, name) WHERE deleted_at IS NULL;

CREATE TABLE deployment (
  id                       TEXT PRIMARY KEY,
  org_id                   TEXT NOT NULL REFERENCES org (id),
  release_id               TEXT NOT NULL REFERENCES release (id),
  target_id                TEXT NOT NULL REFERENCES target (id),
  status                   TEXT NOT NULL CHECK (status IN ('pending', 'deploying', 'active', 'failed', 'superseded', 'rolled_back')),
  started_at               TEXT,
  completed_at             TEXT,
  previous_deployment_id   TEXT REFERENCES deployment (id),
  health_summary           TEXT,  -- JSON
  created_at               TEXT NOT NULL,
  updated_at               TEXT NOT NULL,
  deleted_at               TEXT
);
CREATE INDEX deployment_target_idx ON deployment (target_id) WHERE deleted_at IS NULL;
CREATE INDEX deployment_release_idx ON deployment (release_id) WHERE deleted_at IS NULL;
-- One active deployment per target — design doc §4.2.
CREATE UNIQUE INDEX deployment_target_active_unique
  ON deployment (target_id)
  WHERE status = 'active' AND deleted_at IS NULL;

CREATE TABLE health_check (
  id              TEXT PRIMARY KEY,
  deployment_id   TEXT NOT NULL REFERENCES deployment (id),
  probe_name      TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('pass', 'fail', 'degraded')),
  latency_ms      INTEGER,
  detail          TEXT,
  checked_at      TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  deleted_at      TEXT
);
CREATE INDEX health_check_deployment_idx ON health_check (deployment_id) WHERE deleted_at IS NULL;
CREATE INDEX health_check_checked_at_idx ON health_check (checked_at) WHERE deleted_at IS NULL;

-- ── Scenarios and runs ──────────────────────────────────────────────
CREATE TABLE scenario (
  id              TEXT PRIMARY KEY,
  org_id          TEXT NOT NULL REFERENCES org (id),
  path            TEXT NOT NULL,
  scenario_hash   TEXT NOT NULL,
  name            TEXT NOT NULL,
  tags            TEXT NOT NULL DEFAULT '[]',  -- JSON array
  source          TEXT NOT NULL CHECK (source IN ('disk', 'db', 'gitops')),
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  deleted_at      TEXT
);
CREATE UNIQUE INDEX scenario_org_path_unique ON scenario (org_id, path) WHERE deleted_at IS NULL;
CREATE INDEX scenario_hash_idx ON scenario (scenario_hash) WHERE deleted_at IS NULL;

CREATE TABLE run (
  id                  TEXT PRIMARY KEY,
  org_id              TEXT NOT NULL REFERENCES org (id),
  scenario_id         TEXT NOT NULL REFERENCES scenario (id),
  target_id           TEXT REFERENCES target (id),
  triggered_by        TEXT NOT NULL CHECK (triggered_by IN ('cli', 'api', 'deployment', 'schedule')),
  envelope_blob_uri   TEXT,
  result              TEXT,
  started_at          TEXT,
  completed_at        TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  deleted_at          TEXT
);
CREATE INDEX run_scenario_idx ON run (scenario_id) WHERE deleted_at IS NULL;
CREATE INDEX run_target_idx ON run (target_id) WHERE deleted_at IS NULL;
CREATE INDEX run_started_at_idx ON run (started_at) WHERE deleted_at IS NULL;

-- ── Audit log (append-only) ─────────────────────────────────────────
CREATE TABLE audit_log (
  id           TEXT PRIMARY KEY,
  org_id       TEXT NOT NULL REFERENCES org (id),
  actor        TEXT NOT NULL,
  action       TEXT NOT NULL,
  entity_type  TEXT NOT NULL,
  entity_id    TEXT NOT NULL,
  detail       TEXT,  -- JSON
  at           TEXT NOT NULL,
  created_at   TEXT NOT NULL
);
CREATE INDEX audit_log_org_at_idx ON audit_log (org_id, at);
CREATE INDEX audit_log_entity_idx ON audit_log (entity_type, entity_id);
