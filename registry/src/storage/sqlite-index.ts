/**
 * SQLite-backed manifest catalog for `@signalman/registry`.
 *
 * Two tables (see migrations/0001_init.sql):
 *   - `manifest(name, version)` — primary key. Stores the parsed
 *     fields plus `canonical_bytes`: the exact JSON bytes the
 *     manifest was signed over. Re-serializing on read is unsafe
 *     because non-deterministic JSON ordering / spacing changes
 *     would invalidate signatures.
 *   - `blob` — sha-keyed metadata mirror of the on-disk blob store.
 *     Optional but cheap, and lets `statBlob` lookups avoid a
 *     filesystem walk on hot paths.
 *
 * Migration semantics match `host/src/control-plane/storage`:
 *   filenames `NNNN_name.sql` are applied in order under a single
 *   transaction each; `_migrations` records the version + name.
 *
 * Concurrency: WAL mode + busy_timeout=5s. Suitable for a single
 * registry process plus read-only follower connections. Higher
 * throughput needs Postgres; the storage interface is a deliberate
 * abstraction so we can swap drivers without touching the HTTP
 * layer.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import {
  REGISTRY_ERROR_CODES,
  RegistryError,
  type Blob,
  type BlobRef,
  type ListedManifest,
  type Manifest,
  type ManifestSignature,
  validateManifestName,
  validateManifestVersion,
} from "../types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_MIGRATIONS_DIR = path.join(__dirname, "migrations");

export interface SqliteManifestIndexOptions {
  /** Filesystem path to the .db file. Use ":memory:" for tests. */
  path: string;
  /** Override migrations directory (tests). */
  migrationsDir?: string;
  /** Inject a clock — tests use a fixed timestamp. */
  now?: () => Date;
}

interface ManifestRow {
  name: string;
  version: string;
  media_type: string;
  blobs_json: string;
  annotations_json: string | null;
  signature_b64: string | null;
  signed_by: string | null;
  canonical_bytes: Buffer;
  created_at: string;
}

interface BlobRow {
  sha256: string;
  size: number;
  content_type: string | null;
  created_at: string;
}

export class SqliteManifestIndex {
  readonly db: DatabaseSync;
  private readonly now: () => Date;
  private closed = false;

