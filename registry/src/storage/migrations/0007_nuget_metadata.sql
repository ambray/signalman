-- WS13 M3 (v0.6 NuGet / .NET facade) — NuGet per-package metadata column.
--
-- Mirrors the cargo (0002) / npm (0003) / OCI (0004) / PyPI (0005) / Maven
-- (0006) column pattern. One manifest row per uploaded NuGet package
-- version under manifest `name = 'nuget/<org>/<lower-id>'` keyed on
-- `version = '<lower-version>'`. NuGet identifies a package by
-- case-insensitive id; storage normalises to lowercase to match the
-- canonical flat-container URL convention.
--
-- nuget_metadata_json carries:
--   {
--     id:            string,         // lowercase canonical id, e.g. "newtonsoft.json"
--     version:       string,         // normalised version, e.g. "13.0.3"
--                                     //   (lowercase prerelease tags, trimmed leading
--                                     //   zeros, dropped trailing .0 on 4-segment forms)
--     originalId?:   string,         // operator-supplied id casing (preserved for
--                                     //   audit / display)
--     originalVersion?: string,      // operator-supplied version casing (rare; mostly
--                                     //   identical to version)
--     authors?:      string,
--     description?:  string,
--     summary?:      string,
--     title?:        string,
--     tags?:         string[],
--     projectUrl?:   string,
--     licenseUrl?:   string,
--     licenseExpression?: string,
--     iconUrl?:      string,
--     requireLicenseAcceptance?: boolean,
--     dependencyGroups?: [             // per-framework dependency groups
--       {
--         targetFramework?: string,
--         dependencies?: [ { id, range? } ]
--       }
--     ],
--     targetFrameworks?: string[],   // aggregate target-framework list
--     packageHash:   string,         // base64-encoded SHA-512 of the .nupkg bytes
--                                     //   (NuGet v3 catalog convention; SemVer 2 clients
--                                     //   verify it against the downloaded blob)
--     packageHashAlgorithm: 'SHA512',
--     packageSize:   number,         // .nupkg byte length
--     published?:    string,         // ISO-8601 UTC publish timestamp
--     listed?:       boolean         // operator-controlled unlist flag (M3.x: stub default true)
--   }
--
-- Default NULL preserves back-compat for existing rows (cargo / npm / OCI /
-- PyPI / Maven / generic kinds).

ALTER TABLE manifest ADD COLUMN nuget_metadata_json TEXT;

-- Extend the kind CHECK constraint to permit 'nuget'. SQLite does not
-- support ALTER TABLE ... ALTER COLUMN, so we recreate the manifest
-- table with the wider CHECK + copy data through. Same pattern the
-- PyPI (0005) + Maven (0006) migrations used.

PRAGMA foreign_keys = OFF;

CREATE TABLE manifest_v4 (
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
    CHECK (kind IN ('generic', 'cargo', 'npm', 'oci', 'pypi', 'maven', 'nuget')),
  provenance_json   TEXT,
  cargo_metadata_json TEXT,
  npm_metadata_json TEXT,
  oci_metadata_json TEXT,
  pypi_metadata_json TEXT,
  maven_metadata_json TEXT,
  nuget_metadata_json TEXT,
  PRIMARY KEY (name, version)
);

INSERT INTO manifest_v4 (
  name, version, media_type, blobs_json, annotations_json,
  signature_b64, signed_by, canonical_bytes, created_at,
  kind, provenance_json, cargo_metadata_json, npm_metadata_json,
  oci_metadata_json, pypi_metadata_json, maven_metadata_json,
  nuget_metadata_json
)
SELECT
  name, version, media_type, blobs_json, annotations_json,
  signature_b64, signed_by, canonical_bytes, created_at,
  kind, provenance_json, cargo_metadata_json, npm_metadata_json,
  oci_metadata_json, pypi_metadata_json, maven_metadata_json, NULL
FROM manifest;

DROP TABLE manifest;
ALTER TABLE manifest_v4 RENAME TO manifest;

CREATE INDEX manifest_name_idx ON manifest (name, created_at DESC);
CREATE INDEX manifest_kind_idx ON manifest (kind, created_at DESC);

-- Extend virtual_upstream.kind CHECK to accept 'nuget'. The 0005 migration
-- shipped a CHECK of ('cargo', 'npm', 'oci', 'maven', 'pip', 'pypi', 'helm') —
-- 'nuget' is not yet listed, so we recreate the table here too. Same
-- recreate-and-copy pattern.

CREATE TABLE virtual_upstream_v3 (
  id          TEXT PRIMARY KEY,
  org         TEXT NOT NULL,
  kind        TEXT NOT NULL
    CHECK (kind IN ('cargo', 'npm', 'oci', 'maven', 'pip', 'pypi', 'nuget', 'helm')),
  upstream_url TEXT NOT NULL,
  config_json TEXT NOT NULL DEFAULT '{}',
  enabled     INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

INSERT INTO virtual_upstream_v3
SELECT * FROM virtual_upstream;

DROP TABLE virtual_upstream;
ALTER TABLE virtual_upstream_v3 RENAME TO virtual_upstream;

CREATE UNIQUE INDEX virtual_upstream_org_kind_url_unique
  ON virtual_upstream (org, kind, upstream_url);
CREATE INDEX virtual_upstream_org_kind_idx
  ON virtual_upstream (org, kind) WHERE enabled = 1;

PRAGMA foreign_keys = ON;
