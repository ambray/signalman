/**
 * Guest Agent gRPC client.
 *
 * Connects to the signalman guest agent running inside a VM and exposes
 * typed methods for process control, command execution, UI/browser
 * automation, restriction verification, and software management.
 *
 * Uses @grpc/grpc-js with @grpc/proto-loader for dynamic proto loading.
 *
 * Addresses audit findings S-15 (timeout + retry) and S-16 (connection
 * resource leak) from the project roadmap Phase 4.1.
 */

import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import fs from "node:fs";
import net from "node:net";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { currentTrace, traceMetadata } from "../output/trace.js";

// ── Types ──────────────────────────────────────────────────────────

/**
 * TLS options for connecting to the guest agent.
 *
 * - Provide just `caPath` to verify a guest server cert against a private CA
 *   (server-auth-only TLS).
 * - Provide all three to perform full mTLS — the host presents `certPath`/
 *   `keyPath` as its identity and validates the server against `caPath`.
 *
 * If a TLS-prefixed endpoint URL (`https://...`) is passed without any
 * `caPath`, system trust roots are used (suitable for public CAs but not
 * for the typical Signalman in-VM deployment).
 */
export interface TlsOptions {
  /** Path to CA certificate (PEM). When omitted, system roots are used. */
  caPath?: string;
  /** Path to client certificate (PEM) for mTLS. */
  certPath?: string;
  /** Path to client private key (PEM) for mTLS. */
  keyPath?: string;
  /** TLS server name override for VM IP targets with stable guest cert names. */
  serverNameOverride?: string;
}

/** Options for the GuestAgentClient constructor. */
export interface ClientOptions {
  /** Connection timeout in milliseconds (default 10_000). */
  connectionTimeoutMs?: number;
  /** Default per-RPC timeout in milliseconds (default 30_000). */
  defaultTimeoutMs?: number;
  /** Maximum retry attempts for transient failures (default 3). */
  maxRetries?: number;
  /** Initial retry delay in milliseconds (default 200). */
  initialRetryDelayMs?: number;
  /** Maximum retry delay in milliseconds (default 2000). */
  maxRetryDelayMs?: number;
  /** Bearer token sent as `Authorization: Bearer <token>` on every RPC. */
  authToken?: string;
}

/** Connection state of the gRPC client. */
export type ConnectionState = "disconnected" | "connecting" | "connected" | "error";

/** Windows-specific process token / container details (P8). */
export interface WindowsProcessDetails {
  isAppcontainer: boolean;
  appcontainerSid: string;
  isLowIntegrity: boolean;
  isInJob: boolean;
}

/** Linux-specific process details — reserved; empty in v0.1.0. */
export interface LinuxProcessDetails {
  // Future: cgroupPath, namespaces, capabilities.
}

/** macOS-specific process details — reserved; empty in v0.1.0. */
export interface MacOsProcessDetails {
  // Future: sandboxProfile, codeSigningTeamId.
}

/**
 * Process information returned by the guest agent.
 *
 * Cross-platform fields are flat; OS-specific token / container info
 * lives in `platformDetails` (P8 oneof). For Windows guests, only
 * `platformDetails.windows` is populated; the other variants are
 * absent.
 *
 * Convenience helper: [`getWindowsProcessDetails`] unwraps the oneof
 * for the common Windows-only path.
 */
export interface ProcessInfo {
  pid: number;
  name: string;
  path: string;
  commandLine: string;
  memoryBytes: number;
  cpuPercent: number;
  user: string;
  /**
   * P8 oneof platform_details. Exactly one variant key is present
   * (`windows` | `linux` | `macos`); the others are absent (not
   * `undefined`-valued — actually missing from the object).
   * `@grpc/proto-loader` decodes proto3 oneofs as plain object
   * properties matching the variant name in camelCase.
   */
  platformDetails?: {
    windows?: WindowsProcessDetails;
    linux?: LinuxProcessDetails;
    macos?: MacOsProcessDetails;
  };
}

/**
 * Convenience accessor for the Windows variant of `ProcessInfo.
 * platformDetails`. Returns the WindowsProcessDetails record or
 * `undefined` when the process is from a non-Windows guest. Use this
 * in scenario code that's Windows-only — clearer than spelunking the
 * oneof shape inline.
 */
export function getWindowsProcessDetails(
  info: ProcessInfo,
): WindowsProcessDetails | undefined {
  return info.platformDetails?.windows;
}

/** Result of running a command inside the VM. */
export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

/** Windows-specific restriction evidence (P8). */
export interface WindowsRestrictionDetails {
  /** "AppContainer" | "Legacy" | "None" */
  restrictionMode: string;
  hasAppcontainerToken: boolean;
  appcontainerSid: string;
  isLowIntegrity: boolean;
  isInJob: boolean;
  jobName: string;
  hasRestrictDll: boolean;
  restrictDllPath: string;
}

/**
 * Restriction verification verdict for a process. Cross-platform
 * top-level outcome + per-platform evidence under `platformDetails`.
 *
 * The Windows-specific fields previously hoisted onto this interface
 * (restrictionMode, hasAppcontainerToken, appcontainerSid, etc.) now
 * live under `platformDetails.windows` after the P8 freeze. Use
 * [`getWindowsRestrictionDetails`] to unwrap on the Windows-only path.
 */
