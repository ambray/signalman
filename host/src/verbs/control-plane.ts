/**
 * Shared helpers + verb implementations for control-plane verbs.
 *
 * Two layers:
 *   * `withControlPlane(fn)` — lifecycle wrapper: load config, build
 *     ControlPlane, init() it, run fn, close. Each CLI verb invokes
 *     this once.
 *   * Verb-level functions (`runProductAdd`, `runProductList`, etc.) —
 *     pure functions that take a ControlPlane + typed params and
 *     return typed results. These are the same functions both the CLI
 *     and the MCP server call.
 *
 * The verb functions deliberately do not import `process.stderr` /
 * `process.stdout` — formatting is the caller's job. The MCP path
 * returns JSON; the CLI path either prints JSON or a human summary
 * depending on `--format`.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ControlPlane } from "../control-plane/index.js";
import {
  buildManifest,
  hashManifest,
  runBuild,
  verifyManifest,
  type RunBuildResult,
} from "../control-plane/build/index.js";
import {
  cloneProductAtTag,
  resolveCommitSha,
} from "../control-plane/build/git.js";
import {
  type DeployBackend,
  HypervisorDeployBackend,
  runDeploy,
  runRollback,
  type RunDeployResult,
} from "../control-plane/deploy/index.js";
import { validateBuildYaml, type BuildYaml, type Probe } from "../control-plane/build/yaml.js";
import { runProbes, type ProbeResult } from "../control-plane/probes/index.js";
import { loadConfig } from "../config.js";
import type {
  Approval,
  Artifact,
  AuditLogEntry,
  Deployment,
  DeploymentHealthSummary,
  HealthCheck,
  HealthSchedule,
  Product,
  PromotionGateKind,
  PromotionPolicy,
  Release,
  Target,
  TargetConnection,
  TargetKind,
  WebhookKind,
  WebhookSubscription,
} from "../control-plane/types.js";
import type { ProbeInvoker, ScheduledProbeOutcome } from "../control-plane/scheduler/index.js";
import {
  EventDispatcher,
  type DispatchResult,
  type EmailSender,
  type HttpFetcher,
  type SignalmanEvent,
} from "../control-plane/events/index.js";
import {
  onReleaseBuilt,
  onReleaseDeployed,
  runPromotionTick,
  type DeployInvoker,
  type PromotionListenerOutcome,
} from "../control-plane/promotion/index.js";

// ── Lifecycle helper ────────────────────────────────────────────────

/**
 * Build + init a ControlPlane for the duration of `fn`, then close.
 * Resolves config from disk (same precedence as the rest of the CLI).
 */
export async function withControlPlane<T>(
  fn: (cp: ControlPlane) => Promise<T>,
): Promise<T> {
  const config = loadConfig();
  const controlPlane = ControlPlane.fromConfig(config.controlPlane);
  try {
    await controlPlane.init();
    return await fn(controlPlane);
  } finally {
    await controlPlane.close();
  }
}

// ── Org context ─────────────────────────────────────────────────────

/**
 * v0.2.0 (local mode) pins to the default org. The function exists so
 * that v0.3.0+ can introduce real org switching without rewriting every
 * verb call site.
 */
async function getActiveOrgId(controlPlane: ControlPlane): Promise<string> {
  const { defaultOrg } = await controlPlane.init();
  return defaultOrg.id;
}

// ── Product verbs ───────────────────────────────────────────────────

export interface ProductAddInput {
  name: string;
  repoUrl: string;
  buildYamlPath?: string;
}

export async function runProductAdd(
  controlPlane: ControlPlane,
  input: ProductAddInput,
): Promise<Product> {
  const orgId = await getActiveOrgId(controlPlane);
  const product = await controlPlane.products.create({
    orgId,
    name: input.name,
    repoUrl: input.repoUrl,
    buildYamlPath: input.buildYamlPath,
  });
  await controlPlane.auditLog.append({
    orgId,
    actor: "cli",
    action: "product.added",
    entityType: "product",
    entityId: product.id,
    detail: { name: product.name, repoUrl: product.repoUrl },
  });
  return product;
}

export async function runProductList(
  controlPlane: ControlPlane,
): Promise<Product[]> {
  const orgId = await getActiveOrgId(controlPlane);
  return controlPlane.products.listForOrg(orgId);
}

export async function runProductRemove(
  controlPlane: ControlPlane,
  input: { name: string },
): Promise<void> {
  const orgId = await getActiveOrgId(controlPlane);
  const existing = await controlPlane.products.getByName(orgId, input.name);
  if (!existing) {
    throw new Error(`product not found: ${input.name}`);
  }
  await controlPlane.products.softDelete(existing.id);
  await controlPlane.auditLog.append({
    orgId,
    actor: "cli",
    action: "product.removed",
    entityType: "product",
    entityId: existing.id,
    detail: { name: existing.name },
  });
}

// ── Release verbs ───────────────────────────────────────────────────

export interface ReleaseBuildInput {
  productName: string;
  tag: string;
  /**
   * Optional pre-cloned source tree. If omitted, the executor clones
   * `product.repoUrl` at `tag` into a temp dir.
   */
  workDir?: string;
  /**
   * Optional explicit commit SHA. When omitted (the normal path), the
   * verb runs `git rev-parse HEAD` in `workDir`. Useful for tests and
   * for upstream tools that already know the SHA and don't want a
   * dependency on the working tree being a git repo.
   */
  commitSha?: string;
  /** Optional override for the runner identifier (default: hostname:pid). */
  runnerId?: string;
  /** Audit-log actor (default: 'cli'). */
  actor?: string;
  /**
   * Optional PEM-encoded Ed25519 private key for manifest signing
   * (PR 10a). When supplied, the release row records the signature +
   * fingerprint. Verifiers use `signalman release verify --public-key`.
   */
  signingKeyPem?: string;
}

export async function runReleaseBuild(
  controlPlane: ControlPlane,
  input: ReleaseBuildInput,
  options: { out?: NodeJS.WritableStream } = {},
): Promise<RunBuildResult> {
  const orgId = await getActiveOrgId(controlPlane);
  const product = await controlPlane.products.getByName(orgId, input.productName);
  if (!product) {
    throw new Error(`product not found: ${input.productName}`);
  }

  // Resolve workDir + commitSha. Either the caller pre-cloned and
  // pointed us at a tree, or we clone fresh into a temp dir.
  let workDir: string;
  let cleanup: (() => Promise<void>) | undefined;
  if (input.workDir) {
    workDir = path.resolve(input.workDir);
  } else {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "signalman-build-"));
    workDir = tmp;
    cleanup = async () => {
      await fs.rm(tmp, { recursive: true, force: true });
    };
    await cloneProductAtTag({
      repoUrl: product.repoUrl,
      tag: input.tag,
      destDir: tmp,
      out: options.out ?? process.stderr,
    });
  }

  try {
    const commitSha = input.commitSha ?? (await resolveCommitSha(workDir));
    const result = await runBuild({
      controlPlane,
      orgId,
      productId: product.id,
      tag: input.tag,
      commitSha,
      workDir,
      runnerId: input.runnerId,
      actor: input.actor,
      out: options.out,
      signingKeyPem: input.signingKeyPem,
    });
    if (result.release.status === "ready") {
      await fireEventBestEffort(controlPlane, {
        kind: "release-built",
        orgId,
        at: new Date().toISOString(),
        releaseId: result.release.id,
        productName: product.name,
        tag: result.release.tag,
        manifestSha256: result.release.manifestSha256,
      });
      // Fire the auto-promotion listener — best effort so a failing
      // promotion policy can't block the build from landing as ready.
      await firePromotionListenerBestEffort(controlPlane, result.release);
    }
    return result;
  } finally {
    if (cleanup) await cleanup();
  }
}

async function firePromotionListenerBestEffort(
  controlPlane: ControlPlane,
  release: Release,
): Promise<PromotionListenerOutcome[]> {
  try {
    const deploy = createDefaultPromotionDeployInvoker(controlPlane);
    return await onReleaseBuilt({ controlPlane, deploy }, release);
  } catch (err) {
    process.stderr.write(
      JSON.stringify({
        source: "signalman-promotion",
        kind: "listener-error",
        releaseId: release.id,
        error: (err as Error).message,
      }) + "\n",
    );
    return [];
  }
}

export interface ReleaseListInput {
  productName?: string;
  status?: "building" | "ready" | "failed";
}

export interface ReleaseListEntry {
  release: Release;
  product: Product;
}

export async function runReleaseList(
  controlPlane: ControlPlane,
  input: ReleaseListInput,
): Promise<ReleaseListEntry[]> {
  const orgId = await getActiveOrgId(controlPlane);
  const products = await controlPlane.products.listForOrg(orgId);
  const wantProduct = input.productName;
  const out: ReleaseListEntry[] = [];
  for (const product of products) {
    if (wantProduct && product.name !== wantProduct) continue;
    const releases = await controlPlane.releases.listForProduct(product.id, {
      status: input.status,
    });
    for (const r of releases) out.push({ product, release: r });
  }
  return out;
}

export interface ReleaseShowResult {
  release: Release;
  product: Product;
  artifacts: Artifact[];
  /** v0.4.0-1: attached promotion approvals across all dest targets. */
  approvals?: Array<{
    id: string;
    policyId: string;
    destTargetId: string;
    destTargetName: string | null;
    status: Approval["status"];
    autoApproveAt: string | null;
    decidedBy: string | null;
    decidedAt: string | null;
    deployOutcome: string | null;
    deployDeploymentId: string | null;
  }>;
}

export interface ReleaseVerifyResult {
  release: Release;
  product: Product;
  /** True when (manifestSha256, signatureB64, signedBy) verify against publicKeyPem. */
  verified: boolean;
  reason?: string;
}

/**
 * Verify a release's signature against an operator-supplied public
 * key. Reconstructs the canonical manifest from the release +
 * artifact rows (the same shape the build executor signed), then
 * checks the stored signature.
 */
export async function runReleaseVerify(
  controlPlane: ControlPlane,
  input: { releaseId: string; publicKeyPem: string },
): Promise<ReleaseVerifyResult> {
  const release = await controlPlane.releases.get(input.releaseId);
  if (!release) throw new Error(`release not found: ${input.releaseId}`);
  const product = await controlPlane.products.get(release.productId);
  if (!product) {
    throw new Error(
      `release ${input.releaseId} references a missing product (${release.productId})`,
    );
  }
  if (!release.signatureB64 || !release.signedBy) {
    return {
      release,
      product,
      verified: false,
      reason: "release is unsigned (no signature_b64 / signed_by on the row)",
    };
  }
  const artifacts = await controlPlane.artifacts.listForRelease(release.id);
  const manifest = buildManifest({
    product: product.name,
    tag: release.tag,
    commitSha: release.commitSha,
    entries: artifacts.map((a) =>
      a.kind === "blob"
        ? { component: a.component, kind: "blob" as const, sha256: a.sha256 ?? undefined }
        : { component: a.component, kind: "image_ref" as const, image_ref: a.imageRef ?? undefined },
    ),
  });
  // Belt-and-suspenders: confirm our reconstruction matches the
  // stored manifest hash before we run crypto.verify on it.
  const reconstructedHash = hashManifest(manifest);
  if (
    release.manifestSha256 !== null &&
    reconstructedHash !== release.manifestSha256
  ) {
    return {
      release,
      product,
      verified: false,
      reason: `manifest reconstruction mismatch — stored ${release.manifestSha256}, reconstructed ${reconstructedHash}. The catalog may have been tampered with between build and verify.`,
    };
  }
  try {
    verifyManifest(
      manifest,
      release.signatureB64,
      release.signedBy,
      input.publicKeyPem,
    );
    return { release, product, verified: true };
  } catch (err) {
    return {
      release,
      product,
      verified: false,
      reason: (err as Error).message,
    };
  }
}

