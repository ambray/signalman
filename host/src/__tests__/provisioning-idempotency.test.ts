/**
 * P9.4 — cross-cutting idempotent ensure-provisioned tests.
 *
 * Each provisioning verb has its own unit-test file pinning the local
 * contract; this file is the cross-cutting suite that asserts the
 * "ensure"-style semantics across the whole pipeline. The premise of
 * v0.1.1 is that an LLM-driven workflow can re-invoke any provisioning
 * verb without state leakage: re-running `runInit`, `fetchTemplateImage`,
 * `provisionVM`, `cleanupVM`, and `installBundle` must converge to the
 * same outcome and the second pass must cost ~nothing.
 *
 * What this catches that the per-verb suites don't:
 *
 *   - Idempotency drift across releases. A refactor that changes one
 *     verb's "skip" path to silently overwrite is still passable in
 *     the per-verb tests when it runs once; this file's repeat-N
 *     pattern surfaces the regression.
 *   - End-to-end ensure ordering. The final "init → fetch → provision
 *     → install" pass twice exercises the contract that drives the
 *     bootstrap flow + recovery story; if any single verb regresses
 *     to "always re-do", the second pass blows up wall-clock and the
 *     test fails fast with a structured assertion.
 *
 * Test discipline:
 *
 *   - Each test uses its own tmpdir for any on-disk state so the suite
 *     stays order-independent.
 *   - Backend + client mocks are stateful vi.fn impls so we can
 *     simulate "VM exists after Run 1" without re-implementing the
 *     real backends.
 *   - We do NOT exercise the real PowerShell cert-generation step —
 *     for the provisionVM end-to-end case we pre-stage a cert bundle
 *     into a tmp cwd so `stageDevCerts` takes the "shared certs"
 *     branch (no shell-out).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { Readable } from "node:stream";

import { runInit } from "../verbs/init.js";
import { provisionVM } from "../provisioning/provision.js";
import { cleanupVM } from "../provisioning/cleanup.js";
import {
  installBundle,
  type BundleCapableClient,
} from "../provisioning/install-bundle.js";
import { parseBundle } from "../provisioning/bundle-types.js";
import { fetchTemplateImage } from "../provisioning/template-fetch.js";
import type {
  HypervisorBackend,
  VMHandle,
  VMStatus,
  CheckpointHandle,
  CheckpointInfo,
  CommandResult,
} from "../hypervisors/interface.js";
import type { GuestAgentClient } from "../guest/client.js";
import { globalVmCache } from "../vm-cache.js";

// ── Shared mock factories ─────────────────────────────────────────

function makeHandle(name: string): VMHandle {
  return { id: `id-${name}`, name, backend: "mock" };
}

/**
 * Stateful mock backend. The closure-captured `state` lets a single
 * mock simulate the VM lifecycle across multiple provisionVM calls
 * (Run 1: no VM → Run 2/3: VM exists with checkpoint).
 */
