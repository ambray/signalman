#!/usr/bin/env node
/**
 * Signalman CLI — `signalman <verb>`.
 *
 * One subcommand per MCP verb (per design doc §5). Same execution path
 * as the MCP server: the CLI imports the same `host/src/verbs/*` and
 * emits the same envelope. Exit codes map 1:1 to the envelope's
 * `exit_code` field; usage errors return 64.
 *
 * Usage:
 *   signalman list [--tag T] [--pattern P] [--format json]
 *   signalman describe <id> [--workflow] [--format json]
 *   signalman plan <id> [--param k=v]... [--format json]
 *   signalman run <id> [--param k=v]... [--trace-id HEX] [--follow] [--format json]
 *   signalman status [--run RUN_ID] [--wait N]
 *   signalman record <name> [--duration N]
 *   signalman record finalize <recording_path_or_id> [--scenario-id ID] [--force]
 */

import * as path from "node:path";
import * as process from "node:process";
import { runList } from "./verbs/list.js";
import { runDescribe } from "./verbs/describe.js";
import { runPlan } from "./verbs/plan.js";
import { runRun } from "./verbs/run.js";
import { runStatus } from "./verbs/status.js";
import { runRecord, runRecordFinalize } from "./verbs/record.js";
import { runInit } from "./verbs/init.js";
import { createDefaultExecutor } from "./verbs/default-executor.js";
import { provisionVM } from "./provisioning/provision.js";
import { cleanupVM } from "./provisioning/cleanup.js";
import { GuestMsiDiscoveryError } from "./provisioning/guest-msi-discovery.js";
import type { HypervisorBackend, VMHandle } from "./hypervisors/interface.js";
import {
  loadTemplates,
  validateTemplateImageSource,
} from "./scenarios/templates.js";
import { fetchTemplateImage } from "./provisioning/template-fetch.js";
// P9.2 — bundle install machinery. Imported eagerly here because the
// CLI handler is small; the heavy gRPC client + hypervisor backend
// imports live inside cmdVmInstallBundle's lazy-loaded dependencies.
import {
  parseBundle,
  BundleValidationError,
} from "./provisioning/bundle-types.js";
// PR 2 — control-plane verbs (product, release).
// PR 3 — target, release deploy/rollback.
import {
  withControlPlane,
  runProductAdd,
  runProductList,
  runProductRemove,
  runReleaseBuild,
  runReleaseList,
  runReleaseShow,
  runTargetAdd,
  runTargetList,
  runTargetRemove,
  runReleaseDeploy,
  runReleaseRollback,
  runHealthCheck,
  runHealthHistory,
  runReleaseVerify,
} from "./verbs/control-plane.js";
// PR 6 — `signalman serve` HTTP control plane.
// PR 7 — `signalman api-key create`.
// PR 8 — `signalman runner register/start`, `release build --remote`.
// PR 10a — `signalman key generate/fingerprint`, `release verify`, build --sign.
import { startServer } from "./http/index.js";
import { generateApiKey } from "./http/auth.js";
import { ControlPlane } from "./control-plane/index.js";
import { loadConfig } from "./config.js";
import {
  fingerprintPublicKey,
  generateKeypair,
} from "./control-plane/build/index.js";
import * as fsp from "node:fs/promises";
import {
  HttpClient,
  HttpClientError,
  defaultHandlers,
  runWorker,
} from "./runner/worker.js";
import {
  defaultRunnerConfigPath,
  loadRunnerConfig,
  writeRunnerConfig,
} from "./runner/config.js";
import * as os from "node:os";

// ── Tiny argv parser ──────────────────────────────────────────────

interface ParsedArgs {
  positional: string[];
  flags: Set<string>;
  options: Map<string, string>;
  /** Repeated `--param k=v` collected into a single map. */
  params: Record<string, string>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags = new Set<string>();
  const options = new Map<string, string>();
  const params: Record<string, string> = {};

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const key = eq >= 0 ? a.slice(2, eq) : a.slice(2);
      const value = eq >= 0 ? a.slice(eq + 1) : argv[i + 1];
      // Boolean-ish flags: only consume the next arg when it doesn't look like another flag.
      if (
        key === "follow" ||
        key === "workflow" ||
        key === "no-follow" ||
        key === "force" ||
        key === "bootstrap" ||
        key === "cleanup-on-failure" ||
        key === "wait-guest" ||
        key === "remote" ||
        key === "sign"
      ) {
        flags.add(key);
        if (eq >= 0) {
          // --follow=true variant tolerated; ignore the value.
        }
        continue;
      }
      if (key === "param") {
        if (value === undefined) usageError(`--param expects k=v`);
        const eqI = value.indexOf("=");
        if (eqI < 0) usageError(`--param expects k=v, got "${value}"`);
        params[value.slice(0, eqI)] = value.slice(eqI + 1);
        if (eq < 0) i++;
        continue;
      }
      if (value === undefined) usageError(`--${key} expects a value`);
      options.set(key, value);
      if (eq < 0) i++;
      continue;
    }
    positional.push(a);
  }
  return { positional, flags, options, params };
}

function usageError(msg: string): never {
  console.error(`signalman: ${msg}`);
  console.error(`Run 'signalman --help' for usage.`);
  process.exit(64);
}

// ── Output helpers ────────────────────────────────────────────────

function emitJson(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}

function resolveCliHostPath(value: string): string {
  if (path.isAbsolute(value) || path.win32.isAbsolute(value)) {
    return value;
  }
  return path.resolve(value);
}

function emitTable(rows: Array<Record<string, string>>): void {
  if (rows.length === 0) {
    process.stdout.write("(no scenarios)\n");
    return;
  }
  const cols = Object.keys(rows[0]);
  const widths = cols.map((c) => Math.max(c.length, ...rows.map((r) => (r[c] ?? "").length)));
  const sep = widths.map((w) => "-".repeat(w)).join("  ");
  const header = cols.map((c, i) => c.padEnd(widths[i])).join("  ");
  process.stdout.write(header + "\n" + sep + "\n");
  for (const r of rows) {
    process.stdout.write(cols.map((c, i) => (r[c] ?? "").padEnd(widths[i])).join("  ") + "\n");
  }
}

// ── Verbs ─────────────────────────────────────────────────────────

async function cmdList(args: ParsedArgs): Promise<number> {
  const result = runList({
    tag: args.options.get("tag"),
    pattern: args.options.get("pattern"),
  });
  // PR 5: mirror the disk listing into the control-plane scenario
  // catalog. Best-effort; failures log a warning but don't affect
  // the verb's exit code or output.
  const { indexListResult } = await import("./verbs/indexing.js");
  await indexListResult(result);
  if (args.options.get("format") === "json") {
    emitJson(result);
  } else {
    emitTable(
      result.scenarios.map((s) => ({
        id: s.id,
        name: s.name ?? "",
        tags: (s.tags ?? []).join(","),
        last_run: s.last_run ? s.last_run.result : "",
      })),
    );
  }
  return 0;
}

async function cmdDescribe(args: ParsedArgs): Promise<number> {
  const id = args.positional[0];
  if (!id) usageError("describe requires <id>");
  const result = runDescribe({ id });
  if (args.flags.has("workflow")) {
    process.stdout.write(result.workflow_markdown);
    return 0;
  }
  if (args.options.get("format") === "json") {
    emitJson(result);
  } else {
    process.stdout.write(`# ${result.id}\n`);
    process.stdout.write(`hash: ${result.scenario_hash}\n\n`);
    process.stdout.write(`name: ${(result.setup as Record<string, unknown>).name ?? ""}\n`);
    process.stdout.write(`tags: ${JSON.stringify((result.setup as Record<string, unknown>).tags ?? [])}\n\n`);
    process.stdout.write(`---\n\n${result.workflow_markdown}\n`);
  }
  return 0;
}

async function cmdPlan(args: ParsedArgs): Promise<number> {
  const id = args.positional[0];
  if (!id) usageError("plan requires <id>");
  try {
    const result = runPlan({ id, parameters: args.params });
    if (args.options.get("format") === "json") {
      emitJson(result);
    } else {
      process.stdout.write(`Scenario: ${result.id}\n`);
      process.stdout.write(`Hash:     ${result.scenario_hash}\n`);
      process.stdout.write(`Steps:    ${result.steps.length}\n`);
      for (const s of result.steps) {
        process.stdout.write(`  - ${s.kind}${s.vm ? ` (vm=${s.vm})` : ""}\n`);
      }
      if (result.warnings.length > 0) {
        process.stdout.write(`Warnings:\n`);
        for (const w of result.warnings) process.stdout.write(`  - ${w}\n`);
      }
    }
    return 0;
  } catch (err) {
    console.error(`signalman plan: ${(err as Error).message}`);
    return 5; // validation error
  }
}

async function cmdRun(args: ParsedArgs): Promise<number> {
  const id = args.positional[0];
  if (!id) usageError("run requires <id>");
  const network_class = args.options.get("network-class") as "isolated" | "nat" | "internet" | undefined;
  // P3.d: --trace-id allows external orchestrators (CI, the Loom plugin)
  // to inject a correlation root. runRun validates the format; a
  // malformed value bubbles up as a usage error.
  const trace_id = args.options.get("trace-id");
  let handle;
  try {
    handle = await runRun(
      { id, parameters: args.params, network_class, trace_id },
      createDefaultExecutor(),
    );
  } catch (err) {
    if (err instanceof Error && err.message.includes("trace_id")) {
      usageError(err.message);
    }
    throw err;
  }
  // Default behavior: follow events to stderr, write envelope to stdout
  // when terminal. `--no-follow` returns immediately with the handle.
  if (args.flags.has("no-follow")) {
    emitJson(handle);
    return 0;
  }

  let since = 0;
  // Long-poll until terminal.
  while (true) {
    const status = await runStatus({ run_id: handle.run_id, since_event_seq: since, wait_ms: 5_000 });
    if ("events" in status) {
      for (const e of status.events) {
        process.stderr.write(`[${e.seq}] ${e.type}\n`);
        since = e.seq + 1;
      }
      if (status.envelope) {
        if (args.options.get("format") === "json") {
          emitJson(status.envelope);
        } else {
          process.stdout.write(`Result: ${status.envelope.result}\n`);
          process.stdout.write(`Duration: ${status.envelope.duration_ms}ms\n`);
          process.stdout.write(`Assertions: ${status.envelope.assertions.passed}/${status.envelope.assertions.total} passed\n`);
        }
        return status.envelope.exit_code;
      }
    }
  }
}

