/**
 * SQLite implementation of StorageDriver.
 *
 * Uses Node's built-in `node:sqlite` (DatabaseSync, stable as of Node
 * 22.5.0) wrapped in async repository methods so the driver interface
 * stays uniform across SQLite and the future Postgres driver. WAL mode
 * enabled for concurrent readers.
 *
 * Migrations are .sql files under storage/migrations/; the runner
 * applies them in filename order and records each in the `_migrations`
 * table. Migrations are intended to be Postgres-portable — see the
 * conventions header in 0001_init.sql.
 *
 * All eleven entity repos (orgs, apiKeys, products, releases,
 * artifacts, auditLog, targets, deployments, healthChecks, scenarios,
 * runs) are implemented as of PR 5.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { newId, nowIso } from "../ids.js";
import type {
  ApiKey,
  Artifact,
  ArtifactKind,
  AuditLogEntry,
  Deployment,
  DeploymentHealthSummary,
  DeploymentStatus,
  HealthCheck,
  HealthStatus,
  Org,
  OrgTier,
  Product,
  Release,
  ReleaseStatus,
  Run,
  RunTriggeredBy,
  Scenario,
  ScenarioSource,
  Target,
  TargetConnection,
  TargetKind,
} from "../types.js";
import {
  type ApiKeyRepo,
  type ArtifactRepo,
  type AuditLogRepo,
  type DeploymentRepo,
  type HealthCheckRepo,
  type OrgRepo,
  type ProductRepo,
  type ReleaseRepo,
  type RunRepo,
  type ScenarioRepo,
  StorageConflictError,
  type StorageDriver,
  StorageNotFoundError,
  type TargetRepo,
} from "./driver.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, "migrations");

// Generic SQL row — node:sqlite returns each row as a record of SQL
// output values keyed by column name.
type SqlRow = Record<string, unknown>;

// ── Driver ──────────────────────────────────────────────────────────

export interface SqliteDriverOptions {
  /** Filesystem path to the .db file. Use ":memory:" for tests. */
  path: string;
  /** Override migrations directory (tests). */
  migrationsDir?: string;
}

export class SqliteStorageDriver implements StorageDriver {
  readonly db: DatabaseSync;
  private readonly migrationsDir: string;
  private closed = false;

  readonly orgs: OrgRepo;
  readonly apiKeys: ApiKeyRepo;
  readonly products: ProductRepo;
  readonly releases: ReleaseRepo;
  readonly artifacts: ArtifactRepo;
  readonly auditLog: AuditLogRepo;
  readonly targets: TargetRepo;
  readonly deployments: DeploymentRepo;
  readonly healthChecks: HealthCheckRepo;
  readonly scenarios: ScenarioRepo;
  readonly runs: RunRepo;

  constructor(opts: SqliteDriverOptions) {
    if (opts.path !== ":memory:") {
      // node:sqlite fails at open if the parent directory is absent;
      // make sure first-boot from a vanilla home directory works
      // without manual mkdir.
      const parent = path.dirname(path.resolve(opts.path));
      fs.mkdirSync(parent, { recursive: true });
    }
    this.db = new DatabaseSync(opts.path);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.migrationsDir = opts.migrationsDir ?? MIGRATIONS_DIR;

    this.orgs = new SqliteOrgRepo(this.db);
    this.apiKeys = new SqliteApiKeyRepo(this.db);
    this.products = new SqliteProductRepo(this.db);
    this.releases = new SqliteReleaseRepo(this.db);
    this.artifacts = new SqliteArtifactRepo(this.db);
    this.auditLog = new SqliteAuditLogRepo(this.db);
    this.targets = new SqliteTargetRepo(this.db);
    this.deployments = new SqliteDeploymentRepo(this.db);
    this.healthChecks = new SqliteHealthCheckRepo(this.db);
    this.scenarios = new SqliteScenarioRepo(this.db);
    this.runs = new SqliteRunRepo(this.db);
  }

  async migrate(): Promise<void> {
    runMigrations(this.db, this.migrationsDir);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}

// ── Migration runner ────────────────────────────────────────────────

interface MigrationFile {
  version: number;
  name: string;
  sql: string;
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
    // Filename convention: NNNN_name.sql (4-digit zero-padded version).
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

function runMigrations(db: DatabaseSync, dir: string): void {
  const migrations = loadMigrations(dir);

  // Bootstrap _migrations if absent. Every migration file already
  // re-creates it with IF NOT EXISTS, but that creation is part of the
  // first migration's body — so on a fresh DB we need to actually
  // execute the migration to land it. The query below tolerates absence.
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
    runInTransaction(db, () => {
      db.exec(m.sql);
      // The first migration creates _migrations; subsequent migrations
      // assume it exists. After exec, insert the row.
      db.prepare(
        "INSERT INTO _migrations (version, name, applied_at) VALUES (?, ?, ?)",
      ).run(m.version, m.name, nowIso());
    });
  }
}

// ── Helpers ─────────────────────────────────────────────────────────

/**
 * node:sqlite reports SQLite errors with `code === 'ERR_SQLITE_ERROR'`
 * and the SQLite extended error code in `errcode`. Constraint
 * violations all share primary code 19 (SQLITE_CONSTRAINT) in the low
 * byte; the extended code carries the subtype in the high byte.
 *
 * https://www.sqlite.org/rescode.html#extrc
 */
function mapSqliteError(err: unknown): never {
  const e = err as { code?: string; errcode?: number; message: string };
  if (e.code === "ERR_SQLITE_ERROR" && typeof e.errcode === "number") {
    if ((e.errcode & 0xff) === 19) {
      throw new StorageConflictError(e.message);
    }
  }
  throw err;
}

function runInTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // If ROLLBACK itself fails the connection is in trouble; rethrow
      // the original error rather than masking it.
    }
    throw err;
  }
}

