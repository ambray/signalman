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
  signedBy: string | null;
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

export type TargetKind = "vm_test" | "vm_demo" | "docker_test" | "docker_demo";

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
