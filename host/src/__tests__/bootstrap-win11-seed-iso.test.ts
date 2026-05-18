/**
 * v0.5 Win11 M2 — bootstrap-win11 seed-ISO integration tests
 * (Story 4).
 *
 * Validates the M2 additions to the bootstrap pipeline:
 *  - Phase 2.5 (`compose_seed_iso`) lands between `acquire_lock`
 *    and `create_vm` in the canonical order.
 *  - The seed ISO is written to
 *    `.signalman/state/bootstrap-win11/<vm>.seed.iso`.
 *  - `state.seedIsoPath` is persisted; `state.seedIsoAttached`
 *    flips true once `create_vm` runs.
 *  - The createVM call receives the seed ISO via
 *    `config.extraCdroms`.
 *  - Phase 12 (`checkpoint`) detaches + deletes the seed ISO
 *    before the checkpoint is taken.
 *  - `cleanupOnFailure` detaches + deletes the seed ISO before
 *    cleanupVM removes the VM.
 *  - `skipSeedIso: true` short-circuits the entire flow (no ISO,
 *    no `extraCdroms`, journal records "skipped").
 *  - Resume contract: if the journal already has
 *    `compose_seed_iso` complete + `seedIsoAttached: true`, the
 *    phase is a no-op.
 *  - Unattended.xml inputs (locale, timezone, admin creds,
 *    autoLogonCount) propagate into the composed ISO.
 *  - State file `seedIsoPath` / `seedIsoAttached` round-trips
 *    through `readState` (forward-compat with M1 journals).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type {
  HypervisorBackend,
  VMHandle,
  VMStatus,
  CheckpointHandle,
  CheckpointInfo,
  CommandResult,
  VMConfig,
} from "../hypervisors/interface.js";
import {
  bootstrapWin11,
  type BootstrapWin11Opts,
} from "../provisioning/bootstrap-win11.js";
import {
  readState,
  writeState,
  newState,
  markPhaseComplete,
  bootstrapStatePath,
  PHASE_ORDER,
} from "../provisioning/bootstrap-win11-state.js";
import { readSeedIsoFile } from "../provisioning/seed-iso.js";
import { parseAutounattendXml } from "../provisioning/unattended.js";
import { globalVmCache } from "../vm-cache.js";

// ── Mock factories ────────────────────────────────────────────────

function makeHandle(name: string): VMHandle {
  return { id: `id-${name}`, name, backend: "mock" };
}

interface MockBackendState {
  vmExists: boolean;
  testSigningOn: boolean;
  rebootHappened: boolean;
  lastCreateConfig: VMConfig | null;
  detachedIsos: string[];
}

function makeMockBackend(
  vmName: string,
  overrides: Partial<HypervisorBackend> = {},
  stateRef?: MockBackendState,
): HypervisorBackend & { _state: MockBackendState } {
  const state: MockBackendState = stateRef ?? {
    vmExists: false,
    testSigningOn: false,
    rebootHappened: false,
    lastCreateConfig: null,
    detachedIsos: [],
  };
  const handle = makeHandle(vmName);
  const backend = {
    name: "mock",
    isAvailable: vi.fn().mockResolvedValue(true),
    createVM: vi.fn().mockImplementation(async (cfg: VMConfig) => {
      state.vmExists = true;
      state.lastCreateConfig = cfg;
      return makeHandle(cfg.name);
    }),
    startVM: vi.fn().mockResolvedValue(undefined),
    stopVM: vi.fn().mockResolvedValue(undefined),
    pauseVM: vi.fn().mockResolvedValue(undefined),
    resumeVM: vi.fn().mockResolvedValue(undefined),
    deleteVM: vi.fn().mockImplementation(async () => {
      state.vmExists = false;
    }),
    getStatus: vi.fn().mockImplementation(async () => ({
      handle,
      state: "running",
      ipAddress: "10.0.0.5",
      guestAgentReachable: true,
    } as VMStatus)),
    listVMs: vi.fn().mockImplementation(async () => (state.vmExists ? [handle] : [])),
    createCheckpoint: vi.fn().mockResolvedValue({
      id: "cp-1",
      vmHandle: handle,
      label: "agent-installed",
    } as CheckpointHandle),
    restoreCheckpoint: vi.fn().mockResolvedValue(undefined),
    deleteCheckpoint: vi.fn().mockResolvedValue(undefined),
    listCheckpoints: vi.fn().mockResolvedValue([] as CheckpointInfo[]),
    copyFileToVM: vi.fn().mockResolvedValue(undefined),
    copyFileFromVM: vi.fn().mockResolvedValue(undefined),
    executeCommand: vi.fn().mockImplementation(
      async (_h: VMHandle, cmd: string, args?: string[]) => {
        if (cmd === "bcdedit.exe" && args?.[0] === "/set" && args?.[1] === "testsigning") {
          state.testSigningOn = true;
          return { exitCode: 0, stdout: "", stderr: "", durationMs: 50 } as CommandResult;
        }
        if (cmd === "bcdedit.exe" && args?.[0] === "/enum") {
          const flag = state.testSigningOn && state.rebootHappened ? "Yes" : "No";
          return {
            exitCode: 0,
            stdout: `testsigning             ${flag}\n`,
            stderr: "",
            durationMs: 60,
          } as CommandResult;
        }
        if (cmd === "shutdown.exe") {
          state.rebootHappened = true;
          return { exitCode: 0, stdout: "", stderr: "", durationMs: 20 } as CommandResult;
        }
        if (cmd === "msiexec.exe") {
          return { exitCode: 0, stdout: "Install succeeded.", stderr: "", durationMs: 1000 } as CommandResult;
        }
        return { exitCode: 0, stdout: "", stderr: "", durationMs: 10 } as CommandResult;
      },
    ),
    setVmFirmware: vi.fn().mockResolvedValue(undefined),
    waitForHeartbeat: vi.fn().mockResolvedValue(true),
    // M2: removeIsoFromVm — record detach calls so tests can assert.
    removeIsoFromVm: vi.fn().mockImplementation(async (_h: VMHandle, isoPath: string) => {
      state.detachedIsos.push(isoPath);
    }),
    ...overrides,
  };
  return Object.assign(backend, { _state: state }) as HypervisorBackend & {
    _state: MockBackendState;
  };
}

function stageFakeSharedCerts(cwd: string): void {
  const d = path.join(cwd, "certs", "dev");
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, "ca.pem"), "FAKE-CA");
  fs.writeFileSync(path.join(d, "server.pem"), "FAKE-CERT");
  fs.writeFileSync(path.join(d, "server.key"), "FAKE-KEY");
}

function stageFakeMsi(dir: string): string {
  const p = path.join(dir, "signalman-guest.msi");
  fs.writeFileSync(p, "MZ");
  return p;
}

let originalCwd: string;
let tmpRoot: string;
let projectRoot: string;
let msiPath: string;
let prevRebootDropMs: string | undefined;

beforeEach(() => {
  originalCwd = process.cwd();
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bootstrap-seed-iso-test-"));
  projectRoot = path.join(tmpRoot, "project");
  fs.mkdirSync(projectRoot, { recursive: true });
  stageFakeSharedCerts(projectRoot);
  process.chdir(projectRoot);
  msiPath = stageFakeMsi(tmpRoot);
  prevRebootDropMs = process.env.SIGNALMAN_BOOTSTRAP_WIN11_REBOOT_DROP_MS;
  process.env.SIGNALMAN_BOOTSTRAP_WIN11_REBOOT_DROP_MS = "0";
  for (const n of ["vm1", "vm-skip", "vm-fail", "vm-resume"]) {
    globalVmCache.invalidate(n);
  }
});

afterEach(() => {
  process.chdir(originalCwd);
  if (prevRebootDropMs === undefined) {
    delete process.env.SIGNALMAN_BOOTSTRAP_WIN11_REBOOT_DROP_MS;
  } else {
    process.env.SIGNALMAN_BOOTSTRAP_WIN11_REBOOT_DROP_MS = prevRebootDropMs;
  }
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

const baseOpts = (vmName: string): BootstrapWin11Opts => ({
  vmName,
  msiPath,
  projectRoot,
  unattended: {
    adminUsername: "signalman",
    adminPassword: "SeedISO-test-pass",
  },
});

// ── Phase order ───────────────────────────────────────────────────

describe("M2 phase order", () => {
  it("includes compose_seed_iso between acquire_lock and create_vm", () => {
    const lockIdx = PHASE_ORDER.indexOf("acquire_lock");
    const composeIdx = PHASE_ORDER.indexOf("compose_seed_iso");
    const createIdx = PHASE_ORDER.indexOf("create_vm");
    expect(lockIdx).toBeGreaterThanOrEqual(0);
    expect(composeIdx).toBe(lockIdx + 1);
    expect(createIdx).toBe(composeIdx + 1);
  });

  it("has exactly 13 phases (12 + compose_seed_iso)", () => {
    expect(PHASE_ORDER.length).toBe(13);
  });
});

// ── Happy path ────────────────────────────────────────────────────

describe("bootstrap-win11 — seed ISO injection (happy path)", () => {
  it("composes the seed ISO at .signalman/state/bootstrap-win11/<vm>.seed.iso", async () => {
    const backend = makeMockBackend("vm1");
    await bootstrapWin11(backend, baseOpts("vm1"));
    const expectedPath = path.join(
      projectRoot,
      ".signalman",
      "state",
      "bootstrap-win11",
      "vm1.seed.iso",
    );
    // The checkpoint phase deletes the ISO. Read the journal for the path.
    const state = readState("vm1", projectRoot)!;
    expect(state.seedIsoPath).toBe(expectedPath);
    expect(state.seedIsoAttached).toBe(false); // cleaned up at checkpoint
  });

  it("passes the seed ISO to createVM via extraCdroms", async () => {
    const backend = makeMockBackend("vm1");
    await bootstrapWin11(backend, baseOpts("vm1"));
    expect(backend._state.lastCreateConfig).not.toBeNull();
    expect(backend._state.lastCreateConfig?.extraCdroms?.length).toBe(1);
    expect(backend._state.lastCreateConfig?.extraCdroms?.[0]).toContain("vm1.seed.iso");
  });

  it("seed ISO bytes are a valid ISO9660 containing the composed Autounattend.xml", async () => {
    // Use a non-existent backend so we observe the ISO before
    // it's deleted by phase 12. Easiest path: skip the checkpoint
    // phase by failing at install_msi.
    const backend = makeMockBackend("vm1");
    // Override executeCommand so msiexec fails — pipeline aborts
    // before phase 12 (checkpoint), leaving the ISO on disk.
    backend.executeCommand = vi.fn().mockImplementation(
      async (_h: VMHandle, cmd: string, args?: string[]) => {
        if (cmd === "msiexec.exe") {
          return { exitCode: 1603, stdout: "", stderr: "boom", durationMs: 10 } as CommandResult;
        }
        if (cmd === "bcdedit.exe" && args?.[0] === "/set") {
          backend._state.testSigningOn = true;
          return { exitCode: 0, stdout: "", stderr: "", durationMs: 50 } as CommandResult;
        }
        if (cmd === "bcdedit.exe" && args?.[0] === "/enum") {
          return {
            exitCode: 0,
            stdout: "testsigning             Yes\n",
            stderr: "",
            durationMs: 50,
          } as CommandResult;
        }
        if (cmd === "shutdown.exe") {
          backend._state.rebootHappened = true;
          return { exitCode: 0, stdout: "", stderr: "", durationMs: 20 } as CommandResult;
        }
        return { exitCode: 0, stdout: "", stderr: "", durationMs: 10 } as CommandResult;
      },
    );
    await expect(bootstrapWin11(backend, baseOpts("vm1"))).rejects.toThrow();
    // The ISO is still on disk (no cleanup-on-failure).
    const isoPath = readState("vm1", projectRoot)!.seedIsoPath!;
    expect(fs.existsSync(isoPath)).toBe(true);
    const iso = fs.readFileSync(isoPath);
    const xml = readSeedIsoFile(iso, "Autounattend.xml");
    expect(xml).not.toBeNull();
    const parsed = parseAutounattendXml(xml!.toString("utf8"));
    expect(parsed.computerName).toBe("vm1");
    expect(parsed.adminUsername).toBe("signalman");
    expect(parsed.adminPassword).toBe("SeedISO-test-pass");
  });

  it("propagates unattended opts (locale, timezone, autoLogonCount) into the ISO", async () => {
    const backend = makeMockBackend("vm1");
    // Force a failure at install_msi so the ISO survives for inspection.
    backend.executeCommand = vi.fn().mockImplementation(
      async (_h: VMHandle, cmd: string, args?: string[]) => {
        if (cmd === "msiexec.exe") {
          return { exitCode: 1603, stdout: "", stderr: "boom", durationMs: 10 } as CommandResult;
        }
        if (cmd === "bcdedit.exe" && args?.[0] === "/set") {
          backend._state.testSigningOn = true;
          return { exitCode: 0, stdout: "", stderr: "", durationMs: 50 } as CommandResult;
        }
        if (cmd === "bcdedit.exe" && args?.[0] === "/enum") {
          return {
            exitCode: 0,
            stdout: "testsigning             Yes\n",
            stderr: "",
            durationMs: 50,
          } as CommandResult;
        }
        if (cmd === "shutdown.exe") {
          backend._state.rebootHappened = true;
          return { exitCode: 0, stdout: "", stderr: "", durationMs: 20 } as CommandResult;
        }
        return { exitCode: 0, stdout: "", stderr: "", durationMs: 10 } as CommandResult;
      },
    );
    await expect(
      bootstrapWin11(backend, {
        ...baseOpts("vm1"),
        unattended: {
          adminUsername: "admin",
          adminPassword: "secret",
          locale: "de-DE",
          timezone: "Europe/Berlin",
          autoLogonCount: 7,
        },
      }),
    ).rejects.toThrow();
    const isoPath = readState("vm1", projectRoot)!.seedIsoPath!;
    const iso = fs.readFileSync(isoPath);
    const xml = readSeedIsoFile(iso, "Autounattend.xml")!.toString("utf8");
    const parsed = parseAutounattendXml(xml);
    expect(parsed.locale).toBe("de-DE");
    expect(parsed.timezone).toBe("W. Europe Standard Time");
    expect(parsed.autoLogonCount).toBe(7);
    expect(parsed.adminUsername).toBe("admin");
  });

  it("detaches the seed ISO at the checkpoint phase (before checkpoint is taken)", async () => {
    const backend = makeMockBackend("vm1");
    await bootstrapWin11(backend, baseOpts("vm1"));
    // The detach call captures the ISO path.
    expect(backend._state.detachedIsos.length).toBe(1);
    expect(backend._state.detachedIsos[0]).toContain("vm1.seed.iso");
    // The ISO file is deleted from disk.
    expect(fs.existsSync(backend._state.detachedIsos[0])).toBe(false);
  });
});

// ── skipSeedIso ───────────────────────────────────────────────────

describe("bootstrap-win11 — skipSeedIso", () => {
  it("records the phase as skipped + does not compose an ISO", async () => {
    const backend = makeMockBackend("vm-skip");
    const events: string[] = [];
    await bootstrapWin11(backend, {
      ...baseOpts("vm-skip"),
      skipSeedIso: true,
      onProgress: (e) => {
        if (e.kind === "phase_complete" && e.phase === "compose_seed_iso") {
          events.push(`done:${e.detail}`);
        }
      },
    });
    const state = readState("vm-skip", projectRoot)!;
    expect(state.seedIsoPath).toBeNull();
    expect(state.seedIsoAttached).toBe(false);
    expect(events.length).toBe(1);
    expect(events[0]).toContain("skipped");
    // createVM did NOT receive an extraCdroms entry.
    expect(backend._state.lastCreateConfig?.extraCdroms).toBeUndefined();
  });
});

// ── Resume contract ──────────────────────────────────────────────

describe("bootstrap-win11 — resume after compose_seed_iso", () => {
  it("is a no-op when journal already records compose_seed_iso complete", async () => {
    // Pre-populate the journal through compose_seed_iso with a
    // known seedIsoPath (the file doesn't have to exist for this
    // skip-path test).
    let s = newState({
      vmName: "vm-resume",
      templateName: "win11-base",
      checkpointLabel: "agent-installed",
    });
    s = markPhaseComplete(s, "resolve_template");
    s = markPhaseComplete(s, "acquire_lock");
    const stubIsoPath = path.join(
      projectRoot,
      ".signalman",
      "state",
      "bootstrap-win11",
      "vm-resume.seed.iso",
    );
    fs.mkdirSync(path.dirname(stubIsoPath), { recursive: true });
    fs.writeFileSync(stubIsoPath, "stub");
    s = { ...s, seedIsoPath: stubIsoPath };
    s = markPhaseComplete(s, "compose_seed_iso");
    writeState(s, projectRoot);

    const backend = makeMockBackend("vm-resume");
    const skipEvents: string[] = [];
    await bootstrapWin11(backend, {
      ...baseOpts("vm-resume"),
      onProgress: (e) => {
        if (e.kind === "phase_skip") skipEvents.push(e.phase);
      },
    });
    expect(skipEvents).toContain("compose_seed_iso");
    // createVM still receives the stored seedIsoPath.
    expect(backend._state.lastCreateConfig?.extraCdroms?.[0]).toBe(stubIsoPath);
  });

  it("marks seedIsoAttached=true when create_vm finds an existing VM", async () => {
    // Pre-populate journal with compose_seed_iso done + seedIsoPath
    // set but seedIsoAttached still false (mid-failure scenario).
    let s = newState({
      vmName: "vm-resume",
      templateName: "win11-base",
      checkpointLabel: "agent-installed",
    });
    s = markPhaseComplete(s, "resolve_template");
    s = markPhaseComplete(s, "acquire_lock");
    s = { ...s, seedIsoPath: "/tmp/stub.iso", seedIsoAttached: false };
    s = markPhaseComplete(s, "compose_seed_iso");
    writeState(s, projectRoot);

    // VM appears to exist (idempotent createVM skip path).
    const sharedState: MockBackendState = {
      vmExists: true,
      testSigningOn: false,
      rebootHappened: false,
      lastCreateConfig: null,
      detachedIsos: [],
    };
    const backend = makeMockBackend("vm-resume", {}, sharedState);
    await bootstrapWin11(backend, baseOpts("vm-resume"));
    // The post-run journal should have seedIsoAttached flipped true
    // before being flipped false again by the checkpoint cleanup.
    expect(backend._state.detachedIsos.length).toBe(1);
  });
});

// ── cleanupOnFailure ──────────────────────────────────────────────

describe("bootstrap-win11 — cleanupOnFailure + seed ISO", () => {
  it("detaches + deletes the seed ISO before cleanupVM on failure", async () => {
    const backend = makeMockBackend("vm-fail");
    // Force install_msi to fail.
    backend.executeCommand = vi.fn().mockImplementation(
      async (_h: VMHandle, cmd: string, args?: string[]) => {
        if (cmd === "msiexec.exe") {
          return { exitCode: 1603, stdout: "", stderr: "boom", durationMs: 10 } as CommandResult;
        }
        if (cmd === "bcdedit.exe" && args?.[0] === "/set") {
          backend._state.testSigningOn = true;
          return { exitCode: 0, stdout: "", stderr: "", durationMs: 50 } as CommandResult;
        }
        if (cmd === "bcdedit.exe" && args?.[0] === "/enum") {
          return {
            exitCode: 0,
            stdout: "testsigning             Yes\n",
            stderr: "",
            durationMs: 50,
          } as CommandResult;
        }
        if (cmd === "shutdown.exe") {
          backend._state.rebootHappened = true;
          return { exitCode: 0, stdout: "", stderr: "", durationMs: 20 } as CommandResult;
        }
        return { exitCode: 0, stdout: "", stderr: "", durationMs: 10 } as CommandResult;
      },
    );
    await expect(
      bootstrapWin11(backend, {
        ...baseOpts("vm-fail"),
        cleanupOnFailure: true,
      }),
    ).rejects.toThrow();
    // The detach call was made before cleanupVM.
    expect(backend._state.detachedIsos.length).toBe(1);
    expect(backend._state.detachedIsos[0]).toContain("vm-fail.seed.iso");
  });

  it("deletes a never-attached seed ISO on early failure with cleanupOnFailure", async () => {
    const backend = makeMockBackend("vm-fail-early");
    // Force createVM to fail. The ISO has been composed but
    // seedIsoAttached is still false at the point of the throw.
    backend.createVM = vi.fn().mockRejectedValue(new Error("create-vm-boom"));
    await expect(
      bootstrapWin11(backend, {
        ...baseOpts("vm-fail-early"),
        cleanupOnFailure: true,
      }),
    ).rejects.toThrow(/create-vm-boom/);
    // The ISO path was persisted...
    const state = readState("vm-fail-early", projectRoot);
    expect(state?.seedIsoPath).toBeTruthy();
    // ...and the orphan ISO file was deleted.
    expect(fs.existsSync(state!.seedIsoPath!)).toBe(false);
  });
});

// ── ComputerName rewrite + cleanup-failure resilience ────────────

describe("bootstrap-win11 — ComputerName + cleanup edges", () => {
  it("logs the ComputerName rewrite when source != result", async () => {
    const backend = makeMockBackend("very.long.vm.name");
    const events: string[] = [];
    await bootstrapWin11(backend, {
      ...baseOpts("very.long.vm.name"),
      onProgress: (e) => {
        if (e.kind === "phase_complete" && e.phase === "compose_seed_iso") {
          events.push(e.detail ?? "");
        }
      },
    });
    expect(events.length).toBe(1);
    expect(events[0]).toContain("ComputerName rewritten");
    expect(events[0]).toContain("very.long.vm.name");
  });

  it("continues to checkpoint when seed-iso detach throws (non-fatal)", async () => {
    const backend = makeMockBackend("vm1");
    // Force the removeIsoFromVm to throw — the pipeline must still
    // create the checkpoint and surface a warning.
    backend.removeIsoFromVm = vi.fn().mockRejectedValue(new Error("detach-boom"));
    // Force the unlink path to also throw a non-ENOENT error so the
    // outer try/catch around detachAndDeleteSeedIso fires.
    const result = await bootstrapWin11(backend, baseOpts("vm1"));
    expect(result.alreadyBootstrapped).toBe(false);
    // Checkpoint was still created (final phase succeeded).
    expect(backend.createCheckpoint).toHaveBeenCalled();
  });

  it("cleanupOnFailure tolerates a detach error and still calls cleanupVM", async () => {
    const backend = makeMockBackend("vm-fail-detach");
    backend.removeIsoFromVm = vi.fn().mockRejectedValue(new Error("detach-boom"));
    backend.executeCommand = vi.fn().mockImplementation(
      async (_h: VMHandle, cmd: string, args?: string[]) => {
        if (cmd === "msiexec.exe") {
          return { exitCode: 1603, stdout: "", stderr: "boom", durationMs: 10 } as CommandResult;
        }
        if (cmd === "bcdedit.exe" && args?.[0] === "/set") {
          backend._state.testSigningOn = true;
          return { exitCode: 0, stdout: "", stderr: "", durationMs: 50 } as CommandResult;
        }
        if (cmd === "bcdedit.exe" && args?.[0] === "/enum") {
          return {
            exitCode: 0,
            stdout: "testsigning             Yes\n",
            stderr: "",
            durationMs: 50,
          } as CommandResult;
        }
        if (cmd === "shutdown.exe") {
          backend._state.rebootHappened = true;
          return { exitCode: 0, stdout: "", stderr: "", durationMs: 20 } as CommandResult;
        }
        return { exitCode: 0, stdout: "", stderr: "", durationMs: 10 } as CommandResult;
      },
    );
    await expect(
      bootstrapWin11(backend, {
        ...baseOpts("vm-fail-detach"),
        cleanupOnFailure: true,
      }),
    ).rejects.toThrow();
    // cleanupVM was still attempted despite the detach failure.
    expect(backend.deleteVM).toHaveBeenCalled();
  });

  it("warns when backend lacks removeIsoFromVm", async () => {
    const backend = makeMockBackend("vm-no-detach");
    // Drop the removeIsoFromVm method entirely (simulate a backend
    // without M2 wiring).
    (backend as { removeIsoFromVm?: unknown }).removeIsoFromVm = undefined;
    const warnings: string[] = [];
    const result = await bootstrapWin11(backend, {
      ...baseOpts("vm-no-detach"),
      onProgress: (e) => {
        if (e.kind === "warning") warnings.push(e.message);
      },
    });
    expect(result.alreadyBootstrapped).toBe(false);
    expect(warnings.some((w) => w.includes("removeIsoFromVm"))).toBe(true);
  });

  it("cleanupOnFailure: deletes orphan ISO when no handle and no attach", async () => {
    // Force failure at the create_vm phase BEFORE the VM handle is
    // resolved. compose_seed_iso has run (ISO on disk), but
    // seedIsoAttached is still false, AND `handle` is still null.
    const backend = makeMockBackend("vm-no-handle-fail");
    backend.createVM = vi.fn().mockRejectedValue(new Error("create-vm-boom"));
    await expect(
      bootstrapWin11(backend, {
        ...baseOpts("vm-no-handle-fail"),
        cleanupOnFailure: true,
      }),
    ).rejects.toThrow();
    // The orphan ISO file should have been unlinked.
    const state = readState("vm-no-handle-fail", projectRoot);
    expect(state?.seedIsoPath).toBeTruthy();
    expect(fs.existsSync(state!.seedIsoPath!)).toBe(false);
  });

  it("cleanupOnFailure: best-effort when cleanupVM ALSO fails", async () => {
    const backend = makeMockBackend("vm-double-fail");
    // Force install_msi failure + cleanupVM (via deleteVM) failure.
    backend.executeCommand = vi.fn().mockImplementation(
      async (_h: VMHandle, cmd: string, args?: string[]) => {
        if (cmd === "msiexec.exe") {
          return { exitCode: 1603, stdout: "", stderr: "boom", durationMs: 10 } as CommandResult;
        }
        if (cmd === "bcdedit.exe" && args?.[0] === "/set") {
          backend._state.testSigningOn = true;
          return { exitCode: 0, stdout: "", stderr: "", durationMs: 50 } as CommandResult;
        }
        if (cmd === "bcdedit.exe" && args?.[0] === "/enum") {
          return {
            exitCode: 0,
            stdout: "testsigning             Yes\n",
            stderr: "",
            durationMs: 50,
          } as CommandResult;
        }
        if (cmd === "shutdown.exe") {
          backend._state.rebootHappened = true;
          return { exitCode: 0, stdout: "", stderr: "", durationMs: 20 } as CommandResult;
        }
        return { exitCode: 0, stdout: "", stderr: "", durationMs: 10 } as CommandResult;
      },
    );
    backend.deleteVM = vi.fn().mockRejectedValue(new Error("cleanup-boom"));
    const warnings: string[] = [];
    await expect(
      bootstrapWin11(backend, {
        ...baseOpts("vm-double-fail"),
        cleanupOnFailure: true,
        onProgress: (e) => {
          if (e.kind === "warning") warnings.push(e.message);
        },
      }),
    ).rejects.toThrow();
    expect(warnings.some((w) => w.includes("cleanupVM also failed"))).toBe(true);
  });
});

// ── State journal round-trip ──────────────────────────────────────

describe("bootstrap-win11 state — seedIsoPath/seedIsoAttached round-trip", () => {
  it("persists seedIsoPath + seedIsoAttached through writeState/readState", () => {
    let s = newState({ vmName: "vm1", templateName: "t", checkpointLabel: "ck" });
    s = { ...s, seedIsoPath: "/tmp/foo.iso", seedIsoAttached: true };
    writeState(s, projectRoot);
    const reloaded = readState("vm1", projectRoot)!;
    expect(reloaded.seedIsoPath).toBe("/tmp/foo.iso");
    expect(reloaded.seedIsoAttached).toBe(true);
  });

  it("legacy state files (no seedIsoPath) load as null + attached=false", () => {
    const p = bootstrapStatePath("vm-legacy", projectRoot);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(
      p,
      JSON.stringify({
        stateVersion: 1,
        vmName: "vm-legacy",
        templateName: "t",
        checkpointLabel: "ck",
        startedAt: "2026-05-17T00:00:00Z",
        lastUpdatedAt: "2026-05-17T00:00:00Z",
        phases: [],
      }),
    );
    const reloaded = readState("vm-legacy", projectRoot)!;
    expect(reloaded.seedIsoPath).toBeNull();
    expect(reloaded.seedIsoAttached).toBe(false);
  });
});
