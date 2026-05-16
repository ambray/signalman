/**
 * Postgres implementation of StorageDriver. Mirrors the SQLite driver
 * one-to-one — same schema, same row mappers, same repository
 * methods.
 *
 * The schema was designed for portability (per the conventions header
 * in 0001_init.sql): TEXT for IDs/timestamps, TEXT (not JSONB) for
 * JSON-encoded columns, INTEGER not BOOLEAN where applicable. We
 * therefore reuse the same migration files as SQLite. The migration
 * runner here applies them inside Postgres transactions instead of
 * SQLite ones.
 *
 * Key differences from sqlite.ts:
 *   * `pg.Pool` for connection pooling (each repo call acquires +
 *     releases a client; transactions take a dedicated client).
 *   * SQL placeholders are `$1, $2, ...` instead of `@name`. The
 *     `pgQuery` helper translates `@name`-style SQL (identical to the
 *     sqlite source) into Postgres positional form so the SQL bodies
 *     stay easy to diff between drivers.
 *   * `claimNext` uses `SELECT ... FOR UPDATE SKIP LOCKED` instead of
 *     `BEGIN IMMEDIATE`.
 *   * Constraint-violation errors come back with SQLSTATE codes; we
 *     map class-23 ("integrity constraint violation") to
 *     `StorageConflictError`.
 *
 * Test path: pg-mem (in-memory Postgres-compatible engine) covers the
 * basic CRUD + constraint surface. Behavioural fidelity gaps (e.g.
 * `SELECT FOR UPDATE SKIP LOCKED` semantics under concurrency) are
 * left to operator-driven validation against real Postgres.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import pgPkg from "pg";
import { newId, nowIso } from "../ids.js";
import type {
  ApiKey,
  Approval,
  ApprovalStatus,
  Artifact,
  ArtifactKind,
  AuditLogEntry,
  CloudOrgBudget,
  CloudOrgCredential,
  CloudOrgUsage,
  Deployment,
  DeploymentHealthSummary,
  DeploymentStatus,
  HealthCheck,
  HealthSchedule,
  HealthStatus,
  Job,
  JobStatus,
  Org,
  OrgTier,
  Product,
  PromotionGateKind,
  PromotionPolicy,
  Release,
  ReleaseStatus,
  Run,
  Runner,
  RunTriggeredBy,
  Scenario,
  ScenarioSource,
  Target,
  TargetConnection,
  TargetKind,
  WebhookKind,
  WebhookSubscription,
} from "../types.js";
import {
  type ApiKeyRepo,
  type ApprovalRepo,
  type ArtifactRepo,
  type AuditLogRepo,
  type CloudBudgetRepo,
  type CloudCredentialsRepo,
  type CloudUsageRepo,
  type DeploymentRepo,
  type HealthCheckRepo,
  type HealthScheduleRepo,
  type JobRepo,
  type OrgRepo,
  type ProductRepo,
  type PromotionPolicyRepo,
  type ReleaseRepo,
  type RunRepo,
  type RunnerRepo,
  type ScenarioRepo,
  type SigningNonce,
  type SigningNonceRepo,
  type SigningProviderKey,
  type SigningProviderKeyRepo,
  StorageConflictError,
  type StorageDriver,
  StorageNotFoundError,
  type TargetRepo,
  type WebhookSubscriptionRepo,
} from "./driver.js";

const { Pool: DefaultPool } = pgPkg;
type Pool = pgPkg.Pool;
type PoolClient = pgPkg.PoolClient;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, "migrations");

type SqlRow = Record<string, unknown>;

// ── Driver ──────────────────────────────────────────────────────────

export interface PostgresDriverOptions {
  /** Provide either an existing Pool (tests, custom setups) ... */
  pool?: Pool;
  /** ... or a connection string for the default Pool. */
  connectionString?: string;
  /** Override migrations directory (tests). */
  migrationsDir?: string;
}

export class PostgresStorageDriver implements StorageDriver {
  readonly pool: Pool;
  private readonly migrationsDir: string;
  private readonly ownsPool: boolean;
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
  readonly jobs: JobRepo;
  readonly cloudBudgets: CloudBudgetRepo;
  readonly cloudUsage: CloudUsageRepo;
  readonly cloudCredentials: CloudCredentialsRepo;
  readonly healthSchedules: HealthScheduleRepo;
  readonly webhookSubscriptions: WebhookSubscriptionRepo;
  readonly promotionPolicies: PromotionPolicyRepo;
  readonly approvals: ApprovalRepo;
  // WS6 M3 — registered runners:
  readonly runners: RunnerRepo;
  // WS9 M2 — signing catalog + replay-dedup ledger:
  readonly signingProviderKeys: SigningProviderKeyRepo;
  readonly signingNonces: SigningNonceRepo;

  constructor(opts: PostgresDriverOptions) {
    if (opts.pool) {
      this.pool = opts.pool;
      this.ownsPool = false;
    } else if (opts.connectionString) {
      this.pool = new DefaultPool({ connectionString: opts.connectionString });
      this.ownsPool = true;
    } else {
      throw new Error(
        "PostgresStorageDriver: provide either `pool` or `connectionString`",
      );
    }
    this.migrationsDir = opts.migrationsDir ?? MIGRATIONS_DIR;

    this.orgs = new PgOrgRepo(this.pool);
    this.apiKeys = new PgApiKeyRepo(this.pool);
    this.products = new PgProductRepo(this.pool);
    this.releases = new PgReleaseRepo(this.pool);
    this.artifacts = new PgArtifactRepo(this.pool);
    this.auditLog = new PgAuditLogRepo(this.pool);
    this.targets = new PgTargetRepo(this.pool);
    this.deployments = new PgDeploymentRepo(this.pool);
    this.healthChecks = new PgHealthCheckRepo(this.pool);
    this.scenarios = new PgScenarioRepo(this.pool);
    this.runs = new PgRunRepo(this.pool);
    this.jobs = new PgJobRepo(this.pool);
    this.cloudBudgets = new PgCloudBudgetRepo(this.pool);
    this.cloudUsage = new PgCloudUsageRepo(this.pool);
    this.cloudCredentials = new PgCloudCredentialsRepo(this.pool);
    this.healthSchedules = new PgHealthScheduleRepo(this.pool);
    this.webhookSubscriptions = new PgWebhookSubscriptionRepo(this.pool);
    this.promotionPolicies = new PgPromotionPolicyRepo(this.pool);
    this.approvals = new PgApprovalRepo(this.pool);
    // WS6 M3:
    this.runners = new PgRunnerRepo(this.pool);
    // WS9 M2:
    this.signingProviderKeys = new PgSigningProviderKeyRepo(this.pool);
    this.signingNonces = new PgSigningNonceRepo(this.pool);
  }

  async migrate(): Promise<void> {
    await runMigrations(this.pool, this.migrationsDir);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.ownsPool) {
      await this.pool.end();
    }
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
  // Dialect-aware (see sqlite.ts for the rationale): `.sqlite.sql`
  // files are SQLite-only and skipped here; `.pg.sql` is the
  // Postgres-only counterpart; plain `.sql` applies to both.
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".sql") && !f.endsWith(".sqlite.sql"))
    .sort()
    .map((f) => {
      const match = /^(\d+)_(.+?)(?:\.pg)?\.sql$/.exec(f);
      if (!match) throw new Error(`bad migration filename: ${f}`);
      return {
        version: parseInt(match[1], 10),
        name: match[2],
        sql: fs.readFileSync(path.join(dir, f), "utf-8"),
      };
    });
}

async function runMigrations(pool: Pool, dir: string): Promise<void> {
  const migrations = loadMigrations(dir);
  const client = await pool.connect();
  try {
    // Check if _migrations exists.
    let applied = new Set<number>();
    try {
      const r = await client.query<{ version: number }>(
        "SELECT version FROM _migrations",
      );
      applied = new Set(r.rows.map((row) => row.version));
    } catch {
      // _migrations doesn't exist yet — first migration creates it.
    }

    for (const m of migrations) {
      if (applied.has(m.version)) continue;
      await client.query("BEGIN");
      try {
        await client.query(m.sql);
        await client.query(
          "INSERT INTO _migrations (version, name, applied_at) VALUES ($1, $2, $3)",
          [m.version, m.name, nowIso()],
        );
        await client.query("COMMIT");
      } catch (err) {
        try {
          await client.query("ROLLBACK");
        } catch {
          // ignore
        }
        throw err;
      }
    }
  } finally {
    client.release();
  }
}

// ── Helpers ─────────────────────────────────────────────────────────

/**
 * Translate `@name`-style SQL (the sqlite source convention) into
 * Postgres positional form and run via the pool. Keeps SQL bodies
 * diff-readable between drivers.
 */
async function pgQuery(
  pool: Pool | PoolClient,
  sql: string,
  params: Record<string, unknown> = {},
): Promise<{ rows: SqlRow[]; rowCount: number | null }> {
  const names: string[] = [];
  const positionalSql = sql.replace(/@(\w+)/g, (_m, name: string) => {
    let idx = names.indexOf(name);
    if (idx < 0) {
      names.push(name);
      idx = names.length - 1;
    }
    return `$${idx + 1}`;
  });
  const values = names.map((n) => params[n]);
  try {
    const r = await pool.query(positionalSql, values);
    return { rows: r.rows as SqlRow[], rowCount: r.rowCount };
  } catch (err) {
    mapPgError(err);
  }
}

async function pgPositional(
  pool: Pool | PoolClient,
  sql: string,
  values: unknown[],
): Promise<{ rows: SqlRow[]; rowCount: number | null }> {
  try {
    const r = await pool.query(sql, values);
    return { rows: r.rows as SqlRow[], rowCount: r.rowCount };
  } catch (err) {
    mapPgError(err);
  }
}