function makeStatefulBackend(initial: {
  vms?: VMHandle[];
  checkpoints?: Record<string, CheckpointInfo[]>;
} = {}): {
  backend: HypervisorBackend;
  state: { vms: VMHandle[]; checkpoints: Record<string, CheckpointInfo[]> };
} {
  const state = {
    vms: [...(initial.vms ?? [])],
    checkpoints: { ...(initial.checkpoints ?? {}) },
  };

  const backend: HypervisorBackend = {
    name: "mock",
    isAvailable: vi.fn().mockResolvedValue(true),
    createVM: vi.fn().mockImplementation(async (cfg) => {
      const h = makeHandle(cfg.name);
      state.vms.push(h);
      return h;
    }),
    startVM: vi.fn().mockResolvedValue(undefined),
    stopVM: vi.fn().mockResolvedValue(undefined),
    pauseVM: vi.fn().mockResolvedValue(undefined),
    resumeVM: vi.fn().mockResolvedValue(undefined),
    deleteVM: vi.fn().mockImplementation(async (h: VMHandle) => {
      state.vms = state.vms.filter((vm) => vm.name !== h.name);
      delete state.checkpoints[h.name];
    }),
    getStatus: vi.fn().mockImplementation(
      async (h: VMHandle): Promise<VMStatus> => ({
        handle: h,
        state: "running",
        ipAddress: "10.0.0.5",
        guestAgentReachable: true,
      }),
    ),
    listVMs: vi.fn().mockImplementation(async () => [...state.vms]),
    createCheckpoint: vi
      .fn()
      .mockImplementation(
        async (h: VMHandle, label: string): Promise<CheckpointHandle> => {
          const cp: CheckpointHandle = { id: `cp-${label}`, vmHandle: h, label };
          const list = state.checkpoints[h.name] ?? [];
          list.push({
            id: cp.id,
            label,
            createdAt: new Date(),
          } as unknown as CheckpointInfo);
          state.checkpoints[h.name] = list;
          return cp;
        },
      ),
    restoreCheckpoint: vi.fn().mockResolvedValue(undefined),
    deleteCheckpoint: vi.fn().mockResolvedValue(undefined),
    listCheckpoints: vi
      .fn()
      .mockImplementation(
        async (h: VMHandle): Promise<CheckpointInfo[]> =>
          state.checkpoints[h.name] ?? [],
      ),
    copyFileToVM: vi.fn().mockResolvedValue(undefined),
    copyFileFromVM: vi.fn().mockResolvedValue(undefined),
    executeCommand: vi.fn().mockResolvedValue({
      exitCode: 0,
      stdout: "ok",
      stderr: "",
      durationMs: 100,
    } as CommandResult),
  };

  return { backend, state };
}

/**
 * Pre-stage a fake `<cwd>/certs/dev/{ca.pem,server.pem,server.key}`
 * inside `dir` so `stageDevCerts` takes the shared-certs branch and
 * does NOT shell out to PowerShell. Returns the auth-token directory
 * so we can clean up.
 */
function stageFakeSharedCerts(cwd: string): void {
  const d = path.join(cwd, "certs", "dev");
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, "ca.pem"), "FAKE-CA");
  fs.writeFileSync(path.join(d, "server.pem"), "FAKE-CERT");
  fs.writeFileSync(path.join(d, "server.key"), "FAKE-KEY");
}

/**
 * Materialize a fake .msi file in the supplied dir and return its
 * absolute path. provisionVM's discoverGuestMsi requires either an
 * explicit path or a bundled MSI; in unit-test land we always use
 * the explicit path so the discovery chain doesn't reach the
 * not-yet-implemented GitHub Release source.
 */
function stageFakeMsi(dir: string): string {
  const p = path.join(dir, "signalman-guest.msi");
  fs.writeFileSync(p, "MZ"); // valid-enough placeholder
  return p;
}

function sha256Hex(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

/**
 * Build a fetch impl that streams a buffer once and counts calls.
 * Returns `{ fn, callCount }` where callCount is a getter so each
 * test can read the latest value after awaiting.
 */
function countingFetch(body: Buffer): {
  fn: typeof fetch;
  calls: () => number;
} {
  let n = 0;
  const fn = (async () => {
    n++;
    const stream = Readable.from(body);
    const web = Readable.toWeb(
      stream,
    ) as unknown as ReadableStream<Uint8Array>;
    return new Response(web, {
      status: 200,
      headers: { "content-length": String(body.length) },
    });
  }) as unknown as typeof fetch;
  return { fn, calls: () => n };
}

// ── Per-test cleanup ──────────────────────────────────────────────

afterEach(() => {
  // The provisionVM happy path caches the handle by name. We invalidate
  // every name we use across the suite so cross-test bleed-through can't
  // hide an idempotency bug.
  for (const name of [
    "ensure-vm",
    "force-vm",
    "cleanup-vm",
    "ensure-e2e-vm",
  ]) {
    globalVmCache.invalidate(name);
  }
});

// ── 1. runInit × 3 ────────────────────────────────────────────────

describe("runInit × 3 (idempotent scaffold)", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "p94-init-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("Run 1 creates >=6 files; Runs 2 + 3 skip them all and leave content byte-identical", () => {
    const r1 = runInit({ cwd: tmp });
    expect(r1.filesCreated.length).toBeGreaterThanOrEqual(6);
    expect(r1.filesSkipped).toEqual([]);

    // Capture every file's bytes after run 1 — we'll diff after each
    // subsequent run to make sure idempotency really means "no writes",
    // not "writes equivalent content" (which would still bump mtime
    // and surface as flaky cache invalidations downstream).
    const snapshot = new Map<string, Buffer>();
    for (const abs of r1.filesCreated) {
      snapshot.set(abs, fs.readFileSync(abs));
    }

    for (const run of [2, 3]) {
      const r = runInit({ cwd: tmp });
      expect(
        r.filesCreated,
        `runInit run ${run}: expected no new files (idempotency violated — refactor likely overwrote existing scaffold)`,
      ).toEqual([]);
      expect(
        r.filesSkipped.length,
        `runInit run ${run}: expected >=6 skipped files`,
      ).toBeGreaterThanOrEqual(6);
      for (const [abs, expectedBytes] of snapshot) {
        expect(
          fs.readFileSync(abs),
          `runInit run ${run}: file ${abs} content drifted between runs`,
        ).toEqual(expectedBytes);
      }
    }
  });
});

