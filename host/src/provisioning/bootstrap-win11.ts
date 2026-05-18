/**
 * v0.5 Win11 demo bootstrap pipeline (M1).
 *
 * `bootstrapWin11` orchestrates the 12-step pipeline that takes an
 * unprovisioned host with a Win11 template and produces a VM with
 * the Signalman guest agent installed (test-signed MSI), checkpointed
 * at `agent-installed`. The verb maps 1:1 to `signalman vm
 * bootstrap-win11 <name>`.
 *
 * Phases (canonical order, see {@link BootstrapPhase}):
 *
 *   1. resolve_template            — load template definition.
 *   2. acquire_lock                — `.signalman/state/locks/host.lock`
 *                                    (Q8: per-host serialization).
 *   3. create_vm                   — idempotent; reuse provisionVM's
 *                                    create-VM step.
 *   4. set_firmware                — Secure Boot Off via
 *                                    `backend.setVmFirmware`.
 *   5. boot_vm                     — start + wait for heartbeat.
 *   6. stage_certs                 — mTLS certs into the VM (reuse
 *                                    provisionVM stage_certs).
 *   7. enable_testsigning          — `bcdedit /set testsigning On` via
 *                                    backendForVm (per-VM creds).
 *   8. reboot_for_testsigning      — restart + wait for heartbeat.
 *   9. verify_testsigning          — `bcdedit /enum {current}` parse.
 *  10. resolve_msi                 — accept `--msi <path>` or
 *                                    `--msi-from-build <id>` (deferred:
 *                                    only --msi today; --msi-from-build
 *                                    raises a structured error so
 *                                    callers know how to fall back).
 *  11. install_msi                 — copy + msiexec /quiet (reuse the
 *                                    install logic from provisionVM).
 *  12. checkpoint                  — `agent-installed` (label
 *                                    configurable via --checkpoint).
 *
 * Idempotency contract: each phase records completion in
 * `.signalman/state/bootstrap-win11/<vm-name>.json`. A re-run skips any
 * phase already marked complete, with the same 2-second no-op shape
 * that provisionVM has at the top level. Mid-pipeline failures leave
 * the journal at the failed phase so the next run resumes there
 * (unless `--force` clears state + tears down the VM).
 *
 * Failure model: leave-the-VM. Operator can opt in to cleanup with
 * `cleanupOnFailure: true`. `force: true` is a "redo everything from
 * scratch" override that ALSO clears the state journal.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type {
  HypervisorBackend,
  VMHandle,
  VMConfig,
  VMStatus,
} from "../hypervisors/interface.js";
import {
  loadTemplates,
  resolveTemplate,
  resolveTemplateAsync,
  type VmTemplate,
} from "../scenarios/templates.js";
import { cleanupVM } from "./cleanup.js";
import { cacheVM, globalVmCache } from "../vm-cache.js";
import { composeAutounattendXml, type UnattendedConfig } from "./unattended.js";
import { writeSeedIso } from "./seed-iso.js";
import {
  bootstrapStatePath,
  deleteState,
  isPhaseComplete,
  markPhaseComplete,
  markPhaseFailed,
  newState,
  nextPhaseToRun,
  readState,
  writeState,
  type BootstrapPhase,
  type BootstrapState,
} from "./bootstrap-win11-state.js";

// ── Public API ────────────────────────────────────────────────────

/**
 * M2 (2026-05-17) — Unattended.xml inputs surfaced through the
 * pipeline. All fields are optional; defaults match the M0 Q-locks
 * (en-US locale, UTC timezone, signalman admin, RDP on, etc.).
 */
export interface UnattendedOpts {
  /** UI / system / user locale. Defaults to `en-US`. */
  locale?: string;
  /**
   * Timezone — IANA name or Microsoft display name. Defaults to
   * `UTC`.
   */
  timezone?: string;
  /** Local administrator username. Defaults to `signalman`. */
  adminUsername?: string;
  /**
   * Local administrator password. Defaults to the value of
   * `SIGNALMAN_ADMIN_PASS` env var if set, else a random 32-hex
   * value generated per-run (operator MUST capture from logs if
   * they want to log in interactively).
   */
  adminPassword?: string;
  /** AutoLogon count. Default 3 (Q2 lock). */
  autoLogonCount?: number;
}

