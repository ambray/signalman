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
  HealthCheck,
  Product,
  Release,
  Target,
  TargetConnection,
  TargetKind,
} from "../control-plane/types.js";

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