/**
 * Postgres errors carry a SQLSTATE in `.code`. Class 23 covers
 * integrity-constraint violations: 23505 unique, 23503 foreign-key,
 * 23514 check, 23502 not-null. We coalesce all of class 23 into
 * StorageConflictError to match the sqlite driver's behaviour.
 *
 * https://www.postgresql.org/docs/current/errcodes-appendix.html
 */
function mapPgError(err: unknown): never {
  const e = err as { code?: string; message: string };
  if (typeof e.code === "string" && e.code.startsWith("23")) {
    throw new StorageConflictError(e.message);
  }
  throw err;
}

// ── Row mappers (identical to sqlite.ts; JSON columns are TEXT) ─────

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
    signatureB64: (row.signature_b64 as string | null) ?? null,
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

function mapJob(row: SqlRow): Job {
  return {
    id: row.id as string,
    orgId: row.org_id as string,
    kind: row.kind as string,
    input: JSON.parse(row.input as string) as Record<string, unknown>,
    status: row.status as JobStatus,
    result: row.result
      ? (JSON.parse(row.result as string) as Record<string, unknown>)
      : null,
    error: (row.error as string | null) ?? null,
    claimedBy: (row.claimed_by as string | null) ?? null,
    claimedAt: (row.claimed_at as string | null) ?? null,
    startedAt: (row.started_at as string | null) ?? null,
    completedAt: (row.completed_at as string | null) ?? null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    deletedAt: (row.deleted_at as string | null) ?? null,
  };
}

// ── Repo implementations ────────────────────────────────────────────

class PgOrgRepo implements OrgRepo {
  constructor(private readonly pool: Pool) {}

  async create(input: { name: string; tier?: OrgTier }): Promise<Org> {
    const now = nowIso();
    const bind = {
      id: newId(),
      name: input.name,
      tier: input.tier ?? "free",
      created_at: now,
      updated_at: now,
    };
    await pgQuery(
      this.pool,
      "INSERT INTO org (id, name, tier, created_at, updated_at) VALUES (@id, @name, @tier, @created_at, @updated_at)",
      bind,
    );
    return mapOrg({ ...bind, deleted_at: null });
  }

  async get(id: string): Promise<Org | null> {
    const r = await pgPositional(
      this.pool,
      "SELECT * FROM org WHERE id = $1 AND deleted_at IS NULL",
      [id],
    );
    return r.rows[0] ? mapOrg(r.rows[0]) : null;
  }

  async getByName(name: string): Promise<Org | null> {
    const r = await pgPositional(
      this.pool,
      "SELECT * FROM org WHERE name = $1 AND deleted_at IS NULL",
      [name],
    );
    return r.rows[0] ? mapOrg(r.rows[0]) : null;
  }

  async list(): Promise<Org[]> {
    const r = await pgPositional(
      this.pool,
      "SELECT * FROM org WHERE deleted_at IS NULL ORDER BY created_at",
      [],
    );
    return r.rows.map(mapOrg);
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
    await pgQuery(
      this.pool,
      "UPDATE org SET name = @name, tier = @tier, updated_at = @updated_at WHERE id = @id",
      bind,
    );
    return mapOrg({
      ...bind,
      created_at: existing.createdAt,
      deleted_at: existing.deletedAt,
    });
  }

  async softDelete(id: string): Promise<void> {
    const now = nowIso();
    const r = await pgPositional(
      this.pool,
      "UPDATE org SET deleted_at = $1, updated_at = $2 WHERE id = $3 AND deleted_at IS NULL",
      [now, now, id],
    );
    if (!r.rowCount) throw new StorageNotFoundError("org", id);
  }
}

class PgApiKeyRepo implements ApiKeyRepo {
  constructor(private readonly pool: Pool) {}

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
    await pgQuery(
      this.pool,
      "INSERT INTO api_key (id, org_id, prefix, hash, name, expires_at, created_at, updated_at) VALUES (@id, @org_id, @prefix, @hash, @name, @expires_at, @created_at, @updated_at)",
      bind,
    );
    return mapApiKey({ ...bind, deleted_at: null });
  }

  async get(id: string): Promise<ApiKey | null> {
    const r = await pgPositional(
      this.pool,
      "SELECT * FROM api_key WHERE id = $1 AND deleted_at IS NULL",
      [id],
    );
    return r.rows[0] ? mapApiKey(r.rows[0]) : null;
  }

  async getByPrefix(prefix: string): Promise<ApiKey | null> {
    const r = await pgPositional(
      this.pool,
      "SELECT * FROM api_key WHERE prefix = $1 AND deleted_at IS NULL",
      [prefix],
    );
    return r.rows[0] ? mapApiKey(r.rows[0]) : null;
  }

  async listForOrg(orgId: string): Promise<ApiKey[]> {
    const r = await pgPositional(
      this.pool,
      "SELECT * FROM api_key WHERE org_id = $1 AND deleted_at IS NULL ORDER BY created_at",
      [orgId],
    );
    return r.rows.map(mapApiKey);
  }

  async softDelete(id: string): Promise<void> {
    const now = nowIso();
    const r = await pgPositional(
      this.pool,
      "UPDATE api_key SET deleted_at = $1, updated_at = $2 WHERE id = $3 AND deleted_at IS NULL",
      [now, now, id],
    );
    if (!r.rowCount) throw new StorageNotFoundError("api_key", id);
  }
}

class PgProductRepo implements ProductRepo {
  constructor(private readonly pool: Pool) {}

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
    await pgQuery(
      this.pool,
      "INSERT INTO product (id, org_id, name, repo_url, build_yaml_path, created_at, updated_at) VALUES (@id, @org_id, @name, @repo_url, @build_yaml_path, @created_at, @updated_at)",
      bind,
    );
    return mapProduct({ ...bind, deleted_at: null });
  }

  async get(id: string): Promise<Product | null> {
    const r = await pgPositional(
      this.pool,
      "SELECT * FROM product WHERE id = $1 AND deleted_at IS NULL",
      [id],
    );
    return r.rows[0] ? mapProduct(r.rows[0]) : null;
  }

  async getByName(orgId: string, name: string): Promise<Product | null> {
    const r = await pgPositional(
      this.pool,
      "SELECT * FROM product WHERE org_id = $1 AND name = $2 AND deleted_at IS NULL",
      [orgId, name],
    );
    return r.rows[0] ? mapProduct(r.rows[0]) : null;
  }

  async listForOrg(orgId: string): Promise<Product[]> {
    const r = await pgPositional(
      this.pool,
      "SELECT * FROM product WHERE org_id = $1 AND deleted_at IS NULL ORDER BY name",
      [orgId],
    );
    return r.rows.map(mapProduct);
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
    await pgQuery(
      this.pool,
      "UPDATE product SET name = @name, repo_url = @repo_url, build_yaml_path = @build_yaml_path, updated_at = @updated_at WHERE id = @id",
      bind,
    );
    return mapProduct({
      ...bind,
      org_id: existing.orgId,
      created_at: existing.createdAt,
      deleted_at: existing.deletedAt,
    });
  }

  async softDelete(id: string): Promise<void> {
    const now = nowIso();
    const r = await pgPositional(
      this.pool,
      "UPDATE product SET deleted_at = $1, updated_at = $2 WHERE id = $3 AND deleted_at IS NULL",
      [now, now, id],
    );
    if (!r.rowCount) throw new StorageNotFoundError("product", id);
  }
}

class PgReleaseRepo implements ReleaseRepo {
  constructor(private readonly pool: Pool) {}

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
    await pgQuery(
      this.pool,
      "INSERT INTO release (id, org_id, product_id, tag, commit_sha, status, created_at, updated_at) VALUES (@id, @org_id, @product_id, @tag, @commit_sha, @status, @created_at, @updated_at)",
      bind,
    );
    return mapRelease({
      ...bind,
      manifest_sha256: null,
      signed_by: null,
      signature_b64: null,
      built_at: null,
      built_by_runner_id: null,
      build_yaml_json: null,
      deleted_at: null,
    });
  }

  async get(id: string): Promise<Release | null> {
    const r = await pgPositional(
      this.pool,
      "SELECT * FROM release WHERE id = $1 AND deleted_at IS NULL",
      [id],
    );
    return r.rows[0] ? mapRelease(r.rows[0]) : null;
  }

  async getByTag(productId: string, tag: string): Promise<Release | null> {
    const r = await pgPositional(
      this.pool,
      "SELECT * FROM release WHERE product_id = $1 AND tag = $2 AND deleted_at IS NULL",
      [productId, tag],
    );
    return r.rows[0] ? mapRelease(r.rows[0]) : null;
  }

  async listForProduct(
    productId: string,
    opts: { status?: ReleaseStatus } = {},
  ): Promise<Release[]> {
    if (opts.status) {
      const r = await pgPositional(
        this.pool,
        "SELECT * FROM release WHERE product_id = $1 AND status = $2 AND deleted_at IS NULL ORDER BY created_at DESC",
        [productId, opts.status],
      );
      return r.rows.map(mapRelease);
    }
    const r = await pgPositional(
      this.pool,
      "SELECT * FROM release WHERE product_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC",
      [productId],
    );
    return r.rows.map(mapRelease);
  }

  async update(
    id: string,
    patch: Partial<
      Pick<
        Release,
        | "manifestSha256"
        | "signedBy"
        | "signatureB64"
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
      signature_b64: patch.signatureB64 ?? existing.signatureB64,
      built_at: patch.builtAt ?? existing.builtAt,
      built_by_runner_id: patch.builtByRunnerId ?? existing.builtByRunnerId,
      status: patch.status ?? existing.status,
      build_yaml_json: patch.buildYamlJson ?? existing.buildYamlJson,
      updated_at: nowIso(),
    };
    await pgQuery(
      this.pool,
      "UPDATE release SET manifest_sha256 = @manifest_sha256, signed_by = @signed_by, signature_b64 = @signature_b64, built_at = @built_at, built_by_runner_id = @built_by_runner_id, status = @status, build_yaml_json = @build_yaml_json, updated_at = @updated_at WHERE id = @id",
      bind,
    );
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
    const r = await pgPositional(
      this.pool,
      "UPDATE release SET deleted_at = $1, updated_at = $2 WHERE id = $3 AND deleted_at IS NULL",
      [now, now, id],
    );
    if (!r.rowCount) throw new StorageNotFoundError("release", id);
  }
}

