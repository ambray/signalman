/**
 * Tart hypervisor backend for macOS hosts.
 *
 * Tart is a thin CLI around Apple's Virtualization.framework. This backend
 * keeps Signalman's host surface consistent with the existing Hyper-V/VMware
 * backends while delegating entitlement-heavy VM work to Tart's signed app
 * bundle.
 */

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
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
import {
  sanitizeCommand,
  sanitizeLabel,
  sanitizePath,
  sanitizeTimeout,
  sanitizeVmName,
} from "../sanitize.js";

const exec = promisify(execFile);

export interface TartCommandOutput {
  stdout: string;
  stderr: string;
}

export type TartCommandRunner = (
  args: string[],
  timeoutMs: number,
) => Promise<TartCommandOutput>;

export interface TartChildProcess {
  readonly pid?: number;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  once(event: "error", listener: (err: Error) => void): this;
  unref?(): void;
}

export type TartSpawnRunner = (args: string[]) => TartChildProcess;

export interface TartBackendOptions {
  tartPath?: string;
  commandRunner?: TartCommandRunner;
  spawnRunner?: TartSpawnRunner;
  startTimeoutMs?: number;
  noGraphics?: boolean;
  suspendable?: boolean;
  ipResolver?: "dhcp" | "arp" | "agent";
}

interface TartListEntry {
  name?: unknown;
  Name?: unknown;
  state?: unknown;
  State?: unknown;
  status?: unknown;
  Status?: unknown;
  running?: unknown;
  Running?: unknown;
}

const CHECKPOINT_SEPARATOR = "--signalman-cp--";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    const maybeIo = err as Error & {
      stdout?: string | Buffer;
      stderr?: string | Buffer;
      code?: unknown;
    };
    const stderr = maybeIo.stderr ? String(maybeIo.stderr).trim() : "";
    const stdout = maybeIo.stdout ? String(maybeIo.stdout).trim() : "";
    const code = maybeIo.code === undefined ? "" : ` (code ${String(maybeIo.code)})`;
    return [err.message + code, stderr, stdout].filter(Boolean).join("\n");
  }
  return String(err);
}

function stateFromEntry(entry: TartListEntry): VMState {
  const running = entry.running ?? entry.Running;
  if (typeof running === "boolean") {
    return running ? "running" : "stopped";
  }

  const raw = entry.state ?? entry.State ?? entry.status ?? entry.Status;
  if (typeof raw === "string") {
    const state = raw.toLowerCase();
    if (state.includes("running")) return "running";
    if (state.includes("stopped") || state.includes("suspended") || state.includes("shut")) {
      return "stopped";
    }
    if (state.includes("paused")) return "paused";
    if (state.includes("saved")) return "saved";
  }
  return "unknown";
}

function parseListJson(stdout: string): VMHandle[] | null {
  try {
    const parsed = JSON.parse(stdout) as unknown;
    const entries = Array.isArray(parsed)
      ? parsed
      : parsed &&
          typeof parsed === "object" &&
          "vms" in parsed &&
          Array.isArray((parsed as { vms?: unknown }).vms)
        ? (parsed as { vms: unknown[] }).vms
        : parsed &&
            typeof parsed === "object" &&
            "VMs" in parsed &&
            Array.isArray((parsed as { VMs?: unknown }).VMs)
          ? (parsed as { VMs: unknown[] }).VMs
          : null;

    if (!entries) return null;
    return entries
      .map((entry) => {
        if (!entry || typeof entry !== "object") return null;
        const e = entry as TartListEntry;
        const rawName = e.name ?? e.Name;
        if (typeof rawName !== "string" || rawName.length === 0) return null;
        return { id: rawName, name: rawName, backend: "tart" };
      })
      .filter((h): h is VMHandle => h !== null);
  } catch {
    return null;
  }
}

function parseListText(stdout: string): VMHandle[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !/^name\s+/i.test(line))
    .map((line) => line.split(/\s+/)[0])
    .filter((name) => name && name.toLowerCase() !== "source")
    .map((name) => ({ id: name, name, backend: "tart" }));
}

