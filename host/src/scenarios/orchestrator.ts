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
import {
  loadScenario,
  evaluateAssertions,
  extractToolBlocks,
} from "./runner.js";
import type {
  SetupStep,
} from "./runner.js";
import { parseNarrative } from "./narrative.js";
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

  constructor(
    private backend: HypervisorBackend,
    private guestClients: Map<string, GuestAgentClient>,
    private config: SignalmanConfig,
    options?: OrchestratorOptions,
  ) {
    this.outputDir = options?.outputDir;
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

      // Evaluate assertions against workflow outputs
      if (assertions.assertions.length > 0) {
        const { results } = evaluateAssertions(assertions, workflowOutputs, workflowScreenshots);
        assertionResults = results.map((r) => ({
          id: r.assertion.id,
          description: r.assertion.description,
          passed: r.passed,
          actual: r.actual,
          error: r.error,
        }));

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
   * Execute setup steps sequentially.
   *
   * Supported actions:
   * - vm_install: Install software via guest agent
   * - vm_copy_file: Copy a file host->guest or guest->host
   * - vm_run_command: Run a command inside the VM
   * - vm_restore: Restore a VM checkpoint
   * - vm_checkpoint: Create a VM checkpoint
   * - wait: Sleep for a duration
   */
  async executeSetup(
    steps: SetupStep[],
    vmMap: Map<string, VMHandle>,
  ): Promise<StepResult[]> {
    const results: StepResult[] = [];

    for (const step of steps) {
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
    params: Record<string, unknown>,
    vmMap: Map<string, VMHandle>,
  ): Promise<string> {
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

      default:
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
      const existing = allVms.find(
        (vm) => vm.name.toLowerCase() === def.name.toLowerCase(),
      );
      if (!existing) {
        throw new Error(`VM '${def.name}' not found in hypervisor`);
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