class PgArtifactRepo implements ArtifactRepo {
  constructor(private readonly pool: Pool) {}

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
    await pgQuery(
      this.pool,
      "INSERT INTO artifact (id, release_id, component, kind, sha256, size_bytes, blob_uri, image_ref, created_at, updated_at) VALUES (@id, @release_id, @component, @kind, @sha256, @size_bytes, @blob_uri, @image_ref, @created_at, @updated_at)",
      bind,
    );
    return mapArtifact({ ...bind, deleted_at: null });
  }

  async get(id: string): Promise<Artifact | null> {
    const r = await pgPositional(
      this.pool,
      "SELECT * FROM artifact WHERE id = $1 AND deleted_at IS NULL",
      [id],
    );
    return r.rows[0] ? mapArtifact(r.rows[0]) : null;
  }

  async listForRelease(releaseId: string): Promise<Artifact[]> {
    const r = await pgPositional(
      this.pool,
      "SELECT * FROM artifact WHERE release_id = $1 AND deleted_at IS NULL ORDER BY component",
      [releaseId],
    );
    return r.rows.map(mapArtifact);
  }

  async softDelete(id: string): Promise<void> {
    const now = nowIso();
    const r = await pgPositional(
      this.pool,
      "UPDATE artifact SET deleted_at = $1, updated_at = $2 WHERE id = $3 AND deleted_at IS NULL",
      [now, now, id],
    );
    if (!r.rowCount) throw new StorageNotFoundError("artifact", id);
  }
}

class PgAuditLogRepo implements AuditLogRepo {
  constructor(private readonly pool: Pool) {}

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
    await pgQuery(
      this.pool,
      "INSERT INTO audit_log (id, org_id, actor, action, entity_type, entity_id, detail, at, created_at) VALUES (@id, @org_id, @actor, @action, @entity_type, @entity_id, @detail, @at, @created_at)",
      bind,
    );
    return mapAuditLog(bind);
  }

  async listForOrg(
    orgId: string,
    opts: { limit?: number; entityType?: string; entityId?: string } = {},
  ): Promise<AuditLogEntry[]> {
    const limit = opts.limit ?? 100;
    if (opts.entityType && opts.entityId) {
      const r = await pgPositional(
        this.pool,
        "SELECT * FROM audit_log WHERE org_id = $1 AND entity_type = $2 AND entity_id = $3 ORDER BY at DESC LIMIT $4",
        [orgId, opts.entityType, opts.entityId, limit],
      );
      return r.rows.map(mapAuditLog);
    }
    if (opts.entityType) {
      const r = await pgPositional(
        this.pool,
        "SELECT * FROM audit_log WHERE org_id = $1 AND entity_type = $2 ORDER BY at DESC LIMIT $3",
        [orgId, opts.entityType, limit],
      );
      return r.rows.map(mapAuditLog);
    }
    const r = await pgPositional(
      this.pool,
      "SELECT * FROM audit_log WHERE org_id = $1 ORDER BY at DESC LIMIT $2",
      [orgId, limit],
    );
    return r.rows.map(mapAuditLog);
  }
}

class PgTargetRepo implements TargetRepo {
  constructor(private readonly pool: Pool) {}

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
    await pgQuery(
      this.pool,
      "INSERT INTO target (id, org_id, name, kind, connection, created_at, updated_at) VALUES (@id, @org_id, @name, @kind, @connection, @created_at, @updated_at)",
      bind,
    );
    return mapTarget({ ...bind, deleted_at: null });
  }

  async get(id: string): Promise<Target | null> {
    const r = await pgPositional(
      this.pool,
      "SELECT * FROM target WHERE id = $1 AND deleted_at IS NULL",
      [id],
    );
    return r.rows[0] ? mapTarget(r.rows[0]) : null;
  }

  async getByName(orgId: string, name: string): Promise<Target | null> {
    const r = await pgPositional(
      this.pool,
      "SELECT * FROM target WHERE org_id = $1 AND name = $2 AND deleted_at IS NULL",
      [orgId, name],
    );
    return r.rows[0] ? mapTarget(r.rows[0]) : null;
  }

  async listForOrg(orgId: string): Promise<Target[]> {
    const r = await pgPositional(
      this.pool,
      "SELECT * FROM target WHERE org_id = $1 AND deleted_at IS NULL ORDER BY name",
      [orgId],
    );
    return r.rows.map(mapTarget);
  }

  // WS6 M3 — operator-authorised P3 closure (edit name/connection;
  // kind + id stay immutable). Past Deployment rows not cascaded.
  async update(
    id: string,
    patch: Partial<Pick<Target, "name" | "connection">>,
  ): Promise<Target> {
    const existing = await this.get(id);
    if (!existing) throw new StorageNotFoundError("target", id);
    const bind = {
      id: existing.id,
      name: patch.name ?? existing.name,
      connection: JSON.stringify(patch.connection ?? existing.connection),
      updated_at: nowIso(),
    };
    await pgQuery(
      this.pool,
      "UPDATE target SET name = @name, connection = @connection, updated_at = @updated_at WHERE id = @id",
      bind,
    );
    return mapTarget({
      ...bind,
      org_id: existing.orgId,
      kind: existing.kind,
      created_at: existing.createdAt,
      deleted_at: existing.deletedAt,
    });
  }

  async softDelete(id: string): Promise<void> {
    const now = nowIso();
    const r = await pgPositional(
      this.pool,
      "UPDATE target SET deleted_at = $1, updated_at = $2 WHERE id = $3 AND deleted_at IS NULL",
      [now, now, id],
    );
    if (!r.rowCount) throw new StorageNotFoundError("target", id);
  }
}

class PgDeploymentRepo implements DeploymentRepo {
  constructor(private readonly pool: Pool) {}

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
    await pgQuery(
      this.pool,
      "INSERT INTO deployment (id, org_id, release_id, target_id, status, previous_deployment_id, created_at, updated_at) VALUES (@id, @org_id, @release_id, @target_id, @status, @previous_deployment_id, @created_at, @updated_at)",
      bind,
    );
    return mapDeployment({
      ...bind,
      started_at: null,
      completed_at: null,
      health_summary: null,
      deleted_at: null,
    });
  }

  async get(id: string): Promise<Deployment | null> {
    const r = await pgPositional(
      this.pool,
      "SELECT * FROM deployment WHERE id = $1 AND deleted_at IS NULL",
      [id],
    );
    return r.rows[0] ? mapDeployment(r.rows[0]) : null;
  }

  async getActiveForTarget(targetId: string): Promise<Deployment | null> {
    const r = await pgPositional(
      this.pool,
      "SELECT * FROM deployment WHERE target_id = $1 AND status = 'active' AND deleted_at IS NULL",
      [targetId],
    );
    return r.rows[0] ? mapDeployment(r.rows[0]) : null;
  }

  async listForTarget(
    targetId: string,
    opts: { limit?: number } = {},
  ): Promise<Deployment[]> {
    const limit = opts.limit ?? 100;
    const r = await pgPositional(
      this.pool,
      "SELECT * FROM deployment WHERE target_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC LIMIT $2",
      [targetId, limit],
    );
    return r.rows.map(mapDeployment);
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
    await pgQuery(
      this.pool,
      "UPDATE deployment SET status = @status, started_at = @started_at, completed_at = @completed_at, health_summary = @health_summary, updated_at = @updated_at WHERE id = @id",
      bind,
    );
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

class PgHealthCheckRepo implements HealthCheckRepo {
  constructor(private readonly pool: Pool) {}

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
    await pgQuery(
      this.pool,
      "INSERT INTO health_check (id, deployment_id, probe_name, status, latency_ms, detail, checked_at, created_at, updated_at) VALUES (@id, @deployment_id, @probe_name, @status, @latency_ms, @detail, @checked_at, @created_at, @updated_at)",
      bind,
    );
    return mapHealthCheck({ ...bind, deleted_at: null });
  }

  async listForDeployment(
    deploymentId: string,
    opts: { since?: string; limit?: number } = {},
  ): Promise<HealthCheck[]> {
    const limit = opts.limit ?? 100;
    if (opts.since) {
      const r = await pgPositional(
        this.pool,
        "SELECT * FROM health_check WHERE deployment_id = $1 AND checked_at >= $2 AND deleted_at IS NULL ORDER BY checked_at DESC LIMIT $3",
        [deploymentId, opts.since, limit],
      );
      return r.rows.map(mapHealthCheck);
    }
    const r = await pgPositional(
      this.pool,
      "SELECT * FROM health_check WHERE deployment_id = $1 AND deleted_at IS NULL ORDER BY checked_at DESC LIMIT $2",
      [deploymentId, limit],
    );
    return r.rows.map(mapHealthCheck);
  }
}

class PgScenarioRepo implements ScenarioRepo {
  constructor(private readonly pool: Pool) {}

