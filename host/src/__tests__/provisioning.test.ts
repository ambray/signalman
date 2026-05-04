/**
 * Provisioning pipeline tests (P9.1).
 *
 * Validates the contract surfaces of `provisionVM`, `cleanupVM`, and
 * `discoverGuestMsi` without touching a real hypervisor. Pattern
 * mirrors workflow-api.test.ts: vi.fn mocks for HypervisorBackend +
 * a synthetic VMHandle factory.
 *
 * What's covered:
 *   - Idempotent re-run (VM exists + matching checkpoint) → no-op.
 *   - --force tears down via cleanupVM before re-provisioning.
 *   - Backend errors surface as ProvisioningError (NOT silent throws),
 *     with the failing pipeline step preserved for diagnostics.
 *   - discoverGuestMsi returns "explicit" when path provided + exists.
 *   - discoverGuestMsi raises GuestMsiDiscoveryError with multi-line
 *     remediation when nothing is found.
 *
 * What's NOT covered (explicitly):
 *   - The dev-cert generation step (shells out to PowerShell — would
 *     require a real Windows host or a mock subprocess; deferred to
 *     the e2e harness).
 *   - The actual MSI install / msiexec invocation (same reason —
 *     covered by the e2e harness and an integration test gated on
 *     SIGNALMAN_E2E=1).
 */

import { describe, it, expect, vi, afterEach } from "vitest";
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
import { provisionVM, ProvisioningError } from "../provisioning/provision.js";
import {
  cleanupOrphanedProvisioningVms,
  cleanupVM,
  provisioningManifestPath,
  writeProvisioningManifest,
} from "../provisioning/cleanup.js";
import {
  discoverGuestMsi,
  GuestMsiDiscoveryError,
} from "../provisioning/guest-msi-discovery.js";
import { createVmProvisioningTools } from "../tools/vm-provisioning.js";
import { globalVmCache } from "../vm-cache.js";

// ── Mock factories (mirror workflow-api.test.ts) ──────────────────

function makeHandle(name: string): VMHandle {
  return { id: `id-${name}`, name, backend: "mock" };
}

