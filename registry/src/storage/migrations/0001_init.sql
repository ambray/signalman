-- @signalman/registry initial schema.
--
-- Two tables — the manifest catalog and a content-addressed blob
-- index that mirrors what is on disk. The on-disk blob store is the
-- source of truth for bytes; this table exists so the API can
-- answer `statBlob` and future `list referenced blobs` queries
-- without walking the filesystem.
--
-- Conventions match host/src/control-plane/storage:
--   * IDs are TEXT, ULID-shaped. Names + versions are TEXT.
--   * Timestamps are TEXT in ISO-8601 UTC.
--   * JSON columns are TEXT; consumers parse on read.

CREATE TABLE IF NOT EXISTS _migrations (
  version    INTEGER PRIMARY KEY,
  name       TEXT    NOT NULL,
  applied_at TEXT    NOT NULL
);

CREATE TABLE manifest (
  name              TEXT NOT NULL,
  version           TEXT NOT NULL,
  media_type        TEXT NOT NULL,
  blobs_json        TEXT NOT NULL,
  annotations_json  TEXT,
  signature_b64     TEXT,
  signed_by         TEXT,
  canonical_bytes   BLOB NOT NULL,
  created_at        TEXT NOT NULL,
  PRIMARY KEY (name, version)
);
CREATE INDEX manifest_name_idx ON manifest (name, created_at DESC);

CREATE TABLE blob (
  sha256       TEXT PRIMARY KEY,
  size         INTEGER NOT NULL CHECK (size >= 0),
  content_type TEXT,
  created_at   TEXT NOT NULL
);
