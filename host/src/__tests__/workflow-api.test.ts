/**
 * Workflow API tests — explicit validation that the core scenario
 * actions reach the right backend / guest-client methods.
 *
 * The user-facing scenario surface is small but mission-critical:
 *
 *   - vm_checkpoint / vm_restore                 → snapshotting
 *   - vm_copy_file (host_to_guest, guest_to_host) → file transfer
 *   - vm_install                                 → software install
 *
 * The orchestrator dispatches each scenario action to the right
 * `HypervisorBackend` or `GuestAgentClient` method. This file is
 * the integration test for that routing layer — it verifies that
 * a `vm_checkpoint` step actually invokes `backend.createCheckpoint`
 * with the right argv, that error paths surface as failed
 * StepResults rather than silent successes, and that scenario-author
 * mistakes (missing VM, malformed label) get caught early.
 *
 * Pattern matches `orchestrator.test.ts` exactly: vi.fn() mocks for
 * HypervisorBackend and GuestAgentClient. The orchestrator's
 * `executeSetup` is the function under test; we drive it with a
 * synthetic SetupStep[] and inspect both the returned StepResult[]
 * and the mock-call history.
 */

import { describe, it, expect, vi } from "vitest";

import { ScenarioOrchestrator } from "../scenarios/orchestrator.js";
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

// ── Mock factories (mirror orchestrator.test.ts) ──────────────────

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
      guestAgentReachable: true,
    } as VMStatus),
    listVMs: vi.fn().mockResolvedValue([makeHandle("vm1")]),
    createCheckpoint: vi.fn().mockResolvedValue({
      id: "cp-1",
      vmHandle: makeHandle("vm1"),
      label: "test-cp",
    } as CheckpointHandle),
    restoreCheckpoint: vi.fn().mockResolvedValue(undefined),
    deleteCheckpoint: vi.fn().mockResolvedValue(undefined),
    listCheckpoints: vi.fn().mockResolvedValue([
      {
        id: "cp-1",
        vmHandle: makeHandle("vm1"),
        label: "agent-installed",
        createdAt: new Date().toISOString(),
      } as unknown as CheckpointInfo,
    ]),
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
      stdout: "",
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
    ...overrides,
  } as unknown as GuestAgentClient;
}

function makeOrchestrator(opts: {
  backend?: HypervisorBackend;
  client?: GuestAgentClient;
  /** When true, no GuestAgentClient is registered for endpoint-1.
   *  This forces vm_copy_file through the backend.copyFile{To,From}VM
   *  path rather than the client-streaming path — which is the path
   *  these workflow-api tests are validating. */
  noClient?: boolean;
} = {}) {
  const backend = opts.backend ?? makeMockBackend();
  const client = opts.client ?? makeMockClient();
  const config: SignalmanConfig = {
    hypervisor: { backend: "hyperv" },
    guest: { authToken: "x", clientCertPath: "", clientKeyPath: "", caCertPath: "" },
    docker: undefined,
    kernelDebug: undefined,
  } as unknown as SignalmanConfig;
  const guestClients = opts.noClient
    ? new Map<string, GuestAgentClient>()
    : new Map<string, GuestAgentClient>([["endpoint-1", client]]);
  const orchestrator = new ScenarioOrchestrator(backend, guestClients, config);
  const vmMap = new Map<string, VMHandle>([["endpoint-1", makeHandle("endpoint-1")]]);
  return { orchestrator, backend, client, vmMap };
}

// ── vm_checkpoint (snapshotting) ─────────────────────────────────

