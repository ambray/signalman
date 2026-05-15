/**
 * AWS SSM Session Manager dialer (WS6 wave-3 carve-out #5).
 *
 * Opens a port-forwarding tunnel to a private EC2 instance via the
 * AWS Session Manager plugin. Used when a guest agent's network
 * mode is `aws_ssm` — the cloud VM has no public IP and the host
 * reaches the gRPC port through Session Manager.
 *
 * # Locked design (do not re-litigate)
 *
 * - **Shell out to the `aws` CLI.** Session Manager port
 *   forwarding requires the AWS-published session-manager-plugin
 *   binary; that plugin doesn't have a Node.js library surface.
 *   The CLI is the canonical operator path. No `@aws-sdk/client-
 *   ssm` dep is added.
 * - **Document `AWS-StartPortForwardingSession`.** This is the
 *   AWS-managed document for raw TCP port forwarding (without an
 *   intermediate host). We pass `portNumber` (the EC2 side) and
 *   `localPortNumber` (the host side) as parameters.
 * - **Ready detection: `"Waiting for connections"`.** The plugin
 *   prints this line on stdout exactly once when the tunnel is up.
 *   `open()` resolves at that point; until then we accumulate
 *   stdout + stderr into the error message in case the spawn
 *   fails.
 * - **Refuses non-`aws_ssm` descriptors.** A wrong-kind descriptor
 *   raises `DialerError('unsupported_descriptor')` synchronously
 *   inside `open()`. The {@link defaultDialerFor} helper in
 *   `./index.ts` routes by kind so callers don't manually pick.
 *
 * # What this module does NOT do
 *
 * - **No SDK-side session creation.** Operators set up their AWS
 *   credentials (env, profile, instance-profile, SSO) before
 *   running Signalman; the CLI inherits them. We pass `--profile`
 *   when the descriptor specifies one, but don't otherwise touch
 *   the credential chain.
 * - **No plugin install check.** When the plugin is missing the
 *   CLI prints a clear error to stderr and exits non-zero; we
 *   surface that verbatim as `tunnel_failed` and let the operator
 *   install it. Pre-flight checking the plugin would add a second
 *   CLI invocation per dial; not worth the cost.
 */

import { spawn } from "node:child_process";

import {
  DialerError,
  DIALER_CLOSE_GRACE_MS,
  DIALER_READY_TIMEOUT_MS,
  pickFreeLocalPort,
  wrapChildProcess,
  type CloudConnectionDescriptor,
  type Dialer,
  type DialerChildHandle,
  type DialerExec,
  type DialerHandle,
} from "./interface.js";

// ── Public constants ──────────────────────────────────────────────

/** Default `aws` CLI binary lookup. */
export const DEFAULT_AWS_BIN = "aws";

/**
 * The session-manager-plugin prints this line on stdout when the
 * port-forwarding tunnel is established. Match prefix only;
 * different plugin versions print slightly different suffixes.
 */
export const AWS_SSM_READY_MARKER = "Waiting for connections";

/** The Session Manager document used for raw TCP port forwarding. */
export const AWS_SSM_PORT_FORWARD_DOCUMENT = "AWS-StartPortForwardingSession";

// ── Options ───────────────────────────────────────────────────────

export interface AwsSsmDialerOptions {
  /**
   * Path to the `aws` binary. Defaults to {@link DEFAULT_AWS_BIN}
   * (looked up on PATH).
   */
  awsBin?: string;
  /**
   * Injectable spawner for tests. Production callers leave this
   * undefined; the dialer spawns the binary via
   * `node:child_process.spawn`.
   */
  exec?: DialerExec;
  /**
   * Override the ready-line wait timeout. Defaults to
   * {@link DIALER_READY_TIMEOUT_MS} (30s).
   */
  readyTimeoutMs?: number;
  /**
   * Override the SIGTERM→SIGKILL grace period. Defaults to
   * {@link DIALER_CLOSE_GRACE_MS} (5s).
   */
  closeGraceMs?: number;
  /**
   * Caller-supplied local port. When absent the dialer picks a
   * free one via {@link pickFreeLocalPort}.
   */
  localPort?: number;
}

// ── Argv construction ─────────────────────────────────────────────

/**
 * Build the argv vector passed to the `aws` CLI for a Session
 * Manager port-forwarding session. Exported so tests can assert
 * the exact argv without mocking the whole dial flow.
 */
export function buildAwsSsmArgs(
  descriptor: {
    instance_id: string;
    region: string;
    port: number;
    profile?: string;
  },
  localPort: number,
): string[] {
  const args: string[] = [];
  args.push("ssm", "start-session");
  args.push("--target", descriptor.instance_id);
  args.push("--region", descriptor.region);
  args.push("--document-name", AWS_SSM_PORT_FORWARD_DOCUMENT);
  args.push(
    "--parameters",
    `portNumber=${descriptor.port},localPortNumber=${localPort}`,
  );
  if (descriptor.profile && descriptor.profile.length > 0) {
    args.push("--profile", descriptor.profile);
  }
  return args;
}

// ── Dialer ────────────────────────────────────────────────────────

/**
 * AWS SSM Session Manager port-forwarding dialer. See module
 * header for design constraints.
 */
export class AwsSsmDialer implements Dialer {
  private readonly awsBin: string;
  private readonly exec: DialerExec;
  private readonly readyTimeoutMs: number;
  private readonly closeGraceMs: number;
  private readonly overrideLocalPort: number | undefined;