export interface RestrictionVerdict {
  isRestricted: boolean;
  hasFirewallRules: boolean;
  blockedDomains: string[];
  verdict: string;
  issues: string[];
  /** P8 oneof platform_details; exactly one variant present. */
  platformDetails?: {
    windows?: WindowsRestrictionDetails;
  };
}

/**
 * Convenience accessor for the Windows variant of `RestrictionVerdict.
 * platformDetails`. Returns `undefined` when the verdict came from a
 * non-Windows guest.
 */
export function getWindowsRestrictionDetails(
  v: RestrictionVerdict,
): WindowsRestrictionDetails | undefined {
  return v.platformDetails?.windows;
}

/** Result of a network connectivity test. */
export interface NetworkTestResult {
  reachable: boolean;
  latencyMs: number;
  error: string;
  tlsInfo: string;
}

/** Result of a file access test. */
export interface FileAccessResult {
  allowed: boolean;
  error: string;
  errorCode: string;
}

/** Health check response from the guest agent. */
export interface HealthResult {
  hostname: string;
  os: string;
  osVersion: string;
  agentVersion: string;
  uptimeSeconds: number;
  capabilities: string[];
}

/** Software installation result. */
export interface InstallResult {
  success: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  installedPath: string;
  /**
   * P9.2: true when the guest detected the package was already
   * present and skipped a re-install. The bundle orchestrator counts
   * these as `skipped` rather than `installed`.
   */
  alreadyInstalled?: boolean;
}

/** P9.2: input for `installDirect`. */
export interface InstallDirectOptions {
  id: string;
  url: string;
  sha256: string;
  args?: string[];
  installDir?: string;
  timeoutMs?: number;
}

/** P9.2: input for `installDocker`. */
export interface InstallDockerOptions {
  id: string;
  image: string;
  imageSha256: string;
  containerName?: string;
  ports?: string[];
  env?: Record<string, string>;
  restartPolicy?: "no" | "always" | "unless-stopped" | "on-failure";
  command?: string[];
  timeoutMs?: number;
}

/** Directory entry returned by the guest file API. */
export interface GuestDirectoryEntry {
  name: string;
  size: number;
  isDir: boolean;
  modifiedUnixSecs: number;
}

export interface UiElement {
  name: string;
  automationId: string;
  controlType: string;
  className: string;
  isEnabled: boolean;
  isVisible: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
  value: string;
}

export interface UiScreenshot {
  imageData: Buffer;
  format: string;
  width: number;
  height: number;
}

// ── Proto Loading (lazy) ──────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROTO_PATH = path.resolve(__dirname, "../../../proto/guest.proto");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _guestProto: any = null;

/**
 * Lazily loads the proto definition on first use.
 * This allows tests to mock @grpc/proto-loader and @grpc/grpc-js
 * before the proto is loaded.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getGuestProto(): any {
  if (!_guestProto) {
    const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
      keepCase: false,
      longs: Number,
      enums: String,
      defaults: true,
      oneofs: true,
    });
    const protoDescriptor = grpc.loadPackageDefinition(packageDefinition);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    _guestProto = (protoDescriptor.signalman as any).guest as any;
  }
  return _guestProto;
}

// ── Helpers ────────────────────────────────────────────────────────

/** Default client options. */
const DEFAULT_OPTIONS: Required<ClientOptions> = {
  connectionTimeoutMs: 10_000,
  defaultTimeoutMs: 30_000,
  maxRetries: 3,
  initialRetryDelayMs: 200,
  maxRetryDelayMs: 2_000,
  authToken: "",
};

/**
 * Returns true if the gRPC error is a transient failure that should be retried.
 */
function isTransientError(err: unknown): boolean {
  if (err && typeof err === "object" && "code" in err) {
    const code = (err as { code: number }).code;
    return (
      code === grpc.status.UNAVAILABLE ||
      code === grpc.status.DEADLINE_EXCEEDED ||
      code === grpc.status.ABORTED ||
      code === grpc.status.RESOURCE_EXHAUSTED
    );
  }
  return false;
}

/**
 * Sleeps for the specified number of milliseconds.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry helper with exponential backoff.
 *
 * Calls `fn` up to `maxRetries + 1` times (1 initial + maxRetries retries).
 * Only retries on transient gRPC errors. Non-transient errors are thrown
 * immediately.
 *
 * @param fn - The async function to execute.
 * @param maxRetries - Maximum number of retries (default 3).
 * @param initialDelayMs - Initial delay before first retry (default 200).
 * @param maxDelayMs - Maximum delay between retries (default 2000).
 * @returns The result of `fn`.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries: number = DEFAULT_OPTIONS.maxRetries,
  initialDelayMs: number = DEFAULT_OPTIONS.initialRetryDelayMs,
  maxDelayMs: number = DEFAULT_OPTIONS.maxRetryDelayMs,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < maxRetries && isTransientError(err)) {
        const delay = Math.min(initialDelayMs * Math.pow(2, attempt), maxDelayMs);
        await sleep(delay);
      } else {
        throw err;
      }
    }
  }
  // Should not reach here, but satisfy TypeScript
  throw lastError;
}

/**
 * Wraps a unary gRPC call in a Promise with an optional deadline.
 *
 * @param client - The gRPC client instance.
 * @param method - The method name on the client.
 * @param request - The request message object.
 * @param deadlineMs - Optional deadline in milliseconds from now.
 * @returns Promise resolving to the response message.
 */
