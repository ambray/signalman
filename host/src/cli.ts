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

import * as process from "node:process";
import { runList } from "./verbs/list.js";
import { runDescribe } from "./verbs/describe.js";
import { runPlan } from "./verbs/plan.js";
import { runRun } from "./verbs/run.js";
import { runStatus } from "./verbs/status.js";
import { runRecord } from "./verbs/record.js";
import { createDefaultExecutor } from "./verbs/default-executor.js";

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
      if (key === "follow" || key === "workflow" || key === "no-follow") {
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
      "  list [--tag T] [--pattern P] [--format json]",
      "  describe <id> [--workflow] [--format json]",
      "  plan <id> [--param k=v]... [--format json]",
      "  run <id> [--param k=v]... [--no-follow] [--format json]",
      "  status [--run RUN_ID] [--wait MS]",
      "  record <name> [--duration SECS]",
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
