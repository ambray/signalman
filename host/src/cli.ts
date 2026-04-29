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
 */

import * as path from "node:path";
import * as process from "node:process";
import { runList } from "./verbs/list.js";
import { runDescribe } from "./verbs/describe.js";
import { runPlan } from "./verbs/plan.js";
import { runRun } from "./verbs/run.js";
import { runStatus } from "./verbs/status.js";
import { runRecord } from "./verbs/record.js";
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
        key === "cleanup-on-failure"
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
  const name = args.positional[0];
  if (!name) usageError("record requires <name>");
  const duration = args.options.get("duration") ? parseInt(args.options.get("duration") ?? "600", 10) : undefined;
  const result = runRecord({ name, duration_seconds: duration });
  emitJson(result);
  return 0;
}

// ── init (P9.3) ───────────────────────────────────────────────────
//
// Locked design: minimal scaffold by default, --bootstrap is reserved
// for the interactive flow that composes vm fetch-template (P9.5) +
// vm provision (P9.1). Re-runs are idempotent unless --force is set.

function cmdInit(args: ParsedArgs): number {
  const projectName = args.options.get("name");
  const force = args.flags.has("force");
  const bootstrap = args.flags.has("bootstrap");

  const result = runInit({ projectName, force, bootstrap });

  if (args.options.get("format") === "json") {
    emitJson(result);
    return 0;
  }

  // Plaintext output — first the human-friendly summary, then the
  // bootstrap-deferred message on stderr if --bootstrap was set.
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
  if (result.bootstrapDeferredMessage) {
    process.stderr.write("\n" + result.bootstrapDeferredMessage + "\n");
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
      "vm requires a subcommand (e.g. fetch-template, provision, cleanup, install-bundle)",
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
    default:
      usageError(`unknown vm subcommand: ${sub}`);
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
 * Lazy import keeps the Hyper-V module out of the macOS code path so
 * `signalman list` / `signalman describe` etc still work
 * cross-platform on dev machines that aren't Hyper-V hosts.
 */
async function getCliBackend(): Promise<HypervisorBackend> {
  const { HyperVBackend } = await import("./hypervisors/hyperv.js");
  return new HyperVBackend();
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
      "  vm <subcommand>   (provision, cleanup, create, install-bundle,",
      "                     fetch-template — see ROADMAP P9 / signalman vm --help)",
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