function unaryCall<TReq, TRes>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: any,
  method: string,
  request: TReq,
  deadlineMs?: number,
  authToken?: string,
): Promise<TRes> {
  return new Promise((resolve, reject) => {
    const options: grpc.CallOptions = {};
    if (deadlineMs !== undefined && deadlineMs > 0) {
      options.deadline = new Date(Date.now() + deadlineMs);
    }
    // P3.d: read trace context from AsyncLocalStorage and inject as
    // gRPC metadata. The orchestrator (or any caller wrapping work in
    // runWithTrace) sets the context; we don't otherwise touch the
    // call signature so existing call sites are unchanged.
    const trace = currentTrace();
    const metadata = buildRpcMetadata(trace, authToken);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cb = (err: grpc.ServiceError | null, response: any) => {
      if (err) reject(err);
      else resolve(response as TRes);
    };

    // gRPC's generated method accepts (request, metadata?, options?, cb).
    // UI-prefixed RPC names are exposed as `UIScreenshot` by live
    // proto-loader, while older tests/mocks used `uIScreenshot`.
    // Accept either shape so the client stays compatible across both.
    const fn =
      (client as any)[method] ??
      (method.startsWith("uI") ? (client as any)[`UI${method.slice(2)}`] : undefined);
    if (typeof fn !== "function") {
      reject(new TypeError(`gRPC client method '${method}' is not available`));
      return;
    }
    // Pass metadata only when present so un-traced calls go through
    // the original 3-arg path unchanged.
    if (metadata) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fn.call(client, request, metadata, options, cb);
    } else {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fn.call(client, request, options, cb);
    }
  });
}

/**
 * Convert trace + auth context into gRPC metadata for outbound calls.
 * P3.d helper; no-op when fields are empty.
 */
function buildRpcMetadata(
  trace: import("../output/trace.js").TraceContext | undefined,
  authToken: string | undefined,
): grpc.Metadata | undefined {
  const md = new grpc.Metadata();
  if (trace) {
    for (const [k, v] of Object.entries(traceMetadata(trace))) {
      md.add(k, v);
    }
  }
  if (authToken) {
    md.add("authorization", `Bearer ${authToken}`);
  }
  return md.getMap && Object.keys(md.getMap()).length > 0 ? md : undefined;
}

// ── Client Class ───────────────────────────────────────────────────

/**
 * gRPC client for the signalman guest agent.
 *
 * Connects to an agent running inside a VM and provides typed methods
 * for all guest agent operations defined in proto/guest.proto.
 *
 * Tracks connection state and supports retry with exponential backoff.
 * Call `dispose()` to cleanly close the channel when done.
 */
export class GuestAgentClient {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private client: any;
  private readonly address: string;
  private readonly options: Required<ClientOptions>;
  private _connectionState: ConnectionState = "disconnected";

  // ── Channel recovery state (Sprint 60.12 Phase B follow-up) ────────
  //
  // When the VM is under heavy load or a single chunk RPC stalls, the
  // gRPC channel can poison: every subsequent call inherits the bad
  // state even when the guest agent itself is healthy. We track
  // consecutive transient failures and rebuild the channel once the
  // count crosses the threshold below. Successful RPCs reset the
  // counter; non-transient errors (NOT_FOUND, INVALID_ARGUMENT, etc.)
  // don't count — they aren't channel poisoning, they're app-level.
  private _consecutiveFailures = 0;
  private static readonly RECOVER_CHANNEL_AFTER_FAILURES = 3;

  /**
   * Saved constructor inputs so `openChannel` (called both from the
   * constructor and from [`recoverChannel`]) can rebuild the same
   * channel shape without the caller threading them through.
   */
  private readonly _parsedEndpoint: ParsedEndpoint;
  private readonly _tlsOptions?: TlsOptions;

  /**
   * The `host:port` this client connects to. Read-only — exposed for
   * diagnostic error messages (`"guest at 172.30.0.10:50051 is
   * unreachable"`) so callers don't have to thread the address through
   * separately.
   */
  get target(): string {
    return this.address;
  }

  /**
   * Number of consecutive transient failures since the last successful
   * RPC. Exposed for diagnostic logging in scenario runners. Resets on
   * success or after [`recoverChannel`].
   */
  get consecutiveFailures(): number {
    return this._consecutiveFailures;
  }

