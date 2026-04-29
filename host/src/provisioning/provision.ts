/**
 * VM provisioning pipeline (P9.1).
 *
 * `provisionVM` orchestrates the seven-step pipeline that turns an
 * empty VM name into a VM running the Signalman guest agent with a
 * named checkpoint at the agent-installed boundary:
 *
 *   1. Resolve template (calls into scenarios/templates.ts).
 *   2. Create VM (idempotent — skip if name already exists with
 *      matching template fingerprint).
 *   3. Boot, wait for IP / heartbeat.
 *   4. Generate dev certs into a per-VM tempdir, copy into VM.
 *   5. Discover guest MSI (see guest-msi-discovery.ts).
 *   6. Copy MSI into VM, run silent install, wait for service health.
 *   7. Take a checkpoint at `--checkpoint LABEL`
 *      (default: "agent-installed").
 *
 * Idempotency contract: re-running `provisionVM` with the same name
 * + template + checkpoint label and no `--force` is a 2-second no-op
 * — `alreadyProvisioned: true`. The check is structural (does the VM
 * exist? does the named checkpoint exist?) — there's no per-VM
 * fingerprint registry yet (that lands in v0.2.0 with per-VM
 * identity certs).
 *
 * Failure model (locked Q decision): on ANY failure mid-pipeline we
 * leave the VM around for operator inspection. The caller can opt
 * into auto-cleanup via `cleanupOnFailure: true`. `--force` always
 * tears down + redoes from scratch.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

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
import { discoverGuestMsi, type GuestMsiSource } from "./guest-msi-discovery.js";
import { cleanupVM } from "./cleanup.js";
import { cacheVM, globalVmCache } from "../vm-cache.js";

const exec = promisify(execFile);

// ── Public API ────────────────────────────────────────────────────

export interface ProvisionOptions {
  vmName: string;
  /** Template name; defaults to "win11-base". */
  templateName?: string;
  /** Explicit MSI override; falls through to discovery chain otherwise. */
  guestMsiPath?: string;
  /** Checkpoint to take at the end. Defaults to "agent-installed". */
  checkpointLabel?: string;
  /** Tear down + redo if VM/checkpoint exist already. */
  force?: boolean;
  /** Run cleanupVM on any failure. Defaults to false (operator inspects). */
  cleanupOnFailure?: boolean;
  /** Override the bind address baked into the service registration. */
  bindAddr?: string;
  /**
   * Auth token for the guest agent. When omitted, a random hex token
   * is generated and persisted alongside the dev certs so subsequent
   * host-side connections can read it back.
   */
  authToken?: string;
  /**
   * Optional progress logger. Called once per pipeline step with a
   * stable enum tag so the CLI / MCP wrapper can stream progress.
   */
  onProgress?: (event: ProvisionEvent) => void;
}

export interface ProvisionResult {
  vmName: string;
  vmHandle: VMHandle;
  checkpointLabel: string;
  /** True if the pipeline detected an idempotent no-op and skipped work. */
  alreadyProvisioned: boolean;
  /** Wall-clock duration in milliseconds. */
  durationMs: number;
  /** Source the MSI came from (when one was installed). */
  msiSource?: GuestMsiSource;
}

export type ProvisionEvent =
  | { kind: "step"; step: ProvisionStep; message: string }
  | { kind: "skip"; reason: string }
  | { kind: "warning"; message: string };

export type ProvisionStep =
  | "resolve_template"
  | "create_vm"
  | "boot_vm"
  | "stage_certs"
  | "discover_msi"
  | "install_msi"
  | "checkpoint";

// ── Errors ────────────────────────────────────────────────────────

export class ProvisioningError extends Error {
  override readonly name = "ProvisioningError";
  /** The pipeline step that failed. */
  readonly step: ProvisionStep;
  constructor(step: ProvisionStep, message: string, opts?: { cause?: unknown }) {
    super(message);
    this.step = step;
    if (opts?.cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = opts.cause;
    }
  }
}

// ── Pipeline ──────────────────────────────────────────────────────

/**
 * Provision a VM end-to-end (template → boot → certs → guest MSI →
 * checkpoint). See module docstring for the seven-step contract.
 */