async function cmdStatus(args: ParsedArgs): Promise<number> {
  const run_id = args.options.get("run");
  const wait_ms = args.options.get("wait") ? parseInt(args.options.get("wait") ?? "0", 10) : 0;
  const result = await runStatus({ run_id, wait_ms });
  emitJson(result);
  return 0;
}

async function cmdRecord(args: ParsedArgs): Promise<number> {
  if (args.positional[0] === "finalize") {
    const target = args.positional[1];
    if (!target) usageError("record finalize requires <recording_path_or_id>");
    const isId = target.startsWith("rec_");
    const result = runRecordFinalize({
      recording_id: isId ? target : undefined,
      recording_path: isId ? undefined : target,
      scenario_id: args.options.get("scenario-id"),
      force: args.flags.has("force"),
    });
    emitJson(result);
    return 0;
  }
  const name = args.positional[0];
  if (!name) usageError("record requires <name>");
  const durationRaw = args.options.get("duration");
  const duration = durationRaw ? Number(durationRaw) : undefined;
  const result = runRecord({ name, duration_seconds: duration });
  emitJson(result);
  return 0;
}

// ── init (P9.3) ───────────────────────────────────────────────────
//
// Locked design: minimal scaffold by default; --bootstrap prints the
// explicit cert/template/provision sequence without doing expensive
// operator-owned side effects. Re-runs are idempotent unless --force
// is set.

function cmdInit(args: ParsedArgs): number {
  const projectName = args.options.get("name");
  const force = args.flags.has("force");
  const bootstrap = args.flags.has("bootstrap");

  const result = runInit({ projectName, force, bootstrap });

  if (args.options.get("format") === "json") {
    emitJson(result);
    return 0;
  }

  // Plaintext output: first the human-friendly summary, then the
  // bootstrap next-step message on stderr if --bootstrap was set.
  process.stdout.write(`Signalman project initialised at ${result.projectRoot}\n`);
  if (result.filesCreated.length > 0) {
    process.stdout.write(`  ${result.filesCreated.length} file(s) created:\n`);
    for (const f of result.filesCreated) {
      process.stdout.write(`    + ${path.relative(result.projectRoot, f)}\n`);
    }
  }
  if (result.filesSkipped.length > 0) {
    process.stdout.write(
      `  ${result.filesSkipped.length} file(s) already existed (use --force to overwrite):\n`,
    );
    for (const f of result.filesSkipped) {
      process.stdout.write(`    = ${path.relative(result.projectRoot, f)}\n`);
    }
  }
  const bootstrapMessage = result.bootstrapMessage ?? result.bootstrapDeferredMessage;
  if (bootstrapMessage) {
    process.stderr.write("\n" + bootstrapMessage + "\n");
  }
  process.stdout.write(`\nNext: signalman list\n`);
  return 0;
}

// ── vm subcommand dispatch (P9.x) ─────────────────────────────────
//
// `signalman vm <subcommand> [args]`. Each subcommand has its own
// case below. P9.5 adds `fetch-template`; P9.1 (agent A) adds
// `provision` / `cleanup` / `create`; P9.2 (agent B) adds
// `install-bundle`. Keep cases alphabetical when adding new ones.

async function cmdVmFetchTemplate(args: ParsedArgs): Promise<number> {
  const name = args.positional[0];
  if (!name) usageError("vm fetch-template requires <name>");

  const force = args.flags.has("force");

  const templates = loadTemplates();
  const tmpl = templates.get(name);
  if (!tmpl) {
    console.error(
      `signalman: unknown template '${name}'. Available: ${Array.from(templates.keys()).join(", ")}`,
    );
    return 5;
  }
  // Surface "missing SHA / mixed forms / http://" before any network call.
  validateTemplateImageSource(tmpl);

  if (!tmpl.base_image_url || !tmpl.base_image_sha256) {
    console.error(
      `signalman: template '${name}' has no base_image_url to fetch.\n` +
        (tmpl.base_image_path
          ? `  This is a BYO template (base_image_path: ${tmpl.base_image_path}).\n` +
            `  Nothing to download — the operator owns the disk.`
          : `  This is an abstract template with no base-image source.\n` +
            `  Add base_image_url + base_image_sha256 to the template YAML to fetch.`),
    );
    return 5;
  }

  process.stderr.write(
    `Fetching template '${name}' from ${tmpl.base_image_url}\n`,
  );

  const result = await fetchTemplateImage({
    templateName: name,
    url: tmpl.base_image_url,
    expectedSha256: tmpl.base_image_sha256,
    force,
  });

  if (args.options.get("format") === "json") {
    emitJson(result);
    return 0;
  }

  // Pretty-print: cache status, path, size, duration.
  const sizeMB = (result.sizeBytes / (1024 * 1024)).toFixed(1);
  process.stdout.write(
    `Template:  ${name}\n` +
      `Status:    ${result.cached ? "cache hit (verified)" : "downloaded + verified"}\n` +
      `VHDX path: ${result.vhdxPath}\n` +
      `Size:      ${sizeMB} MB\n` +
      `Duration:  ${result.durationMs} ms\n`,
  );
  return 0;
}

// ── vm create (P9.3) ──────────────────────────────────────────────
//
// Creates a VM from a template WITHOUT installing the guest agent or
// taking a checkpoint. This is the "just stand up the VM" path —
// useful when:
//   - the operator wants to bring their own guest-install workflow
//     (e.g. enterprise SCCM / Intune / Ansible),
//   - the template VHDX already contains an agent and we just need
//     the VM created around it,
//   - debugging the provisioning pipeline (decompose
//     `vm provision` failures into "did create succeed?" first).
//
// `vm create` is a strict subset of `vm provision` — both call the
// same `loadTemplates` + `backend.createVM` + (optional) `startVM`.
// Provision adds: cert landing, MSI install, checkpoint. If you want
// all of that in one step, use `signalman vm provision`.
//
// Idempotency: if a VM with the requested name already exists,
// `vm create` succeeds silently with `alreadyExists: true` in the
// JSON output. `--force` first deletes the VM, then recreates.
//
// Usage:
//   signalman vm create <name> [--template T] [--start] [--force]
//                       [--format json]

async function cmdVmCreate(args: ParsedArgs): Promise<number> {
  const vmName = args.positional[0];
  if (!vmName) usageError("vm create requires <name>");

  const templateName = args.options.get("template") ?? "win11-base";
  const start = args.flags.has("start");
  const force = args.flags.has("force");

  const backend = await getCliBackend();

  // Resolve the template — agent C's templates.ts populates `vhdxPath`
  // from either `base_image_path` (BYO) or by fetching `base_image_url`.
  // For `vm create` we don't fetch automatically (operator should run
  // `signalman vm fetch-template` first if URL form); we just want the
  // template's CPU / memory / network settings.
  const templates = loadTemplates();
  const template = templates.get(templateName);
  if (!template) {
    console.error(
      `signalman vm create: template '${templateName}' not found. ` +
        `Available: ${Array.from(templates.keys()).join(", ") || "(none)"}`,
    );
    return 5; // validation
  }
  validateTemplateImageSource(template);

  // Idempotency: check for existing VM. If found and !force, no-op.
  const existing = await backend.listVMs();
  const found = existing.find((h: VMHandle) => h.name === vmName);
  if (found && !force) {
    if (args.options.get("format") === "json") {
      emitJson({
        vmName,
        backend: backend.name,
        templateName,
        alreadyExists: true,
        handle: found,
      });
    } else {
      process.stdout.write(
        `signalman vm create: VM '${vmName}' already exists ` +
          `(use --force to recreate, or 'signalman vm provision' for full pipeline)\n`,
      );
    }
    return 0;
  }

  if (found && force) {
    // Stop + delete + recreate. We use `cleanupVM` from agent A to
    // share the lifecycle code path (same idempotency guarantees).
    process.stderr.write(
      `signalman vm create: --force specified; removing existing VM '${vmName}'\n`,
    );
    await cleanupVM(backend, vmName);
  }

  // Build VMConfig from the template + CLI overrides.
  const cfg = {
    name: vmName,
    template: template.name,
    cpus: template.processorCount,
    memoryMB: template.memoryMB,
    network: { switchName: template.networkSwitch },
  };
  const handle = await backend.createVM(cfg);

  if (start) {
    await backend.startVM(handle);
  }

  const result = {
    vmName,
    backend: backend.name,
    templateName,
    alreadyExists: false,
    started: start,
    handle,
  };

  if (args.options.get("format") === "json") {
    emitJson(result);
  } else {
    process.stdout.write(
      `Created VM '${vmName}' from template '${templateName}'` +
        (start ? " (started)" : "") +
        `\n  id:      ${handle.id}\n  backend: ${handle.backend}\n` +
        `\nNext: signalman vm provision ${vmName}` +
        ` (to install guest agent + take 'agent-installed' checkpoint),` +
        `\n   or: signalman vm install-bundle ${vmName} <bundle.yaml>` +
        ` (to apply a software bundle).\n`,
    );
  }
  return 0;
}

