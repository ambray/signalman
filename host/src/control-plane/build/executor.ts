/**
 * Build executor — runs the declared components for a product at a
 * specific revision, captures the artifacts, and writes a release row.
 *
 * Inputs are a `workDir` (already-checked-out source tree) and a
 * `commitSha`. Cloning/checkout is the caller's job — this lets us
 * unit-test against synthetic "product repos" without network. The
 * higher-level CLI verb (`signalman release build`) is what shells to
 * git first.
 *
 * Failure modes:
 *   * `BuildYamlValidationError` — invalid signalman.build.yaml
 *   * `ComponentBuildError`     — a build command exited non-zero
 *   * `MissingArtifactError`    — a declared artifact path was absent
 *                                  after the build (the "forgot to
 *                                  build the dashboard" guard)
 *   * `ReleaseAlreadyExistsError` — a ready release exists for this
 *                                    (product, tag) pair
 *
 * On any failure mid-build, the release row is marked `status=failed`
 * (with the cause in the audit log) and the error is re-thrown.
 *
 * Build runs are serial across components in v0.2 (see design doc
 * §13.4); parallelism is a v0.3+ concern.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as YAML from "yaml";
import type { ControlPlane } from "../index.js";
import type {
  Artifact,
  ArtifactKind,
  Release,
} from "../types.js";
import {
  type BuildArtifact,
  type BuildComponent,
  type BuildVariables,
  type BuildYaml,
  substituteComponent,
  validateBuildYaml,
} from "./yaml.js";
import {
  buildManifest,
  hashManifest,
  type ManifestEntry,
  type ReleaseManifest,
} from "./manifest.js";

export class ComponentBuildError extends Error {
  constructor(
    readonly component: string,
    readonly exitCode: number | null,
    readonly stderrTail: string,
  ) {
    super(
      `component '${component}' build failed (exit=${exitCode ?? "signal"}):\n${stderrTail}`,
    );
    this.name = "ComponentBuildError";
  }
}

export class MissingArtifactError extends Error {
  constructor(
    readonly component: string,
    readonly artifactPath: string,
  ) {
    super(
      `component '${component}' build completed but declared artifact ${artifactPath} was not produced`,
    );
    this.name = "MissingArtifactError";
  }
}

export class ReleaseAlreadyExistsError extends Error {
  constructor(productName: string, tag: string) {
    super(
      `release ${productName}@${tag} already exists with status=ready; refusing to rebuild ` +
        `(soft-delete it to force a rebuild, or use a different tag)`,
    );
    this.name = "ReleaseAlreadyExistsError";
  }
}

export interface RunBuildOptions {
  controlPlane: ControlPlane;
  orgId: string;
  productId: string;
  tag: string;
  commitSha: string;
  /** Filesystem path to an already-checked-out source tree at `tag`. */
  workDir: string;
  /** Default: `<hostname>:<pid>`. */
  runnerId?: string;
  /** Audit-log actor. Default: `cli`. */
  actor?: string;
  /**
   * Optional progress sink for component-build stdout/stderr. Defaults
   * to inheriting process.stderr.
   */
  out?: NodeJS.WritableStream;
}

export interface RunBuildResult {
  release: Release;
  manifest: ReleaseManifest;
  manifestSha256: string;
  artifacts: Artifact[];
}

const STDERR_TAIL_BYTES = 4096;

export async function runBuild(opts: RunBuildOptions): Promise<RunBuildResult> {
  const { controlPlane, orgId, productId, tag, commitSha, workDir } = opts;
  const runnerId = opts.runnerId ?? `${os.hostname()}:${process.pid}`;
  const actor = opts.actor ?? "cli";
  const out = opts.out ?? process.stderr;

  const product = await controlPlane.products.get(productId);
  if (!product) {
    throw new Error(`product not found: ${productId}`);
  }

  // Resolve / replace any existing release for this (product, tag).
  const existing = await controlPlane.releases.getByTag(productId, tag);
  if (existing) {
    if (existing.status === "ready") {
      throw new ReleaseAlreadyExistsError(product.name, tag);
    }
    // Stuck/failed previous run — soft-delete and rebuild from scratch.
    await controlPlane.releases.softDelete(existing.id);
  }

  // Parse + validate build.yaml.
  const buildYamlPath = path.join(workDir, product.buildYamlPath);
  let parsed: BuildYaml;
  try {
    const raw = await fsp.readFile(buildYamlPath, "utf-8");
    const yamlDoc = YAML.parse(raw) as unknown;
    parsed = validateBuildYaml(yamlDoc);
  } catch (err) {
    // Surface yaml errors before we even create a release row — there
    // is no useful release-failure state to record yet.
    throw new Error(
      `failed to read or validate ${product.buildYamlPath} at ${buildYamlPath}: ${(err as Error).message}`,
    );
  }

  const vars: BuildVariables = {
    TAG: tag,
    COMMIT_SHA: commitSha,
    COMMIT_SHORT: commitSha.slice(0, 7),
  };

  const release = await controlPlane.releases.create({
    orgId,
    productId,
    tag,
    commitSha,
    status: "building",
  });

  await controlPlane.auditLog.append({
    orgId,
    actor,
    action: "release.build.started",
    entityType: "release",
    entityId: release.id,
    detail: { tag, commitSha, runnerId },
  });

  const artifactRows: Artifact[] = [];
  const manifestEntries: ManifestEntry[] = [];

  try {
    for (const componentRaw of parsed.components) {
      const component = substituteComponent(componentRaw, vars);
      out.write(`[release build] component '${component.name}'\n`);

      await runComponentBuild({ component, workDir, out });

      // Run produce-step for blob artifacts (post-build).
      for (const art of component.artifacts) {
        if (art.kind === "blob" && art.produce) {
          out.write(`[release build]   produce: ${art.produce}\n`);
          await runShellCommand({ command: art.produce, cwd: workDir, out });
        }
      }

      // Verify every declared artifact + upload blobs.
      for (const art of component.artifacts) {
        const { row, entry } = await captureArtifact({
          controlPlane,
          orgId,
          releaseId: release.id,
          component: component.name,
          art,
          workDir,
        });
        artifactRows.push(row);
        manifestEntries.push(entry);
      }
    }

    const manifest = buildManifest({
      product: product.name,
      tag,
      commitSha,
      entries: manifestEntries,
    });
    const manifestSha256 = hashManifest(manifest);

    const finished = await controlPlane.releases.update(release.id, {
      status: "ready",
      manifestSha256,
      builtAt: new Date().toISOString(),
      builtByRunnerId: runnerId,
      // Persist the parsed build.yaml so the deploy executor + health
      // verbs can rediscover probes without re-cloning the source tree.
      buildYamlJson: JSON.stringify(parsed),
    });

    await controlPlane.auditLog.append({
      orgId,
      actor,
      action: "release.build.completed",
      entityType: "release",
      entityId: release.id,
      detail: { tag, manifestSha256, artifactCount: artifactRows.length },
    });

    return { release: finished, manifest, manifestSha256, artifacts: artifactRows };
  } catch (err) {
    const detail =
      err instanceof Error ? { error: err.message, name: err.name } : { error: String(err) };
    try {
      await controlPlane.releases.update(release.id, { status: "failed" });
    } catch {
      // Don't mask the original error if we can't record the failure.
    }
    await controlPlane.auditLog.append({
      orgId,
      actor,
      action: "release.build.failed",
      entityType: "release",
      entityId: release.id,
      detail,
    });
    throw err;
  }
}