  async upsertFromDisk(input: {
    orgId: string;
    path: string;
    scenarioHash: string;
    name: string;
    tags: string[];
  }): Promise<Scenario> {
    const existing = await this.getByPath(input.orgId, input.path);
    if (existing) {
      const bind = {
        id: existing.id,
        scenario_hash: input.scenarioHash,
        name: input.name,
        tags: JSON.stringify(input.tags),
        updated_at: nowIso(),
      };
      await pgQuery(
        this.pool,
        "UPDATE scenario SET scenario_hash = @scenario_hash, name = @name, tags = @tags, updated_at = @updated_at WHERE id = @id",
        bind,
      );
      return mapScenario({
        ...bind,
        org_id: existing.orgId,
        path: existing.path,
        source: existing.source,
        created_at: existing.createdAt,
        deleted_at: existing.deletedAt,
      });
    }
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
    await pgQuery(
      this.pool,
      "INSERT INTO scenario (id, org_id, path, scenario_hash, name, tags, source, created_at, updated_at) VALUES (@id, @org_id, @path, @scenario_hash, @name, @tags, @source, @created_at, @updated_at)",
      bind,
    );
    return mapScenario({ ...bind, deleted_at: null });
  }

  async get(id: string): Promise<Scenario | null> {
    const r = await pgPositional(
      this.pool,
      "SELECT * FROM scenario WHERE id = $1 AND deleted_at IS NULL",
      [id],
    );
    return r.rows[0] ? mapScenario(r.rows[0]) : null;
  }

  async getByPath(orgId: string, p: string): Promise<Scenario | null> {
    const r = await pgPositional(
      this.pool,
      "SELECT * FROM scenario WHERE org_id = $1 AND path = $2 AND deleted_at IS NULL",
      [orgId, p],
    );
    return r.rows[0] ? mapScenario(r.rows[0]) : null;
  }

  async listForOrg(orgId: string): Promise<Scenario[]> {
    const r = await pgPositional(
      this.pool,
      "SELECT * FROM scenario WHERE org_id = $1 AND deleted_at IS NULL ORDER BY path",
      [orgId],
    );
    return r.rows.map(mapScenario);
  }

  async softDelete(id: string): Promise<void> {
    const now = nowIso();
    const r = await pgPositional(
      this.pool,
      "UPDATE scenario SET deleted_at = $1, updated_at = $2 WHERE id = $3 AND deleted_at IS NULL",
      [now, now, id],
    );
    if (!r.rowCount) throw new StorageNotFoundError("scenario", id);
  }
}

class PgRunRepo implements RunRepo {
  constructor(private readonly pool: Pool) {}

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
    await pgQuery(
      this.pool,
      "INSERT INTO run (id, org_id, scenario_id, target_id, triggered_by, created_at, updated_at) VALUES (@id, @org_id, @scenario_id, @target_id, @triggered_by, @created_at, @updated_at)",
      bind,
    );
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
    const r = await pgPositional(
      this.pool,
      "SELECT * FROM run WHERE id = $1 AND deleted_at IS NULL",
      [id],
    );
    return r.rows[0] ? mapRun(r.rows[0]) : null;
  }

  async listForScenario(
    scenarioId: string,
    opts: { limit?: number } = {},
  ): Promise<Run[]> {
    const limit = opts.limit ?? 50;
    const r = await pgPositional(
      this.pool,
      "SELECT * FROM run WHERE scenario_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC LIMIT $2",
      [scenarioId, limit],
    );
    return r.rows.map(mapRun);
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
    await pgQuery(
      this.pool,
      "UPDATE run SET envelope_blob_uri = @envelope_blob_uri, result = @result, started_at = @started_at, completed_at = @completed_at, updated_at = @updated_at WHERE id = @id",
      bind,
    );
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

class PgJobRepo implements JobRepo {
  constructor(private readonly pool: Pool) {}

  async create(input: {
    orgId: string;
    kind: string;
    input?: Record<string, unknown>;
  }): Promise<Job> {
    const now = nowIso();
    const bind = {
      id: newId(),
      org_id: input.orgId,
      kind: input.kind,
      input: JSON.stringify(input.input ?? {}),
      status: "pending" as JobStatus,
      created_at: now,
      updated_at: now,
    };
    await pgQuery(
      this.pool,
      "INSERT INTO job (id, org_id, kind, input, status, created_at, updated_at) VALUES (@id, @org_id, @kind, @input, @status, @created_at, @updated_at)",
      bind,
    );
    return mapJob({
      ...bind,
      result: null,
      error: null,
      claimed_by: null,
      claimed_at: null,
      started_at: null,
      completed_at: null,
      deleted_at: null,
    });
  }

  async get(id: string): Promise<Job | null> {
    const r = await pgPositional(
      this.pool,
      "SELECT * FROM job WHERE id = $1 AND deleted_at IS NULL",
      [id],
    );
    return r.rows[0] ? mapJob(r.rows[0]) : null;
  }

  async listForOrg(
    orgId: string,
    opts: { limit?: number; status?: JobStatus } = {},
  ): Promise<Job[]> {
    const limit = opts.limit ?? 50;
    if (opts.status) {
      const r = await pgPositional(
        this.pool,
        "SELECT * FROM job WHERE org_id = $1 AND status = $2 AND deleted_at IS NULL ORDER BY created_at DESC LIMIT $3",
        [orgId, opts.status, limit],
      );
      return r.rows.map(mapJob);
    }
    const r = await pgPositional(
      this.pool,
      "SELECT * FROM job WHERE org_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC LIMIT $2",
      [orgId, limit],
    );
    return r.rows.map(mapJob);
  }

  async claimNext(input: {
    orgId: string;
    claimedBy: string;
  }): Promise<Job | null> {
    // Postgres analog of sqlite's BEGIN IMMEDIATE + UPDATE-WHERE:
    // SELECT ... FOR UPDATE SKIP LOCKED picks an unlocked pending row
    // and locks it for the rest of the transaction; the UPDATE
    // transitions it to claimed; concurrent claimers either see
    // a different row or block on the locked one (and SKIP LOCKED
    // skips it entirely).
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const pending = await pgPositional(
        client,
        "SELECT * FROM job WHERE org_id = $1 AND status = 'pending' AND deleted_at IS NULL ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED",
        [input.orgId],
      );
      if (pending.rows.length === 0) {
        await client.query("COMMIT");
        return null;
      }
      const row = pending.rows[0];
      const now = nowIso();
      await pgPositional(
        client,
        "UPDATE job SET status = 'claimed', claimed_by = $1, claimed_at = $2, updated_at = $3 WHERE id = $4",
        [input.claimedBy, now, now, row.id as string],
      );
      await client.query("COMMIT");
      return mapJob({
        ...row,
        status: "claimed",
        claimed_by: input.claimedBy,
        claimed_at: now,
        updated_at: now,
      });
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // ignore
      }
      throw err;
    } finally {
      client.release();
    }
  }

  async update(
    id: string,
    patch: Partial<
      Pick<Job, "status" | "result" | "error" | "startedAt" | "completedAt">
    >,
  ): Promise<Job> {
    const existing = await this.get(id);
    if (!existing) throw new StorageNotFoundError("job", id);
    const bind = {
      id: existing.id,
      status: patch.status ?? existing.status,
      result:
        patch.result !== undefined
          ? patch.result === null
            ? null
            : JSON.stringify(patch.result)
          : existing.result
            ? JSON.stringify(existing.result)
            : null,
      error: patch.error !== undefined ? patch.error : existing.error,
      started_at:
        patch.startedAt !== undefined ? patch.startedAt : existing.startedAt,
      completed_at:
        patch.completedAt !== undefined ? patch.completedAt : existing.completedAt,
      updated_at: nowIso(),
    };
    await pgQuery(
      this.pool,
      "UPDATE job SET status = @status, result = @result, error = @error, started_at = @started_at, completed_at = @completed_at, updated_at = @updated_at WHERE id = @id",
      bind,
    );
    return mapJob({
      ...bind,
      org_id: existing.orgId,
      kind: existing.kind,
      input: JSON.stringify(existing.input),
      claimed_by: existing.claimedBy,
      claimed_at: existing.claimedAt,
      created_at: existing.createdAt,
      deleted_at: existing.deletedAt,
    });
  }
}

// ── Cloud cost guardrails (v0.3.0-5 sub-task 5) ────────────────────