/**
 * Prepare a statement and enable bare named parameters so `.run({ name })`
 * binds to `@name` / `:name` placeholders without the prefix in the JS
 * object. Matches better-sqlite3's ergonomics.
 */
function prep(db: DatabaseSync, sql: string): StatementSync {
  const stmt = db.prepare(sql);
  stmt.setAllowBareNamedParameters(true);
  return stmt;
}

// ── Row mappers ─────────────────────────────────────────────────────

function mapOrg(row: SqlRow): Org {
  return {
    id: row.id as string,
    name: row.name as string,
    tier: row.tier as OrgTier,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    deletedAt: (row.deleted_at as string | null) ?? null,
  };
}

function mapApiKey(row: SqlRow): ApiKey {
  return {
    id: row.id as string,
    orgId: row.org_id as string,
    prefix: row.prefix as string,
    hash: row.hash as string,
    name: row.name as string,
    expiresAt: (row.expires_at as string | null) ?? null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    deletedAt: (row.deleted_at as string | null) ?? null,
  };
}

function mapProduct(row: SqlRow): Product {
  return {
    id: row.id as string,
    orgId: row.org_id as string,
    name: row.name as string,
    repoUrl: row.repo_url as string,
    buildYamlPath: row.build_yaml_path as string,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    deletedAt: (row.deleted_at as string | null) ?? null,
  };
}

function mapRelease(row: SqlRow): Release {
  return {
    id: row.id as string,
    orgId: row.org_id as string,
    productId: row.product_id as string,
    tag: row.tag as string,
    commitSha: row.commit_sha as string,
    manifestSha256: (row.manifest_sha256 as string | null) ?? null,
    signedBy: (row.signed_by as string | null) ?? null,
    builtAt: (row.built_at as string | null) ?? null,
    builtByRunnerId: (row.built_by_runner_id as string | null) ?? null,
    status: row.status as ReleaseStatus,
    buildYamlJson: (row.build_yaml_json as string | null) ?? null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    deletedAt: (row.deleted_at as string | null) ?? null,
  };
}

function mapArtifact(row: SqlRow): Artifact {
  return {
    id: row.id as string,
    releaseId: row.release_id as string,
    component: row.component as string,
    kind: row.kind as ArtifactKind,
    sha256: (row.sha256 as string | null) ?? null,
    sizeBytes: (row.size_bytes as number | null) ?? null,
    blobUri: (row.blob_uri as string | null) ?? null,
    imageRef: (row.image_ref as string | null) ?? null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    deletedAt: (row.deleted_at as string | null) ?? null,
  };
}

function mapAuditLog(row: SqlRow): AuditLogEntry {
  return {
    id: row.id as string,
    orgId: row.org_id as string,
    actor: row.actor as string,
    action: row.action as string,
    entityType: row.entity_type as string,
    entityId: row.entity_id as string,
    detail: row.detail
      ? (JSON.parse(row.detail as string) as Record<string, unknown>)
      : null,
    at: row.at as string,
    createdAt: row.created_at as string,
  };
}

// ── Repos ───────────────────────────────────────────────────────────

class SqliteOrgRepo implements OrgRepo {
  constructor(private readonly db: DatabaseSync) {}

  async create(input: { name: string; tier?: OrgTier }): Promise<Org> {
    const now = nowIso();
    const bind = {
      id: newId(),
      name: input.name,
      tier: input.tier ?? "free",
      created_at: now,
      updated_at: now,
    };
    try {
      prep(
        this.db,
        "INSERT INTO org (id, name, tier, created_at, updated_at) VALUES (@id, @name, @tier, @created_at, @updated_at)",
      ).run(bind);
    } catch (err) {
      mapSqliteError(err);
    }
    return mapOrg({ ...bind, deleted_at: null });
  }

  async get(id: string): Promise<Org | null> {
    const row = this.db
      .prepare("SELECT * FROM org WHERE id = ? AND deleted_at IS NULL")
      .get(id) as SqlRow | undefined;
    return row ? mapOrg(row) : null;
  }

  async getByName(name: string): Promise<Org | null> {
    const row = this.db
      .prepare("SELECT * FROM org WHERE name = ? AND deleted_at IS NULL")
      .get(name) as SqlRow | undefined;
    return row ? mapOrg(row) : null;
  }

