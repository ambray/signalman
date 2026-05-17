-- WS13 M1 (v0.6 PyPI / pip facade) — PyPI per-file metadata column.
--
-- Mirrors the cargo (0002) + npm (0003) + OCI (0004) column pattern.
-- One row per uploaded PyPI file (wheel or sdist) under manifest
-- `name = 'pypi/<org>/<pkg>'` keyed on `version = <filename>`. The
-- filename is unique per file by PEP 425 binary-distribution
-- conventions + PEP 491 wheel-naming spec, so it makes a sound
-- PRIMARY KEY component.
--
-- pypi_metadata_json carries:
--   {
--     version:           string,        // PEP 440 version, e.g. "1.2.3"
--     filename:          string,        // matches manifest.version
--     filetype:          "sdist" | "bdist_wheel",
--     requires_python?:  string,        // PEP 345 / PEP 440 spec
--     yanked?:           string | true, // PEP 592; truthy when yanked
--     core_metadata?:    { sha256: string }, // PEP 658 — link to .metadata file
--     python_version?:   string,        // e.g. "py3", "cp310"
--     abi?:              string,        // wheel ABI tag (e.g. "abi3")
--     platform?:         string,        // wheel platform tag
--     md5_digest?:       string,        // legacy PyPI clients still emit md5
--     blake2_256_digest?: string,       // PyPI also accepts blake2
--     classifiers?:      string[],      // trove classifiers from the upload metadata
--     summary?:          string,
--     description?:      string,
--     description_content_type?: string,
--     author?:           string,
--     author_email?:     string,
--     maintainer?:       string,
--     maintainer_email?: string,
--     license?:          string,
--     keywords?:         string,
--     home_page?:        string,
--     project_urls?:     Record<string, string>,
--     requires_dist?:    string[],      // PEP 508 requirement strings
--     provides_dist?:    string[],
--     obsoletes_dist?:   string[]
--   }
--
-- Default NULL preserves back-compat for existing rows (cargo / npm
-- / OCI / generic kinds).

ALTER TABLE manifest ADD COLUMN pypi_metadata_json TEXT;

-- Extend the kind CHECK constraint to permit 'pypi'. SQLite does not
-- support ALTER TABLE ... ALTER COLUMN, so we recreate the manifest
-- table with the wider CHECK + copy data through. The other columns
-- + indexes are preserved byte-identical.
--
-- This is the standard SQLite migration pattern for CHECK changes
-- and is safe because the manifest table is small at this point
-- (a few KB of rows at typical operator deployment scale).

PRAGMA foreign_keys = OFF;

CREATE TABLE manifest_v2 (
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
    CHECK (kind IN ('generic', 'cargo', 'npm', 'oci', 'pypi')),
  provenance_json   TEXT,
  cargo_metadata_json TEXT,
  npm_metadata_json TEXT,
  oci_metadata_json TEXT,
  pypi_metadata_json TEXT,
  PRIMARY KEY (name, version)
);

INSERT INTO manifest_v2 (
  name, version, media_type, blobs_json, annotations_json,
  signature_b64, signed_by, canonical_bytes, created_at,
  kind, provenance_json, cargo_metadata_json, npm_metadata_json,
  oci_metadata_json, pypi_metadata_json
)
SELECT
  name, version, media_type, blobs_json, annotations_json,
  signature_b64, signed_by, canonical_bytes, created_at,
  kind, provenance_json, cargo_metadata_json, npm_metadata_json,
  oci_metadata_json, NULL
FROM manifest;

DROP TABLE manifest;
ALTER TABLE manifest_v2 RENAME TO manifest;

CREATE INDEX manifest_name_idx ON manifest (name, created_at DESC);
CREATE INDEX manifest_kind_idx ON manifest (kind, created_at DESC);

-- Extend virtual_upstream.kind CHECK to accept 'pypi'. Same
-- recreate-and-copy pattern.

CREATE TABLE virtual_upstream_v2 (
  id          TEXT PRIMARY KEY,
  org         TEXT NOT NULL,
  kind        TEXT NOT NULL
    CHECK (kind IN ('cargo', 'npm', 'oci', 'maven', 'pip', 'pypi', 'helm')),
  upstream_url TEXT NOT NULL,
  config_json TEXT NOT NULL DEFAULT '{}',
  enabled     INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

INSERT INTO virtual_upstream_v2
SELECT * FROM virtual_upstream;

DROP TABLE virtual_upstream;
ALTER TABLE virtual_upstream_v2 RENAME TO virtual_upstream;

CREATE UNIQUE INDEX virtual_upstream_org_kind_url_unique
  ON virtual_upstream (org, kind, upstream_url);
CREATE INDEX virtual_upstream_org_kind_idx
  ON virtual_upstream (org, kind) WHERE enabled = 1;

PRAGMA foreign_keys = ON;
