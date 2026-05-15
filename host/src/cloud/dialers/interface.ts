/**
 * Cloud dialer interface (WS6 wave-3 carve-out #5).
 *
 * Common shape for the network-mode tunnel drivers the host uses
 * to reach a guest agent that isn't dialable as a public TCP
 * endpoint. WS1 sub-task 6 shipped `signalman_cloud_connection_
 * descriptor` for three network modes:
 *
 * - `public_mtls` — direct TCP + mTLS. No dialer needed; the host
 *   connects to `host:port` straight away.
 * - `aws_ssm` — Session Manager port-forwarding tunnel. Requires
 *   the `aws` CLI on PATH + the Session Manager plugin installed.
 *   The {@link AwsSsmDialer} (./aws-ssm.ts) implements this mode.
 * - `azure_bastion` — Bastion tunnel for a private VM. Requires
 *   the `az` CLI on PATH + the `bastion` extension installed. The
 *   {@link AzureBastionDialer} (./azure-bastion.ts) implements this
 *   mode.
 *
 * # Locked design (do not re-litigate)
 *
 * - **Shell-out only, no SDK deps.** Neither the AWS Session
 *   Manager plugin nor Azure Bastion native-client tunnel have a
 *   Node.js library surface. The CLIs are the canonical operator
 *   path; this module wraps them rather than re-implementing the
 *   underlying multiplexed protocols. No new npm dep is added.
 * - **Injectable spawner.** Tests pass a `DialerExec` callback
 *   that returns a fake child-handle without spawning a real
 *   process. Production callers leave it undefined; the dialer
 *   spawns the CLI via `node:child_process.spawn`.
 * - **Caller picks the local port, or the dialer picks a free
 *   one.** When `localPort` is omitted the dialer reserves a port
 *   via `net.createServer().listen(0)` and uses it. This keeps the
 *   call site simple while still letting tests pin a port.
 * - **Ready-on-output, not ready-on-timer.** Both CLIs print a
 *   recognisable line when the tunnel is up (`"Waiting for
 *   connections..."` for SSM, `"Tunnel is ready"` for Bastion).
 *   The dialer's `open()` resolves only after that line appears on
 *   stdout. Timeout (default 30s) raises `tunnel_failed`.
 * - **`close()` sends SIGTERM, then SIGKILL.** Both CLIs trap
 *   SIGTERM and unwind cleanly. SIGKILL fires after a 5s grace
 *   period if the child is still alive. `close()` resolves only
 *   after the child has exited.
 * - **Unsupported descriptors throw immediately.** Each concrete
 *   dialer refuses descriptors whose `kind` doesn't match. The
 *   {@link defaultDialerFor} helper (./index.ts) routes by kind so
 *   callers don't manually pick a dialer.
 *
 * # Descriptor source
 *
 * The `CloudConnectionDescriptor` union is imported from upstream
 * `host/src/cloud/types.ts`. WS6 wave-3 added `bastion_name` to the
 * `azure_bastion` variant and `profile?` to the `aws_ssm` variant
 * to match the dialer's needs.
 */

import type { ChildProcess } from "node:child_process";
import type { CloudConnectionDescriptor } from "../types.js";

export type { CloudConnectionDescriptor };

// ── Handle + error ────────────────────────────────────────────────

/**
 * Live tunnel handle. Carries the local port the caller should
 * connect to, and a `close()` that tears the tunnel down.
 */
export interface DialerHandle {
  /**
   * Local TCP port the tunnel is listening on. Caller connects
   * to `127.0.0.1:<localPort>` to reach the guest agent.
   */
  readonly localPort: number;
  /**
   * Tear down the tunnel. Sends SIGTERM to the CLI subprocess,
   * waits up to 5s for clean exit, then SIGKILL. Resolves once
   * the child has exited. Idempotent — calling `close()` on a
   * handle that's already closed resolves immediately.
   */
  close(): Promise<void>;
}

/**
 * A dialer opens a tunnel for one network-mode descriptor and
 * returns a {@link DialerHandle}. Each concrete dialer handles
 * exactly one `kind` value; passing the wrong kind raises
 * {@link DialerError} with code `unsupported_descriptor`.
 */
export interface Dialer {
  open(descriptor: CloudConnectionDescriptor): Promise<DialerHandle>;
}

/**
 * Stable error code for {@link DialerError}.
 *
 * - `unsupported_descriptor` — descriptor `kind` doesn't match the
 *   dialer (e.g. an `azure_bastion` descriptor passed to the
 *   `AwsSsmDialer`), or `defaultDialerFor` got a `public_mtls`
 *   descriptor (no dialer needed).
 * - `cli_not_found` — the underlying CLI (`aws` / `az`) wasn't
 *   found on PATH, or the spawn failed with ENOENT.
 * - `auth_failed` — the CLI exited with an authentication /
 *   authorisation error (parsed from stderr) before the tunnel
 *   came up.
 * - `tunnel_failed` — generic "tunnel didn't come up" error: the
 *   CLI exited before printing the ready-line, or the ready-line
 *   didn't appear within the timeout.
 */
