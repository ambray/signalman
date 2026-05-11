/**
 * StorageDriver — relational backend interface for the control plane.
 *
 * Pluggable per docs/design/meta-build-system.md §5: SQLite for local
 * and self-hosted-small (default), Postgres for self-hosted-large and
 * hosted commercial. Drivers expose typed entity repositories rather
 * than raw `query()` so callers don't hand-roll SQL and the
 * Postgres/SQLite split stays invisible to verb code.
 *
 * v0.2.0 (PR 1) implements: orgs, products, releases, artifacts,
 * auditLog. Targets/deployments/healthChecks land in PR 3, scenarios/
 * runs in PR 5; their interfaces are reserved here so the driver shape
 * is stable from the start.
 *
 * Repository methods are async to keep the API uniform across SQLite
 * (synchronous under the hood) and Postgres (genuinely async).
 */

import type {
  ApiKey,
  Artifact,
  ArtifactKind,
  AuditLogEntry,
  Deployment,
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
  Target,
  TargetConnection,
  TargetKind,
} from "../types.js";

// ── Repository interfaces ───────────────────────────────────────────

export interface OrgRepo {
  create(input: { name: string; tier?: OrgTier }): Promise<Org>;
  get(id: string): Promise<Org | null>;
  getByName(name: string): Promise<Org | null>;
  list(): Promise<Org[]>;
  update(id: string, patch: Partial<Pick<Org, "name" | "tier">>): Promise<Org>;
  softDelete(id: string): Promise<void>;
}

export interface ApiKeyRepo {
  create(input: {
    orgId: string;
    name: string;
    prefix: string;
    hash: string;
    expiresAt?: string;
  }): Promise<ApiKey>;
  get(id: string): Promise<ApiKey | null>;
  getByPrefix(prefix: string): Promise<ApiKey | null>;
  listForOrg(orgId: string): Promise<ApiKey[]>;
  softDelete(id: string): Promise<void>;
}

export interface ProductRepo {
  create(input: {
    orgId: string;
    name: string;
    repoUrl: string;
    buildYamlPath?: string;
  }): Promise<Product>;
  get(id: string): Promise<Product | null>;
  getByName(orgId: string, name: string): Promise<Product | null>;
  listForOrg(orgId: string): Promise<Product[]>;
  update(
    id: string,
    patch: Partial<Pick<Product, "name" | "repoUrl" | "buildYamlPath">>,
  ): Promise<Product>;
  softDelete(id: string): Promise<void>;
}

export interface ReleaseRepo {
  create(input: {
    orgId: string;
    productId: string;
    tag: string;
    commitSha: string;
    status?: ReleaseStatus;
  }): Promise<Release>;
  get(id: string): Promise<Release | null>;
  getByTag(productId: string, tag: string): Promise<Release | null>;
  listForProduct(productId: string, opts?: { status?: ReleaseStatus }): Promise<Release[]>;
  update(
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
  ): Promise<Release>;
  softDelete(id: string): Promise<void>;
}

export interface ArtifactRepo {
  create(input: {
    releaseId: string;
    component: string;
    kind: ArtifactKind;
    sha256?: string;
    sizeBytes?: number;
    blobUri?: string;
    imageRef?: string;
  }): Promise<Artifact>;
  get(id: string): Promise<Artifact | null>;
  listForRelease(releaseId: string): Promise<Artifact[]>;
  softDelete(id: string): Promise<void>;
}

export interface AuditLogRepo {
  /** Append an entry. Audit log is immutable — there is no update. */
  append(input: {
    orgId: string;
    actor: string;
    action: string;
    entityType: string;
    entityId: string;
    detail?: Record<string, unknown>;
  }): Promise<AuditLogEntry>;
  /** List entries for an org, newest first. */
  listForOrg(
    orgId: string,
    opts?: { limit?: number; entityType?: string; entityId?: string },
  ): Promise<AuditLogEntry[]>;
}