function parseStateFromList(stdout: string, vmName: string): VMState {
  try {
    const parsed = JSON.parse(stdout) as unknown;
    const entries = Array.isArray(parsed)
      ? parsed
      : parsed &&
          typeof parsed === "object" &&
          "vms" in parsed &&
          Array.isArray((parsed as { vms?: unknown }).vms)
        ? (parsed as { vms: unknown[] }).vms
        : parsed &&
            typeof parsed === "object" &&
            "VMs" in parsed &&
            Array.isArray((parsed as { VMs?: unknown }).VMs)
          ? (parsed as { VMs: unknown[] }).VMs
          : [];
    const found = entries.find((entry) => {
      if (!entry || typeof entry !== "object") return false;
      const e = entry as TartListEntry;
      return (e.name ?? e.Name) === vmName;
    }) as TartListEntry | undefined;
    return found ? stateFromEntry(found) : "unknown";
  } catch {
    const line = stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.startsWith(`${vmName} `) || l === vmName);
    if (!line) return "unknown";
    const lower = line.toLowerCase();
    return lower.includes("running") ? "running" : "stopped";
  }
}

function checkpointVmName(vmName: string, label: string): string {
  const safeVm = sanitizeVmName(vmName);
  const slug = sanitizeLabel(label)
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
  const maxVmLen = Math.max(1, 100 - CHECKPOINT_SEPARATOR.length - slug.length);
  return `${safeVm.slice(0, maxVmLen)}${CHECKPOINT_SEPARATOR}${slug}`;
}

export class TartBackend implements HypervisorBackend {
  readonly name = "tart";

  private readonly tartPath: string;
  private readonly commandRunner: TartCommandRunner | undefined;
  private readonly spawnRunner: TartSpawnRunner | undefined;
  private readonly startTimeoutMs: number;
  private readonly noGraphics: boolean;
  private readonly suspendable: boolean;
  private readonly ipResolver: "dhcp" | "arp" | "agent";

  constructor(options: TartBackendOptions = {}) {
    this.tartPath = options.tartPath ?? "tart";
    this.commandRunner = options.commandRunner;
    this.spawnRunner = options.spawnRunner;
    this.startTimeoutMs = options.startTimeoutMs ?? 120_000;
    this.noGraphics = options.noGraphics ?? true;
    this.suspendable = options.suspendable ?? false;
    this.ipResolver = options.ipResolver ?? "dhcp";
  }

  async isAvailable(): Promise<boolean> {
    if (process.platform !== "darwin") return false;
    try {
      await this.run(["--version"], 5_000);
      return true;
    } catch {
      return false;
    }
  }

  async createVM(config: VMConfig): Promise<VMHandle> {
    const name = sanitizeVmName(config.name);
    if (!config.template) {
      throw new Error(
        "Tart VM creation requires VMConfig.template to name a local Tart VM or OCI image.",
      );
    }

    await this.run(["clone", config.template, name], 3_600_000);

    if (config.cpus !== undefined) {
      await this.setVmProcessor({ id: name, name, backend: this.name }, config.cpus);
    }
    if (config.memoryMB !== undefined) {
      await this.setVmMemory({ id: name, name, backend: this.name }, config.memoryMB);
    }
    if (config.diskGB !== undefined) {
      await this.run(["set", name, "--disk-size", String(config.diskGB)], 300_000);
    }

    return { id: name, name, backend: this.name };
  }

