/**
 * v0.3.0-2 follow-up — ephemeral reaper tests.
 *
 * Pure-ish module; tests inject `fsImpl`, `now`, and a mock
 * backend so no real filesystem, no real Hyper-V, deterministic
 * time math.
 */

import { describe, it, expect, vi } from "vitest";

import {
  DEFAULT_MIN_AGE_MS,
  EphemeralReaperError,
  reapOrphanedEphemeralResources,
  type ReapOptions,
  type ReapResult,
} from "../provisioning/ephemeral-reaper.js";
import type {
  HypervisorBackend,
  VMHandle,
} from "../hypervisors/interface.js";

// ── Fixture helpers ───────────────────────────────────────────────

const PROJECT_ROOT =
  process.platform === "win32"
    ? "C:\\src\\proj"
    : "/src/proj";

function ephemeralDisksDir(): string {
  return process.platform === "win32"
    ? "C:\\src\\proj\\.signalman\\ephemeral-disks"
    : "/src/proj/.signalman/ephemeral-disks";
}

function makeBackend(opts: {
  vms?: VMHandle[];
  stopFails?: boolean;
  deleteFails?: boolean;
  listFails?: boolean;
} = {}): HypervisorBackend & {
  stopVMMock: ReturnType<typeof vi.fn>;
  deleteVMMock: ReturnType<typeof vi.fn>;
} {
  const stopVMMock = vi.fn(async () => {
    if (opts.stopFails) throw new Error("stop refused");
  });
  const deleteVMMock = vi.fn(async () => {
    if (opts.deleteFails) throw new Error("delete refused");
  });
  return {
    name: "mock",
    isAvailable: vi.fn(),
    createVM: vi.fn(),
    startVM: vi.fn(),
    stopVM: stopVMMock,
    pauseVM: vi.fn(),
    resumeVM: vi.fn(),
    deleteVM: deleteVMMock,
    getStatus: vi.fn(),
    listVMs: vi.fn(async () => {
      if (opts.listFails) throw new Error("list refused");
      return opts.vms ?? [];
    }),
    createCheckpoint: vi.fn(),
    restoreCheckpoint: vi.fn(),
    deleteCheckpoint: vi.fn(),
    listCheckpoints: vi.fn(),
    copyFileToVM: vi.fn(),
    copyFileFromVM: vi.fn(),
    executeCommand: vi.fn(),
    stopVMMock,
    deleteVMMock,
  } as unknown as HypervisorBackend & {
    stopVMMock: ReturnType<typeof vi.fn>;
    deleteVMMock: ReturnType<typeof vi.fn>;
  };
}

interface FakeFs {
  existsSync: (p: string) => boolean;
  readdirSync: (p: string) => string[];
  statSync: (p: string) => { mtimeMs: number };
  unlinkSync: ReturnType<typeof vi.fn>;
  unlinkCalls: string[];
}

/**
 * Build a fake fs surface from a description of the ephemeral-disks
 * directory's contents. `files` maps relative VHDX name → ms-ago
 * mtime offset from `now`.
 */
function makeFs(
  files: Record<string, number>,
  now: number = 1_000_000_000_000,
): FakeFs {
  const unlinkCalls: string[] = [];
  const unlinkSync = vi.fn((p: string) => {
    if (!(p in fileMap)) {
      throw new Error(`ENOENT: ${p}`);
    }
    delete fileMap[p];
    unlinkCalls.push(p);
  });
  const fileMap: Record<string, number> = {};
  for (const [name, ageMs] of Object.entries(files)) {
    fileMap[name] = now - ageMs;
  }
  return {
    existsSync: (p: string) => {
      if (p === ephemeralDisksDir()) return true;
      return p in fileMap;
    },
    readdirSync: (p: string) => {
      if (p !== ephemeralDisksDir()) return [];
      return Object.keys(fileMap).map((abs) =>
        process.platform === "win32"
          ? abs.split("\\").pop()!
          : abs.split("/").pop()!,
      );
    },
    statSync: (p: string) => ({ mtimeMs: fileMap[p] ?? now }),
    unlinkSync,
    unlinkCalls,
  };
}

function vhdxPath(name: string): string {
  return process.platform === "win32"
    ? `${ephemeralDisksDir()}\\${name}.vhdx`
    : `${ephemeralDisksDir()}/${name}.vhdx`;
}

