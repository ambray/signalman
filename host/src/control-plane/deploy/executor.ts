/**
 * Deploy executor — atomically install a release onto a target VM.
 *
 * Flow (per docs/design/meta-build-system.md §7.2):
 *   1. Create new deployment row (status=pending), with previous-active
 *      recorded so rollback can find it.
 *   2. Take a pre-deploy checkpoint of the VM.
 *   3. Stage every blob artifact into `C:/signalman-staging/<release_id>/`
 *      and write a `manifest.json` alongside.
 *   4. Run the `vm_reachable` health probe.
 *   5. On success: supersede the prior active deployment, mark this one
 *      active, delete the pre-deploy checkpoint.
 *   6. On any failure: restore the pre-deploy checkpoint, mark this
 *      deployment failed, audit-log the cause.
 *
 * Install execution (running msiexec / sc.exe / docker run inside the
 * VM) is intentionally out of scope for PR 3. The operator can drive
 * the installed bits from the staging dir via existing `signalman vm
 * exec` until PR 4+ lands a declarative install grammar.
 *
 * The executor depends on a `DeployBackend` interface so tests can
 * inject a fake without standing up Hyper-V. The real backend
 * (HypervisorDeployBackend) wraps the existing HypervisorBackend.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pipeline } from "node:stream/promises";
import type { VMHandle } from "../../hypervisors/interface.js";
import type { ControlPlane } from "../index.js";
import { validateBuildYaml, type BuildYaml } from "../build/yaml.js";
import { runProbes, type ProbeResult } from "../probes/index.js";
import type {
  Artifact,
  Deployment,
  DeploymentHealthSummary,
  HealthStatus,
  Release,
  Target,
} from "../types.js";
import type { DeployBackend } from "./backend.js";

export class DeployBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeployBlockedError";
  }
}

export class DeployHealthFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeployHealthFailedError";
  }
}

export interface RunDeployOptions {
  controlPlane: ControlPlane;
  orgId: string;
  releaseId: string;
  targetId: string;
  backend: DeployBackend;
  /** Audit-log actor (default: 'cli'). */
  actor?: string;
  /** Progress sink for stage/copy chatter. Default: process.stderr. */
  out?: NodeJS.WritableStream;
  /** Override staging root in the guest. Default: `C:/signalman-staging`. */
  guestStagingRoot?: string;
}

export interface RunDeployResult {
  deployment: Deployment;
  release: Release;
  target: Target;
  artifacts: Artifact[];
  healthSummary: DeploymentHealthSummary;
}