  async startVM(handle: VMHandle): Promise<void> {
    const name = sanitizeVmName(handle.name);
    const before = await this.getStatus(handle).catch(() => undefined);
    if (before?.state === "running") return;

    const args = ["run"];
    if (this.noGraphics) args.push("--no-graphics");
    if (this.suspendable) args.push("--suspendable");
    args.push(name);

    const childState: {
      exited?: { code: number | null; signal: NodeJS.Signals | null };
      spawnError?: Error;
    } = {};
    const child = this.spawn(args);
    child.once("exit", (code, signal) => {
      childState.exited = { code, signal };
    });
    child.once("error", (err) => {
      childState.spawnError = err;
    });
    child.unref?.();

    const deadline = Date.now() + this.startTimeoutMs;
    while (Date.now() < deadline) {
      if (childState.spawnError) {
        throw new Error(`Failed to start Tart VM '${name}': ${childState.spawnError.message}`);
      }
      if (childState.exited) {
        throw new Error(
          `Tart VM '${name}' exited before reaching running state (code=${childState.exited.code}, signal=${childState.exited.signal}).`,
        );
      }
      const status = await this.getStatus(handle).catch(() => undefined);
      if (status?.state === "running") return;
      await sleep(1_000);
    }

    throw new Error(`Tart VM '${name}' did not reach running state within ${this.startTimeoutMs}ms`);
  }

  async stopVM(handle: VMHandle, force = false): Promise<void> {
    const name = sanitizeVmName(handle.name);
    const args = force ? ["stop", name, "--timeout", "1"] : ["stop", name];
    await this.run(args, force ? 30_000 : 300_000);
  }

  async pauseVM(handle: VMHandle): Promise<void> {
    await this.run(["suspend", sanitizeVmName(handle.name)], 300_000);
  }

  async resumeVM(handle: VMHandle): Promise<void> {
    await this.startVM(handle);
  }

  async deleteVM(handle: VMHandle): Promise<void> {
    const name = sanitizeVmName(handle.name);
    await this.run(["delete", name], 300_000);
  }

  async getStatus(handle: VMHandle): Promise<VMStatus> {
    const name = sanitizeVmName(handle.name);
    const { stdout } = await this.run(["list", "--format", "json"], 30_000);
    const state = parseStateFromList(stdout, name);
    let ipAddress: string | undefined;
    if (state === "running") {
      ipAddress = await this.getVmIpAddress(handle).catch(() => undefined);
    }
    return {
      handle: { id: handle.id || name, name, backend: this.name },
      state,
      ipAddress,
      guestAgentReachable: false,
    };
  }

  async listVMs(): Promise<VMHandle[]> {
    const { stdout } = await this.run(["list", "--format", "json"], 30_000);
    return parseListJson(stdout) ?? parseListText(stdout);
  }

  async createCheckpoint(handle: VMHandle, label: string): Promise<CheckpointHandle> {
    const cpName = checkpointVmName(handle.name, label);
    await this.run(["clone", sanitizeVmName(handle.name), cpName], 3_600_000);
    return {
      id: cpName,
      label: sanitizeLabel(label),
      vmHandle: { id: handle.id, name: sanitizeVmName(handle.name), backend: this.name },
    };
  }

  async restoreCheckpoint(checkpoint: CheckpointHandle): Promise<void> {
    const target = sanitizeVmName(checkpoint.vmHandle.name);
    const source = checkpoint.id || checkpointVmName(target, checkpoint.label);
    const priorStatus = await this.getStatus(checkpoint.vmHandle).catch(() => undefined);
    if (priorStatus?.state === "running") {
      await this.stopVM(checkpoint.vmHandle, true);
    }
    await this.deleteVM({ id: target, name: target, backend: this.name });
    await this.run(["clone", source, target], 3_600_000);
  }

  async deleteCheckpoint(checkpoint: CheckpointHandle): Promise<void> {
    const name = checkpoint.id || checkpointVmName(checkpoint.vmHandle.name, checkpoint.label);
    await this.run(["delete", sanitizeVmName(name)], 300_000);
  }

  async listCheckpoints(handle: VMHandle): Promise<CheckpointInfo[]> {
    const prefix = `${sanitizeVmName(handle.name)}${CHECKPOINT_SEPARATOR}`;
    const vms = await this.listVMs();
    return vms
      .filter((vm) => vm.name.startsWith(prefix))
      .map((vm) => ({
        id: vm.name,
        label: vm.name.slice(prefix.length),
        createdAt: new Date(0),
      }));
  }

