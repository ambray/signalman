import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ScenarioOrchestrator,
  assertScenarioCapabilities,
  substituteRuntimeRefsDeep,
} from "../scenarios/orchestrator.js";
import { loadTemplates, resolveTemplate } from "../scenarios/templates.js";
import type { VmDefinition, StepResult } from "../scenarios/orchestrator.js";
import type {
  HypervisorBackend,
  VMHandle,
  VMStatus,
  CheckpointHandle,
  CheckpointInfo,
  CommandResult,
  VMConfig,
} from "../hypervisors/interface.js";
import type { GuestAgentClient } from "../guest/client.js";
import type { SignalmanConfig } from "../config.js";

const guestAgentClientMockState = vi.hoisted(() => ({
  nextInstances: [] as Array<Record<string, unknown>>,
  constructorArgs: [] as Array<unknown[]>,
}));

const provisionMockState = vi.hoisted(() => ({
  calls: [] as Array<unknown[]>,
  nextHandle: {
    id: "id-provisioned-vm",
    name: "provisioned-vm",
    backend: "mock",
  } as VMHandle,
}));

vi.mock("../guest/client.js", () => ({
  GuestAgentClient: vi.fn().mockImplementation((...args: unknown[]) => {
    guestAgentClientMockState.constructorArgs.push(args);
    const next = guestAgentClientMockState.nextInstances.shift() ?? {};
    return {
      connectionState: "connected",
      isConnected: vi.fn().mockResolvedValue(true),
      dispose: vi.fn(),
      close: vi.fn(),
      ...next,
    };
  }),
}));

vi.mock("../provisioning/provision.js", () => ({
  provisionVM: vi.fn().mockImplementation(async (...args: unknown[]) => {
    provisionMockState.calls.push(args);
    return {
      vmName: provisionMockState.nextHandle.name,
      vmHandle: provisionMockState.nextHandle,
      checkpointLabel: "agent-installed",
      alreadyProvisioned: false,
      durationMs: 10,
    };
  }),
}));

// ── Mock Factories ─────────────────────────────────────────────────

function makeHandle(name: string): VMHandle {
  return { id: `id-${name}`, name, backend: "mock" };
}

function makeMockBackend(
  overrides: Partial<HypervisorBackend> = {},
): HypervisorBackend {
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
      guestAgentReachable: false,
    } as VMStatus),
    listVMs: vi
      .fn()
      .mockResolvedValue([makeHandle("vm1"), makeHandle("vm2")]),
    createCheckpoint: vi.fn().mockResolvedValue({
      id: "cp-1",
      vmHandle: makeHandle("vm1"),
      label: "test-cp",
    } as CheckpointHandle),
    restoreCheckpoint: vi.fn().mockResolvedValue(undefined),
    deleteCheckpoint: vi.fn().mockResolvedValue(undefined),
    listCheckpoints: vi.fn().mockResolvedValue([] as CheckpointInfo[]),
    copyFileToVM: vi.fn().mockResolvedValue(undefined),
    copyFileFromVM: vi.fn().mockResolvedValue(undefined),
    executeCommand: vi.fn().mockResolvedValue({
      exitCode: 0,
      stdout: "ok",
      stderr: "",
      durationMs: 100,
    } as CommandResult),
    ...overrides,
  };
}