  /**
   * Creates a new GuestAgentClient.
   *
   * Two address forms are accepted:
   * 1. A bare host (e.g. `"172.30.0.10"`) plus a `port` argument. TLS is
   *    used iff `tlsOptions` is supplied.
   * 2. A URL string with `grpc://`, `http://`, or `https://` scheme. The
   *    `https://` prefix forces TLS even when no `tlsOptions.caPath` is
   *    given (system roots are then used).
   *
   * mTLS is requested by supplying both `certPath` and `keyPath` in
   * `tlsOptions` — the agent will reject the connection at TLS handshake
   * time if no client cert is presented and the agent was started with
   * `--tls-ca`.
   *
   * @param address - The guest agent IP/hostname or `grpc[s]://...` URL.
   * @param port - The guest agent gRPC port (default 50051). Ignored when
   *               `address` already contains a port.
   * @param tlsOptions - Optional TLS configuration for secure connections.
   * @param clientOptions - Optional timeout, retry, and keepalive settings.
   */
  constructor(
    address: string,
    port: number = 50051,
    tlsOptions?: TlsOptions,
    clientOptions?: ClientOptions,
  ) {
    const parsed = parseEndpoint(address, port);
    this._parsedEndpoint = parsed;
    this._tlsOptions = tlsOptions;
    this.address = parsed.target;
    this.options = { ...DEFAULT_OPTIONS, ...clientOptions };

    // mTLS requires *both* client cert and key. Surface mis-configurations
    // synchronously rather than at handshake time, so a recoverChannel()
    // rebuild doesn't trip over them either.
    if (
      (tlsOptions?.certPath && !tlsOptions.keyPath) ||
      (tlsOptions?.keyPath && !tlsOptions.certPath)
    ) {
      throw new Error(
        "GuestAgentClient TLS: certPath and keyPath must be specified together",
      );
    }

    this.openChannel();
  }

  /**
   * Build a fresh gRPC channel and assign it to `this.client`. Called
   * from the constructor and again from [`recoverChannel`] after
   * consecutive failures cross the threshold. Idempotent — safe to call
   * multiple times.
   */
  private openChannel(): void {
    // TLS is requested if the endpoint URL declares it, OR if the caller
    // supplied any TLS material. Either path produces an Ssl credential.
    const wantsTls = this._parsedEndpoint.tls || this._tlsOptions !== undefined;

    let credentials: grpc.ChannelCredentials;
    if (wantsTls) {
      const rootCert = this._tlsOptions?.caPath
        ? fs.readFileSync(this._tlsOptions.caPath)
        : null;
      const clientCert = this._tlsOptions?.certPath
        ? fs.readFileSync(this._tlsOptions.certPath)
        : null;
      const clientKey = this._tlsOptions?.keyPath
        ? fs.readFileSync(this._tlsOptions.keyPath)
        : null;
      credentials = grpc.credentials.createSsl(
        rootCert,
        clientKey,
        clientCert,
      );
    } else {
      credentials = grpc.credentials.createInsecure();
    }

    const channelOptions: Record<string, number | string> = {
      "grpc.keepalive_time_ms": 30_000,
      "grpc.keepalive_timeout_ms": 10_000,
      "grpc.max_connection_idle_ms": 60_000,
      "grpc.max_receive_message_length": 128 * 1024 * 1024,
      "grpc.max_send_message_length": 128 * 1024 * 1024,
    };
    if (wantsTls) {
      const targetHost = this._parsedEndpoint.target.split(":")[0] ?? "";
      const serverNameOverride =
        this._tlsOptions?.serverNameOverride ??
        (net.isIP(targetHost) ? "localhost" : undefined);
      if (serverNameOverride) {
        channelOptions["grpc.ssl_target_name_override"] = serverNameOverride;
        channelOptions["grpc.default_authority"] = serverNameOverride;
      }
    }

    this._connectionState = "connecting";
    try {
      const proto = getGuestProto();
      this.client = new proto.GuestAgent(
        this.address,
        credentials,
        channelOptions,
      );
      this._connectionState = "connected";
    } catch (err) {
      this._connectionState = "error";
      throw err;
    }
  }

  /**
   * Recreate the underlying gRPC channel.
   *
   * Closes the current channel (best effort) and rebuilds with the same
   * credentials and options as the original constructor call. Resets
   * the consecutive-failure counter. Used by RPC wrappers when the
   * channel appears poisoned by a stuck in-flight call — observed
   * empirically: once a handful of timeouts pile up, every subsequent
   * call inherits the bad state until the channel is rebuilt.
   *
   * Idempotent and cheap (creates a new in-process socket on the next
   * actual call); safe to invoke from any RPC failure path.
   */
  recoverChannel(): void {
    try {
      this.client?.close?.();
    } catch {
      /* best-effort — old channel may already be in a bad state */
    }
    this.openChannel();
    this._consecutiveFailures = 0;
  }

  /**
   * Track a successful RPC. Resets the consecutive-failure counter so
   * isolated transient hiccups don't compound across calls.
   */
  private noteSuccess(): void {
    this._consecutiveFailures = 0;
  }

  /**
   * Track a failed RPC. When `RECOVER_CHANNEL_AFTER_FAILURES` is hit
   * the channel is recreated synchronously so the NEXT RPC starts
   * fresh. Returns the new failure count for diagnostic logging at the
   * call site. Non-transient errors (NOT_FOUND, INVALID_ARGUMENT, etc.)
   * are application-level and don't count — they aren't channel
   * poisoning.
   */
  private noteFailure(err: unknown): number {
    if (isTransientError(err)) {
      this._consecutiveFailures += 1;
      if (
        this._consecutiveFailures >=
        GuestAgentClient.RECOVER_CHANNEL_AFTER_FAILURES
      ) {
        // eslint-disable-next-line no-console
        console.error(
          `[signalman] guest channel ${this.address} hit ${this._consecutiveFailures} ` +
            `consecutive transient failures — recreating channel`,
        );
        this.recoverChannel();
      }
    }
    return this._consecutiveFailures;
  }