export async function provisionVM(
  backend: HypervisorBackend,
  opts: ProvisionOptions,
): Promise<ProvisionResult> {
  const start = Date.now();
  const templateName = opts.templateName ?? "win11-base";
  const checkpointLabel = opts.checkpointLabel ?? "agent-installed";
  const log = (e: ProvisionEvent): void => {
    opts.onProgress?.(e);
  };

  // ── Force path: clean up before doing anything else ──
  if (opts.force) {
    log({ kind: "step", step: "create_vm", message: "force=true; tearing down existing VM" });
    await cleanupVM(backend, opts.vmName);
  } else {
    // ── Idempotency check ──
    //
    // The structural check is: does a VM with this name exist? If
    // yes, does it carry a checkpoint with our target label? If both
    // are true we declare the VM already provisioned and return. The
    // "matching template" check is best-effort — VmTemplate has no
    // fingerprint field today, so we accept the existing VM as-is
    // when the name matches. v0.2.0 will tighten this with a
    // per-VM fingerprint manifest landed by P9.5.
    const existing = await findExistingVm(backend, opts.vmName);
    if (existing) {
      const hasCheckpoint = await checkpointExists(
        backend,
        existing,
        checkpointLabel,
      );
      if (hasCheckpoint) {
        log({
          kind: "skip",
          reason: `VM '${opts.vmName}' already provisioned (checkpoint '${checkpointLabel}' present)`,
        });
        cacheVM(existing);
        return {
          vmName: opts.vmName,
          vmHandle: existing,
          checkpointLabel,
          alreadyProvisioned: true,
          durationMs: Date.now() - start,
        };
      }
      // VM exists but no matching checkpoint — fall through and let
      // the pipeline pick up where it left off. We don't recreate;
      // we just advance from boot.
      log({
        kind: "warning",
        message: `VM '${opts.vmName}' exists but lacks checkpoint '${checkpointLabel}'; resuming pipeline`,
      });
    }
  }

  let template: VmTemplate;
  let handle: VMHandle | null = null;
  let msiSource: GuestMsiSource | undefined;

  try {
    // ── Step 1: resolve template ──
    //
    // resolveTemplateAsync populates `vhdxPath` from either the
    // operator-supplied `base_image_path` or by fetching + verifying
    // `base_image_url` against `base_image_sha256` (P9.5, agent C).
    // For a freshly cloned dev tree without a populated template
    // registry, abstract templates (no source) round-trip with
    // `vhdxPath: undefined` and createVM falls back on backend
    // defaults — that path keeps the unit tests stable.
    log({ kind: "step", step: "resolve_template", message: `loading template '${templateName}'` });
    try {
      template = await resolveTemplateAsync(templateName);
    } catch (err) {
      // Fall back to the synchronous resolver (no fetch) when the
      // async one fails — most commonly because P9.5 fetch isn't
      // wired in a test environment. We still want the rest of the
      // pipeline to be testable end-to-end with abstract templates.
      try {
        const templates = loadTemplates();
        template = resolveTemplate(templateName, templates);
      } catch {
        throw new ProvisioningError("resolve_template", (err as Error).message, { cause: err });
      }
    }

    // ── Step 2: create VM (idempotent — skipped if exists) ──
    handle = await findExistingVm(backend, opts.vmName);
    if (!handle) {
      log({ kind: "step", step: "create_vm", message: `creating VM '${opts.vmName}' from template '${templateName}'` });
      try {
        const config: VMConfig = {
          name: opts.vmName,
          template: template.vhdxPath,
          cpus: template.processorCount,
          memoryMB: template.memoryMB,
          network: template.networkSwitch ? { switchName: template.networkSwitch } : undefined,
        };
        handle = await backend.createVM(config);
        cacheVM(handle);
      } catch (err) {
        throw new ProvisioningError("create_vm", (err as Error).message, { cause: err });
      }
    } else {
      log({ kind: "skip", reason: `VM '${opts.vmName}' already exists; skipping createVM` });
    }

    // ── Step 3: boot, wait for IP / heartbeat ──
    log({ kind: "step", step: "boot_vm", message: `starting VM and waiting for IP` });
    try {
      await backend.startVM(handle);
      await waitForVmReady(backend, handle);
    } catch (err) {
      throw new ProvisioningError("boot_vm", (err as Error).message, { cause: err });
    }

    // ── Step 4: generate + stage dev certs ──
    log({ kind: "step", step: "stage_certs", message: `generating dev certs and copying into VM` });
    let certBundle: StagedCertBundle;
    try {
      certBundle = await stageDevCerts(opts.vmName, opts.authToken);
      await copyCertsIntoVm(backend, handle, certBundle);
    } catch (err) {
      throw new ProvisioningError("stage_certs", (err as Error).message, { cause: err });
    }

    // ── Step 5: discover MSI ──
    log({ kind: "step", step: "discover_msi", message: `discovering guest MSI` });
    try {
      msiSource = await discoverGuestMsi(opts.guestMsiPath);
    } catch (err) {
      // Re-wrap discovery errors so the step is identifiable; the
      // remediation text from GuestMsiDiscoveryError is preserved in
      // the message.
      throw new ProvisioningError("discover_msi", (err as Error).message, { cause: err });
    }

    // ── Step 6: copy MSI + silent install ──
    log({
      kind: "step",
      step: "install_msi",
      message: `installing guest MSI from ${msiSource.kind}: ${msiSource.path}`,
    });
    try {
      const guestMsiPath = "C:\\Windows\\Temp\\signalman-guest.msi";
      await backend.copyFileToVM(handle, msiSource.path, guestMsiPath);
      const bindAddr = opts.bindAddr ?? "127.0.0.1:50051";
      const installArgs = [
        "/i",
        guestMsiPath,
        "/quiet",
        "/norestart",
        `BIND_ADDR=${bindAddr}`,
        `AUTH_TOKEN=${certBundle.authToken}`,
      ];
      const result = await backend.executeCommand(
        handle,
        "msiexec.exe",
        installArgs,
        300_000,
      );
      if (result.exitCode !== 0) {
        throw new Error(
          `msiexec exited ${result.exitCode}: ${result.stderr || result.stdout}`,
        );
      }
      // Wait for the service to come up — we don't have a guest client
      // yet (cert pinning needs one full handshake first), so we poll
      // the backend's getStatus.guestAgentReachable signal.
      await waitForGuestAgent(backend, handle);
    } catch (err) {
      throw new ProvisioningError("install_msi", (err as Error).message, { cause: err });
    }

    // ── Step 7: checkpoint ──
    log({
      kind: "step",
      step: "checkpoint",
      message: `taking checkpoint '${checkpointLabel}'`,
    });
    try {
      await backend.createCheckpoint(handle, checkpointLabel);
    } catch (err) {
      throw new ProvisioningError("checkpoint", (err as Error).message, { cause: err });
    }

    return {
      vmName: opts.vmName,
      vmHandle: handle,
      checkpointLabel,
      alreadyProvisioned: false,
      durationMs: Date.now() - start,
      msiSource,
    };
  } catch (err) {
    if (opts.cleanupOnFailure) {
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
  }
}

// ── Helpers ───────────────────────────────────────────────────────

interface StagedCertBundle {
  /** Tempdir containing ca.pem, server.pem, server.key. */
  dir: string;
  caPath: string;
  serverCertPath: string;
  serverKeyPath: string;
  /** Generated bearer token (hex), passed via MSI property AUTH_TOKEN. */
  authToken: string;
}

/**
 * Generate a CA + server cert into a per-VM tempdir.
 *
 * Implementation: defer to the existing `scripts/generate-dev-certs.ps1`.
 * We invoke it with -OutDir set to the tempdir; under the hood it uses
 * openssl. v0.2.0 will replace this with a pure-Node cert generator
 * (no external openssl dep) — tracked separately.
 *
 * Cert model is one-CA-many-VMs (locked Q2(c)): we re-use the existing
 * `certs/dev/` material if present rather than minting per-VM CAs. The
 * server cert is reusable across VMs because the SAN list includes
 * the loopback / Hyper-V test-network IPs that all guests share.
 */
async function stageDevCerts(
  vmName: string,
  explicitToken?: string,
): Promise<StagedCertBundle> {
  const dir = path.join(os.tmpdir(), `signalman-provision-${vmName}`);
  fs.mkdirSync(dir, { recursive: true });

  // One-CA-many-VMs model: prefer to reuse the canonical dev cert
  // bundle at <project_root>/certs/dev/ when present; fall back to
  // generating into the tempdir.
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
    // Generate into tempdir using the PowerShell script. We don't run
    // it on non-Windows — the function only ships in the Hyper-V code
    // path today, but a hard error is still better than a silent skip.
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

  // Generate or accept a bearer token. The token is written to the
  // tempdir so the host can read it back when establishing a guest
  // client connection later.
  const authToken = explicitToken ?? randomHexToken();
  fs.writeFileSync(path.join(dir, "auth-token"), authToken, { encoding: "utf8" });

  return { dir, caPath, serverCertPath, serverKeyPath, authToken };
}

function randomHexToken(): string {
  // 32 bytes = 64 hex chars. Adequate entropy for a bearer token.
  return randomBytes(32).toString("hex");
}

/**
 * Copy the CA + server cert + key into the VM at the path the MSI
 * expects: %ProgramData%\Signalman\certs\.
 */
async function copyCertsIntoVm(
  backend: HypervisorBackend,
  handle: VMHandle,
  bundle: StagedCertBundle,
): Promise<void> {
  // %ProgramData% on standard Windows = C:\ProgramData. We hard-code
  // it rather than query because Hyper-V Copy-VMFile doesn't have a
  // good "expand env var on guest" path.
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
 * Find a VM by name without throwing if it doesn't exist.
 */
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

/**
 * Check whether a checkpoint with the given label exists on the VM.
 */
async function checkpointExists(
  backend: HypervisorBackend,
  handle: VMHandle,
  label: string,
): Promise<boolean> {
  try {
    const checkpoints = await backend.listCheckpoints(handle);
    return checkpoints.some((cp) => cp.label === label);
  } catch {
    return false;
  }
}

/**
 * Wait until the VM has an IP address (or heartbeat-healthy if the
 * backend supports it). Polls every 2s for up to 5 minutes.
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
  throw new Error("VM did not become ready (state=running + ipAddress) within 5 minutes");
}

/**
 * Wait for the guest agent's Windows service to be reachable.
 * Polls backend.getStatus.guestAgentReachable.
 */
async function waitForGuestAgent(
  backend: HypervisorBackend,
  handle: VMHandle,
): Promise<void> {
  const deadline = Date.now() + 120_000; // 2 min — service start is fast
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
    "Guest agent service did not report reachable within 2 minutes after MSI install. " +
      "Check that the SignalmanGuest service started in the VM.",
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