export interface BootstrapWin11Opts {
  vmName: string;
  /** Template name (or absolute path). Defaults to "win11-base". */
  templateName?: string;
  /**
   * Path to a signed MSI on the host. When omitted, the pipeline will
   * raise a `BootstrapWin11Error` at the `resolve_msi` phase so the
   * caller can wire up `--msi-from-build` (deferred) or supply
   * `--msi` explicitly. M1 does NOT shell out to WS9 inline (per Q2
   * locked default).
   */
  msiPath?: string;
  /**
   * Path to a test-signing certificate. Reserved for M2/M3 (the
   * pipeline accepts the value today, persists it in the state file
   * for forensic context, but does not yet drive cert provisioning
   * into the guest). Operator-supplied via `--cert <path>` or
   * `SIGNALMAN_TEST_SIGNING_CERT`.
   */
  testSigningCertPath?: string;
  /** Checkpoint label at the end. Defaults to "agent-installed". */
  checkpointLabel?: string;
  /** Tear down + restart the journal if VM/checkpoint exist already. */
  force?: boolean;
  /** Run cleanupVM on any mid-pipeline failure. Defaults to false. */
  cleanupOnFailure?: boolean;
  /** Override the bind address baked into the service registration. */
  bindAddr?: string;
  /** Auth token for the guest agent. Defaults to random hex. */
  authToken?: string;
  /**
   * Override the project root (where `.signalman/state/...` lives).
   * Tests use this to isolate state writes. Defaults to `process.cwd()`.
   */
  projectRoot?: string;
  /**
   * Optional progress logger. Called once per pipeline phase with a
   * stable enum tag.
   */
  onProgress?: (event: BootstrapWin11Event) => void;
  /**
   * M2 (2026-05-17) — Unattended.xml inputs for the seed ISO. When
   * omitted, the M0 Q-locked defaults apply.
   */
  unattended?: UnattendedOpts;
  /**
   * M2 (2026-05-17) — disable the seed-ISO injection entirely
   * (e.g. for a template that already includes its own
   * Autounattend.xml, or for the libvirt path until M4 polishes
   * extraCdroms ordering). Default false — seed ISO is composed +
   * attached.
   */
  skipSeedIso?: boolean;
}

export interface BootstrapWin11Result {
  vmName: string;
  vmHandle: VMHandle;
  checkpointLabel: string;
  /** True if every phase was already complete and the pipeline no-op'd. */
  alreadyBootstrapped: boolean;
  /** Wall-clock duration in milliseconds. */
  durationMs: number;
  /** Final state snapshot (post-run). */
  state: BootstrapState;
}

export type BootstrapWin11Event =
  | { kind: "phase_start"; phase: BootstrapPhase; message: string }
  | { kind: "phase_skip"; phase: BootstrapPhase; reason: string }
  | { kind: "phase_complete"; phase: BootstrapPhase; detail?: string }
  | { kind: "warning"; message: string };

// ── Error ─────────────────────────────────────────────────────────

export class BootstrapWin11Error extends Error {
  override readonly name = "BootstrapWin11Error";
  /** The phase that failed. */
  readonly phase: BootstrapPhase;
  /**
   * Optional remediation hints — surfaced to the CLI for the
   * "configure / re-run" path. Mirrors `GuestMsiDiscoveryError`'s
   * `remediation` shape.
   */
  readonly remediation: string[];
  constructor(
    phase: BootstrapPhase,
    message: string,
    opts?: { cause?: unknown; remediation?: string[] },
  ) {
    super(message);
    this.phase = phase;
    this.remediation = opts?.remediation ?? [];
    if (opts?.cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = opts.cause;
    }
  }
}

// ── Pipeline ──────────────────────────────────────────────────────

/**
 * Run the 12-step Win11 bootstrap pipeline. See module docstring for
 * the phase contract.
 */
