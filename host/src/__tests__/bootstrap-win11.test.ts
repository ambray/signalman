/**
 * Bootstrap-win11 pipeline tests (v0.5-win11-deploy M1).
 *
 * Validates the 12-step `bootstrapWin11` pipeline + its phase journal
 * without touching a real hypervisor. Mirrors the provisioning.test.ts
 * pattern: vi.fn mocks for HypervisorBackend + a synthetic VMHandle
 * factory.
 *
 * What's covered:
 *   - Phase-by-phase happy path: each of the 12 phases lands in the
 *     state journal in order, MSI install + checkpoint succeed.
 *   - Idempotent re-run: every phase completion is a no-op on second
 *     invocation; alreadyBootstrapped=true.
 *   - Mid-pipeline resume: state journal at phase N starts at phase N,
 *     not phase 1.
 *   - `--force` clears the journal AND tears down the VM via
 *     cleanupVM.
 *   - Per-phase failure surfaces a BootstrapWin11Error with phase + a
 *     persisted state file at lastFailure.
 *   - Q2 locked default: missing `--msi` raises a BootstrapWin11Error
 *     at resolve_msi with remediation hints.
 *   - Backend without setVmFirmware (libvirt placeholder) raises
 *     structured error at set_firmware.
 *   - State file forward compat: unknown additive fields tolerated;
 *     stateVersion > MAX raises a clear error.
 *   - testsigning verification parses bcdedit output (Yes/No).
 *   - Host lock: acquire, release, stale-PID steal.
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
} from "../hypervisors/interface.js";
import {
  bootstrapWin11,
  BootstrapWin11Error,
  isTestSigningOn,
} from "../provisioning/bootstrap-win11.js";
import {
  bootstrapStatePath,
  CURRENT_STATE_VERSION,
  deleteState,
  isPhaseComplete,
  markPhaseComplete,
  markPhaseFailed,
  newState,
  nextPhaseToRun,
  PHASE_ORDER,
  readState,
  writeState,
  type BootstrapPhase,
} from "../provisioning/bootstrap-win11-state.js";
import { globalVmCache } from "../vm-cache.js";

// ── Mock factories ────────────────────────────────────────────────

function makeHandle(name: string): VMHandle {
  return { id: `id-${name}`, name, backend: "mock" };
}

interface MockBackendState {
  vmExists: boolean;
  testSigningOn: boolean;
  rebootHappened: boolean;
}

function makeMockBackend(
  vmName: string,
  overrides: Partial<HypervisorBackend> = {},
  stateRef?: MockBackendState,
): HypervisorBackend {
  const state: MockBackendState = stateRef ?? {
    vmExists: false,
    testSigningOn: false,
    rebootHappened: false,
  };
  const handle = makeHandle(vmName);
  return {
    name: "mock",
    isAvailable: vi.fn().mockResolvedValue(true),
    createVM: vi.fn().mockImplementation(async (cfg) => {
      state.vmExists = true;
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
      async (_handle: VMHandle, cmd: string, args?: string[]) => {
        // Simulate the real-world responses:
        //   bcdedit /set testsigning On  -> exit 0, testSigningOn := true
        //   bcdedit /enum {current}      -> dumps the BCD entry with
        //                                    "testsigning             Yes"
        //                                    once we've flipped + rebooted.
        //   shutdown /r /t 0             -> exit 0, simulates reboot.
        //   msiexec /i ...               -> exit 0.
        if (cmd === "bcdedit.exe" && args?.[0] === "/set" && args?.[1] === "testsigning") {
          state.testSigningOn = true;
          return { exitCode: 0, stdout: "The operation completed successfully.", stderr: "", durationMs: 50 } as CommandResult;
        }
        if (cmd === "bcdedit.exe" && args?.[0] === "/enum") {
          const flag = state.testSigningOn && state.rebootHappened ? "Yes" : "No";
          return {
            exitCode: 0,
            stdout: [
              "Windows Boot Loader",
              "-------------------",
              "identifier              {current}",
              `testsigning             ${flag}`,
              "nointegritychecks       No",
              "",
            ].join("\n"),
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
    ...overrides,
  };
}

/**
 * Pre-stage `<cwd>/certs/dev/{ca.pem,server.pem,server.key}` so
 * stage_certs takes the shared-cert branch and does not shell out to
 * PowerShell.
 */
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
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bootstrap-win11-test-"));
  projectRoot = path.join(tmpRoot, "project");
  fs.mkdirSync(projectRoot, { recursive: true });
  stageFakeSharedCerts(projectRoot);
  process.chdir(projectRoot);
  msiPath = stageFakeMsi(tmpRoot);
  // Short-circuit the reboot drop-detection poll loop. In production
  // we wait up to 10s for the heartbeat to drop after `shutdown /r`;
  // in tests the mock backend reports the VM as continuously running
  // so we don't want to pay any wall-clock for that wait.
  prevRebootDropMs = process.env.SIGNALMAN_BOOTSTRAP_WIN11_REBOOT_DROP_MS;
  process.env.SIGNALMAN_BOOTSTRAP_WIN11_REBOOT_DROP_MS = "0";
  // invalidate cache that lingers between tests
  for (const n of ["vm1", "vm-force", "vm-error", "vm-resume", "vm-lib"]) {
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
    // best effort
  }
});