  async list(): Promise<Org[]> {
    return (
      this.db
        .prepare("SELECT * FROM org WHERE deleted_at IS NULL ORDER BY created_at")
        .all() as SqlRow[]
    ).map(mapOrg);
  }

  async update(id: string, patch: Partial<Pick<Org, "name" | "tier">>): Promise<Org> {
    const existing = await this.get(id);
    if (!existing) throw new StorageNotFoundError("org", id);
    const bind = {
      id: existing.id,
      name: patch.name ?? existing.name,
      tier: patch.tier ?? existing.tier,
      updated_at: nowIso(),
    };
    try {
      prep(
        this.db,
        "UPDATE org SET name = @name, tier = @tier, updated_at = @updated_at WHERE id = @id",
      ).run(bind);
    } catch (err) {
      mapSqliteError(err);
    }
    return mapOrg({
      ...bind,
      created_at: existing.createdAt,
      deleted_at: existing.deletedAt,
    });
  }

  async softDelete(id: string): Promise<void> {
    const now = nowIso();
    const result = this.db
      .prepare(
        "UPDATE org SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL",
      )
      .run(now, now, id);
    if (result.changes === 0) throw new StorageNotFoundError("org", id);
  }
}

class SqliteApiKeyRepo implements ApiKeyRepo {
  constructor(private readonly db: DatabaseSync) {}

  async create(input: {
    orgId: string;
    name: string;
    prefix: string;
    hash: string;
    expiresAt?: string;
  }): Promise<ApiKey> {
    const now = nowIso();
    const bind = {
      id: newId(),
      org_id: input.orgId,
      prefix: input.prefix,
      hash: input.hash,
      name: input.name,
      expires_at: input.expiresAt ?? null,
      created_at: now,
      updated_at: now,
    };
    try {
      prep(
        this.db,
        "INSERT INTO api_key (id, org_id, prefix, hash, name, expires_at, created_at, updated_at) VALUES (@id, @org_id, @prefix, @hash, @name, @expires_at, @created_at, @updated_at)",
      ).run(bind);
    } catch (err) {
      mapSqliteError(err);
    }
    return mapApiKey({ ...bind, deleted_at: null });
  }

  async get(id: string): Promise<ApiKey | null> {
    const row = this.db
      .prepare("SELECT * FROM api_key WHERE id = ? AND deleted_at IS NULL")
      .get(id) as SqlRow | undefined;
    return row ? mapApiKey(row) : null;
  }

  async getByPrefix(prefix: string): Promise<ApiKey | null> {
    const row = this.db
      .prepare("SELECT * FROM api_key WHERE prefix = ? AND deleted_at IS NULL")
      .get(prefix) as SqlRow | undefined;
    return row ? mapApiKey(row) : null;
  }

  async listForOrg(orgId: string): Promise<ApiKey[]> {
    return (
      this.db
        .prepare(
          "SELECT * FROM api_key WHERE org_id = ? AND deleted_at IS NULL ORDER BY created_at",
        )
        .all(orgId) as SqlRow[]
    ).map(mapApiKey);
  }

  async softDelete(id: string): Promise<void> {
    const now = nowIso();
    const result = this.db
      .prepare(
        "UPDATE api_key SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL",
      )
      .run(now, now, id);
    if (result.changes === 0) throw new StorageNotFoundError("api_key", id);
  }
}

class SqliteProductRepo implements ProductRepo {
  constructor(private readonly db: DatabaseSync) {}

  async create(input: {
    orgId: string;
    name: string;
    repoUrl: string;
    buildYamlPath?: string;
  }): Promise<Product> {
    const now = nowIso();
    const bind = {
      id: newId(),
      org_id: input.orgId,
      name: input.name,
      repo_url: input.repoUrl,
      build_yaml_path: input.buildYamlPath ?? "signalman.build.yaml",
      created_at: now,
      updated_at: now,
    };
    try {
      prep(
        this.db,
        "INSERT INTO product (id, org_id, name, repo_url, build_yaml_path, created_at, updated_at) VALUES (@id, @org_id, @name, @repo_url, @build_yaml_path, @created_at, @updated_at)",
      ).run(bind);
    } catch (err) {
      mapSqliteError(err);
    }
    return mapProduct({ ...bind, deleted_at: null });
  }

  async get(id: string): Promise<Product | null> {
    const row = this.db
      .prepare("SELECT * FROM product WHERE id = ? AND deleted_at IS NULL")
      .get(id) as SqlRow | undefined;
    return row ? mapProduct(row) : null;
  }

  async getByName(orgId: string, name: string): Promise<Product | null> {
    const row = this.db
      .prepare(
        "SELECT * FROM product WHERE org_id = ? AND name = ? AND deleted_at IS NULL",
      )
      .get(orgId, name) as SqlRow | undefined;
    return row ? mapProduct(row) : null;
  }

  async listForOrg(orgId: string): Promise<Product[]> {
    return (
      this.db
        .prepare(
          "SELECT * FROM product WHERE org_id = ? AND deleted_at IS NULL ORDER BY name",
        )
        .all(orgId) as SqlRow[]
    ).map(mapProduct);
  }