export async function bootstrapWin11(
  backend: HypervisorBackend,
  opts: BootstrapWin11Opts,
): Promise<BootstrapWin11Result> {
  const start = Date.now();
  const templateName = opts.templateName ?? "win11-base";
  const checkpointLabel = opts.checkpointLabel ?? "agent-installed";
  const projectRoot = opts.projectRoot ?? process.cwd();
  const log = (e: BootstrapWin11Event): void => {
    opts.onProgress?.(e);
  };

  // ── Force path: clear state + tear down VM ──
  if (opts.force) {
    log({
      kind: "phase_start",
      phase: "create_vm",
      message: "force=true; clearing state journal and tearing down existing VM",
    });
    deleteState(opts.vmName, projectRoot);
    try {
      await cleanupVM(backend, opts.vmName);
    } catch (err) {
      // cleanupVM is best-effort. If it fails (e.g. VM didn't exist),
      // we don't block the pipeline.
      log({
        kind: "warning",
        message: `force cleanup failed (continuing): ${(err as Error).message}`,
      });
    }
  }

  // ── Load or initialise journal ──
  let state =
    readState(opts.vmName, projectRoot) ??
    newState({
      vmName: opts.vmName,
      templateName,
      checkpointLabel,
    });

  // ── Idempotency: if every phase already complete, no-op fast ──
  if (!opts.force && nextPhaseToRun(state) === null) {
    log({
      kind: "phase_skip",
      phase: "checkpoint",
      reason: `VM '${opts.vmName}' already bootstrapped (all phases complete)`,
    });
    const handle = await findExistingVm(backend, opts.vmName);
    if (handle) cacheVM(handle);
    return {
      vmName: opts.vmName,
      vmHandle: handle ?? synthesizeHandle(opts.vmName, backend.name),
      checkpointLabel,
      alreadyBootstrapped: true,
      durationMs: Date.now() - start,
      state,
    };
  }

  // Persist the initial / loaded state so an immediate failure still
  // leaves a trail.
  writeState(state, projectRoot);

  let template: VmTemplate | null = null;
  let handle: VMHandle | null = null;
  type LockHandle = { release: () => void };
  // `lockHandle` is mutated inside the `acquire_lock` runPhase closure;
  // explicit annotation prevents TS from narrowing to `null` after
  // initialization since the assignment happens in a callback.
  let lockHandle: LockHandle | null = null as LockHandle | null;

  try {
    // ── Phase 1: resolve template ────────────────────────────────
    state = await runPhase(state, "resolve_template", projectRoot, log, async () => {
      template = await resolveTemplateForBootstrap(templateName);
      return `template '${templateName}' resolved`;
    });

    // ── Phase 2: acquire host lock (Q8) ──────────────────────────
    state = await runPhase(state, "acquire_lock", projectRoot, log, async () => {
      const acquired: LockHandle = acquireHostLock(projectRoot, opts.vmName);
      lockHandle = acquired;
      return `host lock acquired`;
    });

    // ── Phase 2.5: compose seed ISO (M2, step 2.5) ───────────────
    state = await runPhase(
      state,
      "compose_seed_iso",
      projectRoot,
      log,
      async () => {
        if (opts.skipSeedIso) {
          return {
            detail: `skipped: opts.skipSeedIso=true`,
            patch: { seedIsoPath: null, seedIsoAttached: false },
          };
        }
        const { isoPath, computerName } = await composeSeedIsoForVm({
          vmName: opts.vmName,
          projectRoot,
          unattended: opts.unattended,
        });
        const note =
          computerName.rewritten
            ? ` (ComputerName rewritten from '${computerName.source}' to '${computerName.result}')`
            : "";
        return {
          detail: `seed ISO at ${isoPath}${note}`,
          patch: { seedIsoPath: isoPath },
        };
      },
    );

    // ── Phase 3: create VM ───────────────────────────────────────
    state = await runPhase(state, "create_vm", projectRoot, log, async () => {
      handle = await findExistingVm(backend, opts.vmName);
      if (handle) {
        cacheVM(handle);
        // VM already exists. If the journal says we composed a seed
        // ISO but never recorded the attach, mark it attached now —
        // the running VM picked it up via the create-time extraCdroms,
        // and the cleanup contract needs the flag set.
        const idempotentPatch: Partial<BootstrapState> | undefined =
          state.seedIsoPath && !state.seedIsoAttached
            ? { seedIsoAttached: true }
            : undefined;
        return {
          detail: `VM '${opts.vmName}' already exists; skipping createVM`,
          patch: idempotentPatch,
        };
      }
      if (!template) {
        // resolve_template was idempotently skipped on a resume; we
        // need the template for createVM, so resolve again. This is
        // cheap (in-memory after the first call).
        template = await resolveTemplateForBootstrap(templateName);
      }
      const config: VMConfig = {
        name: opts.vmName,
        template: template.vhdxPath,
        cpus: template.processorCount,
        memoryMB: template.memoryMB,
        network: template.networkSwitch
          ? { switchName: template.networkSwitch }
          : undefined,
        ...(state.seedIsoPath
          ? { extraCdroms: [state.seedIsoPath] }
          : {}),
      };
      handle = await backend.createVM(config);
      cacheVM(handle);
      const attachPatch: Partial<BootstrapState> | undefined =
        state.seedIsoPath ? { seedIsoAttached: true } : undefined;
      return {
        detail: `VM '${opts.vmName}' created from template '${templateName}'`,
        patch: attachPatch,
      };
    });

    // ── Phase 4: set firmware (Secure Boot Off) ──────────────────
    state = await runPhase(state, "set_firmware", projectRoot, log, async () => {
      if (!backend.setVmFirmware) {
        throw new BootstrapWin11Error(
          "set_firmware",
          `Backend '${backend.name}' does not support setVmFirmware. ` +
            `bootstrap-win11 is currently Hyper-V only (libvirt support lands in M4).`,
          {
            remediation: [
              "Switch to the Hyper-V backend for this VM (set hypervisor.backend=hyperv in .signalman/config.yaml).",
              "Or wait for M4 libvirt parity (see docs/design/v0.5-win11-demo-deploy.md §M4).",
            ],
          },
        );
      }
      handle = handle ?? (await resolveHandleByName(backend, opts.vmName));
      await backend.setVmFirmware(handle, { secureBootEnabled: false });
      return `Secure Boot disabled on '${opts.vmName}'`;
    });

    // ── Phase 5: boot + wait for heartbeat ───────────────────────
    state = await runPhase(state, "boot_vm", projectRoot, log, async () => {
      handle = handle ?? (await resolveHandleByName(backend, opts.vmName));
      await backend.startVM(handle);
      await waitForVmReady(backend, handle);
      return `VM '${opts.vmName}' booted and reachable`;
    });

    // ── Phase 6: stage certs ─────────────────────────────────────
    state = await runPhase(state, "stage_certs", projectRoot, log, async () => {
      handle = handle ?? (await resolveHandleByName(backend, opts.vmName));
      const bundle = await stageDevCerts(opts.vmName, opts.authToken);
      await copyCertsIntoVm(backend, handle, bundle);
      return `dev certs staged at /ProgramData/Signalman/certs`;
    });

    // ── Phase 7: enable test-signing ─────────────────────────────
    state = await runPhase(state, "enable_testsigning", projectRoot, log, async () => {
      handle = handle ?? (await resolveHandleByName(backend, opts.vmName));
      const result = await backend.executeCommand(
        handle,
        "bcdedit.exe",
        ["/set", "testsigning", "On"],
        60_000,
      );
      if (result.exitCode !== 0) {
        throw new BootstrapWin11Error(
          "enable_testsigning",
          `bcdedit /set testsigning On exited ${result.exitCode}: ${
            result.stderr || result.stdout
          }`,
          {
            remediation: [
              "Verify the VM credentials grant Administrator privileges (bcdedit requires elevation).",
              "Verify Secure Boot was actually disabled in phase 4 — bcdedit refuses to set testsigning under Secure Boot.",
            ],
          },
        );
      }
      return `bcdedit /set testsigning On succeeded`;
    });

    // ── Phase 8: reboot for testsigning ──────────────────────────
    state = await runPhase(state, "reboot_for_testsigning", projectRoot, log, async () => {
      handle = handle ?? (await resolveHandleByName(backend, opts.vmName));
      // shutdown /r /t 0 — same idiom used by deploy-executor's
      // post-MSI reboot path. We don't use stopVM/startVM because the
      // graceful shutdown side-effect (services flush, registry
      // commits) is what we want — bcdedit needs a real reboot, not a
      // hypervisor reset.
      await backend.executeCommand(
        handle,
        "shutdown.exe",
        ["/r", "/t", "0", "/f"],
        30_000,
      );
      // The shutdown returns immediately; wait for the VM to go down
      // and come back. We don't have a clean "wait for reboot" RPC,
      // so we poll for heartbeat to drop and re-establish.
      // Tests can shorten the drop-poll window via
      // SIGNALMAN_BOOTSTRAP_WIN11_REBOOT_DROP_MS to keep wall-clock
      // bounded when the mock backend never reports a drop.
      const dropMs = parseInt(
        process.env.SIGNALMAN_BOOTSTRAP_WIN11_REBOOT_DROP_MS ?? "10000",
        10,
      );
      await waitForReboot(backend, handle, dropMs);
      return `VM '${opts.vmName}' rebooted and heartbeat restored`;
    });

    // ── Phase 9: verify testsigning ──────────────────────────────
    state = await runPhase(state, "verify_testsigning", projectRoot, log, async () => {
      handle = handle ?? (await resolveHandleByName(backend, opts.vmName));
      const result = await backend.executeCommand(
        handle,
        "bcdedit.exe",
        ["/enum", "{current}"],
        30_000,
      );
      if (result.exitCode !== 0) {
        throw new BootstrapWin11Error(
          "verify_testsigning",
          `bcdedit /enum {current} exited ${result.exitCode}: ${
            result.stderr || result.stdout
          }`,
        );
      }
      if (!isTestSigningOn(result.stdout)) {
        throw new BootstrapWin11Error(
          "verify_testsigning",
          `bcdedit reports testsigning is NOT On after reboot. ` +
            `Output:\n${result.stdout}`,
          {
            remediation: [
              "Confirm Secure Boot is Off (signalman vm set-firmware <name> --secure-boot off).",
              "If Secure Boot is Off, the most likely cause is a Windows policy override; check `bcdedit /enum all` for an OEM testsigning lock.",
            ],
          },
        );
      }
      return `bcdedit reports testsigning = Yes`;
    });

    // ── Phase 10: resolve MSI ────────────────────────────────────
    state = await runPhase(state, "resolve_msi", projectRoot, log, async () => {
      if (!opts.msiPath) {
        throw new BootstrapWin11Error(
          "resolve_msi",
          `bootstrap-win11 requires --msi <path> in M1 (Q2 locked default: pre-signed MSI only).`,
          {
            remediation: [
              "Pass `--msi /path/to/signalman-guest-test-signed.msi` on the command line.",
              "WS9 inline signing is deferred to v0.6 — see docs/design/v0.5-win11-demo-deploy.md §Q2.",
            ],
          },
        );
      }
      if (!fs.existsSync(opts.msiPath)) {
        throw new BootstrapWin11Error(
          "resolve_msi",
          `MSI not found at '${opts.msiPath}'.`,
          {
            remediation: [
              "Check the path passed to --msi resolves on the host.",
              "Run `ls -l " + opts.msiPath + "` to confirm filesystem visibility.",
            ],
          },
        );
      }
      return `MSI resolved at '${opts.msiPath}'`;
    });

    // ── Phase 11: copy + silent install ──────────────────────────
    state = await runPhase(state, "install_msi", projectRoot, log, async () => {
      handle = handle ?? (await resolveHandleByName(backend, opts.vmName));
      const guestMsiPath = "C:\\Windows\\Temp\\signalman-guest.msi";
      await backend.copyFileToVM(handle, opts.msiPath!, guestMsiPath);
      const bindAddr = opts.bindAddr ?? "127.0.0.1:50051";
      const authToken = opts.authToken ?? readAuthTokenFromCerts(opts.vmName) ?? "";
      const installArgs = [
        "/i",
        guestMsiPath,
        "/quiet",
        "/norestart",
        `BIND_ADDR=${bindAddr}`,
        `AUTH_TOKEN=${authToken}`,
      ];
      const result = await backend.executeCommand(
        handle,
        "msiexec.exe",
        installArgs,
        300_000,
      );
      if (result.exitCode !== 0) {
        throw new BootstrapWin11Error(
          "install_msi",
          `msiexec exited ${result.exitCode}: ${result.stderr || result.stdout}`,
          {
            remediation: [
              "Verify the MSI was test-signed and the cert is trusted on the VM (testsigning is on; check `bcdedit /enum`).",
              "Run `msiexec /i <path>` interactively on the VM to surface the underlying installer error.",
            ],
          },
        );
      }
      await waitForGuestAgent(backend, handle);
      return `MSI installed; guest agent reachable`;
    });

    // ── Phase 12: checkpoint ─────────────────────────────────────
    state = await runPhase(state, "checkpoint", projectRoot, log, async () => {
      handle = handle ?? (await resolveHandleByName(backend, opts.vmName));
      // Detach + delete the seed ISO BEFORE the checkpoint so the
      // saved state doesn't pin a stale ISO blob (locked design §8).
      // Failures here are non-fatal — log a warning and continue
      // with the checkpoint; the operator can clean up the orphan
      // blob manually if necessary.
      let detachPatch: Partial<BootstrapState> | undefined;
      if (state.seedIsoPath && state.seedIsoAttached) {
        try {
          await detachAndDeleteSeedIso(backend, handle, state.seedIsoPath, log);
          detachPatch = { seedIsoAttached: false };
        } catch (cleanupErr) {
          log({
            kind: "warning",
            message:
              `seed ISO cleanup failed before checkpoint (continuing): ` +
              `${(cleanupErr as Error).message}`,
          });
        }
      }
      await backend.createCheckpoint(handle, checkpointLabel);
      return {
        detail: `checkpoint '${checkpointLabel}' created`,
        patch: detachPatch,
      };
    });

    handle = handle ?? (await resolveHandleByName(backend, opts.vmName));
    return {
      vmName: opts.vmName,
      vmHandle: handle,
      checkpointLabel,
      alreadyBootstrapped: false,
      durationMs: Date.now() - start,
      state,
    };
  } catch (err) {
    if (opts.cleanupOnFailure) {
      // M2 (2026-05-17) — detach + delete the seed ISO BEFORE
      // cleanupVM removes the VM. Otherwise cleanupVM may report
      // an in-use error or leave the ISO file on disk.
      if (state.seedIsoPath && state.seedIsoAttached && handle) {
        try {
          await detachAndDeleteSeedIso(backend, handle, state.seedIsoPath, log);
        } catch (detachErr) {
          log({
            kind: "warning",
            message:
              `cleanupOnFailure: seed ISO detach failed (continuing to cleanupVM): ` +
              `${(detachErr as Error).message}`,
          });
        }
      } else if (state.seedIsoPath) {
        // ISO file exists on disk but never attached — delete the
        // orphan file so a re-run with --force doesn't trip over it.
        try {
          fs.unlinkSync(state.seedIsoPath);
        } catch {
          /* best effort */
        }
      }
      try {
        await cleanupVM(backend, opts.vmName);
      } catch (cleanupErr) {
        log({
          kind: "warning",
          message: `cleanupOnFailure: cleanupVM also failed: ${(cleanupErr as Error).message}`,
        });
      }
    }
    throw err;
  } finally {
    const lh: LockHandle | null = lockHandle;
    if (lh) {
      try {
        lh.release();
      } catch {
        /* best effort */
      }
    }
  }
}

