/**
 * v0.3.0-2 — orchestrator ephemeral-VM integration tests.
 *
 * Exercises `resolveVms`'s ephemeral branch (the new code path
 * landed in this sub-task). The pure ephemeral pipeline + teardown
 * are tested in `ephemeral-vm.test.ts` against direct calls; this
 * file pins the orchestrator's wiring:
 *
 *   - Forwards scenarioSlug / runId / records collector correctly.
 *   - Refuses to provision when the backend isn't Hyper-V.
 *   - Refuses when no records collector was supplied (would leak
 *     resources).
 *   - Starts the freshly-provisioned VM via `backend.startVM`.
 *   - Skips checkpoint_restore for ephemeral VMs (no checkpoint
 *     exists yet).
 *
 * vi.mock replaces the ephemeral-vm module with controlled fakes so
 * we never invoke real PowerShell / Hyper-V.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

// vi.mock must be hoisted; declare BEFORE the module imports.
vi.mock("../provisioning/ephemeral-vm.js", () => ({
  provisionEphemeralVm: vi.fn(),
  teardownEphemeralVm: vi.fn(),
}));
vi.mock("../hypervisors/hyperv.js", () => ({
  // Stub psExec — only resolveVms imports this from the module.
  hyperVPsExec: vi.fn().mockResolvedValue(""),
}));

import {
  ScenarioOrchestrator,
  type VmDefinition,
} from "../scenarios/orchestrator.js";
import {
  provisionEphemeralVm,
  teardownEphemeralVm,
  type EphemeralVmRecord,
} from "../provisioning/ephemeral-vm.js";
import type {
  HypervisorBackend,
  VMHandle,
  VMStatus,
} from "../hypervisors/interface.js";

// ── Fixture helpers ───────────────────────────────────────────────

function makeEphemeralRecord(name = "smoke-endpoint-1-abc12345"): EphemeralVmRecord {
  return {
    vmHandle: { id: `id-${name}`, name, backend: "hyperv" },
    ephemeralName: name,
    childVhdxPath: `C:\\disks\\${name}.vhdx`,
    parentVhdxPath: "C:\\templates\\win11-base.vhdx",
    vmLineageHash: "0".repeat(64),
    templateName: "win11-base",
  };
}

function makeMockHyperVBackend(): HypervisorBackend & {
  startVMMock: ReturnType<typeof vi.fn>;
  getStatusMock: ReturnType<typeof vi.fn>;
} {
  const startVMMock = vi.fn(async () => undefined);
  const getStatusMock = vi.fn(
    async (handle: VMHandle): Promise<VMStatus> => ({
      handle,
      state: "running",
      guestAgentReachable: true,
    }),
  );
  return {
    name: "hyperv",
    listVMs: vi.fn(async () => []),
    createVM: vi.fn(),
    startVM: startVMMock,
    stopVM: vi.fn(),
    pauseVM: vi.fn(),
    resumeVM: vi.fn(),
    deleteVM: vi.fn(),
    getStatus: getStatusMock,
    createCheckpoint: vi.fn(),
    restoreCheckpoint: vi.fn(),
    deleteCheckpoint: vi.fn(),
    listCheckpoints: vi.fn(),
    copyFileToVM: vi.fn(),
    copyFileFromVM: vi.fn(),
    executeCommand: vi.fn(),
    startVMMock,
    getStatusMock,
  } as unknown as HypervisorBackend & {
    startVMMock: ReturnType<typeof vi.fn>;
    getStatusMock: ReturnType<typeof vi.fn>;
  };
}

function makeMockTartBackend(): HypervisorBackend {
  const base = makeMockHyperVBackend();
  return { ...base, name: "tart" } as HypervisorBackend;
}

function makeOrchestrator(backend: HypervisorBackend): ScenarioOrchestrator {
  return new ScenarioOrchestrator(backend, new Map(), {
    backends: ["hyperv"],
  });
}

// ── Tests ─────────────────────────────────────────────────────────

beforeEach(() => {
  vi.mocked(provisionEphemeralVm).mockReset();
  vi.mocked(teardownEphemeralVm).mockReset();
});

describe("resolveVms — ephemeral branch", () => {
  it("provisions an ephemeral VM and registers it in vmMap", async () => {
    const backend = makeMockHyperVBackend();
    const orch = makeOrchestrator(backend);
    const record = makeEphemeralRecord("smoke-endpoint-1-abc12345");
    vi.mocked(provisionEphemeralVm).mockResolvedValueOnce(record);

    const records: EphemeralVmRecord[] = [];
    const defs: VmDefinition[] = [
      {
        name: "endpoint-1",
        template: "win11-base",
        guest_agent_port: 50051,
        ephemeral: true,
      },
    ];

    const vmMap = await orch.resolveVms(defs, {
      scenarioSlug: "smoke",
      runId: "abc12345-deadbeef",
      ephemeralRecords: records,
    });

    expect(provisionEphemeralVm).toHaveBeenCalledTimes(1);
    const config = vi.mocked(provisionEphemeralVm).mock.calls[0][1];
    expect(config.scenarioSlug).toBe("smoke");
    expect(config.vmName).toBe("endpoint-1");
    expect(config.runId).toBe("abc12345-deadbeef");
    expect(config.templateName).toBe("win11-base");

    expect(records).toHaveLength(1);
    expect(records[0]).toBe(record);

    expect(vmMap.get("endpoint-1")).toBe(record.vmHandle);
  });

  it("starts the ephemeral VM if not already running", async () => {
    const backend = makeMockHyperVBackend();
    const record = makeEphemeralRecord();
    vi.mocked(provisionEphemeralVm).mockResolvedValueOnce(record);
    // VM is in stopped state initially, then running after startVM.
    backend.getStatusMock
      .mockResolvedValueOnce({
        handle: record.vmHandle,
        state: "stopped",
        guestAgentReachable: false,
      })
      .mockResolvedValueOnce({
        handle: record.vmHandle,
        state: "running",
        guestAgentReachable: true,
      });

    const orch = makeOrchestrator(backend);
    await orch.resolveVms(
      [
        {
          name: "endpoint-1",
          template: "win11-base",
          guest_agent_port: 50051,
          ephemeral: true,
        },
      ],
      { ephemeralRecords: [] },
    );

    expect(backend.startVMMock).toHaveBeenCalledTimes(1);
    expect(backend.startVMMock).toHaveBeenCalledWith(record.vmHandle);
  });

  it("does NOT call startVM when the ephemeral VM is already running", async () => {
    const backend = makeMockHyperVBackend();
    const record = makeEphemeralRecord();
    vi.mocked(provisionEphemeralVm).mockResolvedValueOnce(record);
    backend.getStatusMock.mockResolvedValue({
      handle: record.vmHandle,
      state: "running",
      guestAgentReachable: true,
    });

    const orch = makeOrchestrator(backend);
    await orch.resolveVms(
      [
        {
          name: "endpoint-1",
          template: "win11-base",
          guest_agent_port: 50051,
          ephemeral: true,
        },
      ],
      { ephemeralRecords: [] },
    );

    expect(backend.startVMMock).not.toHaveBeenCalled();
  });

  it("does NOT call restoreCheckpoint for ephemeral VMs even if checkpoint_restore is declared", async () => {
    const backend = makeMockHyperVBackend();
    const record = makeEphemeralRecord();
    vi.mocked(provisionEphemeralVm).mockResolvedValueOnce(record);

    const orch = makeOrchestrator(backend);
    await orch.resolveVms(
      [
        {
          name: "endpoint-1",
          template: "win11-base",
          checkpoint_restore: "should-be-ignored",
          guest_agent_port: 50051,
          ephemeral: true,
        },
      ],
      { ephemeralRecords: [] },
    );

    expect(backend.restoreCheckpoint).not.toHaveBeenCalled();
  });
});

describe("resolveVms — ephemeral validation", () => {
  it("throws when the backend is not Hyper-V", async () => {
    const backend = makeMockTartBackend();
    const orch = makeOrchestrator(backend);

    await expect(
      orch.resolveVms(
        [
          {
            name: "endpoint-1",
            template: "win11-base",
            guest_agent_port: 50051,
            ephemeral: true,
          },
        ],
        { ephemeralRecords: [] },
      ),
    ).rejects.toThrow(/ephemeral.*Hyper-V-only|backend is 'tart'/);

    expect(provisionEphemeralVm).not.toHaveBeenCalled();
  });

  it("throws when no ephemeralRecords collector is supplied", async () => {
    const backend = makeMockHyperVBackend();
    const orch = makeOrchestrator(backend);

    await expect(
      orch.resolveVms(
        [
          {
            name: "endpoint-1",
            template: "win11-base",
            guest_agent_port: 50051,
            ephemeral: true,
          },
        ],
        // No ephemeralRecords!
      ),
    ).rejects.toThrow(/ephemeralRecords output collector/);

    expect(provisionEphemeralVm).not.toHaveBeenCalled();
  });
});

describe("resolveVms — mixed ephemeral + legacy VMs", () => {
  it("provisions an ephemeral VM and looks up a legacy VM in the same scenario", async () => {
    const backend = makeMockHyperVBackend();
    const ephemeralRecord = makeEphemeralRecord("smoke-fresh-vm-abc12345");
    vi.mocked(provisionEphemeralVm).mockResolvedValueOnce(ephemeralRecord);

    // Legacy VM exists in the backend's listVMs response.
    const legacyHandle: VMHandle = {
      id: "legacy-id",
      name: "endpoint-legacy",
      backend: "hyperv",
    };
    backend.listVMs = vi.fn(async () => [legacyHandle]);
    backend.getStatusMock.mockResolvedValue({
      handle: ephemeralRecord.vmHandle,
      state: "running",
      guestAgentReachable: true,
    });

    const orch = makeOrchestrator(backend);
    const records: EphemeralVmRecord[] = [];
    const vmMap = await orch.resolveVms(
      [
        {
          name: "fresh-vm",
          template: "win11-base",
          guest_agent_port: 50051,
          ephemeral: true,
        },
        {
          name: "endpoint-legacy",
          template: "ignored",
          guest_agent_port: 50052,
        },
      ],
      {
        scenarioSlug: "smoke",
        runId: "abc12345",
        ephemeralRecords: records,
      },
    );

    expect(records).toHaveLength(1);
    expect(records[0]).toBe(ephemeralRecord);
    expect(vmMap.get("fresh-vm")).toBe(ephemeralRecord.vmHandle);
    expect(vmMap.get("endpoint-legacy")).toBe(legacyHandle);
  });
});