function makeVm(name: string): VMHandle {
  return { id: `id-${name}`, name, backend: "mock" };
}

const NOW = 1_000_000_000_000;
const hour = (h: number) => h * 60 * 60 * 1000;

function defaultOpts(overrides: Partial<ReapOptions> = {}): ReapOptions {
  return {
    projectRoot: PROJECT_ROOT,
    backend: makeBackend(),
    now: () => NOW,
    ...overrides,
  };
}

// ── Setup-failure paths ───────────────────────────────────────────

describe("reapOrphanedEphemeralResources — setup validation", () => {
  it("rejects a relative projectRoot with non_absolute_path", async () => {
    await expect(
      reapOrphanedEphemeralResources({
        projectRoot: "relative/path",
        backend: makeBackend(),
      }),
    ).rejects.toMatchObject({
      name: "EphemeralReaperError",
      code: "non_absolute_path",
    });
  });

  it("handles a missing ephemeral-disks directory gracefully", async () => {
    const fsImpl = {
      existsSync: () => false,
      readdirSync: () => [],
      statSync: () => ({ mtimeMs: 0 }),
      unlinkSync: vi.fn(),
    };
    const result = await reapOrphanedEphemeralResources(
      defaultOpts({ fsImpl }),
    );
    expect(result.orphan_disk_count).toBe(0);
    expect(result.orphan_vm_count).toBe(0);
    expect(result.orphans).toEqual([]);
    expect(result.errors).toEqual([]);
  });
});

// ── Disk-only orphans ─────────────────────────────────────────────

describe("reapOrphanedEphemeralResources — orphan disks", () => {
  it("identifies a stale VHDX with no matching VM as an orphan disk", async () => {
    const stale = vhdxPath("smoke-endpoint-1-abc12345");
    const fsImpl = makeFs({ [stale]: hour(2) }, NOW);
    const result = await reapOrphanedEphemeralResources(
      defaultOpts({ fsImpl }),
    );

    expect(result.orphan_disk_count).toBe(1);
    expect(result.orphan_vm_count).toBe(0);
    expect(result.orphans).toHaveLength(1);
    expect(result.orphans[0].kind).toBe("disk");
    expect(result.orphans[0].resource).toBe(stale);
    expect(result.orphans[0].age_ms).toBe(hour(2));
    expect(result.orphans[0].deleted).toBe(true);
    expect(fsImpl.unlinkCalls).toEqual([stale]);
  });

  it("skips disks under the age threshold", async () => {
    const fresh = vhdxPath("smoke-endpoint-1-fresh001");
    const fsImpl = makeFs({ [fresh]: 30 * 60 * 1000 }, NOW); // 30 min
    const result = await reapOrphanedEphemeralResources(
      defaultOpts({ fsImpl }),
    );

    expect(result.orphan_disk_count).toBe(0);
    expect(result.orphans).toEqual([]);
    expect(fsImpl.unlinkCalls).toEqual([]);
  });

  it("honours a custom minAgeMs", async () => {
    const target = vhdxPath("smoke-endpoint-1-target01");
    const fsImpl = makeFs({ [target]: 10 * 60 * 1000 }, NOW); // 10 min
    // With a 5-min threshold, the 10-min-old disk is an orphan.
    const result = await reapOrphanedEphemeralResources(
      defaultOpts({ fsImpl, minAgeMs: 5 * 60 * 1000 }),
    );
    expect(result.orphan_disk_count).toBe(1);
    expect(result.orphans[0].deleted).toBe(true);
  });

  it("does not delete in dryRun mode but still reports orphans", async () => {
    const stale = vhdxPath("smoke-endpoint-1-dryrun01");
    const fsImpl = makeFs({ [stale]: hour(2) }, NOW);
    const result = await reapOrphanedEphemeralResources(
      defaultOpts({ fsImpl, dryRun: true }),
    );

    expect(result.dry_run).toBe(true);
    expect(result.orphan_disk_count).toBe(1);
    expect(result.orphans[0].deleted).toBe(false);
    expect(fsImpl.unlinkCalls).toEqual([]);
  });

  it("surfaces unlink failures in errors without aborting other reaps", async () => {
    const stale1 = vhdxPath("smoke-endpoint-1-bad-disk");
    const stale2 = vhdxPath("smoke-endpoint-1-ok-disk1");
    const fsImpl = makeFs({ [stale1]: hour(2), [stale2]: hour(2) }, NOW);
    // Make unlink fail for stale1 only.
    const realUnlink = fsImpl.unlinkSync;
    fsImpl.unlinkSync = vi.fn((p: string) => {
      if (p === stale1) throw new Error("EACCES");
      return realUnlink(p);
    });

    const result = await reapOrphanedEphemeralResources(
      defaultOpts({ fsImpl }),
    );

    expect(result.orphans).toHaveLength(2);
    const stale1Entry = result.orphans.find((o) => o.resource === stale1)!;
    const stale2Entry = result.orphans.find((o) => o.resource === stale2)!;
    expect(stale1Entry.deleted).toBe(false);
    expect(stale2Entry.deleted).toBe(true);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].resource).toBe(stale1);
    expect(result.errors[0].error).toContain("EACCES");
  });

  it("ignores non-VHDX files in the ephemeral-disks directory", async () => {
    const stale = vhdxPath("smoke-endpoint-1-abc12345");
    const noise = process.platform === "win32"
      ? `${ephemeralDisksDir()}\\readme.txt`
      : `${ephemeralDisksDir()}/readme.txt`;
    const fsImpl = makeFs({ [stale]: hour(2), [noise]: hour(2) }, NOW);
    const result = await reapOrphanedEphemeralResources(
      defaultOpts({ fsImpl }),
    );
    expect(result.orphan_disk_count).toBe(1);
    expect(result.orphans[0].resource).toBe(stale);
  });
});

