-- WS6 wave-3 carve-out #9 (M10) — manifest `kind` + provenance +
-- cargo-specific metadata + registry-audit log.
--
-- Three storage changes that together make the registry capable of
-- hosting multi-protocol artifacts (cargo, npm, OCI) while keeping
-- a single blob/manifest store, AND that capture the "where did this
-- come from" trail that powers the forensic API.
--
-- 1. Manifest schema extension:
--    * `kind` column discriminates by protocol. Existing rows
--      backfill to `'generic'` (v0.4.0 behaviour).
--    * `provenance_json` carries the new `Provenance` shape on
--      every write. Existing rows backfill to
--      `{"source":"migration","fetchedAt":"<applied_at>"}`.
--    * `cargo_metadata_json` carries the new `CargoManifestMetadata`
--      shape when `kind = 'cargo'`. Nullable for other kinds.
--
-- 2. Registry-audit table (`registry_audit_log`):
--    Immutable append-only record of every ingest event.
--    Mirrors the host's audit_log shape so the forensic API
--    can answer "show all artifacts originating from crates.io
--    fetched between X and Y" in O(rows-in-range).
--
-- 3. Virtual-upstream config table (`virtual_upstream`):
--    One row per (org, kind, upstream-URL). The cargo handler
--    consults this table on local-miss to decide whether to
--    proxy-fetch from upstream.

ALTER TABLE manifest ADD COLUMN kind TEXT NOT NULL DEFAULT 'generic'
  CHECK (kind IN ('generic', 'cargo', 'npm', 'oci'));

ALTER TABLE manifest ADD COLUMN provenance_json TEXT;
ALTER TABLE manifest ADD COLUMN cargo_metadata_json TEXT;

-- Backfill: existing rows are v0.4.0-era generic uploads. Use the
-- migration-apply time as `fetchedAt` since the original ingest
-- timestamp is the row's createdAt (preserved). The 'migration'
-- source tags these rows as schema-back-filled rather than
-- operator-uploaded.
UPDATE manifest
  SET provenance_json = json_object(
    'source', 'migration',
    'fetchedAt', created_at
  )
  WHERE provenance_json IS NULL;

-- Index helps the forensic API filter by kind cheaply.
CREATE INDEX manifest_kind_idx ON manifest (kind, created_at DESC);

-- Registry audit log: one row per ingest event. Append-only by
-- convention (no UPDATE / DELETE handlers; the storage interface
-- exposes only `append` + `list`).
CREATE TABLE registry_audit_log (
  id          TEXT PRIMARY KEY,
  -- 'upload' | 'proxy_cache' | 'manifest_create' | 'yank' | 'unyank'
  action      TEXT NOT NULL,
  -- 'blob' | 'manifest' | 'cargo_crate' | 'virtual_upstream'
  entity_type TEXT NOT NULL,
  -- The sha256 (for blobs) or `<name>@<version>` (for manifests/crates)
  -- or upstream URL (for virtual_upstream).
  entity_id   TEXT NOT NULL,
  -- Operator-token-id fragment (16 hex) or 'system' for migration / GC.
  actor       TEXT NOT NULL,
  -- Free-form JSON detail. For proxy_cache: upstream_url, fetch_ms,
  -- bytes_in. For yank: reason, decided_by.
  detail_json TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX registry_audit_log_action_idx
  ON registry_audit_log (action, created_at DESC);
CREATE INDEX registry_audit_log_entity_idx
  ON registry_audit_log (entity_type, entity_id, created_at DESC);
CREATE INDEX registry_audit_log_actor_idx
  ON registry_audit_log (actor, created_at DESC);

-- Virtual-upstream config. One row per (org, kind, upstream URL).
-- The cargo handler reads this table on local-miss to decide whether
-- to proxy. Other kinds (npm/oci/maven) will reuse the same table
-- when their facades land.
CREATE TABLE virtual_upstream (
  id          TEXT PRIMARY KEY,
  org         TEXT NOT NULL,
  -- 'cargo' | 'npm' | 'oci' | 'maven' | 'pip' | 'helm'
  kind        TEXT NOT NULL CHECK (kind IN ('cargo', 'npm', 'oci', 'maven', 'pip', 'helm')),
  upstream_url TEXT NOT NULL,
  -- Free-form JSON: { allow_patterns?, deny_patterns?, resign_on_cache?,
  -- auth_header_template?, cache_ttl_seconds? }
  config_json TEXT NOT NULL DEFAULT '{}',
  enabled     INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE UNIQUE INDEX virtual_upstream_org_kind_url_unique
  ON virtual_upstream (org, kind, upstream_url);
CREATE INDEX virtual_upstream_org_kind_idx
  ON virtual_upstream (org, kind) WHERE enabled = 1;