  /** Returns the current connection state. */
  get connectionState(): ConnectionState {
    return this._connectionState;
  }

  /**
   * Checks whether the guest agent is reachable by calling the Health RPC.
   *
   * @param timeoutMs - Timeout for the health check (default 5000).
   * @returns True if the agent responded, false otherwise.
   */
  async isConnected(timeoutMs: number = 5_000): Promise<boolean> {
    if (this._connectionState === "disconnected") return false;
    try {
      await unaryCall(this.client, "health", {}, timeoutMs, this.options.authToken);
      this._connectionState = "connected";
      return true;
    } catch {
      this._connectionState = "error";
      return false;
    }
  }

  /**
   * Close the gRPC channel and release resources.
   * Sets connection state to "disconnected".
   */
  dispose(): void {
    try {
      this.client.close();
    } finally {
      this._connectionState = "disconnected";
    }
  }

  /**
   * Close the gRPC channel and release resources.
   * Alias for dispose() for backward compatibility.
   */
  close(): void {
    this.dispose();
  }

  // ── RPC Methods ───────────────────────────────────────────────────

  /**
   * Check guest agent health and get version information.
   *
   * @param timeoutMs - Per-RPC timeout in milliseconds.
   */
  async health(timeoutMs?: number): Promise<HealthResult> {
    const deadline = timeoutMs ?? this.options.defaultTimeoutMs;
    return withRetry(
      () => unaryCall(this.client, "health", {}, deadline, this.options.authToken),
      this.options.maxRetries,
      this.options.initialRetryDelayMs,
      this.options.maxRetryDelayMs,
    );
  }

  /**
   * Start a process inside the VM.
   *
   * @param processPath - Full path to the executable.
   * @param args - Command-line arguments.
   * @param options - Optional working directory, env, wait, timeout.
   * @param timeoutMs - Per-RPC timeout in milliseconds.
   */
  async startProcess(
    processPath: string,
    args: string[] = [],
    options?: {
      workingDirectory?: string;
      env?: Record<string, string>;
      waitForExit?: boolean;
      timeoutMs?: number;
      runAs?: string;
    },
    timeoutMs?: number,
  ): Promise<{ pid: number; started: boolean; error: string; exitCode: number; stdout: string; stderr: string }> {
    const deadline = timeoutMs ?? this.options.defaultTimeoutMs;
    return withRetry(
      () =>
        unaryCall(this.client, "processStart", {
          path: processPath,
          args,
          workingDirectory: options?.workingDirectory ?? "",
          env: options?.env ?? {},
          waitForExit: options?.waitForExit ?? false,
          timeoutMs: options?.timeoutMs ?? 0,
          run_as: options?.runAs ?? "",
        }, deadline, this.options.authToken),
      this.options.maxRetries,
      this.options.initialRetryDelayMs,
      this.options.maxRetryDelayMs,
    );
  }

  /**
   * Stop a running process.
   *
   * @param pid - Process ID to stop.
   * @param force - Whether to force-kill (SIGKILL equivalent).
   * @param timeoutMs - Per-RPC timeout in milliseconds.
   */
  async stopProcess(
    pid: number,
    force: boolean = false,
    timeoutMs?: number,
  ): Promise<{ stopped: boolean; error: string }> {
    const deadline = timeoutMs ?? this.options.defaultTimeoutMs;
    return withRetry(
      () =>
        unaryCall(this.client, "processStop", {
          pid,
          processName: "",
          force,
        }, deadline, this.options.authToken),
      this.options.maxRetries,
      this.options.initialRetryDelayMs,
      this.options.maxRetryDelayMs,
    );
  }

  /**
   * List processes running inside the VM.
   *
   * @param filter - Optional process name filter.
   * @param timeoutMs - Per-RPC timeout in milliseconds.
   */
  async listProcesses(filter?: string, timeoutMs?: number): Promise<ProcessInfo[]> {
    const deadline = timeoutMs ?? this.options.defaultTimeoutMs;
    const response = await withRetry(
      () =>
        unaryCall<{ nameFilter: string }, { processes: ProcessInfo[] }>(
          this.client, "processList", { nameFilter: filter ?? "" }, deadline, this.options.authToken,
        ),
      this.options.maxRetries,
      this.options.initialRetryDelayMs,
      this.options.maxRetryDelayMs,
    );
    return response.processes;
  }