async function cmdVm(args: ParsedArgs): Promise<number> {
  const sub = args.positional.shift();
  if (!sub) {
    usageError(
      "vm requires a subcommand (e.g. start, stop, status, fetch-template, provision, cleanup, install-bundle)",
    );
  }

  switch (sub) {
    case "fetch-template":
      return await cmdVmFetchTemplate(args);
    case "provision":
      return await cmdVmProvision(args);
    case "cleanup":
      return await cmdVmCleanup(args);
    case "create":
      return await cmdVmCreate(args);
    case "install-bundle":
      return await cmdVmInstallBundle(args);
    case "start":
      return await cmdVmStart(args);
    case "stop":
      return await cmdVmStop(args);
    case "status":
      return await cmdVmStatus(args);
    case "probe-guest":
      return await cmdVmProbeGuest(args);
    case "exec":
      return await cmdVmExec(args);
    case "copy-file":
      return await cmdVmCopyFile(args);
    default:
      usageError(`unknown vm subcommand: ${sub}`);
  }
}

/**
 * Resolve a VM handle by name via the active backend.
 *
 * Used by `vm start` / `vm stop` / `vm status` -- those subcommands
 * take just `<name>` on the CLI but need a `VMHandle` (id + name +
 * backend) to feed `backend.startVM(handle)` etc.  We resolve via
 * `listVMs` rather than synthesising a handle from the name alone
 * because some backends key off the id (Hyper-V GUID, Tart UUID, etc)
 * and a name-only handle would be a foot-gun on rename.
 */
async function resolveVmHandleByName(
  backend: HypervisorBackend,
  name: string,
): Promise<VMHandle> {
  const all = await backend.listVMs();
  const matched = all.find((v) => v.name === name);
  if (!matched) {
    throw new Error(
      `VM '${name}' not found via ${backend.name} backend. ` +
      `Run 'signalman vm create ${name} --template <T>' first, ` +
      `or check that ${backend.name} is the right backend (signalman list-backends).`
    );
  }
  return matched;
}

// ── vm start (idempotent VM power-on) ──────────────────────────────
//
// Wraps `HypervisorBackend.startVM` for the operator's "bring my
// demo VM up so I can run a scenario against it" workflow. The
// scenarios under `.signalman/scenarios/*/setup.yaml` mostly use
// `pre_started: true` (the unprivileged signalman CLI cannot drive
// Hyper-V cmdlets directly), but the ELEVATED service-first backend
// CAN -- so this verb gives the operator a one-line repeatable path
// that doesn't reach for raw `Start-VM` PowerShell.
//
// Flags:
//   --checkpoint <label>   Restore the named checkpoint before starting.
//                          Useful for "snap to a known state then go".
//   --wait-guest           Block until the guest agent's gRPC port
//                          (default 50051) reports reachable.
//   --wait-timeout <ms>    Override the wait-guest deadline (default
//                          120s, matches provisioning's waitForGuestAgent).
//   --format json          Emit a structured envelope on stdout
//                          instead of the human-readable summary.
async function cmdVmStart(args: ParsedArgs): Promise<number> {
  const name = args.positional[0];
  if (!name) usageError("vm start requires <name>");
  const checkpointLabel = args.options.get("checkpoint");
  const waitGuest = args.flags.has("wait-guest");
  const waitTimeoutMs = parseInt(args.options.get("wait-timeout") ?? "120000", 10);
  const format = args.options.get("format");

  const backend = await getCliBackend();
  try {
    const handle = await resolveVmHandleByName(backend, name);

    // Optional checkpoint restore. We use the existing
    // `restoreCheckpoint` API which expects a CheckpointHandle, so
    // we synthesise one from `{ vmHandle, label }` -- the Hyper-V
    // backend resolves the snapshot by VM+name lookup at restore
    // time so an empty `id` field is fine.
    if (checkpointLabel) {
      process.stderr.write(`[vm start] restoring checkpoint '${checkpointLabel}'...\n`);
      await backend.restoreCheckpoint({
        id: "",
        vmHandle: handle,
        label: checkpointLabel,
      });
    }

    process.stderr.write(`[vm start] starting VM '${name}'...\n`);
    await backend.startVM(handle);

    let guestReachable: boolean | undefined;
    if (waitGuest) {
      process.stderr.write(
        `[vm start] waiting up to ${waitTimeoutMs}ms for guest agent...\n`,
      );
      const deadline = Date.now() + waitTimeoutMs;
      guestReachable = false;
      while (Date.now() < deadline) {
        try {
          const status = await backend.getStatus(handle);
          if (status.guestAgentReachable) {
            guestReachable = true;
            break;
          }
        } catch {
          // ignore transient errors during boot
        }
        await new Promise((r) => setTimeout(r, 2_000));
      }
      if (!guestReachable) {
        const err = new Error(
          `Guest agent on '${name}' did not become reachable within ${waitTimeoutMs}ms. ` +
          `Check that SignalmanGuest scheduled task / service is running inside the VM, ` +
          `and that Autologon completed (so the desktop session is up).`,
        );
        if (format === "json") {
          emitJson({ vmName: name, started: true, guestReachable: false, error: err.message });
          return 4;
        }
        throw err;
      }
    }

    if (format === "json") {
      emitJson({
        vmName: name,
        backend: backend.name,
        started: true,
        checkpointRestored: checkpointLabel ?? null,
        guestReachable: guestReachable ?? null,
      });
    } else {
      const tag = guestReachable ? " (guest agent reachable)" : "";
      const cpTag = checkpointLabel ? ` [restored from '${checkpointLabel}']` : "";
      process.stdout.write(`VM '${name}' started${cpTag}${tag}.\n`);
    }
    return 0;
  } catch (err) {
    console.error(`signalman vm start: ${(err as Error).message}`);
    return 4;
  }
}

// ── vm stop ────────────────────────────────────────────────────────
async function cmdVmStop(args: ParsedArgs): Promise<number> {
  const name = args.positional[0];
  if (!name) usageError("vm stop requires <name>");
  const force = args.flags.has("force");
  const format = args.options.get("format");
  const backend = await getCliBackend();
  try {
    const handle = await resolveVmHandleByName(backend, name);
    process.stderr.write(`[vm stop] stopping VM '${name}' (force=${force})...\n`);
    await backend.stopVM(handle, force);
    if (format === "json") {
      emitJson({ vmName: name, backend: backend.name, stopped: true, force });
    } else {
      process.stdout.write(`VM '${name}' stopped${force ? " (forced)" : ""}.\n`);
    }
    return 0;
  } catch (err) {
    console.error(`signalman vm stop: ${(err as Error).message}`);
    return 4;
  }
}

// ── vm exec (PowerShell Direct fallback, bypasses guest agent) ─────
//
// `signalman vm exec <name> -- <command>` drives `Invoke-Command
// -VMName` against the running VM via the host's elevated
// PowerShell Direct path. Critically this DOES NOT need
// SignalmanGuest to be reachable -- the auth surface is the
// host-configured guestCredentials (username/password), not the
// guest agent's TLS+token.  Used when:
//   * the guest agent is broken (token rotated, cert expired,
//     scheduled task crashed) and we need to introspect or fix it
//   * a one-shot bootstrap-style command should run before the
//     guest agent is installed at all
//
// The command after `--` is passed verbatim to PowerShell inside
// the VM. Exit code, stdout, stderr round-trip back. -- is required
// to delimit so signalman's own arg parser doesn't try to interpret
// flags that belong to the inner command.
async function cmdVmExec(args: ParsedArgs): Promise<number> {
  const name = args.positional[0];
  if (!name) usageError("vm exec requires <name> -- <command...>");
  const cmdArgs = args.positional.slice(1);
  if (cmdArgs.length === 0) usageError("vm exec: missing command after VM name (use -- to delimit)");
  const format = args.options.get("format");
  const timeoutMs = parseInt(args.options.get("timeout") ?? "60000", 10);

  // --username / --password are PER-CALL credential overrides for the
  // PowerShell-Direct dispatch path. Use these when:
  //   * the target VM doesn't have signalman-guest installed yet
  //     (e.g. one-shot bootstrap), so all commands must go through
  //     Invoke-Command -VMName -Credential rather than gRPC;
  //   * AND the VM's local user isn't the same as the global
  //     hypervisor.guestCredentials in .signalman/config.yaml.
  // Both flags must be supplied together; mismatched usage is a
  // CLI error.
  const cliUser = args.options.get("username");
  const cliPass = args.options.get("password");
  if ((cliUser && !cliPass) || (!cliUser && cliPass)) {
    usageError("vm exec: --username and --password must be supplied together");
  }
  const credOverride = cliUser && cliPass
    ? { username: cliUser, password: cliPass }
    : undefined;

  const backend = await getCliBackend(credOverride);
  try {
    const handle = await resolveVmHandleByName(backend, name);
    const cmd = cmdArgs[0];
    const cmdRest = cmdArgs.slice(1);
    const result = await backend.executeCommand(handle, cmd, cmdRest, timeoutMs);

    if (format === "json") {
      emitJson({
        vmName: name,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
      });
    } else {
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      if (result.exitCode !== 0) {
        process.stderr.write(`\n[vm exec] exit code: ${result.exitCode}\n`);
      }
    }
    return result.exitCode === 0 ? 0 : 4;
  } catch (err) {
    console.error(`signalman vm exec: ${(err as Error).message}`);
    return 4;
  }
}

