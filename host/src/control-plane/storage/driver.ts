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
  Approval,
  ApprovalStatus,
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
  PromotionGateKind,
  PromotionPolicy,
  Release,
  ReleaseStatus,
  Run,
  Runner,
  RunTriggeredBy,
  Scenario,
  Target,
  TargetConnection,
  TargetKind,
  WebhookKind,
  WebhookSubscription,
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
  /**
   * Edit a target row. `kind` and `id` are NOT editable — kind would
   * invalidate past deployments' backend assumptions; id is the
   * primary key. Past deployment rows reference targets by id and
   * are intentionally NOT updated by this method — operations
   * against a deployment use the target row's *current* connection,
   * which is the right semantic for rollback / health-check.
   *
   * @throws StorageNotFoundError when `id` is unknown or soft-deleted.
   * @throws StorageConflictError when renaming to a name held by
   *   another active target in the same org.
   */
  update(
    id: string,
    patch: Partial<Pick<Target, "name" | "connection">>,
  ): Promise<Target>;
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
 * Repository for promotion policies (v0.4.0-1 / Epic 1).
 * A policy says "when a release of <product> lands at <source target>
 * (or is freshly built when sourceTargetId is null), promote it onto
 * <dest target> using <gate kind> semantics."
 */
export interface PromotionPolicyRepo {
  create(input: {
    orgId: string;
    productId: string;
    sourceTargetId?: string | null;
    destTargetId: string;
    gateKind: PromotionGateKind;
    gateConfig?: Record<string, unknown>;
    active?: boolean;
    description?: string | null;
  }): Promise<PromotionPolicy>;
  get(id: string): Promise<PromotionPolicy | null>;
  listForOrg(orgId: string): Promise<PromotionPolicy[]>;
  /**
   * Active policies matching `productId`. Optional `sourceTargetId`
   * narrows to the ones whose source matches (or, when null is
   * passed, the initial-tier ones).
   */
  listMatchingForProduct(input: {
    productId: string;
    sourceTargetId: string | null;
  }): Promise<PromotionPolicy[]>;
  update(
    id: string,
    patch: Partial<
      Pick<
        PromotionPolicy,
        "gateKind" | "gateConfig" | "active" | "description" | "destTargetId" | "sourceTargetId"
      >
    >,
  ): Promise<PromotionPolicy>;
  softDelete(id: string): Promise<void>;
}

/**
 * Repository for approval rows (v0.4.0-1 / Epic 1). One row per
 * attempted promotion. Unique on (release_id, dest_target_id) while
 * pending or post-deploy so a re-fire of the listener can't queue
 * duplicates.
 */
export interface ApprovalRepo {
  create(input: {
    orgId: string;
    policyId: string;
    releaseId: string;
    destTargetId: string;
    status: ApprovalStatus;
    autoApproveAt?: string | null;
    /** WS6 M7: marks the approval as waiting on a source-tier health gate. */
    requiresHealthGate?: boolean;
  }): Promise<Approval>;
  get(id: string): Promise<Approval | null>;
  getForReleaseAndTarget(input: {
    releaseId: string;
    destTargetId: string;
  }): Promise<Approval | null>;
  listForOrg(
    orgId: string,
    opts?: { status?: ApprovalStatus; limit?: number },
  ): Promise<Approval[]>;
  listPendingAutoApprove(nowIso: string): Promise<Approval[]>;
  /**
   * WS6 M7: pending approvals whose `requires_health_gate` is set.
   * The promotion tick walks these on every pass and checks whether
   * the source-tier health-gate has opened.
   */
  listPendingHealthGated(): Promise<Approval[]>;
  update(
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
  ): Promise<Approval>;
  softDelete(id: string): Promise<void>;
}

/**
 * Repository for outbound webhook subscriptions (v0.4.0-2 / Epic 2).
 * The event dispatcher in control-plane/events/dispatcher.ts walks
 * this repo on every dispatched event and routes to the appropriate
 * driver based on `kind`.
 */
export interface WebhookSubscriptionRepo {
  create(input: {
    orgId: string;
    kind: WebhookKind;
    url: string;
    secretHmacKey?: string | null;
    eventKinds?: string[];
    active?: boolean;
    description?: string | null;
  }): Promise<WebhookSubscription>;
  get(id: string): Promise<WebhookSubscription | null>;
  listForOrg(orgId: string): Promise<WebhookSubscription[]>;
  /** Active, undeleted subscriptions. The dispatcher uses this on every event. */
  listActive(orgId?: string): Promise<WebhookSubscription[]>;
  update(
    id: string,
    patch: Partial<
      Pick<
        WebhookSubscription,
        "url" | "secretHmacKey" | "eventKinds" | "active" | "description"
      >
    >,
  ): Promise<WebhookSubscription>;
  softDelete(id: string): Promise<void>;
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
  // v0.4.0-2 (Epic 2, WS3) — outbound webhook subscriptions:
  readonly webhookSubscriptions: WebhookSubscriptionRepo;
  // v0.4.0-1 (Epic 1, WS3) — promotion policies + approvals:
  readonly promotionPolicies: PromotionPolicyRepo;
  readonly approvals: ApprovalRepo;
  // WS6 M3 — registered runners + heartbeat:
  readonly runners: RunnerRepo;
}

// ── RunnerRepo (WS6 M3) ─────────────────────────────────────────────

export interface RunnerRepo {
  /**
   * Heartbeat from a worker. Upserts by (orgId, name):
   *   - First call for that (org, name) creates a new row with
   *     `registered_at` = now.
   *   - Subsequent calls update `last_seen_at` and `meta`; the
   *     `registered_at` stays at the first-call value.
   *   - If a row exists but is soft-deleted (deregistered), this
   *     call resurrects it: clears `deleted_at`, sets a fresh
   *     `registered_at` (because the runner went away and came
   *     back as a new lifecycle).
   *
   * Returns the upserted row.
   */
  heartbeat(input: {
    orgId: string;
    name: string;
    meta?: Record<string, unknown> | null;
  }): Promise<Runner>;

  /** Get by id (active only). */
  get(id: string): Promise<Runner | null>;

  /** Get by name within an org (active only). */
  getByName(orgId: string, name: string): Promise<Runner | null>;

  /**
   * List active runners for an org, newest-`last_seen_at` first.
   * The "stale" determination is left to the caller — repos return
   * raw rows; the verb layer applies the staleness threshold.
   */
  listForOrg(orgId: string): Promise<Runner[]>;

  /** Soft-delete (deregister) by id. */
  softDelete(id: string): Promise<void>;
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