  /**
   * Run a command inside the VM and capture output.
   *
   * # `maxRetries` override
   *
   * Defaults to the client's configured `maxRetries` (3). Callers
   * driving throughput-sensitive loops (the chunked file-transfer
   * helper is the canonical example) should pass `maxRetries: 1` to
   * avoid 4 × 60 s retry stacking on a single transient
   * `DEADLINE_EXCEEDED` — that pattern can turn a single chunk failure
   * into a multi-minute hang and hides genuine unresponsiveness behind
   * opaque retry storms.
   *
   * # Channel-recovery hookup
   *
   * Wraps the call in success/failure counting so the channel auto-
   * rebuilds after [`RECOVER_CHANNEL_AFTER_FAILURES`] consecutive
   * transient errors. Other RPC wrappers can opt in incrementally as
   * we observe their failure patterns.
   *
   * @param command - The command to execute.
   * @param args - Command arguments.
   * @param options - Per-RPC timeout, run-as identity, and retry override.
   */
  async runCommand(
    command: string,
    args: string[] = [],
    options?: number | {
      timeoutMs?: number;
      runAs?: string;
      maxRetries?: number;
    },
  ): Promise<CommandResult> {
    const deadline = (typeof options === "number" ? options : options?.timeoutMs) ?? this.options.defaultTimeoutMs;
    const runAs = (typeof options === "object" && options !== null) ? (options.runAs ?? "") : "";
    const maxRetries = (typeof options === "object" && options !== null && options.maxRetries !== undefined)
      ? options.maxRetries
      : this.options.maxRetries;
    try {
      const result = await withRetry(
        () =>
          unaryCall(this.client, "runCommand", {
            command,
            args,
            workingDirectory: "",
            timeoutMs: deadline,
            captureOutput: true,
            run_as: runAs,
          }, deadline, this.options.authToken),
        maxRetries,
        this.options.initialRetryDelayMs,
        this.options.maxRetryDelayMs,
      );
      this.noteSuccess();
      return result as CommandResult;
    } catch (err) {
      this.noteFailure(err);
      throw err;
    }
  }

  /**
   * Verify restriction enforcement on a process.
   *
   * @param pid - Process ID to inspect.
   * @param timeoutMs - Per-RPC timeout in milliseconds.
   */
  async verifyRestriction(pid: number, timeoutMs?: number): Promise<RestrictionVerdict> {
    const deadline = timeoutMs ?? this.options.defaultTimeoutMs;
    return withRetry(
      () =>
        unaryCall(this.client, "verifyRestriction", {
          pid,
          processName: "",
        }, deadline, this.options.authToken),
      this.options.maxRetries,
      this.options.initialRetryDelayMs,
      this.options.maxRetryDelayMs,
    );
  }

  /**
   * Test network connectivity from inside the VM.
   *
   * @param host - Target hostname or IP.
   * @param port - Target port.
   * @param protocol - Protocol to use: "tcp", "udp", or "https".
   * @param rpcTimeoutMs - Per-RPC timeout in milliseconds (default 5000).
   */
  async testNetwork(
    host: string,
    port: number,
    protocol: string = "tcp",
    rpcTimeoutMs?: number,
  ): Promise<NetworkTestResult> {
    const deadline = rpcTimeoutMs ?? this.options.defaultTimeoutMs;
    return withRetry(
      () =>
        unaryCall(this.client, "testNetwork", {
          host,
          port,
          protocol,
          timeoutMs: 5_000,
        }, deadline, this.options.authToken),
      this.options.maxRetries,
      this.options.initialRetryDelayMs,
      this.options.maxRetryDelayMs,
    );
  }

  /**
   * Test file access permissions from inside the VM.
   *
   * @param filePath - Path to test.
   * @param operation - Operation to test: "read", "write", "delete", "list".
   * @param timeoutMs - Per-RPC timeout in milliseconds.
   */
  async testFileAccess(
    filePath: string,
    operation: string = "read",
    timeoutMs?: number,
  ): Promise<FileAccessResult> {
    const deadline = timeoutMs ?? this.options.defaultTimeoutMs;
    return withRetry(
      () =>
        unaryCall(this.client, "testFileAccess", {
          path: filePath,
          operation,
        }, deadline, this.options.authToken),
      this.options.maxRetries,
      this.options.initialRetryDelayMs,
      this.options.maxRetryDelayMs,
    );
  }

  /**
   * Install software inside the VM.
   *
   * @param packageId - Package identifier or URL.
   * @param source - Package source: "winget", "choco", or "direct".
   * @param version - Optional specific version.
   * @param timeoutMs - Per-RPC timeout in milliseconds.
   */
  async installSoftware(
    packageId: string,
    source: string = "winget",
    version?: string,
    timeoutMs?: number,
  ): Promise<InstallResult> {
    const deadline = timeoutMs ?? this.options.defaultTimeoutMs;
    return withRetry(
      () =>
        unaryCall(this.client, "installSoftware", {
          packageId,
          source,
          version: version ?? "",
          silent: true,
        }, deadline, this.options.authToken),
      this.options.maxRetries,
      this.options.initialRetryDelayMs,
      this.options.maxRetryDelayMs,
    );
  }