  constructor(opts: SqliteManifestIndexOptions) {
    if (opts.path !== ":memory:") {
      const parent = path.dirname(path.resolve(opts.path));
      fs.mkdirSync(parent, { recursive: true });
    }
    this.db = new DatabaseSync(opts.path);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.now = opts.now ?? (() => new Date());
    runMigrations(this.db, opts.migrationsDir ?? DEFAULT_MIGRATIONS_DIR);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  // ── Manifest operations ────────────────────────────────────────

  /**
   * Insert a manifest row. The caller has already validated the name
   * and version via the type-layer helpers; this method re-validates
   * defensively so a future SDK consumer cannot bypass the rules.
   *
   * Returns the stored manifest (with canonical createdAt). Throws
   * `MANIFEST_EXISTS` when the (name, version) pair is already
   * present with different content; an identical re-put is a no-op
   * and returns the previously-stored row.
   */
  putManifest(input: Manifest, canonicalBytes: Buffer): Manifest {
    validateManifestName(input.name);
    validateManifestVersion(input.version);
    if (input.mediaType.length === 0) {
      throw new RegistryError(
        REGISTRY_ERROR_CODES.BAD_MANIFEST,
        "manifest mediaType must not be empty",
      );
    }

    const existing = this.fetchRow(input.name, input.version);
    if (existing) {
      if (Buffer.compare(existing.canonical_bytes, canonicalBytes) === 0) {
        return rowToManifest(existing);
      }
      throw new RegistryError(
        REGISTRY_ERROR_CODES.MANIFEST_EXISTS,
        `manifest ${input.name}@${input.version} already exists with different content`,
      );
    }

    const createdAt = input.createdAt || this.now().toISOString();
    this.db
      .prepare(
        `INSERT INTO manifest (
           name, version, media_type, blobs_json, annotations_json,
           signature_b64, signed_by, canonical_bytes, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.name,
        input.version,
        input.mediaType,
        JSON.stringify(input.blobs),
        input.annotations ? JSON.stringify(input.annotations) : null,
        input.signature?.signatureB64 ?? null,
        input.signature?.signedBy ?? null,
        canonicalBytes,
        createdAt,
      );
    return {
      ...input,
      createdAt,
    };
  }

  getManifest(name: string, version: string): Manifest | null {
    validateManifestName(name);
    validateManifestVersion(version);
    const row = this.fetchRow(name, version);
    return row ? rowToManifest(row) : null;
  }

  /**
   * Returns the canonical bytes the manifest was signed over. The
   * verify CLI uses this to feed `verifyManifest` the exact bytes
   * that produced the signature; we do not re-serialize because
   * that would invalidate any signature recorded on the row.
   */
  getCanonicalBytes(name: string, version: string): Buffer | null {
    validateManifestName(name);
    validateManifestVersion(version);
    const row = this.fetchRow(name, version);
    return row ? Buffer.from(row.canonical_bytes) : null;
  }

  listManifestVersions(name: string): ListedManifest[] {
    validateManifestName(name);
    const rows = this.db
      .prepare(
        `SELECT name, version, media_type, created_at,
                CASE WHEN signature_b64 IS NULL THEN 0 ELSE 1 END AS signed
         FROM manifest
         WHERE name = ?
         ORDER BY created_at DESC`,
      )
      .all(name) as Array<{
      name: string;
      version: string;
      media_type: string;
      created_at: string;
      signed: number;
    }>;
    return rows.map((r) => ({
      name: r.name,
      version: r.version,
      mediaType: r.media_type,
      createdAt: r.created_at,
      signed: r.signed === 1,
    }));
  }

  deleteManifest(name: string, version: string): void {
    validateManifestName(name);
    validateManifestVersion(version);
    this.db
      .prepare(`DELETE FROM manifest WHERE name = ? AND version = ?`)
      .run(name, version);
  }

  // ── Blob mirror operations ────────────────────────────────────

  recordBlob(blob: Blob): void {
    this.db
      .prepare(
        `INSERT INTO blob (sha256, size, content_type, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(sha256) DO NOTHING`,
      )
      .run(blob.sha256, blob.size, blob.contentType ?? null, blob.createdAt);
  }

  getBlobRecord(sha256: string): Blob | null {
    const row = this.db
      .prepare(`SELECT sha256, size, content_type, created_at FROM blob WHERE sha256 = ?`)
      .get(sha256) as BlobRow | undefined;
    if (!row) return null;
    return {
      sha256: row.sha256,
      size: row.size,
      contentType: row.content_type ?? undefined,
      createdAt: row.created_at,
    };
  }

  // ── Internals ─────────────────────────────────────────────────

  private fetchRow(name: string, version: string): ManifestRow | undefined {
    return this.db
      .prepare(
        `SELECT name, version, media_type, blobs_json, annotations_json,
                signature_b64, signed_by, canonical_bytes, created_at
         FROM manifest
         WHERE name = ? AND version = ?`,
      )
      .get(name, version) as ManifestRow | undefined;
  }
}

function rowToManifest(row: ManifestRow): Manifest {
  const blobs = JSON.parse(row.blobs_json) as BlobRef[];
  const annotations = row.annotations_json
    ? (JSON.parse(row.annotations_json) as Record<string, string>)
    : undefined;
  let signature: ManifestSignature | undefined;
  if (row.signature_b64 && row.signed_by) {
    signature = {
      signatureB64: row.signature_b64,
      signedBy: row.signed_by,
    };
  }
  return {
    name: row.name,
    version: row.version,
    mediaType: row.media_type,
    blobs,
    ...(annotations ? { annotations } : {}),
    ...(signature ? { signature } : {}),
    createdAt: row.created_at,
  };
}

// ── Migration runner (mirrors host) ─────────────────────────────────

interface MigrationFile {
  version: number;
  name: string;
  sql: string;
}

function runMigrations(db: DatabaseSync, dir: string): void {
  const migrations = loadMigrations(dir);

  const tableExists = db
    .prepare(
      "SELECT count(*) AS c FROM sqlite_master WHERE type='table' AND name='_migrations'",
    )
    .get() as { c: number } | undefined;
  const applied = new Set<number>();
  if (tableExists && tableExists.c > 0) {
    for (const row of db
      .prepare("SELECT version FROM _migrations")
      .all() as Array<{ version: number }>) {
      applied.add(row.version);
    }
  }

  for (const m of migrations) {
    if (applied.has(m.version)) continue;
    db.exec("BEGIN");
    try {
      db.exec(m.sql);
      db.prepare(
        "INSERT INTO _migrations (version, name, applied_at) VALUES (?, ?, ?)",
      ).run(m.version, m.name, new Date().toISOString());
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
}

function loadMigrations(dir: string): MigrationFile[] {
  if (!fs.existsSync(dir)) {
    throw new Error(`migrations directory not found: ${dir}`);
  }
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  return files.map((f) => {
    const match = /^(\d+)_(.+)\.sql$/.exec(f);
    if (!match) {
      throw new Error(`migration filename does not match NNNN_name.sql: ${f}`);
    }
    return {
      version: parseInt(match[1], 10),
      name: match[2],
      sql: fs.readFileSync(path.join(dir, f), "utf-8"),
    };
  });
}