export async function runReleaseShow(
  controlPlane: ControlPlane,
  input: { releaseId: string },
): Promise<ReleaseShowResult> {
  const release = await controlPlane.releases.get(input.releaseId);
  if (!release) {
    throw new Error(`release not found: ${input.releaseId}`);
  }
  const product = await controlPlane.products.get(release.productId);
  if (!product) {
    // Shouldn't happen — product FK is constrained. Treat as "deleted
    // product" which is currently impossible since soft-delete doesn't
    // cascade. If we hit it, surface as missing rather than crash.
    throw new Error(
      `release ${input.releaseId} references a missing product (${release.productId})`,
    );
  }
  const artifacts = await controlPlane.artifacts.listForRelease(release.id);
  const approvals = await runReleasePromotionState(controlPlane, {
    releaseId: release.id,
  });
  const approvalSummary = approvals.map((entry) => ({
    id: entry.approval.id,
    policyId: entry.approval.policyId,
    destTargetId: entry.approval.destTargetId,
    destTargetName: entry.destTarget?.name ?? null,
    status: entry.approval.status,
    autoApproveAt: entry.approval.autoApproveAt,
    decidedBy: entry.approval.decidedBy,
    decidedAt: entry.approval.decidedAt,
    deployOutcome: entry.approval.deployOutcome,
    deployDeploymentId: entry.approval.deployDeploymentId,
  }));
  return { release, product, artifacts, approvals: approvalSummary };
}

// Git helpers extracted to control-plane/build/git.ts (PR 8b) so the
// remote runner can share them.

// ── Target verbs (PR 3) ─────────────────────────────────────────────

export interface TargetAddInput {
  name: string;
  kind: TargetKind;
  connection: TargetConnection;
}

export async function runTargetAdd(
  controlPlane: ControlPlane,
  input: TargetAddInput,
): Promise<Target> {
  const orgId = await getActiveOrgId(controlPlane);
  const target = await controlPlane.targets.create({
    orgId,
    name: input.name,
    kind: input.kind,
    connection: input.connection,
  });
  await controlPlane.auditLog.append({
    orgId,
    actor: "cli",
    action: "target.added",
    entityType: "target",
    entityId: target.id,
    detail: { name: target.name, kind: target.kind },
  });
  return target;
}

export async function runTargetList(controlPlane: ControlPlane): Promise<Target[]> {
  const orgId = await getActiveOrgId(controlPlane);
  return controlPlane.targets.listForOrg(orgId);
}

export async function runTargetRemove(
  controlPlane: ControlPlane,
  input: { name: string },
): Promise<void> {
  const orgId = await getActiveOrgId(controlPlane);
  const existing = await controlPlane.targets.getByName(orgId, input.name);
  if (!existing) throw new Error(`target not found: ${input.name}`);
  await controlPlane.targets.softDelete(existing.id);
  await controlPlane.auditLog.append({
    orgId,
    actor: "cli",
    action: "target.removed",
    entityType: "target",
    entityId: existing.id,
    detail: { name: existing.name },
  });
}

/**
 * Edit an existing target's name and/or connection. WS6 M3
 * operator-authorised closure of the P3 "no target edit verb"
 * gap.
 *
 * Editable fields: `name`, `connection`. The `kind` field is
 * deliberately NOT editable — past deployments reference the
 * target by id and route through the deploy backend that matches
 * `kind`; mid-life kind changes would invalidate that assumption.
 * For a kind change, operators still use `remove` + re-`add`.
 *
 * Past deployments are NOT updated by this method. Rollback and
 * health-check operations against this target will use the *new*
 * connection — which is the right semantic ("the target lives
 * here now"), distinct from "rewrite history."
 *
 * @throws if `input.name` doesn't match an active target
 * @throws if neither `newName` nor `newConnection` is supplied
 *   (a no-op edit is treated as an operator mistake)
 */
// ── WS6 M3 — runner list + deregister ───────────────────────────────

/**
 * One row from `runner list` — the raw Runner plus a computed
 * `isStale` flag based on the request's threshold.
 */
export interface RunnerListEntry {
  runner: import("../control-plane/types.js").Runner;
  isStale: boolean;
}

/**
 * WS6 M3 — list registered build runners, newest-`last_seen_at`
 * first. Workers POST heartbeats every `--heartbeat-interval-ms`
 * (default 30s); rows whose `last_seen_at` is older than the
 * `staleThresholdSeconds` (default 90s) are flagged `isStale: true`.
 *
 * Caveat: the threshold is purely advisory — the row stays in the
 * list with `isStale: true` so operators can see "this worker was
 * here recently and stopped." Use `runRunnerDeregister` to actually
 * remove a dead runner.
 */
export async function runRunnerList(
  controlPlane: ControlPlane,
  opts?: { staleThresholdSeconds?: number },
): Promise<RunnerListEntry[]> {
  const orgId = await getActiveOrgId(controlPlane);
  const threshold = opts?.staleThresholdSeconds ?? 90;
  const cutoffMs = Date.now() - threshold * 1000;
  const rows = await controlPlane.runners.listForOrg(orgId);
  return rows.map((runner) => ({
    runner,
    isStale: new Date(runner.lastSeenAt).getTime() < cutoffMs,
  }));
}

/**
 * WS6 M3 — soft-delete a registered runner. Identified by either
 * name (preferred for operator use) or id (preferred for
 * automation). The row is preserved for audit; a worker that
 * heartbeats again under the same name will resurrect the row.
 *
 * @throws if neither `name` nor `id` is supplied
 * @throws if the runner doesn't exist (active) under the supplied
 *   key
 */
export async function runRunnerDeregister(
  controlPlane: ControlPlane,
  input: { name?: string; id?: string },
): Promise<{ id: string; name: string }> {
  if (input.name === undefined && input.id === undefined) {
    throw new Error(
      "runner deregister requires --name or --id (got neither)",
    );
  }
  const orgId = await getActiveOrgId(controlPlane);
  const target =
    input.id !== undefined
      ? await controlPlane.runners.get(input.id)
      : await controlPlane.runners.getByName(orgId, input.name!);
  if (!target) {
    const key = input.id !== undefined ? `id=${input.id}` : `name=${input.name}`;
    throw new Error(`runner not found: ${key}`);
  }
  if (target.orgId !== orgId) {
    throw new Error(`runner ${target.id} belongs to a different org`);
  }
  await controlPlane.runners.softDelete(target.id);
  await controlPlane.auditLog.append({
    orgId,
    actor: "cli",
    action: "runner.deregistered",
    entityType: "runner",
    entityId: target.id,
    detail: { name: target.name },
  });
  return { id: target.id, name: target.name };
}

export async function runTargetEdit(
  controlPlane: ControlPlane,
  input: {
    name: string;
    newName?: string;
    newConnection?: Record<string, unknown>;
  },
): Promise<Target> {
  if (
    input.newName === undefined &&
    input.newConnection === undefined
  ) {
    throw new Error(
      "target edit requires at least one of --new-name or --connection",
    );
  }
  const orgId = await getActiveOrgId(controlPlane);
  const existing = await controlPlane.targets.getByName(orgId, input.name);
  if (!existing) throw new Error(`target not found: ${input.name}`);
  const patch: Partial<Pick<Target, "name" | "connection">> = {};
  if (input.newName !== undefined) patch.name = input.newName;
  if (input.newConnection !== undefined) patch.connection = input.newConnection;
  const updated = await controlPlane.targets.update(existing.id, patch);
  await controlPlane.auditLog.append({
    orgId,
    actor: "cli",
    action: "target.edited",
    entityType: "target",
    entityId: existing.id,
    detail: {
      before: { name: existing.name, connection: existing.connection },
      after: { name: updated.name, connection: updated.connection },
    },
  });
  return updated;
}

// ── WS6 M5 — audit log verbs (P2 closure) ──────────────────────────
//
// The audit log has lived behind HTTP-only routes (GET /v1/audit,
// POST /v1/audit) since v0.2.0. Operators couldn't answer "what
// happened to deployment X" without curl-ing the HTTP API. M5
// surfaces the same read + append paths as CLI verbs + MCP tools
// without changing the underlying storage shape.

export interface AuditQueryInput {
  /** ISO-8601 lower bound on createdAt. Returned entries are newest-first; rows older than this are dropped. */
  since?: string;
  /** Filter by exact entity_type (e.g. "target", "release", "runner"). */
  entityType?: string;
  /** Filter by exact entity_id. */
  entityId?: string;
  /** Filter by exact actor (e.g. "cli", "ci"). */
  actor?: string;
  /** Filter by exact action (e.g. "target.edited", "release.deploy"). */
  action?: string;
  /** Max entries to return. Default unbounded; the repo respects this for performance. */
  limit?: number;
}

/**
 * WS6 M5 — list audit-log entries for the active org, newest first.
 *
 * The repo layer supports entityType + entityId + limit natively;
 * actor + action + since filters are applied at the verb layer
 * (post-filter, since the storage interface doesn't yet index on
 * them). For high-volume audit queries the operator should
 * narrow with entity_type or entity_id first.
 */
export async function runAuditQuery(
  controlPlane: ControlPlane,
  input: AuditQueryInput = {},
): Promise<AuditLogEntry[]> {
  const orgId = await getActiveOrgId(controlPlane);
  // Repo handles entityType + entityId + limit; we apply the rest
  // on the returned rows.
  const repoLimit = input.limit;
  let entries = await controlPlane.auditLog.listForOrg(orgId, {
    entityType: input.entityType,
    entityId: input.entityId,
    limit: repoLimit,
  });
  if (input.actor !== undefined) {
    entries = entries.filter((e) => e.actor === input.actor);
  }
  if (input.action !== undefined) {
    entries = entries.filter((e) => e.action === input.action);
  }
  if (input.since !== undefined) {
    const sinceMs = Date.parse(input.since);
    if (Number.isNaN(sinceMs)) {
      throw new Error(`audit query: --since must be ISO-8601 (got '${input.since}')`);
    }
    entries = entries.filter((e) => Date.parse(e.createdAt) >= sinceMs);
  }
  return entries;
}

export interface AuditAppendInput {
  actor: string;
  action: string;
  entityType: string;
  entityId: string;
  detail?: Record<string, unknown>;
}