function makeMockBackend(
  overrides: Partial<HypervisorBackend> = {},
): HypervisorBackend {
  return {
    name: "mock",
    isAvailable: vi.fn().mockResolvedValue(true),
    createVM: vi.fn().mockImplementation(async (cfg) => makeHandle(cfg.name)),
    startVM: vi.fn().mockResolvedValue(undefined),
    stopVM: vi.fn().mockResolvedValue(undefined),
    pauseVM: vi.fn().mockResolvedValue(undefined),
    resumeVM: vi.fn().mockResolvedValue(undefined),
    deleteVM: vi.fn().mockResolvedValue(undefined),
    getStatus: vi.fn().mockResolvedValue({
      handle: makeHandle("vm1"),
      state: "running",
      ipAddress: "10.0.0.5",
      guestAgentReachable: true,
    } as VMStatus),
    listVMs: vi.fn().mockResolvedValue([]),
    createCheckpoint: vi.fn().mockResolvedValue({
      id: "cp-1",
      vmHandle: makeHandle("vm1"),
      label: "agent-installed",
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

afterEach(() => {
  globalVmCache.invalidate("vm1");
  globalVmCache.invalidate("vm-force");
  globalVmCache.invalidate("vm-error");
  for (const vmName of ["vm1", "vm-force", "vm-error"]) {
    fs.rmSync(path.dirname(provisioningManifestPath(vmName)), {
      recursive: true,
      force: true,
    });
  }
});

// ── provisionVM idempotency ───────────────────────────────────────

describe("provisionVM idempotency", () => {
  // What this catches: a refactor that drops the listCheckpoints
  // probe and unconditionally re-runs the pipeline (would re-mint
  // certs + push the MSI again).
  it("no-ops when VM exists with matching checkpoint label", async () => {
    const handle = makeHandle("vm1");
    const backend = makeMockBackend({
      listVMs: vi.fn().mockResolvedValue([handle]),
      listCheckpoints: vi.fn().mockResolvedValue([
        {
          id: "cp-1",
          vmHandle: handle,
          label: "agent-installed",
          createdAt: new Date(),
        } as unknown as CheckpointInfo,
      ]),
    });

    const result = await provisionVM(backend, {
      vmName: "vm1",
      checkpointLabel: "agent-installed",
    });

    expect(result.alreadyProvisioned).toBe(true);
    expect(result.checkpointLabel).toBe("agent-installed");
    expect(backend.createVM).not.toHaveBeenCalled();
    expect(backend.copyFileToVM).not.toHaveBeenCalled();
    expect(backend.executeCommand).not.toHaveBeenCalled();
    expect(backend.createCheckpoint).not.toHaveBeenCalled();
  });

  // What this catches: --force silently behaving like the no-op path.
  // We don't run the rest of the pipeline (the cert step would shell
  // out to PowerShell — out of scope for a unit test); we just assert
  // that the deleteVM call lands before any subsequent failure.
  it("--force calls cleanupVM (deleteVM) before re-provisioning", async () => {
    const handle = makeHandle("vm-force");
    const backend = makeMockBackend({
      listVMs: vi.fn().mockResolvedValue([handle]),
      // After cleanup, force the pipeline to fail FAST at boot — we
      // care about the deleteVM call ordering, not the full pipeline.
      startVM: vi.fn().mockRejectedValueOnce(new Error("simulated stop after force")),
      listCheckpoints: vi.fn().mockResolvedValue([
        {
          id: "cp-1",
          vmHandle: handle,
          label: "agent-installed",
          createdAt: new Date(),
        } as unknown as CheckpointInfo,
      ]),
    });

    await expect(
      provisionVM(backend, {
        vmName: "vm-force",
        checkpointLabel: "agent-installed",
        force: true,
      }),
    ).rejects.toBeDefined();

    expect(backend.deleteVM).toHaveBeenCalled();
  });
});

// ── provisionVM error propagation ─────────────────────────────────

describe("provisionVM error propagation", () => {
  // What this catches: a backend error during boot getting swallowed
  // and reported as success (the silent-failure anti-pattern called
  // out in workflow-api.test.ts).
  it("propagates startVM errors as ProvisioningError(step=boot_vm)", async () => {
    const backend = makeMockBackend({
      startVM: vi.fn().mockRejectedValueOnce(new Error("hyperv refused to start")),
    });

    let caught: unknown;
    try {
      await provisionVM(backend, { vmName: "vm-error" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ProvisioningError);
    expect((caught as ProvisioningError).step).toBe("boot_vm");
    expect((caught as Error).message).toContain("hyperv refused to start");
  });

  // What this catches: createVM errors getting eaten or re-thrown
  // without the structured `step` context.
  it("propagates createVM errors as ProvisioningError(step=create_vm)", async () => {
    const backend = makeMockBackend({
      createVM: vi.fn().mockRejectedValueOnce(new Error("disk full")),
    });

    let caught: unknown;
    try {
      await provisionVM(backend, { vmName: "vm-error" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ProvisioningError);
    expect((caught as ProvisioningError).step).toBe("create_vm");
  });
});

// ── discoverGuestMsi ──────────────────────────────────────────────

describe("discoverGuestMsi", () => {
  function failingReleaseFetch(): typeof fetch {
    return vi.fn(async () => new Response("not found", { status: 404 })) as unknown as typeof fetch;
  }

  // What this catches: the explicit path being silently ignored or
  // mis-resolved relative to cwd.
  it("returns kind=explicit when path is provided + exists", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "msi-test-"));
    const msiPath = path.join(tmpDir, "fake-guest.msi");
    fs.writeFileSync(msiPath, "MZ"); // valid-enough placeholder
    try {
      const source = await discoverGuestMsi(msiPath);
      expect(source.kind).toBe("explicit");
      expect(source.path).toBe(path.resolve(msiPath));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // What this catches: an explicit path miss falling through to the
  // bundled / GitHub Release path silently.
  it("hard-fails when explicit path doesn't exist", async () => {
    const missing = path.join(os.tmpdir(), "definitely-not-here.msi");
    await expect(discoverGuestMsi(missing)).rejects.toBeInstanceOf(
      GuestMsiDiscoveryError,
    );
  });

  // What this catches: explicit path not ending in .msi being
  // accepted (e.g. a path to a directory or a typo).
  it("hard-fails when explicit path doesn't end in .msi", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "msi-test-"));
    const badPath = path.join(tmpDir, "guest.exe");
    fs.writeFileSync(badPath, "MZ");
    try {
      await expect(discoverGuestMsi(badPath)).rejects.toBeInstanceOf(
        GuestMsiDiscoveryError,
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // What this catches: the discovery error message being a single
  // unhelpful line; LLM agents need the searched paths AND remediation
  // to recover unattended.
  it("hard-fails with multi-line remediation when no MSI is found", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "msi-cache-"));
    let caught: unknown;
    try {
      await discoverGuestMsi(undefined, {
        cacheDir: tmpDir,
        fetchImpl: failingReleaseFetch(),
        releaseTag: "v0.1.0",
      });
    } catch (err) {
      caught = err;
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
    expect(caught).toBeInstanceOf(GuestMsiDiscoveryError);
    const e = caught as GuestMsiDiscoveryError;
    expect(e.searched.length).toBeGreaterThanOrEqual(2);
    expect(e.remediation.length).toBeGreaterThanOrEqual(2);
    expect(e.message.split("\n").length).toBeGreaterThan(2);
    // The remediation must mention both the build-from-source path
    // and the GitHub Release fetch path so an LLM can pick one.
    expect(
      e.remediation.some((r) => r.includes("cargo wix")),
    ).toBe(true);
  });

  // What this catches: Source 3 staying a permanent stub instead of
  // resolving the matching GitHub Release asset on demand.
  it("downloads a guest MSI from a matching GitHub Release", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "msi-cache-"));
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const urlString = String(url);
      if (urlString.includes("/releases/tags/v0.1.0")) {
        return new Response(
          JSON.stringify({
            assets: [
              {
                name: "notes.txt",
                browser_download_url: "https://example.test/notes.txt",
              },
              {
                name: "signalman-guest-v0.1.0-x64.msi",
                browser_download_url: "https://example.test/signalman-guest.msi",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (urlString === "https://example.test/signalman-guest.msi") {
        return new Response(new Uint8Array([0x4d, 0x5a]), { status: 200 });
      }
      return new Response("unexpected url", { status: 500 });
    }) as unknown as typeof fetch;

    try {
      const source = await discoverGuestMsi(undefined, {
        cacheDir: tmpDir,
        fetchImpl,
        releaseRepo: "ambray/signalman",
        releaseTag: "v0.1.0",
      });

      expect(source.kind).toBe("github_release");
      expect(path.basename(source.path)).toBe("signalman-guest-v0.1.0-x64.msi");
      expect(fs.readFileSync(source.path)).toEqual(Buffer.from([0x4d, 0x5a]));
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // What this catches: repeated provisioning runs re-downloading the
  // same MSI even though the matching release asset is already cached.
  it("uses a cached GitHub Release MSI before fetching", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "msi-cache-"));
    const cacheTagDir = path.join(tmpDir, "v0.1.0");
    const cachedMsi = path.join(cacheTagDir, "signalman-guest-v0.1.0-x64.msi");
    const fetchImpl = vi.fn(async () => new Response("unexpected", { status: 500 })) as unknown as typeof fetch;
    fs.mkdirSync(cacheTagDir, { recursive: true });
    fs.writeFileSync(cachedMsi, "MZ");

    try {
      const source = await discoverGuestMsi(undefined, {
        cacheDir: tmpDir,
        fetchImpl,
        releaseRepo: "ambray/signalman",
        releaseTag: "v0.1.0",
      });

      expect(source).toEqual({ kind: "github_release", path: cachedMsi });
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ── cleanupVM idempotency ─────────────────────────────────────────

describe("cleanupVM", () => {
  // What this catches: cleanupVM throwing when the VM is already gone.
  // Per design, this is the explicit "I want this VM not to exist"
  // verb — convergence to the desired state, not strict assertion.
  it("is a no-op when the VM doesn't exist", async () => {
    const backend = makeMockBackend({
      listVMs: vi.fn().mockResolvedValue([]),
    });
    await expect(cleanupVM(backend, "ghost-vm")).resolves.toBeUndefined();
    expect(backend.deleteVM).not.toHaveBeenCalled();
  });

  // What this catches: cleanupVM not actually invoking deleteVM when
  // the VM exists.
  it("calls stopVM + deleteVM when the VM exists", async () => {
    const handle = makeHandle("vm1");
    const backend = makeMockBackend({
      listVMs: vi.fn().mockResolvedValue([handle]),
    });
    await cleanupVM(backend, "vm1");
    expect(backend.stopVM).toHaveBeenCalled();
    expect(backend.deleteVM).toHaveBeenCalledWith(
      expect.objectContaining({ name: "vm1" }),
    );
  });
});

describe("cleanupOrphanedProvisioningVms", () => {
  it("dry-runs manifest-owned VMs that lack the target checkpoint", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "signalman-reaper-"));
    const handle = makeHandle("orphan-vm");
    const backend = makeMockBackend({
      listVMs: vi.fn().mockResolvedValue([handle]),
      listCheckpoints: vi.fn().mockResolvedValue([]),
    });

    try {
      writeProvisioningManifest(
        {
          vmName: "orphan-vm",
          templateName: "win11-base",
          checkpointLabel: "agent-installed",
          startedAt: "2026-05-04T00:00:00.000Z",
          createdVm: true,
        },
        tmpDir,
      );

      const result = await cleanupOrphanedProvisioningVms(backend, { tmpDir });

      expect(result.candidates).toEqual([
        expect.objectContaining({
          vmName: "orphan-vm",
          checkpointLabel: "agent-installed",
          reason: "missing_checkpoint",
        }),
      ]);
      expect(result.cleaned).toEqual([]);
      expect(backend.deleteVM).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("skips completed provisioning runs that have the target checkpoint", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "signalman-reaper-"));
    const handle = makeHandle("ready-vm");
    const backend = makeMockBackend({
      listVMs: vi.fn().mockResolvedValue([handle]),
      listCheckpoints: vi.fn().mockResolvedValue([
        {
          id: "cp-agent-installed",
          label: "agent-installed",
          createdAt: new Date("2026-05-04T00:00:00.000Z"),
        },
      ]),
    });

    try {
      writeProvisioningManifest(
        {
          vmName: "ready-vm",
          templateName: "win11-base",
          checkpointLabel: "agent-installed",
          startedAt: "2026-05-04T00:00:00.000Z",
          createdVm: true,
        },
        tmpDir,
      );

      const result = await cleanupOrphanedProvisioningVms(backend, { tmpDir });

      expect(result.candidates).toEqual([]);
      expect(backend.deleteVM).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("deletes orphan VMs only when dryRun is false", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "signalman-reaper-"));
    const handle = makeHandle("delete-me");
    const backend = makeMockBackend({
      listVMs: vi.fn().mockResolvedValue([handle]),
      listCheckpoints: vi.fn().mockResolvedValue([]),
    });

    try {
      writeProvisioningManifest(
        {
          vmName: "delete-me",
          templateName: "win11-base",
          checkpointLabel: "agent-installed",
          startedAt: "2026-05-04T00:00:00.000Z",
          createdVm: true,
        },
        tmpDir,
      );

      const result = await cleanupOrphanedProvisioningVms(backend, {
        tmpDir,
        dryRun: false,
      });

      expect(result.cleaned).toEqual(["delete-me"]);
      expect(backend.stopVM).toHaveBeenCalledWith(handle, true);
      expect(backend.deleteVM).toHaveBeenCalledWith(handle);
      expect(
        fs.existsSync(provisioningManifestPath("delete-me", tmpDir)),
      ).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("vm_cleanup_orphans tool", () => {
  it("defaults to dry-run so discovery does not delete candidate VMs", async () => {
    const vmName = `tool-orphan-${Date.now()}`;
    const handle = makeHandle(vmName);
    const backend = makeMockBackend({
      listVMs: vi.fn().mockResolvedValue([handle]),
      listCheckpoints: vi.fn().mockResolvedValue([]),
    });
    const tools = createVmProvisioningTools(async () => backend);
    const tool = tools.find((entry) => entry.name === "vm_cleanup_orphans");

    try {
      writeProvisioningManifest({
        vmName,
        templateName: "win11-base",
        checkpointLabel: "agent-installed",
        startedAt: "2026-05-04T00:00:00.000Z",
        createdVm: true,
      });

      const result = await tool?.handler({});
      const payload = JSON.parse(result?.content[0]?.text ?? "{}") as {
        candidates?: Array<{ vmName: string }>;
        cleaned?: string[];
      };

      expect(payload.candidates).toContainEqual(
        expect.objectContaining({ vmName }),
      );
      expect(payload.cleaned).toEqual([]);
      expect(backend.deleteVM).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(path.dirname(provisioningManifestPath(vmName)), {
        recursive: true,
        force: true,
      });
    }
  });

  it("deletes manifest-owned orphan VMs when dry_run is false", async () => {
    const vmName = `tool-delete-${Date.now()}`;
    const handle = makeHandle(vmName);
    const backend = makeMockBackend({
      listVMs: vi.fn().mockResolvedValue([handle]),
      listCheckpoints: vi.fn().mockResolvedValue([]),
    });
    const tools = createVmProvisioningTools(async () => backend);
    const tool = tools.find((entry) => entry.name === "vm_cleanup_orphans");

    try {
      writeProvisioningManifest({
        vmName,
        templateName: "win11-base",
        checkpointLabel: "agent-installed",
        startedAt: "2026-05-04T00:00:00.000Z",
        createdVm: true,
      });

      const result = await tool?.handler({ dry_run: false });
      const payload = JSON.parse(result?.content[0]?.text ?? "{}") as {
        cleaned?: string[];
      };

      expect(payload.cleaned).toEqual([vmName]);
      expect(backend.deleteVM).toHaveBeenCalledWith(handle);
    } finally {
      fs.rmSync(path.dirname(provisioningManifestPath(vmName)), {
        recursive: true,
        force: true,
      });
    }
  });
});