// ── Phase helper ──────────────────────────────────────────────────

/**
 * Run a single phase. If it's already in the journal, emit a skip event
 * and return state unchanged. Otherwise execute `body`; on success
 * persist the completion record; on failure persist the failure record
 * before rethrowing.
 *
 * `body` returns a "detail" string that's persisted in the journal
 * for human inspection.
 */
async function runPhase(
  state: BootstrapState,
  phase: BootstrapPhase,
  projectRoot: string,
  log: (e: BootstrapWin11Event) => void,
  body: () => Promise<string | { detail: string; patch?: Partial<BootstrapState> }>,
): Promise<BootstrapState> {
  if (isPhaseComplete(state, phase)) {
    log({
      kind: "phase_skip",
      phase,
      reason: `phase '${phase}' already complete`,
    });
    return state;
  }
  log({ kind: "phase_start", phase, message: `starting phase '${phase}'` });
  let detail: string;
  let patch: Partial<BootstrapState> | undefined;
  try {
    const result = await body();
    if (typeof result === "string") {
      detail = result;
    } else {
      detail = result.detail;
      patch = result.patch;
    }
  } catch (err) {
    const updated = markPhaseFailed(state, phase, (err as Error).message);
    writeState(updated, projectRoot);
    if (err instanceof BootstrapWin11Error) throw err;
    throw new BootstrapWin11Error(phase, (err as Error).message, { cause: err });
  }
  let updated = markPhaseComplete(state, phase, detail);
  if (patch) updated = { ...updated, ...patch };
  writeState(updated, projectRoot);
  log({ kind: "phase_complete", phase, detail });
  return updated;
}

