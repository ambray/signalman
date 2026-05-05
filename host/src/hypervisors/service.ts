/**
 * Service-backed hypervisor backend.
 *
 * Speaks the `signalman.service.ControlPlane` gRPC contract from
 * `service/proto/signalman_service.proto` over the localhost
 * mTLS-protected port (default 17777). The privileged daemon does the
 * actual Hyper-V cmdlet work, so the host MCP process never needs to
 * elevate.
 *
 * This backend is preferred when both the daemon is reachable AND the
 * client cert bundle is readable. If the service can't be contacted at
 * `isAvailable()` time, the host falls back to the direct (gsudo) path.
 *
 * v0.1.0 transport: TCP only. Named-pipe support is on the service
 * side; @grpc/grpc-js doesn't speak Windows pipes natively, and the
 * mTLS TCP listener is sufficient for the local-elevation use case.
 */

import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import type {
  CheckpointHandle,
  CheckpointInfo,
  CommandResult,
  HypervisorBackend,
  ProgressCallback,
  VMConfig,
  VMHandle,
  VMState,
  VMStatus,
} from "./interface.js";

// ── Configuration ────────────────────────────────────────────────────

/** Connection settings for the service transport. */
export interface ServiceBackendOptions {
  /** Host (default `127.0.0.1`). */
  host?: string;
  /** Port (default 17777). */
  port?: number;
  /** Cert directory (default %ProgramData%\Signalman\certs on Windows). */
  certDir?: string;
  /** Per-RPC unary deadline in ms (default 60_000). */
  defaultDeadlineMs?: number;
  /** Default guest credentials for PowerShell Direct operations. */
  guestCredentials?: {
    username: string;
    password: string;
  };
}

const DEFAULT_PORT = 17777;
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_DEADLINE_MS = 60_000;

/** Resolve the default cert directory. Mirrors the service-side default. */
export function defaultCertDir(): string {
  if (process.platform === "win32") {
    const pd = process.env.ProgramData ?? "C:\\ProgramData";
    return path.join(pd, "Signalman", "certs");
  }
  return "/etc/signalman/certs";
}

// ── Proto loading (lazy) ─────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROTO_PATH = path.resolve(__dirname, "../../../service/proto/signalman_service.proto");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _serviceProto: any = null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getServiceProto(): any {
  if (!_serviceProto) {
    const def = protoLoader.loadSync(PROTO_PATH, {
      keepCase: false,
      longs: Number,
      enums: String,
      defaults: true,
      oneofs: true,
    });
    const proto = grpc.loadPackageDefinition(def);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    _serviceProto = (proto.signalman as any).service as any;
  }
  return _serviceProto;
}

/**
 * Build mTLS credentials from a cert bundle on disk. Returns `null` if
 * the bundle is missing — callers fall back to the direct backend.
 */
function loadCredentials(certDir: string): grpc.ChannelCredentials | null {
  const ca = path.join(certDir, "ca.pem");
  const cert = path.join(certDir, "client.pem");
  const key = path.join(certDir, "client.key");
  if (!fs.existsSync(ca) || !fs.existsSync(cert) || !fs.existsSync(key)) {
    return null;
  }
  return grpc.credentials.createSsl(
    fs.readFileSync(ca),
    fs.readFileSync(key),
    fs.readFileSync(cert),
  );
}