// ── vm probe-guest (diagnostic) ────────────────────────────────────
//
// vm copy-file:
// Usage:
//   signalman vm copy-file <name> <host_path> <guest_path>
//   signalman vm copy-file <name> <guest_path> <host_path> --direction guest-to-host
async function cmdVmCopyFile(args: ParsedArgs): Promise<number> {
  const name = args.positional[0];
  const firstPath = args.positional[1];
  const secondPath = args.positional[2];
  if (!name || !firstPath || !secondPath) {
    usageError("vm copy-file requires <name> <host_path> <guest_path>");
  }
  const direction = args.options.get("direction") ?? "host-to-guest";
  const format = args.options.get("format");

  // --username / --password mirror cmdVmExec: per-call override of
  // the signalman config's `hypervisor.guestCredentials`. The service
  // backend's vmCopyFile RPC uses PowerShell Direct under the hood
  // (`New-PSSession -VMName -Credential` + `Copy-Item -ToSession`),
  // not Hyper-V's no-cred Copy-VMFile integration -- so a Win11_test
  // bootstrap whose user differs from the persisted demo/demo creds
  // hits "The credential is invalid" without this override.
  const cliUser = args.options.get("username");
  const cliPass = args.options.get("password");
  if ((cliUser && !cliPass) || (!cliUser && cliPass)) {
    usageError("vm copy-file: --username and --password must be supplied together");
  }
  const credOverride = cliUser && cliPass
    ? { username: cliUser, password: cliPass }
    : undefined;

  const backend = await getCliBackend(credOverride);

  try {
    const handle = await resolveVmHandleByName(backend, name);
    if (direction === "host-to-guest") {
      await backend.copyFileToVM(handle, resolveCliHostPath(firstPath), secondPath);
    } else if (direction === "guest-to-host") {
      await backend.copyFileFromVM(handle, firstPath, resolveCliHostPath(secondPath));
    } else {
      usageError("vm copy-file --direction must be host-to-guest or guest-to-host");
    }

    const result = {
      vmName: name,
      direction,
      source: firstPath,
      destination: secondPath,
    };
    if (format === "json") {
      emitJson(result);
    } else {
      process.stdout.write(
        `Copied file ${direction} for VM '${name}': ${firstPath} -> ${secondPath}\n`,
      );
    }
    return 0;
  } catch (err) {
    console.error(`signalman vm copy-file: ${(err as Error).message}`);
    return 4;
  }
}

// vm probe-guest diagnostic:
// Re-runs the guest health probe with full error surface instead of the
// quiet boolean used by `vm status`.
async function cmdVmProbeGuest(args: ParsedArgs): Promise<number> {
  const name = args.positional[0];
  if (!name) usageError("vm probe-guest requires <name>");
  const format = args.options.get("format");
  const backend = await getCliBackend();
  try {
    const handle = await resolveVmHandleByName(backend, name);
    const status = await backend.getStatus(handle);
    if (!status.ipAddress) {
      throw new Error(`VM '${name}' has no IP address yet (state=${status.state})`);
    }

    // Re-run the health check inline with full error surface.  We
    // duplicate a small slice of `defaultGuestAgentHealthCheck`
    // here rather than threading an `errorOut` parameter through
    // every backend's getStatus path; this keeps the diagnostic
    // surface scoped to the diagnostic subcommand.
    const { loadConfig } = await import("./config.js");
    const cfg = loadConfig();
    const port = cfg.guestAgent.defaultPort ?? 50051;
    const authToken = cfg.guestAgent.authToken;
    const tls = cfg.guestAgent.tls?.enabled
      ? {
          caPath: cfg.guestAgent.tls.caPath,
          certPath: cfg.guestAgent.tls.certPath,
          keyPath: cfg.guestAgent.tls.keyPath,
        }
      : undefined;

    const { GuestAgentClient } = await import("./guest/client.js");
    const client = new GuestAgentClient(status.ipAddress, port, tls, {
      connectionTimeoutMs: 10_000,
      defaultTimeoutMs: 10_000,
      maxRetries: 0,
      authToken,
    });
    let probeResult: { ok: boolean; error?: string } = { ok: false };
    try {
      // Call the health RPC directly so the underlying error surfaces.
      const { unaryCall } = await import("./guest/client.js");
      await unaryCall(
        // accessing private field for diagnostic; intentional
        (client as unknown as { client: unknown }).client,
        "health",
        {},
        10_000,
        authToken,
      );
      probeResult = { ok: true };
    } catch (e) {
      probeResult = { ok: false, error: (e as Error).message ?? String(e) };
    } finally {
      client.dispose();
    }

    if (format === "json") {
      emitJson({
        vmName: name,
        ipAddress: status.ipAddress,
        port,
        tlsEnabled: tls !== undefined,
        ok: probeResult.ok,
        error: probeResult.error ?? null,
      });
    } else {
      const tag = probeResult.ok ? "OK" : "FAIL";
      process.stdout.write(
        `[${tag}] guest agent at ${status.ipAddress}:${port} (tls=${tls !== undefined})\n`,
      );
      if (probeResult.error) {
        process.stdout.write(`  error: ${probeResult.error}\n`);
      }
    }
    return probeResult.ok ? 0 : 4;
  } catch (err) {
    console.error(`signalman vm probe-guest: ${(err as Error).message}`);
    return 4;
  }
}

// ── vm status ──────────────────────────────────────────────────────
async function cmdVmStatus(args: ParsedArgs): Promise<number> {
  const name = args.positional[0];
  if (!name) usageError("vm status requires <name>");
  const format = args.options.get("format");
  const backend = await getCliBackend();
  try {
    const handle = await resolveVmHandleByName(backend, name);
    const status = await backend.getStatus(handle);
    if (format === "json") {
      emitJson({
        vmName: name,
        backend: backend.name,
        state: status.state,
        ipAddress: status.ipAddress ?? null,
        guestAgentReachable: status.guestAgentReachable,
        uptimeSeconds: status.uptimeSeconds,
        memoryUsedMB: status.memoryUsedMB,
      });
    } else {
      process.stdout.write(
        `${name}: ${status.state}` +
          (status.ipAddress ? ` ip=${status.ipAddress}` : "") +
          ` guest=${status.guestAgentReachable ? "reachable" : "unreachable"}` +
          ` uptime=${status.uptimeSeconds}s` +
          ` mem=${status.memoryUsedMB}MB\n`,
      );
    }
    return 0;
  } catch (err) {
    console.error(`signalman vm status: ${(err as Error).message}`);
    return 4;
  }
}

// ── vm install-bundle (P9.2) ──────────────────────────────────────
//
// Loads a bundle.yaml file from disk, parses it via the strict Zod
// schema, then drives `installBundle` against the named VM. The
// orchestrator's gRPC + hypervisor wiring is reused so the CLI path
// matches the MCP path exactly — same package-manager idempotency
// semantics, same per-package result envelope.
//
// Usage: signalman vm install-bundle <vm> <bundle.yaml> [--format json]

async function cmdVmInstallBundle(args: ParsedArgs): Promise<number> {
  const vmName = args.positional[0];
  const bundlePath = args.positional[1];
  if (!vmName || !bundlePath) {
    usageError("vm install-bundle requires <vm> <bundle.yaml>");
  }

  // Read + parse the bundle BEFORE we spin up the gRPC machinery so
  // schema errors come back fast and don't leave dangling clients.
  let bundle;
  try {
    const fs = await import("node:fs");
    const yaml = await import("yaml");
    if (!fs.existsSync(bundlePath)) {
      console.error(
        `signalman vm install-bundle: bundle file not found: ${bundlePath}`,
      );
      return 5;
    }
    const text = fs.readFileSync(bundlePath, "utf-8");
    const raw = yaml.parse(text);
    bundle = parseBundle(raw);
  } catch (err) {
    if (err instanceof BundleValidationError) {
      console.error(`signalman vm install-bundle: ${err.message}`);
      return 5;
    }
    console.error(
      `signalman vm install-bundle: ${(err as Error).message}`,
    );
    return 5;
  }

  // Lazy-import the heavy machinery; light commands shouldn't pay it.
  const { loadConfig } = await import("./config.js");
  const { GuestAgentClient } = await import("./guest/client.js");
  const { resolveVM } = await import("./vm-cache.js");
  const { installBundle } = await import(
    "./provisioning/install-bundle.js"
  );

  const config = loadConfig();
  const backend = await getCliBackend();
  const handle = await resolveVM(backend, vmName);

  const ipAddress = backend.getVmIpAddress
    ? await backend.getVmIpAddress(handle)
    : undefined;
  if (!ipAddress) {
    console.error(
      `signalman vm install-bundle: cannot resolve IP for VM '${vmName}'`,
    );
    return 4;
  }

  const tlsConfig = config.guestAgent.tls;
  const tlsOptions = tlsConfig.enabled
    ? {
        caPath: tlsConfig.caPath,
        certPath: tlsConfig.certPath,
        keyPath: tlsConfig.keyPath,
      }
    : undefined;

  const client = new GuestAgentClient(
    ipAddress,
    config.guestAgent.defaultPort,
    tlsOptions,
    { authToken: config.guestAgent.authToken },
  );

  try {
    const result = await installBundle(backend, client, vmName, bundle);
    if (args.options.get("format") === "json") {
      emitJson(result);
    } else {
      process.stdout.write(
        `Bundle: ${bundle.metadata.name}\n` +
          `VM:     ${result.vmName}\n` +
          `Total:  ${result.totalPackages}  Installed: ${result.installed}  ` +
          `Skipped: ${result.skipped}  Failed: ${result.failed}\n` +
          `Duration: ${result.durationMs}ms\n\n`,
      );
      for (const r of result.perPackageResults) {
        const tag =
          r.status === "installed"
            ? "[OK]  "
            : r.status === "skipped"
              ? "[skip]"
              : "[FAIL]";
        process.stdout.write(
          `  ${tag} ${r.package} (${r.source})  ${r.durationMs}ms` +
            (r.error ? `\n        ${r.error}` : "") +
            "\n",
        );
      }
    }
    // 0 if no failed packages; 2 (workflow-fail) otherwise.
    return result.failed === 0 ? 0 : 2;
  } finally {
    client.dispose();
  }
}

// ── vm provision / cleanup (P9.1) ─────────────────────────────────

/**
 * Resolve the active hypervisor backend for the CLI.
 *
 * Uses the same selector as `signalman run`, so `signalman vm ...`
 * honors the service-first daemon path and only falls back to direct
 * Hyper-V/gsudo when the daemon is unavailable.
 */
