/**
 * Pending-upload state machine — the SQL half of the chunked-upload
 * flow defined by the OCI Distribution Spec v1.1 §Pushing Blobs.
 *
 * The companion `upload-fs.ts` owns the on-disk tmp file for the
 * uploaded bytes; this module owns the catalog row in
 * `pending_blob_uploads`. Splitting them lets the reaper sweep both
 * sides (disk + db) atomically without leaking either.
 *
 * Persistence shape (migration 0004_oci_metadata.sql):
 *   upload_id        TEXT PRIMARY KEY,
 *   repository       TEXT NOT NULL,
 *   chunks_json      TEXT NOT NULL DEFAULT '[]',
 *   bytes_received   INTEGER NOT NULL DEFAULT 0,
 *   created_at       TEXT NOT NULL,
 *   expires_at       TEXT NOT NULL,
 *   actor            TEXT NOT NULL
 *
 * The `chunks_json` field is a JSON array of `{ offset, length, sha256 }`
 * — one entry per PATCH. Resume after restart works because the row
 * + the on-disk tmp file together carry full state.
 */

import * as crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { SqliteManifestIndex } from "../storage/sqlite-index.js";

export interface PendingUploadChunk {
  /** Byte offset where this chunk started in the assembled blob. */
  offset: number;
  /** Bytes appended by this chunk. */
  length: number;
  /** sha256 of just this chunk's bytes (for forensic resume validation). */
  sha256: string;
}

export interface PendingUploadRow {
  uploadId: string;
  repository: string;
  chunks: PendingUploadChunk[];
  bytesReceived: number;
  createdAt: string;
  expiresAt: string;
  actor: string;
}

/**
 * Default upload-session TTL: 24 hours, per Q8 of the WS10 locked
 * design. Matches Docker Distribution's default. Exported so the
 * reaper + tests can share the constant.
 */
export const DEFAULT_UPLOAD_TTL_SECONDS = 24 * 60 * 60;

export interface UploadStoreOptions {
  index: SqliteManifestIndex;
  /** Injectable clock — tests use a fixed timestamp. */
  now?: () => Date;
  /** Override TTL (seconds). Defaults to {@link DEFAULT_UPLOAD_TTL_SECONDS}. */
  ttlSeconds?: number;
  /** Override upload-id generator. Defaults to a 32-hex random id. */
  newId?: () => string;
}

/**
 * SQL-side handle for the pending_blob_uploads table. Stateless apart
 * from the supplied `now` / id / TTL knobs.
 */
export class UploadStore {
  private readonly db: DatabaseSync;
  private readonly now: () => Date;
  private readonly ttlSeconds: number;
  private readonly newId: () => string;

  constructor(opts: UploadStoreOptions) {
    this.db = opts.index.db;
    this.now = opts.now ?? (() => new Date());
    this.ttlSeconds = opts.ttlSeconds ?? DEFAULT_UPLOAD_TTL_SECONDS;
    this.newId = opts.newId ?? defaultNewId;
  }

  /**
   * Create a new upload session for a repository. Returns the
   * persisted row including the freshly-minted upload id.
   */
  create(repository: string, actor: string): PendingUploadRow {
    const uploadId = this.newId();
    const createdAt = this.now();
    const expiresAt = new Date(createdAt.getTime() + this.ttlSeconds * 1000);
    this.db
      .prepare(
        `INSERT INTO pending_blob_uploads
           (upload_id, repository, chunks_json, bytes_received,
            created_at, expires_at, actor)
         VALUES (?, ?, '[]', 0, ?, ?, ?)`,
      )
      .run(uploadId, repository, createdAt.toISOString(), expiresAt.toISOString(), actor);
    return {
      uploadId,
      repository,
      chunks: [],
      bytesReceived: 0,
      createdAt: createdAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      actor,
    };
  }

  /**
   * Fetch a pending upload row. Returns null when the id is unknown
   * (caller maps to 404 BLOB_UPLOAD_UNKNOWN).
   */
  get(uploadId: string): PendingUploadRow | null {
    const row = this.db
      .prepare(
        `SELECT upload_id, repository, chunks_json, bytes_received,
                created_at, expires_at, actor
         FROM pending_blob_uploads
         WHERE upload_id = ?`,
      )
      .get(uploadId) as
      | {
          upload_id: string;
          repository: string;
          chunks_json: string;
          bytes_received: number;
          created_at: string;
          expires_at: string;
          actor: string;
        }
      | undefined;
    if (!row) return null;
    return {
      uploadId: row.upload_id,
      repository: row.repository,
      chunks: JSON.parse(row.chunks_json) as PendingUploadChunk[],
      bytesReceived: row.bytes_received,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      actor: row.actor,
    };
  }

  /**
   * Append a chunk record + advance the bytes_received cursor.
   * Also refreshes `expires_at` so an in-progress upload that is
   * still being actively patched doesn't get reaped mid-flight.
   */
  appendChunk(uploadId: string, chunk: PendingUploadChunk): PendingUploadRow {
    const existing = this.get(uploadId);
    if (!existing) {
      throw new Error(`pending upload ${uploadId} not found`);
    }
    const chunks = [...existing.chunks, chunk];
    const bytesReceived = existing.bytesReceived + chunk.length;
    const expiresAt = new Date(this.now().getTime() + this.ttlSeconds * 1000);
    this.db
      .prepare(
        `UPDATE pending_blob_uploads
         SET chunks_json = ?, bytes_received = ?, expires_at = ?
         WHERE upload_id = ?`,
      )
      .run(JSON.stringify(chunks), bytesReceived, expiresAt.toISOString(), uploadId);
    return {
      ...existing,
      chunks,
      bytesReceived,
      expiresAt: expiresAt.toISOString(),
    };
  }

  /**
   * Drop a pending upload row. Idempotent — deleting a missing row
   * is a no-op.
   */
  delete(uploadId: string): void {
    this.db
      .prepare(`DELETE FROM pending_blob_uploads WHERE upload_id = ?`)
      .run(uploadId);
  }

  /**
   * Find every pending upload whose `expires_at` is on or before
   * `cutoff`. The reaper uses this to drive its sweep. Empty array
   * when nothing is due.
   */
  listExpired(cutoff: Date): PendingUploadRow[] {
    const rows = this.db
      .prepare(
        `SELECT upload_id, repository, chunks_json, bytes_received,
                created_at, expires_at, actor
         FROM pending_blob_uploads
         WHERE expires_at <= ?
         ORDER BY expires_at ASC`,
      )
      .all(cutoff.toISOString()) as Array<{
      upload_id: string;
      repository: string;
      chunks_json: string;
      bytes_received: number;
      created_at: string;
      expires_at: string;
      actor: string;
    }>;
    return rows.map((row) => ({
      uploadId: row.upload_id,
      repository: row.repository,
      chunks: JSON.parse(row.chunks_json) as PendingUploadChunk[],
      bytesReceived: row.bytes_received,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      actor: row.actor,
    }));
  }
}

function defaultNewId(): string {
  // Same shape as the audit-log id generator: 16 random bytes
  // hex-encoded (32 chars). Path-safe; URL-safe; unambiguous in
  // Location headers.
  return crypto.randomBytes(16).toString("hex");
}