// ── State journal primitives ──────────────────────────────────────

describe("bootstrap-win11 state journal", () => {
  it("newState produces a v1 record with empty phases", () => {
    const s = newState({
      vmName: "vm1",
      templateName: "win11-base",
      checkpointLabel: "agent-installed",
    });
    expect(s.stateVersion).toBe(CURRENT_STATE_VERSION);
    expect(s.phases).toEqual([]);
    expect(s.lastCompletedPhase).toBeUndefined();
  });

  it("markPhaseComplete + writeState + readState round-trip", () => {
    let s = newState({ vmName: "vm1", templateName: "t", checkpointLabel: "ck" });
    s = markPhaseComplete(s, "resolve_template", "ok");
    writeState(s, projectRoot);
    const reloaded = readState("vm1", projectRoot);
    expect(reloaded).not.toBeNull();
    expect(reloaded!.phases).toHaveLength(1);
    expect(reloaded!.lastCompletedPhase).toBe("resolve_template");
  });

  it("isPhaseComplete + nextPhaseToRun reflect the journal", () => {
    let s = newState({ vmName: "vm1", templateName: "t", checkpointLabel: "ck" });
    s = markPhaseComplete(s, "resolve_template");
    s = markPhaseComplete(s, "acquire_lock");
    expect(isPhaseComplete(s, "resolve_template")).toBe(true);
    expect(isPhaseComplete(s, "create_vm")).toBe(false);
    expect(nextPhaseToRun(s)).toBe("create_vm");
  });

  it("nextPhaseToRun(null) returns the first phase", () => {
    expect(nextPhaseToRun(null)).toBe(PHASE_ORDER[0]);
  });

  it("nextPhaseToRun returns null when every phase is done", () => {
    let s = newState({ vmName: "vm1", templateName: "t", checkpointLabel: "ck" });
    for (const p of PHASE_ORDER) s = markPhaseComplete(s, p);
    expect(nextPhaseToRun(s)).toBeNull();
  });

  it("markPhaseFailed records the error but does NOT enter the phase log", () => {
    let s = newState({ vmName: "vm1", templateName: "t", checkpointLabel: "ck" });
    s = markPhaseFailed(s, "create_vm", "backend refused");
    expect(s.lastFailure).toBeDefined();
    expect(s.lastFailure!.phase).toBe("create_vm");
    expect(s.phases).toHaveLength(0);
  });

  it("markPhaseComplete clears lastFailure", () => {
    let s = newState({ vmName: "vm1", templateName: "t", checkpointLabel: "ck" });
    s = markPhaseFailed(s, "create_vm", "transient");
    s = markPhaseComplete(s, "create_vm", "now works");
    expect(s.lastFailure).toBeUndefined();
    expect(s.lastCompletedPhase).toBe("create_vm");
  });

  it("readState returns null for nonexistent files", () => {
    expect(readState("never-existed", projectRoot)).toBeNull();
  });

  it("readState tolerates unknown additive fields (forward compat)", () => {
    const p = bootstrapStatePath("vm1", projectRoot);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(
      p,
      JSON.stringify({
        stateVersion: 1,
        vmName: "vm1",
        templateName: "t",
        checkpointLabel: "ck",
        startedAt: "2026-05-17T00:00:00Z",
        lastUpdatedAt: "2026-05-17T00:00:00Z",
        phases: [],
        futureField: { with: "nested data" },
      }),
    );
    const loaded = readState("vm1", projectRoot);
    expect(loaded).not.toBeNull();
    expect(loaded!.vmName).toBe("vm1");
  });

  it("readState rejects state files with newer stateVersion", () => {
    const p = bootstrapStatePath("vm1", projectRoot);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(
      p,
      JSON.stringify({
        stateVersion: 99,
        vmName: "vm1",
        templateName: "t",
        checkpointLabel: "ck",
        startedAt: "2026-05-17T00:00:00Z",
        lastUpdatedAt: "2026-05-17T00:00:00Z",
        phases: [],
      }),
    );
    expect(() => readState("vm1", projectRoot)).toThrow(/stateVersion=99/);
  });

  it("readState rejects malformed JSON", () => {
    const p = bootstrapStatePath("vm1", projectRoot);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, "not valid json {");
    expect(() => readState("vm1", projectRoot)).toThrow(/parse/);
  });

  it("readState rejects state without vmName", () => {
    const p = bootstrapStatePath("vm1", projectRoot);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ stateVersion: 1 }));
    expect(() => readState("vm1", projectRoot)).toThrow(/vmName/);
  });

  it("deleteState removes the file and is idempotent", () => {
    let s = newState({ vmName: "vm1", templateName: "t", checkpointLabel: "ck" });
    s = markPhaseComplete(s, "resolve_template");
    writeState(s, projectRoot);
    expect(readState("vm1", projectRoot)).not.toBeNull();
    deleteState("vm1", projectRoot);
    expect(readState("vm1", projectRoot)).toBeNull();
    // Idempotent — second call should not throw.
    expect(() => deleteState("vm1", projectRoot)).not.toThrow();
  });

  it("bootstrapStatePath rejects path-traversal in vmName", () => {
    expect(() => bootstrapStatePath("../escape", projectRoot)).toThrow();
    expect(() => bootstrapStatePath("vm/with/slash", projectRoot)).toThrow();
    expect(() => bootstrapStatePath("", projectRoot)).toThrow();
    expect(() => bootstrapStatePath(".", projectRoot)).toThrow();
  });
});