/**
 * WS6 M5 — append a new audit-log entry. Audit log is immutable —
 * there is no update or delete; the repo's append is the only
 * write path.
 *
 * Operator-driven appends complement the executor-driven appends
 * (build / deploy / target edit / runner deregister auto-emit).
 * Useful for: documenting an out-of-band gesture ("manually
 * restarted target X"), recording a postmortem decision, etc.
 */
export async function runAuditAppend(
  controlPlane: ControlPlane,
  input: AuditAppendInput,
): Promise<AuditLogEntry> {
  if (input.actor.length === 0) throw new Error("audit append: actor must be non-empty");
  if (input.action.length === 0) throw new Error("audit append: action must be non-empty");
  if (input.entityType.length === 0) throw new Error("audit append: entity_type must be non-empty");
  if (input.entityId.length === 0) throw new Error("audit append: entity_id must be non-empty");
  const orgId = await getActiveOrgId(controlPlane);
  return controlPlane.auditLog.append({
    orgId,
    actor: input.actor,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId,
    detail: input.detail,
  });
}

// ── Release deploy / rollback verbs (PR 3) ──────────────────────────

export interface ReleaseDeployInput {
  /** Either releaseId, or (productName + tag) to resolve a release. */
  releaseId?: string;
  productName?: string;
  tag?: string;
  targetName: string;
  actor?: string;
}

async function defaultDeployBackend(): Promise<DeployBackend> {
  const { selectBackend } = await import("../hypervisors/selector.js");
  const config = loadConfig();
  const hyp = await selectBackend(config);
  return new HypervisorDeployBackend(hyp);
}

/**
 * True when a target kind is one of the Kubernetes-routed kinds.
 * Used by {@link runReleaseDeploy} / {@link runReleaseRollback} to
 * dispatch away from the hypervisor backend.
 */
function isK8sTargetKind(kind: TargetKind): boolean {
  return kind === "k8s_test" || kind === "k8s_demo";
}

/**
 * WS6 M8: true when a target kind is one of the cloud-routed kinds.
 * Used by {@link runReleaseDeploy} to dispatch away from both the
 * hypervisor backend and the k8s driver. Each cloud kind has its own
 * adapter (`runCloudVmReleaseDeploy` / `runCloudStackReleaseDeploy`).
 */
function isCloudTargetKind(kind: TargetKind): boolean {
  return kind === "cloud_vm" || kind === "cloud_stack";
}

export async function runReleaseDeploy(
  controlPlane: ControlPlane,
  input: ReleaseDeployInput,
  options: { backend?: DeployBackend; out?: NodeJS.WritableStream } = {},
): Promise<RunDeployResult> {
  const orgId = await getActiveOrgId(controlPlane);

  // Resolve the release.
  let releaseId = input.releaseId;
  if (!releaseId) {
    if (!input.productName || !input.tag) {
      throw new Error(
        "release deploy requires either --release <id> or --product <name> + --tag <tag>",
      );
    }
    const product = await controlPlane.products.getByName(orgId, input.productName);
    if (!product) throw new Error(`product not found: ${input.productName}`);
    const release = await controlPlane.releases.getByTag(product.id, input.tag);
    if (!release) {
      throw new Error(`no release for ${input.productName}@${input.tag}`);
    }
    releaseId = release.id;
  }

  const target = await controlPlane.targets.getByName(orgId, input.targetName);
  if (!target) throw new Error(`target not found: ${input.targetName}`);

  // Kubernetes targets route to the K8s driver path. The VM-backed
  // hypervisor backend (checkpoints + staging + reachability) does
  // not apply.
  if (isK8sTargetKind(target.kind)) {
    return runK8sReleaseDeploy(controlPlane, {
      orgId,
      releaseId,
      target,
      actor: input.actor,
      out: options.out,
    });
  }

  // WS6 M8: cloud_vm + cloud_stack route to the cloud adapters.
  if (isCloudTargetKind(target.kind)) {
    const result = await runCloudReleaseDeploy(controlPlane, {
      orgId,
      releaseId,
      target,
      actor: input.actor,
      out: options.out,
    });
    await fireEventBestEffort(controlPlane, {
      kind: "release-deployed",
      orgId,
      at: new Date().toISOString(),
      deploymentId: result.deployment.id,
      releaseId: result.release.id,
      targetName: result.target.name,
      status: result.deployment.status,
      healthSummary: {
        total: result.healthSummary.total,
        pass: result.healthSummary.pass,
        fail: result.healthSummary.fail,
      },
    });
    if (result.deployment.status === "active") {
      await fireTierToTierPromotionBestEffort(controlPlane, result.release, target.id);
    }
    return result;
  }

  const backend = options.backend ?? (await defaultDeployBackend());
  const result = await runDeploy({
    controlPlane,
    orgId,
    releaseId,
    targetId: target.id,
    backend,
    actor: input.actor,
    out: options.out,
  });
  await fireEventBestEffort(controlPlane, {
    kind: "release-deployed",
    orgId,
    at: new Date().toISOString(),
    deploymentId: result.deployment.id,
    releaseId: result.release.id,
    targetName: result.target.name,
    status: result.deployment.status,
    healthSummary: {
      total: result.healthSummary.total,
      pass: result.healthSummary.pass,
      fail: result.healthSummary.fail,
    },
  });
  // Tier-to-tier promotion: only fire when the deploy lands as
  // active (health probes passed). Failed / rolled-back / pending
  // deploys must NOT trigger downstream promotion — the source tier
  // hasn't been verified. Promotion is intentionally NOT fired by
  // rollback paths (per operator policy: rollback is recovery, not
  // a promotion event).
  if (result.deployment.status === "active") {
    await fireTierToTierPromotionBestEffort(controlPlane, result.release, target.id);
  }
  return result;
}

async function fireTierToTierPromotionBestEffort(
  controlPlane: ControlPlane,
  release: Release,
  sourceTargetId: string,
): Promise<PromotionListenerOutcome[]> {
  try {
    const deploy = createDefaultPromotionDeployInvoker(controlPlane);
    return await onReleaseDeployed(
      { controlPlane, deploy },
      release,
      sourceTargetId,
    );
  } catch (err) {
    process.stderr.write(
      JSON.stringify({
        source: "signalman-promotion",
        kind: "tier-listener-error",
        releaseId: release.id,
        sourceTargetId,
        error: (err as Error).message,
      }) + "\n",
    );
    return [];
  }
}

export interface ReleaseRollbackInput {
  targetName: string;
  toReleaseId?: string;
  actor?: string;
}

export async function runReleaseRollback(
  controlPlane: ControlPlane,
  input: ReleaseRollbackInput,
  options: { backend?: DeployBackend; out?: NodeJS.WritableStream } = {},
): Promise<RunDeployResult> {
  const orgId = await getActiveOrgId(controlPlane);
  const target = await controlPlane.targets.getByName(orgId, input.targetName);
  if (!target) throw new Error(`target not found: ${input.targetName}`);

  if (isK8sTargetKind(target.kind)) {
    return runK8sReleaseRollback(controlPlane, {
      orgId,
      target,
      toReleaseId: input.toReleaseId,
      actor: input.actor,
      out: options.out,
    });
  }

  // WS6 M8: cloud rollback semantics differ enough by kind that we
  // intentionally do not auto-route. `cloud_stack` would need to
  // re-apply the previous-release vars (operator can drive
  // `signalman release deploy --release <prior>` instead), and
  // `cloud_vm` rollback would require the same reachability + re-
  // install dance as deploy. Rolling these in scope-creeps M8 past
  // the deploy story; refuse explicitly so the operator gets a
  // clear pointer to the supported workflow.
  if (isCloudTargetKind(target.kind)) {
    throw new Error(
      `release rollback against ${target.kind} targets is not yet supported. ` +
        `Re-deploy the prior release with 'signalman release deploy ` +
        `--release <prior-release-id> --target ${target.name}' instead. ` +
        `Tracked for a future milestone.`,
    );
  }

  const backend = options.backend ?? (await defaultDeployBackend());
  const result = await runRollback({
    controlPlane,
    orgId,
    targetId: target.id,
    toReleaseId: input.toReleaseId,
    backend,
    actor: input.actor,
    out: options.out,
  });
  await fireEventBestEffort(controlPlane, {
    kind: "deployment-rolled-back",
    orgId,
    at: new Date().toISOString(),
    deploymentId: result.deployment.id,
    releaseId: result.release.id,
    targetName: result.target.name,
  });
  return result;
}

// ── Deployment + health query verbs (PR 3 read surface) ─────────────

export interface DeploymentListEntry {
  deployment: Deployment;
  release: Release;
  target: Target;
}

export async function runDeploymentList(
  controlPlane: ControlPlane,
  input: { targetName?: string } = {},
): Promise<DeploymentListEntry[]> {
  const orgId = await getActiveOrgId(controlPlane);
  const targets = input.targetName
    ? [await controlPlane.targets.getByName(orgId, input.targetName)].filter(
        (t): t is Target => t !== null,
      )
    : await controlPlane.targets.listForOrg(orgId);

  const out: DeploymentListEntry[] = [];
  for (const target of targets) {
    const deployments = await controlPlane.deployments.listForTarget(target.id);
    for (const deployment of deployments) {
      const release = await controlPlane.releases.get(deployment.releaseId);
      if (!release) continue;
      out.push({ deployment, release, target });
    }
  }
  return out;
}

export interface DeploymentShowResult {
  deployment: Deployment;
  release: Release;
  target: Target;
  health: HealthCheck[];
}

export async function runDeploymentShow(
  controlPlane: ControlPlane,
  input: { deploymentId: string },
): Promise<DeploymentShowResult> {
  const deployment = await controlPlane.deployments.get(input.deploymentId);
  if (!deployment) throw new Error(`deployment not found: ${input.deploymentId}`);
  const release = await controlPlane.releases.get(deployment.releaseId);
  if (!release) throw new Error(`deployment references missing release: ${deployment.releaseId}`);
  const target = await controlPlane.targets.get(deployment.targetId);
  if (!target) throw new Error(`deployment references missing target: ${deployment.targetId}`);
  const health = await controlPlane.healthChecks.listForDeployment(deployment.id);
  return { deployment, release, target, health };
}

// ── Health verbs (PR 4) ─────────────────────────────────────────────

export interface HealthCheckRunInput {
  targetName: string;
  /** Filter to a subset of probes by name. Default: run all declared. */
  probeNames?: string[];
  /** Override release; default: the target's current active deployment's release. */
  releaseId?: string;
  actor?: string;
}

export interface HealthCheckRunResult {
  target: Target;
  release: Release;
  deploymentId: string | null;
  reachability: { reachable: boolean; detail?: string };
  probes: ProbeResult[];
}

