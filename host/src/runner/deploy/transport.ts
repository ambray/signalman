/**
 * WS6 M9 — `RunnerDeployTransport` abstraction.
 *
 * Five concrete implementations live alongside this file:
 *
 *   - `script` — emit a bash/pwsh script the operator runs themselves.
 *                Lowest-risk; no cred handling, no remote exec from
 *                Signalman.
 *   - `ssh`    — shell out to `ssh` + `scp` to push the binary + write
 *                a systemd unit + start the service on a Linux/macOS
 *                target. Operator supplies an `IdentityFile` path.
 *   - `winrm`  — shell out to `pwsh` (`Invoke-Command -ComputerName`)
 *                to install the binary as a Windows service. Requires
 *                WinRM configured on the target + PowerShell on the
 *                operator's host.
 *   - `docker` — shell out to `docker run -d` (against a local or
 *                remote daemon via DOCKER_HOST / context). The runner
 *                lives in a container with the registration config
 *                mounted in.
 *   - `cloud`  — orchestrate `signalman_cloud_provision` then route to
 *                `ssh` or `winrm` via the resulting handle. Useful
 *                for "give me a fresh runner on AWS in us-east-1."
 *
 * Common to all transports:
 *   - The runner binary URL comes from the operator (typically a
 *     blob URL on a `@signalman/registry`); transports download it
 *     on the remote, optionally verifying sha256.
 *   - Registration uses the standard `signalman runner register`
 *     payload (control_plane_url + token + worker_name). The remote
 *     `runner.yaml` is written before the service starts.
 *   - After `bootstrap()` returns success, the top-level
 *     `runRunnerDeploy` verb optionally waits for the runner to
 *     heartbeat (`waitForRunnerHeartbeat`) before declaring success.
 *
 * Test strategy:
 *   - Every transport accepts an injectable `exec` for shell-outs +
 *     an injectable `writeFile` for remote file deliveries.
 *   - Unit tests verify argv construction + state-machine
 *     transitions; no real subprocess is spawned.
 *   - Integration testing against real SSH / WinRM / Docker / cloud
 *     targets is operator-driven; the abstraction's value is
 *     ergonomics + audit-trail, not bug-free remote bootstrap.
 */

import type { RunnerBinaryRef } from "./binary.js";

/** The five supported transport kinds. */
export type RunnerDeployTransportKind =
  | "script"
  | "ssh"
  | "winrm"
  | "docker"
  | "cloud";

/**
 * Operator-supplied options common to every bootstrap:
 *   - the runner binary to push
 *   - the registration payload the remote needs to talk to the
 *     control plane
 *   - a friendly worker name (used as the runners table key)
 */
export interface BootstrapCommonOptions {
  /** Where the runner binary comes from. */
  binary: RunnerBinaryRef;
  /** Control-plane URL the runner reports to. */
  controlPlaneUrl: string;
  /** API key the runner authenticates with. */
  token: string;
  /**
   * Friendly worker name. Surfaces in the runners table; defaults to
   * `<hostname>:<pid>` when omitted by the verb caller.
   */
  workerName: string;
  /** Audit-log actor. Default: 'cli'. */
  actor?: string;
  /** Progress sink for transport-specific chatter. Default: stderr. */
  out?: NodeJS.WritableStream;
}

/**
 * Captured result of a successful bootstrap. Transports return
 * what they did; the verb layer audit-logs it.
 */
export interface BootstrapResult {
  transport: RunnerDeployTransportKind;
  workerName: string;
  /** Transport-specific evidence (commands run, files written, etc). */
  detail: Record<string, unknown>;
  /**
   * For `script` transport ONLY: the script body the operator must
   * run themselves. Other transports leave this undefined.
   */
  script?: string;
}

/**
 * Pluggable shell-out spawner. Production wires through node:child_process
 * .spawn; tests inject a stub that records argv without actually
 * launching a process.
 *
 * Returns the captured stdout/stderr + exit code. Throws on spawn
 * error (binary not found, etc.) — exit-code != 0 is a non-throwing
 * return so transports can decide whether the exit code matters
 * (e.g. `ssh` returning 1 vs 255 carries different semantics).
 */
export interface TransportExec {
  (command: string, args: string[], opts?: {
    /** Bytes to send to the spawned process's stdin. */
    stdin?: string | Buffer;
    /** Per-call timeout. */
    timeoutMs?: number;
    /** Env merged over process.env. */
    env?: Record<string, string>;
  }): Promise<{
    stdout: string;
    stderr: string;
    exitCode: number;
  }>;
}