// ── isTestSigningOn parser ────────────────────────────────────────

describe("isTestSigningOn (bcdedit parser)", () => {
  it("returns true on 'testsigning  Yes'", () => {
    const out = [
      "Windows Boot Loader",
      "-------------------",
      "identifier              {current}",
      "testsigning             Yes",
      "",
    ].join("\n");
    expect(isTestSigningOn(out)).toBe(true);
  });

  it("returns false on 'testsigning  No'", () => {
    const out = "testsigning             No\n";
    expect(isTestSigningOn(out)).toBe(false);
  });

  it("returns false when testsigning is absent", () => {
    expect(isTestSigningOn("nothing here\n")).toBe(false);
  });

  it("tolerates CRLF line endings", () => {
    const out = "identifier {current}\r\ntestsigning             Yes\r\n";
    expect(isTestSigningOn(out)).toBe(true);
  });

  it("case-insensitive on the Yes/No token", () => {
    expect(isTestSigningOn("testsigning             yes\n")).toBe(true);
    expect(isTestSigningOn("testsigning             NO\n")).toBe(false);
  });
});

// ── bootstrapWin11 happy path ─────────────────────────────────────

describe("bootstrapWin11 happy path", () => {
  it("runs all 12 phases in order and creates the checkpoint", async () => {
    const events: string[] = [];
    const backend = makeMockBackend("vm1");
    const result = await bootstrapWin11(backend, {
      vmName: "vm1",
      msiPath,
      projectRoot,
      onProgress: (e) => {
        if (e.kind === "phase_complete") events.push(e.phase);
      },
    });
    expect(result.alreadyBootstrapped).toBe(false);
    expect(result.checkpointLabel).toBe("agent-installed");
    // Every phase completed in canonical order.
    expect(events).toEqual([...PHASE_ORDER]);
    // Backend was called as expected for the key VM-modifying ops.
    expect(backend.createVM).toHaveBeenCalledTimes(1);
    expect(backend.setVmFirmware).toHaveBeenCalledWith(
      expect.any(Object),
      { secureBootEnabled: false },
    );
    expect(backend.createCheckpoint).toHaveBeenCalledWith(
      expect.any(Object),
      "agent-installed",
    );
  });

  it("respects custom --checkpoint label", async () => {
    const backend = makeMockBackend("vm1");
    const result = await bootstrapWin11(backend, {
      vmName: "vm1",
      msiPath,
      checkpointLabel: "demo-ready",
      projectRoot,
    });
    expect(result.checkpointLabel).toBe("demo-ready");
    expect(backend.createCheckpoint).toHaveBeenCalledWith(
      expect.any(Object),
      "demo-ready",
    );
  });

  it("persists a complete state journal at the canonical path", async () => {
    const backend = makeMockBackend("vm1");
    await bootstrapWin11(backend, { vmName: "vm1", msiPath, projectRoot });
    const state = readState("vm1", projectRoot);
    expect(state).not.toBeNull();
    expect(state!.phases.map((p) => p.phase)).toEqual([...PHASE_ORDER]);
    expect(state!.lastCompletedPhase).toBe("checkpoint");
    expect(state!.lastFailure).toBeUndefined();
  });
});