// ── VM + disk paired orphans ──────────────────────────────────────

describe("reapOrphanedEphemeralResources — orphan VMs", () => {
  it("reaps a paired (VM + stale disk) as a single orphan VM entry", async () => {
    const stale = vhdxPath("smoke-endpoint-1-pair0001");
    const fsImpl = makeFs({ [stale]: hour(3) }, NOW);
    const backend = makeBackend({
      vms: [makeVm("smoke-endpoint-1-pair0001")],
    });
    const result = await reapOrphanedEphemeralResources(
      defaultOpts({ fsImpl, backend }),
    );

    expect(result.orphan_vm_count).toBe(1);
    expect(result.orphan_disk_count).toBe(0);
    const vmEntry = result.orphans.find((o) => o.kind === "vm")!;
    expect(vmEntry.resource).toBe("smoke-endpoint-1-pair0001");
    expect(vmEntry.deleted).toBe(true);
    expect(backend.stopVMMock).toHaveBeenCalledTimes(1);
    expect(backend.deleteVMMock).toHaveBeenCalledTimes(1);
    // Unlink fires after deleteVM so the VHDX goes with the VM.
    expect(fsImpl.unlinkCalls).toEqual([stale]);
  });

  it("does NOT reap a VM whose disk is younger than the threshold", async () => {
    const fresh = vhdxPath("smoke-endpoint-1-fresh001");
    const fsImpl = makeFs({ [fresh]: 15 * 60 * 1000 }, NOW); // 15 min
    const backend = makeBackend({
      vms: [makeVm("smoke-endpoint-1-fresh001")],
    });
    const result = await reapOrphanedEphemeralResources(
      defaultOpts({ fsImpl, backend }),
    );

    expect(result.orphan_vm_count).toBe(0);
    expect(result.orphan_disk_count).toBe(0);
    expect(result.orphans).toEqual([]);
    expect(backend.stopVMMock).not.toHaveBeenCalled();
    expect(backend.deleteVMMock).not.toHaveBeenCalled();
  });

  it("continues to deleteVM when stopVM fails (collects both errors)", async () => {
    const stale = vhdxPath("smoke-endpoint-1-stop-bad");
    const fsImpl = makeFs({ [stale]: hour(2) }, NOW);
    const backend = makeBackend({
      vms: [makeVm("smoke-endpoint-1-stop-bad")],
      stopFails: true,
    });

    const result = await reapOrphanedEphemeralResources(
      defaultOpts({ fsImpl, backend }),
    );

    expect(backend.deleteVMMock).toHaveBeenCalledTimes(1);
    const vmErr = result.errors.find((e) => e.error.includes("stopVM"));
    expect(vmErr).toBeDefined();
    // VM was deleted despite stop failing; VHDX got unlinked too.
    expect(result.orphans[0].deleted).toBe(true);
  });

  it("records deleteVM failures in errors and marks orphan as not-deleted", async () => {
    const stale = vhdxPath("smoke-endpoint-1-del-bad1");
    const fsImpl = makeFs({ [stale]: hour(2) }, NOW);
    const backend = makeBackend({
      vms: [makeVm("smoke-endpoint-1-del-bad1")],
      deleteFails: true,
    });

    const result = await reapOrphanedEphemeralResources(
      defaultOpts({ fsImpl, backend }),
    );

    expect(result.orphans[0].deleted).toBe(false);
    expect(result.errors.some((e) => e.error.includes("deleteVM"))).toBe(true);
    // VHDX NOT unlinked because deleteVM failed (avoid leaving a
    // tracked-by-Hyper-V VM without its disk).
    expect(fsImpl.unlinkCalls).toEqual([]);
  });
});