async function getCliBackend(
  credOverride?: { username: string; password: string },
): Promise<HypervisorBackend> {
  const { loadConfig } = await import("./config.js");
  const { selectBackend } = await import("./hypervisors/selector.js");
  const config = loadConfig();
  if (credOverride) {
    // Per-call credential override for `vm exec --username ... --password ...`.
    // The unprivileged-bootstrap path needs this: when the operator is
    // bringing up a fresh VM whose user isn't `demo/demo`, the global
    // hypervisor.guestCredentials in `.signalman/config.yaml` doesn't
    // match. Mutate the in-memory config (NOT the on-disk file) so the
    // backend reaches Invoke-Command -VMName -Credential with the
    // operator-supplied account, and so subsequent CLI invocations
    // without the override fall back cleanly to the persisted config.
    config.hypervisor.guestCredentials = {
      username: credOverride.username,
      password: credOverride.password,
    };
  }
  return await selectBackend(config);
}

async function cmdVmProvision(args: ParsedArgs): Promise<number> {
  const name = args.positional[0];
  if (!name) usageError("vm provision requires <name>");
  const backend = await getCliBackend();
  try {
    const result = await provisionVM(backend, {
      vmName: name,
      templateName: args.options.get("template"),
      guestMsiPath: args.options.get("guest-msi"),
      checkpointLabel: args.options.get("checkpoint"),
      force: args.flags.has("force"),
      cleanupOnFailure: args.flags.has("cleanup-on-failure"),
      bindAddr: args.options.get("bind-addr"),
      authToken: args.options.get("auth-token"),
      onProgress: (e) => {
        // Stream progress to stderr so the JSON envelope on stdout
        // (when --format json) stays parseable.
        if (e.kind === "step") {
          process.stderr.write(`[provision:${e.step}] ${e.message}\n`);
        } else if (e.kind === "skip") {
          process.stderr.write(`[provision:skip] ${e.reason}\n`);
        } else {
          process.stderr.write(`[provision:warn] ${e.message}\n`);
        }
      },
    });
    if (args.options.get("format") === "json") {
      emitJson({
        vmName: result.vmName,
        checkpointLabel: result.checkpointLabel,
        alreadyProvisioned: result.alreadyProvisioned,
        durationMs: result.durationMs,
        msiSource: result.msiSource ?? null,
      });
    } else {
      const verb = result.alreadyProvisioned ? "already provisioned" : "provisioned";
      process.stdout.write(
        `VM '${result.vmName}' ${verb} (checkpoint: '${result.checkpointLabel}', ${result.durationMs} ms)\n`,
      );
    }
    return 0;
  } catch (err) {
    if (err instanceof GuestMsiDiscoveryError) {
      console.error(`signalman vm provision: ${err.message}`);
      console.error("");
      console.error("Remediation:");
      for (const r of err.remediation) console.error(`  - ${r}`);
      return 3;
    }
    if ((err as { step?: string }).step !== undefined) {
      const step = (err as { step?: string }).step;
      console.error(
        `signalman vm provision: failed at step '${step}': ${(err as Error).message}`,
      );
      return 3;
    }
    console.error(`signalman vm provision: ${(err as Error).message}`);
    return 4;
  }
}

async function cmdVmCleanup(args: ParsedArgs): Promise<number> {
  const name = args.positional[0];
  if (!name) usageError("vm cleanup requires <name>");
  const backend = await getCliBackend();
  try {
    await cleanupVM(backend, name);
    process.stdout.write(`VM '${name}' cleaned up.\n`);
    return 0;
  } catch (err) {
    console.error(`signalman vm cleanup: ${(err as Error).message}`);
    return 4;
  }
}

// ── Product / Release verbs (PR 2 — control-plane) ────────────────

async function cmdProduct(args: ParsedArgs): Promise<number> {
  const sub = args.positional.shift();
  if (!sub) usageError("product requires a subcommand (add, list, remove)");
  switch (sub) {
    case "add":
      return await cmdProductAdd(args);
    case "list":
      return await cmdProductList(args);
    case "remove":
      return await cmdProductRemove(args);
    default:
      usageError(`unknown product subcommand: ${sub}`);
  }
}

async function cmdProductAdd(args: ParsedArgs): Promise<number> {
  const name = args.options.get("name") ?? args.positional[0];
  const repoUrl = args.options.get("repo") ?? args.options.get("repo-url");
  const buildYamlPath = args.options.get("build-yaml");
  if (!name) usageError("product add requires --name <NAME>");
  if (!repoUrl) usageError("product add requires --repo <URL>");
  const format = args.options.get("format");
  try {
    const product = await withControlPlane((cp) =>
      runProductAdd(cp, { name, repoUrl, buildYamlPath }),
    );
    if (format === "json") {
      emitJson(product);
    } else {
      process.stdout.write(
        `Added product '${product.name}' (${product.id})\n  repo: ${product.repoUrl}\n  build.yaml: ${product.buildYamlPath}\n`,
      );
    }
    return 0;
  } catch (err) {
    console.error(`signalman product add: ${(err as Error).message}`);
    return 4;
  }
}

async function cmdProductList(args: ParsedArgs): Promise<number> {
  const format = args.options.get("format");
  try {
    const products = await withControlPlane((cp) => runProductList(cp));
    if (format === "json") {
      emitJson(products);
      return 0;
    }
    if (products.length === 0) {
      process.stdout.write("(no products)\n");
      return 0;
    }
    emitTable(
      products.map((p) => ({
        name: p.name,
        id: p.id,
        repo: p.repoUrl,
        "build.yaml": p.buildYamlPath,
      })),
    );
    return 0;
  } catch (err) {
    console.error(`signalman product list: ${(err as Error).message}`);
    return 4;
  }
}

async function cmdProductRemove(args: ParsedArgs): Promise<number> {
  const name = args.positional[0] ?? args.options.get("name");
  if (!name) usageError("product remove requires <name>");
  try {
    await withControlPlane((cp) => runProductRemove(cp, { name }));
    process.stdout.write(`Removed product '${name}'.\n`);
    return 0;
  } catch (err) {
    console.error(`signalman product remove: ${(err as Error).message}`);
    return 4;
  }
}

async function cmdRelease(args: ParsedArgs): Promise<number> {
  const sub = args.positional.shift();
  if (!sub)
    usageError(
      "release requires a subcommand (build, list, show, deploy, rollback, verify)",
    );
  switch (sub) {
    case "build":
      return await cmdReleaseBuild(args);
    case "list":
      return await cmdReleaseList(args);
    case "show":
      return await cmdReleaseShow(args);
    case "deploy":
      return await cmdReleaseDeploy(args);
    case "rollback":
      return await cmdReleaseRollback(args);
    case "verify":
      return await cmdReleaseVerify(args);
    default:
      usageError(`unknown release subcommand: ${sub}`);
  }
}

// ── target verbs ─────────────────────────────────────────────────

async function cmdTarget(args: ParsedArgs): Promise<number> {
  const sub = args.positional.shift();
  if (!sub) usageError("target requires a subcommand (add, list, remove)");
  switch (sub) {
    case "add":
      return await cmdTargetAdd(args);
    case "list":
      return await cmdTargetList(args);
    case "remove":
      return await cmdTargetRemove(args);
    default:
      usageError(`unknown target subcommand: ${sub}`);
  }
}

async function cmdTargetAdd(args: ParsedArgs): Promise<number> {
  const name = args.options.get("name") ?? args.positional[0];
  const kindRaw = args.options.get("kind");
  if (!name) usageError("target add requires --name <NAME>");
  if (!kindRaw) usageError("target add requires --kind <vm_test|vm_demo|docker_test|docker_demo>");
  const validKinds = new Set(["vm_test", "vm_demo", "docker_test", "docker_demo"]);
  if (!validKinds.has(kindRaw)) {
    usageError(`target add: invalid --kind '${kindRaw}'`);
  }
  const kind = kindRaw as "vm_test" | "vm_demo" | "docker_test" | "docker_demo";

  // Connection: either an explicit JSON blob, or assembled from
  // --vm-name + --backend for the common VM-target case.
  const connectionJson = args.options.get("connection");
  let connection: Record<string, unknown>;
  if (connectionJson) {
    try {
      connection = JSON.parse(connectionJson);
    } catch {
      usageError(`target add: --connection must be valid JSON`);
    }
  } else {
    const vmName = args.options.get("vm-name");
    if (!vmName) {
      usageError(
        "target add: provide --vm-name <VM> (and optionally --backend) or pass --connection '<json>'",
      );
    }
    const backend = args.options.get("backend");
    connection = { vmName, ...(backend ? { backend } : {}) };
  }
  const format = args.options.get("format");
  try {
    const target = await withControlPlane((cp) =>
      runTargetAdd(cp, { name, kind, connection }),
    );
    if (format === "json") {
      emitJson(target);
    } else {
      process.stdout.write(
        `Added target '${target.name}' (${target.id})\n  kind: ${target.kind}\n  connection: ${JSON.stringify(target.connection)}\n`,
      );
    }
    return 0;
  } catch (err) {
    console.error(`signalman target add: ${(err as Error).message}`);
    return 4;
  }
}

async function cmdTargetList(args: ParsedArgs): Promise<number> {
  const format = args.options.get("format");
  try {
    const targets = await withControlPlane((cp) => runTargetList(cp));
    if (format === "json") {
      emitJson(targets);
      return 0;
    }
    if (targets.length === 0) {
      process.stdout.write("(no targets)\n");
      return 0;
    }
    emitTable(
      targets.map((t) => ({
        name: t.name,
        kind: t.kind,
        connection: JSON.stringify(t.connection),
        id: t.id,
      })),
    );
    return 0;
  } catch (err) {
    console.error(`signalman target list: ${(err as Error).message}`);
    return 4;
  }
}