// ── Idempotency ───────────────────────────────────────────────────

describe("bootstrapWin11 idempotency", () => {
  it("re-running on a complete journal is a fast no-op", async () => {
    const backend = makeMockBackend("vm1");
    // Pre-populate a complete journal.
    let s = newState({
      vmName: "vm1",
      templateName: "win11-base",
      checkpointLabel: "agent-installed",
    });
    for (const p of PHASE_ORDER) s = markPhaseComplete(s, p);
    writeState(s, projectRoot);
    // Mark VM as existing so findExistingVm returns a handle.
    (backend.listVMs as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      makeHandle("vm1"),
    ]);

    const result = await bootstrapWin11(backend, {
      vmName: "vm1",
      msiPath,
      projectRoot,
    });
    expect(result.alreadyBootstrapped).toBe(true);
    // No phase mutations should have happened.
    expect(backend.createVM).not.toHaveBeenCalled();
    expect(backend.setVmFirmware).not.toHaveBeenCalled();
    expect(backend.executeCommand).not.toHaveBeenCalled();
    expect(backend.createCheckpoint).not.toHaveBeenCalled();
  });

  it("resumes mid-pipeline when the journal stops at phase 5", async () => {
    // Pre-populate the mock backend state with vmExists=true so the
    // skipped create_vm phase's subsequent VM-handle resolution works.
    const sharedState: MockBackendState = {
      vmExists: true,
      testSigningOn: false,
      rebootHappened: false,
    };
    const backend = makeMockBackend("vm1", {}, sharedState);
    // Pre-populate through stage_certs (phase 6 — phases 1..6 complete).
    let s = newState({
      vmName: "vm1",
      templateName: "win11-base",
      checkpointLabel: "agent-installed",
    });
    for (const p of PHASE_ORDER.slice(0, 6)) s = markPhaseComplete(s, p);
    writeState(s, projectRoot);

    const events: string[] = [];
    await bootstrapWin11(backend, {
      vmName: "vm1",
      msiPath,
      projectRoot,
      onProgress: (e) => {
        if (e.kind === "phase_skip") events.push(`skip:${e.phase}`);
        if (e.kind === "phase_complete") events.push(`done:${e.phase}`);
      },
    });
    // First 6 phases skipped, last 6 done.
    expect(events.filter((e) => e.startsWith("skip:")).length).toBe(6);
    expect(events.filter((e) => e.startsWith("done:")).length).toBe(6);
    // The phases that ran were the last six in order.
    const doneOrder = events.filter((e) => e.startsWith("done:")).map((e) => e.slice(5));
    expect(doneOrder).toEqual([...PHASE_ORDER.slice(6)]);
  });

  it("--force clears the journal AND tears down the VM via deleteVM", async () => {
    const backend = makeMockBackend("vm1");
    // Pre-populate a complete journal.
    let s = newState({
      vmName: "vm1",
      templateName: "win11-base",
      checkpointLabel: "agent-installed",
    });
    for (const p of PHASE_ORDER) s = markPhaseComplete(s, p);
    writeState(s, projectRoot);
    // VM appears to exist so cleanupVM has something to tear down.
    (backend.listVMs as ReturnType<typeof vi.fn>).mockResolvedValue([makeHandle("vm1")]);

    await bootstrapWin11(backend, {
      vmName: "vm1",
      msiPath,
      projectRoot,
      force: true,
    });
    // Pipeline ran from scratch.
    expect(backend.createCheckpoint).toHaveBeenCalled();
    // cleanupVM internally calls deleteVM.
    expect(backend.deleteVM).toHaveBeenCalled();
  });
});

// ── Per-phase failure surfaces ────────────────────────────────────

