/**
 * Tests for scenario / step-level retry policy (P3.b — closes audit C5).
 *
 * Covers:
 *   - Schema validation of `retry: { count, backoff_ms, jitter }` blocks
 *     at scenario and step level.
 *   - Per-step `retry:` override beats scenario-level default.
 *   - Successful retry after transient failure: status=success, attempts>1,
 *     attempt_failures populated.
 *   - Exhausted retries: status=failed, attempts=count+1, attempt_failures
 *     excludes the final attempt's error (which appears in `error`).
 *   - No-retry case omits the attempts/attempt_failures fields entirely
 *     (envelope tidiness for the common case).
 */

import { describe, it, expect, vi } from "vitest";

import { ScenarioOrchestrator } from "../scenarios/orchestrator.js";
import {
  retryConfigSchema,
  scenarioConfigSchema,
  setupStepSchema,
} from "../scenarios/schema.js";
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

// ── schema tests ──────────────────────────────────────────────────

describe("retryConfigSchema", () => {
  it("accepts a fully-specified policy", () => {
    const r = retryConfigSchema.parse({
      count: 3,
      backoff_ms: 2000,
      jitter: true,
    });
    expect(r).toEqual({ count: 3, backoff_ms: 2000, jitter: true });
  });

  it("requires `count` but defaults backoff_ms and jitter", () => {
    const r = retryConfigSchema.parse({ count: 2 });
    expect(r.backoff_ms).toBe(1000);
    expect(r.jitter).toBe(false);
  });

  it("rejects count > 10 (caps pathological retry storms)", () => {
    expect(() => retryConfigSchema.parse({ count: 11 })).toThrow();
  });

  it("rejects backoff_ms > 60000 (caps total wait per step)", () => {
    expect(() =>
      retryConfigSchema.parse({ count: 1, backoff_ms: 60_001 }),
    ).toThrow();
  });

  it("rejects negative count and backoff_ms", () => {
    expect(() => retryConfigSchema.parse({ count: -1 })).toThrow();
    expect(() =>
      retryConfigSchema.parse({ count: 1, backoff_ms: -1 }),
    ).toThrow();
  });

  it("accepts count: 0 as explicit no-retry", () => {
    const r = retryConfigSchema.parse({ count: 0 });
    expect(r.count).toBe(0);
  });
});

describe("setupStepSchema with retry", () => {
  it("attaches a retry block to a step", () => {
    const s = setupStepSchema.parse({
      action: "vm_run_command",
      vm: "endpoint-1",
      retry: { count: 3, backoff_ms: 500 },
    });
    expect(s.retry).toMatchObject({ count: 3, backoff_ms: 500 });
  });

  it("leaves retry undefined when not specified", () => {
    const s = setupStepSchema.parse({ action: "wait" });
    expect(s.retry).toBeUndefined();
  });
});

describe("scenarioConfigSchema with top-level retry", () => {
  it("accepts a scenario-level default retry policy", () => {
    const s = scenarioConfigSchema.parse({
      name: "test",
      version: "1.0",
      vms: [
        {
          name: "endpoint-1",
          template: "win11-base",
          guest_agent_port: 50051,
        },
      ],
      retry: { count: 2 },
    });
    expect(s.retry).toMatchObject({ count: 2, backoff_ms: 1000, jitter: false });
  });
});

// ── orchestrator behaviour ────────────────────────────────────────

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
  const guestClients = new Map<string, GuestAgentClient>([["endpoint-1", client]]);
  const orchestrator = new ScenarioOrchestrator(backend, guestClients, config);
  const vmMap = new Map<string, VMHandle>([["endpoint-1", makeHandle("endpoint-1")]]);
  return { orchestrator, backend, client, vmMap };
}