function mapPgCloudBudget(row: SqlRow): CloudOrgBudget {
  return {
    orgId: row.org_id as string,
    monthlyCentsLimit: Number(row.monthly_cents_limit),
    softWarnPct: Number(row.soft_warn_pct),
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

function mapPgCloudUsage(row: SqlRow): CloudOrgUsage {
  return {
    id: row.id as string,
    orgId: row.org_id as string,
    backend: row.backend as string,
    instanceId: row.instance_id as string,
    instanceType: row.instance_type as string,
    region: row.region as string,
    startedAt: row.started_at as string,
    terminatedAt: (row.terminated_at as string | null) ?? null,
    estimatedCents: Number(row.estimated_cents),
  };
}

class PgCloudBudgetRepo implements CloudBudgetRepo {
  constructor(private readonly pool: Pool) {}

  async get(orgId: string): Promise<CloudOrgBudget | null> {
    const out = await this.pool.query(
      "SELECT * FROM cloud_org_budget WHERE org_id = $1",
      [orgId],
    );
    return out.rows[0] ? mapPgCloudBudget(out.rows[0] as SqlRow) : null;
  }

  async upsert(input: {
    orgId: string;
    monthlyCentsLimit: number;
    softWarnPct?: number;
  }): Promise<CloudOrgBudget> {
    const now = nowIso();
    const softWarnPct = input.softWarnPct ?? 80;
    try {
      const out = await this.pool.query(
        `INSERT INTO cloud_org_budget (org_id, monthly_cents_limit, soft_warn_pct, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $4)
         ON CONFLICT (org_id) DO UPDATE SET
           monthly_cents_limit = EXCLUDED.monthly_cents_limit,
           soft_warn_pct = EXCLUDED.soft_warn_pct,
           updated_at = EXCLUDED.updated_at
         RETURNING *`,
        [input.orgId, input.monthlyCentsLimit, softWarnPct, now],
      );
      return mapPgCloudBudget(out.rows[0] as SqlRow);
    } catch (err) {
      mapPgError(err);
    }
  }

  async remove(orgId: string): Promise<void> {
    await this.pool.query("DELETE FROM cloud_org_budget WHERE org_id = $1", [
      orgId,
    ]);
  }
}

class PgCloudUsageRepo implements CloudUsageRepo {
  constructor(private readonly pool: Pool) {}

  async recordStart(input: {
    orgId: string;
    backend: string;
    instanceId: string;
    instanceType: string;
    region: string;
    startedAt: string;
    estimatedCents: number;
  }): Promise<CloudOrgUsage> {
    try {
      const out = await this.pool.query(
        `INSERT INTO cloud_org_usage (id, org_id, backend, instance_id, instance_type, region, started_at, terminated_at, estimated_cents)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, $8)
         RETURNING *`,
        [
          newId(),
          input.orgId,
          input.backend,
          input.instanceId,
          input.instanceType,
          input.region,
          input.startedAt,
          input.estimatedCents,
        ],
      );
      return mapPgCloudUsage(out.rows[0] as SqlRow);
    } catch (err) {
      mapPgError(err);
    }
  }

  async recordTerminate(input: {
    orgId: string;
    instanceId: string;
    terminatedAt: string;
  }): Promise<void> {
    await this.pool.query(
      "UPDATE cloud_org_usage SET terminated_at = $1 WHERE org_id = $2 AND instance_id = $3 AND terminated_at IS NULL",
      [input.terminatedAt, input.orgId, input.instanceId],
    );
  }

  async sumForRange(input: {
    orgId: string;
    startedAtFrom: string;
    startedAtTo: string;
  }): Promise<number> {
    const out = await this.pool.query(
      "SELECT COALESCE(SUM(estimated_cents), 0)::bigint AS total FROM cloud_org_usage WHERE org_id = $1 AND started_at >= $2 AND started_at < $3",
      [input.orgId, input.startedAtFrom, input.startedAtTo],
    );
    return Number(
      (out.rows[0] as { total: string | number } | undefined)?.total ?? 0,
    );
  }

  async listForOrg(
    orgId: string,
    opts?: { startedAtFrom?: string; startedAtTo?: string },
  ): Promise<CloudOrgUsage[]> {
    const clauses: string[] = ["org_id = $1"];
    const binds: unknown[] = [orgId];
    if (opts?.startedAtFrom) {
      binds.push(opts.startedAtFrom);
      clauses.push(`started_at >= $${binds.length}`);
    }
    if (opts?.startedAtTo) {
      binds.push(opts.startedAtTo);
      clauses.push(`started_at < $${binds.length}`);
    }
    const out = await this.pool.query(
      `SELECT * FROM cloud_org_usage WHERE ${clauses.join(" AND ")} ORDER BY started_at`,
      binds,
    );
    return (out.rows as SqlRow[]).map(mapPgCloudUsage);
  }
}

function mapPgCloudCredential(row: SqlRow): CloudOrgCredential {
  return {
    id: row.id as string,
    orgId: row.org_id as string,
    backend: row.backend as string,
    ciphertextB64: row.ciphertext_b64 as string,
    encryptionMethod: row.encryption_method as string,
    redactedHint: row.redacted_hint as string,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

class PgCloudCredentialsRepo implements CloudCredentialsRepo {
  constructor(private readonly pool: Pool) {}

  async get(orgId: string, backend: string): Promise<CloudOrgCredential | null> {
    const out = await this.pool.query(
      "SELECT * FROM cloud_org_credential WHERE org_id = $1 AND backend = $2",
      [orgId, backend],
    );
    return out.rows[0] ? mapPgCloudCredential(out.rows[0] as SqlRow) : null;
  }

  async upsert(input: {
    orgId: string;
    backend: string;
    ciphertextB64: string;
    encryptionMethod: string;
    redactedHint: string;
  }): Promise<CloudOrgCredential> {
    const now = nowIso();
    try {
      const out = await this.pool.query(
        `INSERT INTO cloud_org_credential
          (id, org_id, backend, ciphertext_b64, encryption_method, redacted_hint, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
         ON CONFLICT (org_id, backend) DO UPDATE SET
           ciphertext_b64 = EXCLUDED.ciphertext_b64,
           encryption_method = EXCLUDED.encryption_method,
           redacted_hint = EXCLUDED.redacted_hint,
           updated_at = EXCLUDED.updated_at
         RETURNING *`,
        [
          newId(),
          input.orgId,
          input.backend,
          input.ciphertextB64,
          input.encryptionMethod,
          input.redactedHint,
          now,
        ],
      );
      return mapPgCloudCredential(out.rows[0] as SqlRow);
    } catch (err) {
      mapPgError(err);
    }
  }

  async remove(orgId: string, backend: string): Promise<void> {
    await this.pool.query(
      "DELETE FROM cloud_org_credential WHERE org_id = $1 AND backend = $2",
      [orgId, backend],
    );
  }

  async listForOrg(orgId: string): Promise<CloudOrgCredential[]> {
    const out = await this.pool.query(
      "SELECT * FROM cloud_org_credential WHERE org_id = $1 ORDER BY backend",
      [orgId],
    );
    return (out.rows as SqlRow[]).map(mapPgCloudCredential);
  }
}

// ── Health schedule repo (v0.4.0-3) ─────────────────────────────────

function mapHealthSchedule(row: SqlRow): HealthSchedule {
  return {
    id: row.id as string,
    orgId: row.org_id as string,
    targetId: row.target_id as string,
    intervalSeconds: Number(row.interval_seconds),
    probeNames: JSON.parse(row.probe_ids_json as string) as string[],
    lastRunAt: (row.last_run_at as string | null) ?? null,
    active: Number(row.active) === 1,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    deletedAt: (row.deleted_at as string | null) ?? null,
  };
}

class PgHealthScheduleRepo implements HealthScheduleRepo {
  constructor(private readonly pool: Pool) {}

  async create(input: {
    orgId: string;
    targetId: string;
    intervalSeconds: number;
    probeNames: string[];
    active?: boolean;
  }): Promise<HealthSchedule> {
    const now = nowIso();
    const bind = {
      id: newId(),
      org_id: input.orgId,
      target_id: input.targetId,
      interval_seconds: input.intervalSeconds,
      probe_ids_json: JSON.stringify(input.probeNames),
      active: input.active === false ? 0 : 1,
      created_at: now,
      updated_at: now,
    };
    await pgQuery(
      this.pool,
      "INSERT INTO health_schedule (id, org_id, target_id, interval_seconds, probe_ids_json, active, created_at, updated_at) VALUES (@id, @org_id, @target_id, @interval_seconds, @probe_ids_json, @active, @created_at, @updated_at)",
      bind,
    );
    return mapHealthSchedule({ ...bind, last_run_at: null, deleted_at: null });
  }

  async get(id: string): Promise<HealthSchedule | null> {
    const r = await pgPositional(
      this.pool,
      "SELECT * FROM health_schedule WHERE id = $1 AND deleted_at IS NULL",
      [id],
    );
    return r.rows[0] ? mapHealthSchedule(r.rows[0]) : null;
  }

  async listForOrg(orgId: string): Promise<HealthSchedule[]> {
    const r = await pgPositional(
      this.pool,
      "SELECT * FROM health_schedule WHERE org_id = $1 AND deleted_at IS NULL ORDER BY created_at",
      [orgId],
    );
    return r.rows.map(mapHealthSchedule);
  }

  async listForTarget(targetId: string): Promise<HealthSchedule[]> {
    const r = await pgPositional(
      this.pool,
      "SELECT * FROM health_schedule WHERE target_id = $1 AND deleted_at IS NULL ORDER BY created_at",
      [targetId],
    );
    return r.rows.map(mapHealthSchedule);
  }

  async listActive(orgId?: string): Promise<HealthSchedule[]> {
    if (orgId) {
      const r = await pgPositional(
        this.pool,
        "SELECT * FROM health_schedule WHERE org_id = $1 AND active = 1 AND deleted_at IS NULL ORDER BY created_at",
        [orgId],
      );
      return r.rows.map(mapHealthSchedule);
    }
    const r = await pgPositional(
      this.pool,
      "SELECT * FROM health_schedule WHERE active = 1 AND deleted_at IS NULL ORDER BY created_at",
      [],
    );
    return r.rows.map(mapHealthSchedule);
  }

  async update(
    id: string,
    patch: Partial<
      Pick<HealthSchedule, "intervalSeconds" | "probeNames" | "active" | "lastRunAt">
    >,
  ): Promise<HealthSchedule> {
    const existing = await this.get(id);
    if (!existing) throw new StorageNotFoundError("health_schedule", id);
    const bind = {
      id: existing.id,
      interval_seconds: patch.intervalSeconds ?? existing.intervalSeconds,
      probe_ids_json: JSON.stringify(patch.probeNames ?? existing.probeNames),
      last_run_at:
        patch.lastRunAt !== undefined ? patch.lastRunAt : existing.lastRunAt,
      active:
        patch.active !== undefined
          ? patch.active
            ? 1
            : 0
          : existing.active
            ? 1
            : 0,
      updated_at: nowIso(),
    };
    await pgQuery(
      this.pool,
      "UPDATE health_schedule SET interval_seconds = @interval_seconds, probe_ids_json = @probe_ids_json, last_run_at = @last_run_at, active = @active, updated_at = @updated_at WHERE id = @id",
      bind,
    );
    return mapHealthSchedule({
      ...bind,
      org_id: existing.orgId,
      target_id: existing.targetId,
      created_at: existing.createdAt,
      deleted_at: existing.deletedAt,
    });
  }

  async softDelete(id: string): Promise<void> {
    const now = nowIso();
    const r = await pgPositional(
      this.pool,
      "UPDATE health_schedule SET deleted_at = $1, updated_at = $2 WHERE id = $3 AND deleted_at IS NULL",
      [now, now, id],
    );
    if (r.rowCount === 0) throw new StorageNotFoundError("health_schedule", id);
  }
}

// ── Webhook subscription repo (v0.4.0-2) ────────────────────────────

function mapWebhookSubscription(row: SqlRow): WebhookSubscription {
  return {
    id: row.id as string,
    orgId: row.org_id as string,
    kind: row.kind as WebhookKind,
    url: row.url as string,
    secretHmacKey: (row.secret_hmac_key as string | null) ?? null,
    eventKinds: JSON.parse(row.event_kinds_json as string) as string[],
    active: Number(row.active) === 1,
    description: (row.description as string | null) ?? null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    deletedAt: (row.deleted_at as string | null) ?? null,
  };
}

class PgWebhookSubscriptionRepo implements WebhookSubscriptionRepo {
  constructor(private readonly pool: Pool) {}

  async create(input: {
    orgId: string;
    kind: WebhookKind;
    url: string;
    secretHmacKey?: string | null;
    eventKinds?: string[];
    active?: boolean;
    description?: string | null;
  }): Promise<WebhookSubscription> {
    const now = nowIso();
    const bind = {
      id: newId(),
      org_id: input.orgId,
      kind: input.kind,
      url: input.url,
      secret_hmac_key: input.secretHmacKey ?? null,
      event_kinds_json: JSON.stringify(input.eventKinds ?? []),
      active: input.active === false ? 0 : 1,
      description: input.description ?? null,
      created_at: now,
      updated_at: now,
    };
    await pgQuery(
      this.pool,
      "INSERT INTO webhook_subscription (id, org_id, kind, url, secret_hmac_key, event_kinds_json, active, description, created_at, updated_at) VALUES (@id, @org_id, @kind, @url, @secret_hmac_key, @event_kinds_json, @active, @description, @created_at, @updated_at)",
      bind,
    );
    return mapWebhookSubscription({ ...bind, deleted_at: null });
  }

  async get(id: string): Promise<WebhookSubscription | null> {
    const r = await pgPositional(
      this.pool,
      "SELECT * FROM webhook_subscription WHERE id = $1 AND deleted_at IS NULL",
      [id],
    );
    return r.rows[0] ? mapWebhookSubscription(r.rows[0]) : null;
  }

  async listForOrg(orgId: string): Promise<WebhookSubscription[]> {
    const r = await pgPositional(
      this.pool,
      "SELECT * FROM webhook_subscription WHERE org_id = $1 AND deleted_at IS NULL ORDER BY created_at",
      [orgId],
    );
    return r.rows.map(mapWebhookSubscription);
  }

  async listActive(orgId?: string): Promise<WebhookSubscription[]> {
    if (orgId) {
      const r = await pgPositional(
        this.pool,
        "SELECT * FROM webhook_subscription WHERE org_id = $1 AND active = 1 AND deleted_at IS NULL ORDER BY created_at",
        [orgId],
      );
      return r.rows.map(mapWebhookSubscription);
    }
    const r = await pgPositional(
      this.pool,
      "SELECT * FROM webhook_subscription WHERE active = 1 AND deleted_at IS NULL ORDER BY created_at",
      [],
    );
    return r.rows.map(mapWebhookSubscription);
  }

  async update(
    id: string,
    patch: Partial<
      Pick<
        WebhookSubscription,
        "url" | "secretHmacKey" | "eventKinds" | "active" | "description"
      >
    >,
  ): Promise<WebhookSubscription> {
    const existing = await this.get(id);
    if (!existing) throw new StorageNotFoundError("webhook_subscription", id);
    const bind = {
      id: existing.id,
      url: patch.url ?? existing.url,
      secret_hmac_key:
        patch.secretHmacKey !== undefined
          ? patch.secretHmacKey
          : existing.secretHmacKey,
      event_kinds_json: JSON.stringify(patch.eventKinds ?? existing.eventKinds),
      active:
        patch.active !== undefined
          ? patch.active
            ? 1
            : 0
          : existing.active
            ? 1
            : 0,
      description:
        patch.description !== undefined ? patch.description : existing.description,
      updated_at: nowIso(),
    };
    await pgQuery(
      this.pool,
      "UPDATE webhook_subscription SET url = @url, secret_hmac_key = @secret_hmac_key, event_kinds_json = @event_kinds_json, active = @active, description = @description, updated_at = @updated_at WHERE id = @id",
      bind,
    );
    return mapWebhookSubscription({
      ...bind,
      org_id: existing.orgId,
      kind: existing.kind,
      created_at: existing.createdAt,
      deleted_at: existing.deletedAt,
    });
  }

  async softDelete(id: string): Promise<void> {
    const now = nowIso();
    const r = await pgPositional(
      this.pool,
      "UPDATE webhook_subscription SET deleted_at = $1, updated_at = $2 WHERE id = $3 AND deleted_at IS NULL",
      [now, now, id],
    );
    if (r.rowCount === 0)
      throw new StorageNotFoundError("webhook_subscription", id);
  }
}

// ── Promotion policy + approval repos (v0.4.0-1) ────────────────────

function mapPromotionPolicy(row: SqlRow): PromotionPolicy {
  return {
    id: row.id as string,
    orgId: row.org_id as string,
    productId: row.product_id as string,
    sourceTargetId: (row.source_target_id as string | null) ?? null,
    destTargetId: row.dest_target_id as string,
    gateKind: row.gate_kind as PromotionGateKind,
    gateConfig: JSON.parse(row.gate_config_json as string) as Record<string, unknown>,
    active: Number(row.active) === 1,
    description: (row.description as string | null) ?? null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    deletedAt: (row.deleted_at as string | null) ?? null,
  };
}

class PgPromotionPolicyRepo implements PromotionPolicyRepo {
  constructor(private readonly pool: Pool) {}

  async create(input: {
    orgId: string;
    productId: string;
    sourceTargetId?: string | null;
    destTargetId: string;
    gateKind: PromotionGateKind;
    gateConfig?: Record<string, unknown>;
    active?: boolean;
    description?: string | null;
  }): Promise<PromotionPolicy> {
    const now = nowIso();
    const bind = {
      id: newId(),
      org_id: input.orgId,
      product_id: input.productId,
      source_target_id: input.sourceTargetId ?? null,
      dest_target_id: input.destTargetId,
      gate_kind: input.gateKind,
      gate_config_json: JSON.stringify(input.gateConfig ?? {}),
      active: input.active === false ? 0 : 1,
      description: input.description ?? null,
      created_at: now,
      updated_at: now,
    };
    await pgQuery(
      this.pool,
      "INSERT INTO promotion_policy (id, org_id, product_id, source_target_id, dest_target_id, gate_kind, gate_config_json, active, description, created_at, updated_at) VALUES (@id, @org_id, @product_id, @source_target_id, @dest_target_id, @gate_kind, @gate_config_json, @active, @description, @created_at, @updated_at)",
      bind,
    );
    return mapPromotionPolicy({ ...bind, deleted_at: null });
  }

  async get(id: string): Promise<PromotionPolicy | null> {
    const r = await pgPositional(
      this.pool,
      "SELECT * FROM promotion_policy WHERE id = $1 AND deleted_at IS NULL",
      [id],
    );
    return r.rows[0] ? mapPromotionPolicy(r.rows[0]) : null;
  }

  async listForOrg(orgId: string): Promise<PromotionPolicy[]> {
    const r = await pgPositional(
      this.pool,
      "SELECT * FROM promotion_policy WHERE org_id = $1 AND deleted_at IS NULL ORDER BY created_at",
      [orgId],
    );
    return r.rows.map(mapPromotionPolicy);
  }

  async listMatchingForProduct(input: {
    productId: string;
    sourceTargetId: string | null;
  }): Promise<PromotionPolicy[]> {
    if (input.sourceTargetId === null) {
      const r = await pgPositional(
        this.pool,
        "SELECT * FROM promotion_policy WHERE product_id = $1 AND source_target_id IS NULL AND active = 1 AND deleted_at IS NULL ORDER BY created_at",
        [input.productId],
      );
      return r.rows.map(mapPromotionPolicy);
    }
    const r = await pgPositional(
      this.pool,
      "SELECT * FROM promotion_policy WHERE product_id = $1 AND source_target_id = $2 AND active = 1 AND deleted_at IS NULL ORDER BY created_at",
      [input.productId, input.sourceTargetId],
    );
    return r.rows.map(mapPromotionPolicy);
  }

  async update(
    id: string,
    patch: Partial<
      Pick<
        PromotionPolicy,
        "gateKind" | "gateConfig" | "active" | "description" | "destTargetId" | "sourceTargetId"
      >
    >,
  ): Promise<PromotionPolicy> {
    const existing = await this.get(id);
    if (!existing) throw new StorageNotFoundError("promotion_policy", id);
    const bind = {
      id: existing.id,
      gate_kind: patch.gateKind ?? existing.gateKind,
      gate_config_json: JSON.stringify(patch.gateConfig ?? existing.gateConfig),
      active:
        patch.active !== undefined
          ? patch.active
            ? 1
            : 0
          : existing.active
            ? 1
            : 0,
      description:
        patch.description !== undefined ? patch.description : existing.description,
      dest_target_id: patch.destTargetId ?? existing.destTargetId,
      source_target_id:
        patch.sourceTargetId !== undefined
          ? patch.sourceTargetId
          : existing.sourceTargetId,
      updated_at: nowIso(),
    };
    await pgQuery(
      this.pool,
      "UPDATE promotion_policy SET gate_kind = @gate_kind, gate_config_json = @gate_config_json, active = @active, description = @description, dest_target_id = @dest_target_id, source_target_id = @source_target_id, updated_at = @updated_at WHERE id = @id",
      bind,
    );
    return mapPromotionPolicy({
      ...bind,
      org_id: existing.orgId,
      product_id: existing.productId,
      created_at: existing.createdAt,
      deleted_at: existing.deletedAt,
    });
  }

  async softDelete(id: string): Promise<void> {
    const now = nowIso();
    const r = await pgPositional(
      this.pool,
      "UPDATE promotion_policy SET deleted_at = $1, updated_at = $2 WHERE id = $3 AND deleted_at IS NULL",
      [now, now, id],
    );
    if (r.rowCount === 0)
      throw new StorageNotFoundError("promotion_policy", id);
  }
}

function mapApproval(row: SqlRow): Approval {
  return {
    id: row.id as string,
    orgId: row.org_id as string,
    policyId: row.policy_id as string,
    releaseId: row.release_id as string,
    destTargetId: row.dest_target_id as string,
    status: row.status as ApprovalStatus,
    autoApproveAt: (row.auto_approve_at as string | null) ?? null,
    decidedBy: (row.decided_by as string | null) ?? null,
    decidedAt: (row.decided_at as string | null) ?? null,
    reason: (row.reason as string | null) ?? null,
    deployAttemptedAt: (row.deploy_attempted_at as string | null) ?? null,
    deployOutcome: (row.deploy_outcome as string | null) ?? null,
    deployDeploymentId: (row.deploy_deployment_id as string | null) ?? null,
    // WS6 M7: pre-migration rows have undefined; coerce to false.
    requiresHealthGate: ((row.requires_health_gate as number | undefined) ?? 0) === 1,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    deletedAt: (row.deleted_at as string | null) ?? null,
  };
}

class PgApprovalRepo implements ApprovalRepo {
  constructor(private readonly pool: Pool) {}

  async create(input: {
    orgId: string;
    policyId: string;
    releaseId: string;
    destTargetId: string;
    status: ApprovalStatus;
    autoApproveAt?: string | null;
    requiresHealthGate?: boolean;
  }): Promise<Approval> {
    const now = nowIso();
    const bind = {
      id: newId(),
      org_id: input.orgId,
      policy_id: input.policyId,
      release_id: input.releaseId,
      dest_target_id: input.destTargetId,
      status: input.status,
      auto_approve_at: input.autoApproveAt ?? null,
      requires_health_gate: input.requiresHealthGate ? 1 : 0,
      created_at: now,
      updated_at: now,
    };
    await pgQuery(
      this.pool,
      "INSERT INTO approval (id, org_id, policy_id, release_id, dest_target_id, status, auto_approve_at, requires_health_gate, created_at, updated_at) VALUES (@id, @org_id, @policy_id, @release_id, @dest_target_id, @status, @auto_approve_at, @requires_health_gate, @created_at, @updated_at)",
      bind,
    );
    return mapApproval({
      ...bind,
      decided_by: null,
      decided_at: null,
      reason: null,
      deploy_attempted_at: null,
      deploy_outcome: null,
      deploy_deployment_id: null,
      deleted_at: null,
    });
  }

  async get(id: string): Promise<Approval | null> {
    const r = await pgPositional(
      this.pool,
      "SELECT * FROM approval WHERE id = $1 AND deleted_at IS NULL",
      [id],
    );
    return r.rows[0] ? mapApproval(r.rows[0]) : null;
  }

  async getForReleaseAndTarget(input: {
    releaseId: string;
    destTargetId: string;
  }): Promise<Approval | null> {
    const r = await pgPositional(
      this.pool,
      "SELECT * FROM approval WHERE release_id = $1 AND dest_target_id = $2 AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1",
      [input.releaseId, input.destTargetId],
    );
    return r.rows[0] ? mapApproval(r.rows[0]) : null;
  }

  async listForOrg(
    orgId: string,
    opts: { status?: ApprovalStatus; limit?: number } = {},
  ): Promise<Approval[]> {
    const limit = opts.limit ?? 100;
    if (opts.status) {
      const r = await pgPositional(
        this.pool,
        "SELECT * FROM approval WHERE org_id = $1 AND status = $2 AND deleted_at IS NULL ORDER BY created_at DESC LIMIT $3",
        [orgId, opts.status, limit],
      );
      return r.rows.map(mapApproval);
    }
    const r = await pgPositional(
      this.pool,
      "SELECT * FROM approval WHERE org_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC LIMIT $2",
      [orgId, limit],
    );
    return r.rows.map(mapApproval);
  }

  async listPendingAutoApprove(nowIsoStr: string): Promise<Approval[]> {
    const r = await pgPositional(
      this.pool,
      "SELECT * FROM approval WHERE status = 'pending' AND auto_approve_at IS NOT NULL AND auto_approve_at <= $1 AND deleted_at IS NULL ORDER BY auto_approve_at",
      [nowIsoStr],
    );
    return r.rows.map(mapApproval);
  }

  async listPendingHealthGated(): Promise<Approval[]> {
    const r = await pgPositional(
      this.pool,
      "SELECT * FROM approval WHERE status = 'pending' AND requires_health_gate = 1 AND deleted_at IS NULL ORDER BY created_at",
      [],
    );
    return r.rows.map(mapApproval);
  }

  async update(
    id: string,
    patch: Partial<
      Pick<
        Approval,
        | "status"
        | "decidedBy"
        | "decidedAt"
        | "reason"
        | "deployAttemptedAt"
        | "deployOutcome"
        | "deployDeploymentId"
      >
    >,
  ): Promise<Approval> {
    const existing = await this.get(id);
    if (!existing) throw new StorageNotFoundError("approval", id);
    const bind = {
      id: existing.id,
      status: patch.status ?? existing.status,
      decided_by:
        patch.decidedBy !== undefined ? patch.decidedBy : existing.decidedBy,
      decided_at:
        patch.decidedAt !== undefined ? patch.decidedAt : existing.decidedAt,
      reason: patch.reason !== undefined ? patch.reason : existing.reason,
      deploy_attempted_at:
        patch.deployAttemptedAt !== undefined
          ? patch.deployAttemptedAt
          : existing.deployAttemptedAt,
      deploy_outcome:
        patch.deployOutcome !== undefined
          ? patch.deployOutcome
          : existing.deployOutcome,
      deploy_deployment_id:
        patch.deployDeploymentId !== undefined
          ? patch.deployDeploymentId
          : existing.deployDeploymentId,
      updated_at: nowIso(),
    };
    await pgQuery(
      this.pool,
      "UPDATE approval SET status = @status, decided_by = @decided_by, decided_at = @decided_at, reason = @reason, deploy_attempted_at = @deploy_attempted_at, deploy_outcome = @deploy_outcome, deploy_deployment_id = @deploy_deployment_id, updated_at = @updated_at WHERE id = @id",
      bind,
    );
    return mapApproval({
      ...bind,
      org_id: existing.orgId,
      policy_id: existing.policyId,
      release_id: existing.releaseId,
      dest_target_id: existing.destTargetId,
      auto_approve_at: existing.autoApproveAt,
      created_at: existing.createdAt,
      deleted_at: existing.deletedAt,
    });
  }

  async softDelete(id: string): Promise<void> {
    const now = nowIso();
    const r = await pgPositional(
      this.pool,
      "UPDATE approval SET deleted_at = $1, updated_at = $2 WHERE id = $3 AND deleted_at IS NULL",
      [now, now, id],
    );
    if (r.rowCount === 0) throw new StorageNotFoundError("approval", id);
  }
}

// ── Runner repo (WS6 M3) ────────────────────────────────────────────

function mapRunner(row: SqlRow): Runner {
  return {
    id: row.id as string,
    orgId: row.org_id as string,
    name: row.name as string,
    lastSeenAt: row.last_seen_at as string,
    registeredAt: row.registered_at as string,
    meta: row.meta
      ? (typeof row.meta === "string"
          ? (JSON.parse(row.meta) as Record<string, unknown>)
          : (row.meta as Record<string, unknown>))
      : null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    deletedAt: (row.deleted_at as string | null) ?? null,
  };
}

class PgRunnerRepo implements RunnerRepo {
  constructor(private readonly pool: Pool) {}

  async heartbeat(input: {
    orgId: string;
    name: string;
    meta?: Record<string, unknown> | null;
  }): Promise<Runner> {
    const now = nowIso();
    const lookup = await pgPositional(
      this.pool,
      "SELECT * FROM runner WHERE org_id = $1 AND name = $2 ORDER BY (deleted_at IS NULL) DESC, last_seen_at DESC LIMIT 1",
      [input.orgId, input.name],
    );
    const existing = lookup.rows[0] as SqlRow | undefined;
    const metaJson = input.meta === undefined ? null : JSON.stringify(input.meta ?? {});

    if (existing && existing.deleted_at === null) {
      const bind = {
        id: existing.id as string,
        last_seen_at: now,
        meta: metaJson ?? (existing.meta as string | null),
        updated_at: now,
      };
      await pgQuery(
        this.pool,
        "UPDATE runner SET last_seen_at = @last_seen_at, meta = @meta, updated_at = @updated_at WHERE id = @id",
        bind,
      );
      return mapRunner({ ...existing, ...bind });
    }

    if (existing && existing.deleted_at !== null) {
      const bind = {
        id: existing.id as string,
        last_seen_at: now,
        registered_at: now,
        meta: metaJson,
        updated_at: now,
      };
      await pgQuery(
        this.pool,
        "UPDATE runner SET last_seen_at = @last_seen_at, registered_at = @registered_at, meta = @meta, updated_at = @updated_at, deleted_at = NULL WHERE id = @id",
        bind,
      );
      return mapRunner({ ...existing, ...bind, deleted_at: null });
    }

    const bind = {
      id: newId(),
      org_id: input.orgId,
      name: input.name,
      last_seen_at: now,
      registered_at: now,
      meta: metaJson,
      created_at: now,
      updated_at: now,
    };
    await pgQuery(
      this.pool,
      "INSERT INTO runner (id, org_id, name, last_seen_at, registered_at, meta, created_at, updated_at) VALUES (@id, @org_id, @name, @last_seen_at, @registered_at, @meta, @created_at, @updated_at)",
      bind,
    );
    return mapRunner({ ...bind, deleted_at: null });
  }

  async get(id: string): Promise<Runner | null> {
    const r = await pgPositional(
      this.pool,
      "SELECT * FROM runner WHERE id = $1 AND deleted_at IS NULL",
      [id],
    );
    return r.rows[0] ? mapRunner(r.rows[0]) : null;
  }

  async getByName(orgId: string, name: string): Promise<Runner | null> {
    const r = await pgPositional(
      this.pool,
      "SELECT * FROM runner WHERE org_id = $1 AND name = $2 AND deleted_at IS NULL",
      [orgId, name],
    );
    return r.rows[0] ? mapRunner(r.rows[0]) : null;
  }

  async listForOrg(orgId: string): Promise<Runner[]> {
    const r = await pgPositional(
      this.pool,
      "SELECT * FROM runner WHERE org_id = $1 AND deleted_at IS NULL ORDER BY last_seen_at DESC",
      [orgId],
    );
    return r.rows.map(mapRunner);
  }

  async softDelete(id: string): Promise<void> {
    const now = nowIso();
    const r = await pgPositional(
      this.pool,
      "UPDATE runner SET deleted_at = $1, updated_at = $2 WHERE id = $3 AND deleted_at IS NULL",
      [now, now, id],
    );
    if (!r.rowCount) throw new StorageNotFoundError("runner", id);
  }
}

// ── WS9 M2 ─────────────────────────────────────────────────────────

function mapPgSigningProviderKey(row: SqlRow): SigningProviderKey {
  return {
    id: row.id as string,
    orgId: row.org_id as string,
    provider: row.provider as string,
    keyId: row.key_id as string,
    algorithm: row.algorithm as SigningProviderKey["algorithm"],
    fingerprint: row.fingerprint as string,
    publicKeyB64: row.public_key_b64 as string,
    pairId: (row.pair_id as string | null) ?? null,
    pairRole: (row.pair_role as SigningProviderKey["pairRole"]) ?? null,
    hybridAlias: (row.hybrid_alias as string | null) ?? null,
    label: (row.label as string | null) ?? null,
    addedBy: row.added_by as string,
    addedAt: row.added_at as string,
    revokedAt: (row.revoked_at as string | null) ?? null,
    revokedBy: (row.revoked_by as string | null) ?? null,
    revokeReason: (row.revoke_reason as string | null) ?? null,
    rotatedTo: (row.rotated_to as string | null) ?? null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

class PgSigningProviderKeyRepo implements SigningProviderKeyRepo {
  constructor(private readonly pool: Pool) {}

  async insert(input: {
    orgId: string;
    provider: string;
    keyId: string;
    algorithm: SigningProviderKey["algorithm"];
    fingerprint: string;
    publicKeyB64: string;
    pairId?: string | null;
    pairRole?: SigningProviderKey["pairRole"];
    hybridAlias?: string | null;
    label?: string | null;
    addedBy: string;
  }): Promise<SigningProviderKey> {
    const now = nowIso();
    const id = newId();
    try {
      const out = await this.pool.query(
        `INSERT INTO signing_provider_key
          (id, org_id, provider, key_id, algorithm, fingerprint, public_key_b64,
           pair_id, pair_role, hybrid_alias, label, added_by, added_at,
           created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $13, $13)
         RETURNING *`,
        [
          id,
          input.orgId,
          input.provider,
          input.keyId,
          input.algorithm,
          input.fingerprint,
          input.publicKeyB64,
          input.pairId ?? null,
          input.pairRole ?? null,
          input.hybridAlias ?? null,
          input.label ?? null,
          input.addedBy,
          now,
        ],
      );
      return mapPgSigningProviderKey(out.rows[0] as SqlRow);
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === "23505") {
        // unique_violation
        throw new StorageConflictError(
          `signing key fingerprint ${input.fingerprint} already registered for org ${input.orgId}`,
        );
      }
      throw err;
    }
  }

  async getByFingerprint(
    orgId: string,
    fingerprint: string,
  ): Promise<SigningProviderKey | null> {
    const out = await this.pool.query(
      "SELECT * FROM signing_provider_key WHERE org_id = $1 AND fingerprint = $2 AND deleted_at IS NULL",
      [orgId, fingerprint],
    );
    return out.rows[0]
      ? mapPgSigningProviderKey(out.rows[0] as SqlRow)
      : null;
  }

  async getByAlias(
    orgId: string,
    keyId: string,
  ): Promise<readonly SigningProviderKey[]> {
    const out = await this.pool.query(
      "SELECT * FROM signing_provider_key WHERE org_id = $1 AND key_id = $2 AND deleted_at IS NULL ORDER BY pair_role, added_at",
      [orgId, keyId],
    );
    return (out.rows as SqlRow[]).map(mapPgSigningProviderKey);
  }

  async list(
    orgId: string,
    opts: { provider?: string; includeRevoked?: boolean } = {},
  ): Promise<readonly SigningProviderKey[]> {
    const parts: string[] = ["org_id = $1", "deleted_at IS NULL"];
    const params: unknown[] = [orgId];
    if (opts.provider) {
      params.push(opts.provider);
      parts.push(`provider = $${params.length}`);
    }
    if (!opts.includeRevoked) {
      parts.push("revoked_at IS NULL");
    }
    const sql = `SELECT * FROM signing_provider_key WHERE ${parts.join(" AND ")} ORDER BY added_at DESC`;
    const out = await this.pool.query(sql, params);
    return (out.rows as SqlRow[]).map(mapPgSigningProviderKey);
  }

  async revoke(input: {
    orgId: string;
    fingerprint: string;
    revokedBy: string;
    reason: string;
  }): Promise<void> {
    const now = nowIso();
    await this.pool.query(
      `UPDATE signing_provider_key SET revoked_at = $1, revoked_by = $2, revoke_reason = $3, updated_at = $4
       WHERE org_id = $5 AND fingerprint = $6 AND deleted_at IS NULL AND revoked_at IS NULL`,
      [now, input.revokedBy, input.reason, now, input.orgId, input.fingerprint],
    );
  }

  async recordRotation(input: {
    orgId: string;
    oldFingerprint: string;
    newFingerprint: string;
  }): Promise<void> {
    const now = nowIso();
    const lookup = await this.pool.query(
      "SELECT id FROM signing_provider_key WHERE org_id = $1 AND fingerprint = $2 AND deleted_at IS NULL",
      [input.orgId, input.newFingerprint],
    );
    if (!lookup.rows[0]) {
      throw new StorageNotFoundError(
        "signing_provider_key",
        `new fingerprint ${input.newFingerprint} not in catalog`,
      );
    }
    const newId = (lookup.rows[0] as SqlRow).id as string;
    await this.pool.query(
      "UPDATE signing_provider_key SET rotated_to = $1, updated_at = $2 WHERE org_id = $3 AND fingerprint = $4 AND deleted_at IS NULL",
      [newId, now, input.orgId, input.oldFingerprint],
    );
  }
}

class PgSigningNonceRepo implements SigningNonceRepo {
  constructor(private readonly pool: Pool) {}

  async insert(input: SigningNonce): Promise<void> {
    try {
      await this.pool.query(
        "INSERT INTO signing_nonce (org_id, actor_cn, nonce, requested_at, fingerprint) VALUES ($1, $2, $3, $4, $5)",
        [input.orgId, input.actorCn, input.nonce, input.requestedAt, input.fingerprint],
      );
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === "23505") {
        throw new StorageConflictError(
          `signing nonce already used: org=${input.orgId} actor=${input.actorCn} nonce=${input.nonce}`,
        );
      }
      throw err;
    }
  }

  async exists(orgId: string, actorCn: string, nonce: string): Promise<boolean> {
    const out = await this.pool.query(
      "SELECT 1 FROM signing_nonce WHERE org_id = $1 AND actor_cn = $2 AND nonce = $3 LIMIT 1",
      [orgId, actorCn, nonce],
    );
    return out.rows.length > 0;
  }

  async sweepOlderThan(cutoffIso: string): Promise<number> {
    const out = await this.pool.query(
      "DELETE FROM signing_nonce WHERE requested_at < $1",
      [cutoffIso],
    );
    return out.rowCount ?? 0;
  }
}