export async function runHealthCheck(
  controlPlane: ControlPlane,
  input: HealthCheckRunInput,
  options: { backend?: DeployBackend; out?: NodeJS.WritableStream } = {},
): Promise<HealthCheckRunResult> {
  const orgId = await getActiveOrgId(controlPlane);
  const out = options.out ?? process.stderr;

  const target = await controlPlane.targets.getByName(orgId, input.targetName);
  if (!target) throw new Error(`target not found: ${input.targetName}`);

  // Resolve the release we're probing: explicit override, or the
  // target's current active deployment's release.
  let release: Release | null;
  let deploymentId: string | null = null;
  if (input.releaseId) {
    release = await controlPlane.releases.get(input.releaseId);
    if (!release) throw new Error(`release not found: ${input.releaseId}`);
  } else {
    const active = await controlPlane.deployments.getActiveForTarget(target.id);
    if (!active) {
      throw new Error(
        `target '${target.name}' has no active deployment to probe. ` +
          `Use --release to specify an explicit release.`,
      );
    }
    deploymentId = active.id;
    release = await controlPlane.releases.get(active.releaseId);
    if (!release) {
      throw new Error(
        `active deployment ${active.id} references a missing release ${active.releaseId}`,
      );
    }
  }

  // Resolve declared probes (and optional name-filter).
  const allDeclared = parseDeclaredProbesFromRelease(release);
  const probesToRun =
    input.probeNames && input.probeNames.length > 0
      ? allDeclared.filter((p) => input.probeNames!.includes(p.name))
      : allDeclared;

  if (input.probeNames && input.probeNames.length > 0) {
    const missing = input.probeNames.filter(
      (n) => !allDeclared.some((p) => p.name === n),
    );
    if (missing.length > 0) {
      throw new Error(
        `unknown probe name(s) on release ${release.id}: ${missing.join(", ")}`,
      );
    }
  }

  // Backend + VM resolution.
  const backend = options.backend ?? (await defaultDeployBackend());
  const { handle, vmName } = await backend.resolveVm(target.connection);
  out.write(`[health check] target '${target.name}' (VM '${vmName}')\n`);

  const reachability = await backend.isVmReachable(handle);
  const probes = probesToRun.length
    ? await runProbes(probesToRun, handle, backend)
    : [];

  // If we're running against the active deployment, append rows so the
  // history surface shows on-demand runs alongside deploy-time runs.
  if (deploymentId) {
    await controlPlane.healthChecks.append({
      deploymentId,
      probeName: "vm_reachable",
      status: reachability.reachable ? "pass" : "fail",
      detail: reachability.detail,
    });
    for (const r of probes) {
      await controlPlane.healthChecks.append({
        deploymentId,
        probeName: r.name,
        status: r.status,
        latencyMs: r.latencyMs,
        detail: r.detail,
      });
    }
  }

  return { target, release, deploymentId, reachability, probes };
}

export interface HealthHistoryInput {
  targetName: string;
  sinceIso?: string;
  limit?: number;
}

export interface HealthHistoryEntry {
  deployment: Deployment;
  release: Release;
  checks: HealthCheck[];
}

export async function runHealthHistory(
  controlPlane: ControlPlane,
  input: HealthHistoryInput,
): Promise<HealthHistoryEntry[]> {
  const orgId = await getActiveOrgId(controlPlane);
  const target = await controlPlane.targets.getByName(orgId, input.targetName);
  if (!target) throw new Error(`target not found: ${input.targetName}`);

  const deployments = await controlPlane.deployments.listForTarget(target.id, {
    limit: input.limit ?? 20,
  });
  const out: HealthHistoryEntry[] = [];
  for (const deployment of deployments) {
    const release = await controlPlane.releases.get(deployment.releaseId);
    if (!release) continue;
    const checks = await controlPlane.healthChecks.listForDeployment(deployment.id, {
      since: input.sinceIso,
      limit: input.limit,
    });
    out.push({ deployment, release, checks });
  }
  return out;
}

function parseDeclaredProbesFromRelease(release: Release): Probe[] {
  if (!release.buildYamlJson) return [];
  const parsed = JSON.parse(release.buildYamlJson) as unknown;
  const yaml: BuildYaml = validateBuildYaml(parsed);
  return yaml.probes ?? [];
}

// ── K8s release-deploy adapter (v0.3.0-6 sub-task 1) ────────────────

/**
 * Pull k8s-target-specific connection fields with shape validation.
 *
 * Stored on `TargetConnection` for `kind: k8s_test | k8s_demo`:
 *   - `bundleUri` (string, required): absolute path to a chart dir
 *     or manifest bundle.
 *   - `namespace` (string, required): target namespace.
 *   - `clusterContext` (string, optional): kubectl/helm --context.
 *   - `releaseName` (string, optional): defaults to bundle basename.
 */
function readK8sConnection(target: Target): {
  bundleUri: string;
  namespace: string;
  clusterContext?: string;
  releaseName?: string;
} {
  const c = target.connection;
  const bundleUri = typeof c.bundleUri === "string" ? c.bundleUri : "";
  const namespace = typeof c.namespace === "string" ? c.namespace : "";
  if (!bundleUri) {
    throw new Error(
      `k8s target '${target.name}' missing connection.bundleUri`,
    );
  }
  if (!namespace) {
    throw new Error(
      `k8s target '${target.name}' missing connection.namespace`,
    );
  }
  return {
    bundleUri,
    namespace,
    clusterContext:
      typeof c.clusterContext === "string" ? c.clusterContext : undefined,
    releaseName:
      typeof c.releaseName === "string" ? c.releaseName : undefined,
  };
}

interface RunK8sReleaseDeployArgs {
  orgId: string;
  releaseId: string;
  target: Target;
  actor?: string;
  out?: NodeJS.WritableStream;
  /** Injectable for tests; production callers omit. */
  drivers?: import("../k8s/index.js").K8sDriverPair;
}

/**
 * K8s adapter for `release deploy`. Creates the same Deployment row
 * shape the hypervisor path uses, runs `runK8sDeploy` (apply +
 * health), then promotes / fails the deployment row identically to
 * the VM flow.
 *
 * Differences from the VM path:
 *   - No pre-deploy checkpoint (Kubernetes uses revision history,
 *     not VM snapshots).
 *   - No artifact staging — the manifest bundle is the artifact;
 *     the release's build.yaml stays informational only.
 *   - Only the `vm_reachable` analogue ("apply succeeded" + pods
 *     ready) is run; declared probes from build.yaml are skipped
 *     in this commit and queued for the v0.3.0-7 probe-runner pass.
 */
export async function runK8sReleaseDeploy(
  controlPlane: ControlPlane,
  args: RunK8sReleaseDeployArgs,
): Promise<RunDeployResult> {
  const { runK8sDeploy } = await import("../k8s/index.js");
  const actor = args.actor ?? "cli";
  const out = args.out ?? process.stderr;

  const release = await controlPlane.releases.get(args.releaseId);
  if (!release) throw new Error(`release not found: ${args.releaseId}`);
  if (release.status !== "ready") {
    throw new Error(
      `release ${release.id} is not ready (status=${release.status})`,
    );
  }
  const conn = readK8sConnection(args.target);
  const artifacts = await controlPlane.artifacts.listForRelease(release.id);
  const previousActive = await controlPlane.deployments.getActiveForTarget(
    args.target.id,
  );

  const deployment = await controlPlane.deployments.create({
    orgId: args.orgId,
    releaseId: release.id,
    targetId: args.target.id,
    previousDeploymentId: previousActive?.id,
  });
  await controlPlane.auditLog.append({
    orgId: args.orgId,
    actor,
    action: "release.deploy.started",
    entityType: "deployment",
    entityId: deployment.id,
    detail: { releaseId: release.id, targetId: args.target.id, kind: args.target.kind },
  });
  await controlPlane.deployments.update(deployment.id, {
    status: "deploying",
    startedAt: new Date().toISOString(),
  });
  out.write(
    `[release deploy] k8s target '${args.target.name}' → namespace '${conn.namespace}'\n`,
  );

  try {
    const result = await runK8sDeploy({
      bundleUri: conn.bundleUri,
      namespace: conn.namespace,
      context: conn.clusterContext,
      releaseName: conn.releaseName,
      drivers: args.drivers,
    });
    const reachable = result.health?.ready ?? true;
    const reachabilityStatus = reachable ? "pass" : "fail";
    await controlPlane.healthChecks.append({
      deploymentId: deployment.id,
      probeName: "k8s_pods_ready",
      status: reachabilityStatus,
      detail: result.health?.detail ?? `applied via ${result.apply.driver}`,
    });

    const healthSummary: DeploymentHealthSummary = {
      total: 1,
      pass: reachable ? 1 : 0,
      fail: reachable ? 0 : 1,
      degraded: 0,
      lastCheckedAt: new Date().toISOString(),
    };

    if (!reachable) {
      await controlPlane.deployments.update(deployment.id, {
        status: "failed",
        completedAt: new Date().toISOString(),
        healthSummary,
      });
      await controlPlane.auditLog.append({
        orgId: args.orgId,
        actor,
        action: "release.deploy.failed",
        entityType: "deployment",
        entityId: deployment.id,
        detail: {
          releaseId: release.id,
          targetId: args.target.id,
          error: result.health?.detail ?? "pods not ready",
        },
      });
      throw new Error(
        `k8s health check failed: ${result.health?.detail ?? "pods not ready"}`,
      );
    }

    if (previousActive) {
      await controlPlane.deployments.update(previousActive.id, {
        status: "superseded",
      });
    }
    const finalized = await controlPlane.deployments.update(deployment.id, {
      status: "active",
      completedAt: new Date().toISOString(),
      healthSummary,
    });
    await controlPlane.auditLog.append({
      orgId: args.orgId,
      actor,
      action: "release.deploy.completed",
      entityType: "deployment",
      entityId: deployment.id,
      detail: {
        releaseId: release.id,
        targetId: args.target.id,
        supersededId: previousActive?.id,
        bundleKind: result.bundleKind,
        driver: result.apply.driver,
      },
    });
    return {
      deployment: finalized,
      release,
      target: args.target,
      artifacts,
      healthSummary,
    };
  } catch (err) {
    // Distinguish thrown-by-us (failed health) from driver-thrown
    // (apply failure). The deployment row is only updated when we
    // didn't already do it above.
    const current = await controlPlane.deployments.get(deployment.id);
    if (current && current.status !== "failed") {
      await controlPlane.deployments.update(deployment.id, {
        status: "failed",
        completedAt: new Date().toISOString(),
      });
      await controlPlane.auditLog.append({
        orgId: args.orgId,
        actor,
        action: "release.deploy.failed",
        entityType: "deployment",
        entityId: deployment.id,
        detail: {
          releaseId: release.id,
          targetId: args.target.id,
          error: (err as Error).message,
        },
      });
    }
    throw err;
  }
}

interface RunK8sReleaseRollbackArgs {
  orgId: string;
  target: Target;
  toReleaseId?: string;
  actor?: string;
  out?: NodeJS.WritableStream;
  drivers?: import("../k8s/index.js").K8sDriverPair;
}

/**
 * Rollback path for k8s targets: defer to the K8s driver's native
 * rollback (`kubectl rollout undo` or `helm rollback`) rather than
 * "redeploy the prior release", since Kubernetes already maintains
 * a revision history.
 *
 * The implementation records the rollback as a deployment-row state
 * transition so the audit timeline matches the VM path. We map the
 * rolled-back deployment to `status: rolled_back` and, when a prior
 * superseded deployment exists, promote it back to active.
 */
