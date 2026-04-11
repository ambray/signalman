/**
 * Hypervisor backend interface.
 *
 * All hypervisor implementations (Hyper-V, VMware, Azure, etc.) must
 * implement this interface. The host MCP server uses this abstraction
 * to manage VMs without coupling to any specific hypervisor.
 */

/** VM configuration for creation. */
export interface VMConfig {
  /** Human-readable name for the VM. */
  name: string;
  /** Template to create from (image name, template path, etc.). */
  template?: string;
  /** Number of virtual CPUs. */
  cpus?: number;
  /** Memory in MB. */
  memoryMB?: number;
  /** Disk size in GB. */
  diskGB?: number;
  /** Network configuration. */
  network?: NetworkConfig;
  /** Guest agent port (default: 50051). */
  guestAgentPort?: number;
}

/** Network configuration for a VM. */
export interface NetworkConfig {
  /** Virtual switch / network name. */
  switchName?: string;
  /** Static IP address (if not DHCP). */
  staticIP?: string;
  /** Subnet mask. */
  subnetMask?: string;
  /** Default gateway. */
  gateway?: string;
}

/** Opaque handle to a managed VM. */
export interface VMHandle {
  /** Unique identifier (hypervisor-specific). */
  id: string;
  /** Human-readable name. */
  name: string;
  /** Hypervisor backend type. */
  backend: string;
}

/** VM runtime status. */
export type VMState = "stopped" | "running" | "paused" | "saved" | "unknown";

/** VM status information. */
export interface VMStatus {
  handle: VMHandle;
  state: VMState;
  /** IP address (if running and detectable). */
  ipAddress?: string;
  /** Whether the guest agent is reachable. */
  guestAgentReachable: boolean;
  /** Uptime in seconds (if running). */
  uptimeSeconds?: number;
  /** Memory usage in MB (if available). */
  memoryUsedMB?: number;
}

/** Checkpoint (snapshot) information. */
export interface CheckpointInfo {
  /** Checkpoint identifier. */
  id: string;
  /** Human-readable label. */
  label: string;
  /** When the checkpoint was created. */
  createdAt: Date;
  /** Parent checkpoint ID (for checkpoint trees). */
  parentId?: string;
}

/** Opaque handle to a checkpoint. */
export interface CheckpointHandle {
  /** Checkpoint identifier. */
  id: string;
  /** VM this checkpoint belongs to. */
  vmHandle: VMHandle;
  /** Human-readable label. */
  label: string;
}

/** File copy progress callback. */
export type ProgressCallback = (bytesTransferred: number, totalBytes: number) => void;

/**
 * Hypervisor backend interface.
 *
 * Implementations must handle all lifecycle operations for VMs
 * managed by that hypervisor. Operations should be idempotent
 * where possible (e.g., starting an already-running VM is a no-op).
 */
export interface HypervisorBackend {
  /** Backend identifier (e.g., "hyperv", "vmware", "azure"). */
  readonly name: string;

  /** Check if this backend is available on the current system. */
  isAvailable(): Promise<boolean>;

  // ── VM Lifecycle ──────────────────────────────────────────────

  /** Create a new VM from configuration. */
  createVM(config: VMConfig): Promise<VMHandle>;

  /** Start a VM. No-op if already running. */
  startVM(handle: VMHandle): Promise<void>;

  /** Stop/shutdown a VM gracefully. */
  stopVM(handle: VMHandle, force?: boolean): Promise<void>;

  /** Pause a running VM. */
  pauseVM(handle: VMHandle): Promise<void>;

  /** Resume a paused VM. */
  resumeVM(handle: VMHandle): Promise<void>;

  /** Delete a VM and its disk files. */
  deleteVM(handle: VMHandle): Promise<void>;

  /** Get current VM status. */
  getStatus(handle: VMHandle): Promise<VMStatus>;

  /** List all VMs managed by this backend. */
  listVMs(): Promise<VMHandle[]>;

  // ── Checkpoints ───────────────────────────────────────────────

  /** Create a named checkpoint (snapshot). */
  createCheckpoint(handle: VMHandle, label: string): Promise<CheckpointHandle>;

  /** Restore a VM to a checkpoint. VM must be stopped or will be stopped. */
  restoreCheckpoint(checkpoint: CheckpointHandle): Promise<void>;

  /** Delete a checkpoint. */
  deleteCheckpoint(checkpoint: CheckpointHandle): Promise<void>;

  /** List all checkpoints for a VM. */
  listCheckpoints(handle: VMHandle): Promise<CheckpointInfo[]>;

  // ── File Transfer ─────────────────────────────────────────────

  /** Copy a file from host into the VM. */
  copyFileToVM(
    handle: VMHandle,
    hostPath: string,
    guestPath: string,
    progress?: ProgressCallback,
  ): Promise<void>;

  /** Copy a file from the VM to the host. */
  copyFileFromVM(
    handle: VMHandle,
    guestPath: string,
    hostPath: string,
    progress?: ProgressCallback,
  ): Promise<void>;

  // ── Command Execution ─────────────────────────────────────────

  /**
   * Execute a command inside the VM.
   *
   * This is a fallback for when the guest agent is not yet installed.
   * Prefer guest agent gRPC calls when available.
   */
  executeCommand(
    handle: VMHandle,
    command: string,
    args?: string[],
    timeoutMs?: number,
  ): Promise<CommandResult>;
}

/** Result of a command execution. */
export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}
