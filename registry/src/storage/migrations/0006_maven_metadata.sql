-- WS13 M2 (v0.6 Maven / Java facade) — Maven per-artifact metadata column.
--
-- Mirrors the cargo (0002) / npm (0003) / OCI (0004) / PyPI (0005) column
-- pattern. One manifest row per uploaded Maven artifact (jar / pom / war /
-- ear / module / sources jar / javadoc jar / .asc signature / per-extension
-- checksum) under manifest `name = 'maven/<org>/<groupId>/<artifactId>'`
-- keyed on `version = '<version>/<filename>'`. The version composite is
-- chosen so multiple files at the same Maven version (e.g. main jar +
-- sources jar + .pom + signatures + checksums) share the GAV but get
-- distinct manifest rows; the slash inside `version` is allowed by the
-- manifest schema (see `validateManifestVersion`).
--
-- maven_metadata_json carries:
--   {
--     groupId:     string,        // e.g. "com.example"
--     artifactId:  string,        // e.g. "demo-lib"
--     version:     string,        // Maven version, regular ("1.2.3") or
--                                  //   snapshot ("1.2.3-SNAPSHOT") or
--                                  //   resolved-snapshot ("1.2.3-20260517.123456-1")
--     baseVersion: string,        // For resolved snapshots, the base
--                                  //   version (e.g. "1.2.3-SNAPSHOT");
--                                  //   for non-snapshots, identical to version
--     filename:    string,        // matches the final segment in the
--                                  //   path, e.g. "demo-lib-1.2.3.jar"
--     extension:   string,        // "jar" | "pom" | "war" | "ear" | "module" |
--                                  //   "jar.asc" | "pom.asc" | "jar.sha1" | ...
--                                  //   Multi-suffix (sha1 / asc) preserved verbatim.
--     classifier?: string,        // "sources" | "javadoc" | operator-defined
--     isSnapshot:  boolean,       // true when version ends with -SNAPSHOT
--                                  //   or matches the resolved-snapshot grammar
--     snapshot?: {                 // present only on snapshot artifacts
--       timestamp:   string,       // "20260517.123456"
--       buildNumber: number        // monotonic per-base-version
--     },
--     checksumOf?: string,         // when extension ends in .sha1/.md5/.sha256/.sha512:
--                                  //   the filename of the artifact this checksum
--                                  //   covers (without the trailing checksum ext)
--     signatureOf?: string,        // when extension ends in .asc: the filename of
--                                  //   the artifact this signature covers
--     contentType?: string         // operator-asserted; defaults to
--                                  //   "application/java-archive" for jars,
--                                  //   "application/xml" for poms, "application/octet-stream"
--                                  //   for everything else
--   }
--
-- Default NULL preserves back-compat for existing rows (cargo / npm / OCI /
-- PyPI / generic kinds).

ALTER TABLE manifest ADD COLUMN maven_metadata_json TEXT;

-- Extend the kind CHECK constraint to permit 'maven'. SQLite does not
-- support ALTER TABLE ... ALTER COLUMN, so we recreate the manifest
-- table with the wider CHECK + copy data through. Same pattern the
-- PyPI migration (0005) used.

PRAGMA foreign_keys = OFF;

CREATE TABLE manifest_v3 (
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
    CHECK (kind IN ('generic', 'cargo', 'npm', 'oci', 'pypi', 'maven')),
  provenance_json   TEXT,
  cargo_metadata_json TEXT,
  npm_metadata_json TEXT,
  oci_metadata_json TEXT,
  pypi_metadata_json TEXT,
  maven_metadata_json TEXT,
  PRIMARY KEY (name, version)
);

INSERT INTO manifest_v3 (
  name, version, media_type, blobs_json, annotations_json,
  signature_b64, signed_by, canonical_bytes, created_at,
  kind, provenance_json, cargo_metadata_json, npm_metadata_json,
  oci_metadata_json, pypi_metadata_json, maven_metadata_json
)
SELECT
  name, version, media_type, blobs_json, annotations_json,
  signature_b64, signed_by, canonical_bytes, created_at,
  kind, provenance_json, cargo_metadata_json, npm_metadata_json,
  oci_metadata_json, pypi_metadata_json, NULL
FROM manifest;

DROP TABLE manifest;
ALTER TABLE manifest_v3 RENAME TO manifest;

CREATE INDEX manifest_name_idx ON manifest (name, created_at DESC);
CREATE INDEX manifest_kind_idx ON manifest (kind, created_at DESC);

-- The virtual_upstream.kind CHECK already includes 'maven' as of 0005
-- (`CHECK (kind IN ('cargo', 'npm', 'oci', 'maven', 'pip', 'pypi', 'helm'))`),
-- so we do NOT need to recreate that table here. Operators creating
-- Maven virtual upstreams through the management API are already
-- accepted at the database boundary.

PRAGMA foreign_keys = ON;