export type DialerErrorCode =
  | "unsupported_descriptor"
  | "cli_not_found"
  | "auth_failed"
  | "tunnel_failed";

/**
 * Structured error raised by all dialers. Callers pattern-match
 * on `code` without parsing message strings. Message bodies name
 * the offending field / situation explicitly for operators.
 */
export class DialerError extends Error {
  constructor(
    public readonly code: DialerErrorCode,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "DialerError";
  }
}

// ── Injectable subprocess spawner ─────────────────────────────────

/**
 * Subset of `ChildProcess` the dialers actually use. Tests
 * implement this with an `EventEmitter` and a `vi.fn()` `kill`;
 * production receives a real `ChildProcess`.
 *
 * Modelled on the injectable-exec pattern used by the M9 deploy
 * transport (`host/src/runner/deploy/transport.ts`) and the existing
 * OpenTofu driver (`host/src/cloud/tofu.ts`).
 */
export interface DialerChildHandle {
  /** Send a signal to the child. Mirrors `ChildProcess.kill`. */
  kill(signal?: NodeJS.Signals | number): boolean;
  /**
   * Subscribe to stdout text. The dialer scans for the ready-line
   * here. The callback receives raw stdout chunks as strings.
   */
  onStdout(listener: (chunk: string) => void): void;
  /**
   * Subscribe to stderr text. Used only for diagnostics in error
   * messages.
   */
  onStderr(listener: (chunk: string) => void): void;
  /**
   * Subscribe to the `exit` event. Listener receives the exit code
   * (or null when killed by signal) and the signal name (or null
   * when exited normally).
   */
  onExit(
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): void;
  /**
   * True once the child has exited (either cleanly or via signal).
   * Used by `close()` to skip the wait when the child is already
   * dead.
   */
  readonly exited: boolean;
}

/**
 * Injectable spawner for tests. Returns a {@link DialerChildHandle}
 * synchronously; the caller awaits the ready-line via the handle's
 * `onStdout` listener.
 *
 * Production callers leave this undefined; the dialer spawns the
 * CLI via `node:child_process.spawn` and wraps the result.
 */
export type DialerExec = (
  command: string,
  args: string[],
  opts: DialerExecOptions,
) => DialerChildHandle;

export interface DialerExecOptions {
  /** Environment variables to set (merged with the parent env). */
  env?: Record<string, string>;
}

// ── Spawn-wrapping helper (production default) ────────────────────

/**
 * Wrap a real `ChildProcess` into the `DialerChildHandle` shape.
 * Used by the production-default `DialerExec` in the concrete
 * dialer modules. Exported so each dialer can share the wrapping
 * without duplicating the event-glue.
 */
export function wrapChildProcess(child: ChildProcess): DialerChildHandle {
  let exited = false;
  child.once("exit", () => {
    exited = true;
  });
  return {
    kill: (signal) => child.kill(signal),
    onStdout: (listener) => {
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => listener(chunk));
    },
    onStderr: (listener) => {
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk: string) => listener(chunk));
    },
    onExit: (listener) => {
      child.once("exit", (code, signal) => listener(code, signal));
    },
    get exited() {
      return exited;
    },
  };
}

// ── Shared utilities ──────────────────────────────────────────────

/**
 * Default ready-line wait. After this many ms with no ready line
 * on stdout, the dialer raises `tunnel_failed`.
 */
export const DIALER_READY_TIMEOUT_MS = 30_000;

/**
 * Grace period after SIGTERM before SIGKILL is sent during
 * `close()`. Both `aws ssm start-session` and `az network bastion
 * tunnel` handle SIGTERM and unwind in under a second in practice;
 * 5s is plenty.
 */
export const DIALER_CLOSE_GRACE_MS = 5_000;

/**
 * Reserve a free local TCP port by binding `:0` and immediately
 * releasing. The returned port is not held — a small race window
 * exists between this call and the dialer's spawn-then-bind. In
 * practice the underlying CLI does its own bind and would surface
 * `EADDRINUSE` on collision, which the dialer maps to
 * `tunnel_failed` with a clear message.
 *
 * Exported for tests; production callers go through the dialers'
 * `open()` method which calls this internally when no `localPort`
 * is supplied.
 */
export async function pickFreeLocalPort(): Promise<number> {
  const net = await import("node:net");
  return new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", (err) => reject(err));
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr === null || typeof addr === "string") {
        server.close();
        reject(new Error("pickFreeLocalPort: createServer returned unexpected address shape"));
        return;
      }
      const port = addr.port;
      server.close(() => resolve(port));
    });
  });
}
