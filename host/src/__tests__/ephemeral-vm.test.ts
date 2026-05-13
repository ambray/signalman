/**
 * v0.3.0-2 — ephemeral VM provisioning tests.
 *
 * Pure-helper tests + an orchestrated-path suite that exercises
 * provisionEphemeralVm/teardownEphemeralVm against a mock backend
 * and injected template-resolver / differencing-disk impls.
 *
 * Nothing real is touched: no PowerShell, no Hyper-V, no fs apart
 * from a fresh tmpdir per test where the ephemeral-disks-dir needs
 * to exist on disk for the existsSync gate.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  buildEphemeralName,
  computeEphemeralChildVhdxPath,
  defaultOsLabel,
  EPHEMERAL_NAME_MAX_LEN,
  EphemeralVmError,
  provisionEphemeralVm,
  sanitizeNameSegment,
  teardownEphemeralVm,
  RUN_ID_SHORT_LEN,
  type EphemeralVmConfig,
} from "../provisioning/ephemeral-vm.js";
import type {
  HypervisorBackend,
  VMConfig,
  VMHandle,
} from "../hypervisors/interface.js";
import type { VmTemplate } from "../scenarios/templates.js";

// ── Helpers ───────────────────────────────────────────────────────

function freshTmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "signalman-ephemeral-"));
}

function makeMockBackend(): HypervisorBackend & {
  createVMMock: ReturnType<typeof vi.fn>;
  stopVMMock: ReturnType<typeof vi.fn>;
  deleteVMMock: ReturnType<typeof vi.fn>;
} {
  const createVMMock = vi.fn(
    async (config: VMConfig): Promise<VMHandle> => ({
      id: `mock-${config.name}`,
      name: config.name,
      backend: "mock",
    }),
  );
  const stopVMMock = vi.fn(async () => undefined);
  const deleteVMMock = vi.fn(async () => undefined);

  return {
    name: "mock",
    createVM: createVMMock,
    stopVM: stopVMMock,
    deleteVM: deleteVMMock,
    startVM: vi.fn(),
    pauseVM: vi.fn(),
    resumeVM: vi.fn(),
    getStatus: vi.fn(),
    listVMs: vi.fn(),
    createCheckpoint: vi.fn(),
    restoreCheckpoint: vi.fn(),
    deleteCheckpoint: vi.fn(),
    listCheckpoints: vi.fn(),
    copyFileToVM: vi.fn(),
    copyFileFromVM: vi.fn(),
    executeCommand: vi.fn(),
    createVMMock,
    stopVMMock,
    deleteVMMock,
  } as unknown as HypervisorBackend & {
    createVMMock: ReturnType<typeof vi.fn>;
    stopVMMock: ReturnType<typeof vi.fn>;
    deleteVMMock: ReturnType<typeof vi.fn>;
  };
}

function makeTemplate(overrides: Partial<VmTemplate> = {}): VmTemplate {
  return {
    name: "win11-base",
    vhdxPath: "C:\\templates\\win11-base.vhdx",
    generation: 2,
    memoryMB: 4096,
    processorCount: 2,
    networkSwitch: "Default Switch",
    ...overrides,
  };
}

function makeConfig(
  ephemeralDisksDir: string,
  overrides: Partial<EphemeralVmConfig> = {},
): EphemeralVmConfig {
  return {
    scenarioSlug: "smoke",
    vmName: "endpoint-1",
    runId: "abc12345",
    templateName: "win11-base",
    ephemeralDisksDir,
    ...overrides,
  };
}

// ── Pure helpers ──────────────────────────────────────────────────

describe("sanitizeNameSegment", () => {
  it("lowercases the input", () => {
    expect(sanitizeNameSegment("WIN11")).toBe("win11");
  });

  it("replaces unsafe characters with hyphens", () => {
    expect(sanitizeNameSegment("a/b\\c:d?e")).toBe("a-b-c-d-e");
  });

  it("collapses runs of hyphens", () => {
    expect(sanitizeNameSegment("a---b")).toBe("a-b");
  });

  it("trims leading and trailing hyphens", () => {
    expect(sanitizeNameSegment("-abc-")).toBe("abc");
  });

  it("preserves underscores and digits", () => {
    expect(sanitizeNameSegment("foo_bar_42")).toBe("foo_bar_42");
  });
});

describe("buildEphemeralName", () => {
  it("composes <scenarioSlug>-<vmName>-<runIdShort>", () => {
    const name = buildEphemeralName({
      scenarioSlug: "smoke",
      vmName: "endpoint-1",
      runIdShort: "abc12345",
    });
    expect(name).toBe("smoke-endpoint-1-abc12345");
  });

  it("sanitises each segment before composing", () => {
    const name = buildEphemeralName({
      scenarioSlug: "Service:Backend:Smoke",
      vmName: "EP/1",
      runIdShort: "AB12",
    });
    expect(name).toBe("service-backend-smoke-ep-1-ab12");
  });

  it("truncates from the left when the full name exceeds the max", () => {
    const longSlug = "a".repeat(100);
    const name = buildEphemeralName({
      scenarioSlug: longSlug,
      vmName: "vm",
      runIdShort: "12345678",
    });
    expect(name.length).toBeLessThanOrEqual(EPHEMERAL_NAME_MAX_LEN);
    // The tail (vm + runId) MUST survive — that's the uniqueness anchor.
    expect(name).toContain("vm");
    expect(name.endsWith("12345678")).toBe(true);
  });

  it("never produces a name with leading hyphens after truncation", () => {
    const name = buildEphemeralName({
      scenarioSlug: "a".repeat(100),
      vmName: "vm",
      runIdShort: "12345678",
    });
    expect(name.startsWith("-")).toBe(false);
  });
});

describe("computeEphemeralChildVhdxPath", () => {
  it("joins disksDir + name + .vhdx extension", () => {
    const p = computeEphemeralChildVhdxPath(
      "C:\\disks",
      "smoke-endpoint-1-abc12345",
    );
    // path.join normalises separators per platform; on Windows we get \\
    expect(p).toMatch(/smoke-endpoint-1-abc12345\.vhdx$/);
    expect(p).toContain("disks");
  });
});

describe("defaultOsLabel", () => {
  it("maps win11 template names to windows-11", () => {
    expect(defaultOsLabel("win11-base")).toBe("windows-11");
    expect(defaultOsLabel("WINDOWS-11-eval")).toBe("windows-11");
  });

  it("maps win10 template names to windows-10", () => {
    expect(defaultOsLabel("win10-base")).toBe("windows-10");
    expect(defaultOsLabel("windows-10-server")).toBe("windows-10");
  });

  it("maps ubuntu template names to ubuntu", () => {
    expect(defaultOsLabel("ubuntu-22.04-base")).toBe("ubuntu");
  });

  it("falls through to unknown for unrecognised names", () => {
    expect(defaultOsLabel("custom-image")).toBe("unknown");
  });
});

// ── provisionEphemeralVm — happy path ─────────────────────────────

describe("provisionEphemeralVm — happy path", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = freshTmpdir();
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("returns a record with all expected fields populated", async () => {
    const backend = makeMockBackend();
    const template = makeTemplate();
    const diffDisk = vi.fn(async () => ({
      parentVhdxPath: template.vhdxPath!,
      childVhdxPath: "ignored",
    }));

    const record = await provisionEphemeralVm(
      backend,
      makeConfig(tmp),
      {
        resolveTemplate: async () => template,
        createDifferencingDisk: diffDisk,
      },
    );

    expect(record.vmHandle.name).toBe("smoke-endpoint-1-abc12345");
    expect(record.ephemeralName).toBe("smoke-endpoint-1-abc12345");
    expect(record.parentVhdxPath).toBe(template.vhdxPath);
    expect(record.childVhdxPath).toContain("smoke-endpoint-1-abc12345.vhdx");
    expect(record.templateName).toBe("win11-base");
    expect(record.vmLineageHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("calls backend.createVM with the child VHDX as the template", async () => {
    const backend = makeMockBackend();
    const template = makeTemplate();
    const diffDisk = vi.fn(async () => ({
      parentVhdxPath: template.vhdxPath!,
      childVhdxPath: "ignored",
    }));

    await provisionEphemeralVm(backend, makeConfig(tmp), {
      resolveTemplate: async () => template,
      createDifferencingDisk: diffDisk,
    });

    expect(backend.createVMMock).toHaveBeenCalledTimes(1);
    const config = backend.createVMMock.mock.calls[0][0] as VMConfig;
    expect(config.template).toContain("smoke-endpoint-1-abc12345.vhdx");
    expect(config.name).toBe("smoke-endpoint-1-abc12345");
    // Template defaults flow through
    expect(config.cpus).toBe(2);
    expect(config.memoryMB).toBe(4096);
    expect(config.network).toEqual({ switchName: "Default Switch" });
  });

  it("invokes the differencing-disk pipeline with parent=template VHDX", async () => {
    const backend = makeMockBackend();
    const template = makeTemplate();
    const diffDisk = vi.fn(async () => ({
      parentVhdxPath: template.vhdxPath!,
      childVhdxPath: "ignored",
    }));

    await provisionEphemeralVm(backend, makeConfig(tmp), {
      resolveTemplate: async () => template,
      createDifferencingDisk: diffDisk,
    });

    expect(diffDisk).toHaveBeenCalledTimes(1);
    const args = diffDisk.mock.calls[0][0];
    expect(args.parentVhdxPath).toBe(template.vhdxPath);
    expect(args.childVhdxPath).toContain("smoke-endpoint-1-abc12345.vhdx");
  });

  it("honors vmConfigOverrides for cpus, memory, and network", async () => {
    const backend = makeMockBackend();
    const template = makeTemplate();
    const diffDisk = vi.fn(async () => ({
      parentVhdxPath: template.vhdxPath!,
      childVhdxPath: "ignored",
    }));

    await provisionEphemeralVm(
      backend,
      makeConfig(tmp, {
        vmConfigOverrides: {
          cpus: 8,
          memoryMB: 16384,
          network: { switchName: "OverrideSwitch" },
        },
      }),
      { resolveTemplate: async () => template, createDifferencingDisk: diffDisk },
    );

    const config = backend.createVMMock.mock.calls[0][0] as VMConfig;
    expect(config.cpus).toBe(8);
    expect(config.memoryMB).toBe(16384);
    expect(config.network).toEqual({ switchName: "OverrideSwitch" });
  });

  it("generates a random runIdShort when config.runId is omitted", async () => {
    const backend = makeMockBackend();
    const template = makeTemplate();
    const diffDisk = vi.fn(async () => ({
      parentVhdxPath: template.vhdxPath!,
      childVhdxPath: "ignored",
    }));
    const randomBytes = vi.fn(() => Buffer.from("0123456789abcdef", "hex"));

    const record = await provisionEphemeralVm(
      backend,
      makeConfig(tmp, { runId: undefined }),
      {
        resolveTemplate: async () => template,
        createDifferencingDisk: diffDisk,
        randomBytes,
      },
    );

    expect(randomBytes).toHaveBeenCalled();
    // The runId-derived suffix is 8 hex chars from the random buffer.
    expect(record.ephemeralName.endsWith("01234567")).toBe(true);
  });

  it("uses templateVersion from base_image_sha256 when present", async () => {
    const backend = makeMockBackend();
    const template = makeTemplate({
      base_image_sha256:
        "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
    });
    const diffDisk = vi.fn(async () => ({
      parentVhdxPath: template.vhdxPath!,
      childVhdxPath: "ignored",
    }));

    const record = await provisionEphemeralVm(backend, makeConfig(tmp), {
      resolveTemplate: async () => template,
      createDifferencingDisk: diffDisk,
    });

    expect(record.templateVersion).toBe("abcdef0123456789");
  });

  it("computes a stable vm_lineage_hash incorporating template_name + os + installed", async () => {
    const backend = makeMockBackend();
    const template = makeTemplate();
    const diffDisk = vi.fn(async () => ({
      parentVhdxPath: template.vhdxPath!,
      childVhdxPath: "ignored",
    }));

    const r1 = await provisionEphemeralVm(
      backend,
      makeConfig(tmp, { installed: [{ name: "git", version: "2.40" }] }),
      { resolveTemplate: async () => template, createDifferencingDisk: diffDisk },
    );
    const r2 = await provisionEphemeralVm(
      backend,
      makeConfig(tmp, { installed: [{ name: "git", version: "2.41" }] }),
      { resolveTemplate: async () => template, createDifferencingDisk: diffDisk },
    );

    expect(r1.vmLineageHash).not.toBe(r2.vmLineageHash);
  });

  it("uses osLabel override when supplied", async () => {
    const backend = makeMockBackend();
    const template = makeTemplate();
    const diffDisk = vi.fn(async () => ({
      parentVhdxPath: template.vhdxPath!,
      childVhdxPath: "ignored",
    }));

    const r1 = await provisionEphemeralVm(
      backend,
      makeConfig(tmp, { osLabel: "windows-server-2022" }),
      { resolveTemplate: async () => template, createDifferencingDisk: diffDisk },
    );
    const r2 = await provisionEphemeralVm(backend, makeConfig(tmp), {
      resolveTemplate: async () => template,
      createDifferencingDisk: diffDisk,
    });
    // Different os labels → different hashes
    expect(r1.vmLineageHash).not.toBe(r2.vmLineageHash);
  });
});

// ── provisionEphemeralVm — error paths ────────────────────────────

describe("provisionEphemeralVm — error paths", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = freshTmpdir();
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("wraps template-resolver failure as template_resolve_failed", async () => {
    const backend = makeMockBackend();
    await expect(
      provisionEphemeralVm(backend, makeConfig(tmp), {
        resolveTemplate: async () => {
          throw new Error("template registry empty");
        },
      }),
    ).rejects.toMatchObject({
      name: "EphemeralVmError",
      code: "template_resolve_failed",
    });
  });

  it("rejects when template has no vhdxPath with template_missing_vhdx", async () => {
    const backend = makeMockBackend();
    const template = makeTemplate({ vhdxPath: undefined });
    await expect(
      provisionEphemeralVm(backend, makeConfig(tmp), {
        resolveTemplate: async () => template,
      }),
    ).rejects.toMatchObject({
      name: "EphemeralVmError",
      code: "template_missing_vhdx",
    });
  });

  it("rejects when ephemeralDisksDir does not exist", async () => {
    const backend = makeMockBackend();
    const template = makeTemplate();
    await expect(
      provisionEphemeralVm(
        backend,
        makeConfig(path.join(tmp, "nonexistent")),
        { resolveTemplate: async () => template },
      ),
    ).rejects.toMatchObject({
      name: "EphemeralVmError",
      code: "ephemeral_disks_dir_missing",
    });
  });

  it("rolls back the child VHDX when createVM fails", async () => {
    const template = makeTemplate();
    const backend = makeMockBackend();
    backend.createVMMock.mockRejectedValueOnce(
      new Error("Hyper-V refused: out of memory"),
    );

    const unlinkSpy = vi.fn();
    const diffDisk = vi.fn(async () => ({
      parentVhdxPath: template.vhdxPath!,
      childVhdxPath: "ignored",
    }));

    await expect(
      provisionEphemeralVm(backend, makeConfig(tmp), {
        resolveTemplate: async () => template,
        createDifferencingDisk: diffDisk,
        unlinkChildDisk: unlinkSpy,
      }),
    ).rejects.toMatchObject({
      name: "EphemeralVmError",
      code: "create_vm_failed",
    });

    // Cleanup attempted exactly once for the orphaned child VHDX.
    expect(unlinkSpy).toHaveBeenCalledTimes(1);
    expect(unlinkSpy.mock.calls[0][0]).toContain(
      "smoke-endpoint-1-abc12345.vhdx",
    );
  });

  it("swallows unlink errors during rollback so the original error surfaces", async () => {
    const template = makeTemplate();
    const backend = makeMockBackend();
    const originalErr = new Error("create-vm broke");
    backend.createVMMock.mockRejectedValueOnce(originalErr);

    const unlinkSpy = vi.fn(() => {
      throw new Error("unlink also broken");
    });

    let caught: unknown;
    try {
      await provisionEphemeralVm(backend, makeConfig(tmp), {
        resolveTemplate: async () => template,
        createDifferencingDisk: async () => ({
          parentVhdxPath: template.vhdxPath!,
          childVhdxPath: "ignored",
        }),
        unlinkChildDisk: unlinkSpy,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(EphemeralVmError);
    // Original create-vm error message is in the wrapped error
    expect((caught as Error).message).toContain("create-vm broke");
    expect((caught as EphemeralVmError).code).toBe("create_vm_failed");
  });

  it("wraps differencing-disk failure as diff_disk_failed", async () => {
    const template = makeTemplate();
    const backend = makeMockBackend();
    const diffDisk = vi.fn(async () => {
      throw new Error("New-VHD: parent is locked");
    });

    await expect(
      provisionEphemeralVm(backend, makeConfig(tmp), {
        resolveTemplate: async () => template,
        createDifferencingDisk: diffDisk,
      }),
    ).rejects.toMatchObject({
      name: "EphemeralVmError",
      code: "diff_disk_failed",
    });
  });
});

// ── teardownEphemeralVm ───────────────────────────────────────────

describe("teardownEphemeralVm", () => {
  it("invokes stopVM, deleteVM, and unlink in that order", async () => {
    const backend = makeMockBackend();
    const unlinkSpy = vi.fn();
    const callOrder: string[] = [];
    backend.stopVMMock.mockImplementationOnce(async () => {
      callOrder.push("stop");
    });
    backend.deleteVMMock.mockImplementationOnce(async () => {
      callOrder.push("delete");
    });
    unlinkSpy.mockImplementationOnce(() => {
      callOrder.push("unlink");
    });

    await teardownEphemeralVm(
      backend,
      {
        vmHandle: { id: "id-1", name: "test", backend: "mock" },
        ephemeralName: "test",
        childVhdxPath: "C:\\disks\\test.vhdx",
        parentVhdxPath: "C:\\templates\\base.vhdx",
        vmLineageHash: "0".repeat(64),
        templateName: "win11-base",
      },
      { unlinkChildDisk: unlinkSpy },
    );

    expect(callOrder).toEqual(["stop", "delete", "unlink"]);
  });

  it("continues teardown when stopVM fails", async () => {
    const backend = makeMockBackend();
    backend.stopVMMock.mockRejectedValueOnce(new Error("already off"));
    const unlinkSpy = vi.fn();

    await expect(
      teardownEphemeralVm(
        backend,
        {
          vmHandle: { id: "id-1", name: "test", backend: "mock" },
          ephemeralName: "test",
          childVhdxPath: "C:\\disks\\test.vhdx",
          parentVhdxPath: "C:\\templates\\base.vhdx",
          vmLineageHash: "0".repeat(64),
          templateName: "win11-base",
        },
        { unlinkChildDisk: unlinkSpy },
      ),
    ).rejects.toThrow("already off");

    // Even though stopVM failed, deleteVM and unlink ran.
    expect(backend.deleteVMMock).toHaveBeenCalledTimes(1);
    expect(unlinkSpy).toHaveBeenCalledTimes(1);
  });

  it("surfaces the FIRST error when multiple steps fail", async () => {
    const backend = makeMockBackend();
    const stopErr = new Error("stop broke");
    const deleteErr = new Error("delete also broke");
    backend.stopVMMock.mockRejectedValueOnce(stopErr);
    backend.deleteVMMock.mockRejectedValueOnce(deleteErr);
    const unlinkSpy = vi.fn();

    await expect(
      teardownEphemeralVm(
        backend,
        {
          vmHandle: { id: "id-1", name: "test", backend: "mock" },
          ephemeralName: "test",
          childVhdxPath: "C:\\disks\\test.vhdx",
          parentVhdxPath: "C:\\templates\\base.vhdx",
          vmLineageHash: "0".repeat(64),
          templateName: "win11-base",
        },
        { unlinkChildDisk: unlinkSpy },
      ),
    ).rejects.toBe(stopErr);

    expect(unlinkSpy).toHaveBeenCalled();
  });

  it("resolves cleanly when nothing fails", async () => {
    const backend = makeMockBackend();
    const unlinkSpy = vi.fn();

    await expect(
      teardownEphemeralVm(
        backend,
        {
          vmHandle: { id: "id-1", name: "test", backend: "mock" },
          ephemeralName: "test",
          childVhdxPath: "C:\\disks\\test.vhdx",
          parentVhdxPath: "C:\\templates\\base.vhdx",
          vmLineageHash: "0".repeat(64),
          templateName: "win11-base",
        },
        { unlinkChildDisk: unlinkSpy },
      ),
    ).resolves.toBeUndefined();
  });
});

// ── Error type ergonomics ─────────────────────────────────────────

describe("EphemeralVmError", () => {
  it("is an Error subclass with stable code", () => {
    const e = new EphemeralVmError("create_vm_failed", "test");
    expect(e).toBeInstanceOf(Error);
    expect(e).toBeInstanceOf(EphemeralVmError);
    expect(e.code).toBe("create_vm_failed");
    expect(e.name).toBe("EphemeralVmError");
  });

  it("preserves cause when supplied", () => {
    const cause = new Error("underlying");
    const e = new EphemeralVmError("diff_disk_failed", "wrapped", cause);
    expect(e.cause).toBe(cause);
  });
});

// ── Sanity: RUN_ID_SHORT_LEN ──────────────────────────────────────

describe("RUN_ID_SHORT_LEN constant", () => {
  it("is 8 (used in name generation)", () => {
    expect(RUN_ID_SHORT_LEN).toBe(8);
  });
});