// ── 2. runInit({force:true}) × 3 with tampering ───────────────────

describe("runInit({force:true}) × 3 after content tampering", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "p94-init-force-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("each --force run restores canonical content even when config.yaml was clobbered", () => {
    runInit({ cwd: tmp });
    const cfgPath = path.join(tmp, ".signalman", "config.yaml");
    const canonical = fs.readFileSync(cfgPath, "utf8");

    for (const run of [1, 2, 3]) {
      // Tamper between runs: simulate an operator hand-edit gone bad.
      fs.writeFileSync(cfgPath, `# clobber #${run}\n`, "utf8");
      expect(fs.readFileSync(cfgPath, "utf8")).toBe(`# clobber #${run}\n`);

      const result = runInit({ cwd: tmp, force: true });
      expect(
        result.filesCreated.map((p) => path.relative(tmp, p)),
        `force run ${run}: expected config.yaml in filesCreated (overwrite path)`,
      ).toContain(path.join(".signalman", "config.yaml"));
      expect(
        fs.readFileSync(cfgPath, "utf8"),
        `force run ${run}: canonical content was not restored`,
      ).toBe(canonical);
    }
  });
});

// ── 3. provisionVM × 3 ────────────────────────────────────────────

describe("provisionVM × 3 (idempotent ensure)", () => {
  let savedCwd: string;
  let tmpCwd: string;

  beforeEach(() => {
    savedCwd = process.cwd();
    tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), "p94-prov-"));
    stageFakeSharedCerts(tmpCwd);
    process.chdir(tmpCwd);
  });
  afterEach(() => {
    process.chdir(savedCwd);
    fs.rmSync(tmpCwd, { recursive: true, force: true });
    // Tempdir per-VM cert bundle staged by stageDevCerts when the
    // provision pipeline ran. Best-effort cleanup.
    try {
      fs.rmSync(path.join(os.tmpdir(), `signalman-provision-ensure-vm`), {
        recursive: true,
        force: true,
      });
    } catch {
      /* swallow */
    }
  });

  it("Run 1 runs full pipeline; Runs 2 + 3 short-circuit (no createVM, no copyFileToVM)", async () => {
    const { backend } = makeStatefulBackend();
    const msi = stageFakeMsi(tmpCwd);

    // Run 1: cold start. The full pipeline runs end-to-end against
    // the stateful mock, which transitions itself into the "VM
    // exists with checkpoint" terminal state.
    const r1 = await provisionVM(backend, {
      vmName: "ensure-vm",
      checkpointLabel: "agent-installed",
      guestMsiPath: msi,
    });
    expect(
      r1.alreadyProvisioned,
      "Run 1: VM was empty, expected alreadyProvisioned=false (full pipeline)",
    ).toBe(false);
    expect(r1.checkpointLabel).toBe("agent-installed");
    expect(backend.createVM).toHaveBeenCalledTimes(1);
    expect(backend.createCheckpoint).toHaveBeenCalledTimes(1);
    // The MSI install path goes through copyFileToVM (certs + msi)
    // and executeCommand (msiexec) — assert at least one of each.
    expect(
      (backend.copyFileToVM as ReturnType<typeof vi.fn>).mock.calls.length,
    ).toBeGreaterThan(0);
    expect(backend.executeCommand).toHaveBeenCalled();

    const createVmCallsAfterRun1 = (
      backend.createVM as ReturnType<typeof vi.fn>
    ).mock.calls.length;
    const copyFileCallsAfterRun1 = (
      backend.copyFileToVM as ReturnType<typeof vi.fn>
    ).mock.calls.length;

    // Runs 2 + 3: the mock backend's state now reports the VM with
    // the matching checkpoint, so provisionVM must short-circuit.
    for (const run of [2, 3]) {
      const t0 = Date.now();
      const r = await provisionVM(backend, {
        vmName: "ensure-vm",
        checkpointLabel: "agent-installed",
        guestMsiPath: msi,
      });
      const elapsed = Date.now() - t0;
      expect(
        r.alreadyProvisioned,
        `Run ${run}: expected alreadyProvisioned=true (VM + checkpoint already exist)`,
      ).toBe(true);
      expect(
        elapsed,
        `Run ${run}: idempotent path took ${elapsed} ms; expected <100 ms (real pipeline ran by mistake?)`,
      ).toBeLessThan(100);
      expect(
        (backend.createVM as ReturnType<typeof vi.fn>).mock.calls.length,
        `Run ${run}: backend.createVM was called again on idempotent path`,
      ).toBe(createVmCallsAfterRun1);
      expect(
        (backend.copyFileToVM as ReturnType<typeof vi.fn>).mock.calls.length,
        `Run ${run}: backend.copyFileToVM was called again on idempotent path`,
      ).toBe(copyFileCallsAfterRun1);
    }
  });
});

