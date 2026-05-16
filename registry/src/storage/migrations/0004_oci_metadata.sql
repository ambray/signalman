-- WS10 (v0.5 OCI distribution-spec facade) — OCI-specific storage.
--
-- Three additions, mirroring the cargo (0002) + npm (0003) column
-- pattern and reserving migration 0005+ for the next protocol
-- (maven / pip / helm).
--
-- 1. `oci_metadata_json` column on manifest:
--    Operator-signed protocol-specific metadata for kind='oci' rows.
--    Schema (parsed lazily on read):
--      { isIndex: bool,
--        schemaVariant: 'oci-v1' | 'docker-v2-2',
--        configDigest?: 'sha256:<hex>',
--        configMediaType?: string,
--        layerDigests?: string[],
--        totalSize?: number,
--        childManifests?: [{ digest, mediaType, platform, size }, ...] }
--    Default NULL so back-compat rows (generic / cargo / npm) round-
--    trip unchanged. The `kind` column's CHECK constraint already
--    permits 'oci' from migration 0002.
--
-- 2. `oci_tag` table:
--    Mutable pointers to immutable manifest digests, per OCI spec
--    §Tag Reference Format. Primary key (repository, tag) so each
--    repo has one row per tag; tag rotation is an UPDATE of
--    manifest_sha256. The `repository` column carries the storage-
--    layer manifest name (e.g. 'oci/team/svc'); `manifest_sha256` is
--    the lowercase-hex sha256 over the manifest's canonical bytes
--    (matches what the API surfaces in the `Docker-Content-Digest`
--    header).
--    M3 populates this table; M1 just creates the shape.
--
-- 3. `pending_blob_uploads` table:
--    Chunked-upload state machine. Each row is one in-flight upload
--    session. `chunks_json` is a JSON array of {offset, length, sha256}
--    persisted on every PATCH so resume-after-restart works (Docker
--    Distribution's default behaviour). `expires_at` powers the 24-
--    hour reaper. M2 populates this table; M1 just creates the shape.

ALTER TABLE manifest ADD COLUMN oci_metadata_json TEXT;

CREATE TABLE oci_tag (
  repository       TEXT NOT NULL,
  tag              TEXT NOT NULL,
  manifest_sha256  TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  PRIMARY KEY (repository, tag)
);
CREATE INDEX oci_tag_repository_idx ON oci_tag (repository, tag);
CREATE INDEX oci_tag_digest_idx ON oci_tag (manifest_sha256);

CREATE TABLE pending_blob_uploads (
  upload_id        TEXT PRIMARY KEY,
  repository       TEXT NOT NULL,
  chunks_json      TEXT NOT NULL DEFAULT '[]',
  bytes_received   INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL,
  expires_at       TEXT NOT NULL,
  actor            TEXT NOT NULL
);
CREATE INDEX pending_blob_uploads_expires_idx
  ON pending_blob_uploads (expires_at);
CREATE INDEX pending_blob_uploads_repo_idx
  ON pending_blob_uploads (repository, created_at DESC);