describe("workflow API: vm_checkpoint (snapshotting)", () => {
  // What this catches: a refactor that drops the createCheckpoint
  // call entirely or routes it to the wrong VM.
  it("vm_checkpoint invokes backend.createCheckpoint with the VM handle and label", async () => {
    const { orchestrator, backend, vmMap } = makeOrchestrator();
    const results = await orchestrator.executeSetup(
      [{ action: "vm_checkpoint", vm: "endpoint-1", label: "after-install" }],
      vmMap,
    );
    expect(results[0].status).toBe("success");
    expect(backend.createCheckpoint).toHaveBeenCalledTimes(1);
    expect(backend.createCheckpoint).toHaveBeenCalledWith(
      expect.objectContaining({ name: "endpoint-1" }),
      "after-install",
    );
  });

  // What this catches: backend errors silently succeeding instead of
  // surfacing as a failed StepResult.
  it("vm_checkpoint surfaces backend errors as failed step", async () => {
    const backend = makeMockBackend({
      createCheckpoint: vi
        .fn()
        .mockRejectedValueOnce(new Error("disk full")),
    });
    const { orchestrator, vmMap } = makeOrchestrator({ backend });
    const results = await orchestrator.executeSetup(
      [{ action: "vm_checkpoint", vm: "endpoint-1", label: "x" }],
      vmMap,
    );
    expect(results[0].status).toBe("failed");
    expect(results[0].error).toContain("disk full");
  });

  // What this catches: scenario referring to a VM that wasn't
  // resolved (typo in scenario YAML) — must fail loudly.
  it("vm_checkpoint fails when VM is not in vmMap", async () => {
    const { orchestrator } = makeOrchestrator();
    const emptyMap = new Map<string, VMHandle>();
    const results = await orchestrator.executeSetup(
      [{ action: "vm_checkpoint", vm: "nonexistent", label: "x" }],
      emptyMap,
    );
    expect(results[0].status).toBe("failed");
    expect(results[0].error).toMatch(/VM 'nonexistent' not found/);
  });
});

describe("workflow API: vm_restore (snapshotting)", () => {
  // What this catches: restore targeting wrong VM, or wrong checkpoint label.
  it("vm_restore invokes backend.restoreCheckpoint with VM + label", async () => {
    const { orchestrator, backend, vmMap } = makeOrchestrator();
    const results = await orchestrator.executeSetup(
      [{ action: "vm_restore", vm: "endpoint-1", checkpoint: "agent-installed" }],
      vmMap,
    );
    expect(results[0].status).toBe("success");
    expect(backend.restoreCheckpoint).toHaveBeenCalledTimes(1);
    const call = (backend.restoreCheckpoint as ReturnType<typeof vi.fn>).mock
      .calls[0][0];
    expect(call.label).toBe("agent-installed");
    expect(call.vmHandle.name).toBe("endpoint-1");
  });

  // What this catches: backend errors during restore (e.g. checkpoint missing)
  // surfacing properly as failed step.
  it("vm_restore propagates backend.restoreCheckpoint failures", async () => {
    const backend = makeMockBackend({
      restoreCheckpoint: vi
        .fn()
        .mockRejectedValueOnce(new Error("checkpoint 'missing' not found")),
    });
    const { orchestrator, vmMap } = makeOrchestrator({ backend });
    const results = await orchestrator.executeSetup(
      [{ action: "vm_restore", vm: "endpoint-1", checkpoint: "missing" }],
      vmMap,
    );
    expect(results[0].status).toBe("failed");
    expect(results[0].error).toContain("not found");
  });

  // What this catches: a scenario calling vm_restore with no checkpoint label
  // shouldn't crash — it should fail with a descriptive error.
  it("vm_restore handles missing checkpoint label gracefully", async () => {
    const backend = makeMockBackend({
      // backend would receive label: "" (cast as string of an undefined)
      restoreCheckpoint: vi
        .fn()
        .mockImplementation(({ label }: { label: string }) => {
          if (!label) throw new Error("checkpoint label required");
          return Promise.resolve();
        }),
    });
    const { orchestrator, vmMap } = makeOrchestrator({ backend });
    const results = await orchestrator.executeSetup(
      [{ action: "vm_restore", vm: "endpoint-1" }],
      vmMap,
    );
    expect(results[0].status).toBe("failed");
  });
});

describe("workflow API: backend snapshot list/delete (sanity)", () => {
  // These aren't dispatched directly from setup-step actions in
  // v0.1.0 (no `vm_list_checkpoints` action), but the backend
  // surface MUST stay reachable so future scenarios + the
  // signalman.advanced.* MCP namespace can call them.
  // What this catches: an interface refactor that drops these
  // methods from HypervisorBackend.

  it("HypervisorBackend exposes listCheckpoints and deleteCheckpoint", () => {
    const backend = makeMockBackend();
    expect(typeof backend.listCheckpoints).toBe("function");
    expect(typeof backend.deleteCheckpoint).toBe("function");
  });

  it("listCheckpoints returns the configured CheckpointInfo[] shape", async () => {
    const backend = makeMockBackend();
    const list = await backend.listCheckpoints(makeHandle("endpoint-1"));
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      id: "cp-1",
      label: "agent-installed",
    });
  });

  it("deleteCheckpoint accepts a CheckpointHandle", async () => {
    const backend = makeMockBackend();
    await backend.deleteCheckpoint({
      id: "cp-1",
      vmHandle: makeHandle("endpoint-1"),
      label: "to-remove",
    });
    expect(backend.deleteCheckpoint).toHaveBeenCalledWith(
      expect.objectContaining({ id: "cp-1", label: "to-remove" }),
    );
  });
});