// ── 4. provisionVM({force:true}) ──────────────────────────────────

describe("provisionVM({force:true})", () => {
  let savedCwd: string;
  let tmpCwd: string;

  beforeEach(() => {
    savedCwd = process.cwd();
    tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), "p94-force-"));
    stageFakeSharedCerts(tmpCwd);
    process.chdir(tmpCwd);
  });
  afterEach(() => {
    process.chdir(savedCwd);
    fs.rmSync(tmpCwd, { recursive: true, force: true });
    try {
      fs.rmSync(path.join(os.tmpdir(), `signalman-provision-force-vm`), {
        recursive: true,
        force: true,
      });
    } catch {
      /* swallow */
    }
  });

  it("calls backend.deleteVM before backend.createVM (cleanup-then-rebuild ordering)", async () => {
    const handle = makeHandle("force-vm");
    const { backend, state } = makeStatefulBackend({
      vms: [handle],
      checkpoints: {
        "force-vm": [
          {
            id: "cp-old",
            label: "agent-installed",
            createdAt: new Date(),
          } as unknown as CheckpointInfo,
        ],
      },
    });
    const msi = stageFakeMsi(tmpCwd);

    // Track global call ordering across mocks by tagging vi.fn
    // callbacks with a monotonic sequence counter. We still mutate
    // the stateful-mock's `state` so the rest of the pipeline (which
    // does findExistingVm after cleanup) sees the post-delete world.
    let seq = 0;
    let deleteSeq = -1;
    let createSeq = -1;
    backend.deleteVM = vi.fn().mockImplementation(async (h: VMHandle) => {
      deleteSeq = ++seq;
      state.vms = state.vms.filter((vm) => vm.name !== h.name);
      delete state.checkpoints[h.name];
    });
    backend.createVM = vi.fn().mockImplementation(async (cfg) => {
      createSeq = ++seq;
      const h = makeHandle(cfg.name);
      state.vms.push(h);
      return h;
    });

    await provisionVM(backend, {
      vmName: "force-vm",
      checkpointLabel: "agent-installed",
      force: true,
      guestMsiPath: msi,
    });

    expect(
      backend.deleteVM,
      "force=true must call deleteVM (teardown before rebuild)",
    ).toHaveBeenCalledTimes(1);
    expect(
      backend.createVM,
      "force=true must call createVM after teardown",
    ).toHaveBeenCalledTimes(1);
    expect(
      deleteSeq,
      `expected deleteVM (seq=${deleteSeq}) to fire before createVM (seq=${createSeq})`,
    ).toBeLessThan(createSeq);
  });
});

