/**
 * Mutable tag pointers for OCI manifests.
 *
 * The OCI manifest catalog itself is content-addressed (`name = oci/<org>/<repo>`
 * + `version = sha256:<hex>` is the immutable address). Tags are a
 * separate layer of mutable string → digest mapping, stored in the
 * `oci_tag` table from migration 0004:
 *
 *   PRIMARY KEY (repository, tag)
 *   manifest_sha256 TEXT NOT NULL
 *   updated_at      TEXT NOT NULL
 *
 * Tag rotation is `INSERT ... ON CONFLICT DO UPDATE` — the same tag
 * keyed under the same repository may point at different digests
 * over time. The `manifest_sha256` is the lowercase-hex sha256 of
 * the manifest's literal stored bytes (matches what the API surfaces
 * as the `Docker-Content-Digest` header).
 */

import type { DatabaseSync } from "node:sqlite";
import type { SqliteManifestIndex } from "../storage/sqlite-index.js";

export interface TagRow {
  repository: string;
  tag: string;
  manifestSha256: string;
  updatedAt: string;
}

export interface TagStoreOptions {
  index: SqliteManifestIndex;
  now?: () => Date;
}

export class TagStore {
  private readonly db: DatabaseSync;
  private readonly now: () => Date;

  constructor(opts: TagStoreOptions) {
    this.db = opts.index.db;
    this.now = opts.now ?? (() => new Date());
  }

  /**
   * Insert or update the tag → digest pointer. Returns whether this
   * was a rotation (existing row pointed at a different digest).
   */
  put(repository: string, tag: string, manifestSha256: string): {
    rotated: boolean;
    previousSha256?: string;
  } {
    const existing = this.get(repository, tag);
    const updatedAt = this.now().toISOString();
    this.db
      .prepare(
        `INSERT INTO oci_tag (repository, tag, manifest_sha256, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(repository, tag)
         DO UPDATE SET manifest_sha256 = excluded.manifest_sha256,
                       updated_at      = excluded.updated_at`,
      )
      .run(repository, tag, manifestSha256, updatedAt);
    if (existing && existing.manifestSha256 !== manifestSha256) {
      return { rotated: true, previousSha256: existing.manifestSha256 };
    }
    return { rotated: false };
  }

  /** Fetch the tag → digest pointer. Returns null when unknown. */
  get(repository: string, tag: string): TagRow | null {
    const row = this.db
      .prepare(
        `SELECT repository, tag, manifest_sha256, updated_at
         FROM oci_tag
         WHERE repository = ? AND tag = ?`,
      )
      .get(repository, tag) as
      | {
          repository: string;
          tag: string;
          manifest_sha256: string;
          updated_at: string;
        }
      | undefined;
    if (!row) return null;
    return {
      repository: row.repository,
      tag: row.tag,
      manifestSha256: row.manifest_sha256,
      updatedAt: row.updated_at,
    };
  }

  /**
   * List all tags for a repository, ASCII-lexically ordered after
   * `after` (exclusive). Caps the result count at `limit`. Used by
   * the M4 `/v2/<name>/tags/list` endpoint.
   */
  list(repository: string, opts: { after?: string; limit?: number } = {}): TagRow[] {
    const limit = opts.limit ?? 1000;
    const after = opts.after ?? "";
    const rows = this.db
      .prepare(
        `SELECT repository, tag, manifest_sha256, updated_at
         FROM oci_tag
         WHERE repository = ? AND tag > ?
         ORDER BY tag ASC
         LIMIT ?`,
      )
      .all(repository, after, limit) as Array<{
      repository: string;
      tag: string;
      manifest_sha256: string;
      updated_at: string;
    }>;
    return rows.map((row) => ({
      repository: row.repository,
      tag: row.tag,
      manifestSha256: row.manifest_sha256,
      updatedAt: row.updated_at,
    }));
  }

  /**
   * Delete one tag pointer. Idempotent — deleting an unknown tag
   * is a no-op. Returns whether a row was actually removed.
   */
  delete(repository: string, tag: string): boolean {
    const result = this.db
      .prepare(`DELETE FROM oci_tag WHERE repository = ? AND tag = ?`)
      .run(repository, tag);
    return result.changes > 0;
  }

  /**
   * Delete all tag pointers in a repository that point at a given
   * digest. Used by manifest-DELETE-by-digest to keep dangling tags
   * from referring to a removed manifest. Returns the deleted tags.
   */
  deleteByDigest(repository: string, manifestSha256: string): string[] {
    const rows = this.db
      .prepare(
        `SELECT tag FROM oci_tag
         WHERE repository = ? AND manifest_sha256 = ?`,
      )
      .all(repository, manifestSha256) as Array<{ tag: string }>;
    if (rows.length === 0) return [];
    this.db
      .prepare(
        `DELETE FROM oci_tag
         WHERE repository = ? AND manifest_sha256 = ?`,
      )
      .run(repository, manifestSha256);
    return rows.map((r) => r.tag);
  }
}