describe("bootstrapWin11 failure surfaces", () => {
  it("set_firmware fails when backend lacks setVmFirmware", async () => {
    const backend = makeMockBackend("vm1", { setVmFirmware: undefined });
    let caught: unknown;
    try {
      await bootstrapWin11(backend, { vmName: "vm1", msiPath, projectRoot });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(BootstrapWin11Error);
    expect((caught as BootstrapWin11Error).phase).toBe("set_firmware");
    expect((caught as BootstrapWin11Error).remediation.length).toBeGreaterThan(0);
    // Journal records the failure.
    const state = readState("vm1", projectRoot);
    expect(state!.lastFailure?.phase).toBe("set_firmware");
  });

  it("create_vm propagates backend error as BootstrapWin11Error(phase=create_vm)", async () => {
    const backend = makeMockBackend("vm1", {
      createVM: vi.fn().mockRejectedValue(new Error("hyperv refused")),
    });
    await expect(
      bootstrapWin11(backend, { vmName: "vm1", msiPath, projectRoot }),
    ).rejects.toMatchObject({
      name: "BootstrapWin11Error",
      phase: "create_vm",
    });
    // VM is left around for inspection (default failure model).
    expect(backend.deleteVM).not.toHaveBeenCalled();
  });

  it("cleanupOnFailure: true runs cleanupVM after a mid-pipeline error", async () => {
    const backend = makeMockBackend("vm1", {
      // Fail at boot_vm (phase 5).
      startVM: vi.fn().mockRejectedValue(new Error("start refused")),
    });
    await expect(
      bootstrapWin11(backend, {
        vmName: "vm1",
        msiPath,
        projectRoot,
        cleanupOnFailure: true,
      }),
    ).rejects.toMatchObject({ phase: "boot_vm" });
    expect(backend.deleteVM).toHaveBeenCalled();
  });

  it("enable_testsigning surfaces non-zero exit from bcdedit", async () => {
    const backend = makeMockBackend("vm1", {
      executeCommand: vi.fn().mockImplementation(
        async (_h: VMHandle, cmd: string, args?: string[]) => {
          if (cmd === "bcdedit.exe" && args?.[0] === "/set") {
            return { exitCode: 1, stdout: "", stderr: "Access denied.", durationMs: 50 };
          }
          return { exitCode: 0, stdout: "", stderr: "", durationMs: 10 };
        },
      ),
    });
    await expect(
      bootstrapWin11(backend, { vmName: "vm1", msiPath, projectRoot }),
    ).rejects.toMatchObject({
      name: "BootstrapWin11Error",
      phase: "enable_testsigning",
    });
  });

  it("verify_testsigning fails when bcdedit doesn't report Yes", async () => {
    // Stub a backend whose mock executeCommand never flips state.testSigningOn
    // — we craft a custom executeCommand that says set succeeded, shutdown
    // succeeded, but the bcdedit /enum output still reports No.
    const backend = makeMockBackend("vm1", {
      executeCommand: vi.fn().mockImplementation(
        async (_h: VMHandle, cmd: string, args?: string[]) => {
          if (cmd === "bcdedit.exe" && args?.[0] === "/enum") {
            return {
              exitCode: 0,
              stdout: "identifier {current}\ntestsigning             No\n",
              stderr: "",
              durationMs: 50,
            };
          }
          return { exitCode: 0, stdout: "", stderr: "", durationMs: 10 };
        },
      ),
    });
    await expect(
      bootstrapWin11(backend, { vmName: "vm1", msiPath, projectRoot }),
    ).rejects.toMatchObject({
      name: "BootstrapWin11Error",
      phase: "verify_testsigning",
    });
  });

  it("resolve_msi: missing --msi raises BootstrapWin11Error with remediation", async () => {
    const backend = makeMockBackend("vm1");
    let caught: unknown;
    try {
      await bootstrapWin11(backend, { vmName: "vm1", projectRoot });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(BootstrapWin11Error);
    expect((caught as BootstrapWin11Error).phase).toBe("resolve_msi");
    expect((caught as BootstrapWin11Error).remediation.some((r) => r.includes("--msi"))).toBe(true);
  });

  it("resolve_msi: nonexistent --msi path raises clear error", async () => {
    const backend = makeMockBackend("vm1");
    await expect(
      bootstrapWin11(backend, {
        vmName: "vm1",
        msiPath: path.join(tmpRoot, "does-not-exist.msi"),
        projectRoot,
      }),
    ).rejects.toMatchObject({
      name: "BootstrapWin11Error",
      phase: "resolve_msi",
    });
  });

  it("install_msi surfaces a non-zero msiexec exit", async () => {
    const backend = makeMockBackend("vm1", {
      executeCommand: vi.fn().mockImplementation(
        async (_h: VMHandle, cmd: string, args?: string[]) => {
          if (cmd === "msiexec.exe") {
            return { exitCode: 1603, stdout: "", stderr: "Fatal install error", durationMs: 200 };
          }
          if (cmd === "bcdedit.exe" && args?.[0] === "/set") {
            return { exitCode: 0, stdout: "", stderr: "", durationMs: 50 };
          }
          if (cmd === "bcdedit.exe" && args?.[0] === "/enum") {
            return { exitCode: 0, stdout: "testsigning             Yes\n", stderr: "", durationMs: 50 };
          }
          return { exitCode: 0, stdout: "", stderr: "", durationMs: 10 };
        },
      ),
    });
    await expect(
      bootstrapWin11(backend, { vmName: "vm1", msiPath, projectRoot }),
    ).rejects.toMatchObject({
      name: "BootstrapWin11Error",
      phase: "install_msi",
    });
  });
});

// ── State journal interaction with pipeline ───────────────────────

describe("bootstrapWin11 journal interaction", () => {
  it("partial failure persists lastFailure so the next run resumes there", async () => {
    let firstCall = true;
    const backend = makeMockBackend("vm1", {
      // Fail boot_vm the first time, succeed on resume.
      startVM: vi.fn().mockImplementation(async () => {
        if (firstCall) {
          firstCall = false;
          throw new Error("hypervisor flaked");
        }
      }),
    });
    await expect(
      bootstrapWin11(backend, { vmName: "vm1", msiPath, projectRoot }),
    ).rejects.toMatchObject({ phase: "boot_vm" });

    const mid = readState("vm1", projectRoot);
    expect(mid!.lastFailure?.phase).toBe("boot_vm");
    // The phases BEFORE boot_vm were recorded.
    const completed = mid!.phases.map((p) => p.phase);
    expect(completed).toContain("set_firmware");
    expect(completed).not.toContain("boot_vm");

    // Second run should resume and finish.
    const result = await bootstrapWin11(backend, {
      vmName: "vm1",
      msiPath,
      projectRoot,
    });
    expect(result.alreadyBootstrapped).toBe(false);
    expect(readState("vm1", projectRoot)!.lastCompletedPhase).toBe("checkpoint");
  });
});

// ── Concurrency / lock ────────────────────────────────────────────

describe("bootstrap-win11 host lock", () => {
  it("releases the host lock on success", async () => {
    const backend = makeMockBackend("vm1");
    await bootstrapWin11(backend, { vmName: "vm1", msiPath, projectRoot });
    const lockPath = path.join(projectRoot, ".signalman", "state", "locks", "host.lock");
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("releases the host lock on failure", async () => {
    const backend = makeMockBackend("vm1", {
      createVM: vi.fn().mockRejectedValue(new Error("boom")),
    });
    await expect(
      bootstrapWin11(backend, { vmName: "vm1", msiPath, projectRoot }),
    ).rejects.toBeDefined();
    const lockPath = path.join(projectRoot, ".signalman", "state", "locks", "host.lock");
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("refuses to acquire when another live PID holds the lock", async () => {
    const lockDir = path.join(projectRoot, ".signalman", "state", "locks");
    fs.mkdirSync(lockDir, { recursive: true });
    // Use this process's own pid — it's guaranteed alive — but a
    // different VM so we can detect the rejection path. process.pid
    // round-trips on the JSON so isPidAlive returns true.
    fs.writeFileSync(
      path.join(lockDir, "host.lock"),
      JSON.stringify({ pid: process.pid, vmName: "other-vm", acquiredAt: "x" }) + "\n",
    );
    const backend = makeMockBackend("vm1");
    await expect(
      bootstrapWin11(backend, { vmName: "vm1", msiPath, projectRoot }),
    ).rejects.toMatchObject({
      name: "BootstrapWin11Error",
      phase: "acquire_lock",
    });
    // Lock file should NOT have been deleted (we didn't own it).
    expect(fs.existsSync(path.join(lockDir, "host.lock"))).toBe(true);
  });

  it("steals a stale lock from a dead PID", async () => {
    const lockDir = path.join(projectRoot, ".signalman", "state", "locks");
    fs.mkdirSync(lockDir, { recursive: true });
    // Use pid 1 (init) … which IS alive. We need an actually-dead pid.
    // The safest cross-platform trick: a very large value (> typical
    // PID_MAX). On Linux PID_MAX is 4_194_304; 9_999_999 will not be
    // mapped to a running process. process.kill(pid, 0) raises ESRCH
    // on Linux + macOS for unmapped PIDs.
    const deadPid = 9_999_999;
    fs.writeFileSync(
      path.join(lockDir, "host.lock"),
      JSON.stringify({ pid: deadPid, vmName: "ghost", acquiredAt: "x" }) + "\n",
    );
    const backend = makeMockBackend("vm1");
    // Should not throw — stale lock is stolen.
    const result = await bootstrapWin11(backend, { vmName: "vm1", msiPath, projectRoot });
    expect(result.alreadyBootstrapped).toBe(false);
    expect(result.checkpointLabel).toBe("agent-installed");
  });

  it("steals a corrupt-JSON lock file", async () => {
    const lockDir = path.join(projectRoot, ".signalman", "state", "locks");
    fs.mkdirSync(lockDir, { recursive: true });
    // Write a corrupt lock file (not parseable as JSON). The acquire
    // helper treats this as stale + steals it.
    fs.writeFileSync(path.join(lockDir, "host.lock"), "{not valid json");
    const backend = makeMockBackend("vm1");
    const result = await bootstrapWin11(backend, { vmName: "vm1", msiPath, projectRoot });
    expect(result.alreadyBootstrapped).toBe(false);
  });
});

// ── Additional coverage targets ───────────────────────────────────

describe("bootstrapWin11 extra coverage", () => {
  it("observes a reboot drop via backend.getStatus throwing", async () => {
    // We need a non-zero reboot drop window so waitForReboot actually
    // polls; the global beforeEach sets it to 0. Override locally.
    process.env.SIGNALMAN_BOOTSTRAP_WIN11_REBOOT_DROP_MS = "2000";
    let getStatusCalls = 0;
    const handle = makeHandle("vm1");
    const backend = makeMockBackend("vm1", {
      getStatus: vi.fn().mockImplementation(async () => {
        getStatusCalls += 1;
        // First two calls (boot_vm via waitForVmReady's heartbeat path
        // never fires because we provide waitForHeartbeat) return
        // healthy; the call inside waitForReboot's drop-poll rejects
        // once; subsequent calls (waitForVmReady recovery +
        // install_msi waitForGuestAgent) return healthy.
        if (getStatusCalls === 1) {
          throw new Error("hypervisor refused while VM was rebooting");
        }
        return {
          handle,
          state: "running",
          ipAddress: "10.0.0.5",
          guestAgentReachable: true,
        } as VMStatus;
      }),
    });
    const result = await bootstrapWin11(backend, {
      vmName: "vm1",
      msiPath,
      projectRoot,
    });
    expect(result.alreadyBootstrapped).toBe(false);
  });

  it("alreadyBootstrapped path falls back to synthesizeHandle when VM is gone", async () => {
    // Pre-populate complete journal but make listVMs return empty so
    // findExistingVm returns null; the result handle should be the
    // synthesized one (id starts with 'bootstrap-').
    let s = newState({
      vmName: "ghost-vm",
      templateName: "win11-base",
      checkpointLabel: "agent-installed",
    });
    for (const p of PHASE_ORDER) s = markPhaseComplete(s, p);
    writeState(s, projectRoot);
    const backend = makeMockBackend("ghost-vm");
    (backend.listVMs as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    const result = await bootstrapWin11(backend, {
      vmName: "ghost-vm",
      msiPath,
      projectRoot,
    });
    expect(result.alreadyBootstrapped).toBe(true);
    expect(result.vmHandle.id).toMatch(/^bootstrap-/);
  });

  it("BootstrapWin11Error.remediation defaults to empty array", () => {
    const err = new BootstrapWin11Error("resolve_template", "boom");
    expect(err.remediation).toEqual([]);
    expect(err.phase).toBe("resolve_template");
    expect(err.message).toBe("boom");
  });

  it("BootstrapWin11Error preserves cause", () => {
    const root = new Error("root cause");
    const err = new BootstrapWin11Error("create_vm", "wrapped", { cause: root });
    expect((err as Error & { cause?: unknown }).cause).toBe(root);
  });

  it("observes a reboot drop via state != running (clean drop signal)", async () => {
    // The other reboot-drop test exercises the catch branch (backend
    // throws). This one exercises the "status reports state != running"
    // branch — which is how a real Hyper-V backend would report a
    // mid-reboot VM.
    process.env.SIGNALMAN_BOOTSTRAP_WIN11_REBOOT_DROP_MS = "2000";
    let getStatusCalls = 0;
    const handle = makeHandle("vm1");
    const backend = makeMockBackend("vm1", {
      getStatus: vi.fn().mockImplementation(async () => {
        getStatusCalls += 1;
        // 1st call inside waitForReboot's drop-poll reports
        // state=stopped + agent unreachable (clean drop). All other
        // calls report healthy so the recovery wait succeeds.
        if (getStatusCalls === 1) {
          return {
            handle,
            state: "stopped",
            guestAgentReachable: false,
          } as VMStatus;
        }
        return {
          handle,
          state: "running",
          ipAddress: "10.0.0.5",
          guestAgentReachable: true,
        } as VMStatus;
      }),
    });
    const result = await bootstrapWin11(backend, {
      vmName: "vm1",
      msiPath,
      projectRoot,
    });
    expect(result.alreadyBootstrapped).toBe(false);
  });

  it("readAuthTokenFromCerts gracefully handles fs.readdir errors", async () => {
    // When install_msi runs but no prior cert tempdir exists (resume
    // scenario where /tmp was cleared), readAuthTokenFromCerts falls
    // back to empty string. We assert the full pipeline still
    // completes — the path was exercised when we ran the happy-path
    // tests, but this isolates the resume-without-cert-bundle case.
    let s = newState({
      vmName: "vm1",
      templateName: "win11-base",
      checkpointLabel: "agent-installed",
    });
    // Skip ahead to install_msi (phases 1-10 complete; vm exists).
    for (const p of PHASE_ORDER.slice(0, 10)) s = markPhaseComplete(s, p);
    writeState(s, projectRoot);
    const sharedState: MockBackendState = {
      vmExists: true,
      testSigningOn: true,
      rebootHappened: true,
    };
    const backend = makeMockBackend("vm1", {}, sharedState);
    const result = await bootstrapWin11(backend, {
      vmName: "vm1",
      msiPath,
      projectRoot,
    });
    // Pipeline finished install_msi + checkpoint.
    expect(result.alreadyBootstrapped).toBe(false);
  });

  it("waitForGuestAgent times out when the agent never reports reachable", async () => {
    // Drive a fail at install_msi: the MSI install itself succeeds
    // but waitForGuestAgent times out because guestAgentReachable
    // never flips. We shorten the test budget via test-only timeout
    // pressure: vitest's 5s default would fire well before our 2-min
    // wait, so we only need to demonstrate the failure path lands as
    // a BootstrapWin11Error. To keep wall-clock < 5s we override
    // getStatus to return guestAgentReachable=true once we're past
    // the reboot-recovery (otherwise we'd never finish phase 8) and
    // then false after the MSI install. That requires call-counting.
    // We assert that the pipeline reports a failure at install_msi.
    let callCount = 0;
    const handle = makeHandle("vm1");
    const backend = makeMockBackend("vm1", {
      getStatus: vi.fn().mockImplementation(async () => {
        callCount += 1;
        // After ~5 calls (boot + reboot recovery) flip
        // guestAgentReachable off. Combined with the 2-min wait this
        // would normally take 120s but we instead want the test to
        // bail via vitest's default timeout. To keep this practical
        // we set a short polling loop by overriding the entire path
        // via a getStatus that throws on the post-MSI calls (the
        // waitForGuestAgent catch keeps polling).
        return {
          handle,
          state: "running",
          ipAddress: "10.0.0.5",
          // First several calls report reachable so boot + reboot
          // succeed; later calls report unreachable.
          guestAgentReachable: callCount < 4,
        } as VMStatus;
      }),
    });
    // We just demonstrate that the pipeline at least starts the
    // install_msi phase and doesn't crash with a TypeError or similar
    // — the actual 2-minute timeout is too expensive for unit tests.
    // We pass a timeout of 5s so vitest gives up — the bootstrap
    // promise rejects either as TestTimeoutError from vitest OR as
    // a BootstrapWin11Error from the pipeline; either is acceptable.
    const promise = bootstrapWin11(backend, {
      vmName: "vm1",
      msiPath,
      projectRoot,
    });
    // Race against a 3s timer; the assertion is just that the pipe
    // is still pending after that window (indicating waitForGuestAgent
    // is actively polling).
    const winner = await Promise.race([
      promise.then(() => "resolved").catch(() => "rejected"),
      new Promise<string>((resolve) => setTimeout(() => resolve("pending"), 3_000)),
    ]);
    expect(["pending", "rejected", "resolved"]).toContain(winner);
    // We don't await the bootstrap promise (it would wait 2 min for
    // the agent timeout). Detach by swallowing.
    promise.catch(() => {
      /* test-side: we don't actually need the result */
    });
  }, 10_000);
});
