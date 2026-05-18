-- WS13 M4 (v0.6 HuggingFace Hub facade) — HF per-file metadata column
-- + sibling hf_revision table.
--
-- Per-file rows live in `manifest` under
--   name    = 'hf/<org>/<repo>/<repo_type>'
--   version = '<revision>/<path>'
-- with `kind = 'hf'` and `hf_metadata_json` carrying the per-file
-- projection from `HfManifestMetadata`. The composite manifest.version
-- string `<revision>/<path>` keeps the per-revision file rows distinct
-- without explicitly storing the revision as a column (the row is
-- indexable via the leading prefix when the read path needs to scan
-- a single revision).
--
-- The revision-level tree manifest is a NEW companion table —
-- `hf_revision` — keyed on the composite (org, repo, repo_type,
-- revision). This is the first facade to introduce a non-`manifest`
-- companion table; see `.workstream-status-ws13-m4.md` for the
-- architectural rationale (revisions don't carry blob references
-- directly — the per-file rows do — so storing them as manifests
-- with empty blobs[] would be a category mismatch, and the
-- `manifest.version` key collides badly with the per-file rows).
--
-- hf_metadata_json carries (per `HfManifestMetadata`):
--   {
--     org:        string,         // validated lowercase org
--     repo:       string,         // HF repo name
--     repoType:   string,         // 'model' | 'dataset' | 'space'
--     revision:   string,         // git SHA-1, tag, or branch name
--     path:       string,         // POSIX relative path inside the repo
--     lfs:        boolean,        // true → /resolve emits pointer file
--     sha256:     string,         // 64-char lowercase hex
--     size:       number,         // bytes (matches blob bytes stored)
--     mimeType?:  string,         // advisory content-type hint
--     lfsOid?:    string          // canonical 'sha256:<hex>' for LFS files
--   }
--
-- Default NULL preserves back-compat for existing rows (cargo / npm /
-- OCI / PyPI / Maven / NuGet / generic kinds).

ALTER TABLE manifest ADD COLUMN hf_metadata_json TEXT;

-- Extend the kind CHECK constraint to permit 'hf'. SQLite does not
-- support ALTER TABLE ... ALTER COLUMN, so we recreate the manifest
-- table with the wider CHECK + copy data through. Same pattern the
-- 0005 (pypi), 0006 (maven), and 0007 (nuget) migrations used.

PRAGMA foreign_keys = OFF;

CREATE TABLE manifest_v5 (
  name              TEXT NOT NULL,
  version           TEXT NOT NULL,
  media_type        TEXT NOT NULL,
  blobs_json        TEXT NOT NULL,
  annotations_json  TEXT,
  signature_b64     TEXT,
  signed_by         TEXT,
  canonical_bytes   BLOB NOT NULL,
  created_at        TEXT NOT NULL,
  kind              TEXT NOT NULL DEFAULT 'generic'
    CHECK (kind IN ('generic', 'cargo', 'npm', 'oci', 'pypi', 'maven', 'nuget', 'hf')),
  provenance_json   TEXT,
  cargo_metadata_json TEXT,
  npm_metadata_json TEXT,
  oci_metadata_json TEXT,
  pypi_metadata_json TEXT,
  maven_metadata_json TEXT,
  nuget_metadata_json TEXT,
  hf_metadata_json TEXT,
  PRIMARY KEY (name, version)
);

INSERT INTO manifest_v5 (
  name, version, media_type, blobs_json, annotations_json,
  signature_b64, signed_by, canonical_bytes, created_at,
  kind, provenance_json, cargo_metadata_json, npm_metadata_json,
  oci_metadata_json, pypi_metadata_json, maven_metadata_json,
  nuget_metadata_json, hf_metadata_json
)
SELECT
  name, version, media_type, blobs_json, annotations_json,
  signature_b64, signed_by, canonical_bytes, created_at,
  kind, provenance_json, cargo_metadata_json, npm_metadata_json,
  oci_metadata_json, pypi_metadata_json, maven_metadata_json,
  nuget_metadata_json, NULL
FROM manifest;

DROP TABLE manifest;
ALTER TABLE manifest_v5 RENAME TO manifest;

CREATE INDEX manifest_name_idx ON manifest (name, created_at DESC);
CREATE INDEX manifest_kind_idx ON manifest (kind, created_at DESC);

-- Extend virtual_upstream.kind CHECK to accept 'huggingface'. The
-- 0007 migration shipped a CHECK of
-- ('cargo', 'npm', 'oci', 'maven', 'pip', 'pypi', 'nuget', 'helm') —
-- 'huggingface' is not yet listed, so recreate the table here too.

CREATE TABLE virtual_upstream_v4 (
  id          TEXT PRIMARY KEY,
  org         TEXT NOT NULL,
  kind        TEXT NOT NULL
    CHECK (kind IN ('cargo', 'npm', 'oci', 'maven', 'pip', 'pypi', 'nuget', 'huggingface', 'helm')),
  upstream_url TEXT NOT NULL,
  config_json TEXT NOT NULL DEFAULT '{}',
  enabled     INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

INSERT INTO virtual_upstream_v4
SELECT * FROM virtual_upstream;

DROP TABLE virtual_upstream;
ALTER TABLE virtual_upstream_v4 RENAME TO virtual_upstream;

CREATE UNIQUE INDEX virtual_upstream_org_kind_url_unique
  ON virtual_upstream (org, kind, upstream_url);
CREATE INDEX virtual_upstream_org_kind_idx
  ON virtual_upstream (org, kind) WHERE enabled = 1;

-- Companion table: per-revision file-tree manifest. Keyed on the
-- composite (org, repo, repo_type, revision) per Q8 lock.
--
-- files_json is a JSON-encoded array of HfRevisionFile entries:
--   [{ path, sha256, size, lfs, mimeType? }, ...]
-- The read path's resolve handler walks this array to locate the
-- file entry; it never enumerates manifest rows directly (those exist
-- for blob hydration, not tree traversal).

CREATE TABLE hf_revision (
  org              TEXT NOT NULL,
  repo             TEXT NOT NULL,
  repo_type        TEXT NOT NULL CHECK (repo_type IN ('model', 'dataset', 'space')),
  revision         TEXT NOT NULL,
  root_tree_digest TEXT NOT NULL,
  parent_revision  TEXT,
  files_json       TEXT NOT NULL,
  provenance_json  TEXT,
  created_at       TEXT NOT NULL,
  PRIMARY KEY (org, repo, repo_type, revision)
);

CREATE INDEX hf_revision_created_idx
  ON hf_revision (org, repo, repo_type, created_at DESC);

PRAGMA foreign_keys = ON;