  /**
   * P9.2 — Install software from a direct URL.
   *
   * The guest agent downloads the installer over HTTPS, verifies the
   * SHA-256 against `opts.sha256`, then spawns the installer with
   * `opts.args` as silent-install arguments. The download is streamed
   * (no full-file-in-memory) and the partial file is shredded on any
   * failure path so a hash mismatch can't leak a half-downloaded
   * payload.
   *
   * Pre-conditions enforced server-side: HTTPS-only URL, 64-char
   * lowercase hex sha256. The host-side `bundle-types.ts` Zod schema
   * also enforces these — failure surfaces here only when the bundle
   * was constructed in code (not from YAML) or the schema drifted.
   */
  async installDirect(opts: InstallDirectOptions): Promise<InstallResult> {
    const deadline = opts.timeoutMs ?? this.options.defaultTimeoutMs;
    return withRetry(
      () =>
        unaryCall(
          this.client,
          "installDirect",
          {
            id: opts.id,
            url: opts.url,
            sha256: opts.sha256,
            args: opts.args ?? [],
            installDir: opts.installDir ?? "",
            timeoutMs: opts.timeoutMs ?? 0,
          },
          deadline,
          this.options.authToken,
        ),
      this.options.maxRetries,
      this.options.initialRetryDelayMs,
      this.options.maxRetryDelayMs,
    );
  }

  /**
   * P9.2 — Install software as a docker container.
   *
   * Requires Docker on the VM (operator orders that prerequisite
   * explicitly in the bundle, per Q10(a)). The guest pulls the image
   * with the digest pin (`<image>@<image_sha256>`), then runs it with
   * the supplied options. "Container already exists" is treated as
   * `alreadyInstalled: true` (idempotent re-run).
   */
  async installDocker(opts: InstallDockerOptions): Promise<InstallResult> {
    const deadline = opts.timeoutMs ?? this.options.defaultTimeoutMs;
    return withRetry(
      () =>
        unaryCall(
          this.client,
          "installDocker",
          {
            id: opts.id,
            image: opts.image,
            imageSha256: opts.imageSha256,
            containerName: opts.containerName ?? "",
            ports: opts.ports ?? [],
            env: opts.env ?? {},
            restartPolicy: opts.restartPolicy ?? "",
            command: opts.command ?? [],
            timeoutMs: opts.timeoutMs ?? 0,
          },
          deadline,
          this.options.authToken,
        ),
      this.options.maxRetries,
      this.options.initialRetryDelayMs,
      this.options.maxRetryDelayMs,
    );
  }

  /**
   * Read a file chunk from the guest filesystem and return the server's
   * truncation signal.
   */
  async readFileChunk(
    filePath: string,
    options: { offset?: number; limit?: number; timeoutMs?: number } = {},
  ): Promise<{ data: Buffer; truncated: boolean }> {
    const deadline = options.timeoutMs ?? this.options.defaultTimeoutMs;
    const response = await withRetry(
      () =>
        unaryCall<
          { path: string; offset: number; limit: number },
          { data: Buffer | Uint8Array; truncated: boolean }
        >(this.client, "readFile", {
          path: filePath,
          offset: options.offset ?? 0,
          limit: options.limit ?? 0,
        }, deadline, this.options.authToken),
      this.options.maxRetries,
      this.options.initialRetryDelayMs,
      this.options.maxRetryDelayMs,
    );
    return {
      data: Buffer.from(response.data),
      truncated: response.truncated,
    };
  }

  /**
   * Read a file from the guest filesystem.
   */
  async readFile(
    filePath: string,
    options: { offset?: number; limit?: number; timeoutMs?: number } = {},
  ): Promise<Buffer> {
    return (await this.readFileChunk(filePath, options)).data;
  }

  /**
   * Write a file to the guest filesystem.
   */
  async writeFile(
    filePath: string,
    data: Buffer | Uint8Array | string,
    append: boolean = false,
    timeoutMs?: number,
  ): Promise<{ bytesWritten: number }> {
    const deadline = timeoutMs ?? this.options.defaultTimeoutMs;
    return withRetry(
      () =>
        unaryCall<
          { path: string; data: Buffer; append: boolean },
          { bytesWritten: number }
        >(this.client, "writeFile", {
          path: filePath,
          data: Buffer.isBuffer(data) ? data : Buffer.from(data),
          append,
        }, deadline, this.options.authToken),
      this.options.maxRetries,
      this.options.initialRetryDelayMs,
      this.options.maxRetryDelayMs,
    );
  }

  /**
   * List a directory inside the guest filesystem.
   */
  async listDirectory(filePath: string, timeoutMs?: number): Promise<GuestDirectoryEntry[]> {
    const deadline = timeoutMs ?? this.options.defaultTimeoutMs;
    const response = await withRetry(
      () =>
        unaryCall<
          { path: string },
          { entries: GuestDirectoryEntry[] }
        >(this.client, "listDirectory", { path: filePath }, deadline, this.options.authToken),
      this.options.maxRetries,
      this.options.initialRetryDelayMs,
      this.options.maxRetryDelayMs,
    );
    return response.entries ?? [];
  }

  /**
   * Take a screenshot of the VM display.
   *
   * @param windowTitle - Optional window title to capture (full desktop if omitted).
   * @param format - Image format: "png" or "jpeg" (default "png").
   * @param timeoutMs - Per-RPC timeout in milliseconds.
   */
  async screenshot(
    windowTitle?: string,
    format: string = "png",
    timeoutMs?: number,
  ): Promise<Buffer> {
    return (await this.uiScreenshot({ windowTitle, format, timeoutMs })).imageData;
  }