  async update(
    id: string,
    patch: Partial<Pick<Product, "name" | "repoUrl" | "buildYamlPath">>,
  ): Promise<Product> {
    const existing = await this.get(id);
    if (!existing) throw new StorageNotFoundError("product", id);
    const bind = {
      id: existing.id,
      name: patch.name ?? existing.name,
      repo_url: patch.repoUrl ?? existing.repoUrl,
      build_yaml_path: patch.buildYamlPath ?? existing.buildYamlPath,
      updated_at: nowIso(),
    };
    try {
      prep(
        this.db,
        "UPDATE product SET name = @name, repo_url = @repo_url, build_yaml_path = @build_yaml_path, updated_at = @updated_at WHERE id = @id",
      ).run(bind);
    } catch (err) {
      mapSqliteError(err);
    }
    return mapProduct({
      ...bind,
      org_id: existing.orgId,
      created_at: existing.createdAt,
      deleted_at: existing.deletedAt,
    });
  }

  async softDelete(id: string): Promise<void> {
    const now = nowIso();
    const result = this.db
      .prepare(
        "UPDATE product SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL",
      )
      .run(now, now, id);
    if (result.changes === 0) throw new StorageNotFoundError("product", id);
  }
}

class SqliteReleaseRepo implements ReleaseRepo {
  constructor(private readonly db: DatabaseSync) {}

  async create(input: {
    orgId: string;
    productId: string;
    tag: string;
    commitSha: string;
    status?: ReleaseStatus;
  }): Promise<Release> {
    const now = nowIso();
    const bind = {
      id: newId(),
      org_id: input.orgId,
      product_id: input.productId,
      tag: input.tag,
      commit_sha: input.commitSha,
      status: input.status ?? "building",
      created_at: now,
      updated_at: now,
    };
    try {
      prep(
        this.db,
        "INSERT INTO release (id, org_id, product_id, tag, commit_sha, status, created_at, updated_at) VALUES (@id, @org_id, @product_id, @tag, @commit_sha, @status, @created_at, @updated_at)",
      ).run(bind);
    } catch (err) {
      mapSqliteError(err);
    }
    return mapRelease({
      ...bind,
      manifest_sha256: null,
      signed_by: null,
      built_at: null,
      built_by_runner_id: null,
      build_yaml_json: null,
      deleted_at: null,
    });
  }

  async get(id: string): Promise<Release | null> {
    const row = this.db
      .prepare("SELECT * FROM release WHERE id = ? AND deleted_at IS NULL")
      .get(id) as SqlRow | undefined;
    return row ? mapRelease(row) : null;
  }

  async getByTag(productId: string, tag: string): Promise<Release | null> {
    const row = this.db
      .prepare(
        "SELECT * FROM release WHERE product_id = ? AND tag = ? AND deleted_at IS NULL",
      )
      .get(productId, tag) as SqlRow | undefined;
    return row ? mapRelease(row) : null;
  }

  async listForProduct(
    productId: string,
    opts: { status?: ReleaseStatus } = {},
  ): Promise<Release[]> {
    if (opts.status) {
      return (
        this.db
          .prepare(
            "SELECT * FROM release WHERE product_id = ? AND status = ? AND deleted_at IS NULL ORDER BY created_at DESC",
          )
          .all(productId, opts.status) as SqlRow[]
      ).map(mapRelease);
    }
    return (
      this.db
        .prepare(
          "SELECT * FROM release WHERE product_id = ? AND deleted_at IS NULL ORDER BY created_at DESC",
        )
        .all(productId) as SqlRow[]
    ).map(mapRelease);
  }

  async update(
    id: string,
    patch: Partial<
      Pick<
        Release,
        | "manifestSha256"
        | "signedBy"
        | "builtAt"
        | "builtByRunnerId"
        | "status"
        | "buildYamlJson"
      >
    >,
  ): Promise<Release> {
    const existing = await this.get(id);
    if (!existing) throw new StorageNotFoundError("release", id);
    const bind = {
      id: existing.id,
      manifest_sha256: patch.manifestSha256 ?? existing.manifestSha256,
      signed_by: patch.signedBy ?? existing.signedBy,
      built_at: patch.builtAt ?? existing.builtAt,
      built_by_runner_id: patch.builtByRunnerId ?? existing.builtByRunnerId,
      status: patch.status ?? existing.status,
      build_yaml_json: patch.buildYamlJson ?? existing.buildYamlJson,
      updated_at: nowIso(),
    };
    try {
      prep(
        this.db,
        "UPDATE release SET manifest_sha256 = @manifest_sha256, signed_by = @signed_by, built_at = @built_at, built_by_runner_id = @built_by_runner_id, status = @status, build_yaml_json = @build_yaml_json, updated_at = @updated_at WHERE id = @id",
      ).run(bind);
    } catch (err) {
      mapSqliteError(err);
    }
    return mapRelease({
      ...bind,
      org_id: existing.orgId,
      product_id: existing.productId,
      tag: existing.tag,
      commit_sha: existing.commitSha,
      created_at: existing.createdAt,
      deleted_at: existing.deletedAt,
    });
  }