export async function runK8sReleaseRollback(
  controlPlane: ControlPlane,
  args: RunK8sReleaseRollbackArgs,
): Promise<RunDeployResult> {
  const { runK8sRollback } = await import("../k8s/index.js");
  const actor = args.actor ?? "cli-rollback";
  const out = args.out ?? process.stderr;

  const active = await controlPlane.deployments.getActiveForTarget(args.target.id);
  if (!active) {
    throw new Error(
      `no active deployment on k8s target '${args.target.name}' to roll back`,
    );
  }
  const release = await controlPlane.releases.get(active.releaseId);
  if (!release) {
    throw new Error(`active deployment ${active.id} references missing release`);
  }
  const conn = readK8sConnection(args.target);
  const releaseName = conn.releaseName ?? release.id;
  const artifacts = await controlPlane.artifacts.listForRelease(release.id);
  out.write(
    `[release rollback] k8s target '${args.target.name}' → release '${releaseName}'\n`,
  );

  // Kubernetes rollback addresses a workload by name; the operator
  // pins the rollback target name via `releaseName` on the target's
  // connection. We default to `deployment/<releaseName>` so the
  // common "single Deployment per target" shape works out of the box.
  const releaseId = conn.releaseName
    ? `deployment/${conn.releaseName}`
    : `deployment/${release.id}`;

  await runK8sRollback({
    releaseId,
    namespace: conn.namespace,
    context: conn.clusterContext,
    drivers: args.drivers,
  });

  await controlPlane.deployments.update(active.id, {
    status: "rolled_back",
    completedAt: new Date().toISOString(),
  });
  await controlPlane.auditLog.append({
    orgId: args.orgId,
    actor,
    action: "release.rollback.completed",
    entityType: "deployment",
    entityId: active.id,
    detail: {
      releaseId: release.id,
      targetId: args.target.id,
      driver: "kubectl",
    },
  });
  const finalized = await controlPlane.deployments.get(active.id);
  return {
    deployment: finalized ?? active,
    release,
    target: args.target,
    artifacts,
    healthSummary: active.healthSummary ?? {
      total: 0,
      pass: 0,
      fail: 0,
      degraded: 0,
    },
  };
}

// ── WS6 M8 — cloud_vm + cloud_stack deploy adapters ─────────────────
//
// Two cloud-routed target kinds, both with their own deploy semantic:
//
//   * cloud_vm:    target.connection carries a CloudInstanceHandle
//                  shape ({ provider, region, instance_id, name,
//                  network_mode? }). Deploy resolves the public IP
//                  via the cloud backend, runs a guest-agent
//                  reachability probe at port 443, records the
//                  Deployment row as active. Today only
//                  `public_mtls` network mode is dialable — the
//                  SSM / Bastion tunneling drivers are v0.3.x
//                  follow-ups (the descriptor contract from sub-task
//                  6 is in place; the dialer side is not).
//
//   * cloud_stack: target.connection carries
//                  { stack_name, module_path, image_var_name?,
//                    extra_vars? }. Deploy invokes
//                  TofuDriver.applyModule with the per-release
//                  variables `release_tag`, `release_id`,
//                  `release_commit_sha` always set, plus
//                  `<image_var_name>=<release.tag>` when the
//                  operator named one. The stack's HCL template
//                  controls how those vars become actual cloud
//                  resources — Signalman is intentionally agnostic
//                  to the template shape.
//
// Both share the same control-plane lifecycle as the VM / k8s
// adapters: create Deployment row, audit-log start, perform the
// kind-specific operation, record health-check result, finalise.

interface RunCloudReleaseDeployArgs {
  orgId: string;
  releaseId: string;
  target: Target;
  actor?: string;
  out?: NodeJS.WritableStream;
  /** Injectable for tests; production omits. */
  cloudBackendResolver?: (
    kind: import("../cloud/types.js").CloudBackendKind,
  ) => Promise<import("../cloud/types.js").CloudBackend>;
  /** Injectable for tests; production omits. */
  tofuDriverFactory?: () => import("../cloud/tofu.js").TofuDriver;
  /** Injectable reachability probe (host, port) -> {ok, detail}. */
  reachabilityProbe?: (host: string, port: number) => Promise<{ ok: boolean; detail: string }>;
}

interface CloudVmConnectionShape {
  provider: import("../cloud/types.js").CloudBackendKind;
  region: string;
  instance_id: string;
  name: string;
  network_mode?: import("../cloud/types.js").NetworkMode;
  guest_agent_port?: number;
}

interface CloudStackConnectionShape {
  stack_name: string;
  module_path: string;
  image_var_name?: string;
  extra_vars?: Record<string, string | number | boolean>;
}

/**
 * Parse a cloud_vm target's connection JSON. Throws operator-friendly
 * errors when required fields are missing.
 */
export function readCloudVmConnection(target: Target): CloudVmConnectionShape {
  const c = target.connection;
  const provider = c.provider as unknown;
  if (provider !== "aws" && provider !== "azure") {
    throw new Error(
      `cloud_vm target '${target.name}': connection.provider must be 'aws' or 'azure' (got ${JSON.stringify(provider)})`,
    );
  }
  if (typeof c.region !== "string" || c.region.length === 0) {
    throw new Error(`cloud_vm target '${target.name}': connection.region must be a non-empty string`);
  }
  if (typeof c.instance_id !== "string" || c.instance_id.length === 0) {
    throw new Error(`cloud_vm target '${target.name}': connection.instance_id must be a non-empty string`);
  }
  if (typeof c.name !== "string" || c.name.length === 0) {
    throw new Error(`cloud_vm target '${target.name}': connection.name must be a non-empty string`);
  }
  const mode = c.network_mode as unknown;
  if (mode !== undefined && mode !== "public_mtls" && mode !== "aws_ssm" && mode !== "azure_bastion") {
    throw new Error(
      `cloud_vm target '${target.name}': connection.network_mode must be one of public_mtls / aws_ssm / azure_bastion (got ${JSON.stringify(mode)})`,
    );
  }
  const port = c.guest_agent_port as unknown;
  if (port !== undefined && (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535)) {
    throw new Error(
      `cloud_vm target '${target.name}': connection.guest_agent_port must be an integer in [1, 65535]`,
    );
  }
  return {
    provider,
    region: c.region,
    instance_id: c.instance_id,
    name: c.name,
    network_mode: mode as CloudVmConnectionShape["network_mode"],
    guest_agent_port: port as number | undefined,
  };
}

/** Parse a cloud_stack target's connection JSON. */
export function readCloudStackConnection(target: Target): CloudStackConnectionShape {
  const c = target.connection;
  if (typeof c.stack_name !== "string" || c.stack_name.length === 0) {
    throw new Error(`cloud_stack target '${target.name}': connection.stack_name must be a non-empty string`);
  }
  if (typeof c.module_path !== "string" || c.module_path.length === 0) {
    throw new Error(`cloud_stack target '${target.name}': connection.module_path must be a non-empty string`);
  }
  const imageVar = c.image_var_name as unknown;
  if (imageVar !== undefined && (typeof imageVar !== "string" || imageVar.length === 0)) {
    throw new Error(
      `cloud_stack target '${target.name}': connection.image_var_name must be a non-empty string when set`,
    );
  }
  const extra = c.extra_vars as unknown;
  if (extra !== undefined && (typeof extra !== "object" || extra === null || Array.isArray(extra))) {
    throw new Error(
      `cloud_stack target '${target.name}': connection.extra_vars must be a JSON object when set`,
    );
  }
  return {
    stack_name: c.stack_name,
    module_path: c.module_path,
    image_var_name: imageVar as string | undefined,
    extra_vars: extra as Record<string, string | number | boolean> | undefined,
  };
}

/**
 * Default TCP-connect reachability probe — connects to (host, port)
 * with a 5s timeout. Returns ok=true if the SYN/SYN-ACK lands, false
 * otherwise. Production callers omit the override; tests inject a
 * deterministic stub.
 */
async function defaultReachabilityProbe(
  host: string,
  port: number,
): Promise<{ ok: boolean; detail: string }> {
  const net = await import("node:net");
  return await new Promise((resolve) => {
    const socket = new net.Socket();
    const timer = setTimeout(() => {
      socket.destroy();
      resolve({ ok: false, detail: `tcp-connect timeout to ${host}:${port}` });
    }, 5000);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.end();
      resolve({ ok: true, detail: `tcp-connect ok to ${host}:${port}` });
    });
    socket.once("error", (err) => {
      clearTimeout(timer);
      socket.destroy();
      resolve({ ok: false, detail: `tcp-connect failed to ${host}:${port}: ${err.message}` });
    });
    socket.connect(port, host);
  });
}

/**
 * WS6 M8: cloud-routed release deploy. Dispatches on target.kind:
 *   - cloud_vm    → runCloudVmReleaseDeploy
 *   - cloud_stack → runCloudStackReleaseDeploy
 * Caller is `runReleaseDeploy` after isCloudTargetKind checks pass.
 */
export async function runCloudReleaseDeploy(
  controlPlane: ControlPlane,
  args: RunCloudReleaseDeployArgs,
): Promise<RunDeployResult> {
  if (args.target.kind === "cloud_vm") return runCloudVmReleaseDeploy(controlPlane, args);
  if (args.target.kind === "cloud_stack") return runCloudStackReleaseDeploy(controlPlane, args);
  throw new Error(`runCloudReleaseDeploy: unsupported target.kind ${args.target.kind}`);
}