// ── Component execution ─────────────────────────────────────────────

async function runComponentBuild(input: {
  component: BuildComponent;
  workDir: string;
  out: NodeJS.WritableStream;
}): Promise<void> {
  const { component, workDir, out } = input;
  const cwd = component.build.cwd
    ? path.resolve(workDir, component.build.cwd)
    : workDir;
  const args = component.build.args ?? [];
  out.write(`[release build]   $ ${component.build.command} ${args.join(" ")}\n`);
  await runRawCommand({
    componentName: component.name,
    command: component.build.command,
    args,
    cwd,
    env: component.build.env,
    out,
  });
}

interface RawCommandInput {
  componentName: string;
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  out: NodeJS.WritableStream;
}

function runRawCommand(input: RawCommandInput): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      env: { ...process.env, ...(input.env ?? {}) },
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });

    let stderrTail = Buffer.alloc(0);
    child.stdout.on("data", (chunk) => input.out.write(chunk));
    child.stderr.on("data", (chunk) => {
      input.out.write(chunk);
      stderrTail = Buffer.concat([stderrTail, chunk]);
      if (stderrTail.length > STDERR_TAIL_BYTES) {
        stderrTail = stderrTail.subarray(stderrTail.length - STDERR_TAIL_BYTES);
      }
    });

    child.on("error", (err) => reject(err));
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(
          new ComponentBuildError(input.componentName, code, stderrTail.toString("utf-8")),
        );
      }
    });
  });
}

interface ShellCommandInput {
  command: string;
  cwd: string;
  out: NodeJS.WritableStream;
}

function runShellCommand(input: ShellCommandInput): Promise<void> {
  // Platform shell: cmd.exe on Windows, sh on POSIX. The produce step
  // is intentionally a single shell line, not a structured invocation,
  // so the operator can write `tar -czf foo.tar.gz dir | something`.
  const onWindows = process.platform === "win32";
  const shell = onWindows ? "cmd.exe" : "sh";
  const shellArgs = onWindows ? ["/d", "/s", "/c", input.command] : ["-c", input.command];
  return runRawCommand({
    componentName: "<produce>",
    command: shell,
    args: shellArgs,
    cwd: input.cwd,
    out: input.out,
  });
}

// ── Artifact capture ────────────────────────────────────────────────

async function captureArtifact(input: {
  controlPlane: ControlPlane;
  orgId: string;
  releaseId: string;
  component: string;
  art: BuildArtifact;
  workDir: string;
}): Promise<{ row: Artifact; entry: ManifestEntry }> {
  const { controlPlane, orgId, releaseId, component, art, workDir } = input;
  if (art.kind === "image_ref") {
    const row = await controlPlane.artifacts.create({
      releaseId,
      component,
      kind: "image_ref" as ArtifactKind,
      imageRef: art.ref,
    });
    return {
      row,
      entry: { component, kind: "image_ref", image_ref: art.ref },
    };
  }

  // kind === 'blob'
  const filePath = path.resolve(workDir, art.path);
  if (!fs.existsSync(filePath)) {
    throw new MissingArtifactError(component, art.path);
  }
  const stat = await fsp.stat(filePath);
  if (!stat.isFile()) {
    throw new MissingArtifactError(component, art.path);
  }
  const stream = fs.createReadStream(filePath);
  const blob = await controlPlane.blobs.put({ orgId, body: stream });
  const row = await controlPlane.artifacts.create({
    releaseId,
    component,
    kind: "blob" as ArtifactKind,
    sha256: blob.sha256,
    sizeBytes: blob.size,
    blobUri: blob.uri,
  });
  return {
    row,
    entry: { component, kind: "blob", sha256: blob.sha256 },
  };
}