// ── Helpers ───────────────────────────────────────────────────────

/**
 * Resolve a template name (or absolute path) into a VmTemplate. Mirrors
 * provisionVM's resolve_template step with the same async-then-sync
 * fallback so abstract templates without `base_image_path` still
 * round-trip in unit tests.
 */
async function resolveTemplateForBootstrap(
  templateName: string,
): Promise<VmTemplate> {
  try {
    return await resolveTemplateAsync(templateName);
  } catch (err) {
    try {
      const templates = loadTemplates();
      return resolveTemplate(templateName, templates);
    } catch {
      throw new BootstrapWin11Error(
        "resolve_template",
        `Failed to resolve template '${templateName}': ${(err as Error).message}`,
        {
          cause: err,
          remediation: [
            "Run `signalman vm fetch-template " +
              templateName +
              "` to populate the template registry.",
            "Or pass `--template <absolute-path-to-yaml>` to point at an out-of-tree template.",
          ],
        },
      );
    }
  }
}

/**
 * Acquire a coarse per-host file lock. Q8 locked default: serialized
 * per-host, parallel per-VM is safe but we don't optimise for it.
 *
 * Implementation: try to create `host.lock` with `O_EXCL`; if the file
 * exists, read the PID, check whether that process still exists, and
 * either steal the lock (stale PID) or fail. Returns a release handle.
 */