async function cmdTargetRemove(args: ParsedArgs): Promise<number> {
  const name = args.positional[0] ?? args.options.get("name");
  if (!name) usageError("target remove requires <name>");
  try {
    await withControlPlane((cp) => runTargetRemove(cp, { name }));
    process.stdout.write(`Removed target '${name}'.\n`);
    return 0;
  } catch (err) {
    console.error(`signalman target remove: ${(err as Error).message}`);
    return 4;
  }
}

// ── release deploy / rollback ───────────────────────────────────────

async function cmdReleaseDeploy(args: ParsedArgs): Promise<number> {
  const productName = args.options.get("product");
  const tag = args.options.get("tag");
  const releaseId = args.options.get("release");
  const targetName = args.options.get("target");
  if (!targetName) usageError("release deploy requires --target <NAME>");
  if (!releaseId && !(productName && tag)) {
    usageError("release deploy requires either --release <ID> or --product <NAME> + --tag <TAG>");
  }
  const format = args.options.get("format");
  try {
    const result = await withControlPlane((cp) =>
      runReleaseDeploy(
        cp,
        { releaseId, productName, tag, targetName },
        { out: process.stderr },
      ),
    );
    if (format === "json") {
      emitJson({
        deployment: result.deployment,
        release_id: result.release.id,
        target_id: result.target.id,
        health: result.healthSummary,
      });
    } else {
      process.stdout.write(
        `Deployed ${result.release.tag} → ${result.target.name}\n` +
          `  deployment: ${result.deployment.id}\n` +
          `  status: ${result.deployment.status}\n` +
          `  health: ${result.healthSummary.pass}/${result.healthSummary.total} probes passed\n`,
      );
    }
    return 0;
  } catch (err) {
    const name = (err as Error).name;
    if (name === "DeployBlockedError" || name === "DeployHealthFailedError") {
      console.error(`signalman release deploy: ${(err as Error).message}`);
      return 2;
    }
    console.error(`signalman release deploy: ${(err as Error).message}`);
    return 4;
  }
}

// ── health verbs ────────────────────────────────────────────────────

async function cmdHealth(args: ParsedArgs): Promise<number> {
  const sub = args.positional.shift();
  if (!sub) usageError("health requires a subcommand (check, history)");
  switch (sub) {
    case "check":
      return await cmdHealthCheck(args);
    case "history":
      return await cmdHealthHistory(args);
    default:
      usageError(`unknown health subcommand: ${sub}`);
  }
}

async function cmdHealthCheck(args: ParsedArgs): Promise<number> {
  const targetName = args.options.get("target");
  if (!targetName) usageError("health check requires --target <NAME>");
  // --probe may be repeated via comma-separation: --probe a,b,c.
  // Keeps the parser simple without per-flag repetition support.
  const probeOpt = args.options.get("probe");
  const probeNames = probeOpt
    ? probeOpt.split(",").map((s) => s.trim()).filter((s) => s.length > 0)
    : undefined;
  const releaseId = args.options.get("release");
  const format = args.options.get("format");
  try {
    const result = await withControlPlane((cp) =>
      runHealthCheck(
        cp,
        { targetName, probeNames, releaseId },
        { out: process.stderr },
      ),
    );
    if (format === "json") {
      emitJson(result);
      return 0;
    }
    process.stdout.write(
      `Target '${result.target.name}' — release ${result.release.tag} (${result.release.id})\n` +
        `  vm_reachable: ${result.reachability.reachable ? "pass" : "fail"}` +
        (result.reachability.detail ? `  (${result.reachability.detail})` : "") +
        "\n",
    );
    if (result.probes.length === 0) {
      process.stdout.write("  (no declared probes)\n");
    } else {
      for (const p of result.probes) {
        process.stdout.write(`  ${p.name}: ${p.status}  (${p.detail})\n`);
      }
    }
    const anyFail =
      !result.reachability.reachable || result.probes.some((p) => p.status === "fail");
    return anyFail ? 1 : 0;
  } catch (err) {
    console.error(`signalman health check: ${(err as Error).message}`);
    return 4;
  }
}

async function cmdHealthHistory(args: ParsedArgs): Promise<number> {
  const targetName = args.options.get("target");
  if (!targetName) usageError("health history requires --target <NAME>");
  const sinceIso = args.options.get("since");
  const limitRaw = args.options.get("limit");
  const limit = limitRaw ? parseInt(limitRaw, 10) : undefined;
  const format = args.options.get("format");
  try {
    const entries = await withControlPlane((cp) =>
      runHealthHistory(cp, { targetName, sinceIso, limit }),
    );
    if (format === "json") {
      emitJson(entries);
      return 0;
    }
    if (entries.length === 0) {
      process.stdout.write("(no deployments on target)\n");
      return 0;
    }
    for (const e of entries) {
      process.stdout.write(
        `Deployment ${e.deployment.id} (${e.deployment.status}) — release ${e.release.tag}\n`,
      );
      if (e.checks.length === 0) {
        process.stdout.write("  (no health checks)\n");
        continue;
      }
      for (const c of e.checks) {
        process.stdout.write(
          `  ${c.checkedAt}  ${c.probeName}: ${c.status}` +
            (c.detail ? `  (${c.detail})` : "") +
            "\n",
        );
      }
    }
    return 0;
  } catch (err) {
    console.error(`signalman health history: ${(err as Error).message}`);
    return 4;
  }
}

// ── runner (PR 8 — submit-mode worker) ──────────────────────────────

async function cmdRunner(args: ParsedArgs): Promise<number> {
  const sub = args.positional.shift();
  if (!sub) usageError("runner requires a subcommand (register, start)");
  switch (sub) {
    case "register":
      return await cmdRunnerRegister(args);
    case "start":
      return await cmdRunnerStart(args);
    default:
      usageError(`unknown runner subcommand: ${sub}`);
  }
}

async function cmdRunnerRegister(args: ParsedArgs): Promise<number> {
  const url = args.options.get("control-plane");
  const token = args.options.get("token");
  const workerName = args.options.get("worker-name");
  if (!url) usageError("runner register requires --control-plane <URL>");
  if (!token) usageError("runner register requires --token <TOKEN>");
  try {
    const target = defaultRunnerConfigPath();
    await writeRunnerConfig(
      { controlPlaneUrl: url, token, workerName },
      target,
    );
    process.stdout.write(`Registered runner at ${target}\n`);
    return 0;
  } catch (err) {
    console.error(`signalman runner register: ${(err as Error).message}`);
    return 4;
  }
}

async function cmdRunnerStart(args: ParsedArgs): Promise<number> {
  const intervalRaw = args.options.get("poll-interval-ms");
  const pollIntervalMs = intervalRaw ? parseInt(intervalRaw, 10) : 1000;
  if (Number.isNaN(pollIntervalMs) || pollIntervalMs < 50) {
    usageError("--poll-interval-ms must be >= 50");
  }
  let config;
  try {
    config = await loadRunnerConfig();
  } catch (err) {
    console.error(`signalman runner start: ${(err as Error).message}`);
    return 5;
  }
  const workerName =
    args.options.get("worker-name") ??
    config.workerName ??
    `${os.hostname()}:${process.pid}`;
  const client = new HttpClient({
    baseUrl: config.controlPlaneUrl,
    token: config.token,
  });

  process.stdout.write(
    `signalman runner start: '${workerName}' → ${config.controlPlaneUrl}\n`,
  );

  const controller = new AbortController();
  const shutdown = (signal: NodeJS.Signals) => {
    process.stderr.write(`signalman runner: received ${signal}, stopping...\n`);
    controller.abort();
  };
  globalThis.process.once("SIGINT", shutdown);
  globalThis.process.once("SIGTERM", shutdown);

  try {
    await runWorker({
      client,
      workerName,
      pollIntervalMs,
      signal: controller.signal,
      handlers: defaultHandlers({ client, runnerId: workerName }),
    });
    return 0;
  } catch (err) {
    console.error(`signalman runner start: ${(err as Error).message}`);
    return 4;
  }
}

// ── api-key (PR 7 — bearer tokens) ──────────────────────────────────

async function cmdApiKey(args: ParsedArgs): Promise<number> {
  const sub = args.positional.shift();
  if (!sub) usageError("api-key requires a subcommand (create, list, revoke)");
  switch (sub) {
    case "create":
      return await cmdApiKeyCreate(args);
    case "list":
      return await cmdApiKeyList(args);
    case "revoke":
      return await cmdApiKeyRevoke(args);
    default:
      usageError(`unknown api-key subcommand: ${sub}`);
  }
}

async function cmdApiKeyCreate(args: ParsedArgs): Promise<number> {
  const name = args.options.get("name") ?? args.positional[0];
  if (!name) usageError("api-key create requires --name <NAME>");
  const expiresAt = args.options.get("expires-at");
  const format = args.options.get("format");
  const config = loadConfig();
  const controlPlane = ControlPlane.fromConfig(config.controlPlane);
  try {
    const { defaultOrg } = await controlPlane.init();
    const generated = generateApiKey();
    const row = await controlPlane.apiKeys.create({
      orgId: defaultOrg.id,
      name,
      prefix: generated.prefix,
      hash: generated.hash,
      expiresAt,
    });
    if (format === "json") {
      emitJson({
        api_key: { ...row, hash: undefined },
        token: generated.token,
      });
    } else {
      process.stdout.write(
        `Created api key '${row.name}' (${row.id})\n` +
          `  prefix:  ${row.prefix}\n` +
          `  expires: ${row.expiresAt ?? "never"}\n` +
          `\n` +
          `  TOKEN (shown once — save it now):\n` +
          `  ${generated.token}\n`,
      );
    }
    return 0;
  } catch (err) {
    console.error(`signalman api-key create: ${(err as Error).message}`);
    return 4;
  } finally {
    await controlPlane.close();
  }
}

