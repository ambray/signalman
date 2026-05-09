/**
 * Scenario orchestrator — multi-VM scenario execution engine.
 *
 * Coordinates setup, workflow execution, assertion evaluation, and
 * teardown across multiple VMs. Bridges the hypervisor backend and
 * guest agent clients to execute scenario DSL actions.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { HypervisorBackend, VMHandle } from "../hypervisors/interface.js";
import { GuestAgentClient, type CommandResult } from "../guest/client.js";
import { describeUiActionTargets, describeUiElements } from "../guest/ui-elements.js";
import { ensureUiSidecar } from "../guest/ui-sidecar.js";
import { withUiSidecarRecovery, type UiSidecarRecoveryOptions } from "../guest/ui-recovery.js";
import type { SignalmanConfig } from "../config.js";
import type { DockerClient, ComposeConfig } from "../docker/client.js";
import {
  loadScenario,
  evaluateAssertions,
  evaluateAssertionsV2,
  extractToolBlocks,
} from "./runner.js";
import type {
  SetupStep,
  SandboxMode,
} from "./runner.js";
import type { ValidatedRetryPolicy } from "./schema.js";
import type { EnvelopeEventEmitter } from "../output/envelope.js";
import { runWithTrace, type TraceContext } from "../output/trace.js";
import { parseNarrative } from "./narrative.js";
import { BreakLog } from "../kernel-debug/break-log.js";
import { createKernelDebugToolRegistry } from "../kernel-debug/tools.js";
import type { ToolRegistry } from "../kernel-debug/tool-registry.js";
// KdSession type is only referenced via `import("...")` in member
// signatures, so no value import is needed here. The factory module
// provides the default constructor wrapper.
import {
  createRealKdSession,
  type KdSessionFactory,
} from "../kernel-debug/factory.js";

// ── P3.b retry helpers ────────────────────────────────────────────

/**
 * Resolve the effective retry policy for a setup/teardown step.
 *
 * Per-step `retry:` beats scenario-level `retry:` beats no retry. A
 * `count: 0` policy is preserved (explicit "no retry" override on a
 * step-by-step basis). Returns `undefined` when no retry applies.
 */
function resolveStepRetry(
  step: { retry?: ValidatedRetryPolicy } & Record<string, unknown>,
  scenarioRetry: ValidatedRetryPolicy | undefined,
): ValidatedRetryPolicy | undefined {
  if (step.retry) return step.retry;
  return scenarioRetry;
}

/**
 * Compute the next backoff delay in ms for a retry attempt.
 *
 * v0.1.0 P3.b ships a constant backoff (`policy.backoff_ms`) with
 * optional ±25% jitter. Exponential backoff is reserved for a follow-up
 * (audit C5 only required constant; exponential is defensible but adds
 * surface area without an established consumer need).
 *
 * `attempt` is the failed attempt number (1-indexed). Currently unused
 * for the constant policy but the parameter keeps the signature
 * forward-compat for an exponential variant.
 */
function computeBackoff(policy: ValidatedRetryPolicy, _attempt: number): number {
  const base = policy.backoff_ms;
  if (!policy.jitter) return base;
  // ±25% jitter; uniform across [0.75, 1.25] of base.
  const factor = 0.75 + Math.random() * 0.5;
  return Math.max(0, Math.floor(base * factor));
}

function resolveHostFilePath(hostPath: string): string {
  if (path.isAbsolute(hostPath) || path.win32.isAbsolute(hostPath)) {
    return hostPath;
  }
  return path.resolve(hostPath);
}

function resolveWorkflowScreenshotPath(
  output: string,
  config: SignalmanConfig,
): string {
  if (path.isAbsolute(output) || path.win32.isAbsolute(output)) {
    return output;
  }
  const normalized = output.replace(/\\/g, "/").replace(/^\.\//, "");
  if (normalized === "output" || normalized.startsWith("output/")) {
    return path.resolve(path.dirname(config.scenarios.outputDir), normalized);
  }
  return path.resolve(config.scenarios.screenshotDir, output);
}

function uiActionWorkflowResult(result: { success: boolean; error: string; durationMs?: number }) {
  return {
    success: result.success,
    error: result.error,
    duration_ms: result.durationMs ?? 0,
  };
}

function uiRecoveryOptions(params: Record<string, unknown>): UiSidecarRecoveryOptions | undefined {
  const username = params.sidecar_username as string | undefined;
  if (!username) return undefined;
  return {
    username,
    engine: params.sidecar_engine as string | undefined,
    waitReadyMs: params.sidecar_wait_ready_ms as number | undefined,
    timeoutMs: params.timeout_ms as number | undefined,
  };
}

/**
 * Local helper so the class body can stay synchronous when wiring a
 * kernel-debug session. Importing BreakLog at the top is cheap (no
 * side effects, no Win32 touch) so static import is fine.
 */
function createBreakLog(
  session: import("../kernel-debug/kd-session.js").KdSession,
): BreakLog {
  return new BreakLog(session);
}

/**
 * Build the orchestrator's initial tool registry — starts with the
 * kernel-debug tools registered by `tools.ts`. Future sprints can
 * extend by calling `orchestrator.tools.register(...)` from their
 * own modules after construction.
 */
function createInitialToolRegistry(): ToolRegistry {
  return createKernelDebugToolRegistry();
}

// `createRealKdSession` moved to `kernel-debug/factory.ts` (follow-up
// 2). Imported at the top of this file so the class body can use it
// as the default kdSessionFactory without touching the concrete
// KdSession constructor.
import { writeJunitReport } from "../output/reporter.js";
import type { TestResult, AssertionResultEntry, ToolBlockResult } from "../output/reporter.js";

const GUEST_FILE_CHUNK_BYTES = 1024 * 1024;

// ── Types ──────────────────────────────────────────────────────────

/** VM definition as declared in a scenario's setup.yaml. */
export interface VmDefinition {
  /** Logical name used in scenario steps (e.g., "endpoint-1"). */
  name: string;
  /** Template name or checkpoint to restore from. */
  template: string;
  /** Checkpoint to restore before the test starts. */
  checkpoint_restore?: string;
  /**
   * Whether `checkpoint_restore` names a warm-state checkpoint. Defaults
   * to `true` (the schema layer applies that default for parsed scenarios;
   * `resolveVms` re-applies it for direct construction in tests).
   *
   * The flag exists primarily as a contract marker today: every
   * `restoreCheckpoint` call goes through the optimised stop-then-restore
   * path in `hyperv.ts`. When `false`, the orchestrator emits a warning so
   * the slow-stabilisation expectation is visible in scenario logs — that
   * surfaces drift as scenarios are migrated to warm checkpoints over time
   * (see Sprint 60 P2 follow-up).
   */
  warm_checkpoint?: boolean;
  /**
   * P9.4 v0.1.1 — auto-provision the VM if missing before scenario
   * starts. See `host/src/scenarios/schema.ts` `vmConfigSchema` for
   * the YAML-side documentation. When false (default), a missing VM
   * is a hard fail with a remediation hint pointing at this flag.
   */
  provision_if_missing?: boolean;
  /**
   * When true, skip ALL Hyper-V/VMware management for this VM
   * (`listVMs`, `restoreCheckpoint`, `startVM`, `waitForHeartbeat`).
   * The VM must already be running and at the desired state before the
   * scenario runs; the orchestrator constructs a synthetic VMHandle
   * with id `"pre-started"` and proceeds straight to
   * `waitForGuestAgents`. See schema.ts `vmConfigSchema.pre_started`
   * for the operator-facing rationale (Sprint 60.12 Phase B —
   * unprivileged host-CLI runs).
   */
  pre_started?: boolean;
  /**
   * Whether to wait for the hypervisor heartbeat integration service
   * after restore/start. Defaults to true; backend-only smoke scenarios
   * can set false when they only need PowerShell Direct / VM file copy.
   */
  wait_for_heartbeat?: boolean;
  /** Guest agent gRPC port (default: 50051). */
  guest_agent_port: number;
  /** Network configuration. */
  network?: {
    switch: string;
    static_ip: string;
  };
  /** Kernel-debug config, copied through from setup.yaml. When
   * `enabled: true`, `resolveVms` spawns a KdSession for this VM. */
  kernel_debug?: import("./runner.js").KernelDebugConfig;
}

/** Result of a single setup/teardown step. */
export interface StepResult {
  action: string;
  vm: string;
  status: "success" | "failed" | "skipped";
  duration_ms: number;
  error?: string;
  /**
   * Total number of attempts the step took (1 if no retry configured or
   * retry succeeded on first try). Populated only when retry was active
   * to keep envelopes tidy for the common no-retry case. P3.b deliverable.
   */
  attempts?: number;
  /**
   * Error messages from prior failed attempts (excluding the final
   * attempt — its error appears in `error` for failed runs, or is
   * absent for retry-then-success). Populated only when at least one
   * intermediate attempt failed. P3.b deliverable.
   */
  attempt_failures?: string[];
}

/** Result of a single assertion evaluation. */
export interface AssertionResult {
  id: string;
  description: string;
  passed: boolean;
  actual?: string;
  error?: string;
}

/** Overall result of a scenario execution. */
export interface ScenarioResult {
  name: string;
  status: "passed" | "failed" | "error";
  duration_ms: number;
  setup_results: StepResult[];
  assertion_results: AssertionResult[];
  teardown_results: StepResult[];
  error?: string;
  /**
   * Sandbox enforcement mode this run executed under.
   *
   * Populated when the scenario's `sandbox_modes:` list is used (Sprint
   * 60 Phase 5, Story 5.2). Absent for single-mode runs.
   */
  sandbox_mode?: SandboxMode;
}

/**
 * Aggregated results from running a scenario across multiple sandbox modes.
 *
 * Produced by `ScenarioOrchestrator.runScenarioMultiMode` when the
 * scenario's `setup.yaml` declares a `sandbox_modes:` list. The Phase 5
 * regression detector consumes this shape to diff sandboxed runs against
 * the `none` baseline.
 *
 * # Sprint Reference
 * Sprint 60, Phase 5, Story 5.2.
 */
export interface MultiModeResult {
  scenario: string;
  /** One entry per mode in the order declared by the scenario config. */
  runs: Array<{
    mode: SandboxMode;
    result: ScenarioResult;
  }>;
  total_duration_ms: number;
}

// ── Template variable substitution (Story 5.2) ────────────────────

/**
 * Substitute `${VAR_NAME}` tokens in a value recursively.
 *
 * Walks strings (replace), arrays (map), and plain objects (clone keys).
 * Non-string primitives pass through unchanged. Used by the multi-mode
 * scenario runner to stamp `${SANDBOX_MODE}` into setup steps and tool
 * block parameters.
 */
export function substituteVarsDeep(
  value: unknown,
  vars: Record<string, string>,
): unknown {
  if (typeof value === "string") {
    return value.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (match, name: string) => {
      return Object.prototype.hasOwnProperty.call(vars, name) ? vars[name] : match;
    });
  }
  if (Array.isArray(value)) {
    return value.map((v) => substituteVarsDeep(v, vars));
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = substituteVarsDeep(v, vars);
    }
    return out;
  }
  return value;
}

class ReferenceResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReferenceResolutionError";
  }
}

function mergeRuntimeParams(
  declared: Record<string, unknown> | undefined,
  supplied: Record<string, unknown>,
): Record<string, unknown> {
  return { ...(declared ?? {}), ...supplied };
}

function secretFromEnv(name: string): string | undefined {
  return process.env[`SIGNALMAN_SECRET_${name}`] ?? process.env[name];
}

function substituteRuntimeRefs(input: string, params: Record<string, unknown>): string {
  return input.replace(
    /\$\{(param|secret):([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g,
    (_match, kind: string, name: string, def?: string) => {
      if (kind === "secret") {
        const value = secretFromEnv(name);
        if (value === undefined) {
          throw new ReferenceResolutionError(`secret-unresolved: ${name}`);
        }
        return value;
      }
      if (Object.prototype.hasOwnProperty.call(params, name)) {
        return String(params[name]);
      }
      if (def !== undefined) return def;
      throw new ReferenceResolutionError(`parameter-unresolved: ${name}`);
    },
  );
}

export function substituteRuntimeRefsDeep(
  value: unknown,
  params: Record<string, unknown>,
): unknown {
  if (typeof value === "string") return substituteRuntimeRefs(value, params);
  if (Array.isArray(value)) return value.map((v) => substituteRuntimeRefsDeep(v, params));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = substituteRuntimeRefsDeep(v, params);
    }
    return out;
  }
  return value;
}

function pathAllowed(actual: string, allowed: string[] | undefined): boolean {
  if (!allowed || allowed.length === 0) return false;
  const normalizeCapabilityPath = (p: string) =>
    path.normalize(p).replace(/[\\/]+/g, "/").toLowerCase();
  const norm = normalizeCapabilityPath(actual);
  return allowed.some((pattern) => {
    const normalizedPattern = normalizeCapabilityPath(pattern);
    if (normalizedPattern.endsWith("/**")) {
      const prefix = normalizedPattern.slice(0, -3);
      return norm === prefix || norm.startsWith(`${prefix}/`);
    }
    return norm === normalizedPattern;
  });
}

function copyStepHostPath(step: Record<string, unknown>): string | undefined {
  if (typeof step.host_path === "string") return step.host_path;
  if (step.action !== "vm_copy_file") return undefined;

  const direction = (step.direction as string | undefined) ?? "host_to_guest";
  const writesHost = direction === "from_vm" || direction === "guest_to_host";
  const legacyField = writesHost ? step.dest : step.src;
  return typeof legacyField === "string" ? legacyField : undefined;
}

function requireCapability(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`capability-denied: ${message}`);
  }
}

export function assertScenarioCapabilities(
  config: import("./runner.js").ScenarioConfig,
  workflowMarkdown: string,
): void {
  const caps = config.capabilities;
  if (!caps) return;

  const allowedVms = new Set([...(caps.vms ?? []), ...(caps.hosts ?? [])]);
  const allowedNetworks = new Set(caps.networks ?? []);
  const hostRead = caps.host_paths?.read;
  const hostWrite = caps.host_paths?.write;

  for (const vm of config.vms ?? []) {
    if (allowedVms.size > 0) {
      requireCapability(allowedVms.has(vm.name), `VM '${vm.name}' is not declared in capabilities.vms`);
    }
    const switchName = vm.network?.switch;
    if (switchName && allowedNetworks.size > 0) {
      requireCapability(
        allowedNetworks.has(switchName),
        `network '${switchName}' is not declared in capabilities.networks`,
      );
    }
  }

  const setupSteps = [...(config.setup ?? []), ...(config.teardown ?? [])];
  const workflowSteps = extractToolBlocks(workflowMarkdown).map((block) => ({
    action: block.tool,
    ...block.params,
  }));
  for (const step of [...setupSteps, ...workflowSteps] as Array<Record<string, unknown>>) {
    const vm = step.vm as string | undefined;
    if (vm && allowedVms.size > 0) {
      requireCapability(allowedVms.has(vm), `step '${step.action}' targets undeclared VM '${vm}'`);
    }
    const hostPath = copyStepHostPath(step);
    if (!hostPath) continue;
    const direction = (step.direction as string | undefined) ?? "host_to_guest";
    const writesHost = direction === "from_vm" || direction === "guest_to_host";
    requireCapability(
      pathAllowed(hostPath, writesHost ? hostWrite : hostRead),
      `step '${step.action}' ${writesHost ? "writes" : "reads"} undeclared host path '${hostPath}'`,
    );
  }
}

// ── Orchestrator ───────────────────────────────────────────────────

/**
 * Orchestrates multi-VM scenario execution.
 *
 * Coordinates the full lifecycle: VM resolution, guest agent readiness,
 * setup steps, workflow execution, assertion evaluation, and teardown.
 */
/** Options for the ScenarioOrchestrator. */
export interface OrchestratorOptions {
  /** Directory for writing output reports (JSON, Markdown, JUnit XML). */
  outputDir?: string;
  /**
   * Register a one-shot process `exit` hook that force-terminates any
   * active kernel-debug sessions. Production `signalman run` enables
   * this while unit tests leave it off by default to avoid global
   * listener churn.
   */
  registerProcessExitCleanup?: boolean;
}

interface ProcessExitHookTarget {
  once(event: "exit", listener: () => void): unknown;
  off?(event: "exit", listener: () => void): unknown;
  removeListener?(event: "exit", listener: () => void): unknown;
}

export class ScenarioOrchestrator {
  private readonly outputDir: string | undefined;
  private readonly docker: DockerClient | undefined;

  /**
   * Per-VM kernel-debug sessions + break logs, populated by
   * `setKernelDebugSession()` when `kernel_debug.enabled: true` is
   * configured in setup.yaml. Missing when kernel debugging isn't
   * enabled for a VM; tool blocks that require it throw a clear
   * error. Sprint 60.7.5 Phase 1e.
   */
  private kernelDebug: Map<
    string,
    {
      session: import("../kernel-debug/kd-session.js").KdSession;
      breakLog: import("../kernel-debug/break-log.js").BreakLog;
    }
  > = new Map();

  /**
   * Pluggable tool registry — handles the driver_* / kernel_* tool
   * blocks added in Sprint 60.7.5 and anything subsequent sprints
   * register. Consulted by `executeToolBlock` before the legacy
   * switch's default branch.
   *
   * Existing tools (`vm_run_command`, `wait`, `ui_*`, `docker_*`,
   * etc.) stay in the switch for now; they're already working and
   * migrating them is a separate refactor with its own risk budget.
   */
  private readonly toolRegistry: import("../kernel-debug/tool-registry.js").ToolRegistry;
  private processExitCleanup: (() => void) | undefined;

  constructor(
    private backend: HypervisorBackend,
    private guestClients: Map<string, GuestAgentClient>,
    private config: SignalmanConfig,
    options?: OrchestratorOptions & { docker?: DockerClient },
  ) {
    this.outputDir = options?.outputDir;
    this.docker = options?.docker;
    // Lazy-import-compatible initializer — the import below is static
    // so there's no circular-dep risk (kernel-debug doesn't import
    // orchestrator).

    this.toolRegistry = createInitialToolRegistry();
    if (options?.registerProcessExitCleanup) {
      this.registerProcessExitCleanup();
    }
  }

  /**
   * Narrow accessor used by the pluggable tool registry; returns
   * `undefined` when no guest client is registered for the given VM.
   *
   * Public so tools (`kernel-debug/tools.ts`) can look up
   * dependencies without needing the full orchestrator surface.
   */
  getGuestClient(vmName: string): GuestAgentClient | undefined {
    return this.guestClients.get(vmName);
  }

  /**
   * Narrow accessor for the kernel-debug binding on a given VM, or
   * `undefined` when none exists. Counterpart to `getGuestClient`.
   */
  getKernelDebug(
    vmName: string,
  ): import("../kernel-debug/tool-registry.js").KernelDebugBinding | undefined {
    return this.kernelDebug.get(vmName);
  }

  /**
   * Access the tool registry. Primarily for tests; most callers reach
   * tools via `executeToolBlock`.
   */
  get tools(): import("../kernel-debug/tool-registry.js").ToolRegistry {
    return this.toolRegistry;
  }

  /**
   * Attach a kernel-debug session to a named VM. Creates the matching
   * {@link BreakLog} and subscribes it to the session's `break`
   * events. Idempotent — re-calling for the same vmName replaces the
   * existing session (detaching the prior break log first).
   *
   * Scenarios with `kernel_debug.enabled: true` in setup.yaml have
   * the orchestrator's lifecycle wiring call this during VM
   * resolution; tests can call it directly to drive the handlers
   * without the full lifecycle scaffolding.
   */
  setKernelDebugSession(
    vmName: string,
    session: import("../kernel-debug/kd-session.js").KdSession,
  ): void {
    // Lazy import to avoid circular dep at module init.
    // BreakLog is tiny — the dynamic-import cost here is trivial.
    const prior = this.kernelDebug.get(vmName);
    if (prior) {
      prior.breakLog.detach();
    }
    // Synchronous construction — imported via the static type above.
    // We use a require-like trick via the top-level TS imports below.
    this.kernelDebug.set(vmName, {
      session,
      breakLog: createBreakLog(session),
    });
  }

  /**
   * Detach all kernel-debug break logs. Called at scenario teardown.
   * Does NOT kill the kd sessions themselves — the orchestrator
   * owns the break-log subscription, not the kd lifecycle (which is
   * the caller's responsibility, so the session survives across
   * multiple scenarios if the caller wants).
   */
  detachKernelDebugSessions(): void {
    for (const { breakLog } of this.kernelDebug.values()) {
      breakLog.detach();
    }
    this.kernelDebug.clear();
  }

  /**
   * Full teardown: detach break logs AND stop the underlying
   * `KdSession` processes. Called by the scenario runner at scenario
   * end so kd.exe children don't leak across back-to-back scenarios.
   *
   * Safe to call even if no sessions were spawned. Best-effort — a
   * failed detach on one session does not prevent the others from
   * being cleaned up.
   */
  async teardownKernelDebugSessions(): Promise<void> {
    const errors: unknown[] = [];
    for (const { session, breakLog } of this.kernelDebug.values()) {
      breakLog.detach();
      try {
        await session.detach();
      } catch (e) {
        errors.push(e);
      }
    }
    this.kernelDebug.clear();
    if (errors.length > 0 && process.env.SIGNALMAN_DEBUG === "1") {
      // Debug-only surface — most detach failures mean the process
      // was already dead, which is fine.

      console.error(
        `[orchestrator] ${errors.length} kernel-debug teardown error(s):`,
        errors.map((e) => (e instanceof Error ? e.message : String(e))),
      );
    }
    this.unregisterProcessExitCleanup();
  }

  /**
   * Register emergency cleanup for Node process exit. The hook cannot
   * await async detach, so it uses the synchronous KdSession emergency
   * path when available and otherwise starts detach best-effort.
   */
  registerProcessExitCleanup(target: ProcessExitHookTarget = process): void {
    if (this.processExitCleanup) return;

    const handler = () => this.forceTerminateKernelDebugSessions();
    target.once("exit", handler);
    this.processExitCleanup = () => {
      if (typeof target.off === "function") {
        target.off("exit", handler);
        return;
      }
      target.removeListener?.("exit", handler);
    };
  }

