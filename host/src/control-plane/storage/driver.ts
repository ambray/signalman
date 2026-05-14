/**
 * StorageDriver — relational backend interface for the control plane.
 *
 * Pluggable per docs/design/meta-build-system.md §5: SQLite for local
 * and self-hosted-small (default), Postgres for self-hosted-large.
 * Drivers expose typed entity repositories rather
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
  CloudOrgBudget,
  CloudOrgCredential,
  CloudOrgUsage,
  Deployment,
  HealthCheck,
  HealthSchedule,
  HealthStatus,
  Job,
  JobStatus,
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
        | "signatureB64"
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

/**
 * Repository for periodic health-check schedules (v0.4.0-3 / Epic 3).
 * The scheduler module in control-plane/scheduler/ owns the wake-and-
 * dispatch loop; this repo just persists the configured schedules.
 */
export interface HealthScheduleRepo {
  create(input: {
    orgId: string;
    targetId: string;
    intervalSeconds: number;
    probeNames: string[];
    active?: boolean;
  }): Promise<HealthSchedule>;
  get(id: string): Promise<HealthSchedule | null>;
  listForOrg(orgId: string): Promise<HealthSchedule[]>;
  listForTarget(targetId: string): Promise<HealthSchedule[]>;
  /**
   * Active, undeleted schedules for the org, regardless of target.
   * The scheduler tick uses this to find work; "due-ness" is decided
   * in the scheduler against `now` (rather than via SQL) so the
   * comparison stays portable between SQLite and Postgres without
   * driver-specific time arithmetic.
   */
  listActive(orgId?: string): Promise<HealthSchedule[]>;
  update(
    id: string,
    patch: Partial<
      Pick<HealthSchedule, "intervalSeconds" | "probeNames" | "active" | "lastRunAt">
    >,
  ): Promise<HealthSchedule>;
  softDelete(id: string): Promise<void>;
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

export interface JobRepo {
  create(input: {
    orgId: string;
    kind: string;
    input?: Record<string, unknown>;
  }): Promise<Job>;
  get(id: string): Promise<Job | null>;
  listForOrg(
    orgId: string,
    opts?: { limit?: number; status?: JobStatus },
  ): Promise<Job[]>;
  /**
   * Atomically claim the oldest pending job for an org. Returns null
   * when the queue is empty. The repo guarantees at most one worker
   * sees a given job in `claimed` state, even under concurrent calls.
   */
  claimNext(input: {
    orgId: string;
    claimedBy: string;
  }): Promise<Job | null>;
  /** Set status / started_at / completed_at / result / error. */
  update(
    id: string,
    patch: Partial<
      Pick<
        Job,
        "status" | "result" | "error" | "startedAt" | "completedAt"
      >
    >,
  ): Promise<Job>;
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

// ── Cloud cost guardrails (v0.3.0-5 sub-task 5) ────────────────────

/**
 * Per-org budget configuration. `softWarnPct` is the percentage
 * at which the gate flags `warned: true`; 100% is the hard limit.
 */
export interface CloudBudgetRepo {
  /** Return the org's budget row, or null if none configured. */
  get(orgId: string): Promise<CloudOrgBudget | null>;
  /**
   * Create or update the org's budget. softWarnPct defaults to 80
   * per design §13.5. Caller passes monthlyCentsLimit > 0
   * (constraint enforced by the storage layer).
   */
  upsert(input: {
    orgId: string;
    monthlyCentsLimit: number;
    softWarnPct?: number;
  }): Promise<CloudOrgBudget>;
  /** Remove the org's budget; usage rows are unaffected. */
  remove(orgId: string): Promise<void>;
}

/**
 * Per-instance cost tracking. The budget gate sums rows by
 * (orgId, billing-month) to compute current usage; terminate
 * marks the row so followup reconciliation can narrow estimates
 * to actual lifetime.
 */
export interface CloudUsageRepo {
  /**
   * Record a new in-flight instance with its initial estimated
   * cost. Unique on (orgId, instanceId).
   */
  recordStart(input: {
    orgId: string;
    backend: string;
    instanceId: string;
    instanceType: string;
    region: string;
    startedAt: string;
    estimatedCents: number;
  }): Promise<CloudOrgUsage>;
  /**
   * Mark the row terminated. No-op if no matching row (idempotent
   * — matches the backend's terminateInstance contract).
   */
  recordTerminate(input: {
    orgId: string;
    instanceId: string;
    terminatedAt: string;
  }): Promise<void>;
  /**
   * Sum estimated_cents for the org across a date range. The gate
   * calls this with the current billing month's bounds.
   */
  sumForRange(input: {
    orgId: string;
    startedAtFrom: string;
    startedAtTo: string;
  }): Promise<number>;
  /** List usage rows for an org (optionally filtered by range). */
  listForOrg(
    orgId: string,
    opts?: { startedAtFrom?: string; startedAtTo?: string },
  ): Promise<CloudOrgUsage[]>;
}

/**
 * Per-org cloud credentials, stored encrypted (v0.3.0-5 sub-task 6).
 *
 * Repos handle the raw row. Encryption/decryption lives in
 * `host/src/cloud/credentials.ts` — repo callers pass ciphertext
 * + redacted hint in; the decrypter loads the row and applies
 * AES-GCM at call time.
 */
export interface CloudCredentialsRepo {
  /** Return the credential row for the org+backend, or null. */
  get(orgId: string, backend: string): Promise<CloudOrgCredential | null>;
  /**
   * Upsert (overwrite) the credential. Operators rotating
   * credentials run this; downstream callers re-decrypt with the
   * new ciphertext on next read.
   */
  upsert(input: {
    orgId: string;
    backend: string;
    ciphertextB64: string;
    encryptionMethod: string;
    redactedHint: string;
  }): Promise<CloudOrgCredential>;
  /** Remove the credential. Idempotent. */
  remove(orgId: string, backend: string): Promise<void>;
  /** List all credentials for the org (across backends). */
  listForOrg(orgId: string): Promise<CloudOrgCredential[]>;
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

  // PR 8 — runner queue:
  readonly jobs: JobRepo;

  // v0.3.0-5 sub-task 5 — cloud cost guardrails:
  readonly cloudBudgets: CloudBudgetRepo;
  readonly cloudUsage: CloudUsageRepo;
  // v0.3.0-5 sub-task 6 — per-org credentials at rest:
  readonly cloudCredentials: CloudCredentialsRepo;
  // v0.4.0-3 (Epic 3, WS3) — scheduled health checks:
  readonly healthSchedules: HealthScheduleRepo;
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