function makeMockClient(
  overrides: Partial<GuestAgentClient> = {},
): GuestAgentClient {
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
    runCommand: vi.fn().mockResolvedValue({
      exitCode: 0,
      stdout: "ok",
      stderr: "",
      durationMs: 50,
    }),
    installSoftware: vi.fn().mockResolvedValue({
      success: true,
      exitCode: 0,
      stdout: "installed",
      stderr: "",
      installedPath: "C:\\Program Files\\test",
    }),
    startProcess: vi.fn().mockResolvedValue({
      pid: 1234,
      started: true,
      error: "",
      exitCode: 0,
      stdout: "",
      stderr: "",
    }),
    stopProcess: vi.fn().mockResolvedValue({ stopped: true, error: "" }),
    listProcesses: vi.fn().mockResolvedValue([]),
    verifyRestriction: vi.fn().mockResolvedValue({
      isRestricted: false,
      hasFirewallRules: false,
      blockedDomains: [],
      verdict: "unrestricted",
      issues: [],
      // P8: Windows-specific evidence under platformDetails.windows.
      platformDetails: {
        windows: {
          restrictionMode: "none",
          hasAppcontainerToken: false,
          appcontainerSid: "",
          isLowIntegrity: false,
          isInJob: false,
          jobName: "",
          hasRestrictDll: false,
          restrictDllPath: "",
        },
      },
    }),
    testNetwork: vi.fn().mockResolvedValue({
      reachable: true,
      latencyMs: 10,
      error: "",
      tlsInfo: "",
    }),
    testFileAccess: vi.fn().mockResolvedValue({
      allowed: true,
      error: "",
      errorCode: "",
    }),
    readFile: vi.fn().mockResolvedValue(Buffer.from("from guest")),
    readFileChunk: vi.fn().mockResolvedValue({
      data: Buffer.from("from guest"),
      truncated: false,
    }),
    writeFile: vi.fn().mockResolvedValue({ bytesWritten: 9 }),
    listDirectory: vi.fn().mockResolvedValue([]),
    screenshot: vi.fn().mockResolvedValue(Buffer.from([])),
    ...overrides,
  } as unknown as GuestAgentClient;
}

function makeConfig(): SignalmanConfig {
  return {
    hypervisor: { backend: "hyperv" },
    guestAgent: { defaultPort: 50051, tls: { enabled: false } },
    scenarios: {
      dir: "./scenarios",
      outputDir: "./output",
      screenshotDir: "./output/screenshots",
    },
  };
}

// ── Tests ──────────────────────────────────────────────────────────