  async softDelete(id: string): Promise<void> {
    const now = nowIso();
    const result = this.db
      .prepare(
        "UPDATE release SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL",
      )
      .run(now, now, id);
    if (result.changes === 0) throw new StorageNotFoundError("release", id);
  }
}

class SqliteArtifactRepo implements ArtifactRepo {
  constructor(private readonly db: DatabaseSync) {}

  async create(input: {
    releaseId: string;
    component: string;
    kind: ArtifactKind;
    sha256?: string;
    sizeBytes?: number;
    blobUri?: string;
    imageRef?: string;
  }): Promise<Artifact> {
    const now = nowIso();
    const bind = {
      id: newId(),
      release_id: input.releaseId,
      component: input.component,
      kind: input.kind,
      sha256: input.sha256 ?? null,
      size_bytes: input.sizeBytes ?? null,
      blob_uri: input.blobUri ?? null,
      image_ref: input.imageRef ?? null,
      created_at: now,
      updated_at: now,
    };
    try {
      prep(
        this.db,
        "INSERT INTO artifact (id, release_id, component, kind, sha256, size_bytes, blob_uri, image_ref, created_at, updated_at) VALUES (@id, @release_id, @component, @kind, @sha256, @size_bytes, @blob_uri, @image_ref, @created_at, @updated_at)",
      ).run(bind);
    } catch (err) {
      mapSqliteError(err);
    }
    return mapArtifact({ ...bind, deleted_at: null });
  }

  async get(id: string): Promise<Artifact | null> {
    const row = this.db
      .prepare("SELECT * FROM artifact WHERE id = ? AND deleted_at IS NULL")
      .get(id) as SqlRow | undefined;
    return row ? mapArtifact(row) : null;
  }

  async listForRelease(releaseId: string): Promise<Artifact[]> {
    return (
      this.db
        .prepare(
          "SELECT * FROM artifact WHERE release_id = ? AND deleted_at IS NULL ORDER BY component",
        )
        .all(releaseId) as SqlRow[]
    ).map(mapArtifact);
  }

  async softDelete(id: string): Promise<void> {
    const now = nowIso();
    const result = this.db
      .prepare(
        "UPDATE artifact SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL",
      )
      .run(now, now, id);
    if (result.changes === 0) throw new StorageNotFoundError("artifact", id);
  }
}

class SqliteAuditLogRepo implements AuditLogRepo {
  constructor(private readonly db: DatabaseSync) {}

  async append(input: {
    orgId: string;
    actor: string;
    action: string;
    entityType: string;
    entityId: string;
    detail?: Record<string, unknown>;
  }): Promise<AuditLogEntry> {
    const now = nowIso();
    const bind = {
      id: newId(),
      org_id: input.orgId,
      actor: input.actor,
      action: input.action,
      entity_type: input.entityType,
      entity_id: input.entityId,
      detail: input.detail ? JSON.stringify(input.detail) : null,
      at: now,
      created_at: now,
    };
    try {
      prep(
        this.db,
        "INSERT INTO audit_log (id, org_id, actor, action, entity_type, entity_id, detail, at, created_at) VALUES (@id, @org_id, @actor, @action, @entity_type, @entity_id, @detail, @at, @created_at)",
      ).run(bind);
    } catch (err) {
      mapSqliteError(err);
    }
    return mapAuditLog(bind);
  }

  async listForOrg(
    orgId: string,
    opts: { limit?: number; entityType?: string; entityId?: string } = {},
  ): Promise<AuditLogEntry[]> {
    const limit = opts.limit ?? 100;
    if (opts.entityType && opts.entityId) {
      return (
        this.db
          .prepare(
            "SELECT * FROM audit_log WHERE org_id = ? AND entity_type = ? AND entity_id = ? ORDER BY at DESC LIMIT ?",
          )
          .all(orgId, opts.entityType, opts.entityId, limit) as SqlRow[]
      ).map(mapAuditLog);
    }
    if (opts.entityType) {
      return (
        this.db
          .prepare(
            "SELECT * FROM audit_log WHERE org_id = ? AND entity_type = ? ORDER BY at DESC LIMIT ?",
          )
          .all(orgId, opts.entityType, limit) as SqlRow[]
      ).map(mapAuditLog);
    }
    return (
      this.db
        .prepare("SELECT * FROM audit_log WHERE org_id = ? ORDER BY at DESC LIMIT ?")
        .all(orgId, limit) as SqlRow[]
    ).map(mapAuditLog);
  }
}

// ── Row mappers (PR 3 entities) ─────────────────────────────────────

function mapTarget(row: SqlRow): Target {
  return {
    id: row.id as string,
    orgId: row.org_id as string,
    name: row.name as string,
    kind: row.kind as TargetKind,
    connection: JSON.parse(row.connection as string) as TargetConnection,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    deletedAt: (row.deleted_at as string | null) ?? null,
  };
}

