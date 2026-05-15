/**
 * WS6 M9 — public surface of the runner-deploy module.
 *
 * The top-level `runRunnerDeploy` verb is the single entry point
 * from the CLI / MCP layer. Internally it:
 *
 *   1. Validates the operator-supplied `RunnerBinaryRef`
 *   2. Selects the right transport (script / ssh / winrm / docker /
 *      cloud) based on `opts.transport.kind`
 *   3. Calls `transport.bootstrap(common, opts.transport, exec)`
 *   4. Optionally waits for the runner to heartbeat (verification)
 *   5. Audit-logs the deployment outcome
 *
 * The cloud transport requires extra deps (provision + getIp); the
 * verb wires them through `defaultCloudTransportDeps` against the
 * cloud backend registry.
 */

import type { ControlPlane } from "../../control-plane/index.js";
import { CloudTransport, type CloudTransportDeps } from "./cloud.js";
import { DockerTransport } from "./docker.js";
import { ScriptTransport } from "./script.js";
import { SshTransport } from "./ssh.js";
import { WinRmTransport } from "./winrm.js";
import {
  defaultTransportExec,
  type BootstrapCommonOptions,
  type BootstrapResult,
  type RunnerDeployTransport,
  type TransportExec,
  type TransportOptions,
} from "./transport.js";
import { validateBinaryRef, type RunnerBinaryRef } from "./binary.js";
import {
  waitForRunnerHeartbeat,
  type WaitForHeartbeatResult,
} from "./heartbeat-wait.js";

export type {
  RunnerBinaryRef,
} from "./binary.js";
export {
  validateBinaryRef,
  parseBlobUrlSha256,
  resolveExpectedSha256,
} from "./binary.js";
export type {
  BootstrapCommonOptions,
  BootstrapResult,
  RunnerDeployTransport,
  RunnerDeployTransportKind,
  ScriptTransportOptions,
  SshTransportOptions,
  WinRmTransportOptions,
  DockerTransportOptions,
  CloudTransportOptions,
  TransportOptions,
  TransportExec,
} from "./transport.js";
export { defaultTransportExec } from "./transport.js";
export { ScriptTransport } from "./script.js";
export {
  SshTransport,
  buildSshInstallCommands,
  buildRunnerYaml,
  scpArgs,
} from "./ssh.js";
export {
  WinRmTransport,
  buildWinRmScript,
  buildWinRmInvokeArgs,
} from "./winrm.js";
export {
  DockerTransport,
  buildDockerPullArgs,
  buildDockerRmArgs,
  buildDockerRunArgs,
} from "./docker.js";
export { CloudTransport } from "./cloud.js";
export type { CloudTransportDeps } from "./cloud.js";
export {
  waitForRunnerHeartbeat,
} from "./heartbeat-wait.js";
export type {
  WaitForHeartbeatOptions,
  WaitForHeartbeatResult,
} from "./heartbeat-wait.js";

/**
 * Input to `runRunnerDeploy`. Combines the common bootstrap options
 * with the transport-specific options under `transport`.
 */
export interface RunRunnerDeployInput {
  binary: RunnerBinaryRef;
  controlPlaneUrl: string;
  token: string;
  workerName: string;
  transport: TransportOptions;
  /**
   * Wait for the runner to heartbeat after bootstrap. Default
   * 60000ms; pass 0 to disable verification (e.g. for the script
   * transport, where the operator runs the script later).
   */
  waitTimeoutMs?: number;
  /**
   * Org id for the heartbeat-wait lookup. Defaults to "default".
   */
  orgId?: string;
  actor?: string;
  out?: NodeJS.WritableStream;
  /** Injectable for tests. */
  exec?: TransportExec;
  /**
   * Injectable transport map for tests — override with stubs that
   * record args without doing real work. Production wires through
   * the bundled implementations.
   */
  transportRegistry?: Partial<Record<TransportOptions["kind"], RunnerDeployTransport>>;
  /**
   * Cloud transport deps. Required when `transport.kind === 'cloud'`
   * and the default registry isn't being used; tests inject stubs.
   */
  cloudDeps?: CloudTransportDeps;
}

export interface RunRunnerDeployResult {
  bootstrap: BootstrapResult;
  /** undefined when waitTimeoutMs=0 (verification disabled). */
  verification?: WaitForHeartbeatResult;
}

/**
 * Build the default cloud-transport deps by wiring through the
 * registered cloud backend. Used by the production runRunnerDeploy
 * path; tests inject their own.
 */