  constructor(options: AwsSsmDialerOptions = {}) {
    this.awsBin = options.awsBin ?? DEFAULT_AWS_BIN;
    this.exec = options.exec ?? defaultSsmExec;
    this.readyTimeoutMs = options.readyTimeoutMs ?? DIALER_READY_TIMEOUT_MS;
    this.closeGraceMs = options.closeGraceMs ?? DIALER_CLOSE_GRACE_MS;
    this.overrideLocalPort = options.localPort;
  }

  async open(descriptor: CloudConnectionDescriptor): Promise<DialerHandle> {
    if (descriptor.kind !== "aws_ssm") {
      throw new DialerError(
        "unsupported_descriptor",
        `AwsSsmDialer received descriptor of kind '${descriptor.kind}'; expected 'aws_ssm'`,
      );
    }

    const localPort =
      this.overrideLocalPort ?? (await pickFreeLocalPort());

    const args = buildAwsSsmArgs(descriptor, localPort);

    let child: DialerChildHandle;
    try {
      child = this.exec(this.awsBin, args, {});
    } catch (err) {
      throw new DialerError(
        "cli_not_found",
        `failed to spawn '${this.awsBin}': ${describeError(err)}`,
        err,
      );
    }

    await waitForReady(child, {
      readyMarker: AWS_SSM_READY_MARKER,
      timeoutMs: this.readyTimeoutMs,
      cliName: "aws ssm start-session",
    });

    return makeHandle(child, localPort, this.closeGraceMs);
  }
}

// ── Production-default spawner ────────────────────────────────────

const defaultSsmExec: DialerExec = (command, args, opts) => {
  const child = spawn(command, args, {
    env: opts.env ? { ...process.env, ...opts.env } : process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return wrapChildProcess(child);
};

// ── Shared helpers (exported so the Bastion dialer can reuse) ─────

/**
 * Wait for `readyMarker` to appear on stdout, or for the child to
 * exit before then, or for the timeout to fire — whichever happens
 * first. Resolves silently on ready; throws {@link DialerError} on
 * exit-before-ready or timeout.
 */
export async function waitForReady(
  child: DialerChildHandle,
  opts: { readyMarker: string; timeoutMs: number; cliName: string },
): Promise<void> {
  let stdoutBuf = "";
  let stderrBuf = "";

  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      // Best-effort kill; the caller's `open()` doesn't wait for
      // exit on this failure path.
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore — child may already be dead
      }
      reject(
        new DialerError(
          "tunnel_failed",
          `${opts.cliName}: tunnel did not become ready within ${opts.timeoutMs}ms. stdout=${truncate(stdoutBuf)} stderr=${truncate(stderrBuf)}`,
        ),
      );
    }, opts.timeoutMs);
    timer.unref?.();

    child.onStdout((chunk) => {
      if (settled) return;
      stdoutBuf += chunk;
      if (stdoutBuf.includes(opts.readyMarker)) {
        settled = true;
        clearTimeout(timer);
        resolve();
      }
    });

    child.onStderr((chunk) => {
      if (settled) return;
      stderrBuf += chunk;
    });

    child.onExit((code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const errCode = classifyExitFailure(stderrBuf);
      reject(
        new DialerError(
          errCode,
          `${opts.cliName} exited before tunnel was ready (code=${code ?? "null"}, signal=${signal ?? "null"}). stdout=${truncate(stdoutBuf)} stderr=${truncate(stderrBuf)}`,
        ),
      );
    });
  });
}

/**
 * Build a {@link DialerHandle} from a live child + chosen local
 * port. `close()` sends SIGTERM, waits up to `graceMs`, then
 * SIGKILL, and resolves once the child has exited. Exported so
 * the Bastion dialer can share the shape.
 */
export function makeHandle(
  child: DialerChildHandle,
  localPort: number,
  graceMs: number,
): DialerHandle {
  let closeStarted = false;
  let closePromise: Promise<void> | null = null;

  return {
    localPort,
    close(): Promise<void> {
      if (closePromise !== null) return closePromise;
      closeStarted = true;
      void closeStarted; // satisfy ts noUnusedLocals if it's tight
      closePromise = new Promise<void>((resolve) => {
        if (child.exited) {
          resolve();
          return;
        }
        let resolved = false;
        const finalise = () => {
          if (resolved) return;
          resolved = true;
          clearTimeout(killTimer);
          resolve();
        };
        child.onExit(() => finalise());
        try {
          child.kill("SIGTERM");
        } catch {
          // ignore; race with already-exited
        }
        const killTimer = setTimeout(() => {
          if (resolved) return;
          try {
            child.kill("SIGKILL");
          } catch {
            // ignore
          }
        }, graceMs);
        killTimer.unref?.();
      });
      return closePromise;
    },
  };
}

/**
 * Inspect stderr text from a CLI that exited before the tunnel
 * was ready and pick the most specific {@link DialerError} code.
 * Generic fallback is `tunnel_failed`.
 */
export function classifyExitFailure(
  stderr: string,
): "cli_not_found" | "auth_failed" | "tunnel_failed" {
  const lc = stderr.toLowerCase();
  if (
    lc.includes("not found") ||
    lc.includes("no such file") ||
    lc.includes("command not recognized") ||
    lc.includes("'aws' is not recognized") ||
    lc.includes("'az' is not recognized")
  ) {
    return "cli_not_found";
  }
  if (
    lc.includes("unable to locate credentials") ||
    lc.includes("expiredtoken") ||
    lc.includes("accessdenied") ||
    lc.includes("unauthorizedaccess") ||
    lc.includes("authentication failed") ||
    lc.includes("please run 'az login'") ||
    lc.includes("aadsts")
  ) {
    return "auth_failed";
  }
  return "tunnel_failed";
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function truncate(s: string, max = 512): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `…(+${s.length - max} more)`;
}