export async function runDeploy(opts: RunDeployOptions): Promise<RunDeployResult> {
  const { controlPlane, orgId, backend } = opts;
  const actor = opts.actor ?? "cli";
  const out = opts.out ?? process.stderr;
  const guestStagingRoot = opts.guestStagingRoot ?? "C:/signalman-staging";

  const release = await controlPlane.releases.get(opts.releaseId);
  if (!release) throw new Error(`release not found: ${opts.releaseId}`);
  if (release.status !== "ready") {
    throw new DeployBlockedError(
      `release ${release.id} is not ready (status=${release.status})`,
    );
  }

  const target = await controlPlane.targets.get(opts.targetId);
  if (!target) throw new Error(`target not found: ${opts.targetId}`);
  if (target.orgId !== orgId) {
    throw new Error(`target ${target.id} belongs to a different org`);
  }

  const previousActive = await controlPlane.deployments.getActiveForTarget(target.id);
  const artifacts = await controlPlane.artifacts.listForRelease(release.id);

  const { handle, vmName } = await backend.resolveVm(target.connection);
  out.write(`[release deploy] target VM '${vmName}'\n`);

  const deployment = await controlPlane.deployments.create({
    orgId,
    releaseId: release.id,
    targetId: target.id,
    previousDeploymentId: previousActive?.id,
  });

  await controlPlane.auditLog.append({
    orgId,
    actor,
    action: "release.deploy.started",
    entityType: "deployment",
    entityId: deployment.id,
    detail: { releaseId: release.id, targetId: target.id },
  });

  // Pre-deploy checkpoint — staging-then-promote lever for rollback on
  // failure (design §7.2). On success we delete the checkpoint; rollback
  // proper is "redeploy the previous release", not "restore this
  // checkpoint."
  const checkpointLabel = `signalman-pre-${deployment.id}`;
  out.write(`[release deploy] creating checkpoint '${checkpointLabel}'\n`);
  const checkpoint = await backend.createCheckpoint(handle, checkpointLabel);

  await controlPlane.deployments.update(deployment.id, {
    status: "deploying",
    startedAt: new Date().toISOString(),
  });

  try {
    // Stage every blob artifact + a human-readable manifest.json.
    const stagingDir = `${guestStagingRoot}/${release.id}`;
    out.write(`[release deploy] staging into ${stagingDir}\n`);
    for (const art of artifacts) {
      if (art.kind !== "blob") continue;
      if (!art.blobUri) {
        throw new Error(`artifact ${art.id} has kind=blob but no blob_uri`);
      }
      const guestPath = `${stagingDir}/${art.component}.bin`;
      out.write(`[release deploy]   ${art.component} → ${guestPath}\n`);
      await stageBlobInto({ controlPlane, art, handle, guestPath, backend });
    }

    const manifestJson = buildDeployManifest({
      release,
      target,
      artifacts,
      deploymentId: deployment.id,
    });
    const manifestPath = `${stagingDir}/manifest.json`;
    out.write(`[release deploy]   manifest.json → ${manifestPath}\n`);
    await stageStringInto({
      contents: JSON.stringify(manifestJson, null, 2),
      handle,
      guestPath: manifestPath,
      backend,
    });

    // Health probes — two layers (per docs/design/meta-build-system.md §8):
    //   1. `vm_reachable` floor: VM is running. Cheap precondition.
    //   2. Declarative probes from signalman.build.yaml: product-specific
    //      checks (services up, /health 200, files in place, etc).
    out.write(`[release deploy] running health probes\n`);
    const reachability = await backend.isVmReachable(handle);
    const reachabilityStatus: HealthStatus = reachability.reachable ? "pass" : "fail";
    await controlPlane.healthChecks.append({
      deploymentId: deployment.id,
      probeName: "vm_reachable",
      status: reachabilityStatus,
      detail: reachability.detail,
    });
    if (!reachability.reachable) {
      throw new DeployHealthFailedError(
        `vm_reachable probe failed: ${reachability.detail ?? "unknown reason"}`,
      );
    }

    // Declared probes from the release's frozen build.yaml (set by the
    // build executor; null for releases that predate PR 4).
    const declared = parseDeclaredProbes(release, out);
    const probeResults: ProbeResult[] = declared.length
      ? await runProbes(declared, handle, backend)
      : [];
    for (const r of probeResults) {
      await controlPlane.healthChecks.append({
        deploymentId: deployment.id,
        probeName: r.name,
        status: r.status,
        latencyMs: r.latencyMs,
        detail: r.detail,
      });
    }

    const allChecks: { status: HealthStatus }[] = [
      { status: reachabilityStatus },
      ...probeResults,
    ];
    const pass = allChecks.filter((c) => c.status === "pass").length;
    const fail = allChecks.filter((c) => c.status === "fail").length;
    const degraded = allChecks.filter((c) => c.status === "degraded").length;
    const healthSummary: DeploymentHealthSummary = {
      total: allChecks.length,
      pass,
      fail,
      degraded,
      lastCheckedAt: new Date().toISOString(),
    };

    if (fail > 0) {
      const failed = probeResults.filter((r) => r.status === "fail");
      throw new DeployHealthFailedError(
        `${failed.length} declared probe(s) failed: ${failed
          .map((r) => `${r.name} (${r.detail})`)
          .join("; ")}`,
      );
    }

    // Promote: supersede prior active (ordered to satisfy the unique
    // partial index on target_id WHERE status='active'), then mark
    // this deployment active.
    if (previousActive) {
      await controlPlane.deployments.update(previousActive.id, {
        status: "superseded",
      });
    }
    const finishedAt = new Date().toISOString();
    const finalized = await controlPlane.deployments.update(deployment.id, {
      status: "active",
      completedAt: finishedAt,
      healthSummary,
    });

    // Drop the pre-deploy checkpoint — the rollback path doesn't use
    // it; rolling back redeploys the prior release.
    out.write(`[release deploy] success — dropping checkpoint '${checkpointLabel}'\n`);
    await backend.deleteCheckpoint(checkpoint);

    await controlPlane.auditLog.append({
      orgId,
      actor,
      action: "release.deploy.completed",
      entityType: "deployment",
      entityId: deployment.id,
      detail: { releaseId: release.id, targetId: target.id, supersededId: previousActive?.id },
    });

    return {
      deployment: finalized,
      release,
      target,
      artifacts,
      healthSummary,
    };
  } catch (err) {
    out.write(`[release deploy] FAILED — restoring '${checkpointLabel}'\n`);
    try {
      await backend.restoreCheckpoint(checkpoint);
    } catch (restoreErr) {
      out.write(
        `[release deploy] restore-checkpoint also failed: ${(restoreErr as Error).message}\n`,
      );
    }
    try {
      await backend.deleteCheckpoint(checkpoint);
    } catch {
      // Best-effort cleanup; the operator may need to clean up by hand.
    }
    try {
      await controlPlane.deployments.update(deployment.id, {
        status: "failed",
        completedAt: new Date().toISOString(),
      });
    } catch {
      // Don't mask the original error.
    }
    await controlPlane.auditLog.append({
      orgId,
      actor,
      action: "release.deploy.failed",
      entityType: "deployment",
      entityId: deployment.id,
      detail: {
        releaseId: release.id,
        targetId: target.id,
        error: (err as Error).message,
        errorName: (err as Error).name,
      },
    });
    throw err;
  }
}