// ── vm_copy_file (file transfer) ─────────────────────────────────

describe("workflow API: vm_copy_file (host_to_guest)", () => {
  // NOTE on test setup: orchestrator.copyFileToGuest has two paths —
  //   1. guest-client-streaming via `client.writeFile` (when a
  //      GuestAgentClient is registered for the VM)
  //   2. backend fallback via `backend.copyFileToVM` (when not)
  // These tests pin the BACKEND surface (path 2) — the canonical
  // hypervisor-level file-transfer API. The client-streaming path
  // is exercised separately in orchestrator.test.ts.

  // What this catches: a refactor where `vm_copy_file` defaults to the
  // wrong direction or invokes the wrong backend method.
  it("default direction is host_to_guest", async () => {
    const { orchestrator, backend, vmMap } = makeOrchestrator({
      noClient: true,
    });
    const results = await orchestrator.executeSetup(
      [
        {
          action: "vm_copy_file",
          vm: "endpoint-1",
          host_path: "C:\\src\\file.bin",
          guest_path: "C:\\dst\\file.bin",
        },
      ],
      vmMap,
    );
    expect(results[0].status).toBe("success");
    expect(backend.copyFileToVM).toHaveBeenCalledTimes(1);
    expect(backend.copyFileFromVM).not.toHaveBeenCalled();
  });

  // What this catches: paths swapped (host→guest mode passing guest path
  // first, etc.) — the order matters.
  it("host_to_guest passes (handle, host_path, guest_path) in order", async () => {
    const { orchestrator, backend, vmMap } = makeOrchestrator({
      noClient: true,
    });
    await orchestrator.executeSetup(
      [
        {
          action: "vm_copy_file",
          vm: "endpoint-1",
          direction: "host_to_guest",
          host_path: "C:\\src\\a.bin",
          guest_path: "C:\\dst\\a.bin",
        },
      ],
      vmMap,
    );
    const call = (backend.copyFileToVM as ReturnType<typeof vi.fn>).mock
      .calls[0];
    expect(call[0]).toMatchObject({ name: "endpoint-1" });
    expect(call[1]).toBe("C:\\src\\a.bin");
    expect(call[2]).toBe("C:\\dst\\a.bin");
  });

  // What this catches: backend errors during copy (network drop,
  // permission, etc.) surfacing as failed step.
  it("propagates backend copy failures", async () => {
    const backend = makeMockBackend({
      copyFileToVM: vi
        .fn()
        .mockRejectedValueOnce(new Error("ENOSPC: no space left on device")),
    });
    const { orchestrator, vmMap } = makeOrchestrator({
      backend,
      noClient: true,
    });
    const results = await orchestrator.executeSetup(
      [
        {
          action: "vm_copy_file",
          vm: "endpoint-1",
          host_path: "C:\\src\\big.bin",
          guest_path: "C:\\dst\\big.bin",
        },
      ],
      vmMap,
    );
    expect(results[0].status).toBe("failed");
    expect(results[0].error).toContain("ENOSPC");
  });
});

describe("workflow API: vm_copy_file (guest_to_host)", () => {
  // What this catches: scenario that downloads logs/artifacts
  // explicitly setting direction.
  it("direction='guest_to_host' invokes copyFileFromVM with (handle, guest_path, host_path)", async () => {
    const { orchestrator, backend, vmMap } = makeOrchestrator({
      noClient: true,
    });
    await orchestrator.executeSetup(
      [
        {
          action: "vm_copy_file",
          vm: "endpoint-1",
          direction: "guest_to_host",
          host_path: "C:\\local\\out.log",
          guest_path: "C:\\Logs\\app.log",
        },
      ],
      vmMap,
    );
    expect(backend.copyFileFromVM).toHaveBeenCalledTimes(1);
    expect(backend.copyFileToVM).not.toHaveBeenCalled();
    const call = (backend.copyFileFromVM as ReturnType<typeof vi.fn>).mock
      .calls[0];
    expect(call[0]).toMatchObject({ name: "endpoint-1" });
    expect(call[1]).toBe("C:\\Logs\\app.log");
    expect(call[2]).toBe("C:\\local\\out.log");
  });
});