async function cmdApiKeyList(args: ParsedArgs): Promise<number> {
  const format = args.options.get("format");
  const config = loadConfig();
  const controlPlane = ControlPlane.fromConfig(config.controlPlane);
  try {
    const { defaultOrg } = await controlPlane.init();
    const keys = await controlPlane.apiKeys.listForOrg(defaultOrg.id);
    const sanitized = keys.map((k) => ({ ...k, hash: undefined }));
    if (format === "json") {
      emitJson(sanitized);
      return 0;
    }
    if (sanitized.length === 0) {
      process.stdout.write("(no api keys)\n");
      return 0;
    }
    emitTable(
      sanitized.map((k) => ({
        name: k.name,
        prefix: k.prefix,
        id: k.id,
        expires_at: k.expiresAt ?? "never",
      })),
    );
    return 0;
  } finally {
    await controlPlane.close();
  }
}

async function cmdApiKeyRevoke(args: ParsedArgs): Promise<number> {
  const id = args.positional[0] ?? args.options.get("id");
  if (!id) usageError("api-key revoke requires <id>");
  const config = loadConfig();
  const controlPlane = ControlPlane.fromConfig(config.controlPlane);
  try {
    await controlPlane.init();
    const key = await controlPlane.apiKeys.get(id);
    if (!key) {
      console.error(`signalman api-key revoke: not found: ${id}`);
      return 5;
    }
    await controlPlane.apiKeys.softDelete(key.id);
    process.stdout.write(`Revoked api key '${key.name}' (${key.id})\n`);
    return 0;
  } finally {
    await controlPlane.close();
  }
}

// ── key (PR 10a — release signing) ──────────────────────────────────

async function cmdKey(args: ParsedArgs): Promise<number> {
  const sub = args.positional.shift();
  if (!sub) usageError("key requires a subcommand (generate, fingerprint)");
  switch (sub) {
    case "generate":
      return await cmdKeyGenerate(args);
    case "fingerprint":
      return await cmdKeyFingerprint(args);
    default:
      usageError(`unknown key subcommand: ${sub}`);
  }
}

async function cmdKeyGenerate(args: ParsedArgs): Promise<number> {
  const out = args.options.get("out") ?? path.join(os.homedir(), ".signalman", "keys");
  const name = args.options.get("name") ?? "signing";
  const force = args.flags.has("force");
  const format = args.options.get("format");
  const pubPath = path.join(out, `${name}.pub`);
  const privPath = path.join(out, `${name}.key`);
  if (!force) {
    for (const p of [pubPath, privPath]) {
      try {
        await fsp.access(p);
        console.error(
          `signalman key generate: ${p} already exists. Re-run with --force to overwrite (loses the existing key!).`,
        );
        return 5;
      } catch {
        // ENOENT: good, slot is free.
      }
    }
  }
  await fsp.mkdir(out, { recursive: true });
  const kp = generateKeypair();
  // Public key: world-readable; private key: mode 0600.
  await fsp.writeFile(pubPath, kp.publicKeyPem, "utf-8");
  await fsp.writeFile(privPath, kp.privateKeyPem, { encoding: "utf-8", mode: 0o600 });
  const fp = fingerprintPublicKey(kp.publicKeyPem);
  if (format === "json") {
    emitJson({ public_key: pubPath, private_key: privPath, fingerprint: fp });
  } else {
    process.stdout.write(
      `Generated Ed25519 signing keypair\n` +
        `  public:      ${pubPath}\n` +
        `  private:     ${privPath}  (mode 0600 — guard this file)\n` +
        `  fingerprint: ${fp}\n`,
    );
  }
  return 0;
}

async function cmdKeyFingerprint(args: ParsedArgs): Promise<number> {
  const keyPath = args.positional[0] ?? args.options.get("path");
  if (!keyPath) usageError("key fingerprint requires <public_key_path>");
  let pem: string;
  try {
    pem = await fsp.readFile(resolveCliHostPath(keyPath), "utf-8");
  } catch (err) {
    console.error(
      `signalman key fingerprint: could not read '${keyPath}': ${(err as Error).message}`,
    );
    return 5;
  }
  try {
    const fp = fingerprintPublicKey(pem);
    if (args.options.get("format") === "json") {
      emitJson({ fingerprint: fp });
    } else {
      process.stdout.write(`${fp}\n`);
    }
    return 0;
  } catch (err) {
    console.error(`signalman key fingerprint: ${(err as Error).message}`);
    return 5;
  }
}

async function cmdReleaseVerify(args: ParsedArgs): Promise<number> {
  const releaseId = args.positional[0] ?? args.options.get("release");
  const pubKeyPath = args.options.get("public-key");
  if (!releaseId) usageError("release verify requires <release_id>");
  if (!pubKeyPath) usageError("release verify requires --public-key <PATH>");
  let pem: string;
  try {
    pem = await fsp.readFile(resolveCliHostPath(pubKeyPath), "utf-8");
  } catch (err) {
    console.error(
      `signalman release verify: could not read --public-key '${pubKeyPath}': ${(err as Error).message}`,
    );
    return 5;
  }
  const format = args.options.get("format");
  try {
    const result = await withControlPlane((cp) =>
      runReleaseVerify(cp, { releaseId, publicKeyPem: pem }),
    );
    if (format === "json") {
      emitJson(result);
      return result.verified ? 0 : 1;
    }
    if (result.verified) {
      process.stdout.write(
        `OK — release ${result.release.tag} (${result.release.id})\n` +
          `  signed_by: ${result.release.signedBy}\n` +
          `  manifest:  ${result.release.manifestSha256}\n`,
      );
      return 0;
    }
    process.stderr.write(
      `FAIL — release ${result.release.tag} (${result.release.id})\n` +
        `  ${result.reason}\n`,
    );
    return 1;
  } catch (err) {
    console.error(`signalman release verify: ${(err as Error).message}`);
    return 4;
  }
}

// ── serve (PR 6 — HTTP control plane) ───────────────────────────────

async function cmdServe(args: ParsedArgs): Promise<number> {
  const portRaw = args.options.get("port");
  const port = portRaw ? parseInt(portRaw, 10) : 8765;
  if (Number.isNaN(port) || port < 0 || port > 65535) {
    usageError(`serve: invalid --port '${portRaw}'`);
  }
  const host = args.options.get("host") ?? "127.0.0.1";

  const config = loadConfig();
  const controlPlane = ControlPlane.fromConfig(config.controlPlane);
  try {
    await controlPlane.init();
  } catch (err) {
    console.error(`signalman serve: failed to init control plane: ${(err as Error).message}`);
    await controlPlane.close();
    return 4;
  }

  let server;
  try {
    server = await startServer({ controlPlane, port, host });
  } catch (err) {
    console.error(`signalman serve: failed to bind ${host}:${port}: ${(err as Error).message}`);
    await controlPlane.close();
    return 4;
  }

  process.stdout.write(`signalman serve: listening on ${server.url}\n`);
  if (host !== "127.0.0.1") {
    // PR 7 lands bearer-token auth. Until then, the operator owns the
    // network exposure decision; warn loudly on non-loopback binds.
    process.stderr.write(
      `signalman serve: WARNING: bound to ${host} without auth. ` +
        `Bind to 127.0.0.1 until PR 7 lands bearer-token middleware.\n`,
    );
  }

  await new Promise<void>((resolve) => {
    const shutdown = (signal: NodeJS.Signals) => {
      process.stderr.write(`signalman serve: received ${signal}, shutting down...\n`);
      resolve();
    };
    // Signal handlers live on the global process (EventEmitter); the
    // `node:process` module namespace import at the top of this file
    // doesn't re-export `.once`.
    globalThis.process.once("SIGINT", shutdown);
    globalThis.process.once("SIGTERM", shutdown);
  });

  await server.stop();
  await controlPlane.close();
  return 0;
}

async function cmdReleaseRollback(args: ParsedArgs): Promise<number> {
  const targetName = args.options.get("target");
  const toReleaseId = args.options.get("to-release");
  if (!targetName) usageError("release rollback requires --target <NAME>");
  const format = args.options.get("format");
  try {
    const result = await withControlPlane((cp) =>
      runReleaseRollback(
        cp,
        { targetName, toReleaseId },
        { out: process.stderr },
      ),
    );
    if (format === "json") {
      emitJson({
        deployment: result.deployment,
        release_id: result.release.id,
        target_id: result.target.id,
        health: result.healthSummary,
      });
    } else {
      process.stdout.write(
        `Rolled back ${result.target.name} → ${result.release.tag}\n` +
          `  deployment: ${result.deployment.id}\n`,
      );
    }
    return 0;
  } catch (err) {
    const name = (err as Error).name;
    if (name === "DeployBlockedError" || name === "DeployHealthFailedError") {
      console.error(`signalman release rollback: ${(err as Error).message}`);
      return 2;
    }
    console.error(`signalman release rollback: ${(err as Error).message}`);
    return 4;
  }
}

