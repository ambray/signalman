/**
 * Tests for the orchestrator's live event-emission hook (P3.c — closes
 * audit C2-residual). Verifies that step lifecycle events arrive
 * in real-time via the `emit` callback rather than retrospectively
 * after `runScenario` returns.
 *
 * Coverage:
 *   - step.started fires before step body executes (timestamp ordering).
 *   - step.completed / step.failed / step.skipped fire as terminal events.
 *   - step.retry_started fires between retry attempts with attempt
 *     bookkeeping (attempt, of, previous_error, backoff_ms).
 *   - Events for multiple steps preserve step_index ordering.
 *   - Events fire even when the caller does not await further work
 *     (i.e., they arrive *before* runScenario / executeSetup returns).
 */

import { describe, it, expect, vi } from "vitest";

import { ScenarioOrchestrator } from "../scenarios/orchestrator.js";
import type { EnvelopeEventInput } from "../output/envelope.js";
import type {
  HypervisorBackend,
  VMHandle,
  VMStatus,
  CheckpointHandle,
  CheckpointInfo,
  CommandResult,
} from "../hypervisors/interface.js";
import type { GuestAgentClient } from "../guest/client.js";
import type { SignalmanConfig } from "../config.js";

function makeHandle(name: string): VMHandle {
  return { id: `id-${name}`, name, backend: "mock" };
}

function makeMockBackend(): HypervisorBackend {
  return {
    name: "mock",
    isAvailable: vi.fn().mockResolvedValue(true),
    createVM: vi.fn().mockResolvedValue(makeHandle("new-vm")),
    startVM: vi.fn().mockResolvedValue(undefined),
    stopVM: vi.fn().mockResolvedValue(undefined),
    pauseVM: vi.fn().mockResolvedValue(undefined),
    resumeVM: vi.fn().mockResolvedValue(undefined),
    deleteVM: vi.fn().mockResolvedValue(undefined),
    getStatus: vi.fn().mockResolvedValue({
      handle: makeHandle("vm1"),
      state: "running",
      guestAgentReachable: true,
    } as VMStatus),
    listVMs: vi.fn().mockResolvedValue([]),
    createCheckpoint: vi.fn().mockResolvedValue({
      id: "cp",
      vmHandle: makeHandle("vm1"),
      label: "x",
    } as CheckpointHandle),
    restoreCheckpoint: vi.fn().mockResolvedValue(undefined),
    deleteCheckpoint: vi.fn().mockResolvedValue(undefined),
    listCheckpoints: vi.fn().mockResolvedValue([] as CheckpointInfo[]),
    copyFileToVM: vi.fn().mockResolvedValue(undefined),
    copyFileFromVM: vi.fn().mockResolvedValue(undefined),
    executeCommand: vi.fn().mockResolvedValue({
      exitCode: 0,
      stdout: "",
      stderr: "",
      durationMs: 10,
    } as CommandResult),
  };
}

function makeMockClient(): GuestAgentClient {
  return {
    connectionState: "connected",
    isConnected: vi.fn().mockResolvedValue(true),
    dispose: vi.fn(),
    close: vi.fn(),
    health: vi.fn().mockResolvedValue({
      hostname: "test",
      os: "Windows",
      osVersion: "11",
      agentVersion: "0.1.0",
      uptimeSeconds: 100,
      capabilities: [],
    }),
    runCommand: vi.fn(),
    installSoftware: vi.fn(),
    register: vi.fn(),
    processStart: vi.fn(),
    processStop: vi.fn(),
    processList: vi.fn(),
    testNetwork: vi.fn(),
    testFileAccess: vi.fn(),
  } as unknown as GuestAgentClient;
}

function makeOrchestrator() {
  const backend = makeMockBackend();
  const client = makeMockClient();
  const config: SignalmanConfig = {
    hypervisor: { backend: "hyperv" },
    guest: { authToken: "x", clientCertPath: "", clientKeyPath: "", caCertPath: "" },
    docker: undefined,
    kernelDebug: undefined,
  } as unknown as SignalmanConfig;
  const guestClients = new Map<string, GuestAgentClient>([
    ["endpoint-1", client],
  ]);
  const orchestrator = new ScenarioOrchestrator(backend, guestClients, config);
  const vmMap = new Map<string, VMHandle>([["endpoint-1", makeHandle("endpoint-1")]]);
  return { orchestrator, backend, client, vmMap };
}