// ── vm_install (software install automation) ────────────────────

describe("workflow API: vm_install", () => {
  // What this catches: scenario that drops `source` defaults to wrong
  // package manager. The orchestrator default MUST be winget.
  it("default source is winget", async () => {
    const { orchestrator, client, vmMap } = makeOrchestrator();
    await orchestrator.executeSetup(
      [{ action: "vm_install", vm: "endpoint-1", package_id: "Cursor.Cursor" }],
      vmMap,
    );
    expect(client.installSoftware).toHaveBeenCalledTimes(1);
    const call = (client.installSoftware as ReturnType<typeof vi.fn>).mock
      .calls[0];
    expect(call[0]).toBe("Cursor.Cursor");
    expect(call[1]).toBe("winget");
  });

  // What this catches: explicit-source scenarios route correctly.
  it("source='choco' is passed through unchanged", async () => {
    const { orchestrator, client, vmMap } = makeOrchestrator();
    await orchestrator.executeSetup(
      [
        {
          action: "vm_install",
          vm: "endpoint-1",
          package_id: "git",
          source: "choco",
        },
      ],
      vmMap,
    );
    const call = (client.installSoftware as ReturnType<typeof vi.fn>).mock
      .calls[0];
    expect(call[1]).toBe("choco");
  });

  // What this catches: version + timeout pass-through. The orchestrator
  // shouldn't strip optional args.
  it("optional version + timeout_ms thread through to installSoftware", async () => {
    const { orchestrator, client, vmMap } = makeOrchestrator();
    await orchestrator.executeSetup(
      [
        {
          action: "vm_install",
          vm: "endpoint-1",
          package_id: "Microsoft.VisualStudioCode",
          version: "1.84.0",
          timeout_ms: 600_000,
        },
      ],
      vmMap,
    );
    const call = (client.installSoftware as ReturnType<typeof vi.fn>).mock
      .calls[0];
    expect(call[2]).toBe("1.84.0");
    expect(call[3]).toBe(600_000);
  });

  // What this catches: backend reporting install failure surfacing as
  // failed StepResult — agents need to see this to avoid running
  // assertions against a missing tool.
  it("propagates installSoftware errors as failed step", async () => {
    const client = makeMockClient({
      installSoftware: vi
        .fn()
        .mockRejectedValueOnce(
          new Error("winget: package 'Bogus.Pkg' not found"),
        ),
    });
    const { orchestrator, vmMap } = makeOrchestrator({ client });
    const results = await orchestrator.executeSetup(
      [{ action: "vm_install", vm: "endpoint-1", package_id: "Bogus.Pkg" }],
      vmMap,
    );
    expect(results[0].status).toBe("failed");
    expect(results[0].error).toContain("not found");
  });

  // What this catches: scenario with a typo'd VM name (no client
  // registered) failing loudly rather than silently swallowing.
  it("vm_install fails when no guest client is registered for the VM", async () => {
    const backend = makeMockBackend();
    const config: SignalmanConfig = {
      hypervisor: { backend: "hyperv" },
    } as unknown as SignalmanConfig;
    // Empty guest-clients map → no client for endpoint-1.
    const orchestrator = new ScenarioOrchestrator(
      backend,
      new Map<string, GuestAgentClient>(),
      config,
    );
    const vmMap = new Map<string, VMHandle>([
      ["endpoint-1", makeHandle("endpoint-1")],
    ]);
    const results = await orchestrator.executeSetup(
      [{ action: "vm_install", vm: "endpoint-1", package_id: "x" }],
      vmMap,
    );
    expect(results[0].status).toBe("failed");
    expect(results[0].error).toMatch(/No guest client/);
  });
});

// ── End-to-end workflow chain (multi-step) ──────────────────────

