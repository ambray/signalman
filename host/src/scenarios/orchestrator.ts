/**
 * Scenario orchestrator — multi-VM scenario execution engine.
 *
 * Coordinates setup, workflow execution, assertion evaluation, and
 * teardown across multiple VMs. Bridges the hypervisor backend and
 * guest agent clients to execute scenario DSL actions.
 */

import * as path from "node:path";
import type { HypervisorBackend, VMHandle } from "../hypervisors/interface.js";
import type { GuestAgentClient } from "../guest/client.js";
import type { SignalmanConfig } from "../config.js";
import type { DockerClient, ComposeConfig } from "../docker/client.js";
import {
  loadScenario,
  evaluateAssertions,
  evaluateAssertionsV2,
  extractToolBlocks,
} from "./runner.js";
import type { CommandResult } from "../guest/client.js";
import type {
  SetupStep,
  SandboxMode,
} from "./runner.js";
import { parseNarrative } from "./narrative.js";
import { BreakLog } from "../kernel-debug/break-log.js";
import { createKernelDebugToolRegistry } from "../kernel-debug/tools.js";
import type { ToolRegistry } from "../kernel-debug/tool-registry.js";

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
import { writeJunitReport } from "../output/reporter.js";
import type { TestResult, AssertionResultEntry } from "../output/reporter.js";

// ── Types ──────────────────────────────────────────────────────────

/** VM definition as declared in a scenario's setup.yaml. */
export interface VmDefinition {
  /** Logical name used in scenario steps (e.g., "endpoint-1"). */
  name: string;
  /** Template name or checkpoint to restore from. */
  template: string;
  /** Checkpoint to restore before the test starts. */
  checkpoint_restore?: string;
  /** Guest agent gRPC port (default: 50051). */
  guest_agent_port: number;
  /** Network configuration. */
  network?: {
    switch: string;
    static_ip: string;
  };
}

/** Result of a single setup/teardown step. */
export interface StepResult {
  action: string;
  vm: string;
  status: "success" | "failed" | "skipped";
  duration_ms: number;
  error?: string;
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
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    this.toolRegistry = createInitialToolRegistry();
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