export interface RunRollbackOptions {
  controlPlane: ControlPlane;
  orgId: string;
  targetId: string;
  /** Optional: roll back to a specific release. Default: previous superseded. */
  toReleaseId?: string;
  backend: DeployBackend;
  actor?: string;
  out?: NodeJS.WritableStream;
}

export async function runRollback(opts: RunRollbackOptions): Promise<RunDeployResult> {
  const { controlPlane, orgId, targetId } = opts;
  const out = opts.out ?? process.stderr;

  const target = await controlPlane.targets.get(targetId);
  if (!target) throw new Error(`target not found: ${targetId}`);

  let releaseId = opts.toReleaseId;
  if (!releaseId) {
    const history = await controlPlane.deployments.listForTarget(target.id, { limit: 10 });
    const superseded = history.find((d) => d.status === "superseded");
    if (!superseded) {
      throw new DeployBlockedError(
        `no superseded deployment found on target '${target.name}' to roll back to. ` +
          `Use --release to specify an explicit prior release.`,
      );
    }
    releaseId = superseded.releaseId;
  }

  out.write(`[release rollback] target '${target.name}' → release ${releaseId}\n`);
  return runDeploy({
    controlPlane,
    orgId,
    releaseId,
    targetId,
    backend: opts.backend,
    actor: opts.actor ?? "cli-rollback",
    out,
  });
}

// ── Helpers ─────────────────────────────────────────────────────────

interface StageBlobInput {
  controlPlane: ControlPlane;
  art: Artifact;
  handle: VMHandle;
  guestPath: string;
  backend: DeployBackend;
}

async function stageBlobInto(input: StageBlobInput): Promise<void> {
  // copyFileToVM works on host filesystem paths, not streams — so we
  // materialize the blob to a host temp file first, copy it in, then
  // delete the temp. The blob driver dedupes by sha256 server-side
  // so a temp materialize is the right shape.
  const stream = await input.controlPlane.blobs.get(input.art.blobUri!);
  const tmp = path.join(
    os.tmpdir(),
    `signalman-stage-${crypto.randomBytes(8).toString("hex")}.bin`,
  );
  try {
    await pipeline(stream, fs.createWriteStream(tmp));
    await input.backend.copyFileToVM(input.handle, tmp, input.guestPath);
  } finally {
    await fsp.unlink(tmp).catch(() => undefined);
  }
}

interface StageStringInput {
  contents: string;
  handle: VMHandle;
  guestPath: string;
  backend: DeployBackend;
}

async function stageStringInto(input: StageStringInput): Promise<void> {
  const tmp = path.join(
    os.tmpdir(),
    `signalman-stage-${crypto.randomBytes(8).toString("hex")}.txt`,
  );
  try {
    await fsp.writeFile(tmp, input.contents, "utf-8");
    await input.backend.copyFileToVM(input.handle, tmp, input.guestPath);
  } finally {
    await fsp.unlink(tmp).catch(() => undefined);
  }
}

/**
 * Pull declared probes off a release. Tolerates a null/empty/corrupt
 * `buildYamlJson` so old releases or partial builds don't break the
 * deploy path — they just run with no declared probes (vm_reachable
 * still gates).
 */
function parseDeclaredProbes(release: Release, out: NodeJS.WritableStream) {
  if (!release.buildYamlJson) return [];
  try {
    const parsed = JSON.parse(release.buildYamlJson) as unknown;
    const yaml: BuildYaml = validateBuildYaml(parsed);
    return yaml.probes ?? [];
  } catch (err) {
    out.write(
      `[release deploy] warning: failed to parse build_yaml_json on release ${release.id}: ${(err as Error).message}\n`,
    );
    return [];
  }
}

interface DeployManifestInput {
  release: Release;
  target: Target;
  artifacts: Artifact[];
  deploymentId: string;
}

/** The manifest.json staged into the VM alongside the artifacts. */
function buildDeployManifest(input: DeployManifestInput): Record<string, unknown> {
  return {
    schema_version: 1,
    release_id: input.release.id,
    release_tag: input.release.tag,
    commit_sha: input.release.commitSha,
    manifest_sha256: input.release.manifestSha256,
    deployment_id: input.deploymentId,
    target_name: input.target.name,
    target_kind: input.target.kind,
    artifacts: input.artifacts.map((a) => {
      const base: Record<string, unknown> = {
        component: a.component,
        kind: a.kind,
      };
      if (a.kind === "blob") {
        base.sha256 = a.sha256;
        base.size_bytes = a.sizeBytes;
        base.guest_filename = `${a.component}.bin`;
      } else {
        base.image_ref = a.imageRef;
      }
      return base;
    }),
  };
}