describe("ScenarioOrchestrator", () => {
  let backend: HypervisorBackend;
  let clients: Map<string, GuestAgentClient>;
  let config: SignalmanConfig;
  let orchestrator: ScenarioOrchestrator;

  beforeEach(() => {
    guestAgentClientMockState.nextInstances = [];
    guestAgentClientMockState.constructorArgs = [];
    provisionMockState.calls = [];
    provisionMockState.nextHandle = {
      id: "id-provisioned-vm",
      name: "provisioned-vm",
      backend: "mock",
    };
    backend = makeMockBackend();
    clients = new Map([
      ["vm1", makeMockClient()],
      ["vm2", makeMockClient()],
    ]);
    config = makeConfig();
    orchestrator = new ScenarioOrchestrator(backend, clients, config);
  });

  // ── resolveVms ──────────────────────────────────────────────────

  it("resolveVms creates VMHandles from definitions", async () => {
    const defs: VmDefinition[] = [
      { name: "vm1", template: "win11-base", guest_agent_port: 50051 },
      { name: "vm2", template: "win11-base", guest_agent_port: 50051 },
    ];

    const vmMap = await orchestrator.resolveVms(defs);

    expect(vmMap.size).toBe(2);
    expect(vmMap.get("vm1")?.name).toBe("vm1");
    expect(vmMap.get("vm2")?.name).toBe("vm2");
    expect(backend.listVMs).toHaveBeenCalled();
  });

  it("resolveVms throws when VM not found", async () => {
    const defs: VmDefinition[] = [
      { name: "nonexistent", template: "win11-base", guest_agent_port: 50051 },
    ];

    await expect(orchestrator.resolveVms(defs)).rejects.toThrow(
      "VM 'nonexistent' not found in hypervisor",
    );
  });

  it("resolveVms restores checkpoint when specified", async () => {
    const defs: VmDefinition[] = [
      {
        name: "vm1",
        template: "win11-base",
        checkpoint_restore: "clean",
        guest_agent_port: 50051,
      },
    ];

    await orchestrator.resolveVms(defs);

    expect(backend.restoreCheckpoint).toHaveBeenCalledWith(
      expect.objectContaining({ label: "clean" }),
    );
  });

  // ── pre_started bypass (Sprint 60.12 Phase B) ──────────────────
  //
  // Sub-suite locks down the contract that scenarios marked
  // `pre_started: true` skip ALL hypervisor lifecycle calls. The
  // scenarios depending on this are unprivileged-host-CLI runs
  // where the listVMs cmdlet would either fail with access-denied
  // or hang behind a UAC prompt.

  it("resolveVms with pre_started: true skips listVMs entirely", async () => {
    const defs: VmDefinition[] = [
      {
        name: "vm1",
        template: "win11-base",
        guest_agent_port: 50051,
        pre_started: true,
      },
    ];

    const vmMap = await orchestrator.resolveVms(defs);

    expect(vmMap.get("vm1")?.id).toBe("pre-started");
    // The whole point — we don't query the hypervisor at all.
    expect(backend.listVMs).not.toHaveBeenCalled();
    expect(backend.restoreCheckpoint).not.toHaveBeenCalled();
    expect(backend.startVM).not.toHaveBeenCalled();
    expect(backend.getStatus).not.toHaveBeenCalled();
  });

  it("resolveVms with pre_started: true honours vmAliases for the synthetic handle", async () => {
    const cfgWithAlias: SignalmanConfig = {
      ...config,
      vmAliases: { vm1: "Win11x64-Real" },
    };
    const orch = new ScenarioOrchestrator(backend, clients, cfgWithAlias);
    const defs: VmDefinition[] = [
      {
        name: "vm1",
        template: "win11-base",
        guest_agent_port: 50051,
        pre_started: true,
      },
    ];

    const vmMap = await orch.resolveVms(defs);
    const handle = vmMap.get("vm1");
    expect(handle?.id).toBe("pre-started");
    expect(handle?.name).toBe("Win11x64-Real");
  });

  // ── REGRESSION: unprivileged host-CLI hang ────────────────────
  //
  // Field bug:
  //   example-agent-driver-e2e Sprint 60.12 Phase B run.
  //   Without the pre_started fast-path, signalman would call
  //   `Get-VM` (via `listVMs`) under an unprivileged shell. On
  //   unattended runs (no human watching the screen) this either
  //   exited with access-denied OR hung 30 seconds behind a UAC
  //   prompt no human ever clicked, then surfaced a cryptic
  //   "User cancelled" error.
  //
  // Contract under test:
  //   When EVERY VM in the scenario is marked `pre_started: true`,
  //   listVMs is never called. The only hypervisor-side work is
  //   constructing synthetic VMHandles with id `"pre-started"` so
  //   downstream code (vm_copy_file, scenario hooks) can detect
  //   the shape and route around hypervisor-level operations.
  it("REGRESSION: unprivileged scenario does NOT touch the hypervisor", async () => {
    // Make listVMs throw the way an unprivileged Get-VM would:
    // we want to PROVE the bypass — if anything internally tries to
    // list VMs the test fails loudly rather than silently masking
    // the regression.
    const angryBackend = makeMockBackend({
      listVMs: vi.fn().mockRejectedValue(
        new Error(
          "Get-VM: access denied (this scenario must run elevated, " +
            "or be marked pre_started: true on every VM def)",
        ),
      ),
    });
    const orch = new ScenarioOrchestrator(angryBackend, clients, config);

    const defs: VmDefinition[] = [
      {
        name: "vm1",
        template: "win11-base",
        guest_agent_port: 50051,
        pre_started: true,
      },
      {
        name: "vm2",
        template: "win11-base",
        guest_agent_port: 50051,
        pre_started: true,
      },
    ];

    // No throw — the bypass kicked in.
    const vmMap = await orch.resolveVms(defs);
    expect(vmMap.size).toBe(2);
    expect([...vmMap.values()].every((h) => h.id === "pre-started")).toBe(true);
    expect(angryBackend.listVMs).not.toHaveBeenCalled();
  });

  // ── executeSetup ────────────────────────────────────────────────

  it("executeSetup runs steps in order", async () => {
    const vmMap = new Map([["vm1", makeHandle("vm1")]]);
    const steps = [
      { action: "wait", duration_ms: 10 },
      { action: "wait", duration_ms: 10 },
    ];

    const results = await orchestrator.executeSetup(steps, vmMap);

    expect(results).toHaveLength(2);
    expect(results[0].status).toBe("success");
    expect(results[1].status).toBe("success");
    // Second step should finish after first
    expect(results[1].duration_ms).toBeGreaterThanOrEqual(0);
  });

  it("executeSetup handles vm_run_command with timeout", async () => {
    const mockClient = makeMockClient();
    clients.set("vm1", mockClient);
    orchestrator = new ScenarioOrchestrator(backend, clients, config);

    const vmMap = new Map([["vm1", makeHandle("vm1")]]);
    const steps = [
      {
        action: "vm_run_command",
        vm: "vm1",
        command: "echo",
        args: ["hello"],
        timeout_ms: 5000,
      },
    ];

    const results = await orchestrator.executeSetup(steps, vmMap);

    expect(results).toHaveLength(1);
    expect(results[0].status).toBe("success");
    expect(mockClient.runCommand).toHaveBeenCalledWith("echo", ["hello"], { timeoutMs: 5000, runAs: undefined });
  });

  it("executeSetup handles vm_copy_file host_to_guest", async () => {
    const vmMap = new Map([["vm1", makeHandle("vm1")]]);
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "signalman-copy-"));
    const hostPath = path.join(tmpDir, "file.txt");
    fs.writeFileSync(hostPath, "payload");
    const steps = [
      {
        action: "vm_copy_file",
        vm: "vm1",
        direction: "host_to_guest",
        host_path: hostPath,
        guest_path: "C:\\remote\\file.txt",
      },
    ];

    const results = await orchestrator.executeSetup(steps, vmMap);

    expect(results[0].status).toBe("success");
    expect(clients.get("vm1")?.writeFile).toHaveBeenCalledWith(
      "C:\\remote\\file.txt",
      Buffer.from("payload"),
      false,
    );
    expect(backend.copyFileToVM).not.toHaveBeenCalled();
  });

  it("executeSetup chunks vm_copy_file host_to_guest", async () => {
    const vmMap = new Map([["vm1", makeHandle("vm1")]]);
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "signalman-copy-"));
    const hostPath = path.join(tmpDir, "large.bin");
    const chunkBytes = 1024 * 1024;
    fs.writeFileSync(
      hostPath,
      Buffer.concat([Buffer.alloc(chunkBytes, 0x61), Buffer.from("tail")]),
    );
    const steps = [
      {
        action: "vm_copy_file",
        vm: "vm1",
        direction: "host_to_guest",
        host_path: hostPath,
        guest_path: "/tmp/large.bin",
      },
    ];

    const results = await orchestrator.executeSetup(steps, vmMap);

    expect(results[0].status).toBe("success");
    const writeFile = vi.mocked(clients.get("vm1")!.writeFile);
    expect(writeFile).toHaveBeenCalledTimes(2);
    expect(writeFile.mock.calls[0][0]).toBe("/tmp/large.bin");
    expect(writeFile.mock.calls[0][1]).toHaveLength(chunkBytes);
    expect(writeFile.mock.calls[0][2]).toBe(false);
    expect(writeFile.mock.calls[1][1]).toEqual(Buffer.from("tail"));
    expect(writeFile.mock.calls[1][2]).toBe(true);
  });

  it("executeSetup handles vm_copy_file guest_to_host", async () => {
    const vmMap = new Map([["vm1", makeHandle("vm1")]]);
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "signalman-copy-"));
    const hostPath = path.join(tmpDir, "file.txt");
    const steps = [
      {
        action: "vm_copy_file",
        vm: "vm1",
        direction: "guest_to_host",
        host_path: hostPath,
        guest_path: "C:\\remote\\file.txt",
      },
    ];

    const results = await orchestrator.executeSetup(steps, vmMap);

    expect(results[0].status).toBe("success");
    expect(clients.get("vm1")?.readFileChunk).toHaveBeenCalledWith(
      "C:\\remote\\file.txt",
      { offset: 0, limit: 1024 * 1024 },
    );
    expect(fs.readFileSync(hostPath, "utf8")).toBe("from guest");
    expect(backend.copyFileFromVM).not.toHaveBeenCalled();
  });

  it("executeSetup chunks vm_copy_file guest_to_host", async () => {
    const chunkBytes = 1024 * 1024;
    const chunk = Buffer.alloc(chunkBytes, 0x62);
    const tail = Buffer.from("done");
    const mockClient = makeMockClient({
      readFileChunk: vi.fn().mockImplementation(async (_guestPath: string, options?: { offset?: number }) => {
        return options?.offset === 0
          ? { data: chunk, truncated: true }
          : { data: tail, truncated: false };
      }),
    });
    clients.set("vm1", mockClient);
    orchestrator = new ScenarioOrchestrator(backend, clients, config);
    const vmMap = new Map([["vm1", makeHandle("vm1")]]);
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "signalman-copy-"));
    const hostPath = path.join(tmpDir, "large.bin");
    const steps = [
      {
        action: "vm_copy_file",
        vm: "vm1",
        direction: "guest_to_host",
        host_path: hostPath,
        guest_path: "/tmp/large.bin",
      },
    ];

    const results = await orchestrator.executeSetup(steps, vmMap);

    expect(results[0].status).toBe("success");
    expect(mockClient.readFileChunk).toHaveBeenCalledTimes(2);
    expect(mockClient.readFileChunk).toHaveBeenNthCalledWith(
      1,
      "/tmp/large.bin",
      { offset: 0, limit: chunkBytes },
    );
    expect(mockClient.readFileChunk).toHaveBeenNthCalledWith(
      2,
      "/tmp/large.bin",
      { offset: chunkBytes, limit: chunkBytes },
    );
    const saved = fs.readFileSync(hostPath);
    expect(saved).toHaveLength(chunkBytes + tail.length);
    expect(saved[0]).toBe(0x62);
    expect(saved[chunkBytes - 1]).toBe(0x62);
    expect(saved.subarray(chunkBytes)).toEqual(tail);
  });

  it("executeSetup handles wait action", async () => {
    const vmMap = new Map<string, VMHandle>();
    const steps = [{ action: "wait", duration_ms: 50 }];

    const startTime = Date.now();
    const results = await orchestrator.executeSetup(steps, vmMap);
    const elapsed = Date.now() - startTime;

    expect(results[0].status).toBe("success");
    expect(results[0].action).toBe("wait");
    expect(elapsed).toBeGreaterThanOrEqual(40); // Allow some timing slack
  });

  it("executeSetup handles vm_install", async () => {
    const mockClient = makeMockClient();
    clients.set("vm1", mockClient);
    orchestrator = new ScenarioOrchestrator(backend, clients, config);

    const vmMap = new Map([["vm1", makeHandle("vm1")]]);
    const steps = [
      {
        action: "vm_install",
        vm: "vm1",
        package_id: "Mozilla.Firefox",
        source: "winget",
      },
    ];

    const results = await orchestrator.executeSetup(steps, vmMap);

    expect(results[0].status).toBe("success");
    expect(mockClient.installSoftware).toHaveBeenCalledWith(
      "Mozilla.Firefox",
      "winget",
      undefined,
      undefined,
    );
  });

  it("executeSetup handles vm_checkpoint", async () => {
    const vmMap = new Map([["vm1", makeHandle("vm1")]]);
    const steps = [{ action: "vm_checkpoint", vm: "vm1", label: "post-setup" }];

    const results = await orchestrator.executeSetup(steps, vmMap);

    expect(results[0].status).toBe("success");
    expect(backend.createCheckpoint).toHaveBeenCalledWith(
      expect.objectContaining({ name: "vm1" }),
      "post-setup",
    );
  });

  it("executeSetup handles vm_restore", async () => {
    const vmMap = new Map([["vm1", makeHandle("vm1")]]);
    const steps = [{ action: "vm_restore", vm: "vm1", checkpoint: "clean" }];

    const results = await orchestrator.executeSetup(steps, vmMap);

    expect(results[0].status).toBe("success");
    expect(backend.restoreCheckpoint).toHaveBeenCalledWith(
      expect.objectContaining({ label: "clean" }),
    );
  });

  it("executeSetup captures error on failure", async () => {
    const failingClient = makeMockClient({
      runCommand: vi.fn().mockRejectedValue(new Error("command timed out")),
    });
    clients.set("vm1", failingClient);
    orchestrator = new ScenarioOrchestrator(backend, clients, config);

    const vmMap = new Map([["vm1", makeHandle("vm1")]]);
    const steps = [{ action: "vm_run_command", vm: "vm1", command: "hang" }];

    const results = await orchestrator.executeSetup(steps, vmMap);

    expect(results[0].status).toBe("failed");
    expect(results[0].error).toContain("command timed out");
  });

  it("executeSetup skips unknown actions", async () => {
    const vmMap = new Map<string, VMHandle>();
    const steps = [{ action: "vm_unknown_action", vm: "vm1" }];

    const results = await orchestrator.executeSetup(steps, vmMap);

    expect(results[0].status).toBe("skipped");
    expect(results[0].error).toContain("Unknown action");
  });

  // ── executeTeardown ─────────────────────────────────────────────

  it("executeTeardown runs on failure without throwing", async () => {
    const failingBackend = makeMockBackend({
      restoreCheckpoint: vi
        .fn()
        .mockRejectedValue(new Error("restore failed")),
    });
    orchestrator = new ScenarioOrchestrator(failingBackend, clients, config);

    const vmMap = new Map([["vm1", makeHandle("vm1")]]);
    const steps = [{ action: "vm_restore", vm: "vm1", checkpoint: "clean" }];

    const results = await orchestrator.executeTeardown(steps, vmMap);

    expect(results[0].status).toBe("failed");
    expect(results[0].error).toContain("restore failed");
  });

  // ── ScenarioResult status ───────────────────────────────────────

  it("produces passed status when all steps succeed (via executeSetup)", async () => {
    const vmMap = new Map([["vm1", makeHandle("vm1")]]);
    const steps = [
      { action: "wait", duration_ms: 1 },
      { action: "wait", duration_ms: 1 },
    ];

    const results = await orchestrator.executeSetup(steps, vmMap);

    const allSuccess = results.every((r) => r.status === "success");
    expect(allSuccess).toBe(true);
  });

  it("produces failed status when a step fails", async () => {
    const failingClient = makeMockClient({
      runCommand: vi.fn().mockRejectedValue(new Error("boom")),
    });
    clients.set("vm1", failingClient);
    orchestrator = new ScenarioOrchestrator(backend, clients, config);

    const vmMap = new Map([["vm1", makeHandle("vm1")]]);
    const steps = [{ action: "vm_run_command", vm: "vm1", command: "fail" }];

    const results = await orchestrator.executeSetup(steps, vmMap);

    expect(results.some((r) => r.status === "failed")).toBe(true);
  });

  it("runScenario executes teardown after guest readiness failure", async () => {
    const localBackend = makeMockBackend({
      listVMs: vi.fn().mockResolvedValue([makeHandle("endpoint-1")]),
    });
    const emptyClients = new Map<string, GuestAgentClient>();
    orchestrator = new ScenarioOrchestrator(localBackend, emptyClients, config);
    const scenarioDir = path.resolve(
      "..",
      ".signalman",
      "scenarios",
      "cursor-restrict",
    );

    const result = await orchestrator.runScenario(scenarioDir);

    expect(result.status).toBe("error");
    expect(result.error).toContain("No guest client configured for VM 'endpoint-1'");
    expect(result.teardown_results).toEqual([
      expect.objectContaining({
        action: "vm_restore",
        vm: "endpoint-1",
        status: "success",
      }),
    ]);
    expect(localBackend.restoreCheckpoint).toHaveBeenCalledTimes(2);
  });

  // ── waitForGuestAgents ──────────────────────────────────────────

  it("waitForGuestAgents retries on connection failure", async () => {
    let attempts = 0;
    const retryClient = makeMockClient({
      isConnected: vi.fn().mockImplementation(async () => {
        attempts++;
        if (attempts < 3) return false;
        return true;
      }),
    });
    clients.set("vm1", retryClient);
    orchestrator = new ScenarioOrchestrator(backend, clients, config);

    const vmMap = new Map([["vm1", makeHandle("vm1")]]);
    const defs: VmDefinition[] = [
      { name: "vm1", template: "t", guest_agent_port: 50051 },
    ];

    // Should not throw because it eventually connects
    await orchestrator.waitForGuestAgents(vmMap, defs);

    expect(attempts).toBeGreaterThanOrEqual(3);
  });

  it("waitForGuestAgents waits for all VMs in parallel", async () => {
    let resolveVm1!: (value: boolean) => void;
    let resolveVm2!: (value: boolean) => void;
    const vm1Connected = vi.fn(
      () => new Promise<boolean>((resolve) => { resolveVm1 = resolve; }),
    );
    const vm2Connected = vi.fn(
      () => new Promise<boolean>((resolve) => { resolveVm2 = resolve; }),
    );
    clients.set("vm1", makeMockClient({ isConnected: vm1Connected }));
    clients.set("vm2", makeMockClient({ isConnected: vm2Connected }));
    orchestrator = new ScenarioOrchestrator(backend, clients, config);

    const vmMap = new Map([
      ["vm1", makeHandle("vm1")],
      ["vm2", makeHandle("vm2")],
    ]);
    const defs: VmDefinition[] = [
      { name: "vm1", template: "t", guest_agent_port: 50051 },
      { name: "vm2", template: "t", guest_agent_port: 50052 },
    ];

    const wait = orchestrator.waitForGuestAgents(vmMap, defs);
    await Promise.resolve();

    expect(vm1Connected).toHaveBeenCalledTimes(1);
    expect(vm2Connected).toHaveBeenCalledTimes(1);

    resolveVm1(true);
    resolveVm2(true);
    await wait;
  });

  it("waitForGuestAgents throws when no client is configured", async () => {
    const emptyClients = new Map<string, GuestAgentClient>();
    orchestrator = new ScenarioOrchestrator(backend, emptyClients, config);

    const vmMap = new Map([["vm1", makeHandle("vm1")]]);
    const defs: VmDefinition[] = [
      { name: "vm1", template: "t", guest_agent_port: 50051 },
    ];

    await expect(
      orchestrator.waitForGuestAgents(vmMap, defs),
    ).rejects.toThrow("No guest client configured for VM 'vm1'");
  });

  it("waitForGuestAgents retries Tart IP discovery before creating a client", async () => {
    const emptyClients = new Map<string, GuestAgentClient>();
    const getVmIpAddress = vi
      .fn()
      .mockRejectedValueOnce(new Error("no DHCP lease yet"))
      .mockResolvedValue("192.168.64.8");
    const tartBackend = makeMockBackend({
      name: "tart",
      getVmIpAddress,
    });
    const isConnected = vi.fn().mockResolvedValue(true);
    guestAgentClientMockState.nextInstances.push({ isConnected });
    orchestrator = new ScenarioOrchestrator(
      tartBackend,
      emptyClients,
      {
        ...config,
        guestAgent: {
          defaultPort: 50051,
          authToken: "guest-secret",
          tls: { enabled: false },
        },
      },
    );

    const vmMap = new Map([["vm1", makeHandle("vm1")]]);
    const defs: VmDefinition[] = [
      { name: "vm1", template: "t", guest_agent_port: 50052 },
    ];

    await orchestrator.waitForGuestAgents(vmMap, defs);

    expect(getVmIpAddress).toHaveBeenCalledTimes(2);
    expect(guestAgentClientMockState.constructorArgs[0]).toEqual([
      "192.168.64.8",
      50052,
      undefined,
      { authToken: "guest-secret" },
    ]);
    expect(emptyClients.get("vm1")).toBeDefined();
    expect(isConnected).toHaveBeenCalled();
  });
});