describe("executeSetup with retry", () => {
  it("succeeds on first attempt: omits attempts + attempt_failures", async () => {
    const { orchestrator, client, vmMap } = makeOrchestrator();
    (client.runCommand as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      exitCode: 0,
      stdout: "",
      stderr: "",
      durationMs: 10,
    });
    const results = await orchestrator.executeSetup(
      [{ action: "vm_run_command", vm: "endpoint-1", command: "echo hi" }],
      vmMap,
    );
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe("success");
    expect(results[0].attempts).toBeUndefined();
    expect(results[0].attempt_failures).toBeUndefined();
  });

  it("retries a flaky step until success: records attempts + intermediate failures", async () => {
    const { orchestrator, client, vmMap } = makeOrchestrator();
    const cmd = client.runCommand as ReturnType<typeof vi.fn>;
    cmd.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    cmd.mockRejectedValueOnce(new Error("transient timeout"));
    cmd.mockResolvedValueOnce({
      exitCode: 0,
      stdout: "",
      stderr: "",
      durationMs: 10,
    });

    const results = await orchestrator.executeSetup(
      [
        {
          action: "vm_run_command",
          vm: "endpoint-1",
          command: "echo hi",
          retry: { count: 3, backoff_ms: 1, jitter: false },
        },
      ],
      vmMap,
    );
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe("success");
    expect(results[0].attempts).toBe(3); // 2 failures + 1 success
    expect(results[0].attempt_failures).toEqual([
      "ECONNREFUSED",
      "transient timeout",
    ]);
    expect(cmd).toHaveBeenCalledTimes(3);
  });

  it("exhausts retries and reports failed: attempts=count+1, attempt_failures excludes final error", async () => {
    const { orchestrator, client, vmMap } = makeOrchestrator();
    const cmd = client.runCommand as ReturnType<typeof vi.fn>;
    cmd.mockRejectedValue(new Error("permanently broken"));

    const results = await orchestrator.executeSetup(
      [
        {
          action: "vm_run_command",
          vm: "endpoint-1",
          command: "echo hi",
          retry: { count: 2, backoff_ms: 1, jitter: false },
        },
      ],
      vmMap,
    );
    expect(results[0].status).toBe("failed");
    expect(results[0].attempts).toBe(3); // initial + 2 retries
    // The final attempt's error is in `error`; intermediates in attempt_failures.
    expect(results[0].error).toBe("permanently broken");
    expect(results[0].attempt_failures).toEqual([
      "permanently broken",
      "permanently broken",
    ]);
    expect(cmd).toHaveBeenCalledTimes(3);
  });

  it("scenario-level retry applies as default to steps without their own", async () => {
    const { orchestrator, client, vmMap } = makeOrchestrator();
    const cmd = client.runCommand as ReturnType<typeof vi.fn>;
    cmd.mockRejectedValueOnce(new Error("once"));
    cmd.mockResolvedValueOnce({
      exitCode: 0,
      stdout: "",
      stderr: "",
      durationMs: 10,
    });

    const results = await orchestrator.executeSetup(
      [{ action: "vm_run_command", vm: "endpoint-1", command: "echo" }],
      vmMap,
      { count: 2, backoff_ms: 1, jitter: false },
    );
    expect(results[0].status).toBe("success");
    expect(results[0].attempts).toBe(2);
    expect(results[0].attempt_failures).toEqual(["once"]);
  });

  it("per-step retry overrides scenario-level retry", async () => {
    const { orchestrator, client, vmMap } = makeOrchestrator();
    const cmd = client.runCommand as ReturnType<typeof vi.fn>;
    cmd.mockRejectedValue(new Error("flaky"));

    const results = await orchestrator.executeSetup(
      [
        {
          action: "vm_run_command",
          vm: "endpoint-1",
          command: "echo",
          // Step explicitly disables retry — should override scenario's count: 5.
          retry: { count: 0, backoff_ms: 0, jitter: false },
        },
      ],
      vmMap,
      { count: 5, backoff_ms: 1, jitter: false },
    );
    expect(results[0].status).toBe("failed");
    // count: 0 means 1 total attempt; recordAttempts only fires if attempts > 1,
    // so attempts/attempt_failures should be absent.
    expect(results[0].attempts).toBeUndefined();
    expect(results[0].attempt_failures).toBeUndefined();
    expect(cmd).toHaveBeenCalledTimes(1);
  });

  it("does not retry skipped (unknown-action) steps — they're deterministic", async () => {
    const { orchestrator, vmMap } = makeOrchestrator();
    const results = await orchestrator.executeSetup(
      [
        {
          action: "definitely-not-a-real-action" as string,
          vm: "endpoint-1",
        } as unknown as { action: string; vm: string },
      ],
      vmMap,
      { count: 5, backoff_ms: 1000, jitter: false },
    );
    expect(results[0].status).toBe("skipped");
    expect(results[0].error).toContain("Unknown action");
    expect(results[0].attempts).toBeUndefined();
  });
});