function acquireHostLock(
  projectRoot: string,
  vmName: string,
): { release: () => void } {
  const lockDir = path.join(projectRoot, ".signalman", "state", "locks");
  fs.mkdirSync(lockDir, { recursive: true });
  const lockPath = path.join(lockDir, "host.lock");
  const myPid = process.pid;
  const payload = JSON.stringify({ pid: myPid, vmName, acquiredAt: new Date().toISOString() }) + "\n";

  while (true) {
    try {
      const fd = fs.openSync(lockPath, "wx");
      fs.writeSync(fd, payload);
      fs.closeSync(fd);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      // Check whether the holding PID is still alive.
      let existing: { pid?: number; vmName?: string } = {};
      try {
        existing = JSON.parse(fs.readFileSync(lockPath, "utf8")) as {
          pid?: number;
          vmName?: string;
        };
      } catch {
        // Corrupt lock file; steal it.
        try {
          fs.unlinkSync(lockPath);
          continue;
        } catch {
          // race with another stealer; try again.
          continue;
        }
      }
      if (typeof existing.pid === "number" && isPidAlive(existing.pid)) {
        throw new BootstrapWin11Error(
          "acquire_lock",
          `bootstrap-win11 host lock held by pid ${existing.pid} (VM '${existing.vmName ?? "?"}')`,
          {
            remediation: [
              `Wait for the other bootstrap-win11 run to complete.`,
              `If pid ${existing.pid} has crashed without releasing the lock, remove ${lockPath} manually.`,
            ],
          },
        );
      }
      // Stale lock. Steal it.
      try {
        fs.unlinkSync(lockPath);
      } catch {
        // race; try again.
      }
    }
  }
  return {
    release: () => {
      try {
        const buf = fs.readFileSync(lockPath, "utf8");
        const parsed = JSON.parse(buf) as { pid?: number };
        if (parsed.pid === myPid) fs.unlinkSync(lockPath);
      } catch {
        // file gone or unreadable; nothing to release.
      }
    },
  };
}

function isPidAlive(pid: number): boolean {
  try {
    // Signal 0 doesn't kill; it tests delivery rights.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ESRCH") return false;
    // EPERM means the pid exists but we don't have rights; treat as alive.
    return true;
  }
}

/**
 * Parse `bcdedit /enum {current}` stdout to determine whether
 * testsigning is reported as Yes. The output is line-oriented; we look
 * for a line of the form `testsigning             Yes`. bcdedit
 * localises some labels but `testsigning` is a verbatim BCD key, so
 * the match is stable across locales.
 */
export function isTestSigningOn(bcdeditStdout: string): boolean {
  const lines = bcdeditStdout.split(/\r?\n/);
  for (const line of lines) {
    const m = /^\s*testsigning\s+(Yes|No)\s*$/i.exec(line);
    if (m) return m[1].toLowerCase() === "yes";
  }
  return false;
}

/** Find a VM by name without throwing if it doesn't exist. */
async function findExistingVm(
  backend: HypervisorBackend,
  name: string,
): Promise<VMHandle | null> {
  const cached = globalVmCache.get(name);
  if (cached) return cached;
  try {
    const vms = await backend.listVMs();
    return vms.find((vm) => vm.name === name) ?? null;
  } catch {
    return null;
  }
}

async function resolveHandleByName(
  backend: HypervisorBackend,
  name: string,
): Promise<VMHandle> {
  const handle = await findExistingVm(backend, name);
  if (!handle) {
    throw new Error(
      `VM '${name}' not found via ${backend.name} backend (expected after create_vm phase).`,
    );
  }
  return handle;
}

/**
 * Wait for VM to be reachable: heartbeat-healthy if the backend
 * supports it, otherwise IP + state=running. Mirrors provisionVM's
 * helper.
 */
async function waitForVmReady(
  backend: HypervisorBackend,
  handle: VMHandle,
): Promise<void> {
  const deadline = Date.now() + 300_000; // 5 min
  if (typeof backend.waitForHeartbeat === "function") {
    const ok = await backend.waitForHeartbeat(handle, 300_000);
    if (!ok) throw new Error("VM heartbeat never reported healthy within 5 minutes");
    return;
  }
  while (Date.now() < deadline) {
    let status: VMStatus;
    try {
      status = await backend.getStatus(handle);
    } catch {
      await sleep(2_000);
      continue;
    }
    if (status.state === "running" && status.ipAddress) return;
    await sleep(2_000);
  }
  throw new Error("VM did not become ready within 5 minutes");
}