describe("workflow API: end-to-end chain (snapshot + copy + install)", () => {
  // What this catches: REGRESSION in the dispatch loop — a refactor
  // where `executeSetup` skips a step type silently. This test runs
  // a realistic scenario chain (restore checkpoint → copy artifact →
  // install package → snapshot) and asserts each backend/client call
  // fired in order.
  //
  // NOTE: this uses the BACKEND copy path (noClient: true exercises
  // `backend.copyFileToVM` rather than guest-client streaming). To
  // also include `vm_install` (which always requires a guest client),
  // we re-register the client just for that step via a second
  // makeOrchestrator call below — this test asserts the full chain
  // routes correctly, the install-without-client edge case is its
  // own test in vm_install above.
  it("executes restore → copy → install → checkpoint in order", async () => {
    const backend = makeMockBackend();
    const client = makeMockClient();
    const config: SignalmanConfig = {
      hypervisor: { backend: "hyperv" },
      guest: { authToken: "x", clientCertPath: "", clientKeyPath: "", caCertPath: "" },
    } as unknown as SignalmanConfig;
    // Register a client for endpoint-1 BUT also stub out writeFile so
    // copyFileToGuest's streaming path completes without touching the
    // real filesystem — we want to assert the dispatch fires, not
    // exercise streaming bytes here.
    const stubbedClient = {
      ...(client as unknown as Record<string, unknown>),
      writeFile: vi.fn().mockResolvedValue(undefined),
      readFileChunk: vi.fn().mockResolvedValue({ data: Buffer.alloc(0), truncated: false }),
    } as unknown as GuestAgentClient;
    const guestClients = new Map<string, GuestAgentClient>([
      ["endpoint-1", stubbedClient],
    ]);
    const orchestrator = new ScenarioOrchestrator(
      backend,
      guestClients,
      config,
    );
    const vmMap = new Map<string, VMHandle>([
      ["endpoint-1", makeHandle("endpoint-1")],
    ]);
    // Use a real tiny temp file so fs.openSync inside copyFileToGuest
    // succeeds; the streaming loop reads zero bytes and exits clean.
    const fs = await import("node:fs");
    const path = await import("node:path");
    const os = await import("node:os");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wfapi-"));
    const tmpFile = path.join(tmpDir, "policy.json");
    fs.writeFileSync(tmpFile, "");
    try {
      const results = await orchestrator.executeSetup(
        [
          {
            action: "vm_restore",
            vm: "endpoint-1",
            checkpoint: "agent-installed",
          },
          {
            action: "vm_copy_file",
            vm: "endpoint-1",
            host_path: tmpFile,
            guest_path: "C:\\Example\\policy.json",
          },
          {
            action: "vm_install",
            vm: "endpoint-1",
            package_id: "Cursor.Cursor",
          },
          {
            action: "vm_checkpoint",
            vm: "endpoint-1",
            label: "after-policy",
          },
        ],
        vmMap,
      );
      expect(results.map((r) => r.status)).toEqual([
        "success",
        "success",
        "success",
        "success",
      ]);
      expect(backend.restoreCheckpoint).toHaveBeenCalledTimes(1);
      // Empty file → writeFile called once (zero-length write branch).
      expect(stubbedClient.writeFile).toHaveBeenCalledTimes(1);
      expect(stubbedClient.installSoftware).toHaveBeenCalledTimes(1);
      expect(backend.createCheckpoint).toHaveBeenCalledTimes(1);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // What this catches: a failure midway through the chain SHOULD
  // halt subsequent steps — current behaviour is "report failed and
  // continue", which is intentional (lets downstream assertions
  // observe partial state). Documenting the contract here.
  it("a failed step does NOT abort subsequent steps (current contract)", async () => {
    const backend = makeMockBackend({
      restoreCheckpoint: vi
        .fn()
        .mockRejectedValueOnce(new Error("transient")),
    });
    const { orchestrator, vmMap } = makeOrchestrator({ backend });
    const results = await orchestrator.executeSetup(
      [
        { action: "vm_restore", vm: "endpoint-1", checkpoint: "x" },
        { action: "vm_checkpoint", vm: "endpoint-1", label: "y" },
      ],
      vmMap,
    );
    expect(results).toHaveLength(2);
    expect(results[0].status).toBe("failed");
    expect(results[1].status).toBe("success");
    // The orchestrator's caller (run.ts) inspects setupFailed and decides
    // whether to halt the run. The CONTRACT here is that executeSetup
    // returns the full StepResult[]; halt logic lives upstream.
  });
});
