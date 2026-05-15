/**
 * Control-plane entity types.
 *
 * Mirrors the schema in storage/migrations/0001_init.sql and the data
 * model in docs/design/meta-build-system.md §4. Types are deliberately
 * narrow — JSON-typed columns (e.g. `connection`, `tags`,
 * `health_summary`) are decoded into structured types here, not left
 * as `string` for callers to parse.
 *
 * IDs are ULIDs (TEXT). Timestamps are ISO-8601 UTC strings; convert
 * to Date in callers that need it. Soft-delete is via `deletedAt`;
 * repositories filter `deletedAt IS NULL` by default.
 */

// ── Tenancy ─────────────────────────────────────────────────────────

export type OrgTier = "free" | "paid";

export interface Org {
  id: string;
  name: string;
  tier: OrgTier;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface ApiKey {
  id: string;
  orgId: string;
  prefix: string;
  hash: string;
  name: string;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

// ── Products and releases ───────────────────────────────────────────

export interface Product {
  id: string;
  orgId: string;
  name: string;
  repoUrl: string;
  buildYamlPath: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export type ReleaseStatus = "building" | "ready" | "failed";

export interface Release {
  id: string;
  orgId: string;
  productId: string;
  tag: string;
  commitSha: string;
  manifestSha256: string | null;
  /**
   * Public-key fingerprint of the signer (first 16 hex chars of
   * `sha256(DER(public key))`). Paired with `signatureB64` for verifies.
   * Null on unsigned releases.
   */
  signedBy: string | null;
  /**
   * Base64-encoded Ed25519 signature over the canonical manifest JSON.
   * Verify with the public key whose fingerprint matches `signedBy`.
   * Null on unsigned releases. (PR 10a — manifest signing.)
   */
  signatureB64: string | null;
  builtAt: string | null;
  builtByRunnerId: string | null;
  status: ReleaseStatus;
  /**
   * JSON-encoded parsed `signalman.build.yaml`. Set by the build
   * executor on success so deploy + health verbs don't need the
   * source tree. Null for releases that predate PR 4 or for in-
   * progress builds.
   */
  buildYamlJson: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export type ArtifactKind = "blob" | "image_ref";

export interface Artifact {
  id: string;
  releaseId: string;
  component: string;
  kind: ArtifactKind;
  sha256: string | null;
  sizeBytes: number | null;
  blobUri: string | null;
  imageRef: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

// ── Targets and deployments ─────────────────────────────────────────

/**
 * Target dispatch kind. Append-only: existing rows in storage carry
 * the old kinds, so removing or renaming a value is a migration.
 *
 * - `vm_test` / `vm_demo` — hypervisor-backed VMs (v0.2.0).
 * - `docker_test` / `docker_demo` — docker-compose deploy targets
 *   (v0.2.0 placeholder; the driver wiring landed alongside the VM
 *   path).
 * - `k8s_test` / `k8s_demo` — Kubernetes deploy targets (v0.3.0-6).
 *   The `bundle_uri` + `namespace` + optional `cluster_context` live
 *   on `TargetConnection`; dispatch happens in
 *   `verbs/control-plane.ts` based on the `k8s_` prefix.
 */
export type TargetKind =
  | "vm_test"
  | "vm_demo"
  | "docker_test"
  | "docker_demo"
  | "k8s_test"
  | "k8s_demo";

/** JSON shape of `target.connection`. Intentionally permissive — the
 * exact required fields vary per `kind` and are validated by the
 * deploy verb (PR 3). */
export interface TargetConnection {
  backend?: string;
  vmName?: string;
  host?: string;
  [k: string]: unknown;
}

export interface Target {
  id: string;
  orgId: string;
  name: string;
  kind: TargetKind;
  connection: TargetConnection;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export type DeploymentStatus =
  | "pending"
  | "deploying"
  | "active"
  | "failed"
  | "superseded"
  | "rolled_back";

export interface DeploymentHealthSummary {
  total: number;
  pass: number;
  fail: number;
  degraded: number;
  lastCheckedAt?: string;
}

export interface Deployment {
  id: string;
  orgId: string;
  releaseId: string;
  targetId: string;
  status: DeploymentStatus;
  startedAt: string | null;
  completedAt: string | null;
  previousDeploymentId: string | null;
  healthSummary: DeploymentHealthSummary | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export type HealthStatus = "pass" | "fail" | "degraded";

export interface HealthCheck {
  id: string;
  deploymentId: string;
  probeName: string;
  status: HealthStatus;
  latencyMs: number | null;
  detail: string | null;
  checkedAt: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

// ── Scenarios and runs ──────────────────────────────────────────────

export type ScenarioSource = "disk" | "db" | "gitops";

export interface Scenario {
  id: string;
  orgId: string;
  path: string;
  scenarioHash: string;
  name: string;
  tags: string[];
  source: ScenarioSource;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export type RunTriggeredBy = "cli" | "api" | "deployment" | "schedule";

export interface Run {
  id: string;
  orgId: string;
  scenarioId: string;
  targetId: string | null;
  triggeredBy: RunTriggeredBy;
  envelopeBlobUri: string | null;
  result: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

// ── Promotion policies + approvals (v0.4.0-1) ───────────────────────

export type PromotionGateKind = "auto" | "manual" | "time_delay";

export interface PromotionPolicy {
  id: string;
  orgId: string;
  productId: string;
  /** `null` for the initial-tier policy (fires on release-built). */
  sourceTargetId: string | null;
  destTargetId: string;
  gateKind: PromotionGateKind;
  /** Free-form, kind-specific. e.g. `{ delay_seconds: 600 }` for time_delay. */
  gateConfig: Record<string, unknown>;
  active: boolean;
  description: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export type ApprovalStatus = "pending" | "approved" | "rejected" | "auto_approved";

export interface Approval {
  id: string;
  orgId: string;
  policyId: string;
  releaseId: string;
  destTargetId: string;
  status: ApprovalStatus;
  /** Wall-clock at-or-after which `pending` flips to `auto_approved` for `time_delay`. */
  autoApproveAt: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  reason: string | null;
  deployAttemptedAt: string | null;
  /** 'success' / 'failed' / null. */
  deployOutcome: string | null;
  deployDeploymentId: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

// ── Webhook subscriptions (v0.4.0-2) ────────────────────────────────

export type WebhookKind = "generic" | "slack" | "email";

/**
 * Persisted webhook subscription. `eventKinds` is the wishlist of
 * event kinds this subscription wants delivered; an empty array means
 * "all kinds" (matches principle of least surprise — a fresh
 * subscription gets everything until the operator narrows it).
 *
 * `secretHmacKey` is meaningful only for `kind='generic'`; Slack and
 * email drivers ignore it.
 */
export interface WebhookSubscription {
  id: string;
  orgId: string;
  kind: WebhookKind;
  url: string;
  secretHmacKey: string | null;
  eventKinds: string[];
  active: boolean;
  description: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

// ── Health schedules (v0.4.0-3) ─────────────────────────────────────

/**
 * Periodic re-run of the existing `health check` verb against a
 * target's active deployment, without an operator triggering it. See
 * docs/design/meta-build-system.md §12 (v0.4 phasing) and migration
 * 0060_health_schedule.sql.
 *
 * `probeNames` is a list of probe names from the target's active
 * release's signalman.build.yaml. An empty array means "all declared
 * probes" — matches the CLI's `health check` default behaviour.
 *
 * `intervalSeconds` is the minimum gap between runs. The scheduler
 * wakes once per minute and runs everything whose `lastRunAt + intervalSeconds`
 * is in the past (or which has never run). Lower bound is 60 seconds
 * (enforced at the schema level) so a runaway schedule can't flood the
 * health surface.
 */
export interface HealthSchedule {
  id: string;
  orgId: string;
  targetId: string;
  intervalSeconds: number;
  probeNames: string[];
  lastRunAt: string | null;
  active: boolean;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

// ── Jobs (PR 8 — submit-mode runner queue) ──────────────────────────

export type JobStatus =
  | "pending"
  | "claimed"
  | "running"
  | "succeeded"
  | "failed";

export interface Job {
  id: string;
  orgId: string;
  /** Free-form kind (e.g. `noop`, `release.build`). Worker dispatches on this. */
  kind: string;
  /** Parsed job input. Worker schema-validates per `kind`. */
  input: Record<string, unknown>;
  status: JobStatus;
  result: Record<string, unknown> | null;
  error: string | null;
  /** Identity of the runner that claimed the job (worker name or hostname). */
  claimedBy: string | null;
  claimedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

// ── Runners (WS6 M3 — explicit registration + heartbeat) ────────────

/**
 * Registered build runner. Workers POST `/v1/runners/heartbeat` on
 * startup and every `--heartbeat-interval-ms` (default 30000ms); the
 * row's `last_seen_at` is updated each time. Operators see "is this
 * worker alive" via `signalman runner list`, which computes a
 * derived `isStale` flag at read time from `last_seen_at` + a
 * threshold (default 90s).
 *
 * Deregistration is a soft-delete (`deleted_at IS NOT NULL`). A
 * deregistered runner's row is preserved for audit; re-registering
 * under the same name spawns a fresh row.
 */
export interface Runner {
  id: string;
  orgId: string;
  /** Worker name (e.g. `builder-mac-01`). Unique per active row. */
  name: string;
  /** ISO-8601 of the most recent heartbeat. */
  lastSeenAt: string;
  /** ISO-8601 of the first heartbeat that created this row. */
  registeredAt: string;
  /** Free-form JSON: hostname, version, etc. Diagnostic only. */
  meta: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

// ── Audit log ───────────────────────────────────────────────────────

export interface AuditLogEntry {
  id: string;
  orgId: string;
  actor: string;
  action: string;
  entityType: string;
  entityId: string;
  detail: Record<string, unknown> | null;
  at: string;
  createdAt: string;
}

// ── Cloud cost guardrails (v0.3.0-5 sub-task 5) ─────────────────────

/**
 * Per-org monthly spend cap. Absence = no budget = unlimited
 * (back-compat for existing orgs). The budget gate is consulted
 * on provisionInstance: usage >= 100% throws `budget_exceeded`;
 * usage >= softWarnPct returns `warned: true` so the caller can
 * surface the warning.
 */
export interface CloudOrgBudget {
  orgId: string;
  monthlyCentsLimit: number;
  softWarnPct: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * One row per provisioned instance recording the estimated
 * cost. `estimatedCents` is computed at provision time from a
 * static SKU × region cost table (see `host/src/cloud/cost.ts`);
 * acceptable starting point per design §13.5 "naive at first".
 * `terminatedAt` is updated when the instance is reaped /
 * terminated; this lets the cost reaper retroactively narrow the
 * estimate to actual lifetime in followup work.
 */
export interface CloudOrgUsage {
  id: string;
  orgId: string;
  backend: string;
  instanceId: string;
  instanceType: string;
  region: string;
  startedAt: string;
  terminatedAt: string | null;
  estimatedCents: number;
}

/**
 * Per-org cloud credential stored encrypted at rest
 * (v0.3.0-5 sub-task 6, design §13.7).
 *
 * The `ciphertextB64` field holds the base64-encoded AES-GCM
 * blob (iv || ciphertext || auth_tag). Decryption is in
 * `host/src/cloud/credentials.ts`; callers should NEVER pass
 * the raw `ciphertextB64` to anything other than the decrypter.
 *
 * `redactedHint` is the safe-to-display short string — operators
 * see this in `signalman cloud creds get` / `signalman_creds_get`
 * to confirm "yes, that's the right key without leaking the
 * secret".
 */
export interface CloudOrgCredential {
  id: string;
  orgId: string;
  backend: string;
  ciphertextB64: string;
  encryptionMethod: string;
  redactedHint: string;
  createdAt: string;
  updatedAt: string;
}