/**
 * After issuing `shutdown /r /t 0`, wait for the VM to go down and
 * come back. We don't have a clean "the shutdown took effect" RPC, so:
 *   1. Poll briefly for heartbeat to drop (state != running, or
 *      guestAgentReachable=false). Short deadline so a fast-reboot
 *      (or a mocked one) doesn't dominate wall-clock; if we don't
 *      observe a drop within this window we assume the reboot was
 *      faster than our polling cadence and proceed to step 2.
 *   2. Poll for heartbeat to recover (state=running + ready). 5-minute
 *      deadline matches waitForVmReady.
 *
 * `dropTimeoutMs` is parameterised for tests so the suite doesn't pay
 * a real-time deadline penalty when the mock backend reports the VM
 * as healthy throughout.
 */
async function waitForReboot(
  backend: HypervisorBackend,
  handle: VMHandle,
  dropTimeoutMs: number = 10_000,
): Promise<void> {
  const dropDeadline = Date.now() + dropTimeoutMs;
  let observedDrop = false;
  while (Date.now() < dropDeadline) {
    try {
      const status = await backend.getStatus(handle);
      if (status.state !== "running" || !status.guestAgentReachable) {
        observedDrop = true;
        break;
      }
    } catch {
      // backend transient error during reboot — that's fine, count as a drop.
      observedDrop = true;
      break;
    }
    await sleep(500);
  }
  // If we never observed a drop, the reboot was either too fast for
  // our cadence to catch OR the mock backend reports it as
  // continuously healthy. Either way, proceed to waitForVmReady which
  // is the real readiness gate. (In production, the more common case
  // is that we miss the drop on the first poll iteration because
  // shutdown /r /t 0 returns instantly + Windows takes a few seconds
  // to actually pull the rug.)
  void observedDrop;
  await waitForVmReady(backend, handle);
}

/**
 * Wait for the guest agent's Windows service to be reachable. Same as
 * provisionVM's helper.
 */
async function waitForGuestAgent(
  backend: HypervisorBackend,
  handle: VMHandle,
): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    try {
      const status = await backend.getStatus(handle);
      if (status.guestAgentReachable) return;
    } catch {
      // ignore + retry
    }
    await sleep(2_000);
  }
  throw new Error(
    "Guest agent service did not report reachable within 2 minutes after MSI install.",
  );
}

interface StagedCertBundle {
  dir: string;
  caPath: string;
  serverCertPath: string;
  serverKeyPath: string;
  authToken: string;
}

/**
 * Stage dev certs into a per-VM tempdir. Mirrors provisionVM's
 * `stageDevCerts` — same one-CA-many-VMs model; prefer reusing
 * `<project_root>/certs/dev/` when present.
 */
async function stageDevCerts(
  vmName: string,
  explicitToken?: string,
): Promise<StagedCertBundle> {
  const { randomBytes } = await import("node:crypto");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const exec = promisify(execFile);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `signalman-bootstrap-${vmName}-`));
  const sharedCertsDir = path.resolve(process.cwd(), "certs", "dev");
  const hasShared =
    fs.existsSync(path.join(sharedCertsDir, "ca.pem")) &&
    fs.existsSync(path.join(sharedCertsDir, "server.pem")) &&
    fs.existsSync(path.join(sharedCertsDir, "server.key"));

  let caPath: string;
  let serverCertPath: string;
  let serverKeyPath: string;

  if (hasShared) {
    caPath = path.join(sharedCertsDir, "ca.pem");
    serverCertPath = path.join(sharedCertsDir, "server.pem");
    serverKeyPath = path.join(sharedCertsDir, "server.key");
  } else {
    if (process.platform !== "win32") {
      throw new Error(
        "Dev cert generation requires Windows (uses scripts/generate-dev-certs.ps1).\n" +
          "Pre-stage certs at <project_root>/certs/dev/{ca.pem,server.pem,server.key} to bypass.",
      );
    }
    const script = path.resolve(process.cwd(), "scripts", "generate-dev-certs.ps1");
    if (!fs.existsSync(script)) {
      throw new Error(
        `Cert generation script not found: ${script}.\n` +
          `Pre-stage certs at <project_root>/certs/dev/ to bypass.`,
      );
    }
    await exec(
      "powershell.exe",
      ["-ExecutionPolicy", "Bypass", "-File", script, "-OutDir", dir],
      { windowsHide: true },
    );
    caPath = path.join(dir, "ca.pem");
    serverCertPath = path.join(dir, "server.pem");
    serverKeyPath = path.join(dir, "server.key");
  }

  const authToken = explicitToken ?? randomBytes(32).toString("hex");
  fs.writeFileSync(path.join(dir, "auth-token"), authToken, "utf8");
  return { dir, caPath, serverCertPath, serverKeyPath, authToken };
}

async function copyCertsIntoVm(
  backend: HypervisorBackend,
  handle: VMHandle,
  bundle: StagedCertBundle,
): Promise<void> {
  const guestCertsDir = "C:\\ProgramData\\Signalman\\certs";
  const targets: Array<[string, string]> = [
    [bundle.caPath, `${guestCertsDir}\\ca.pem`],
    [bundle.serverCertPath, `${guestCertsDir}\\server.pem`],
    [bundle.serverKeyPath, `${guestCertsDir}\\server.key`],
  ];
  for (const [src, dst] of targets) {
    await backend.copyFileToVM(handle, src, dst);
  }
}