async function runCloudVmReleaseDeploy(
  controlPlane: ControlPlane,
  args: RunCloudReleaseDeployArgs,
): Promise<RunDeployResult> {
  const actor = args.actor ?? "cli";
  const out = args.out ?? process.stderr;
  const conn = readCloudVmConnection(args.target);

  const release = await controlPlane.releases.get(args.releaseId);
  if (!release) throw new Error(`release not found: ${args.releaseId}`);
  if (release.status !== "ready") {
    throw new Error(`release ${release.id} is not ready (status=${release.status})`);
  }
  const artifacts = await controlPlane.artifacts.listForRelease(release.id);

  // network_mode guard. Only public_mtls is dialable today; SSM /
  // Bastion descriptors are queued for the v0.3.x tunneling driver
  // pass. Surface the misconfig before creating a Deployment row.
  const mode = conn.network_mode ?? "public_mtls";
  if (mode !== "public_mtls") {
    throw new Error(
      `cloud_vm deploy: network_mode='${mode}' has no dialable transport yet ` +
        `(SSM / Bastion tunneling drivers are deferred to v0.3.x). ` +
        `Set the target's network_mode to 'public_mtls' or re-provision the ` +
        `instance with that mode.`,
    );
  }

  const previousActive = await controlPlane.deployments.getActiveForTarget(args.target.id);
  const deployment = await controlPlane.deployments.create({
    orgId: args.orgId,
    releaseId: release.id,
    targetId: args.target.id,
    previousDeploymentId: previousActive?.id,
  });
  await controlPlane.auditLog.append({
    orgId: args.orgId,
    actor,
    action: "release.deploy.started",
    entityType: "deployment",
    entityId: deployment.id,
    detail: {
      releaseId: release.id,
      targetId: args.target.id,
      kind: args.target.kind,
      provider: conn.provider,
      instance_id: conn.instance_id,
    },
  });
  await controlPlane.deployments.update(deployment.id, {
    status: "deploying",
    startedAt: new Date().toISOString(),
  });
  out.write(
    `[release deploy] cloud_vm '${args.target.name}' → ${conn.provider}/${conn.region}/${conn.instance_id}\n`,
  );

  try {
    const resolver =
      args.cloudBackendResolver ??
      (async (kind) => {
        const { getCloudBackend } = await import("../cloud/registry.js");
        return getCloudBackend(kind);
      });
    const backend = await resolver(conn.provider);
    const handle: import("../cloud/types.js").CloudInstanceHandle = {
      id: conn.instance_id,
      backend: conn.provider,
      name: conn.name,
      region: conn.region,
      network_mode: mode,
    };
    const ip = await backend.getInstanceIp(handle);
    if (!ip) {
      throw new Error(
        `cloud_vm deploy: backend returned no public IP for ${conn.instance_id} ` +
          `(instance may not be running or may have no public network interface)`,
      );
    }

    const probe = args.reachabilityProbe ?? defaultReachabilityProbe;
    const port = conn.guest_agent_port ?? 443;
    const reach = await probe(ip, port);

    await controlPlane.healthChecks.append({
      deploymentId: deployment.id,
      probeName: "cloud_vm_reachable",
      status: reach.ok ? "pass" : "fail",
      detail: reach.detail,
    });

    if (!reach.ok) {
      throw new Error(`cloud_vm_reachable probe failed: ${reach.detail}`);
    }

    const nowIsoStr = new Date().toISOString();
    const healthSummary: DeploymentHealthSummary = {
      total: 1,
      pass: 1,
      fail: 0,
      degraded: 0,
      lastCheckedAt: nowIsoStr,
    };

    if (previousActive) {
      await controlPlane.deployments.update(previousActive.id, { status: "superseded" });
    }
    const finalized = await controlPlane.deployments.update(deployment.id, {
      status: "active",
      completedAt: nowIsoStr,
      healthSummary,
    });
    await controlPlane.auditLog.append({
      orgId: args.orgId,
      actor,
      action: "release.deploy.completed",
      entityType: "deployment",
      entityId: deployment.id,
      detail: {
        releaseId: release.id,
        targetId: args.target.id,
        supersededId: previousActive?.id,
        ip,
        port,
      },
    });
    return {
      deployment: finalized,
      release,
      target: args.target,
      artifacts,
      healthSummary,
    };
  } catch (err) {
    const current = await controlPlane.deployments.get(deployment.id);
    if (current && current.status !== "failed") {
      await controlPlane.deployments.update(deployment.id, {
        status: "failed",
        completedAt: new Date().toISOString(),
      });
      await controlPlane.auditLog.append({
        orgId: args.orgId,
        actor,
        action: "release.deploy.failed",
        entityType: "deployment",
        entityId: deployment.id,
        detail: {
          releaseId: release.id,
          targetId: args.target.id,
          error: (err as Error).message,
        },
      });
    }
    throw err;
  }
}

async function runCloudStackReleaseDeploy(
  controlPlane: ControlPlane,
  args: RunCloudReleaseDeployArgs,
): Promise<RunDeployResult> {
  const actor = args.actor ?? "cli";
  const out = args.out ?? process.stderr;
  const conn = readCloudStackConnection(args.target);

  const release = await controlPlane.releases.get(args.releaseId);
  if (!release) throw new Error(`release not found: ${args.releaseId}`);
  if (release.status !== "ready") {
    throw new Error(`release ${release.id} is not ready (status=${release.status})`);
  }
  const artifacts = await controlPlane.artifacts.listForRelease(release.id);

  const previousActive = await controlPlane.deployments.getActiveForTarget(args.target.id);
  const deployment = await controlPlane.deployments.create({
    orgId: args.orgId,
    releaseId: release.id,
    targetId: args.target.id,
    previousDeploymentId: previousActive?.id,
  });
  await controlPlane.auditLog.append({
    orgId: args.orgId,
    actor,
    action: "release.deploy.started",
    entityType: "deployment",
    entityId: deployment.id,
    detail: {
      releaseId: release.id,
      targetId: args.target.id,
      kind: args.target.kind,
      stack_name: conn.stack_name,
      module_path: conn.module_path,
    },
  });
  await controlPlane.deployments.update(deployment.id, {
    status: "deploying",
    startedAt: new Date().toISOString(),
  });
  out.write(
    `[release deploy] cloud_stack '${args.target.name}' → stack=${conn.stack_name} module=${conn.module_path}\n`,
  );

  try {
    const driverFactory =
      args.tofuDriverFactory ??
      (() => {
        // Dynamic import + new TofuDriver from cwd. Production wires
        // through this; tests inject a stub.
        const TofuDriverClass = require("../cloud/tofu.js").TofuDriver;
        return new TofuDriverClass({ projectRoot: process.cwd() });
      });
    const driver = driverFactory();

    // Compose the deploy variables. release_tag / release_id /
    // release_commit_sha are ALWAYS set; the operator's TF template
    // references whichever of those it needs. image_var_name is an
    // operator-named convenience alias that ALSO receives release.tag
    // — useful for templates that pin an AMI / image SKU by tag.
    const vars: Record<string, string | number | boolean> = {
      ...(conn.extra_vars ?? {}),
      release_tag: release.tag,
      release_id: release.id,
      release_commit_sha: release.commitSha,
    };
    if (conn.image_var_name) {
      vars[conn.image_var_name] = release.tag;
    }

    const result = await driver.applyModule({
      stackName: conn.stack_name,
      modulePath: conn.module_path,
      vars,
    });

    await controlPlane.healthChecks.append({
      deploymentId: deployment.id,
      probeName: "stack_apply",
      status: "pass",
      detail:
        `add=${result.changeSummary.add} change=${result.changeSummary.change} ` +
        `destroy=${result.changeSummary.destroy} durationMs=${result.durationMs}`,
    });

    const nowIsoStr = new Date().toISOString();
    const healthSummary: DeploymentHealthSummary = {
      total: 1,
      pass: 1,
      fail: 0,
      degraded: 0,
      lastCheckedAt: nowIsoStr,
    };

    if (previousActive) {
      await controlPlane.deployments.update(previousActive.id, { status: "superseded" });
    }
    const finalized = await controlPlane.deployments.update(deployment.id, {
      status: "active",
      completedAt: nowIsoStr,
      healthSummary,
    });
    await controlPlane.auditLog.append({
      orgId: args.orgId,
      actor,
      action: "release.deploy.completed",
      entityType: "deployment",
      entityId: deployment.id,
      detail: {
        releaseId: release.id,
        targetId: args.target.id,
        supersededId: previousActive?.id,
        stack_name: conn.stack_name,
        outputs: result.outputs,
        change_summary: result.changeSummary,
      },
    });
    return {
      deployment: finalized,
      release,
      target: args.target,
      artifacts,
      healthSummary,
    };
  } catch (err) {
    await controlPlane.healthChecks.append({
      deploymentId: deployment.id,
      probeName: "stack_apply",
      status: "fail",
      detail: (err as Error).message,
    });
    const current = await controlPlane.deployments.get(deployment.id);
    if (current && current.status !== "failed") {
      await controlPlane.deployments.update(deployment.id, {
        status: "failed",
        completedAt: new Date().toISOString(),
      });
      await controlPlane.auditLog.append({
        orgId: args.orgId,
        actor,
        action: "release.deploy.failed",
        entityType: "deployment",
        entityId: deployment.id,
        detail: {
          releaseId: release.id,
          targetId: args.target.id,
          stack_name: conn.stack_name,
          error: (err as Error).message,
        },
      });
    }
    throw err;
  }
}

// ── Direct K8s verbs (MCP + CLI entry points) ───────────────────────

export interface K8sDeployVerbInput {
  bundleUri: string;
  namespace: string;
  clusterContext?: string;
  releaseName?: string;
  waitForHealth?: boolean;
  healthTimeoutMs?: number;
}

/**
 * Direct K8s deploy — bypasses the control-plane Deployment row and
 * runs `runK8sDeploy` on an explicit bundle/namespace. Mirrors the
 * cloud `signalman_stack_apply` path: the MCP / CLI surface drives
 * the driver, the control-plane release-deploy verb stays the
 * audit-logged path.
 */
export async function runK8sDeployVerb(input: K8sDeployVerbInput) {
  const { runK8sDeploy } = await import("../k8s/index.js");
  return runK8sDeploy({
    bundleUri: input.bundleUri,
    namespace: input.namespace,
    context: input.clusterContext,
    releaseName: input.releaseName,
    waitForHealth: input.waitForHealth,
    healthTimeoutMs: input.healthTimeoutMs,
  });
}

export interface K8sRollbackVerbInput {
  releaseId: string;
  namespace: string;
  clusterContext?: string;
  toRevision?: number;
  driver?: "kubectl" | "helm";
}

export async function runK8sRollbackVerb(input: K8sRollbackVerbInput) {
  const { runK8sRollback } = await import("../k8s/index.js");
  return runK8sRollback({
    releaseId: input.releaseId,
    namespace: input.namespace,
    context: input.clusterContext,
    toRevision: input.toRevision,
    driver: input.driver,
  });
}

export interface K8sStatusVerbInput {
  namespace: string;
  clusterContext?: string;
  selector?: string;
  releaseName?: string;
  driver?: "kubectl" | "helm";
}

export async function runK8sStatusVerb(input: K8sStatusVerbInput) {
  const { runK8sStatus } = await import("../k8s/index.js");
  return runK8sStatus({
    namespace: input.namespace,
    context: input.clusterContext,
    selector: input.selector,
    releaseName: input.releaseName,
    driver: input.driver,
  });
}

// ── Scheduled health verbs (v0.4.0-3 / Epic 3) ──────────────────────

export interface ScheduleAddInput {
  targetName: string;
  intervalSeconds: number;
  probeNames?: string[];
  active?: boolean;
}

export interface ScheduleListEntry {
  schedule: HealthSchedule;
  target: Target;
}

export async function runScheduleAdd(
  controlPlane: ControlPlane,
  input: ScheduleAddInput,
): Promise<ScheduleListEntry> {
  if (!Number.isFinite(input.intervalSeconds) || input.intervalSeconds < 60) {
    throw new Error("schedule add: --interval-seconds must be >= 60");
  }
  const orgId = await getActiveOrgId(controlPlane);
  const target = await controlPlane.targets.getByName(orgId, input.targetName);
  if (!target) throw new Error(`target not found: ${input.targetName}`);
  const schedule = await controlPlane.healthSchedules.create({
    orgId,
    targetId: target.id,
    intervalSeconds: input.intervalSeconds,
    probeNames: input.probeNames ?? [],
    active: input.active,
  });
  await controlPlane.auditLog.append({
    orgId,
    actor: "cli",
    action: "health_schedule.added",
    entityType: "health_schedule",
    entityId: schedule.id,
    detail: {
      targetId: target.id,
      intervalSeconds: schedule.intervalSeconds,
      probeNames: schedule.probeNames,
    },
  });
  return { schedule, target };
}

