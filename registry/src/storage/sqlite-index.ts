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
  type CargoManifestMetadata,
  type ListedManifest,
  type Manifest,
  type ManifestKind,
  type ManifestSignature,
  type NpmManifestMetadata,
  type OciManifestMetadata,
  type Provenance,
  validateManifestName,
  validateManifestVersion,
} from "../types.js";
import { canonicalManifestBytes } from "../signing.js";

/**
 * Wrapper used by setCargoYanked: re-canonicalize a manifest after
 * mutating cargoMetadata.yanked in-place. The signing module's
 * canonicalManifestBytes strips `signature` before serializing,
 * which is exactly what we want here.
 */
function canonicalManifestBytesForRow(m: Manifest): Buffer {
  return canonicalManifestBytes(m);
}

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
  // WS6 wave-3 (M10):
  kind: ManifestKind;
  provenance_json: string | null;
  cargo_metadata_json: string | null;
  // v0.1.1 (npm facade):
  npm_metadata_json: string | null;
  // WS10 (v0.5 OCI facade):
  oci_metadata_json: string | null;
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
  putManifest(
    input: Manifest,
    canonicalBytes: Buffer,
    explicitProvenance?: Provenance,
  ): Manifest {
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
    // WS6 wave-3 (M10): kind comes from the operator-signed manifest
    // verbatim; the storage layer stores null when absent so
    // back-compat v0.4.0 manifests round-trip unchanged. The row's
    // `kind` column has DEFAULT 'generic' on the SQL side; we pass
    // input.kind so the row records exactly what the operator wrote.
    const kindForRow = input.kind ?? "generic";
    // WS6 wave-3 (M10): provenance lives on the row, NOT in the
    // manifest's canonical bytes. The default is 'manifest_create' at
    // current time; cache-fill and proxy paths supply explicit
    // provenance via the `provenance` parameter on putManifest.
    const provenance: Provenance = explicitProvenance ?? {
      source: "manifest_create",
      fetchedAt: createdAt,
    };
    this.db
      .prepare(
        `INSERT INTO manifest (
           name, version, media_type, blobs_json, annotations_json,
           signature_b64, signed_by, canonical_bytes, created_at,
           kind, provenance_json, cargo_metadata_json, npm_metadata_json,
           oci_metadata_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        kindForRow,
        JSON.stringify(provenance),
        input.cargoMetadata ? JSON.stringify(input.cargoMetadata) : null,
        input.npmMetadata ? JSON.stringify(input.npmMetadata) : null,
        input.ociMetadata ? JSON.stringify(input.ociMetadata) : null,
      );
    return {
      ...input,
      createdAt,
    };
  }

  /**
   * WS6 wave-3 (M10): fetch row-side provenance.
   */
  getProvenance(name: string, version: string): Provenance | null {
    validateManifestName(name);
    validateManifestVersion(version);
    const row = this.db
      .prepare(
        `SELECT provenance_json FROM manifest WHERE name = ? AND version = ?`,
      )
      .get(name, version) as { provenance_json: string | null } | undefined;
    if (!row || !row.provenance_json) return null;
    return JSON.parse(row.provenance_json) as Provenance;
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
        `SELECT name, version, media_type, kind, created_at,
                CASE WHEN signature_b64 IS NULL THEN 0 ELSE 1 END AS signed
         FROM manifest
         WHERE name = ?
         ORDER BY created_at DESC`,
      )
      .all(name) as Array<{
      name: string;
      version: string;
      media_type: string;
      kind: ManifestKind;
      created_at: string;
      signed: number;
    }>;
    return rows.map((r) => ({
      name: r.name,
      version: r.version,
      mediaType: r.media_type,
      kind: r.kind,
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

  // ── Forensic summary (WS6 wave-3 M10.5) ───────────────────────

  /**
   * Aggregate counts of manifests by (kind, provenance.source).
   * Powers the forensic-summary API: "what's in my registry and
   * where did it come from."
   *
   * Returns rows with `kind`, `source`, and `count` — one row per
   * (kind, source) combination present in the catalog. Empty array
   * when the registry is empty.
   */
  manifestCountsByKindAndSource(): Array<{
    kind: ManifestKind;
    source: string;
    count: number;
  }> {
    const rows = this.db
      .prepare(
        `SELECT kind,
                json_extract(provenance_json, '$.source') AS source,
                COUNT(*) AS count
         FROM manifest
         GROUP BY kind, source`,
      )
      .all() as Array<{
      kind: ManifestKind;
      source: string | null;
      count: number;
    }>;
    return rows.map((r) => ({
      kind: r.kind,
      source: r.source ?? "unknown",
      count: r.count,
    }));
  }

  /**
   * Aggregate blob counts grouped by the provenance.upstreamUrl
   * of any manifest that references the blob. Useful for "what
   * came from crates.io" forensics.
   *
   * Note: a single blob can be referenced by multiple manifests
   * with different provenances; the count here is "manifests
   * referencing the blob from this upstream", not "distinct
   * blobs by upstream."
   */
  artifactsByUpstream(): Array<{ upstreamUrl: string; count: number }> {
    const rows = this.db
      .prepare(
        `SELECT json_extract(provenance_json, '$.upstreamUrl') AS upstream,
                COUNT(*) AS count
         FROM manifest
         WHERE json_extract(provenance_json, '$.source') = 'proxy_cache'
         GROUP BY upstream
         ORDER BY count DESC`,
      )
      .all() as Array<{ upstream: string | null; count: number }>;
    return rows
      .filter((r): r is { upstream: string; count: number } => !!r.upstream)
      .map((r) => ({ upstreamUrl: r.upstream, count: r.count }));
  }

  // ── Virtual upstream config (WS6 wave-3 M10.4) ────────────────

  /**
   * Register a virtual-upstream row. The unique index on
   * (org, kind, upstream_url) makes this idempotent: re-adding
   * the same triple returns the existing row.
   */
  addVirtualUpstream(input: {
    org: string;
    kind: VirtualUpstreamKind;
    upstreamUrl: string;
    config?: VirtualUpstreamConfig;
    enabled?: boolean;
  }): VirtualUpstream {
    if (!/^https?:\/\//i.test(input.upstreamUrl)) {
      throw new RegistryError(
        REGISTRY_ERROR_CODES.BAD_NAME,
        `virtual upstream URL must be http(s); got '${input.upstreamUrl}'`,
      );
    }
    // Idempotent: try fetching first.
    const existing = this.db
      .prepare(
        `SELECT id FROM virtual_upstream
         WHERE org = ? AND kind = ? AND upstream_url = ?`,
      )
      .get(input.org, input.kind, input.upstreamUrl) as
      | { id: string }
      | undefined;
    if (existing) {
      const row = this.getVirtualUpstream(existing.id);
      if (row) return row;
    }
    const id = newAuditId();
    const now = this.now().toISOString();
    this.db
      .prepare(
        `INSERT INTO virtual_upstream
           (id, org, kind, upstream_url, config_json, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.org,
        input.kind,
        input.upstreamUrl,
        JSON.stringify(input.config ?? {}),
        (input.enabled ?? true) ? 1 : 0,
        now,
        now,
      );
    return {
      id,
      org: input.org,
      kind: input.kind,
      upstreamUrl: input.upstreamUrl,
      config: input.config ?? {},
      enabled: input.enabled ?? true,
      createdAt: now,
      updatedAt: now,
    };
  }

  /** Fetch a virtual-upstream row by id. */
  getVirtualUpstream(id: string): VirtualUpstream | null {
    const row = this.db
      .prepare(
        `SELECT id, org, kind, upstream_url, config_json, enabled, created_at, updated_at
         FROM virtual_upstream WHERE id = ?`,
      )
      .get(id) as VirtualUpstreamRow | undefined;
    return row ? rowToVirtualUpstream(row) : null;
  }

  /**
   * List virtual upstreams for an org. Filter by kind when set;
   * filter to enabled-only by default.
   */
  listVirtualUpstreams(opts: {
    org: string;
    kind?: VirtualUpstreamKind;
    includeDisabled?: boolean;
  }): VirtualUpstream[] {
    const where: string[] = ["org = ?"];
    const args: Array<string> = [opts.org];
    if (opts.kind) {
      where.push("kind = ?");
      args.push(opts.kind);
    }
    if (!opts.includeDisabled) {
      where.push("enabled = 1");
    }
    const rows = this.db
      .prepare(
        `SELECT id, org, kind, upstream_url, config_json, enabled, created_at, updated_at
         FROM virtual_upstream
         WHERE ${where.join(" AND ")}
         ORDER BY created_at ASC`,
      )
      .all(...args) as unknown as VirtualUpstreamRow[];
    return rows.map(rowToVirtualUpstream);
  }

  /** Remove a virtual-upstream row. Idempotent. */
  removeVirtualUpstream(id: string): void {
    this.db
      .prepare(`DELETE FROM virtual_upstream WHERE id = ?`)
      .run(id);
  }

  // ── Cargo yank state (WS6 wave-3 M10.3) ───────────────────────

  /**
   * Toggle the yanked flag on a cargo manifest row. The flag lives
   * inside `cargo_metadata_json`; we mutate the JSON in-place AND
   * clear the row's signature (since the canonical bytes change,
   * the original signature is no longer verifiable).
   *
   * Throws `MANIFEST_NOT_FOUND` when the row is absent OR when the
   * row's kind != 'cargo'.
   */
  setCargoYanked(name: string, version: string, yanked: boolean): void {
    validateManifestName(name);
    validateManifestVersion(version);
    const row = this.fetchRow(name, version);
    if (!row || row.kind !== "cargo" || !row.cargo_metadata_json) {
      throw new RegistryError(
        REGISTRY_ERROR_CODES.MANIFEST_NOT_FOUND,
        `cargo crate ${name}@${version} not found`,
      );
    }
    const meta = JSON.parse(row.cargo_metadata_json) as CargoManifestMetadata;
    if (meta.yanked === yanked) {
      // Idempotent no-op.
      return;
    }
    meta.yanked = yanked;
    const newMetaJson = JSON.stringify(meta);
    // Recompute canonical bytes for the row so getCanonicalBytes
    // reflects the post-yank state. We use a sorted-keys
    // serializer that mirrors the signing module's canonicalize.
    const manifest = rowToManifest({ ...row, cargo_metadata_json: newMetaJson });
    const canonical = canonicalManifestBytesForRow(manifest);
    this.db
      .prepare(
        `UPDATE manifest
         SET cargo_metadata_json = ?,
             canonical_bytes = ?,
             signature_b64 = NULL,
             signed_by = NULL
         WHERE name = ? AND version = ?`,
      )
      .run(newMetaJson, canonical, name, version);
  }

  // ── Audit log (WS6 wave-3 M10) ────────────────────────────────

  /**
   * Append an audit-log entry. Immutable by convention — no UPDATE
   * or DELETE handlers. The forensic API reads via
   * `listAuditEntries`.
   */
  appendAuditEntry(input: {
    action: AuditAction;
    entityType: AuditEntityType;
    entityId: string;
    actor: string;
    detail?: Record<string, unknown>;
  }): RegistryAuditEntry {
    const id = newAuditId();
    const createdAt = this.now().toISOString();
    this.db
      .prepare(
        `INSERT INTO registry_audit_log (
           id, action, entity_type, entity_id, actor, detail_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.action,
        input.entityType,
        input.entityId,
        input.actor,
        input.detail ? JSON.stringify(input.detail) : null,
        createdAt,
      );
    return {
      id,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      actor: input.actor,
      detail: input.detail,
      createdAt,
    };
  }

  /**
   * List audit-log entries newest-first. Filters AND-combine.
   */
  listAuditEntries(
    opts: {
      action?: AuditAction;
      entityType?: AuditEntityType;
      entityId?: string;
      actor?: string;
      since?: string;
      limit?: number;
    } = {},
  ): RegistryAuditEntry[] {
    const limit = opts.limit ?? 200;
    const where: string[] = [];
    const args: Array<string> = [];
    if (opts.action) {
      where.push("action = ?");
      args.push(opts.action);
    }
    if (opts.entityType) {
      where.push("entity_type = ?");
      args.push(opts.entityType);
    }
    if (opts.entityId) {
      where.push("entity_id = ?");
      args.push(opts.entityId);
    }
    if (opts.actor) {
      where.push("actor = ?");
      args.push(opts.actor);
    }
    if (opts.since) {
      where.push("created_at >= ?");
      args.push(opts.since);
    }
    const whereClause = where.length === 0 ? "" : `WHERE ${where.join(" AND ")}`;
    const rows = this.db
      .prepare(
        `SELECT id, action, entity_type, entity_id, actor, detail_json, created_at
         FROM registry_audit_log
         ${whereClause}
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(...args, limit) as Array<{
      id: string;
      action: AuditAction;
      entity_type: AuditEntityType;
      entity_id: string;
      actor: string;
      detail_json: string | null;
      created_at: string;
    }>;
    return rows.map((r) => ({
      id: r.id,
      action: r.action,
      entityType: r.entity_type,
      entityId: r.entity_id,
      actor: r.actor,
      detail: r.detail_json
        ? (JSON.parse(r.detail_json) as Record<string, unknown>)
        : undefined,
      createdAt: r.created_at,
    }));
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
                signature_b64, signed_by, canonical_bytes, created_at,
                kind, provenance_json, cargo_metadata_json, npm_metadata_json,
                oci_metadata_json
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
  const cargoMetadata: CargoManifestMetadata | undefined = row.cargo_metadata_json
    ? (JSON.parse(row.cargo_metadata_json) as CargoManifestMetadata)
    : undefined;
  const npmMetadata: NpmManifestMetadata | undefined = row.npm_metadata_json
    ? (JSON.parse(row.npm_metadata_json) as NpmManifestMetadata)
    : undefined;
  const ociMetadata: OciManifestMetadata | undefined = row.oci_metadata_json
    ? (JSON.parse(row.oci_metadata_json) as OciManifestMetadata)
    : undefined;
  // WS6 wave-3 (M10): only surface `kind` when the row actually
  // recorded a non-default value, so v0.4.0 manifests round-trip
  // signature-compatible.
  const includeKind = row.kind && row.kind !== "generic";
  return {
    name: row.name,
    version: row.version,
    mediaType: row.media_type,
    ...(includeKind ? { kind: row.kind } : {}),
    blobs,
    ...(annotations ? { annotations } : {}),
    ...(signature ? { signature } : {}),
    ...(cargoMetadata ? { cargoMetadata } : {}),
    ...(npmMetadata ? { npmMetadata } : {}),
    ...(ociMetadata ? { ociMetadata } : {}),
    createdAt: row.created_at,
  };
}

// ── Virtual upstream types (WS6 wave-3 M10.4) ───────────────────────

export type VirtualUpstreamKind = "cargo" | "npm" | "oci" | "maven" | "pip" | "helm";

/**
 * Per-upstream config. Free-form so future facades can carry their
 * own knobs (npm scopes, OCI media-type allowlist, etc.) without
 * schema changes.
 */
export interface VirtualUpstreamConfig {
  /** Glob patterns of names to allow from this upstream. */
  allow_patterns?: string[];
  /** Glob patterns of names to refuse from this upstream. */
  deny_patterns?: string[];
  /**
   * When true, the registry re-signs the cached manifest with the
   * operator's Ed25519 key on first cache. The upstream's original
   * signature (if any) is preserved on the row's provenance.
   */
  resign_on_cache?: boolean;
  /**
   * Optional Authorization header template for upstream requests.
   * Use `{token}` for the token placeholder when needed; tokens
   * come from env vars the operator sets out-of-band.
   */
  auth_header_template?: string;
  /**
   * Cache TTL for sparse-index entries (NOT for the immutable
   * tarball blobs — those are content-addressed and never expire).
   * After this many seconds, the next sparse-index request triggers
   * an upstream re-fetch even if the cached row exists. Default 0
   * (immutable cache; operator manually busts via DELETE manifest).
   */
  cache_ttl_seconds?: number;
}

export interface VirtualUpstream {
  id: string;
  org: string;
  kind: VirtualUpstreamKind;
  upstreamUrl: string;
  config: VirtualUpstreamConfig;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

interface VirtualUpstreamRow {
  id: string;
  org: string;
  kind: VirtualUpstreamKind;
  upstream_url: string;
  config_json: string;
  enabled: number;
  created_at: string;
  updated_at: string;
}

function rowToVirtualUpstream(row: VirtualUpstreamRow): VirtualUpstream {
  return {
    id: row.id,
    org: row.org,
    kind: row.kind,
    upstreamUrl: row.upstream_url,
    config: row.config_json
      ? (JSON.parse(row.config_json) as VirtualUpstreamConfig)
      : {},
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ── Audit log types (WS6 wave-3 M10) ────────────────────────────────

export type AuditAction =
  | "upload"
  | "proxy_cache"
  | "manifest_create"
  | "yank"
  | "unyank";

export type AuditEntityType =
  | "blob"
  | "manifest"
  | "cargo_crate"
  | "virtual_upstream";

export interface RegistryAuditEntry {
  id: string;
  action: AuditAction;
  entityType: AuditEntityType;
  entityId: string;
  actor: string;
  detail?: Record<string, unknown>;
  createdAt: string;
}

function newAuditId(): string {
  // Same Crockford-base32 ULID shape as the host. Cheap; we don't
  // import the host's ulid helper to avoid a cross-package coupling.
  const bytes = Buffer.alloc(16);
  for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  return bytes.toString("hex");
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