  unregisterProcessExitCleanup(): void {
    const cleanup = this.processExitCleanup;
    if (!cleanup) return;
    this.processExitCleanup = undefined;
    cleanup();
  }

  forceTerminateKernelDebugSessions(): void {
    for (const { session, breakLog } of this.kernelDebug.values()) {
      breakLog.detach();
      const maybeForce = session as typeof session & { forceTerminate?: () => void };
      if (typeof maybeForce.forceTerminate === "function") {
        maybeForce.forceTerminate();
        continue;
      }
      void session.detach().catch(() => undefined);
    }
    this.kernelDebug.clear();
  }

  /**
   * Injection point for `spawnKernelDebugSessions`. Scenarios that
   * need a custom KdSession construction (mocks in tests, a future
   * multi-transport deployment) can swap this in via `setKdSessionFactory`.
   * Default factory is `createRealKdSession` defined below this class.
   */
  private kdSessionFactory: KdSessionFactory = createRealKdSession;

  /**
   * Override the default kd session factory. Tests call this to
   * inject a fake that returns a controllable session without
   * spawning kd.exe. Production code should not need this.
   */
  setKdSessionFactory(factory: KdSessionFactory): void {
    this.kdSessionFactory = factory;
  }

  /**
   * For every VM def with `kernel_debug.enabled: true`, construct a
   * KdSession (via the injectable factory), start it, and attach a
   * BreakLog via `setKernelDebugSession`. Called once from
   * `runScenario` after `resolveVms`.
   *
   * Scenarios without any kernel_debug VMs never touch this code —
   * no kd.exe is spawned, no network pipes are opened.
   */
  private async spawnKernelDebugSessions(
    vmDefs: VmDefinition[],
  ): Promise<void> {
    for (const def of vmDefs) {
      const kd = def.kernel_debug;
      if (!kd || !kd.enabled) continue;

      const pipe = (kd.pipe ?? "\\\\.\\pipe\\kd-{vm_name}").replace(
        "{vm_name}",
        def.name,
      );
      const symbolPath =
        kd.symbol_path ??
        "srv*C:\\Symbols*https://msdl.microsoft.com/download/symbols";
      const kdExe = kd.kd_exe ?? "kd.exe";

      // Build kd CLI args. Serial-over-pipe is the only supported
      // transport at the time of writing; decision #2 in the sprint
      // doc rules out KDNET / KDVM for v1.
      const kdArgs = [
        "-k",
        `com:pipe,port=${pipe},baud=115200,reconnect`,
        "-y",
        symbolPath,
      ];

      const session = this.kdSessionFactory({
        kdExe,
        kdArgs,
        breakOnLoad: kd.break_on_load,
        breakOnBugcheck: kd.break_on_bugcheck,
      });
      await session.start();
      this.setKernelDebugSession(def.name, session);
    }
  }

  /**
   * Return the DockerClient or throw a descriptive error.
   *
   * Called by docker_compose_up / docker_compose_down handlers so that
   * the orchestrator still works without a Docker client for VM-only
   * scenarios.
   */
  private requireDocker(): DockerClient {
    if (!this.docker) {
      throw new Error(
        "Docker action requested but no DockerClient was provided to the orchestrator. " +
        "Pass a DockerClient via the `docker` option in the constructor.",
      );
    }
    return this.docker;
  }

  protected async ensureGuestClient(
    vmName: string,
    handle: VMHandle,
    def?: VmDefinition,
  ): Promise<GuestAgentClient> {
    const existing = this.guestClients.get(vmName);
    if (existing) return existing;

    const ipAddress =
      def?.network?.static_ip ??
      (this.backend.getVmIpAddress
        ? await this.backend.getVmIpAddress(handle)
        : undefined);
    if (!ipAddress) {
      throw new Error(`Cannot create guest client for VM '${vmName}': no IP address available`);
    }

    const tlsConfig = this.config.guestAgent.tls;
    const tlsOptions = tlsConfig.enabled
      ? {
          caPath: tlsConfig.caPath,
          certPath: tlsConfig.certPath,
          keyPath: tlsConfig.keyPath,
        }
      : undefined;

    const client = new GuestAgentClient(
      ipAddress,
      def?.guest_agent_port ?? this.config.guestAgent.defaultPort,
      tlsOptions,
      { authToken: this.config.guestAgent.authToken },
    );
    this.guestClients.set(vmName, client);
    return client;
  }

