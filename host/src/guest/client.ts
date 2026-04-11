/**
 * Guest Agent gRPC client.
 *
 * Connects to the signalman guest agent running inside a VM and exposes
 * typed methods for process control, command execution, UI/browser
 * automation, restriction verification, and software management.
 *
 * Uses @grpc/grpc-js with @grpc/proto-loader for dynamic proto loading.
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

/**
 * Wraps a unary gRPC call in a Promise.
 *
 * @param client - The gRPC client instance.
 * @param method - The method name on the client.
 * @param request - The request message object.
 * @returns Promise resolving to the response message.
 */
function unaryCall<TReq, TRes>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: any,
  method: string,
  request: TReq,
): Promise<TRes> {
  return new Promise((resolve, reject) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any)[method](
      request,
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
 */
export class GuestAgentClient {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private client: any;
  private readonly address: string;

  /**
   * Creates a new GuestAgentClient.
   *
   * @param address - The guest agent IP address or hostname.
   * @param port - The guest agent gRPC port (default 50051).
   * @param tlsOptions - Optional TLS configuration for secure connections.
   */
  constructor(address: string, port: number = 50051, tlsOptions?: TlsOptions) {
    this.address = `${address}:${port}`;

    let credentials: grpc.ChannelCredentials;
    if (tlsOptions) {
      // TLS / mTLS -- read certs lazily at construction time
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

    this.client = new guestProto.GuestAgent(this.address, credentials);
  }

  /**
   * Check guest agent health and get version information.
   */
  async health(): Promise<HealthResult> {
    return unaryCall(this.client, "health", {});
  }

  /**
   * Start a process inside the VM.
   *
   * @param processPath - Full path to the executable.
   * @param args - Command-line arguments.
   * @param options - Optional working directory, env, wait, timeout.
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
  ): Promise<{ pid: number; started: boolean; error: string; exitCode: number; stdout: string; stderr: string }> {
    return unaryCall(this.client, "processStart", {
      path: processPath,
      args,
      workingDirectory: options?.workingDirectory ?? "",
      env: options?.env ?? {},
      waitForExit: options?.waitForExit ?? false,
      timeoutMs: options?.timeoutMs ?? 0,
    });
  }

  /**
   * Stop a running process.
   *
   * @param pid - Process ID to stop.
   * @param force - Whether to force-kill (SIGKILL equivalent).
   */
  async stopProcess(
    pid: number,
    force: boolean = false,
  ): Promise<{ stopped: boolean; error: string }> {
    return unaryCall(this.client, "processStop", {
      pid,
      processName: "",
      force,
    });
  }

  /**
   * List processes running inside the VM.
   *
   * @param filter - Optional process name filter.
   */
  async listProcesses(filter?: string): Promise<ProcessInfo[]> {
    const response = await unaryCall<
      { nameFilter: string },
      { processes: ProcessInfo[] }
    >(this.client, "processList", { nameFilter: filter ?? "" });
    return response.processes;
  }

  /**
   * Run a command inside the VM and capture output.
   *
   * @param command - The command to execute.
   * @param args - Command arguments.
   * @param timeoutMs - Timeout in milliseconds (default 60000).
   */
  async runCommand(
    command: string,
    args: string[] = [],
    timeoutMs: number = 60_000,
  ): Promise<CommandResult> {
    return unaryCall(this.client, "runCommand", {
      command,
      args,
      workingDirectory: "",
      timeoutMs,
      captureOutput: true,
    });
  }

  /**
   * Verify restriction enforcement on a process.
   *
   * @param pid - Process ID to inspect.
   */
  async verifyRestriction(pid: number): Promise<RestrictionVerdict> {
    return unaryCall(this.client, "verifyRestriction", {
      pid,
      processName: "",
    });
  }

  /**
   * Test network connectivity from inside the VM.
   *
   * @param host - Target hostname or IP.
   * @param port - Target port.
   * @param protocol - Protocol to use: "tcp", "udp", or "https".
   * @param timeoutMs - Timeout in milliseconds (default 5000).
   */
  async testNetwork(
    host: string,
    port: number,
    protocol: string = "tcp",
    timeoutMs: number = 5_000,
  ): Promise<NetworkTestResult> {
    return unaryCall(this.client, "testNetwork", {
      host,
      port,
      protocol,
      timeoutMs,
    });
  }

  /**
   * Test file access permissions from inside the VM.
   *
   * @param filePath - Path to test.
   * @param operation - Operation to test: "read", "write", "delete", "list".
   */
  async testFileAccess(
    filePath: string,
    operation: string = "read",
  ): Promise<FileAccessResult> {
    return unaryCall(this.client, "testFileAccess", {
      path: filePath,
      operation,
    });
  }

  /**
   * Install software inside the VM.
   *
   * @param packageId - Package identifier or URL.
   * @param source - Package source: "winget", "choco", or "direct".
   * @param version - Optional specific version.
   */
  async installSoftware(
    packageId: string,
    source: string = "winget",
    version?: string,
  ): Promise<InstallResult> {
    return unaryCall(this.client, "installSoftware", {
      packageId,
      source,
      version: version ?? "",
      silent: true,
    });
  }

  /**
   * Take a screenshot of the VM display.
   *
   * @param windowTitle - Optional window title to capture (full desktop if omitted).
   * @param format - Image format: "png" or "jpeg" (default "png").
   */
  async screenshot(
    windowTitle?: string,
    format: string = "png",
  ): Promise<Buffer> {
    const response = await unaryCall<
      { windowTitle: string; format: string },
      { imageData: Buffer; format: string; width: number; height: number }
    >(this.client, "uIScreenshot", {
      windowTitle: windowTitle ?? "",
      format,
    });
    return Buffer.from(response.imageData);
  }

  /**
   * Close the gRPC channel and release resources.
   */
  close(): void {
    this.client.close();
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