// ── Mixed reap modes ──────────────────────────────────────────────

describe("reapOrphanedEphemeralResources — mixed cases", () => {
  it("handles a VM with disk-already-deleted-externally cleanly", async () => {
    // VM exists in Hyper-V; the VHDX was deleted manually so it's
    // not in the disks dir. The VM is NOT considered an orphan by
    // this reaper because we only match VMs whose name appears as
    // a VHDX stem in the ephemeral-disks dir. That's the
    // documented contract: cross-reference by name. An operator
    // who manually deleted the VHDX must also manually delete the
    // VM (or use a sweep specific to this case in a future epic).
    const fsImpl = makeFs({}, NOW); // empty dir
    const backend = makeBackend({
      vms: [makeVm("smoke-endpoint-1-leftover")],
    });
    const result = await reapOrphanedEphemeralResources(
      defaultOpts({ fsImpl, backend }),
    );
    expect(result.orphan_vm_count).toBe(0);
    expect(result.orphans).toEqual([]);
  });

  it("survives listVMs failure and reaps disks anyway", async () => {
    const stale = vhdxPath("smoke-endpoint-1-listbad");
    const fsImpl = makeFs({ [stale]: hour(2) }, NOW);
    const backend = makeBackend({ listFails: true });
    const result = await reapOrphanedEphemeralResources(
      defaultOpts({ fsImpl, backend }),
    );
    // No VMs from the backend → all stale disks reaped as orphan disks.
    expect(result.orphan_disk_count).toBe(1);
    expect(result.orphans[0].deleted).toBe(true);
  });

  it("reports both kinds in one pass", async () => {
    const orphanVm = "smoke-endpoint-1-oldvm001";
    const orphanDisk = "smoke-endpoint-1-olddsk01";
    const fresh = "smoke-endpoint-1-fresh001";
    const fsImpl = makeFs(
      {
        [vhdxPath(orphanVm)]: hour(2),
        [vhdxPath(orphanDisk)]: hour(2),
        [vhdxPath(fresh)]: 5 * 60 * 1000,
      },
      NOW,
    );
    const backend = makeBackend({
      vms: [makeVm(orphanVm), makeVm(fresh)],
    });

    const result = await reapOrphanedEphemeralResources(
      defaultOpts({ fsImpl, backend }),
    );
    expect(result.orphan_vm_count).toBe(1);
    expect(result.orphan_disk_count).toBe(1);
    expect(result.orphans).toHaveLength(2);
    // VM orphan + disk orphan; fresh VM untouched.
    expect(backend.stopVMMock).toHaveBeenCalledTimes(1);
    expect(backend.deleteVMMock).toHaveBeenCalledTimes(1);
  });
});

// ── Defaults + constants ──────────────────────────────────────────

describe("DEFAULT_MIN_AGE_MS", () => {
  it("is one hour", () => {
    expect(DEFAULT_MIN_AGE_MS).toBe(60 * 60 * 1000);
  });
});

// ── Error type ergonomics ─────────────────────────────────────────

describe("EphemeralReaperError", () => {
  it("is an Error subclass with stable code", () => {
    const e = new EphemeralReaperError("project_root_missing", "test");
    expect(e).toBeInstanceOf(Error);
    expect(e).toBeInstanceOf(EphemeralReaperError);
    expect(e.code).toBe("project_root_missing");
    expect(e.name).toBe("EphemeralReaperError");
  });
});