// ── Reserved interfaces (PR 3 / PR 5 will implement) ────────────────

export interface TargetRepo {
  create(input: {
    orgId: string;
    name: string;
    kind: TargetKind;
    connection: TargetConnection;
  }): Promise<Target>;
  get(id: string): Promise<Target | null>;
  getByName(orgId: string, name: string): Promise<Target | null>;
  listForOrg(orgId: string): Promise<Target[]>;
  softDelete(id: string): Promise<void>;
}

export interface DeploymentRepo {
  create(input: {
    orgId: string;
    releaseId: string;
    targetId: string;
    previousDeploymentId?: string;
  }): Promise<Deployment>;
  get(id: string): Promise<Deployment | null>;
  getActiveForTarget(targetId: string): Promise<Deployment | null>;
  listForTarget(targetId: string, opts?: { limit?: number }): Promise<Deployment[]>;
  update(
    id: string,
    patch: Partial<
      Pick<
        Deployment,
        "status" | "startedAt" | "completedAt" | "healthSummary"
      >
    >,
  ): Promise<Deployment>;
}

export interface HealthCheckRepo {
  append(input: {
    deploymentId: string;
    probeName: string;
    status: HealthStatus;
    latencyMs?: number;
    detail?: string;
  }): Promise<HealthCheck>;
  listForDeployment(
    deploymentId: string,
    opts?: { since?: string; limit?: number },
  ): Promise<HealthCheck[]>;
}

export interface ScenarioRepo {
  upsertFromDisk(input: {
    orgId: string;
    path: string;
    scenarioHash: string;
    name: string;
    tags: string[];
  }): Promise<Scenario>;
  get(id: string): Promise<Scenario | null>;
  getByPath(orgId: string, path: string): Promise<Scenario | null>;
  listForOrg(orgId: string): Promise<Scenario[]>;
  softDelete(id: string): Promise<void>;
}

export interface RunRepo {
  create(input: {
    orgId: string;
    scenarioId: string;
    targetId?: string;
    triggeredBy: RunTriggeredBy;
  }): Promise<Run>;
  get(id: string): Promise<Run | null>;
  listForScenario(scenarioId: string, opts?: { limit?: number }): Promise<Run[]>;
  update(
    id: string,
    patch: Partial<
      Pick<Run, "envelopeBlobUri" | "result" | "startedAt" | "completedAt">
    >,
  ): Promise<Run>;
}

// ── Driver façade ───────────────────────────────────────────────────

export interface StorageDriver {
  /** Apply pending migrations. Idempotent. */
  migrate(): Promise<void>;
  /** Close the underlying connection. Idempotent. */
  close(): Promise<void>;

  // PR 1 — implemented:
  readonly orgs: OrgRepo;
  readonly apiKeys: ApiKeyRepo;
  readonly products: ProductRepo;
  readonly releases: ReleaseRepo;
  readonly artifacts: ArtifactRepo;
  readonly auditLog: AuditLogRepo;

  // PR 3 — interfaces declared, throw NotImplementedError until then:
  readonly targets: TargetRepo;
  readonly deployments: DeploymentRepo;
  readonly healthChecks: HealthCheckRepo;

  // PR 5:
  readonly scenarios: ScenarioRepo;
  readonly runs: RunRepo;
}

/** Thrown by repos that are declared in this PR but not yet implemented. */
export class NotImplementedError extends Error {
  constructor(method: string) {
    super(`${method} is not implemented in this build (deferred to a later PR)`);
    this.name = "NotImplementedError";
  }
}

/** Distinct error thrown by repository methods when a row is not found. */
export class StorageNotFoundError extends Error {
  constructor(entity: string, id: string) {
    super(`${entity} not found: ${id}`);
    this.name = "StorageNotFoundError";
  }
}

/** Thrown when a unique constraint or check constraint is violated. */
export class StorageConflictError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "StorageConflictError";
  }
}