/**
 * Transport-specific options. Each impl narrows the union by
 * `kind`; the verb layer dispatches on it.
 */
export type TransportOptions =
  | ScriptTransportOptions
  | SshTransportOptions
  | WinRmTransportOptions
  | DockerTransportOptions
  | CloudTransportOptions;

export interface ScriptTransportOptions {
  kind: "script";
  /** Target OS family — controls bash vs pwsh emission. */
  os: "linux" | "macos" | "windows";
  /**
   * Optional output path: when set, the verb writes the script there
   * AND returns it; otherwise just returns it inline.
   */
  outputPath?: string;
}

export interface SshTransportOptions {
  kind: "ssh";
  /** Target host (`user@host` or just `host`). */
  host: string;
  /** Identity file (`-i <path>`). */
  identityPath: string;
  /** SSH port. Default 22. */
  port?: number;
  /**
   * Service-manager flavour. Defaults to `systemd` (Linux);
   * `launchd` (macOS) is supported. `none` skips service
   * installation — useful for ephemeral test runners.
   */
  serviceManager?: "systemd" | "launchd" | "none";
  /** Optional bastion / jumphost. */
  proxyJump?: string;
}

export interface WinRmTransportOptions {
  kind: "winrm";
  /** Target host. */
  host: string;
  /** Domain\\username. */
  username: string;
  /** Password (env-var hint preferred; this is operator-supplied). */
  password: string;
  /** WinRM port. Default 5985 (HTTP) or 5986 (HTTPS). */
  port?: number;
  /** Use HTTPS. Default true. */
  useSsl?: boolean;
}

export interface DockerTransportOptions {
  kind: "docker";
  /** Docker image tag for the runner. Operator-built. */
  image: string;
  /**
   * Docker context name. Empty / `default` uses the local daemon.
   * Remote daemons require `docker context create ...` ahead of time.
   */
  context?: string;
  /** Container name. Defaults to `signalman-runner-<workerName>`. */
  containerName?: string;
  /** Extra `-v` mount specs. */
  extraVolumes?: string[];
  /** Extra `-e KEY=VALUE` env pairs. */
  extraEnv?: Record<string, string>;
}

export interface CloudTransportOptions {
  kind: "cloud";
  /**
   * Cloud provision config (mirrors `signalman_cloud_provision`).
   * The transport invokes the registered cloud backend then routes
   * to `ssh` (Linux) or `winrm` (Windows) via the resulting handle.
   */
  provider: "aws" | "azure";
  region: string;
  instanceType: string;
  imageRef: string;
  name: string;
  osFamily: "linux" | "windows";
  /** Optional pre-existing SSH identity / WinRM creds for the inner transport. */
  innerSsh?: { identityPath: string };
  innerWinRm?: { username: string; password: string };
  /** Optional org_id for per-org credential injection. */
  orgId?: string;
  /** TTL in minutes; default 60. */
  ttlMinutes?: number;
}

/**
 * Each transport implementation conforms to this shape. Implementations
 * live in sibling files (script.ts, ssh.ts, etc.) and are dispatched
 * to from the runRunnerDeploy verb based on `opts.kind`.
 */
export interface RunnerDeployTransport {
  readonly kind: RunnerDeployTransportKind;
  bootstrap(
    common: BootstrapCommonOptions,
    opts: TransportOptions,
    exec: TransportExec,
  ): Promise<BootstrapResult>;
}

/**
 * Default exec — spawns the named binary with node:child_process.
 * Production callers omit the override; tests inject a stub.
 */
export async function defaultTransportExec(
  command: string,
  args: string[],
  opts: { stdin?: string | Buffer; timeoutMs?: number; env?: Record<string, string> } = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const { spawn } = await import("node:child_process");
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
    });
    let stdout = "";
    let stderr = "";
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          child.kill("SIGTERM");
          reject(new Error(`exec timeout: ${command} after ${opts.timeoutMs}ms`));
        }, opts.timeoutMs)
      : null;
    child.stdout.on("data", (b: Buffer) => {
      stdout += b.toString("utf-8");
    });
    child.stderr.on("data", (b: Buffer) => {
      stderr += b.toString("utf-8");
    });
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code ?? -1 });
    });
    if (opts.stdin !== undefined) {
      child.stdin.write(opts.stdin);
      child.stdin.end();
    }
  });
}