// ── 5. cleanupVM × 3 ──────────────────────────────────────────────

describe("cleanupVM × 3 (no-op after first run)", () => {
  it("Run 1 deletes; Runs 2 + 3 are no-ops with deleteVM never called again", async () => {
    const handle = makeHandle("cleanup-vm");
    const { backend, state } = makeStatefulBackend({ vms: [handle] });

    // Run 1: VM exists → deleteVM fires.
    await expect(cleanupVM(backend, "cleanup-vm")).resolves.toBeUndefined();
    expect(backend.deleteVM).toHaveBeenCalledTimes(1);
    expect(state.vms.length).toBe(0);

    // Runs 2 + 3: VM is gone → deleteVM must NOT fire again, no throw.
    for (const run of [2, 3]) {
      const callsBefore = (backend.deleteVM as ReturnType<typeof vi.fn>).mock
        .calls.length;
      await expect(
        cleanupVM(backend, "cleanup-vm"),
        `cleanupVM run ${run}: should not throw when VM is already gone`,
      ).resolves.toBeUndefined();
      expect(
        (backend.deleteVM as ReturnType<typeof vi.fn>).mock.calls.length,
        `cleanupVM run ${run}: deleteVM was called again on idempotent path`,
      ).toBe(callsBefore);
    }
  });
});

// ── 6. installBundle × 3 ──────────────────────────────────────────

describe("installBundle × 3 (already-installed signal flips installed→skipped)", () => {
  /**
   * Build a guest-client mock whose `installSoftware` returns "real
   * install" stdout on the first N calls and "Package already
   * installed" stdout afterwards. The real installBundle decoder
   * (`isAlreadyInstalled`) reads stdout/stderr — there's no separate
   * `alreadyInstalled` boolean on the wire today.
   */
  function makeAlreadyAfterFirstClient(
    bundleSize: number,
  ): BundleCapableClient {
    let callsSoFar = 0;
    return {
      connectionState: "connected",
      isConnected: vi.fn().mockResolvedValue(true),
      dispose: vi.fn(),
      close: vi.fn(),
      runCommand: vi.fn().mockResolvedValue({
        exitCode: 0,
        stdout: "",
        stderr: "",
        durationMs: 5,
      }),
      installSoftware: vi.fn().mockImplementation(async () => {
        callsSoFar++;
        // First `bundleSize` calls report a fresh install; everything
        // after reports "already installed" (idempotent backend).
        if (callsSoFar <= bundleSize) {
          return {
            success: true,
            exitCode: 0,
            stdout: "Successfully installed",
            stderr: "",
            installedPath: "C:\\test",
          };
        }
        return {
          success: true,
          exitCode: 0,
          stdout: "Package already installed",
          stderr: "",
          installedPath: "C:\\test",
        };
      }),
      installDirect: vi.fn(),
      installDocker: vi.fn(),
    } as unknown as BundleCapableClient;
  }

  it("Run 1 reports installed=N,skipped=0; Runs 2 + 3 report installed=0,skipped=N", async () => {
    const bundle = parseBundle({
      apiVersion: "signalman.dev/v1alpha1",
      kind: "Bundle",
      metadata: { name: "ensure" },
      packages: [
        { id: "Git.Git", source: "winget" },
        { id: "nodejs-lts", source: "choco" },
        { id: "Microsoft.PowerShell", source: "winget" },
      ],
    });
    const N = 3;
    const client = makeAlreadyAfterFirstClient(N);
    const backend = {
      name: "mock",
      isAvailable: vi.fn().mockResolvedValue(true),
    } as unknown as HypervisorBackend;

    const r1 = await installBundle(
      backend,
      client as unknown as GuestAgentClient,
      "ensure-vm",
      bundle,
    );
    expect(r1.installed).toBe(N);
    expect(r1.skipped).toBe(0);
    expect(r1.failed).toBe(0);

    for (const run of [2, 3]) {
      const r = await installBundle(
        backend,
        client as unknown as GuestAgentClient,
        "ensure-vm",
        bundle,
      );
      expect(
        r.installed,
        `installBundle run ${run}: expected installed=0 (already-installed signal ignored?)`,
      ).toBe(0);
      expect(
        r.skipped,
        `installBundle run ${run}: expected skipped=${N}`,
      ).toBe(N);
      expect(r.failed).toBe(0);
    }
  });
});