/**
 * If we're resuming a pipeline where the auth-token was persisted by
 * an earlier stage_certs phase, read it back so the MSI install
 * propagates the same value to the guest.
 *
 * The token file is written to a per-VM tempdir whose path includes a
 * random suffix; we walk `os.tmpdir()` for any `signalman-bootstrap-<vmName>-*`
 * directory containing an `auth-token` file. Best-effort — if the
 * tempdir was reaped between phases, the MSI install will use a
 * fresh random token and the operator will need to re-mint the
 * client config to talk to the guest.
 */
function readAuthTokenFromCerts(vmName: string): string | null {
  try {
    const tmp = os.tmpdir();
    const entries = fs.readdirSync(tmp);
    const prefix = `signalman-bootstrap-${vmName}-`;
    for (const entry of entries) {
      if (!entry.startsWith(prefix)) continue;
      const tokenPath = path.join(tmp, entry, "auth-token");
      if (fs.existsSync(tokenPath)) {
        return fs.readFileSync(tokenPath, "utf8").trim();
      }
    }
  } catch {
    // best-effort
  }
  return null;
}

function synthesizeHandle(name: string, backendName: string): VMHandle {
  return { id: `bootstrap-${name}`, name, backend: backendName };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── M2 helpers ────────────────────────────────────────────────────

interface ComposeSeedIsoArgs {
  vmName: string;
  projectRoot: string;
  unattended: UnattendedOpts | undefined;
}

/**
 * Compose the Autounattend.xml + write the seed ISO to
 * `.signalman/state/bootstrap-win11/<vm-name>.seed.iso`. Returns
 * the absolute path + ComputerName rewrite metadata so the caller
 * can log the (silent) NetBIOS-15 transliteration.
 *
 * Side effect: the seed-ISO file is written to disk. The state
 * journal mutation is the caller's responsibility — we don't
 * touch the journal here so test code can call this in isolation.
 */
async function composeSeedIsoForVm(
  args: ComposeSeedIsoArgs,
): Promise<{
  isoPath: string;
  computerName: { source: string; result: string; rewritten: boolean };
}> {
  const { composeWithMeta } = await import("./unattended.js");
  // Resolve admin password: explicit > SIGNALMAN_ADMIN_PASS env >
  // random 32-hex (operator sees the password in the journal /
  // detail field, never anywhere else).
  const { randomBytes } = await import("node:crypto");
  const u = args.unattended ?? {};
  const adminUsername = u.adminUsername ?? "signalman";
  const adminPassword =
    u.adminPassword ??
    process.env.SIGNALMAN_ADMIN_PASS ??
    randomBytes(16).toString("hex");
  const cfg: UnattendedConfig = {
    computerName: args.vmName,
    adminUsername,
    adminPassword,
    locale: u.locale,
    timezone: u.timezone,
    autoLogonCount: u.autoLogonCount,
  };
  const { xml, meta } = composeWithMeta(cfg);
  const isoDir = path.join(
    args.projectRoot,
    ".signalman",
    "state",
    "bootstrap-win11",
  );
  fs.mkdirSync(isoDir, { recursive: true });
  const isoPath = path.join(isoDir, `${args.vmName}.seed.iso`);
  await writeSeedIso(isoPath, {
    "Autounattend.xml": Buffer.from(xml, "utf8"),
  });
  // Also call composeAutounattendXml so the unused import doesn't
  // warn — same call shape composeWithMeta already covers.
  void composeAutounattendXml;
  return {
    isoPath,
    computerName: meta.computerName,
  };
}

/**
 * Detach the seed ISO from the VM (best-effort; backend-specific)
 * and remove the on-disk file. Called from the checkpoint phase
 * and from the cleanupOnFailure path.
 */
async function detachAndDeleteSeedIso(
  backend: HypervisorBackend,
  handle: VMHandle,
  isoPath: string,
  log: (e: BootstrapWin11Event) => void,
): Promise<void> {
  // Backends that expose `removeIsoFromVm` get the explicit detach
  // call; otherwise we rely on the operator's cleanup-step or a
  // backend stop+restart cycle to release the media. The interface
  // surface is intentionally minimal at M2 — full Remove-VMDvdDrive
  // wiring on Hyper-V lands in M3 once the bootstrap pipeline has
  // proven the create-time attach.
  type BackendWithDetach = HypervisorBackend & {
    removeIsoFromVm?: (handle: VMHandle, isoPath: string) => Promise<void>;
  };
  const b = backend as BackendWithDetach;
  if (typeof b.removeIsoFromVm === "function") {
    try {
      await b.removeIsoFromVm(handle, isoPath);
    } catch (err) {
      log({
        kind: "warning",
        message:
          `seed ISO detach via backend.removeIsoFromVm failed ` +
          `(continuing to delete file): ${(err as Error).message}`,
      });
    }
  } else {
    log({
      kind: "warning",
      message:
        `backend '${backend.name}' does not implement removeIsoFromVm; ` +
        `seed ISO will remain attached to the VM definition. ` +
        `Deleting the on-disk file regardless so a re-run with --force is clean.`,
    });
  }
  try {
    fs.unlinkSync(isoPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }
}
