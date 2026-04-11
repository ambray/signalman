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
import { fileURLToPath } from "node:url";
import path from "node:path";

// ── Types ──────────────────────────────────────────────────────────

/** TLS options for connecting to the guest agent. */
export interface TlsOptions {
  /** Path to CA certificate (PEM). */
  caPath: string;
  /** Path to client certificate (PEM) for mTLS. */
  certPath?: string;
  /** Path to client private key (PEM) for mTLS. */
  keyPath?: string;
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
}

/** Connection state of the gRPC client. */
export type ConnectionState = "disconnected" | "connecting" | "connected" | "error";

/** Process information returned by the guest agent. */
export interface ProcessInfo {
  pid: number;
  name: string;
  path: string;
  commandLine: string;
  memoryBytes: number;
  cpuPercent: number;
  user: string;
  isAppcontainer: boolean;
  appcontainerSid: string;
  isLowIntegrity: boolean;
  isInJob: boolean;
}

/** Result of running a command inside the VM. */
export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

/** Restriction verification verdict for a process. */
export interface RestrictionVerdict {
  isRestricted: boolean;
  restrictionMode: string;
  hasAppcontainerToken: boolean;
  appcontainerSid: string;
  isLowIntegrity: boolean;
  isInJob: boolean;
  jobName: string;
  hasFirewallRules: boolean;
  blockedDomains: string[];
  hasRestrictDll: boolean;
  restrictDllPath: string;
  verdict: string;
  issues: string[];
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
}

// ── Proto Loading ──────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROTO_PATH = path.resolve(__dirname, "../../../proto/guest.proto");

const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
  keepCase: false,
  longs: Number,
  enums: String,
  defaults: true,
  oneofs: true,
});

const protoDescriptor = grpc.loadPackageDefinition(packageDefinition);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const guestProto = (protoDescriptor.signalman as any).guest as any;

// ── Helpers ────────────────────────────────────────────────────────

/** Default client options. */
const DEFAULT_OPTIONS: Required<ClientOptions> = {
  connectionTimeoutMs: 10_000,
  defaultTimeoutMs: 30_000,
  maxRetries: 3,
  initialRetryDelayMs: 200,
  maxRetryDelayMs: 2_000,
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
): Promise<TRes> {
  return new Promise((resolve, reject) => {
    const options: grpc.CallOptions = {};
    if (deadlineMs !== undefined && deadlineMs > 0) {
      options.deadline = new Date(Date.now() + deadlineMs);
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any)[method](
      request,
      options,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (err: grpc.ServiceError | null, response: any) => {
        if (err) reject(err);
        else resolve(response as TRes);
      },
    );
  });
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

  /**
   * Creates a new GuestAgentClient.
   *
   * @param address - The guest agent IP address or hostname.
   * @param port - The guest agent gRPC port (default 50051).
   * @param tlsOptions - Optional TLS configuration for secure connections.
   * @param clientOptions - Optional timeout, retry, and keepalive settings.
   */
  constructor(
    address: string,
    port: number = 50051,
    tlsOptions?: TlsOptions,
    clientOptions?: ClientOptions,
  ) {
    this.address = `${address}:${port}`;
    this.options = { ...DEFAULT_OPTIONS, ...clientOptions };

    let credentials: grpc.ChannelCredentials;
    if (tlsOptions) {
      const fs = await_import_fs();
      const rootCert = fs.readFileSync(tlsOptions.caPath);
      const clientCert = tlsOptions.certPath
        ? fs.readFileSync(tlsOptions.certPath)
        : null;
      const clientKey = tlsOptions.keyPath
        ? fs.readFileSync(tlsOptions.keyPath)
        : null;
      credentials = grpc.credentials.createSsl(
        rootCert,
        clientKey,
        clientCert,
      );
    } else {
      credentials = grpc.credentials.createInsecure();
    }

    const channelOptions: Record<string, number> = {
      "grpc.keepalive_time_ms": 30_000,
      "grpc.keepalive_timeout_ms": 10_000,
      "grpc.max_connection_idle_ms": 60_000,
    };

    this._connectionState = "connecting";
    try {
      this.client = new guestProto.GuestAgent(
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
      await unaryCall(this.client, "health", {}, timeoutMs);
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
      () => unaryCall(this.client, "health", {}, deadline),
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
        }, deadline),
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
        }, deadline),
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
          this.client, "processList", { nameFilter: filter ?? "" }, deadline,
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
   * @param command - The command to execute.
   * @param args - Command arguments.
   * @param timeoutMs - Per-RPC timeout in milliseconds (default from config).
   */
  async runCommand(
    command: string,
    args: string[] = [],
    timeoutMs?: number,
  ): Promise<CommandResult> {
    const deadline = timeoutMs ?? this.options.defaultTimeoutMs;
    return withRetry(
      () =>
        unaryCall(this.client, "runCommand", {
          command,
          args,
          workingDirectory: "",
          timeoutMs: deadline,
          captureOutput: true,
        }, deadline),
      this.options.maxRetries,
      this.options.initialRetryDelayMs,
      this.options.maxRetryDelayMs,
    );
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
        }, deadline),
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
        }, deadline),
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
        }, deadline),
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
        }, deadline),
      this.options.maxRetries,
      this.options.initialRetryDelayMs,
      this.options.maxRetryDelayMs,
    );
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
    const deadline = timeoutMs ?? this.options.defaultTimeoutMs;
    const response = await withRetry(
      () =>
        unaryCall<
          { windowTitle: string; format: string },
          { imageData: Buffer; format: string; width: number; height: number }
        >(this.client, "uIScreenshot", {
          windowTitle: windowTitle ?? "",
          format,
        }, deadline),
      this.options.maxRetries,
      this.options.initialRetryDelayMs,
      this.options.maxRetryDelayMs,
    );
    return Buffer.from(response.imageData);
  }
}

// ── Internal Helpers ───────────────────────────────────────────────

/**
 * Synchronously imports the fs module. Avoids top-level import so the
 * module can be loaded in environments where fs is not needed.
 */
function await_import_fs(): typeof import("node:fs") {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("node:fs");
}