// ── 7. fetchTemplateImage × 3 ─────────────────────────────────────

describe("fetchTemplateImage × 3 (cache miss → cache hit × 2)", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "p94-fetch-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("Run 1: cached=false, fetch called once. Runs 2 + 3: cached=true, fetch never re-invoked.", async () => {
    const body = Buffer.from("ensure-cache-bytes-payload");
    const sha = sha256Hex(body);
    const { fn, calls } = countingFetch(body);

    const r1 = await fetchTemplateImage({
      templateName: "ensure-tmpl",
      url: "https://example.com/ensure.vhdx",
      expectedSha256: sha,
      cacheDir: tmp,
      fetchImpl: fn,
    });
    expect(r1.cached).toBe(false);
    expect(calls()).toBe(1);

    for (const run of [2, 3]) {
      const r = await fetchTemplateImage({
        templateName: "ensure-tmpl",
        url: "https://example.com/ensure.vhdx",
        expectedSha256: sha,
        cacheDir: tmp,
        fetchImpl: fn,
      });
      expect(
        r.cached,
        `fetchTemplateImage run ${run}: expected cached=true (cache hit)`,
      ).toBe(true);
      expect(
        calls(),
        `fetchTemplateImage run ${run}: fetch was called again on cache hit`,
      ).toBe(1);
      // Re-verifies SHA from disk on every cache hit — the file must
      // still be there after the cache-hit path returned.
      expect(fs.existsSync(r.vhdxPath)).toBe(true);
    }
  });

  it("cache hit re-verifies SHA from disk (corrupting the cache forces a re-download)", async () => {
    const body = Buffer.from("verify-on-hit");
    const sha = sha256Hex(body);
    const { fn, calls } = countingFetch(body);

    // Run 1: download.
    const r1 = await fetchTemplateImage({
      templateName: "verify-tmpl",
      url: "https://example.com/v.vhdx",
      expectedSha256: sha,
      cacheDir: tmp,
      fetchImpl: fn,
    });
    expect(calls()).toBe(1);
    expect(r1.cached).toBe(false);

    // Tamper with the cached bytes between runs. The next call must
    // detect the SHA drift and fall through to re-download instead
    // of silently returning the corrupt file.
    fs.writeFileSync(r1.vhdxPath, "tampered-bytes");

    const r2 = await fetchTemplateImage({
      templateName: "verify-tmpl",
      url: "https://example.com/v.vhdx",
      expectedSha256: sha,
      cacheDir: tmp,
      fetchImpl: fn,
    });
    expect(
      calls(),
      "tampered cache must force a re-download (SHA re-verified on every hit)",
    ).toBe(2);
    expect(r2.cached).toBe(false);
    // Final file is the canonical one again.
    expect(fs.readFileSync(r2.vhdxPath)).toEqual(body);
  });
});

// ── 8. End-to-end ensure semantics ────────────────────────────────