  async copyFileToVM(
    _handle: VMHandle,
    hostPath: string,
    _guestPath: string,
    _progress?: ProgressCallback,
  ): Promise<void> {
    sanitizePath(hostPath);
    throw new Error(
      "Tart file copy is not available through Signalman yet. Use a Tart shared directory at VM start or install the Signalman guest agent.",
    );
  }

  async copyFileFromVM(
    _handle: VMHandle,
    guestPath: string,
    _hostPath: string,
    _progress?: ProgressCallback,
  ): Promise<void> {
    sanitizePath(guestPath);
    throw new Error(
      "Tart file copy is not available through Signalman yet. Use a Tart shared directory at VM start or install the Signalman guest agent.",
    );
  }

  async executeCommand(
    handle: VMHandle,
    command: string,
    args: string[] = [],
    timeoutMs = 60_000,
  ): Promise<CommandResult> {
    const startTime = Date.now();
    const safeTimeout = sanitizeTimeout(timeoutMs);
    const safeCommand = sanitizeCommand(command);
    const safeArgs = args.map((arg) => sanitizeCommand(arg));

    try {
      const { stdout, stderr } = await this.run(
        ["exec", sanitizeVmName(handle.name), safeCommand, ...safeArgs],
        safeTimeout,
      );
      return {
        exitCode: 0,
        stdout,
        stderr,
        durationMs: Date.now() - startTime,
      };
    } catch (err) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: errorMessage(err),
        durationMs: Date.now() - startTime,
      };
    }
  }

  async getVmIpAddress(handle: VMHandle): Promise<string> {
    const args = ["ip"];
    if (this.ipResolver !== "dhcp") {
      args.push(`--resolver=${this.ipResolver}`);
    }
    args.push(sanitizeVmName(handle.name));
    const { stdout } = await this.run(args, 30_000);
    const ip = stdout.trim();
    if (!ip) throw new Error(`No IP address found for Tart VM '${handle.name}'`);
    return ip;
  }

  async waitForHeartbeat(handle: VMHandle, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + sanitizeTimeout(timeoutMs, 1_800_000);
    while (Date.now() < deadline) {
      const result = await this.executeCommand(handle, "/usr/bin/true", [], 5_000);
      if (result.exitCode === 0) return true;
      await sleep(2_000);
    }
    return false;
  }

  async setVmMemory(handle: VMHandle, memoryMB: number): Promise<void> {
    if (!Number.isInteger(memoryMB) || memoryMB < 512 || memoryMB > 1_048_576) {
      throw new Error(`Invalid Tart memory value: ${memoryMB}MB.`);
    }
    await this.run(["set", sanitizeVmName(handle.name), "--memory", String(memoryMB)], 300_000);
  }

  async setVmProcessor(handle: VMHandle, count: number): Promise<void> {
    if (!Number.isInteger(count) || count < 1 || count > 64) {
      throw new Error(`Invalid Tart processor count: ${count}.`);
    }
    await this.run(["set", sanitizeVmName(handle.name), "--cpu", String(count)], 300_000);
  }

  private async run(args: string[], timeoutMs: number): Promise<TartCommandOutput> {
    if (this.commandRunner) {
      return this.commandRunner(args, timeoutMs);
    }

    try {
      const { stdout, stderr } = await exec(this.tartPath, args, {
        timeout: timeoutMs,
        maxBuffer: 10 * 1024 * 1024,
        encoding: "utf8",
      });
      return { stdout: String(stdout ?? "").trim(), stderr: String(stderr ?? "").trim() };
    } catch (err) {
      throw new Error(`tart ${args.join(" ")} failed: ${errorMessage(err)}`);
    }
  }

  private spawn(args: string[]): TartChildProcess {
    if (this.spawnRunner) {
      return this.spawnRunner(args);
    }
    return spawn(this.tartPath, args, {
      detached: true,
      stdio: "ignore",
    }) as ChildProcess;
  }
}