function mapDeployment(row: SqlRow): Deployment {
  return {
    id: row.id as string,
    orgId: row.org_id as string,
    releaseId: row.release_id as string,
    targetId: row.target_id as string,
    status: row.status as DeploymentStatus,
    startedAt: (row.started_at as string | null) ?? null,
    completedAt: (row.completed_at as string | null) ?? null,
    previousDeploymentId: (row.previous_deployment_id as string | null) ?? null,
    healthSummary: row.health_summary
      ? (JSON.parse(row.health_summary as string) as DeploymentHealthSummary)
      : null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    deletedAt: (row.deleted_at as string | null) ?? null,
  };
}

function mapHealthCheck(row: SqlRow): HealthCheck {
  return {
    id: row.id as string,
    deploymentId: row.deployment_id as string,
    probeName: row.probe_name as string,
    status: row.status as HealthStatus,
    latencyMs: (row.latency_ms as number | null) ?? null,
    detail: (row.detail as string | null) ?? null,
    checkedAt: row.checked_at as string,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    deletedAt: (row.deleted_at as string | null) ?? null,
  };
}

// ── Repos (PR 3 entities) ───────────────────────────────────────────

class SqliteTargetRepo implements TargetRepo {
  constructor(private readonly db: DatabaseSync) {}

  async create(input: {
    orgId: string;
    name: string;
    kind: TargetKind;
    connection: TargetConnection;
  }): Promise<Target> {
    const now = nowIso();
    const bind = {
      id: newId(),
      org_id: input.orgId,
      name: input.name,
      kind: input.kind,
      connection: JSON.stringify(input.connection),
      created_at: now,
      updated_at: now,
    };
    try {
      prep(
        this.db,
        "INSERT INTO target (id, org_id, name, kind, connection, created_at, updated_at) VALUES (@id, @org_id, @name, @kind, @connection, @created_at, @updated_at)",
      ).run(bind);
    } catch (err) {
      mapSqliteError(err);
    }
    return mapTarget({ ...bind, deleted_at: null });
  }

  async get(id: string): Promise<Target | null> {
    const row = this.db
      .prepare("SELECT * FROM target WHERE id = ? AND deleted_at IS NULL")
      .get(id) as SqlRow | undefined;
    return row ? mapTarget(row) : null;
  }

  async getByName(orgId: string, name: string): Promise<Target | null> {
    const row = this.db
      .prepare(
        "SELECT * FROM target WHERE org_id = ? AND name = ? AND deleted_at IS NULL",
      )
      .get(orgId, name) as SqlRow | undefined;
    return row ? mapTarget(row) : null;
  }

  async listForOrg(orgId: string): Promise<Target[]> {
    return (
      this.db
        .prepare(
          "SELECT * FROM target WHERE org_id = ? AND deleted_at IS NULL ORDER BY name",
        )
        .all(orgId) as SqlRow[]
    ).map(mapTarget);
  }

  async softDelete(id: string): Promise<void> {
    const now = nowIso();
    const result = this.db
      .prepare(
        "UPDATE target SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL",
      )
      .run(now, now, id);
    if (result.changes === 0) throw new StorageNotFoundError("target", id);
  }
}

class SqliteDeploymentRepo implements DeploymentRepo {
  constructor(private readonly db: DatabaseSync) {}

  async create(input: {
    orgId: string;
    releaseId: string;
    targetId: string;
    previousDeploymentId?: string;
  }): Promise<Deployment> {
    const now = nowIso();
    const bind = {
      id: newId(),
      org_id: input.orgId,
      release_id: input.releaseId,
      target_id: input.targetId,
      status: "pending" as DeploymentStatus,
      previous_deployment_id: input.previousDeploymentId ?? null,
      created_at: now,
      updated_at: now,
    };
    try {
      prep(
        this.db,
        "INSERT INTO deployment (id, org_id, release_id, target_id, status, previous_deployment_id, created_at, updated_at) VALUES (@id, @org_id, @release_id, @target_id, @status, @previous_deployment_id, @created_at, @updated_at)",
      ).run(bind);
    } catch (err) {
      mapSqliteError(err);
    }
    return mapDeployment({
      ...bind,
      started_at: null,
      completed_at: null,
      health_summary: null,
      deleted_at: null,
    });
  }

  async get(id: string): Promise<Deployment | null> {
    const row = this.db
      .prepare("SELECT * FROM deployment WHERE id = ? AND deleted_at IS NULL")
      .get(id) as SqlRow | undefined;
    return row ? mapDeployment(row) : null;
  }

  async getActiveForTarget(targetId: string): Promise<Deployment | null> {
    const row = this.db
      .prepare(
        "SELECT * FROM deployment WHERE target_id = ? AND status = 'active' AND deleted_at IS NULL",
      )
      .get(targetId) as SqlRow | undefined;
    return row ? mapDeployment(row) : null;
  }

  async listForTarget(
    targetId: string,
    opts: { limit?: number } = {},
  ): Promise<Deployment[]> {
    const limit = opts.limit ?? 100;
    return (
      this.db
        .prepare(
          "SELECT * FROM deployment WHERE target_id = ? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT ?",
        )
        .all(targetId, limit) as SqlRow[]
    ).map(mapDeployment);
  }