describe("end-to-end ensure semantics (init → fetch → provision → install) × 2", () => {
  let savedCwd: string;
  let tmpCwd: string;
  let cacheDir: string;

  beforeEach(() => {
    savedCwd = process.cwd();
    tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), "p94-e2e-"));
    cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "p94-e2e-cache-"));
    stageFakeSharedCerts(tmpCwd);
    process.chdir(tmpCwd);
  });
  afterEach(() => {
    process.chdir(savedCwd);
    fs.rmSync(tmpCwd, { recursive: true, force: true });
    fs.rmSync(cacheDir, { recursive: true, force: true });
    try {
      fs.rmSync(path.join(os.tmpdir(), `signalman-provision-ensure-e2e-vm`), {
        recursive: true,
        force: true,
      });
    } catch {
      /* swallow */
    }
  });

  it("second pass reports already-done at every step (init skipped, fetch cached, provision idempotent, install skipped)", async () => {
    const body = Buffer.from("e2e-ensure-bytes");
    const sha = sha256Hex(body);
    const { fn: fetchFn, calls: fetchCalls } = countingFetch(body);
    const { backend } = makeStatefulBackend();

    const bundle = parseBundle({
      apiVersion: "signalman.dev/v1alpha1",
      kind: "Bundle",
      metadata: { name: "e2e-ensure" },
      packages: [
        { id: "Git.Git", source: "winget" },
        { id: "nodejs-lts", source: "choco" },
      ],
    });

    // Stateful client: returns "fresh install" stdout on Pass 1 and
    // "already installed" on Pass 2 — mirrors the real package
    // manager's idempotency story.
    let installPass = 1;
    const client: BundleCapableClient = {
      connectionState: "connected",
      isConnected: vi.fn().mockResolvedValue(true),
      dispose: vi.fn(),
      close: vi.fn(),
      runCommand: vi.fn().mockResolvedValue({
        exitCode: 0,
        stdout: "",
        stderr: "",
        durationMs: 5,
      }),
      installSoftware: vi.fn().mockImplementation(async () => ({
        success: true,
        exitCode: 0,
        stdout: installPass === 1 ? "Successfully installed" : "Package already installed",
        stderr: "",
        installedPath: "C:\\test",
      })),
      installDirect: vi.fn(),
      installDocker: vi.fn(),
    } as unknown as BundleCapableClient;

    // ── Pass 1: cold ──
    const initR1 = runInit({ cwd: tmpCwd });
    expect(initR1.filesCreated.length).toBeGreaterThanOrEqual(6);

    const fetchR1 = await fetchTemplateImage({
      templateName: "e2e-tmpl",
      url: "https://example.com/e2e.vhdx",
      expectedSha256: sha,
      cacheDir,
      fetchImpl: fetchFn,
    });
    expect(fetchR1.cached).toBe(false);
    expect(fetchCalls()).toBe(1);

    const msi = stageFakeMsi(tmpCwd);
    const provR1 = await provisionVM(backend, {
      vmName: "ensure-e2e-vm",
      checkpointLabel: "agent-installed",
      guestMsiPath: msi,
    });
    expect(provR1.alreadyProvisioned).toBe(false);

    const instR1 = await installBundle(
      backend,
      client as unknown as GuestAgentClient,
      "ensure-e2e-vm",
      bundle,
    );
    expect(instR1.installed).toBe(2);
    expect(instR1.skipped).toBe(0);

    // ── Pass 2: every step must report already-done ──
    installPass = 2;

    const t0 = Date.now();

    const initR2 = runInit({ cwd: tmpCwd });
    expect(
      initR2.filesCreated,
      "e2e pass 2: runInit re-created files (idempotency regression)",
    ).toEqual([]);
    expect(initR2.filesSkipped.length).toBeGreaterThanOrEqual(6);

    const fetchR2 = await fetchTemplateImage({
      templateName: "e2e-tmpl",
      url: "https://example.com/e2e.vhdx",
      expectedSha256: sha,
      cacheDir,
      fetchImpl: fetchFn,
    });
    expect(
      fetchR2.cached,
      "e2e pass 2: fetchTemplateImage missed the cache",
    ).toBe(true);
    expect(
      fetchCalls(),
      "e2e pass 2: fetch was re-invoked despite warm cache",
    ).toBe(1);

    const provR2 = await provisionVM(backend, {
      vmName: "ensure-e2e-vm",
      checkpointLabel: "agent-installed",
      guestMsiPath: msi,
    });
    expect(
      provR2.alreadyProvisioned,
      "e2e pass 2: provisionVM did not detect the existing checkpoint",
    ).toBe(true);

    const instR2 = await installBundle(
      backend,
      client as unknown as GuestAgentClient,
      "ensure-e2e-vm",
      bundle,
    );
    expect(
      instR2.installed,
      "e2e pass 2: installBundle re-installed packages (already-installed signal lost)",
    ).toBe(0);
    expect(
      instR2.skipped,
      "e2e pass 2: installBundle should have reported skipped=N",
    ).toBe(2);

    const elapsed = Date.now() - t0;
    // Generous bound: even a slow CI box should clear the four
    // already-done verbs in well under a second. A regression that
    // re-runs any step would blow this out by orders of magnitude.
    expect(
      elapsed,
      `e2e pass 2 took ${elapsed} ms; expected <2000 ms (a step likely re-ran)`,
    ).toBeLessThan(2000);
  });
});