  private async copyFileToGuest(
    vmName: string,
    handle: VMHandle,
    hostPath: string,
    guestPath: string,
  ): Promise<void> {
    const client = this.guestClients.get(vmName);
    const resolvedHostPath = resolveHostFilePath(hostPath);
    if (!client) {
      await this.backend.copyFileToVM(handle, resolvedHostPath, guestPath);
      return;
    }

    // Sprint 60.12 Phase B — pre-started VMs route through the
    // hardened HTTP-over-gRPC helper. The helper adds:
    //   * SHA-cache fast-path (12 min → <2 s on no-op repeat runs)
    //   * Atomic temp + rename (no half-written destination on failure)
    //   * Overall transfer deadline (10 min default)
    //   * Bounded retry (maxRetries: 1) — avoids 4×60 s retry storms
    //   * 5 s health probe up front — fails fast on dead guests
    //
    // For non-pre-started VMs we keep the simpler chunked-writeFile
    // loop: those scenarios run with the SystemBackend service which
    // gives us Copy-VMFile elevation, and the writeFile path is
    // measurably faster on the cold-cache common case.
    if (handle.id === "pre-started") {
      const { copyFileToGuestViaHttp } = await import("../guest/file_transfer.js");
      await copyFileToGuestViaHttp(client, resolvedHostPath, guestPath);
      return;
    }

    const fd = fs.openSync(resolvedHostPath, "r");
    try {
      const buffer = Buffer.allocUnsafe(GUEST_FILE_CHUNK_BYTES);
      let offset = 0;
      let firstChunk = true;
      while (true) {
        const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, offset);
        if (bytesRead === 0) {
          if (firstChunk) {
            await client.writeFile(guestPath, Buffer.alloc(0), false);
          }
          break;
        }
        await client.writeFile(guestPath, buffer.subarray(0, bytesRead), !firstChunk);
        firstChunk = false;
        offset += bytesRead;
      }
    } finally {
      fs.closeSync(fd);
    }
  }

  private async copyFileFromGuest(
    vmName: string,
    handle: VMHandle,
    guestPath: string,
    hostPath: string,
  ): Promise<void> {
    const client = this.guestClients.get(vmName);
    const resolvedHostPath = resolveHostFilePath(hostPath);
    if (!client) {
      await this.backend.copyFileFromVM(handle, guestPath, resolvedHostPath);
      return;
    }
    fs.mkdirSync(path.dirname(resolvedHostPath), { recursive: true });
    const fd = fs.openSync(resolvedHostPath, "w");
    try {
      let offset = 0;
      while (true) {
        const chunk = await client.readFileChunk(guestPath, {
          offset,
          limit: GUEST_FILE_CHUNK_BYTES,
        });
        const data = chunk.data;
        if (data.length === 0) break;
        fs.writeSync(fd, data, 0, data.length);
        offset += data.length;
        if (!chunk.truncated) break;
      }
    } finally {
      fs.closeSync(fd);
    }
  }

  /**
   * Execute a complete scenario: setup, workflow, assertions, teardown.
   *
   * @param scenarioPath - Path to the scenario directory.
   * @param emit - Optional live event emitter (P3.c). When provided, the
   *               orchestrator pushes step lifecycle events
   *               (`step.started`, `step.completed`, `step.failed`,
   *               `step.skipped`, `step.retry_started`) and assertion
   *               results (`assertion.passed`, `assertion.failed`) as
   *               they happen — replacing the legacy retrospective-
   *               replay pattern in `default-executor.ts`. The
   *               `signalman.run` path forwards events into the run's
   *               `EventQueue`; the Loom plugin's P5.3 work routes into
   *               Loom's `EventBus`.
   * @returns The full ScenarioResult.
   */
  async runScenario(
    scenarioPath: string,
    emit?: EnvelopeEventEmitter,
    /**
     * P3.d: trace context propagated to every gRPC call this run makes.
     * `vmName` is filled in per-call inside executeSetup; the {traceId,
     * runId} pair is the run-level constant.
     */
    trace?: { traceId: string; runId: string },
    parameters: Record<string, unknown> = {},
  ): Promise<ScenarioResult> {
    const startTime = Date.now();
    const setupResults: StepResult[] = [];
    const teardownResults: StepResult[] = [];
    let assertionResults: AssertionResult[] = [];
    let scenarioName = "unknown";
    let status: "passed" | "failed" | "error" = "passed";
    let error: string | undefined;
    let resolvedVmMap: Map<string, VMHandle> | undefined;
    let teardownSteps: SetupStep[] = [];
    let scenarioRetry: ValidatedRetryPolicy | undefined;
    // Hoisted so the post-run JUnit/report block (after the outer try)
    // can snapshot workflow step outputs into workflow-outputs.json for
    // post-mortem when assertions fail.
    const workflowOutputsSnapshot = new Map<string, string>();
    // Phase-3 audit (2026-05-05): hoisted so the post-run JUnit
    // synthesis path can read per-tool-block pass/fail.  Populated
    // inside the try block (one entry per tool block executed);
    // empty when scenario fails before reaching workflow execution.
    const toolBlockResults: ToolBlockResult[] = [];

    try {
      const loadResult = loadScenario(scenarioPath);
      const runtimeParams = mergeRuntimeParams(loadResult.config.parameters, parameters);
      const scenarioConfig = substituteRuntimeRefsDeep(
        loadResult.config,
        runtimeParams,
      ) as typeof loadResult.config;
      const workflowMarkdown = substituteRuntimeRefs(loadResult.workflowMarkdown, runtimeParams);
      const assertions = loadResult.assertions;
      scenarioName = scenarioConfig.name;
      assertScenarioCapabilities(scenarioConfig, workflowMarkdown);

      // Resolve VMs
      const vmDefs: VmDefinition[] = scenarioConfig.vms.map((vm) => ({
        name: vm.name,
        template: vm.template,
        checkpoint_restore: vm.checkpoint_restore,
        // Default to warm-checkpoint semantics. The schema layer
        // already applies this default for validator-parsed scenarios;
        // re-apply here so direct construction (tests, future loaders)
        // gets the same behavior.
        warm_checkpoint: vm.warm_checkpoint ?? true,
        wait_for_heartbeat: vm.wait_for_heartbeat ?? true,
        provision_if_missing: vm.provision_if_missing,
        pre_started: vm.pre_started,
        guest_agent_port: vm.guest_agent_port,
        network: vm.network,
        kernel_debug: vm.kernel_debug,
      }));
      const vmMap = await this.resolveVms(vmDefs);
      resolvedVmMap = vmMap;
      teardownSteps = scenarioConfig.teardown ?? [];

      // Phase 1e/follow-up C — spawn per-VM KdSession when
      // `kernel_debug.enabled: true` is set in setup.yaml. The
      // handlers (`kernel_expect_bugcheck` / `kernel_break_on`) look
      // these up via `orchestrator.getKernelDebug(vmName)`.
      await this.spawnKernelDebugSessions(vmDefs);

      // Wait for guest agents
      await this.waitForGuestAgents(vmMap, vmDefs);

      // P9.2 — apply `software:` bundles BEFORE `setup:` runs so
      // setup steps can rely on the installed packages. Each bundle
      // is applied to its declared `vm:` (or the lone scenario VM
      // when there's exactly one). Failures are surfaced as
      // setupResults entries with status="failed" so scenarios that
      // depend on the bundle are observable in the envelope.
      if (scenarioConfig.software && scenarioConfig.software.length > 0) {
        const softwareResults = await this.applyScenarioSoftware(
          scenarioConfig.software,
          vmMap,
          path.dirname(scenarioPath),
        );
        setupResults.push(...softwareResults);
        if (softwareResults.some((r) => r.status === "failed")) {
          status = "failed";
        }
      }

      // Execute setup. The scenario-level retry policy (if declared)
      // applies as a default to every step; per-step `retry:` overrides it.
      const setupSteps = scenarioConfig.setup ?? [];
      scenarioRetry = (scenarioConfig as { retry?: ValidatedRetryPolicy }).retry;
      const sResults = await this.executeSetup(
        setupSteps,
        vmMap,
        scenarioRetry,
        emit,
        trace,
      );
      setupResults.push(...sResults);

      const setupFailed = sResults.some((r) => r.status === "failed");
      if (setupFailed) {
        status = "failed";
      }

      // Execute workflow tool blocks from workflow.md
      const workflowOutputs = workflowOutputsSnapshot;
      const workflowScreenshots = new Map<string, string>();
      // `toolBlockResults` is hoisted to the runScenario scope —
      // see the declaration above the outer try.  The closures
      // below mutate it in place so the post-run JUnit synthesis
      // can read it after this try/catch returns.

      const recordToolBlockSuccess = (idx: number, tool: string, output: string) => {
        const snippet = output.length > 256 ? output.slice(0, 256) + "..." : output;
        toolBlockResults.push({
          stepIndex: idx,
          tool,
          passed: true,
          outputSnippet: snippet,
        });
      };
      const recordToolBlockFailure = (
        idx: number,
        tool: string,
        error: string,
      ) => {
        const snippet = error.length > 512 ? error.slice(0, 512) + "..." : error;
        toolBlockResults.push({
          stepIndex: idx,
          tool,
          passed: false,
          error: snippet,
        });
      };

      if (workflowMarkdown) {
        const narrative = parseNarrative(workflowMarkdown);
        let stepIndex = 0;

        if (narrative.steps.length > 0) {
          for (const step of narrative.steps) {
            for (const block of step.toolBlocks) {
              const sourceKey = `step-${stepIndex}`;
              try {
                const output = await this.executeToolBlock(
                  block.tool,
                  block.params,
                  vmMap,
                );
                workflowOutputs.set(sourceKey, output);
                recordToolBlockSuccess(stepIndex, block.tool, output);
              } catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                workflowOutputs.set(sourceKey, `ERROR: ${msg}`);
                recordToolBlockFailure(stepIndex, block.tool, msg);
                status = "failed";
              }
              stepIndex++;
            }
          }
        } else {
          // Fallback: extract tool blocks directly
          const blocks = extractToolBlocks(workflowMarkdown);
          for (let i = 0; i < blocks.length; i++) {
            const sourceKey = `step-${i}`;
            try {
              const output = await this.executeToolBlock(
                blocks[i].tool,
                blocks[i].params,
                vmMap,
              );
              workflowOutputs.set(sourceKey, output);
              recordToolBlockSuccess(i, blocks[i].tool, output);
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e);
              workflowOutputs.set(sourceKey, `ERROR: ${msg}`);
              recordToolBlockFailure(i, blocks[i].tool, msg);
              status = "failed";
            }
          }
        }
      }

      // Evaluate assertions against workflow outputs.
      //
      // The legacy evaluator only handles {command_output, screenshot_check,
      // process_state}. Scenarios using json_field, exit_code, file_exists,
      // etc. need the V2 evaluator. Route to V2 when any assertion uses a
      // modern type; otherwise stay on legacy for backwards compat.
      if (assertions.assertions.length > 0) {
        const needsV2 = assertions.assertions.some(
          (a) => !["command_output", "screenshot_check", "process_state"].includes(a.type as string),
        );

        // The V1 and V2 evaluators return different result shapes. We
        // normalize to a shared record so downstream consumers don't need
        // to care which evaluator produced the result.
        let normalized: AssertionResultEntry[];

        // V2 returns an `overallPassed` verdict that respects
        // `pass_threshold` and `critical_must_pass`. Stash it for the
        // status-flip below so a single info-severity miss inside a
        // scenario whose threshold permits it doesn't flip the whole
        // run red. Stays `undefined` for V1, which doesn't have these
        // gates and fall through to the legacy "any failure → failed"
        // behaviour.
        let v2OverallPassed: boolean | undefined;

        if (needsV2) {
          // Convert workflowOutputs (Map<string,string>) into CommandResult shape.
          const commandResults = new Map<string, CommandResult>();
          for (const [key, value] of workflowOutputs.entries()) {
            commandResults.set(key, {
              stdout: value,
              stderr: "",
              exit_code: value.startsWith("ERROR:") ? 1 : 0,
              error: "",
            } as unknown as CommandResult);
          }
          const { results: v2Results, passed: v2Passed } = await evaluateAssertionsV2(
            assertions,
            commandResults,
            workflowScreenshots,
            scenarioPath,
          );
          // V2 result: { id, description, passed, actual, error }
          normalized = v2Results.map((r, i) => ({
            id: (r as { id: string }).id,
            description: (r as { description?: string }).description ?? "",
            passed: r.passed,
            actual: typeof r.actual === "string" ? r.actual : r.actual === undefined ? undefined : JSON.stringify(r.actual),
            error: (r as { error?: string }).error,
            severity: ((assertions.assertions[i] as { severity?: string })?.severity ?? "medium") as AssertionResultEntry["severity"],
          }));
          v2OverallPassed = v2Passed;
        } else {
          const { results: v1Results } = evaluateAssertions(
            assertions, workflowOutputs, workflowScreenshots,
          );
          // V1 result: { assertion, passed, actual, error }
          normalized = v1Results.map((r) => ({
            id: r.assertion.id,
            description: r.assertion.description,
            passed: r.passed,
            actual: r.actual,
            error: r.error,
            severity: (r.assertion.severity ?? "medium") as AssertionResultEntry["severity"],
          }));
        }
        assertionResults = normalized;

        // P3.c: emit per-assertion events so agents see results as they
        // resolve, not just in the final envelope. Pass/fail is the
        // discriminator; failed events carry actual + error for the
        // consumer to render without parsing the assertion_results array.
        for (const r of assertionResults) {
          emit?.(
            r.passed
              ? { type: "assertion.passed", id: r.id }
              : {
                  type: "assertion.failed",
                  id: r.id,
                  actual: r.actual,
                  error: r.error,
                },
          );
        }

        // For V2, honour the overall verdict computed against
        // `pass_threshold` + `critical_must_pass`: a scenario with a
        // 0.9 threshold and one info-severity miss should land green.
        // For V1 keep the legacy "any failure → failed" behaviour
        // since it has no threshold to honour.
        if (v2OverallPassed !== undefined) {
          if (!v2OverallPassed) {
            status = "failed";
          }
        } else {
          const anyFailed = assertionResults.some((r) => !r.passed);
          if (anyFailed) {
            status = "failed";
          }
        }
      }

    } catch (err) {
      status = "error";
      error = err instanceof Error ? err.message : String(err);
    } finally {
      // Always run declared scenario teardown once VMs have been resolved.
      // This covers failures during guest readiness, setup, workflow, and
      // assertion evaluation; before this guard, any throw before the
      // in-try teardown block skipped scenario cleanup entirely.
      if (resolvedVmMap && teardownSteps.length > 0) {
        try {
          const tResults = await this.executeTeardown(
            teardownSteps,
            resolvedVmMap,
            scenarioRetry,
            emit,
            trace,
          );
          teardownResults.push(...tResults);
          if (status === "passed" && tResults.some((r) => r.status === "failed")) {
            status = "failed";
          }
        } catch (e) {
          status = "error";
          const teardownError = e instanceof Error ? e.message : String(e);
          error = error
            ? `${error}; teardown failed: ${teardownError}`
            : `teardown failed: ${teardownError}`;
        }
      }

      // Always tear down kd sessions — even if the scenario errored
      // mid-run, we don't want orphan kd.exe processes for subsequent
      // scenarios to inherit. Follow-up C.
      try {
        await this.teardownKernelDebugSessions();
      } catch (e) {
        // Detach failures here are benign (most mean the kd process
        // already exited); suppress rather than overwrite the outer
        // scenario error.
        if (!error && process.env.SIGNALMAN_DEBUG === "1") {
          error = `kd teardown failed: ${e instanceof Error ? e.message : String(e)}`;
        }
      }
    }

    const durationMs = Date.now() - startTime;
    const result: ScenarioResult = {
      name: scenarioName,
      status,
      duration_ms: durationMs,
      setup_results: setupResults,
      assertion_results: assertionResults,
      teardown_results: teardownResults,
      error,
    };

    // Write JUnit XML report if an output directory is configured
    if (this.outputDir) {
      const passedCount = assertionResults.filter((r) => r.passed).length;
      const total = assertionResults.length;
      const score = total > 0 ? passedCount / total : 1;
      const startedAt = new Date(startTime).toISOString();
      const finishedAt = new Date(startTime + durationMs).toISOString();

      const testResult: TestResult = {
        scenario: scenarioName,
        startedAt,
        finishedAt,
        durationMs,
        passed: status === "passed",
        score,
        assertions: assertionResults.map(
          (r): AssertionResultEntry => ({
            id: r.id,
            description: r.description,
            severity: "medium",
            passed: r.passed,
            actual: r.actual,
            error: r.error,
          }),
        ),
        // Phase-3 audit follow-up (2026-05-05): include per-tool-block
        // results so the JUnit report counts workflow.md tool blocks
        // as test cases, not just `assertions.yaml` entries.
        toolBlocks: toolBlockResults,
        screenshots: [],
        errors: error ? [error] : [],
      };

      const scenarioOutputDir = path.join(this.outputDir, scenarioName);
      writeJunitReport(testResult, scenarioOutputDir);

      // Persist workflow step outputs for post-run diagnosis. Without
      // this, silent tool-block failures produce no artifact to inspect.
      try {
        if (!fs.existsSync(scenarioOutputDir)) {
          fs.mkdirSync(scenarioOutputDir, { recursive: true });
        }
        const workflowDump: Record<string, string> = {};
        for (const [k, v] of workflowOutputsSnapshot.entries()) {
          workflowDump[k] = v;
        }
        fs.writeFileSync(
          path.join(scenarioOutputDir, "workflow-outputs.json"),
          JSON.stringify(workflowDump, null, 2),
        );
      } catch {
        // Non-fatal; JUnit report is still written above.
      }
    }

    return result;
  }

  /**
   * Execute a scenario across multiple sandbox enforcement modes.
   *
   * Reads the `sandbox_modes:` list from the scenario's `setup.yaml`. If
   * absent or empty, falls back to a single `runScenario` invocation
   * wrapped in a `MultiModeResult` (preserves backward compatibility).
   *
   * Between modes the orchestrator reverts every VM to the checkpoint
   * declared by `VmConfig.checkpoint_restore` before the next run. If a
   * VM has no checkpoint declared, revert is skipped with a warning —
   * the run will still execute but state may leak between modes.
   *
   * Each setup step parameter and tool block parameter has
   * `${SANDBOX_MODE}` substituted with the active mode name, so the
   * same scenario file can parameterize per-mode behavior (e.g.
   * `example-cli set-mode ${SANDBOX_MODE}`).
   *
   * # Sprint Reference
   * Sprint 60, Phase 5, Story 5.2.
   */
  async runScenarioMultiMode(scenarioPath: string): Promise<MultiModeResult> {
    const startTime = Date.now();

    let declaredModes: SandboxMode[] | undefined;
    let scenarioName = "unknown";
    try {
      const loaded = loadScenario(scenarioPath);
      declaredModes = loaded.config.sandbox_modes;
      scenarioName = loaded.config.name;
    } catch {
      // If scenario fails to load we still want runScenario's error handling
      // to produce the failure record, so fall through to a single run.
    }

    const modes: SandboxMode[] =
      declaredModes && declaredModes.length > 0 ? declaredModes : (["none"] as SandboxMode[]);

    const runs: Array<{ mode: SandboxMode; result: ScenarioResult }> = [];
    for (let i = 0; i < modes.length; i++) {
      const mode = modes[i];
      if (i > 0) {
        // Between modes: revert every VM to its declared checkpoint so
        // the next run starts from the same state as the first.
        await this.revertVmsToCheckpoints(scenarioPath);
      }

      // Set the mode context so that setup/workflow steps can substitute
      // `${SANDBOX_MODE}` before execution.
      this.currentSandboxMode = mode;
      try {
        const result = await this.runScenario(scenarioPath);
        result.sandbox_mode = mode;
        runs.push({ mode, result });
      } finally {
        this.currentSandboxMode = undefined;
      }
    }

    return {
      scenario: scenarioName,
      runs,
      total_duration_ms: Date.now() - startTime,
    };
  }

  /**
   * The mode currently being executed by `runScenarioMultiMode`, if any.
   * Read by `substituteSandboxMode` at step-dispatch time.
   */
  private currentSandboxMode: SandboxMode | undefined;

  /**
   * Recursively substitute `${SANDBOX_MODE}` in all string values of a
   * setup step or tool block parameter map. Returns a new object; the
   * input is not mutated.
   */
  protected substituteSandboxMode<T>(value: T): T {
    const mode = this.currentSandboxMode;
    if (mode === undefined) return value;
    return substituteVarsDeep(value, { SANDBOX_MODE: mode }) as T;
  }

  /**
   * Revert every VM declared by the scenario to its `checkpoint_restore`
   * label. Used between sandbox-mode runs.
   */
  private async revertVmsToCheckpoints(scenarioPath: string): Promise<void> {
    const { config } = loadScenario(scenarioPath);
    for (const vm of config.vms) {
      if (!vm.checkpoint_restore) {
        console.warn(
          `[orchestrator] VM '${vm.name}' has no checkpoint_restore declared — ` +
            `state may leak between sandbox modes`,
        );
        continue;
      }
      const handle = await this.backend
        .listVMs()
        .then((vms) => vms.find((v) => v.name === vm.template));
      if (!handle) {
        console.warn(
          `[orchestrator] could not resolve VM '${vm.template}' for revert; skipping`,
        );
        continue;
      }
      await this.backend.restoreCheckpoint({
        id: "",
        vmHandle: handle,
        label: vm.checkpoint_restore,
      });
    }
  }

  /**
   * P9.2 — Read + parse a bundle.yaml from disk and apply it to a VM.
   *
   * Used by both the `install_bundle` setup-action and the top-level
   * `software:` key. The path is resolved relative to the caller's
   * `cwd` if not absolute (CLI path) and relative to the scenario
   * directory by `applyScenarioSoftware`.
   */
  private async applyBundleByPath(
    client: GuestAgentClient,
    vmName: string,
    bundlePath: string,
  ): Promise<import("../provisioning/install-bundle.js").InstallBundleResult> {
    const fs = await import("node:fs");
    const yamlMod = await import("yaml");
    const { parseBundle } = await import("../provisioning/bundle-types.js");
    const { installBundle } = await import(
      "../provisioning/install-bundle.js"
    );
    if (!fs.existsSync(bundlePath)) {
      throw new Error(`bundle file not found: ${bundlePath}`);
    }
    const text = fs.readFileSync(bundlePath, "utf-8");
    const bundle = parseBundle(yamlMod.parse(text));
    return installBundle(this.backend, client, vmName, bundle);
  }

  /**
   * P9.2 — Apply every entry in a scenario's `software:` list. Returns
   * a `StepResult[]` shaped like a setup pass so the caller can fold
   * the entries into `setupResults` directly. Each entry produces ONE
   * step result whose action is "install_bundle" — the per-package
   * detail lives in the orchestrator's structured logs (the bundle
   * machinery returns a richer `InstallBundleResult` but the scenario-
   * level surface is binary success/fail).
   */
  private async applyScenarioSoftware(
    refs: import("./runner.js").BundleRef[],
    vmMap: Map<string, VMHandle>,
    scenarioDir: string,
  ): Promise<StepResult[]> {
    const results: StepResult[] = [];
    for (const refRaw of refs) {
      const ref =
        typeof refRaw === "string" ? { path: refRaw } : refRaw;
      const startedAt = Date.now();

      // Resolve target VM. With one scenario VM the `vm:` field is
      // optional; with multiple, omitting it is an error.
      let vmName = ref.vm ?? "";
      if (!vmName) {
        if (vmMap.size === 1) {
          vmName = vmMap.keys().next().value as string;
        } else {
          results.push({
            action: "install_bundle",
            vm: "",
            status: "failed",
            duration_ms: Date.now() - startedAt,
            error: `software entry '${ref.path}' must specify 'vm:' when scenario has multiple VMs`,
          });
          continue;
        }
      }
      const handle = vmMap.get(vmName);
      if (!handle) {
        results.push({
          action: "install_bundle",
          vm: vmName,
          status: "failed",
          duration_ms: Date.now() - startedAt,
          error: `VM '${vmName}' not found in resolved VMs`,
        });
        continue;
      }
      const client = this.guestClients.get(vmName);
      if (!client) {
        results.push({
          action: "install_bundle",
          vm: vmName,
          status: "failed",
          duration_ms: Date.now() - startedAt,
          error: `No guest client for VM '${vmName}'`,
        });
        continue;
      }

      // Resolve bundle path relative to the scenario dir if relative.
      const resolvedPath = path.isAbsolute(ref.path)
        ? ref.path
        : path.join(scenarioDir, ref.path);

      try {
        const bundleResult = await this.applyBundleByPath(
          client,
          vmName,
          resolvedPath,
        );
        const failed = bundleResult.failed;
        results.push({
          action: "install_bundle",
          vm: vmName,
          status: failed > 0 ? "failed" : "success",
          duration_ms: Date.now() - startedAt,
          ...(failed > 0
            ? {
                error: `${failed}/${bundleResult.totalPackages} packages failed`,
              }
            : {}),
        });
      } catch (err) {
        results.push({
          action: "install_bundle",
          vm: vmName,
          status: "failed",
          duration_ms: Date.now() - startedAt,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return results;
  }

  /**
   * Execute setup steps sequentially.
   *
   * Supported actions:
   * - vm_install: Install software via guest agent
   * - install_bundle: Apply a software bundle (P9.2)
   * - vm_copy_file: Copy a file host->guest or guest->host
   * - vm_run_command: Run a command inside the VM
   * - vm_restore: Restore a VM checkpoint
   * - vm_checkpoint: Create a VM checkpoint
   * - wait: Sleep for a duration
   * - docker_compose_up: Start a Docker Compose stack (requires DockerClient)
   * - docker_compose_down: Stop a Docker Compose stack (requires DockerClient)
   */
  async executeSetup(
    steps: SetupStep[],
    vmMap: Map<string, VMHandle>,
    scenarioRetry?: ValidatedRetryPolicy,
    emit?: EnvelopeEventEmitter,
    /**
     * P3.d: run-level trace context. The per-step trace context is
     * built here by composing { traceId, runId } with `vmName`
     * derived from the step's vm field.
     */
    trace?: { traceId: string; runId: string },
  ): Promise<StepResult[]> {
    const results: StepResult[] = [];

    for (let stepIndex = 0; stepIndex < steps.length; stepIndex++) {
      const rawStep = steps[stepIndex];
      // Story 5.2: substitute ${SANDBOX_MODE} etc. before dispatch so the
      // existing per-action handlers see the resolved values.
      const step = this.substituteSandboxMode(rawStep) as SetupStep;
      const vmName = (step.vm as string) ?? "";
      const startTime = Date.now();

      // P3.c: emit step.started before any work begins. Live events
      // replace the post-hoc replay in default-executor.ts; agents
      // subscribed to signalman.status see this immediately.
      emit?.({
        type: "step.started",
        step_index: stepIndex,
        kind: step.action,
        vm: vmName,
      });

      // P3.b: resolve effective retry policy: per-step beats scenario-
      // level beats none. `count: 0` is explicit no-retry; absent
      // policy is also no-retry.
      const retryPolicy = resolveStepRetry(step, scenarioRetry);
      const maxAttempts = (retryPolicy?.count ?? 0) + 1;
      const attemptFailures: string[] = [];
      let succeeded = false;
      let outcome: { status: "success" | "skipped"; error?: string } | null = null;
      let lastError: unknown = null;

      // P3.d: per-step trace context. vmName is filled in here so log
      // demuxing works at fleet scale (many VMs, many concurrent runs).
      // runWithTrace is a no-op when `trace` is undefined, so the
      // un-traced path is identical to pre-P3.d behaviour.
      const stepTrace: TraceContext | undefined = trace
        ? { traceId: trace.traceId, runId: trace.runId, vmName }
        : undefined;

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          outcome = await runWithTrace(stepTrace, () =>
            this.executeStepBody(step, vmName, vmMap),
          );
          succeeded = true;
          break;
        } catch (err) {
          lastError = err;
          const msg = err instanceof Error ? err.message : String(err);
          if (attempt < maxAttempts) {
            attemptFailures.push(msg);
            const delay = computeBackoff(retryPolicy!, attempt);
            // P3.c: surface retries as their own event so consumers can
            // see flaky-but-recovered runs without parsing attempt_failures.
            emit?.({
              type: "step.retry_started",
              step_index: stepIndex,
              kind: step.action,
              vm: vmName,
              attempt: attempt + 1,
              of: maxAttempts,
              previous_error: msg,
              backoff_ms: delay,
            });
            if (delay > 0) {
              await new Promise((resolve) => setTimeout(resolve, delay));
            }
          }
        }
      }

      const duration_ms = Date.now() - startTime;
      const totalAttempts = succeeded ? attemptFailures.length + 1 : maxAttempts;
      const recordAttempts = totalAttempts > 1; // only emit on retry-active runs

      if (succeeded && outcome) {
        results.push({
          action: step.action,
          vm: vmName,
          status: outcome.status,
          duration_ms,
          ...(outcome.error !== undefined ? { error: outcome.error } : {}),
          ...(recordAttempts ? { attempts: totalAttempts } : {}),
          ...(attemptFailures.length > 0
            ? { attempt_failures: attemptFailures }
            : {}),
        });
        // P3.c: terminal event — completed for actual work, skipped
        // for unknown actions. Consumers can branch on type without
        // reading the StepResult.
        if (outcome.status === "skipped") {
          emit?.({
            type: "step.skipped",
            step_index: stepIndex,
            kind: step.action,
            vm: vmName,
            reason: outcome.error,
          });
        } else {
          emit?.({
            type: "step.completed",
            step_index: stepIndex,
            kind: step.action,
            vm: vmName,
            duration_ms,
            ...(recordAttempts ? { attempts: totalAttempts } : {}),
          });
        }
      } else {
        const errMsg = lastError instanceof Error ? lastError.message : String(lastError);
        results.push({
          action: step.action,
          vm: vmName,
          status: "failed",
          duration_ms,
          error: errMsg,
          ...(recordAttempts ? { attempts: totalAttempts } : {}),
          // attempt_failures excludes the final attempt's error since
          // it already appears in `error`; only intermediate failures
          // surface here.
          ...(attemptFailures.length > 0
            ? { attempt_failures: attemptFailures }
            : {}),
        });
        // P3.c: failed terminal event with the final error and retry
        // bookkeeping for consumers that don't ingest the full envelope.
        emit?.({
          type: "step.failed",
          step_index: stepIndex,
          kind: step.action,
          vm: vmName,
          duration_ms,
          error: errMsg,
          ...(recordAttempts ? { attempts: totalAttempts } : {}),
        });
      }
    }

    return results;
  }

  /**
   * Execute a single setup/teardown step body. Returns
   * `{ status: "success" }` on completion, `{ status: "skipped", error }`
   * for unknown actions, and **throws** on any handler failure so the
   * caller's retry loop can catch and re-attempt. P3.b refactor.
   */
  private async executeStepBody(
    step: SetupStep,
    vmName: string,
    vmMap: Map<string, VMHandle>,
  ): Promise<{ status: "success" | "skipped"; error?: string }> {
    switch (step.action) {
          case "vm_install": {
            const handle = vmMap.get(vmName);
            if (!handle) throw new Error(`VM '${vmName}' not found in resolved VMs`);
            const client = this.guestClients.get(vmName);
            if (!client) throw new Error(`No guest client for VM '${vmName}'`);
            await client.installSoftware(
              step.package_id as string,
              (step.source as string) ?? "winget",
              step.version as string | undefined,
              step.timeout_ms as number | undefined,
            );
            break;
          }

          // P9.2 — `install_bundle` action. Lets a scenario's `setup:`
          // pull in a software bundle in one declarative step. The
          // top-level `software:` key (applied before `setup:` runs)
          // and this action dispatch share the same `applyBundleByPath`
          // helper so the semantics match.
          case "install_bundle": {
            const handle = vmMap.get(vmName);
            if (!handle) throw new Error(`VM '${vmName}' not found in resolved VMs`);
            const client = this.guestClients.get(vmName);
            if (!client) throw new Error(`No guest client for VM '${vmName}'`);
            const bundlePath = step.bundle as string;
            if (!bundlePath) {
              throw new Error(`install_bundle missing 'bundle' path`);
            }
            const result = await this.applyBundleByPath(
              client,
              vmName,
              bundlePath,
            );
            if (result.failed > 0) {
              const firstFail = result.perPackageResults.find(
                (r) => r.status === "failed",
              );
              throw new Error(
                `install_bundle: ${result.failed}/${result.totalPackages} packages failed` +
                  (firstFail ? ` — first: ${firstFail.package}: ${firstFail.error}` : ""),
              );
            }
            break;
          }

          case "vm_copy_file": {
            const handle = vmMap.get(vmName);
            if (!handle) throw new Error(`VM '${vmName}' not found in resolved VMs`);
            const direction = (step.direction as string) ?? "host_to_guest";
            if (direction === "host_to_guest") {
              await this.copyFileToGuest(
                vmName,
                handle,
                step.host_path as string,
                step.guest_path as string,
              );
            } else {
              await this.copyFileFromGuest(
                vmName,
                handle,
                step.guest_path as string,
                step.host_path as string,
              );
            }
            break;
          }

          case "vm_run_command": {
            const handle = vmMap.get(vmName);
            if (!handle) throw new Error(`VM '${vmName}' not found in resolved VMs`);
            const client = this.guestClients.get(vmName);
            const timeoutMs = (step.timeout_ms as number) ?? 60_000;
            const cmdArgs = (step.args as string[]) ?? [];
            const runAs = (step.run_as as string) ?? undefined;

            // Phase 3 §C1 follow-up (2026-05-06): retry once on
            // DEADLINE_EXCEEDED for guest-agent cold-start. Both the
            // guest-client and backend.executeCommand paths get the
            // same retry treatment so scenarios that pin the very
            // first command after a `vm_restore` don't flake.
            const runOnce = async () => {
              if (client) {
                await client.runCommand(
                  step.command as string,
                  cmdArgs,
                  { timeoutMs, runAs },
                );
              } else {
                const result = await this.backend.executeCommand(
                  handle,
                  step.command as string,
                  cmdArgs,
                  timeoutMs,
                );
                if (result.exitCode !== 0) {
                  throw new Error(
                    `vm_run_command exited ${result.exitCode}: ${result.stderr || result.stdout}`,
                  );
                }
              }
            };
            try {
              await runOnce();
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e);
              const isDeadline = /DEADLINE_EXCEEDED|CANCELLED.*Timeout/i.test(msg);
              if (!isDeadline) throw e;
              await runOnce();
            }
            break;
          }

          case "vm_restore": {
            const handle = vmMap.get(vmName);
            if (!handle) throw new Error(`VM '${vmName}' not found in resolved VMs`);
            const label = step.checkpoint as string;
            await this.backend.restoreCheckpoint({
              id: "",
              vmHandle: handle,
              label,
            });
            break;
          }

          case "vm_checkpoint": {
            const handle = vmMap.get(vmName);
            if (!handle) throw new Error(`VM '${vmName}' not found in resolved VMs`);
            const label = step.label as string;
            await this.backend.createCheckpoint(handle, label);
            break;
          }

          case "wait": {
            const durationMs = (step.duration_ms as number) ?? 1_000;
            await new Promise((resolve) => setTimeout(resolve, durationMs));
            break;
          }

          case "docker_compose_up": {
            const docker = this.requireDocker();
            const composeConfig: ComposeConfig = {
              projectName: step.project_name as string,
              composeFile: step.compose_file as string,
              env: step.env as Record<string, string> | undefined,
            };
            await docker.composeUp(composeConfig, step.services as string[] | undefined);

            // Optionally wait for all services to become healthy
            if (step.wait_healthy) {
              const timeoutMs = (step.timeout_ms as number) ?? 60_000;
              const containers = await docker.composePs(composeConfig);
              for (const container of containers) {
                if (container.state === "running") {
                  const healthy = await docker.waitForHealthy(container.name, timeoutMs);
                  if (!healthy) {
                    throw new Error(
                      `Container '${container.name}' did not become healthy within ${timeoutMs}ms`,
                    );
                  }
                }
              }
            }

            break;
          }

          case "docker_compose_down": {
            const docker = this.requireDocker();
            const composeConfig: ComposeConfig = {
              projectName: step.project_name as string,
              composeFile: (step.compose_file as string) ?? "",
              env: step.env as Record<string, string> | undefined,
            };
            await docker.composeDown(composeConfig, step.remove_volumes as boolean | undefined);
            break;
          }

      default: {
        return {
          status: "skipped",
          error: `Unknown action: ${step.action}`,
        };
      }
    }

    // Successful (non-default) case fell through via `break`. The
    // method throws on any handler failure (errors propagate naturally
    // since there's no try/catch wrapping the switch); the caller's
    // retry loop in executeSetup handles the catch.
    return { status: "success" };
  }

  /**
   * Execute teardown steps. Errors are captured but do not throw.
   */
  async executeTeardown(
    steps: SetupStep[],
    vmMap: Map<string, VMHandle>,
    scenarioRetry?: ValidatedRetryPolicy,
    emit?: EnvelopeEventEmitter,
    trace?: { traceId: string; runId: string },
  ): Promise<StepResult[]> {
    // Teardown uses the same logic as setup but swallows errors. P3.b:
    // retry policy threads through identically — flaky teardowns can
    // also benefit from retry. P3.c: live events emit identically too.
    // P3.d: trace context threads through too so teardown gRPC calls
    // are correlated with their run.
    return this.executeSetup(steps, vmMap, scenarioRetry, emit, trace);
  }

  /**
   * Execute a single tool block from a workflow.md narrative.
   *
   * Routes tool calls to the appropriate guest client or orchestrator
   * action and returns the captured stdout/output.
   */
  async executeToolBlock(
    tool: string,
    rawParams: Record<string, unknown>,
    vmMap: Map<string, VMHandle>,
  ): Promise<string> {
    // Story 5.2: substitute ${SANDBOX_MODE} across tool block parameters
    // before any handler reads them.
    const params = this.substituteSandboxMode(rawParams) as Record<string, unknown>;
    const vmName = (params.vm as string) ?? vmMap.keys().next().value;

    switch (tool) {
      case "vm_run_command": {
        const handle = vmMap.get(vmName);
        const client = this.guestClients.get(vmName);
        const command = params.command as string;
        const args = (params.args as string[]) ?? [];
        const timeoutMs = (params.timeout_ms as number) ?? 60_000;
        const runAs = (params.run_as as string) ?? undefined;
        // Cherry-pick reconciliation (2026-05-06): main's
        // `vm_run_command` supports both the guest-client and the
        // backend.executeCommand paths; the original commit only
        // handled guest-client. Merged shape: keep main's bifurcated
        // dispatch, plus retry once on DEADLINE_EXCEEDED to absorb
        // guest-agent cold-start jitter.
        //
        // After `vm_restore` the agent's TCP socket comes up before
        // its runCommand-handler thread pool warms — `isConnected`
        // (health RPC) returns true but the first real command can
        // still hit a 10-15s queue delay. A single retry with the
        // scenario's own timeout handles the cold path without
        // changing per-scenario `timeout_ms` budgets.
        //
        // The retry is gated on the gRPC error being specifically a
        // DEADLINE / CANCELLED — other errors (UNAVAILABLE, etc.)
        // surface immediately so genuine failures aren't masked.
        const dispatch = async () => {
          if (client) {
            return await client.runCommand(command, args, { timeoutMs, runAs });
          }
          if (handle) {
            return await this.backend.executeCommand(handle, command, args, timeoutMs);
          }
          return undefined;
        };
        let result;
        try {
          result = await dispatch();
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          const isDeadline = /DEADLINE_EXCEEDED|CANCELLED.*Timeout/i.test(msg);
          if (!isDeadline) throw e;
          result = await dispatch();
        }
        if (!result) throw new Error(`VM '${vmName}' not found`);
        const stdout = result.stdout ?? "";

        // Phase-3 audit (2026-05-05): enforce workflow.md `expect_*`
        // parameters here so a `vm_run_command` block that fails its
        // expectations throws — the orchestrator then marks the
        // step's `workflowOutputs` entry with the `ERROR:` prefix
        // AND records the per-tool-block failure for JUnit synthesis.
        // When `expect_exit_code` is unset, default to expecting 0
        // (preserves main's "fail-on-nonzero" semantics).
        const failures: string[] = [];
        const expectedExit = params.expect_exit_code !== undefined
          ? (params.expect_exit_code as number)
          : 0;
        if (result.exitCode !== expectedExit) {
          failures.push(
            `expect_exit_code: expected ${expectedExit}, got ${result.exitCode}: ${result.stderr || result.stdout}`,
          );
        }
        if (params.expect_stdout !== undefined) {
          const expected = params.expect_stdout as string;
          if (!stdout.includes(expected)) {
            failures.push(
              `expect_stdout: expected substring ${JSON.stringify(expected)} not found in stdout`,
            );
          }
        }
        if (params.expect_stdout_regex !== undefined) {
          const pattern = params.expect_stdout_regex as string;
          let re: RegExp;
          try {
            // Multiline mode by default — existing scenarios assume
            // `^` / `$` match line boundaries within multi-line
            // command output (e.g., `^example\s+\d+\s+370000` against
            // a `fltmc filters` table). Without `m`, `^` only matches
            // start-of-string and silently fails for any line past
            // the first.
            re = new RegExp(pattern, "m");
          } catch (e) {
            failures.push(
              `expect_stdout_regex: invalid regex ${JSON.stringify(pattern)}: ${e instanceof Error ? e.message : String(e)}`,
            );
            re = /(?:)/;
          }
          if (!re.test(stdout)) {
            failures.push(
              `expect_stdout_regex: pattern ${JSON.stringify(pattern)} did not match stdout`,
            );
          }
        }
        if (params.expect_stdout_not_regex !== undefined) {
          const pattern = params.expect_stdout_not_regex as string;
          let re: RegExp;
          try {
            // Multiline mode by default — existing scenarios assume
            // `^` / `$` match line boundaries within multi-line
            // command output (e.g., `^example\s+\d+\s+370000` against
            // a `fltmc filters` table). Without `m`, `^` only matches
            // start-of-string and silently fails for any line past
            // the first.
            re = new RegExp(pattern, "m");
          } catch (e) {
            failures.push(
              `expect_stdout_not_regex: invalid regex ${JSON.stringify(pattern)}: ${e instanceof Error ? e.message : String(e)}`,
            );
            re = /^$/;
          }
          if (re.test(stdout)) {
            failures.push(
              `expect_stdout_not_regex: pattern ${JSON.stringify(pattern)} unexpectedly matched stdout`,
            );
          }
        }
        if (failures.length > 0) {
          // Include a stdout snippet for diagnosis (capped to keep
          // the orchestrator's `ERROR:` line compact).
          const snippet = stdout.length > 256
            ? stdout.slice(0, 256) + "..."
            : stdout;
          throw new Error(
            `vm_run_command expectations failed: ${failures.join("; ")} | stdout snippet: ${JSON.stringify(snippet)}`,
          );
        }

        return stdout;
      }

      case "vm_copy_file": {
        const handle = vmMap.get(vmName);
        if (!handle) throw new Error(`VM '${vmName}' not found`);
        const direction = (params.direction as string) ?? "host_to_guest";
        if (direction === "host_to_guest") {
          await this.copyFileToGuest(
            vmName,
            handle,
            params.host_path as string,
            params.guest_path as string,
          );
        } else {
          await this.copyFileFromGuest(
            vmName,
            handle,
            params.guest_path as string,
            params.host_path as string,
          );
        }
        return "ok";
      }

      case "vm_install": {
        const client = this.guestClients.get(vmName);
        if (!client) throw new Error(`No guest client for VM '${vmName}'`);
        await client.installSoftware(
          params.package_id as string,
          (params.source as string) ?? "winget",
          params.version as string | undefined,
          params.timeout_ms as number | undefined,
        );
        return "installed";
      }

      case "wait": {
        const durationMs = (params.duration_ms as number) ?? 1_000;
        await new Promise((resolve) => setTimeout(resolve, durationMs));
        return "waited";
      }

      case "docker_compose_up": {
        const docker = this.requireDocker();
        const composeConfig: ComposeConfig = {
          projectName: params.project_name as string,
          composeFile: params.compose_file as string,
          env: params.env as Record<string, string> | undefined,
        };
        await docker.composeUp(composeConfig, params.services as string[] | undefined);

        if (params.wait_healthy) {
          const timeoutMs = (params.timeout_ms as number) ?? 60_000;
          const containers = await docker.composePs(composeConfig);
          for (const container of containers) {
            if (container.state === "running") {
              const healthy = await docker.waitForHealthy(container.name, timeoutMs);
              if (!healthy) {
                throw new Error(
                  `Container '${container.name}' did not become healthy within ${timeoutMs}ms`,
                );
              }
            }
          }
        }

        return "compose stack started";
      }

      case "docker_compose_down": {
        const docker = this.requireDocker();
        const composeConfig: ComposeConfig = {
          projectName: params.project_name as string,
          composeFile: (params.compose_file as string) ?? "",
          env: params.env as Record<string, string> | undefined,
        };
        await docker.composeDown(composeConfig, params.remove_volumes as boolean | undefined);
        return "compose stack stopped";
      }

      // ── UI automation (Sprint 60 Phase 5, Story 5.5 prep) ────────
      // Each case returns a JSON-stringified result so spec authors can
      // pipe it into the standard `json_field` / `stdout_contains`
      // assertions.

      case "ui_ensure_sidecar": {
        const client = this.guestClients.get(vmName);
        if (!client) throw new Error(`No guest client for VM '${vmName}'`);
        const username = params.username as string;
        if (!username) throw new Error(`ui_ensure_sidecar missing 'username'`);
        const result = await ensureUiSidecar(client, {
          username,
          bind: params.bind as string | undefined,
          engine: params.engine as string | undefined,
          runNow: params.run_now as boolean | undefined,
          waitReadyMs: params.wait_ready_ms as number | undefined,
          timeoutMs: params.timeout_ms as number | undefined,
        });
        return JSON.stringify({
          task_name: result.taskName,
          username: result.username,
          bind: result.bind,
          engine: result.engine,
          created: result.created,
          run_now: result.runNow,
          state: result.state,
          ready: result.ready,
          wait_ready_ms: result.waitReadyMs,
        });
      }

      case "ui_click": {
        const client = this.guestClients.get(vmName);
        if (!client) throw new Error(`No guest client for VM '${vmName}'`);
        const selector = params.selector as string;
        if (!selector) throw new Error(`ui_click missing 'selector'`);
        const result = await withUiSidecarRecovery(client, uiRecoveryOptions(params), () =>
          client.uiClick(selector, {
            windowTitle: params.window_title as string | undefined,
            clickType: params.click_type as "left" | "right" | "double" | undefined,
            timeoutMs: params.timeout_ms as number | undefined,
          }),
        );
        return JSON.stringify(uiActionWorkflowResult(result));
      }

      case "ui_key": {
        const client = this.guestClients.get(vmName);
        if (!client) throw new Error(`No guest client for VM '${vmName}'`);
        const keys = params.keys as string;
        if (!keys) throw new Error(`ui_key missing 'keys'`);
        const result = await withUiSidecarRecovery(client, uiRecoveryOptions(params), () =>
          client.uiKey(keys, {
            selector: params.selector as string | undefined,
            windowTitle: params.window_title as string | undefined,
            repeat: params.repeat as number | undefined,
            timeoutMs: params.timeout_ms as number | undefined,
          }),
        );
        return JSON.stringify(uiActionWorkflowResult(result));
      }

      case "ui_type": {
        const client = this.guestClients.get(vmName);
        if (!client) throw new Error(`No guest client for VM '${vmName}'`);
        const text = params.text as string;
        if (text === undefined || text === null) {
          throw new Error(`ui_type missing 'text'`);
        }
        const result = await withUiSidecarRecovery(client, uiRecoveryOptions(params), () =>
          client.uiType(text, {
            selector: params.selector as string | undefined,
            windowTitle: params.window_title as string | undefined,
            clearFirst: params.clear_first as boolean | undefined,
            timeoutMs: params.timeout_ms as number | undefined,
          }),
        );
        return JSON.stringify(uiActionWorkflowResult(result));
      }

      case "ui_find": {
        const client = this.guestClients.get(vmName);
        if (!client) throw new Error(`No guest client for VM '${vmName}'`);
        const selector = params.selector as string;
        if (!selector) throw new Error(`ui_find missing 'selector'`);
        const find = await withUiSidecarRecovery(client, uiRecoveryOptions(params), () =>
          client.uiFindDetailed(selector, {
            windowTitle: params.window_title as string | undefined,
            findTimeoutMs: params.find_timeout_ms as number | undefined,
            timeoutMs: params.timeout_ms as number | undefined,
          }),
        );
        const elements = find.elements;
        const descriptors = describeUiElements(elements);
        const actionTargets = describeUiActionTargets(descriptors, 50);
        // Return a structured result so `json_field` assertions can
        // query e.g. `count` or `elements[0].is_enabled`.
        return JSON.stringify({
          count: elements.length,
          duration_ms: find.durationMs,
          elements: descriptors,
          action_target_count: actionTargets.length,
          action_targets: actionTargets,
        });
      }

      case "ui_wait_for": {
        const client = this.guestClients.get(vmName);
        if (!client) throw new Error(`No guest client for VM '${vmName}'`);
        const selector = params.selector as string;
        if (!selector) throw new Error(`ui_wait_for missing 'selector'`);
        const find = await withUiSidecarRecovery(client, uiRecoveryOptions(params), () =>
          client.uiFindDetailed(selector, {
            windowTitle: params.window_title as string | undefined,
            findTimeoutMs: params.find_timeout_ms as number | undefined,
            timeoutMs: params.timeout_ms as number | undefined,
          }),
        );
        const elements = find.elements;
        const descriptors = describeUiElements(elements);
        const actionTargets = describeUiActionTargets(descriptors, 50);
        const found = elements.length > 0;
        if (!found) {
          throw new Error(`UI element not found: ${selector}`);
        }
        return JSON.stringify({
          found,
          count: elements.length,
          duration_ms: find.durationMs,
          elements: descriptors,
          action_target_count: actionTargets.length,
          action_targets: actionTargets,
        });
      }

      case "ui_screenshot": {
        const client = this.guestClients.get(vmName);
        if (!client) throw new Error(`No guest client for VM '${vmName}'`);
        const format = (params.format as string) ?? "png";
        const screenshot = await withUiSidecarRecovery(client, uiRecoveryOptions(params), () =>
          client.uiScreenshot({
            windowTitle: params.window_title as string | undefined,
            format,
            timeoutMs: params.timeout_ms as number | undefined,
          }),
        );
        // Optional persistence to disk for visual debugging — when
        // `output` is set, write the bytes there. Either way return
        // size metadata so assertions can sanity-check the capture.
        let savedPath: string | undefined;
        if (typeof params.output === "string" && params.output.length > 0) {
          const fs = await import("node:fs");
          savedPath = resolveWorkflowScreenshotPath(params.output, this.config);
          fs.mkdirSync(path.dirname(savedPath), { recursive: true });
          fs.writeFileSync(savedPath, screenshot.imageData);
        }
        return JSON.stringify({
          format: screenshot.format,
          bytes: screenshot.imageData.length,
          duration_ms: screenshot.durationMs,
          saved_path: savedPath ?? null,
        });
      }

      case "ui_health": {
        const client = this.guestClients.get(vmName);
        if (!client) throw new Error(`No guest client for VM '${vmName}'`);
        const result = await client.uiHealth(params.timeout_ms as number | undefined);
        return JSON.stringify({
          sidecar_reachable: result.sidecarReachable,
          engine: result.engine,
          pid: result.pid,
          uptime_ms: result.uptimeMs,
          error: result.error,
          duration_ms: result.durationMs,
        });
      }

      case "ui_snapshot": {
        const client = this.guestClients.get(vmName);
        if (!client) throw new Error(`No guest client for VM '${vmName}'`);
        const format = (params.format as string) ?? "png";
        const timeoutMs = params.timeout_ms as number | undefined;
        const maxElements = Math.max(
          1,
          Math.min(Math.floor((params.max_elements as number | undefined) ?? 50), 200),
        );
        const [screenshot, find] = await withUiSidecarRecovery(
          client,
          uiRecoveryOptions(params),
          () =>
            Promise.all([
              client.uiScreenshot({
                windowTitle: params.window_title as string | undefined,
                format,
                timeoutMs,
              }),
              client.uiFindDetailed("", {
                windowTitle: params.window_title as string | undefined,
                findTimeoutMs: params.find_timeout_ms as number | undefined,
                timeoutMs,
              }),
            ]),
        );
        const elements = find.elements;
        const descriptors = describeUiElements(elements);
        const actionTargets = describeUiActionTargets(descriptors, maxElements);
        const actionTargetCount = descriptors.filter(
          (element) => element.actions.length > 0 && element.selector,
        ).length;
        let savedPath: string | undefined;
        if (typeof params.output === "string" && params.output.length > 0) {
          const fs = await import("node:fs");
          savedPath = resolveWorkflowScreenshotPath(params.output, this.config);
          fs.mkdirSync(path.dirname(savedPath), { recursive: true });
          fs.writeFileSync(savedPath, screenshot.imageData);
        }
        return JSON.stringify({
          format: screenshot.format,
          width: screenshot.width,
          height: screenshot.height,
          bytes: screenshot.imageData.length,
          screenshot_duration_ms: screenshot.durationMs,
          find_duration_ms: find.durationMs,
          element_count: elements.length,
          elements: descriptors.slice(0, maxElements),
          truncated: elements.length > maxElements,
          action_target_count: actionTargetCount,
          action_targets: actionTargets,
          action_targets_truncated: actionTargetCount > actionTargets.length,
          saved_path: savedPath ?? null,
        });
      }

      default:
        // Pluggable tool registry (Sprint 60.7.5 follow-up B). Tools
        // registered via `this.tools.register(...)` — currently the
        // kernel-debug set — are resolved here. Unknown tools fall
        // through to the error below.
        if (this.toolRegistry.has(tool)) {
          return this.toolRegistry.execute(
            tool,
            { vmName, vmMap, orchestrator: this },
            params,
          );
        }
        throw new Error(`Unknown workflow tool: ${tool}`);
    }
  }

  /**
   * Resolve VM definitions to VMHandle objects.
   *
   * For each VM definition, attempts to find an existing VM by name.
   * If the VM has a checkpoint_restore, restores it and starts the VM.
   */
  async resolveVms(
    vmDefs: VmDefinition[],
  ): Promise<Map<string, VMHandle>> {
    const vmMap = new Map<string, VMHandle>();

    // Sprint 60.12 Phase B — unprivileged host-CLI fast path. When
    // every VM in the scenario is `pre_started: true`, skip the
    // hypervisor `listVMs` call entirely; it requires elevation on
    // Hyper-V (Get-VM enumerates the management OS) and would hang
    // the scenario behind a UAC prompt under unattended runs.
    const allPreStarted = vmDefs.length > 0 && vmDefs.every((d) => d.pre_started);
    const allVms = allPreStarted ? [] : await this.backend.listVMs();

    for (const def of vmDefs) {
      // Pre-started fast path — no listVMs lookup, no checkpoint
      // restore, no startVM. Construct a synthetic VMHandle whose `id`
      // is the sentinel string `"pre-started"` so downstream code
      // (`copyFileToGuest`, scenario hooks) can detect the shape and
      // route around hypervisor-level operations.
      if (def.pre_started) {
        const physicalName = this.config.vmAliases?.[def.name] ?? def.name;
        vmMap.set(def.name, {
          id: "pre-started",
          name: physicalName,
          backend: this.backend.name,
        });
        continue;
      }

      // Resolve alias: check config.vmAliases first, then use the logical name
      const physicalName = this.config.vmAliases?.[def.name] ?? def.name;
      let existing = allVms.find(
        (vm) => vm.name.toLowerCase() === physicalName.toLowerCase(),
      );
      // P9.4 v0.1.1 — `provision_if_missing: true` triggers a one-shot
      // `signalman vm provision` before the rest of the scenario
      // touches the VM. Idempotent: if the VM already exists with the
      // matching template + checkpoint, provisionVM returns
      // `alreadyProvisioned: true` in <100ms.
      //
      // Why we ALWAYS gate on provision_if_missing being explicitly
      // true: silently bootstrapping VMs is exactly the kind of
      // "magic" that makes scenarios non-portable across hosts.
      // Operators opt in per-VM in scenario YAML; the default is the
      // existing v0.1.0 "VM not found" hard fail.
      if (!existing && def.provision_if_missing) {
        // Lazy-import provisionVM to avoid a top-of-file dependency
        // cycle (orchestrator → provision → templates → orchestrator
        // for type-only imports). This is the same pattern
        // cmdVmInstallBundle uses for its bundle helpers.
        const { provisionVM } = await import("../provisioning/provision.js");
        const provisionResult = await provisionVM(this.backend, {
          vmName: physicalName,
          templateName: def.template,
          checkpointLabel: def.checkpoint_restore,
        });
        existing = provisionResult.vmHandle;
        // Append the freshly-provisioned VM to allVms so subsequent
        // iterations of this loop see it (a scenario with two VMs
        // both opting in to provisioning, sharing a template).
        allVms.push(existing);
      }
      if (!existing) {
        const aliasHint = physicalName !== def.name
          ? ` (alias for '${physicalName}')`
          : "";
        throw new Error(
          `VM '${def.name}'${aliasHint} not found in hypervisor. ` +
          `Available VMs: ${allVms.map((v) => v.name).join(", ")}. ` +
          `Set provision_if_missing: true on this VM in setup.yaml ` +
          `to have signalman provision it automatically (P9.4).`,
        );
      }
      vmMap.set(def.name, existing);

      // Restore checkpoint if specified
      if (def.checkpoint_restore) {
        // P2 follow-up: warm-checkpoint is the default. When a scenario
        // explicitly opts out (`warm_checkpoint: false`), emit a one-line
        // warning so the slow-stabilisation path is visible in run output.
        // The actual restore call is the same either way — the optimised
        // stop-then-restore semantics live in `hyperv.ts:restoreCheckpoint`.
        const warm = def.warm_checkpoint ?? true;
        if (!warm) {
          console.warn(
            `[orchestrator] VM '${def.name}' has warm_checkpoint: false — ` +
              `expect a slower stabilisation budget after ` +
              `'${def.checkpoint_restore}' restore`,
          );
        }
        await this.backend.restoreCheckpoint({
          id: "",
          vmHandle: existing,
          label: def.checkpoint_restore,
        });
      }

      // Ensure VM is running
      const status = await this.backend.getStatus(existing);
      if (status.state !== "running") {
        await this.backend.startVM(existing);
        const deadline = Date.now() + 60_000;
        let running = false;
        while (Date.now() < deadline) {
          const current = await this.backend.getStatus(existing);
          if (current.state === "running") {
            running = true;
            break;
          }
          const remaining = deadline - Date.now();
          if (remaining <= 0) break;
          await new Promise((resolve) =>
            setTimeout(resolve, Math.min(1_000, remaining)),
          );
        }
        if (!running) {
          throw new Error(
            `VM '${def.name}' did not reach running state within 60000ms`,
          );
        }
      }
      if ((def.wait_for_heartbeat ?? true) && this.backend.waitForHeartbeat) {
        const ready = await this.backend.waitForHeartbeat(existing, 180_000);
        if (!ready) {
          throw new Error(
            `VM '${def.name}' heartbeat did not become ready within 180000ms`,
          );
        }
      }
    }

    return vmMap;
  }

  /**
   * Wait for guest agents to become reachable on all VMs.
   *
   * Polls each guest client's isConnected() method until it returns true
   * or a timeout (30s default) expires.
   */
  async waitForGuestAgents(
    vmMap: Map<string, VMHandle>,
    vmDefs: VmDefinition[],
  ): Promise<void> {
    // 30s was too tight for cold-boot scenarios (Win11 Gen-2 with
    // vTPM disabled: BIOS + OS + service-startup ~ 60-90s, observed
    // up to 240s under Hyper-V contention, and occasionally 360s+
    // after a long-idle host when the disk cache is cold). 10 min
    // absorbs that worst-case cold boot while still failing fast on
    // real issues (agent crashed, network misconfigured, etc.).
    // The poll interval stays at 2s so we still notice startup within
    // a few seconds of the guest actually being ready.
    const timeoutMs = 600_000;
    const pollIntervalMs = 2_000;

    await Promise.all(vmDefs.map(async (def) => {
      const handle = vmMap.get(def.name);
      let client = this.guestClients.get(def.name);
      if (!client) {
        const canDiscoverOrCreateClient =
          Boolean(def.network?.static_ip) ||
          Boolean(this.backend.getVmIpAddress) ||
          this.backend.name === "tart";
        if (!handle || !canDiscoverOrCreateClient) {
          return;
        }
      }

      const deadline = Date.now() + timeoutMs;
      let connected = false;

      while (Date.now() < deadline) {
        try {
          if (!client) {
            client = await this.ensureGuestClient(def.name, handle!, def);
          }
          connected = await client.isConnected(5_000);
          if (connected) break;
        } catch {
          // Retry while Tart is still assigning an IP or while the agent is
          // still booting.
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        await new Promise((resolve) =>
          setTimeout(resolve, Math.min(pollIntervalMs, remaining)),
        );
      }

      if (!connected) {
        throw new Error(
          `Guest agent on VM '${def.name}' did not become reachable within ${timeoutMs}ms`,
        );
      }
    }));
  }
}