  async update(
    id: string,
    patch: Partial<
      Pick<Deployment, "status" | "startedAt" | "completedAt" | "healthSummary">
    >,
  ): Promise<Deployment> {
    const existing = await this.get(id);
    if (!existing) throw new StorageNotFoundError("deployment", id);
    const bind = {
      id: existing.id,
      status: patch.status ?? existing.status,
      started_at: patch.startedAt ?? existing.startedAt,
      completed_at: patch.completedAt ?? existing.completedAt,
      health_summary:
        patch.healthSummary !== undefined
          ? patch.healthSummary === null
            ? null
            : JSON.stringify(patch.healthSummary)
          : existing.healthSummary
            ? JSON.stringify(existing.healthSummary)
            : null,
      updated_at: nowIso(),
    };
    try {
      prep(
        this.db,
        "UPDATE deployment SET status = @status, started_at = @started_at, completed_at = @completed_at, health_summary = @health_summary, updated_at = @updated_at WHERE id = @id",
      ).run(bind);
    } catch (err) {
      mapSqliteError(err);
    }
    return mapDeployment({
      ...bind,
      org_id: existing.orgId,
      release_id: existing.releaseId,
      target_id: existing.targetId,
      previous_deployment_id: existing.previousDeploymentId,
      created_at: existing.createdAt,
      deleted_at: existing.deletedAt,
    });
  }
}

class SqliteHealthCheckRepo implements HealthCheckRepo {
  constructor(private readonly db: DatabaseSync) {}

  async append(input: {
    deploymentId: string;
    probeName: string;
    status: HealthStatus;
    latencyMs?: number;
    detail?: string;
  }): Promise<HealthCheck> {
    const now = nowIso();
    const bind = {
      id: newId(),
      deployment_id: input.deploymentId,
      probe_name: input.probeName,
      status: input.status,
      latency_ms: input.latencyMs ?? null,
      detail: input.detail ?? null,
      checked_at: now,
      created_at: now,
      updated_at: now,
    };
    try {
      prep(
        this.db,
        "INSERT INTO health_check (id, deployment_id, probe_name, status, latency_ms, detail, checked_at, created_at, updated_at) VALUES (@id, @deployment_id, @probe_name, @status, @latency_ms, @detail, @checked_at, @created_at, @updated_at)",
      ).run(bind);
    } catch (err) {
      mapSqliteError(err);
    }
    return mapHealthCheck({ ...bind, deleted_at: null });
  }

  async listForDeployment(
    deploymentId: string,
    opts: { since?: string; limit?: number } = {},
  ): Promise<HealthCheck[]> {
    const limit = opts.limit ?? 100;
    if (opts.since) {
      return (
        this.db
          .prepare(
            "SELECT * FROM health_check WHERE deployment_id = ? AND checked_at >= ? AND deleted_at IS NULL ORDER BY checked_at DESC LIMIT ?",
          )
          .all(deploymentId, opts.since, limit) as SqlRow[]
      ).map(mapHealthCheck);
    }
    return (
      this.db
        .prepare(
          "SELECT * FROM health_check WHERE deployment_id = ? AND deleted_at IS NULL ORDER BY checked_at DESC LIMIT ?",
        )
        .all(deploymentId, limit) as SqlRow[]
    ).map(mapHealthCheck);
  }
}

// ── Row mappers (PR 5 entities) ─────────────────────────────────────

function mapScenario(row: SqlRow): Scenario {
  return {
    id: row.id as string,
    orgId: row.org_id as string,
    path: row.path as string,
    scenarioHash: row.scenario_hash as string,
    name: row.name as string,
    tags: JSON.parse(row.tags as string) as string[],
    source: row.source as ScenarioSource,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    deletedAt: (row.deleted_at as string | null) ?? null,
  };
}

function mapRun(row: SqlRow): Run {
  return {
    id: row.id as string,
    orgId: row.org_id as string,
    scenarioId: row.scenario_id as string,
    targetId: (row.target_id as string | null) ?? null,
    triggeredBy: row.triggered_by as RunTriggeredBy,
    envelopeBlobUri: (row.envelope_blob_uri as string | null) ?? null,
    result: (row.result as string | null) ?? null,
    startedAt: (row.started_at as string | null) ?? null,
    completedAt: (row.completed_at as string | null) ?? null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    deletedAt: (row.deleted_at as string | null) ?? null,
  };
}

// ── Repos (PR 5 entities) ───────────────────────────────────────────

class SqliteScenarioRepo implements ScenarioRepo {
  constructor(private readonly db: DatabaseSync) {}

