import { describe, it, expect, vi, beforeEach } from "vitest";
import { ScenarioOrchestrator } from "../scenarios/orchestrator.js";
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
      restrictionMode: "none",
      hasAppcontainerToken: false,
      appcontainerSid: "",
      isLowIntegrity: false,
      isInJob: false,
      jobName: "",
      hasFirewallRules: false,
      blockedDomains: [],
      hasRestrictDll: false,
      restrictDllPath: "",
      verdict: "unrestricted",
      issues: [],
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
    const steps = [
      {
        action: "vm_copy_file",
        vm: "vm1",
        direction: "host_to_guest",
        host_path: "C:\\local\\file.txt",
        guest_path: "C:\\remote\\file.txt",
      },
    ];

    const results = await orchestrator.executeSetup(steps, vmMap);

    expect(results[0].status).toBe("success");
    expect(backend.copyFileToVM).toHaveBeenCalledWith(
      expect.objectContaining({ name: "vm1" }),
      "C:\\local\\file.txt",
      "C:\\remote\\file.txt",
    );
  });

  it("executeSetup handles vm_copy_file guest_to_host", async () => {
    const vmMap = new Map([["vm1", makeHandle("vm1")]]);
    const steps = [
      {
        action: "vm_copy_file",
        vm: "vm1",
        direction: "guest_to_host",
        host_path: "C:\\local\\file.txt",
        guest_path: "C:\\remote\\file.txt",
      },
    ];

    const results = await orchestrator.executeSetup(steps, vmMap);

    expect(results[0].status).toBe("success");
    expect(backend.copyFileFromVM).toHaveBeenCalledWith(
      expect.objectContaining({ name: "vm1" }),
      "C:\\remote\\file.txt",
      "C:\\local\\file.txt",
    );
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