/** Wrap a unary gRPC call as a Promise with an optional deadline. */
function unaryCall<TReq, TRes>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: any,
  method: string,
  request: TReq,
  deadlineMs: number,
): Promise<TRes> {
  return new Promise((resolve, reject) => {
    const options: grpc.CallOptions = { deadline: new Date(Date.now() + deadlineMs) };
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type GrpcStream = grpc.ClientReadableStream<any>;

/**
 * Drain a server-streaming gRPC call into a Promise that resolves with
 * the array of received events. Errors propagate as a rejected Promise.
 */
function streamCall<TReq, TEvent>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: any,
  method: string,
  request: TReq,
  onEvent?: (ev: TEvent) => void,
): Promise<TEvent[]> {
  return new Promise((resolve, reject) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stream: GrpcStream = (client as any)[method](request);
    const events: TEvent[] = [];
    stream.on("data", (ev: TEvent) => {
      events.push(ev);
      if (onEvent) onEvent(ev);
    });
    stream.on("end", () => resolve(events));
    stream.on("error", (err: Error) => reject(err));
  });
}

// ── Wire-shape helpers ───────────────────────────────────────────────
//
// The proto is camelCased by protoLoader (`keepCase:false`) so e.g.
// `vm_handle` arrives as `vmHandle`. Field names below assume that.

/** Map an internal VMHandle to the proto shape (no transformation). */
function handleToWire(h: VMHandle) {
  return { id: h.id, name: h.name, backend: h.backend };
}

/** Map a proto handle back to our internal shape. */
function handleFromWire(w: { id: string; name: string; backend: string }): VMHandle {
  return { id: w.id, name: w.name, backend: w.backend };
}

function mapState(s: string): VMState {
  switch (s) {
    case "running":
    case "stopped":
    case "paused":
    case "saved":
      return s as VMState;
    default:
      return "unknown";
  }
}

// ── Backend ──────────────────────────────────────────────────────────

export class ServiceBackend implements HypervisorBackend {
  readonly name = "service";

  private readonly host: string;
  private readonly port: number;
  private readonly certDir: string;
  private readonly defaultDeadlineMs: number;
  private readonly guestCredentials?: ServiceBackendOptions["guestCredentials"];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _client: any | null = null;
  /** Backend name reported by the daemon (e.g. "hyperv"). */
  private upstreamBackend = "hyperv";

  constructor(opts: ServiceBackendOptions = {}) {
    this.host = opts.host ?? DEFAULT_HOST;
    this.port = opts.port ?? DEFAULT_PORT;
    this.certDir = opts.certDir ?? defaultCertDir();
    this.defaultDeadlineMs = opts.defaultDeadlineMs ?? DEFAULT_DEADLINE_MS;
    this.guestCredentials = opts.guestCredentials;
  }

  /**
   * True iff cert bundle exists AND a Health RPC succeeds within 2s.
   * Used by the backend selector to decide whether the service path
   * is viable.
   */
  async isAvailable(): Promise<boolean> {
    const creds = loadCredentials(this.certDir);
    if (!creds) return false;
    try {
      const client = this.client();
      const resp = await unaryCall<Record<string, never>, { activeBackend?: string }>(
        client,
        "health",
        {},
        2_000,
      );
      if (resp.activeBackend) {
        this.upstreamBackend = resp.activeBackend;
      }
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Lazily build the gRPC client.  Re-built on first use after dispose.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private client(): any {
    if (!this._client) {
      const proto = getServiceProto();
      const creds = loadCredentials(this.certDir);
      if (!creds) {
        throw new Error(
          `Signalman service cert bundle missing in ${this.certDir}. ` +
            `Install the service or generate dev certs with 'signalman-service install'.`,
        );
      }
      this._client = new proto.ControlPlane(
        `${this.host}:${this.port}`,
        creds,
        {
          // Match the server's TLS hostname; the cert bundle puts
          // 'localhost' in the SAN, so override the authority for
          // 127.0.0.1 connections.
          "grpc.ssl_target_name_override": "localhost",
          "grpc.default_authority": "localhost",
        },
      );
    }
    return this._client;
  }

  /** Tear down the client; the next call rebuilds it. */
  dispose(): void {
    if (this._client && typeof this._client.close === "function") {
      try {
        this._client.close();
      } catch {
        /* ignore */
      }
    }
    this._client = null;
  }

  // ── VM Lifecycle ──────────────────────────────────────────────────

  async createVM(config: VMConfig): Promise<VMHandle> {
    const wire = {
      config: {
        name: config.name,
        template: config.template ?? "",
        cpus: config.cpus ?? 0,
        memoryMb: config.memoryMB ?? 0,
        diskGb: config.diskGB ?? 0,
        network: config.network
          ? {
              switchName: config.network.switchName ?? "",
              staticIp: config.network.staticIP ?? "",
              subnetMask: config.network.subnetMask ?? "",
              gateway: config.network.gateway ?? "",
            }
          : undefined,
        guestAgentPort: config.guestAgentPort ?? 0,
      },
    };
    const resp = await unaryCall<typeof wire, { handle: { id: string; name: string; backend: string } }>(
      this.client(),
      "vmCreate",
      wire,
      this.defaultDeadlineMs,
    );
    return handleFromWire(resp.handle);
  }

  async startVM(handle: VMHandle): Promise<void> {
    await unaryCall(this.client(), "vmStart", { handle: handleToWire(handle) }, 600_000);
  }

  async stopVM(handle: VMHandle, force = false): Promise<void> {
    await unaryCall(
      this.client(),
      "vmStop",
      { handle: handleToWire(handle), force },
      300_000,
    );
  }

  async pauseVM(handle: VMHandle): Promise<void> {
    await unaryCall(
      this.client(),
      "vmPause",
      { handle: handleToWire(handle) },
      this.defaultDeadlineMs,
    );
  }

  async resumeVM(handle: VMHandle): Promise<void> {
    await unaryCall(
      this.client(),
      "vmResume",
      { handle: handleToWire(handle) },
      this.defaultDeadlineMs,
    );
  }

  async deleteVM(handle: VMHandle): Promise<void> {
    await unaryCall(
      this.client(),
      "vmDelete",
      { handle: handleToWire(handle) },
      this.defaultDeadlineMs,
    );
  }

  async getStatus(handle: VMHandle): Promise<VMStatus> {
    const resp = await unaryCall<
      { handle: ReturnType<typeof handleToWire> },
      {
        handle: { id: string; name: string; backend: string };
        state: string;
        ipAddress: string;
        guestAgentReachable: boolean;
        uptimeSeconds: number;
        memoryUsedMb: number;
      }
    >(
      this.client(),
      "vmGetStatus",
      { handle: handleToWire(handle) },
      this.defaultDeadlineMs,
    );
    return {
      handle: handleFromWire(resp.handle),
      state: mapState(resp.state),
      ipAddress: resp.ipAddress || undefined,
      guestAgentReachable: resp.guestAgentReachable,
      uptimeSeconds: resp.uptimeSeconds,
      memoryUsedMB: resp.memoryUsedMb,
    };
  }

  async listVMs(): Promise<VMHandle[]> {
    const resp = await unaryCall<
      Record<string, never>,
      { handles: Array<{ id: string; name: string; backend: string }> }
    >(this.client(), "vmList", {}, this.defaultDeadlineMs);
    return (resp.handles ?? []).map(handleFromWire);
  }

  // ── Checkpoints ───────────────────────────────────────────────────

  async createCheckpoint(handle: VMHandle, label: string): Promise<CheckpointHandle> {
    const resp = await unaryCall<
      { handle: ReturnType<typeof handleToWire>; label: string },
      {
        handle: {
          id: string;
          label: string;
          vmHandle: { id: string; name: string; backend: string };
        };
      }
    >(
      this.client(),
      "checkpointCreate",
      { handle: handleToWire(handle), label },
      600_000,
    );
    return {
      id: resp.handle.id,
      label: resp.handle.label,
      vmHandle: handleFromWire(resp.handle.vmHandle),
    };
  }

  async restoreCheckpoint(checkpoint: CheckpointHandle): Promise<void> {
    await unaryCall(
      this.client(),
      "checkpointRestore",
      {
        id: checkpoint.id,
        label: checkpoint.label,
        vmHandle: handleToWire(checkpoint.vmHandle),
      },
      600_000,
    );
  }

  async deleteCheckpoint(checkpoint: CheckpointHandle): Promise<void> {
    await unaryCall(
      this.client(),
      "checkpointDelete",
      {
        id: checkpoint.id,
        label: checkpoint.label,
        vmHandle: handleToWire(checkpoint.vmHandle),
      },
      this.defaultDeadlineMs,
    );
  }

  async listCheckpoints(handle: VMHandle): Promise<CheckpointInfo[]> {
    const resp = await unaryCall<
      { handle: ReturnType<typeof handleToWire> },
      {
        checkpoints: Array<{
          id: string;
          label: string;
          createdAt: string;
          parentId: string;
        }>;
      }
    >(this.client(), "checkpointList", { handle: handleToWire(handle) }, this.defaultDeadlineMs);
    return (resp.checkpoints ?? []).map((c) => ({
      id: c.id,
      label: c.label,
      createdAt: new Date(c.createdAt),
      parentId: c.parentId || undefined,
    }));
  }

  // ── File Transfer ────────────────────────────────────────────────

  async copyFileToVM(
    handle: VMHandle,
    hostPath: string,
    guestPath: string,
    progress?: ProgressCallback,
  ): Promise<void> {
    await this.copyFile(handle, hostPath, guestPath, false, progress);
  }

  async copyFileFromVM(
    handle: VMHandle,
    guestPath: string,
    hostPath: string,
    progress?: ProgressCallback,
  ): Promise<void> {
    await this.copyFile(handle, hostPath, guestPath, true, progress);
  }

  private async copyFile(
    handle: VMHandle,
    hostPath: string,
    guestPath: string,
    fromGuest: boolean,
    progress?: ProgressCallback,
  ): Promise<void> {
    type CopyEvent = {
      progress?: { bytesTransferred: number; totalBytes: number };
      complete?: Record<string, never>;
    };
    await streamCall<unknown, CopyEvent>(
      this.client(),
      "vmCopyFile",
      {
        handle: handleToWire(handle),
        hostPath,
        guestPath,
        fromGuest,
        credentials: this.credentialsToWire(),
      },
      progress
        ? (ev) => {
            if (ev.progress) {
              progress(ev.progress.bytesTransferred, ev.progress.totalBytes);
            }
          }
        : undefined,
    );
  }

  // ── Command Execution ────────────────────────────────────────────

  async executeCommand(
    handle: VMHandle,
    command: string,
    args: string[] = [],
    timeoutMs = 60_000,
  ): Promise<CommandResult> {
    type RunEvent = {
      start?: { startedAtUnixMs: number };
      stdoutChunk?: { data: Buffer | Uint8Array };
      stderrChunk?: { data: Buffer | Uint8Array };
      result?: {
        exitCode: number;
        stdout: string;
        stderr: string;
        durationMs: number;
      };
    };
    let result: CommandResult | null = null;
    await streamCall<unknown, RunEvent>(
      this.client(),
      "vmRunCommand",
      {
        handle: handleToWire(handle),
        command,
        args,
        timeoutMs,
        credentials: this.credentialsToWire(),
      },
      (ev) => {
        if (ev.result) {
          result = {
            exitCode: ev.result.exitCode,
            stdout: ev.result.stdout,
            stderr: ev.result.stderr,
            durationMs: ev.result.durationMs,
          };
        }
      },
    );
    if (!result) {
      throw new Error(
        "Service did not return a terminal result for vm_run_command",
      );
    }
    return result;
  }

  // ── Extended Operations ───────────────────────────────────────────

  async getVmIpAddress(handle: VMHandle): Promise<string> {
    const resp = await unaryCall<
      { handle: ReturnType<typeof handleToWire> },
      { ipAddress: string }
    >(this.client(), "vmGetIp", { handle: handleToWire(handle) }, this.defaultDeadlineMs);
    return resp.ipAddress;
  }

  async waitForHeartbeat(handle: VMHandle, timeoutMs: number): Promise<boolean> {
    type WaitEvent = {
      heartbeat?: { heartbeatState: string; elapsedMs: number };
      ready?: Record<string, never>;
      timeout?: Record<string, never>;
    };
    let ready = false;
    await streamCall<unknown, WaitEvent>(
      this.client(),
      "vmWaitAgent",
      { handle: handleToWire(handle), timeoutMs },
      (ev) => {
        if (ev.ready) ready = true;
      },
    );
    return ready;
  }

  async setVmMemory(handle: VMHandle, memoryMB: number): Promise<void> {
    await unaryCall(
      this.client(),
      "vmSetMemory",
      { handle: handleToWire(handle), memoryMb: memoryMB },
      this.defaultDeadlineMs,
    );
  }

  async setVmProcessor(handle: VMHandle, count: number): Promise<void> {
    await unaryCall(
      this.client(),
      "vmSetProcessor",
      { handle: handleToWire(handle), count },
      this.defaultDeadlineMs,
    );
  }

  private credentialsToWire():
    | { username: string; password: string }
    | undefined {
    if (!this.guestCredentials) return undefined;
    return {
      username: this.guestCredentials.username,
      password: this.guestCredentials.password,
    };
  }
}