export async function runScheduleList(
  controlPlane: ControlPlane,
  input: { targetName?: string } = {},
): Promise<ScheduleListEntry[]> {
  const orgId = await getActiveOrgId(controlPlane);
  if (input.targetName) {
    const target = await controlPlane.targets.getByName(orgId, input.targetName);
    if (!target) throw new Error(`target not found: ${input.targetName}`);
    const schedules = await controlPlane.healthSchedules.listForTarget(target.id);
    return schedules.map((schedule) => ({ schedule, target }));
  }
  const schedules = await controlPlane.healthSchedules.listForOrg(orgId);
  const out: ScheduleListEntry[] = [];
  for (const schedule of schedules) {
    const target = await controlPlane.targets.get(schedule.targetId);
    if (target) out.push({ schedule, target });
  }
  return out;
}

export async function runScheduleDisable(
  controlPlane: ControlPlane,
  input: { id: string },
): Promise<HealthSchedule> {
  const existing = await controlPlane.healthSchedules.get(input.id);
  if (!existing) throw new Error(`health schedule not found: ${input.id}`);
  const updated = await controlPlane.healthSchedules.update(existing.id, {
    active: false,
  });
  await controlPlane.auditLog.append({
    orgId: existing.orgId,
    actor: "cli",
    action: "health_schedule.disabled",
    entityType: "health_schedule",
    entityId: existing.id,
  });
  return updated;
}

export async function runScheduleEnable(
  controlPlane: ControlPlane,
  input: { id: string },
): Promise<HealthSchedule> {
  const existing = await controlPlane.healthSchedules.get(input.id);
  if (!existing) throw new Error(`health schedule not found: ${input.id}`);
  const updated = await controlPlane.healthSchedules.update(existing.id, {
    active: true,
  });
  await controlPlane.auditLog.append({
    orgId: existing.orgId,
    actor: "cli",
    action: "health_schedule.enabled",
    entityType: "health_schedule",
    entityId: existing.id,
  });
  return updated;
}

export async function runScheduleRemove(
  controlPlane: ControlPlane,
  input: { id: string },
): Promise<void> {
  const existing = await controlPlane.healthSchedules.get(input.id);
  if (!existing) throw new Error(`health schedule not found: ${input.id}`);
  await controlPlane.healthSchedules.softDelete(existing.id);
  await controlPlane.auditLog.append({
    orgId: existing.orgId,
    actor: "cli",
    action: "health_schedule.removed",
    entityType: "health_schedule",
    entityId: existing.id,
  });
}

/**
 * Build a `ProbeInvoker` that re-uses the existing `runHealthCheck`
 * verb. The scheduler module is agnostic about how probes execute;
 * the production wiring lives here so the scheduler stays testable in
 * isolation.
 */
export function createDefaultProbeInvoker(
  controlPlane: ControlPlane,
): ProbeInvoker {
  return async ({ schedule }) => {
    const target = await controlPlane.targets.get(schedule.targetId);
    if (!target) {
      throw new Error(
        `health schedule ${schedule.id} references missing target ${schedule.targetId}`,
      );
    }
    const result = await runHealthCheck(
      controlPlane,
      {
        targetName: target.name,
        probeNames: schedule.probeNames.length > 0 ? schedule.probeNames : undefined,
        actor: "scheduler",
      },
      { out: process.stderr },
    );
    const outcome: ScheduledProbeOutcome = {
      reachable: result.reachability.reachable,
      probes: result.probes.map((p) => ({ name: p.name, status: p.status })),
      deploymentId: result.deploymentId,
    };
    return outcome;
  };
}

// ── Webhook subscription verbs (v0.4.0-2 / Epic 2) ──────────────────

export interface WebhookAddInput {
  kind: WebhookKind;
  url: string;
  secretHmacKey?: string;
  eventKinds?: string[];
  active?: boolean;
  description?: string;
}

export async function runWebhookAdd(
  controlPlane: ControlPlane,
  input: WebhookAddInput,
): Promise<WebhookSubscription> {
  if (input.kind === "email" && !input.url.startsWith("mailto:") && !input.url.includes("@")) {
    throw new Error(
      "webhook add: email kind requires a mailto: URL or a bare email address",
    );
  }
  if ((input.kind === "generic" || input.kind === "slack") && !/^https?:\/\//i.test(input.url)) {
    throw new Error("webhook add: generic/slack kinds require an http(s):// URL");
  }
  const orgId = await getActiveOrgId(controlPlane);
  const sub = await controlPlane.webhookSubscriptions.create({
    orgId,
    kind: input.kind,
    url: input.url,
    secretHmacKey: input.secretHmacKey ?? null,
    eventKinds: input.eventKinds ?? [],
    active: input.active,
    description: input.description ?? null,
  });
  await controlPlane.auditLog.append({
    orgId,
    actor: "cli",
    action: "webhook.added",
    entityType: "webhook_subscription",
    entityId: sub.id,
    detail: {
      kind: sub.kind,
      url: sub.url,
      eventKinds: sub.eventKinds,
    },
  });
  return sub;
}

export async function runWebhookList(
  controlPlane: ControlPlane,
): Promise<WebhookSubscription[]> {
  const orgId = await getActiveOrgId(controlPlane);
  return controlPlane.webhookSubscriptions.listForOrg(orgId);
}

export async function runWebhookRemove(
  controlPlane: ControlPlane,
  input: { id: string },
): Promise<void> {
  const existing = await controlPlane.webhookSubscriptions.get(input.id);
  if (!existing) throw new Error(`webhook subscription not found: ${input.id}`);
  await controlPlane.webhookSubscriptions.softDelete(existing.id);
  await controlPlane.auditLog.append({
    orgId: existing.orgId,
    actor: "cli",
    action: "webhook.removed",
    entityType: "webhook_subscription",
    entityId: existing.id,
  });
}

export interface WebhookTestInput {
  id: string;
  /** Event payload to use for the test. Defaults to a synthetic `release-built`. */
  event?: SignalmanEvent;
}

export interface WebhookTestResult {
  subscription: WebhookSubscription;
  outcome: { delivered: boolean; status?: number; error?: string };
}

/**
 * Send a synthetic event to a single subscription. Used by `signalman
 * webhook test <id>` to verify a subscription before relying on it
 * in production paths.
 */
export async function runWebhookTest(
  controlPlane: ControlPlane,
  input: WebhookTestInput,
  options: { fetch?: HttpFetcher; email?: EmailSender | null } = {},
): Promise<WebhookTestResult> {
  const existing = await controlPlane.webhookSubscriptions.get(input.id);
  if (!existing) throw new Error(`webhook subscription not found: ${input.id}`);
  const event: SignalmanEvent = input.event ?? {
    kind: "release-built",
    orgId: existing.orgId,
    at: new Date().toISOString(),
    releaseId: "test-release",
    productName: "test-product",
    tag: "v0.0.0-test",
    manifestSha256: null,
  };
  const dispatcher = new EventDispatcher({
    controlPlane,
    fetch: options.fetch,
    email: options.email,
  });
  const outcome = await dispatcher.deliver(existing, event);
  return {
    subscription: existing,
    outcome: {
      delivered: outcome.delivered,
      status: outcome.status,
      error: outcome.error,
    },
  };
}

/**
 * Fire an event through the dispatcher without letting downstream
 * delivery failures propagate. The release-build / deploy / rollback
 * paths use this so a flaky Slack webhook can't block a build from
 * landing.
 *
 * Returns the dispatch result for tests that want to assert delivery;
 * production paths discard the return value.
 */
export async function fireEventBestEffort(
  controlPlane: ControlPlane,
  event: SignalmanEvent,
): Promise<DispatchResult | null> {
  try {
    const dispatcher = new EventDispatcher({ controlPlane });
    return await dispatcher.dispatch(event);
  } catch (err) {
    // Dispatcher itself blew up (e.g. listActive() against a closed
    // DB). Log to stderr and continue.
    process.stderr.write(
      JSON.stringify({
        source: "signalman-dispatcher",
        kind: "dispatch-error",
        event: event.kind,
        error: (err as Error).message,
      }) + "\n",
    );
    return null;
  }
}

/**
 * Wire the scheduler emit hook into the event dispatcher. Returns an
 * emit function suitable for `runSchedulerTick`'s `emit` option;
 * health-failed events get translated into dispatcher events, all
 * other scheduler events are logged but not dispatched.
 */
export function createSchedulerDispatcherBridge(
  controlPlane: ControlPlane,
  orgId: string,
) {
  return (ev: {
    kind: "health-tick" | "health-failed" | "schedule-error";
    scheduleId: string;
    targetId: string;
    at: string;
    outcome?: ScheduledProbeOutcome;
    error?: string;
  }) => {
    if (ev.kind !== "health-failed" || !ev.outcome) return;
    void fireEventBestEffort(controlPlane, {
      kind: "health-failed",
      orgId,
      at: ev.at,
      scheduleId: ev.scheduleId,
      targetId: ev.targetId,
      deploymentId: ev.outcome.deploymentId,
      reachable: ev.outcome.reachable,
      probes: ev.outcome.probes,
    });
  };
}

// ── Promotion policy / approval verbs (v0.4.0-1 / Epic 1) ───────────

export interface PromotionPolicyAddInput {
  productName: string;
  destTargetName: string;
  gateKind: PromotionGateKind;
  /** Optional source target name. Omit for the initial-tier policy. */
  sourceTargetName?: string;
  /** Free-form kind-specific config; e.g. `{ delay_seconds: 600 }` for time_delay. */
  gateConfig?: Record<string, unknown>;
  description?: string;
}

export interface PromotionPolicyListEntry {
  policy: PromotionPolicy;
  product: Product;
  destTarget: Target;
  sourceTarget: Target | null;
}

export async function runPromotionPolicyAdd(
  controlPlane: ControlPlane,
  input: PromotionPolicyAddInput,
): Promise<PromotionPolicyListEntry> {
  const orgId = await getActiveOrgId(controlPlane);
  const product = await controlPlane.products.getByName(orgId, input.productName);
  if (!product) throw new Error(`product not found: ${input.productName}`);
  const destTarget = await controlPlane.targets.getByName(orgId, input.destTargetName);
  if (!destTarget) throw new Error(`target not found: ${input.destTargetName}`);
  let sourceTarget: Target | null = null;
  let sourceTargetId: string | null = null;
  if (input.sourceTargetName) {
    sourceTarget = await controlPlane.targets.getByName(orgId, input.sourceTargetName);
    if (!sourceTarget)
      throw new Error(`source target not found: ${input.sourceTargetName}`);
    sourceTargetId = sourceTarget.id;
  }
  if (input.gateKind === "time_delay") {
    // Validate delay_seconds up front so a malformed config doesn't
    // explode the listener later.
    const raw = (input.gateConfig as { delay_seconds?: unknown } | undefined)?.delay_seconds;
    const n = typeof raw === "number" ? raw : Number(raw);
    if (!Number.isFinite(n) || n < 0) {
      throw new Error(
        "promotion add: time_delay gate requires { delay_seconds: N } in --gate-config",
      );
    }
  }
  const policy = await controlPlane.promotionPolicies.create({
    orgId,
    productId: product.id,
    sourceTargetId,
    destTargetId: destTarget.id,
    gateKind: input.gateKind,
    gateConfig: input.gateConfig ?? {},
    description: input.description ?? null,
  });
  await controlPlane.auditLog.append({
    orgId,
    actor: "cli",
    action: "promotion_policy.added",
    entityType: "promotion_policy",
    entityId: policy.id,
    detail: {
      productId: product.id,
      destTargetId: destTarget.id,
      sourceTargetId,
      gateKind: policy.gateKind,
    },
  });
  return { policy, product, destTarget, sourceTarget };
}