async function cmdReleaseBuild(args: ParsedArgs): Promise<number> {
  const productName = args.options.get("product");
  const tag = args.options.get("tag");
  const workDir = args.options.get("work-dir");
  if (!productName) usageError("release build requires --product <NAME>");
  if (!tag) usageError("release build requires --tag <TAG>");
  const remote = args.flags.has("remote");
  if (remote) {
    return await cmdReleaseBuildRemote(args, { productName, tag });
  }
  // PR 10a: optional `--sign --key <path>` reads the Ed25519 private
  // key + tells the build executor to sign the manifest.
  const sign = args.flags.has("sign");
  const keyPath = args.options.get("key");
  if (sign && !keyPath) {
    usageError("release build --sign requires --key <PATH_TO_PRIVATE_KEY_PEM>");
  }
  let signingKeyPem: string | undefined;
  if (sign && keyPath) {
    try {
      signingKeyPem = await fsp.readFile(resolveCliHostPath(keyPath), "utf-8");
    } catch (err) {
      console.error(
        `signalman release build: could not read --key '${keyPath}': ${(err as Error).message}`,
      );
      return 5;
    }
  }
  const format = args.options.get("format");
  try {
    const result = await withControlPlane((cp) =>
      runReleaseBuild(
        cp,
        { productName, tag, workDir, signingKeyPem },
        { out: process.stderr },
      ),
    );
    if (format === "json") {
      emitJson({
        release: result.release,
        manifest_sha256: result.manifestSha256,
        artifact_count: result.artifacts.length,
        signed_by: result.signature?.signedBy,
      });
    } else {
      process.stdout.write(
        `Release ${result.release.tag} ready (id=${result.release.id})\n` +
          `  manifest: ${result.manifestSha256}\n` +
          (result.signature
            ? `  signed_by: ${result.signature.signedBy}\n`
            : "") +
          `  artifacts: ${result.artifacts.length}\n`,
      );
    }
    return 0;
  } catch (err) {
    const name = (err as Error).name;
    if (
      name === "BuildYamlValidationError" ||
      name === "ComponentBuildError" ||
      name === "MissingArtifactError" ||
      name === "ReleaseAlreadyExistsError"
    ) {
      console.error(`signalman release build: ${(err as Error).message}`);
      return name === "BuildYamlValidationError" ? 5 : 2;
    }
    console.error(`signalman release build: ${(err as Error).message}`);
    return 4;
  }
}

/**
 * Submit-mode build: pushes a `release.build` job onto the remote
 * control plane, then polls until the job is terminal. PR 8a stubs
 * the runner-side handler with a "deferred to 8b" failure; the wiring
 * is provable end-to-end (job lands, runner claims, status flows back)
 * once you `signalman runner start` alongside.
 */
async function cmdReleaseBuildRemote(
  args: ParsedArgs,
  input: { productName: string; tag: string },
): Promise<number> {
  const format = args.options.get("format");
  let config;
  try {
    config = await loadRunnerConfig();
  } catch (err) {
    console.error(`signalman release build --remote: ${(err as Error).message}`);
    return 5;
  }
  const client = new HttpClient({
    baseUrl: config.controlPlaneUrl,
    token: config.token,
  });
  try {
    const product = await client.productByName(input.productName);
    const job = await client.submitJob("release.build", {
      product_id: product.id,
      product_name: product.name,
      tag: input.tag,
    });
    process.stderr.write(
      `[release build --remote] submitted job ${job.id}; polling...\n`,
    );
    const terminal = await followJob(client, job.id, process.stderr);
    if (format === "json") {
      emitJson(terminal);
      return terminal.status === "succeeded" ? 0 : 2;
    }
    if (terminal.status === "succeeded") {
      process.stdout.write(
        `Remote build succeeded (job ${terminal.id})\n` +
          (terminal.result ? `  result: ${JSON.stringify(terminal.result)}\n` : ""),
      );
      return 0;
    }
    process.stderr.write(
      `Remote build failed (job ${terminal.id}): ${terminal.error ?? "unknown error"}\n`,
    );
    return 2;
  } catch (err) {
    if (err instanceof HttpClientError) {
      console.error(
        `signalman release build --remote: HTTP ${err.status} (${err.code}): ${err.message}`,
      );
      return 4;
    }
    console.error(`signalman release build --remote: ${(err as Error).message}`);
    return 4;
  }
}

async function followJob(
  client: HttpClient,
  jobId: string,
  out: NodeJS.WritableStream,
): Promise<Awaited<ReturnType<typeof client.getJob>>> {
  let lastStatus: string | null = null;
  while (true) {
    const job = await client.getJob(jobId);
    if (job.status !== lastStatus) {
      out.write(`  ${job.id} → ${job.status}\n`);
      lastStatus = job.status;
    }
    if (job.status === "succeeded" || job.status === "failed") {
      return job;
    }
    await new Promise((r) => setTimeout(r, 750));
  }
}

async function cmdReleaseList(args: ParsedArgs): Promise<number> {
  const productName = args.options.get("product");
  const statusOpt = args.options.get("status");
  const validStatuses = new Set(["building", "ready", "failed"]);
  if (statusOpt && !validStatuses.has(statusOpt)) {
    usageError(`release list: invalid --status '${statusOpt}' (expected building|ready|failed)`);
  }
  const status = statusOpt as "building" | "ready" | "failed" | undefined;
  const format = args.options.get("format");
  try {
    const entries = await withControlPlane((cp) =>
      runReleaseList(cp, { productName, status }),
    );
    if (format === "json") {
      emitJson(entries);
      return 0;
    }
    if (entries.length === 0) {
      process.stdout.write("(no releases)\n");
      return 0;
    }
    emitTable(
      entries.map((e) => ({
        product: e.product.name,
        tag: e.release.tag,
        status: e.release.status,
        commit: e.release.commitSha.slice(0, 7),
        id: e.release.id,
        built_at: e.release.builtAt ?? "—",
      })),
    );
    return 0;
  } catch (err) {
    console.error(`signalman release list: ${(err as Error).message}`);
    return 4;
  }
}

async function cmdReleaseShow(args: ParsedArgs): Promise<number> {
  const releaseId = args.positional[0];
  if (!releaseId) usageError("release show requires <release_id>");
  const format = args.options.get("format");
  try {
    const result = await withControlPlane((cp) =>
      runReleaseShow(cp, { releaseId }),
    );
    if (format === "json") {
      emitJson(result);
      return 0;
    }
    const r = result.release;
    process.stdout.write(
      `Release ${r.tag} (${r.id})\n` +
        `  product: ${result.product.name}\n` +
        `  status: ${r.status}\n` +
        `  commit: ${r.commitSha}\n` +
        `  manifest: ${r.manifestSha256 ?? "—"}\n` +
        `  built_at: ${r.builtAt ?? "—"}\n` +
        `  built_by: ${r.builtByRunnerId ?? "—"}\n` +
        `  artifacts (${result.artifacts.length}):\n`,
    );
    for (const a of result.artifacts) {
      const detail =
        a.kind === "blob"
          ? `sha256=${(a.sha256 ?? "").slice(0, 16)}… size=${a.sizeBytes ?? "?"}B`
          : `ref=${a.imageRef ?? ""}`;
      process.stdout.write(`    - ${a.component} (${a.kind}) ${detail}\n`);
    }
    return 0;
  } catch (err) {
    console.error(`signalman release show: ${(err as Error).message}`);
    return 4;
  }
}

// ── Entry point ───────────────────────────────────────────────────

async function main(argv: string[]): Promise<number> {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    printHelp();
    return 0;
  }
  const [verb, ...rest] = argv;
  const args = parseArgs(rest);

  try {
    switch (verb) {
      case "list":
        return await cmdList(args);
      case "describe":
        return await cmdDescribe(args);
      case "plan":
        return await cmdPlan(args);
      case "run":
        return await cmdRun(args);
      case "status":
        return await cmdStatus(args);
      case "record":
        return await cmdRecord(args);
      case "init":
        return cmdInit(args);
      case "vm":
        return await cmdVm(args);
      case "product":
        return await cmdProduct(args);
      case "release":
        return await cmdRelease(args);
      case "target":
        return await cmdTarget(args);
      case "health":
        return await cmdHealth(args);
      case "serve":
        return await cmdServe(args);
      case "api-key":
        return await cmdApiKey(args);
      case "runner":
        return await cmdRunner(args);
      case "key":
        return await cmdKey(args);
      default:
        usageError(`unknown verb: ${verb}`);
    }
  } catch (err) {
    if ((err as Error).name === "ScenarioNotFoundError") {
      console.error(`signalman: ${(err as Error).message}`);
      return 5;
    }
    if ((err as Error).name === "ScenarioValidationError") {
      console.error(`signalman: ${(err as Error).message}`);
      return 5;
    }
    if ((err as Error).name === "ParameterUnresolvedError") {
      console.error(`signalman: ${(err as Error).message}`);
      return 5;
    }
    if ((err as Error).name === "RecordValidationError") {
      console.error(`signalman: ${(err as Error).message}`);
      return 5;
    }
    console.error(`signalman: unhandled error: ${(err as Error).message}`);
    return 4;
  }
}

function printHelp(): void {
  process.stdout.write(
    [
      "Usage: signalman <verb> [options]",
      "",
      "Verbs:",
      "  init [--name PROJECT] [--force] [--bootstrap] [--format json]",
      "  list [--tag T] [--pattern P] [--format json]",
      "  describe <id> [--workflow] [--format json]",
      "  plan <id> [--param k=v]... [--format json]",
      "  run <id> [--param k=v]... [--no-follow] [--format json]",
      "  status [--run RUN_ID] [--wait MS]",
      "  record <name> [--duration SECS]",
      "  record finalize <recording_path_or_id> [--scenario-id ID] [--force]",
      "  vm <subcommand>   (provision, cleanup, create, install-bundle,",
      "                     fetch-template — see ROADMAP P9 / signalman vm --help)",
      "  product <subcommand>   (add, list, remove)",
      "  release <subcommand>   (build, list, show, deploy, rollback)",
      "  target <subcommand>    (add, list, remove)",
      "  health <subcommand>    (check, history)",
      "  serve [--port P] [--host H]   (start the control-plane HTTP server)",
      "  api-key <subcommand>   (create, list, revoke)",
      "  runner <subcommand>    (register, start)",
      "  key <subcommand>       (generate, fingerprint — Ed25519 release signing)",
      "",
      "Exit codes (per docs/design/p0-mcp-surface.md §5):",
      "  0  pass        2  workflow fail        4  infra error",
      "  1  assert fail 3  setup error          5  validation error  64 usage error",
    ].join("\n") + "\n",
  );
}

const isEntryPoint =
  import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}` ||
  process.argv[1]?.endsWith("cli.ts") ||
  process.argv[1]?.endsWith("cli.js");

if (isEntryPoint) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