  /**
   * Execute a complete scenario: setup, workflow, assertions, teardown.
   *
   * @param scenarioPath - Path to the scenario directory.
   * @returns The full ScenarioResult.
   */
  async runScenario(scenarioPath: string): Promise<ScenarioResult> {
    const startTime = Date.now();
    const setupResults: StepResult[] = [];
    const teardownResults: StepResult[] = [];
    let assertionResults: AssertionResult[] = [];
    let scenarioName = "unknown";
    let status: "passed" | "failed" | "error" = "passed";
    let error: string | undefined;

    try {
      const loadResult = loadScenario(scenarioPath);
      const { config: scenarioConfig, assertions } = loadResult;
      scenarioName = scenarioConfig.name;

      // Resolve VMs
      const vmDefs: VmDefinition[] = scenarioConfig.vms.map((vm) => ({
        name: vm.name,
        template: vm.template,
        checkpoint_restore: vm.checkpoint_restore,
        guest_agent_port: vm.guest_agent_port,
        network: vm.network,
      }));
      const vmMap = await this.resolveVms(vmDefs);

      // Wait for guest agents
      await this.waitForGuestAgents(vmMap, vmDefs);

      // Execute setup
      const setupSteps = scenarioConfig.setup ?? [];
      const sResults = await this.executeSetup(setupSteps, vmMap);
      setupResults.push(...sResults);

      const setupFailed = sResults.some((r) => r.status === "failed");
      if (setupFailed) {
        status = "failed";
      }

      // Execute workflow tool blocks from workflow.md
      const workflowOutputs = new Map<string, string>();
      const workflowScreenshots = new Map<string, string>();

      if (loadResult.workflowMarkdown) {
        const narrative = loadResult.narrative ?? parseNarrative(loadResult.workflowMarkdown);
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
              } catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                workflowOutputs.set(sourceKey, `ERROR: ${msg}`);
                status = "failed";
              }
              stepIndex++;
            }
          }
        } else {
          // Fallback: extract tool blocks directly
          const blocks = extractToolBlocks(loadResult.workflowMarkdown);
          for (let i = 0; i < blocks.length; i++) {
            const sourceKey = `step-${i}`;
            try {
              const output = await this.executeToolBlock(
                blocks[i].tool,
                blocks[i].params,
                vmMap,
              );
              workflowOutputs.set(sourceKey, output);
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e);
              workflowOutputs.set(sourceKey, `ERROR: ${msg}`);
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
          const { results: v2Results } = await evaluateAssertionsV2(
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

        const anyFailed = assertionResults.some((r) => !r.passed);
        if (anyFailed) {
          status = "failed";
        }
      }

      // Execute teardown
      const teardownSteps = scenarioConfig.teardown ?? [];
      const tResults = await this.executeTeardown(teardownSteps, vmMap);
      teardownResults.push(...tResults);
    } catch (err) {
      status = "error";
      error = err instanceof Error ? err.message : String(err);
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
        screenshots: [],
        errors: error ? [error] : [],
      };

      const scenarioOutputDir = path.join(this.outputDir, scenarioName);
      writeJunitReport(testResult, scenarioOutputDir);
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
   * Execute setup steps sequentially.
   *
   * Supported actions:
   * - vm_install: Install software via guest agent
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
  ): Promise<StepResult[]> {
    const results: StepResult[] = [];

    for (const rawStep of steps) {
      // Story 5.2: substitute ${SANDBOX_MODE} etc. before dispatch so the
      // existing per-action handlers see the resolved values.
      const step = this.substituteSandboxMode(rawStep) as SetupStep;
      const vmName = (step.vm as string) ?? "";
      const startTime = Date.now();

      try {
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
            results.push({
              action: step.action,
              vm: vmName,
              status: "success",
              duration_ms: Date.now() - startTime,
            });
            break;
          }

          case "vm_copy_file": {
            const handle = vmMap.get(vmName);
            if (!handle) throw new Error(`VM '${vmName}' not found in resolved VMs`);
            const direction = (step.direction as string) ?? "host_to_guest";
            if (direction === "host_to_guest") {
              await this.backend.copyFileToVM(
                handle,
                step.host_path as string,
                step.guest_path as string,
              );
            } else {
              await this.backend.copyFileFromVM(
                handle,
                step.guest_path as string,
                step.host_path as string,
              );
            }
            results.push({
              action: step.action,
              vm: vmName,
              status: "success",
              duration_ms: Date.now() - startTime,
            });
            break;
          }

          case "vm_run_command": {
            const handle = vmMap.get(vmName);
            if (!handle) throw new Error(`VM '${vmName}' not found in resolved VMs`);
            const client = this.guestClients.get(vmName);
            if (!client) throw new Error(`No guest client for VM '${vmName}'`);
            const timeoutMs = (step.timeout_ms as number) ?? 60_000;
            const cmdArgs = (step.args as string[]) ?? [];
            const runAs = (step.run_as as string) ?? undefined;
            await client.runCommand(
              step.command as string,
              cmdArgs,
              { timeoutMs, runAs },
            );
            results.push({
              action: step.action,
              vm: vmName,
              status: "success",
              duration_ms: Date.now() - startTime,
            });
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
            results.push({
              action: step.action,
              vm: vmName,
              status: "success",
              duration_ms: Date.now() - startTime,
            });
            break;
          }

          case "vm_checkpoint": {
            const handle = vmMap.get(vmName);
            if (!handle) throw new Error(`VM '${vmName}' not found in resolved VMs`);
            const label = step.label as string;
            await this.backend.createCheckpoint(handle, label);
            results.push({
              action: step.action,
              vm: vmName,
              status: "success",
              duration_ms: Date.now() - startTime,
            });
            break;
          }

          case "wait": {
            const durationMs = (step.duration_ms as number) ?? 1_000;
            await new Promise((resolve) => setTimeout(resolve, durationMs));
            results.push({
              action: step.action,
              vm: vmName,
              status: "success",
              duration_ms: Date.now() - startTime,
            });
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

            results.push({
              action: step.action,
              vm: vmName,
              status: "success",
              duration_ms: Date.now() - startTime,
            });
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
            results.push({
              action: step.action,
              vm: vmName,
              status: "success",
              duration_ms: Date.now() - startTime,
            });
            break;
          }

          default: {
            results.push({
              action: step.action,
              vm: vmName,
              status: "skipped",
              duration_ms: Date.now() - startTime,
              error: `Unknown action: ${step.action}`,
            });
          }
        }
      } catch (err) {
        results.push({
          action: step.action,
          vm: vmName,
          status: "failed",
          duration_ms: Date.now() - startTime,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return results;
  }

  /**
   * Execute teardown steps. Errors are captured but do not throw.
   */
  async executeTeardown(
    steps: SetupStep[],
    vmMap: Map<string, VMHandle>,
  ): Promise<StepResult[]> {
    // Teardown uses the same logic as setup but swallows errors
    return this.executeSetup(steps, vmMap);
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
        const client = this.guestClients.get(vmName);
        if (!client) throw new Error(`No guest client for VM '${vmName}'`);
        const command = params.command as string;
        const args = (params.args as string[]) ?? [];
        const timeoutMs = (params.timeout_ms as number) ?? 60_000;
        const runAs = (params.run_as as string) ?? undefined;
        const result = await client.runCommand(command, args, { timeoutMs, runAs });
        return result.stdout ?? "";
      }

      case "vm_copy_file": {
        const handle = vmMap.get(vmName);
        if (!handle) throw new Error(`VM '${vmName}' not found`);
        const direction = (params.direction as string) ?? "host_to_guest";
        if (direction === "host_to_guest") {
          await this.backend.copyFileToVM(
            handle,
            params.host_path as string,
            params.guest_path as string,
          );
        } else {
          await this.backend.copyFileFromVM(
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

      case "ui_click": {
        const client = this.guestClients.get(vmName);
        if (!client) throw new Error(`No guest client for VM '${vmName}'`);
        const selector = params.selector as string;
        if (!selector) throw new Error(`ui_click missing 'selector'`);
        const result = await client.uiClick(selector, {
          windowTitle: params.window_title as string | undefined,
          clickType: params.click_type as "left" | "right" | "double" | undefined,
          timeoutMs: params.timeout_ms as number | undefined,
        });
        return JSON.stringify(result);
      }

      case "ui_type": {
        const client = this.guestClients.get(vmName);
        if (!client) throw new Error(`No guest client for VM '${vmName}'`);
        const text = params.text as string;
        if (text === undefined || text === null) {
          throw new Error(`ui_type missing 'text'`);
        }
        const result = await client.uiType(text, {
          selector: params.selector as string | undefined,
          windowTitle: params.window_title as string | undefined,
          clearFirst: params.clear_first as boolean | undefined,
          timeoutMs: params.timeout_ms as number | undefined,
        });
        return JSON.stringify(result);
      }

      case "ui_find": {
        const client = this.guestClients.get(vmName);
        if (!client) throw new Error(`No guest client for VM '${vmName}'`);
        const selector = params.selector as string;
        if (!selector) throw new Error(`ui_find missing 'selector'`);
        const elements = await client.uiFind(selector, {
          windowTitle: params.window_title as string | undefined,
          findTimeoutMs: params.find_timeout_ms as number | undefined,
          timeoutMs: params.timeout_ms as number | undefined,
        });
        // Return a structured result so `json_field` assertions can
        // query e.g. `count` or `elements[0].is_enabled`.
        return JSON.stringify({ count: elements.length, elements });
      }

      case "ui_screenshot": {
        const client = this.guestClients.get(vmName);
        if (!client) throw new Error(`No guest client for VM '${vmName}'`);
        const buffer = await client.screenshot(
          params.window_title as string | undefined,
          (params.format as string) ?? "png",
          params.timeout_ms as number | undefined,
        );
        // Optional persistence to disk for visual debugging — when
        // `output` is set, write the bytes there. Either way return
        // size metadata so assertions can sanity-check the capture.
        let savedPath: string | undefined;
        if (typeof params.output === "string" && params.output.length > 0) {
          const fs = await import("node:fs");
          fs.mkdirSync(path.dirname(params.output), { recursive: true });
          fs.writeFileSync(params.output, buffer);
          savedPath = params.output;
        }
        return JSON.stringify({
          bytes: buffer.length,
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
    const allVms = await this.backend.listVMs();

    for (const def of vmDefs) {
      // Resolve alias: check config.vmAliases first, then use the logical name
      const physicalName = this.config.vmAliases?.[def.name] ?? def.name;
      const existing = allVms.find(
        (vm) => vm.name.toLowerCase() === physicalName.toLowerCase(),
      );
      if (!existing) {
        const aliasHint = physicalName !== def.name
          ? ` (alias for '${physicalName}')`
          : "";
        throw new Error(
          `VM '${def.name}'${aliasHint} not found in hypervisor. ` +
          `Available VMs: ${allVms.map((v) => v.name).join(", ")}`,
        );
      }
      vmMap.set(def.name, existing);

      // Restore checkpoint if specified
      if (def.checkpoint_restore) {
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
    const timeoutMs = 30_000;
    const pollIntervalMs = 2_000;

    for (const def of vmDefs) {
      const client = this.guestClients.get(def.name);
      if (!client) {
        throw new Error(`No guest client configured for VM '${def.name}'`);
      }

      const deadline = Date.now() + timeoutMs;
      let connected = false;

      while (Date.now() < deadline) {
        try {
          connected = await client.isConnected(5_000);
          if (connected) break;
        } catch {
          // Retry on connection failure
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
    }
  }
}