  async upsertFromDisk(input: {
    orgId: string;
    path: string;
    scenarioHash: string;
    name: string;
    tags: string[];
  }): Promise<Scenario> {
    const existing = await this.getByPath(input.orgId, input.path);
    if (existing) {
      // Same path, possibly different hash/name/tags → update in place.
      const bind = {
        id: existing.id,
        scenario_hash: input.scenarioHash,
        name: input.name,
        tags: JSON.stringify(input.tags),
        updated_at: nowIso(),
      };
      try {
        prep(
          this.db,
          "UPDATE scenario SET scenario_hash = @scenario_hash, name = @name, tags = @tags, updated_at = @updated_at WHERE id = @id",
        ).run(bind);
      } catch (err) {
        mapSqliteError(err);
      }
      return mapScenario({
        ...bind,
        org_id: existing.orgId,
        path: existing.path,
        source: existing.source,
        created_at: existing.createdAt,
        deleted_at: existing.deletedAt,
      });
    }
    // First time we've seen this path → insert.
    const now = nowIso();
    const bind = {
      id: newId(),
      org_id: input.orgId,
      path: input.path,
      scenario_hash: input.scenarioHash,
      name: input.name,
      tags: JSON.stringify(input.tags),
      source: "disk" as ScenarioSource,
      created_at: now,
      updated_at: now,
    };
    try {
      prep(
        this.db,
        "INSERT INTO scenario (id, org_id, path, scenario_hash, name, tags, source, created_at, updated_at) VALUES (@id, @org_id, @path, @scenario_hash, @name, @tags, @source, @created_at, @updated_at)",
      ).run(bind);
    } catch (err) {
      mapSqliteError(err);
    }
    return mapScenario({ ...bind, deleted_at: null });
  }

  async get(id: string): Promise<Scenario | null> {
    const row = this.db
      .prepare("SELECT * FROM scenario WHERE id = ? AND deleted_at IS NULL")
      .get(id) as SqlRow | undefined;
    return row ? mapScenario(row) : null;
  }

  async getByPath(orgId: string, p: string): Promise<Scenario | null> {
    const row = this.db
      .prepare(
        "SELECT * FROM scenario WHERE org_id = ? AND path = ? AND deleted_at IS NULL",
      )
      .get(orgId, p) as SqlRow | undefined;
    return row ? mapScenario(row) : null;
  }

  async listForOrg(orgId: string): Promise<Scenario[]> {
    return (
      this.db
        .prepare(
          "SELECT * FROM scenario WHERE org_id = ? AND deleted_at IS NULL ORDER BY path",
        )
        .all(orgId) as SqlRow[]
    ).map(mapScenario);
  }

  async softDelete(id: string): Promise<void> {
    const now = nowIso();
    const result = this.db
      .prepare(
        "UPDATE scenario SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL",
      )
      .run(now, now, id);
    if (result.changes === 0) throw new StorageNotFoundError("scenario", id);
  }
}

class SqliteRunRepo implements RunRepo {
  constructor(private readonly db: DatabaseSync) {}

  async create(input: {
    orgId: string;
    scenarioId: string;
    targetId?: string;
    triggeredBy: RunTriggeredBy;
  }): Promise<Run> {
    const now = nowIso();
    const bind = {
      id: newId(),
      org_id: input.orgId,
      scenario_id: input.scenarioId,
      target_id: input.targetId ?? null,
      triggered_by: input.triggeredBy,
      created_at: now,
      updated_at: now,
    };
    try {
      prep(
        this.db,
        "INSERT INTO run (id, org_id, scenario_id, target_id, triggered_by, created_at, updated_at) VALUES (@id, @org_id, @scenario_id, @target_id, @triggered_by, @created_at, @updated_at)",
      ).run(bind);
    } catch (err) {
      mapSqliteError(err);
    }
    return mapRun({
      ...bind,
      envelope_blob_uri: null,
      result: null,
      started_at: null,
      completed_at: null,
      deleted_at: null,
    });
  }

  async get(id: string): Promise<Run | null> {
    const row = this.db
      .prepare("SELECT * FROM run WHERE id = ? AND deleted_at IS NULL")
      .get(id) as SqlRow | undefined;
    return row ? mapRun(row) : null;
  }

  async listForScenario(
    scenarioId: string,
    opts: { limit?: number } = {},
  ): Promise<Run[]> {
    const limit = opts.limit ?? 50;
    return (
      this.db
        .prepare(
          "SELECT * FROM run WHERE scenario_id = ? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT ?",
        )
        .all(scenarioId, limit) as SqlRow[]
    ).map(mapRun);
  }

  async update(
    id: string,
    patch: Partial<
      Pick<Run, "envelopeBlobUri" | "result" | "startedAt" | "completedAt">
    >,
  ): Promise<Run> {
    const existing = await this.get(id);
    if (!existing) throw new StorageNotFoundError("run", id);
    const bind = {
      id: existing.id,
      envelope_blob_uri: patch.envelopeBlobUri ?? existing.envelopeBlobUri,
      result: patch.result ?? existing.result,
      started_at: patch.startedAt ?? existing.startedAt,
      completed_at: patch.completedAt ?? existing.completedAt,
      updated_at: nowIso(),
    };
    try {
      prep(
        this.db,
        "UPDATE run SET envelope_blob_uri = @envelope_blob_uri, result = @result, started_at = @started_at, completed_at = @completed_at, updated_at = @updated_at WHERE id = @id",
      ).run(bind);
    } catch (err) {
      mapSqliteError(err);
    }
    return mapRun({
      ...bind,
      org_id: existing.orgId,
      scenario_id: existing.scenarioId,
      target_id: existing.targetId,
      triggered_by: existing.triggeredBy,
      created_at: existing.createdAt,
      deleted_at: existing.deletedAt,
    });
  }
}