describe("executeSetup live event emission", () => {
  it("emits step.started before step body runs and step.completed after", async () => {
    const { orchestrator, client, vmMap } = makeOrchestrator();
    const events: EnvelopeEventInput[] = [];
    const cmd = client.runCommand as ReturnType<typeof vi.fn>;
    let runCommandObserved = -1;
    cmd.mockImplementation(async () => {
      // At this point, step.started must have already been emitted.
      runCommandObserved = events.length;
      return { exitCode: 0, stdout: "", stderr: "", durationMs: 10 };
    });

    await orchestrator.executeSetup(
      [{ action: "vm_run_command", vm: "endpoint-1", command: "echo" }],
      vmMap,
      undefined,
      (e) => events.push(e),
    );

    expect(runCommandObserved).toBe(1); // step.started emitted before body
    expect(events[0]).toMatchObject({
      type: "step.started",
      step_index: 0,
      kind: "vm_run_command",
      vm: "endpoint-1",
    });
    expect(events[1]).toMatchObject({
      type: "step.completed",
      step_index: 0,
      kind: "vm_run_command",
    });
  });

  it("emits step.failed with the final error after a non-retried failure", async () => {
    const { orchestrator, client, vmMap } = makeOrchestrator();
    const events: EnvelopeEventInput[] = [];
    (client.runCommand as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("boom"),
    );

    await orchestrator.executeSetup(
      [{ action: "vm_run_command", vm: "endpoint-1", command: "x" }],
      vmMap,
      undefined,
      (e) => events.push(e),
    );

    const failed = events.find((e) => e.type === "step.failed");
    expect(failed).toMatchObject({
      type: "step.failed",
      step_index: 0,
      kind: "vm_run_command",
      error: "boom",
    });
    // No retry, so attempts field is omitted.
    expect((failed as Record<string, unknown>).attempts).toBeUndefined();
  });

  it("emits step.skipped with reason for unknown actions", async () => {
    const { orchestrator, vmMap } = makeOrchestrator();
    const events: EnvelopeEventInput[] = [];

    await orchestrator.executeSetup(
      [
        {
          action: "unknown_action_xyz" as string,
          vm: "endpoint-1",
        } as unknown as { action: string; vm: string },
      ],
      vmMap,
      undefined,
      (e) => events.push(e),
    );

    const skipped = events.find((e) => e.type === "step.skipped");
    expect(skipped).toMatchObject({
      type: "step.skipped",
      step_index: 0,
      kind: "unknown_action_xyz",
    });
    expect((skipped as Record<string, unknown>).reason).toContain(
      "Unknown action",
    );
  });

  it("emits step.retry_started between failed attempts", async () => {
    const { orchestrator, client, vmMap } = makeOrchestrator();
    const events: EnvelopeEventInput[] = [];
    const cmd = client.runCommand as ReturnType<typeof vi.fn>;
    cmd.mockRejectedValueOnce(new Error("first fail"));
    cmd.mockRejectedValueOnce(new Error("second fail"));
    cmd.mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "", durationMs: 10 });

    await orchestrator.executeSetup(
      [
        {
          action: "vm_run_command",
          vm: "endpoint-1",
          command: "echo",
          retry: { count: 3, backoff_ms: 1, jitter: false },
        },
      ],
      vmMap,
      undefined,
      (e) => events.push(e),
    );

    const retryEvents = events.filter((e) => e.type === "step.retry_started");
    expect(retryEvents).toHaveLength(2);
    expect(retryEvents[0]).toMatchObject({
      type: "step.retry_started",
      step_index: 0,
      attempt: 2,
      of: 4,
      previous_error: "first fail",
      backoff_ms: 1,
    });
    expect(retryEvents[1]).toMatchObject({
      attempt: 3,
      previous_error: "second fail",
    });

    const completed = events.find((e) => e.type === "step.completed");
    expect(completed).toMatchObject({
      type: "step.completed",
      step_index: 0,
      attempts: 3,
    });
  });

  it("preserves step_index ordering across multiple steps", async () => {
    const { orchestrator, client, vmMap } = makeOrchestrator();
    const events: EnvelopeEventInput[] = [];
    (client.runCommand as ReturnType<typeof vi.fn>).mockResolvedValue({
      exitCode: 0,
      stdout: "",
      stderr: "",
      durationMs: 10,
    });

    await orchestrator.executeSetup(
      [
        { action: "vm_run_command", vm: "endpoint-1", command: "a" },
        { action: "wait", duration_ms: 1 },
        { action: "vm_run_command", vm: "endpoint-1", command: "b" },
      ],
      vmMap,
      undefined,
      (e) => events.push(e),
    );

    const stepStarted = events.filter((e) => e.type === "step.started");
    const indices = stepStarted.map((e) => e.step_index as number);
    expect(indices).toEqual([0, 1, 2]);

    const completed = events.filter((e) => e.type === "step.completed");
    expect(completed.map((e) => e.step_index as number)).toEqual([0, 1, 2]);
  });

  it("does not break when no emit callback is provided", async () => {
    // Backwards-compat: callers that don't pass `emit` (legacy) still
    // get the full StepResult array. P3.c is purely additive.
    const { orchestrator, client, vmMap } = makeOrchestrator();
    (client.runCommand as ReturnType<typeof vi.fn>).mockResolvedValue({
      exitCode: 0,
      stdout: "",
      stderr: "",
      durationMs: 10,
    });

    const results = await orchestrator.executeSetup(
      [{ action: "vm_run_command", vm: "endpoint-1", command: "echo" }],
      vmMap,
    );
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe("success");
  });
});
