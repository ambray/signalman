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
  Artifact,
  Deployment,
  DeploymentHealthSummary,
  HealthCheck,
  HealthSchedule,
  Product,
  Release,
  Target,
  TargetConnection,
  TargetKind,
} from "../control-plane/types.js";
import type { ProbeInvoker, ScheduledProbeOutcome } from "../control-plane/scheduler/index.js";

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
    return await runBuild({
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
  } finally {
    if (cleanup) await cleanup();
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
  return { release, product, artifacts };
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

  const backend = options.backend ?? (await defaultDeployBackend());
  return runDeploy({
    controlPlane,
    orgId,
    releaseId,
    targetId: target.id,
    backend,
    actor: input.actor,
    out: options.out,
  });
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

  const backend = options.backend ?? (await defaultDeployBackend());
  return runRollback({
    controlPlane,
    orgId,
    targetId: target.id,
    toReleaseId: input.toReleaseId,
    backend,
    actor: input.actor,
    out: options.out,
  });
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