export async function runPromotionPolicyList(
  controlPlane: ControlPlane,
): Promise<PromotionPolicyListEntry[]> {
  const orgId = await getActiveOrgId(controlPlane);
  const policies = await controlPlane.promotionPolicies.listForOrg(orgId);
  const out: PromotionPolicyListEntry[] = [];
  for (const policy of policies) {
    const product = await controlPlane.products.get(policy.productId);
    const destTarget = await controlPlane.targets.get(policy.destTargetId);
    if (!product || !destTarget) continue;
    const sourceTarget = policy.sourceTargetId
      ? await controlPlane.targets.get(policy.sourceTargetId)
      : null;
    out.push({ policy, product, destTarget, sourceTarget });
  }
  return out;
}

export async function runPromotionPolicyRemove(
  controlPlane: ControlPlane,
  input: { id: string },
): Promise<void> {
  const existing = await controlPlane.promotionPolicies.get(input.id);
  if (!existing) throw new Error(`promotion policy not found: ${input.id}`);
  await controlPlane.promotionPolicies.softDelete(existing.id);
  await controlPlane.auditLog.append({
    orgId: existing.orgId,
    actor: "cli",
    action: "promotion_policy.removed",
    entityType: "promotion_policy",
    entityId: existing.id,
  });
}

export interface ApprovalEntry {
  approval: Approval;
  policy: PromotionPolicy | null;
  release: Release | null;
  destTarget: Target | null;
}

export async function runApprovalList(
  controlPlane: ControlPlane,
  input: { status?: Approval["status"] } = {},
): Promise<ApprovalEntry[]> {
  const orgId = await getActiveOrgId(controlPlane);
  const approvals = await controlPlane.approvals.listForOrg(orgId, {
    status: input.status,
  });
  const out: ApprovalEntry[] = [];
  for (const a of approvals) {
    const policy = await controlPlane.promotionPolicies.get(a.policyId);
    const release = await controlPlane.releases.get(a.releaseId);
    const destTarget = await controlPlane.targets.get(a.destTargetId);
    out.push({ approval: a, policy, release, destTarget });
  }
  return out;
}

export interface ApprovalDecisionInput {
  id: string;
  decidedBy?: string;
  reason?: string;
}

export interface ApprovalDecisionResult {
  approval: Approval;
  deployedDeploymentId?: string | null;
  deployOutcome?: "success" | "failed";
}

export async function runPromotionApprove(
  controlPlane: ControlPlane,
  input: ApprovalDecisionInput,
  options: { deploy?: DeployInvoker } = {},
): Promise<ApprovalDecisionResult> {
  const existing = await controlPlane.approvals.get(input.id);
  if (!existing) throw new Error(`approval not found: ${input.id}`);
  if (existing.status !== "pending") {
    throw new Error(
      `approval ${input.id} is ${existing.status}, not pending — refusing to re-approve`,
    );
  }
  const policy = await controlPlane.promotionPolicies.get(existing.policyId);
  if (!policy) throw new Error(`approval references missing policy ${existing.policyId}`);
  const release = await controlPlane.releases.get(existing.releaseId);
  if (!release) throw new Error(`approval references missing release ${existing.releaseId}`);
  // Enforce the per-policy approver allow-list when configured.
  // Honour-system check: --decided-by is caller-supplied, not
  // authenticated. Surfaces accidental self-approval; does not block
  // a malicious operator who already has CLI access (they could
  // bypass promotion entirely with `release deploy`). The audit-log
  // row preserves whatever the caller passed.
  const allowlistError = checkApproverAllowlist(policy, input.decidedBy);
  if (allowlistError) throw new Error(allowlistError);
  const nowIsoStr = new Date().toISOString();
  await controlPlane.approvals.update(existing.id, {
    status: "approved",
    decidedBy: input.decidedBy ?? "cli",
    decidedAt: nowIsoStr,
    reason: input.reason ?? null,
  });
  await controlPlane.auditLog.append({
    orgId: existing.orgId,
    actor: input.decidedBy ?? "cli",
    action: "approval.approved",
    entityType: "approval",
    entityId: existing.id,
    detail: { reason: input.reason },
  });
  await fireEventBestEffort(controlPlane, {
    kind: "promotion-approved",
    orgId: existing.orgId,
    at: nowIsoStr,
    promotionId: existing.id,
    approvalId: existing.id,
    policyId: policy.id,
    releaseId: release.id,
    targetName: (await controlPlane.targets.get(existing.destTargetId))?.name ?? existing.destTargetId,
  });
  const fresh = await controlPlane.approvals.get(existing.id);
  if (!fresh) throw new Error(`approval ${existing.id} vanished after approval`);
  // Fire the deploy now that the gate is open.
  const deploy = options.deploy ?? createDefaultPromotionDeployInvoker(controlPlane);
  const invocation = await deploy({
    releaseId: release.id,
    destTargetId: existing.destTargetId,
    approval: fresh,
    policy,
  });
  const updated = await controlPlane.approvals.update(existing.id, {
    deployAttemptedAt: nowIsoStr,
    deployOutcome: invocation.outcome,
    deployDeploymentId: invocation.deploymentId,
  });
  return {
    approval: updated,
    deployedDeploymentId: invocation.deploymentId,
    deployOutcome: invocation.outcome,
  };
}

export async function runPromotionReject(
  controlPlane: ControlPlane,
  input: ApprovalDecisionInput,
): Promise<Approval> {
  const existing = await controlPlane.approvals.get(input.id);
  if (!existing) throw new Error(`approval not found: ${input.id}`);
  if (existing.status !== "pending") {
    throw new Error(
      `approval ${input.id} is ${existing.status}, not pending — refusing to re-reject`,
    );
  }
  const policy = await controlPlane.promotionPolicies.get(existing.policyId);
  if (!policy) throw new Error(`approval references missing policy ${existing.policyId}`);
  const nowIsoStr = new Date().toISOString();
  const updated = await controlPlane.approvals.update(existing.id, {
    status: "rejected",
    decidedBy: input.decidedBy ?? "cli",
    decidedAt: nowIsoStr,
    reason: input.reason ?? null,
  });
  await controlPlane.auditLog.append({
    orgId: existing.orgId,
    actor: input.decidedBy ?? "cli",
    action: "approval.rejected",
    entityType: "approval",
    entityId: existing.id,
    detail: { reason: input.reason },
  });
  const target = await controlPlane.targets.get(existing.destTargetId);
  await fireEventBestEffort(controlPlane, {
    kind: "promotion-rejected",
    orgId: existing.orgId,
    at: nowIsoStr,
    promotionId: existing.id,
    approvalId: existing.id,
    policyId: policy.id,
    releaseId: existing.releaseId,
    targetName: target?.name ?? existing.destTargetId,
    reason: input.reason ?? null,
  });
  return updated;
}

/**
 * Process due `time_delay` approvals. Returns the count dispatched.
 * Exposed via `signalman promotion tick` and as an MCP tool so cron
 * paths can prod it without a long-running daemon.
 */
export async function runPromotionTickVerb(
  controlPlane: ControlPlane,
  options: { deploy?: DeployInvoker } = {},
): Promise<{ processed: number }> {
  const deploy = options.deploy ?? createDefaultPromotionDeployInvoker(controlPlane);
  const processed = await runPromotionTick({ controlPlane, deploy });
  return { processed };
}

/**
 * Default deploy invoker for the promotion listener / tick. Wraps
 * `runReleaseDeploy` and captures success/failure as the typed shape
 * the listener expects.
 */
export function createDefaultPromotionDeployInvoker(
  controlPlane: ControlPlane,
): DeployInvoker {
  return async ({ releaseId, destTargetId }) => {
    const target = await controlPlane.targets.get(destTargetId);
    if (!target) {
      return { deploymentId: null, outcome: "failed", errorMessage: "dest target missing" };
    }
    try {
      const result = await runReleaseDeploy(
        controlPlane,
        {
          targetName: target.name,
          releaseId,
          actor: "promotion",
        },
        { out: process.stderr },
      );
      return {
        deploymentId: result.deployment.id,
        outcome: result.deployment.status === "active" ? "success" : "failed",
      };
    } catch (err) {
      return {
        deploymentId: null,
        outcome: "failed",
        errorMessage: (err as Error).message,
      };
    }
  };
}

/**
 * Read the approver allow-list from a policy's gate_config. Returns
 * an error message when `decidedBy` is set but isn't allowed; null
 * when there's no allow-list or the caller is allowed.
 *
 * Exported for unit tests. The check is honour-system only — see
 * the security note in `.workstream-status.md`.
 */
export function checkApproverAllowlist(
  policy: PromotionPolicy,
  decidedBy: string | undefined,
): string | null {
  const raw = (policy.gateConfig as { approvers?: unknown }).approvers;
  if (raw === undefined || raw === null) return null;
  if (!Array.isArray(raw)) {
    return `promotion policy ${policy.id} has malformed gate_config.approvers (expected array of strings)`;
  }
  const approvers = raw.filter((s): s is string => typeof s === "string");
  if (approvers.length === 0) return null;
  if (!decidedBy || decidedBy.length === 0) {
    return `promotion policy ${policy.id} requires --decided-by; allowed approvers: ${approvers.join(", ")}`;
  }
  if (!approvers.includes(decidedBy)) {
    return `'${decidedBy}' is not in the approver allow-list for promotion policy ${policy.id}: ${approvers.join(", ")}`;
  }
  return null;
}

/**
 * Promotion-state lookup for `signalman release show`. Returns the
 * approval rows attached to this release across all dest targets.
 */
export async function runReleasePromotionState(
  controlPlane: ControlPlane,
  input: { releaseId: string },
): Promise<ApprovalEntry[]> {
  const orgId = await getActiveOrgId(controlPlane);
  const all = await controlPlane.approvals.listForOrg(orgId, { limit: 200 });
  const relevant = all.filter((a) => a.releaseId === input.releaseId);
  const out: ApprovalEntry[] = [];
  for (const a of relevant) {
    const policy = await controlPlane.promotionPolicies.get(a.policyId);
    const release = await controlPlane.releases.get(a.releaseId);
    const destTarget = await controlPlane.targets.get(a.destTargetId);
    out.push({ approval: a, policy, release, destTarget });
  }
  return out;
}