  async uiScreenshot(options: {
    windowTitle?: string;
    format?: string;
    timeoutMs?: number;
  } = {}): Promise<UiScreenshot> {
    const deadline = options.timeoutMs ?? this.options.defaultTimeoutMs;
    const response = await withRetry(
      () =>
        unaryCall<
          { windowTitle: string; format: string },
          { imageData: Buffer; format: string; width: number; height: number }
        >(this.client, "uIScreenshot", {
          windowTitle: options.windowTitle ?? "",
          format: options.format ?? "png",
        }, deadline, this.options.authToken),
      this.options.maxRetries,
      this.options.initialRetryDelayMs,
      this.options.maxRetryDelayMs,
    );
    return {
      imageData: Buffer.from(response.imageData),
      format: response.format,
      width: response.width,
      height: response.height,
    };
  }

  async uiClick(
    selector: string,
    options: {
      windowTitle?: string;
      clickType?: "left" | "right" | "double";
      timeoutMs?: number;
    } = {},
  ): Promise<{ success: boolean; error: string }> {
    const deadline = options.timeoutMs ?? this.options.defaultTimeoutMs;
    return withRetry(
      () =>
        unaryCall(this.client, "uIClick", {
          selector,
          windowTitle: options.windowTitle ?? "",
          clickType: options.clickType ?? "left",
        }, deadline, this.options.authToken),
      this.options.maxRetries,
      this.options.initialRetryDelayMs,
      this.options.maxRetryDelayMs,
    );
  }

  async uiType(
    text: string,
    options: {
      selector?: string;
      windowTitle?: string;
      clearFirst?: boolean;
      timeoutMs?: number;
    } = {},
  ): Promise<{ success: boolean; error: string }> {
    const deadline = options.timeoutMs ?? this.options.defaultTimeoutMs;
    return withRetry(
      () =>
        unaryCall(this.client, "uIType", {
          text,
          selector: options.selector ?? "",
          windowTitle: options.windowTitle ?? "",
          clearFirst: options.clearFirst ?? false,
        }, deadline, this.options.authToken),
      this.options.maxRetries,
      this.options.initialRetryDelayMs,
      this.options.maxRetryDelayMs,
    );
  }

  async uiFind(
    selector: string,
    options: {
      windowTitle?: string;
      findTimeoutMs?: number;
      timeoutMs?: number;
    } = {},
  ): Promise<UiElement[]> {
    const deadline = options.timeoutMs ?? this.options.defaultTimeoutMs;
    const response = await withRetry(
      () =>
        unaryCall<
          { selector: string; windowTitle: string; timeoutMs: number },
          { elements: UiElement[] }
        >(this.client, "uIFind", {
          selector,
          windowTitle: options.windowTitle ?? "",
          timeoutMs: options.findTimeoutMs ?? 5_000,
        }, deadline, this.options.authToken),
      this.options.maxRetries,
      this.options.initialRetryDelayMs,
      this.options.maxRetryDelayMs,
    );
    return response.elements ?? [];
  }

}

// ── Internal Helpers ───────────────────────────────────────────────

/** Result of parsing an endpoint string into a gRPC target + TLS hint. */
interface ParsedEndpoint {
  /** `host:port` ready to hand to `@grpc/grpc-js`. */
  target: string;
  /** Whether the URL scheme requested TLS (`https://` or `grpcs://`). */
  tls: boolean;
}

/**
 * Parses an address into a gRPC target string and a TLS-hint flag.
 *
 * Accepts:
 *   - bare host: `"172.30.0.10"` -> uses the supplied default port.
 *   - host:port: `"vm.local:51000"` -> uses the embedded port verbatim.
 *   - URL: `"https://vm.local:50051"` -> sets `tls=true`; uses port 443
 *     by default if not given (matching @grpc/grpc-js URL semantics).
 *
 * Anything else falls through as a plain string with no TLS hint.
 */
export function parseEndpoint(
  address: string,
  defaultPort: number,
): ParsedEndpoint {
  // URL scheme branch — only attempt URL parsing when an explicit scheme
  // is present so we do not misinterpret IPv6 host:port pairs.
  const schemeMatch = /^([a-z][a-z0-9+.-]*):\/\//i.exec(address);
  if (schemeMatch) {
    const scheme = schemeMatch[1].toLowerCase();
    let url: URL;
    try {
      url = new URL(address);
    } catch {
      return { target: address, tls: scheme === "https" || scheme === "grpcs" };
    }
    const tls = scheme === "https" || scheme === "grpcs";
    const port = url.port
      ? Number(url.port)
      : tls
        ? 443
        : defaultPort;
    return { target: `${url.hostname}:${port}`, tls };
  }

  // Bare host or host:port. We assume an embedded port is present iff
  // there is exactly one colon AND the right side is all digits — this
  // avoids treating IPv6 addresses (which have many colons) as host:port.
  const lastColon = address.lastIndexOf(":");
  const firstColon = address.indexOf(":");
  if (
    lastColon !== -1 &&
    lastColon === firstColon &&
    /^\d+$/.test(address.slice(lastColon + 1))
  ) {
    return { target: address, tls: false };
  }
  return { target: `${address}:${defaultPort}`, tls: false };
}