async function defaultCloudTransportDeps(): Promise<CloudTransportDeps> {
  return {
    provision: async (input) => {
      const { getCloudBackend } = await import("../../cloud/registry.js");
      const backend = getCloudBackend(input.provider);
      const handle = await backend.provisionInstance({
        region: input.region,
        instance_type: input.instanceType,
        image_ref: input.imageRef,
        name: input.name,
        org_id: input.orgId ?? "default",
        ttl_minutes: input.ttlMinutes ?? 60,
      });
      return {
        id: handle.id,
        backend: handle.backend as "aws" | "azure",
        name: handle.name,
        region: handle.region,
      };
    },
    getIp: async (handle) => {
      const { getCloudBackend } = await import("../../cloud/registry.js");
      const backend = getCloudBackend(handle.backend);
      return backend.getInstanceIp({
        id: handle.id,
        backend: handle.backend,
        name: handle.name,
        region: handle.region,
      });
    },
  };
}

/**
 * Build a transport for a given kind. Falls back to the bundled
 * implementations if the caller didn't override.
 */
async function selectTransport(
  kind: TransportOptions["kind"],
  registry: Partial<Record<TransportOptions["kind"], RunnerDeployTransport>> | undefined,
  cloudDeps: CloudTransportDeps | undefined,
): Promise<RunnerDeployTransport> {
  if (registry && registry[kind]) return registry[kind] as RunnerDeployTransport;
  switch (kind) {
    case "script":
      return new ScriptTransport();
    case "ssh":
      return new SshTransport();
    case "winrm":
      return new WinRmTransport();
    case "docker":
      return new DockerTransport();
    case "cloud":
      return new CloudTransport(cloudDeps ?? (await defaultCloudTransportDeps()));
    default: {
      const exhaustive: never = kind;
      throw new Error(`runRunnerDeploy: unknown transport kind ${exhaustive as string}`);
    }
  }
}

/**
 * WS6 M9 top-level verb. Dispatches on `transport.kind` and
 * orchestrates bootstrap + verification + audit.
 */
export async function runRunnerDeploy(
  controlPlane: ControlPlane,
  input: RunRunnerDeployInput,
): Promise<RunRunnerDeployResult> {
  validateBinaryRef(input.binary);
  const actor = input.actor ?? "cli";
  const orgIdForAudit = input.orgId ?? "default";
  const out = input.out ?? process.stderr;
  const exec = input.exec ?? defaultTransportExec;

  // Resolve orgId properly: callers from the verb layer typically
  // pass through the active orgId, but for unit-test simplicity we
  // default to "default". The audit-log row carries it.
  const transport = await selectTransport(
    input.transport.kind,
    input.transportRegistry,
    input.cloudDeps,
  );

  const common: BootstrapCommonOptions = {
    binary: input.binary,
    controlPlaneUrl: input.controlPlaneUrl,
    token: input.token,
    workerName: input.workerName,
    actor,
    out,
  };

  const bootstrapStartIso = new Date().toISOString();
  await controlPlane.auditLog.append({
    orgId: orgIdForAudit,
    actor,
    action: "runner.deploy.started",
    entityType: "runner",
    entityId: input.workerName,
    detail: {
      transport: input.transport.kind,
      binary_url: input.binary.url,
      binary_sha256_pinned: !!input.binary.sha256,
      control_plane_url: input.controlPlaneUrl,
    },
  });

  let bootstrap: BootstrapResult;
  try {
    bootstrap = await transport.bootstrap(common, input.transport, exec);
  } catch (err) {
    await controlPlane.auditLog.append({
      orgId: orgIdForAudit,
      actor,
      action: "runner.deploy.failed",
      entityType: "runner",
      entityId: input.workerName,
      detail: {
        transport: input.transport.kind,
        error: (err as Error).message,
      },
    });
    throw err;
  }

  await controlPlane.auditLog.append({
    orgId: orgIdForAudit,
    actor,
    action: "runner.deploy.bootstrapped",
    entityType: "runner",
    entityId: input.workerName,
    detail: bootstrap.detail,
  });

  // Optional verification: wait for the runner to heartbeat.
  const waitTimeoutMs = input.waitTimeoutMs ?? 60_000;
  if (waitTimeoutMs > 0 && input.transport.kind !== "script") {
    // Script transport produces a script the operator runs later;
    // verification doesn't apply at deploy time.
    const verification = await waitForRunnerHeartbeat(controlPlane, {
      orgId: orgIdForAudit,
      workerName: input.workerName,
      waitTimeoutMs,
      freshAfter: new Date(bootstrapStartIso),
    });
    if (!verification.heartbeated) {
      await controlPlane.auditLog.append({
        orgId: orgIdForAudit,
        actor,
        action: "runner.deploy.verification_failed",
        entityType: "runner",
        entityId: input.workerName,
        detail: { verification_reason: verification.reason },
      });
    } else {
      await controlPlane.auditLog.append({
        orgId: orgIdForAudit,
        actor,
        action: "runner.deploy.verified",
        entityType: "runner",
        entityId: input.workerName,
        detail: {
          elapsed_ms: verification.elapsedMs,
          last_seen_at: verification.lastSeenAt,
        },
      });
    }
    return { bootstrap, verification };
  }

  return { bootstrap };
}