describe("runtime references and capability gates", () => {
  it("resolves supplied params and environment secrets recursively", () => {
    process.env.SIGNALMAN_SECRET_API_KEY = "secret-value";
    try {
      const resolved = substituteRuntimeRefsDeep(
        {
          command: "tool",
          args: ["--endpoint", "${param:endpoint:-https://default.example}", "${secret:API_KEY}"],
        },
        { endpoint: "https://override.example" },
      ) as { args: string[] };

      expect(resolved.args).toEqual([
        "--endpoint",
        "https://override.example",
        "secret-value",
      ]);
    } finally {
      delete process.env.SIGNALMAN_SECRET_API_KEY;
    }
  });

  it("resolveVms provisions missing VM when provision_if_missing is true", async () => {
    const localBackend = makeMockBackend({
      listVMs: vi.fn().mockResolvedValue([]),
    });
    const localOrchestrator = new ScenarioOrchestrator(
      localBackend,
      new Map(),
      makeConfig(),
    );
    provisionMockState.nextHandle = {
      id: "id-auto-vm",
      name: "auto-vm",
      backend: "mock",
    };
    const defs: VmDefinition[] = [
      {
        name: "auto-vm",
        template: "win11-base",
        guest_agent_port: 50051,
        checkpoint_restore: "agent-installed",
        provision_if_missing: true,
      },
    ];

    const vmMap = await localOrchestrator.resolveVms(defs);

    expect(vmMap.get("auto-vm")?.id).toBe("id-auto-vm");
    expect(provisionMockState.calls).toHaveLength(1);
    expect(provisionMockState.calls[0][1]).toMatchObject({
      vmName: "auto-vm",
      templateName: "win11-base",
      checkpointLabel: "agent-installed",
    });
  });

  it("fails closed when a secret reference has no env value", () => {
    expect(() =>
      substituteRuntimeRefsDeep("${secret:MISSING_SIGNALMAN_TEST_SECRET}", {}),
    ).toThrow("secret-unresolved: MISSING_SIGNALMAN_TEST_SECRET");
  });

  it("rejects undeclared VM capabilities before execution", () => {
    expect(() =>
      assertScenarioCapabilities(
        {
          name: "cap-test",
          version: "1.0",
          tags: [],
          capabilities: { vms: ["vm1"] },
          vms: [
            { name: "vm1", template: "win11", guest_agent_port: 50051 },
            { name: "vm2", template: "win11", guest_agent_port: 50051 },
          ],
          setup: [],
          teardown: [],
          checkpoints: {},
        },
        "",
      ),
    ).toThrow("capability-denied");
  });

  it("allows declared host path glob capabilities", () => {
    expect(() =>
      assertScenarioCapabilities(
        {
          name: "cap-test",
          version: "1.0",
          tags: [],
          capabilities: {
            vms: ["vm1"],
            host_paths: { read: ["C:\\safe\\**"], write: ["C:\\out\\**"] },
          },
          vms: [{ name: "vm1", template: "win11", guest_agent_port: 50051 }],
          setup: [
            {
              action: "vm_copy_file",
              vm: "vm1",
              direction: "host_to_guest",
              host_path: "C:\\safe\\payload.txt",
            },
            {
              action: "vm_copy_file",
              vm: "vm1",
              direction: "guest_to_host",
              host_path: "C:\\out\\result.txt",
            },
          ],
          teardown: [],
          checkpoints: {},
        },
        "",
      ),
    ).not.toThrow();
  });

  it("rejects host file access when capabilities omit host_paths", () => {
    expect(() =>
      assertScenarioCapabilities(
        {
          name: "cap-test",
          version: "1.0",
          tags: [],
          capabilities: { vms: ["vm1"] },
          vms: [{ name: "vm1", template: "win11", guest_agent_port: 50051 }],
          setup: [
            {
              action: "vm_copy_file",
              vm: "vm1",
              direction: "host_to_guest",
              host_path: "C:\\safe\\payload.txt",
            },
          ],
          teardown: [],
          checkpoints: {},
        },
        "",
      ),
    ).toThrow("capability-denied");
  });

  it("checks legacy vm_copy_file src aliases against host path capabilities", () => {
    expect(() =>
      assertScenarioCapabilities(
        {
          name: "cap-test",
          version: "1.0",
          tags: [],
          capabilities: {
            vms: ["vm1"],
            host_paths: { read: ["C:\\safe\\**"] },
          },
          vms: [{ name: "vm1", template: "win11", guest_agent_port: 50051 }],
          setup: [
            {
              action: "vm_copy_file",
              vm: "vm1",
              direction: "host_to_guest",
              src: "C:\\outside\\payload.txt",
              dest: "C:\\guest\\payload.txt",
            },
          ],
          teardown: [],
          checkpoints: {},
        },
        "",
      ),
    ).toThrow("capability-denied");
  });
});

// ── Template Tests ─────────────────────────────────────────────────

describe("loadTemplates", () => {
  it("returns default templates when no config path", () => {
    const templates = loadTemplates();

    expect(templates.size).toBeGreaterThanOrEqual(3);
    expect(templates.has("win11-base")).toBe(true);
    expect(templates.has("win10-base")).toBe(true);
    expect(templates.has("win11-dev")).toBe(true);
  });

  it("default templates have expected properties", () => {
    const templates = loadTemplates();
    const win11 = templates.get("win11-base")!;

    expect(win11.name).toBe("win11-base");
    expect(win11.generation).toBe(2);
    expect(win11.memoryMB).toBe(4096);
    expect(win11.processorCount).toBe(2);
    expect(win11.networkSwitch).toBe("Default Switch");
  });

  it("throws when config file not found", () => {
    expect(() => loadTemplates("/nonexistent/templates.yaml")).toThrow(
      "Template config file not found",
    );
  });
});

describe("resolveTemplate", () => {
  it("resolves known template", () => {
    const templates = loadTemplates();
    const tmpl = resolveTemplate("win11-base", templates);

    expect(tmpl.name).toBe("win11-base");
  });

  it("throws on unknown template", () => {
    const templates = loadTemplates();

    expect(() => resolveTemplate("nonexistent", templates)).toThrow(
      "Unknown template 'nonexistent'",
    );
  });

  it("error message lists available templates", () => {
    const templates = loadTemplates();

    try {
      resolveTemplate("bad", templates);
      expect.fail("should have thrown");
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain("win11-base");
      expect(msg).toContain("win10-base");
    }
  });
});
