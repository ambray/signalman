/**
 * v0.3.0-1 follow-up — CLI direct-invocation capture tests.
 *
 * The CLI's `withCliCapture` wrapper extends record/replay coverage
 * to direct `signalman ...` invocations so an agent that mixes CLI
 * usage with MCP tool usage produces a single unified
 * `calls.jsonl`. These tests exercise the wrapper against a real
 * recording session in a tmpdir + verify the captured records
 * carry the verb name, normalised args, exit code, and error
 * shape.
 *
 * The exported helpers under test:
 *   - `parsedArgsToRecord(args)` — pure, no I/O
 *   - the calls.jsonl that the wrapper writes via `recordMcpCall`
 *
 * The wrapper itself is not exported (it's internal to cli.ts) but
 * we exercise its observable contract via the public
 * `recordMcpCall` + `runRecord` surface.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  recordMcpCall,
  runRecord,
  _resetRecordCaptureForTests,
} from "../verbs/record.js";
import { parsedArgsToRecord } from "../cli.js";

// ── parsedArgsToRecord — pure helper ──────────────────────────────

describe("parsedArgsToRecord", () => {
  it("preserves positional args in order", () => {
    const r = parsedArgsToRecord({
      positional: ["foo", "bar"],
      options: new Map(),
      flags: new Set(),
      params: {},
    });
    expect(r.positional).toEqual(["foo", "bar"]);
  });

  it("converts options Map to plain object", () => {
    const r = parsedArgsToRecord({
      positional: [],
      options: new Map([
        ["scenario-id", "smoke"],
        ["older-than", "1h"],
      ]),
      flags: new Set(),
      params: {},
    });
    expect(r.options).toEqual({
      "scenario-id": "smoke",
      "older-than": "1h",
    });
  });

  it("converts flags Set to sorted array (or unsorted — just an array)", () => {
    const r = parsedArgsToRecord({
      positional: [],
      options: new Map(),
      flags: new Set(["dry-run", "force"]),
      params: {},
    });
    expect((r.flags as string[]).sort()).toEqual(["dry-run", "force"]);
  });

  it("captures --param entries separately from options", () => {
    const r = parsedArgsToRecord({
      positional: ["scenario-x"],
      options: new Map([["format", "json"]]),
      flags: new Set(),
      params: { vm: "endpoint-1", tier: "gold" },
    });
    expect(r.params).toEqual({ vm: "endpoint-1", tier: "gold" });
    // Options + params are surfaced as separate keys so the replay
    // synthesiser can distinguish CLI metadata flags from scenario
    // parameter values.
    expect(r.options).toEqual({ format: "json" });
  });

  it("returns empty containers for an empty ParsedArgs", () => {
    const r = parsedArgsToRecord({
      positional: [],
      options: new Map(),
      flags: new Set(),
      params: {},
    });
    expect(r.positional).toEqual([]);
    expect(r.options).toEqual({});
    expect(r.flags).toEqual([]);
    expect(r.params).toEqual({});
  });
});

// ── End-to-end: capture writes to calls.jsonl ─────────────────────

describe("CLI capture round-trip via recordMcpCall", () => {
  let projectRoot: string;
  let priorCwd: string;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "signalman-cli-capture-"));
    fs.mkdirSync(path.join(projectRoot, ".signalman"), { recursive: true });
    priorCwd = process.cwd();
    process.chdir(projectRoot);
    _resetRecordCaptureForTests();
  });

  afterEach(() => {
    process.chdir(priorCwd);
    fs.rmSync(projectRoot, { recursive: true, force: true });
    _resetRecordCaptureForTests();
  });

  it("captures a CLI-style call into the active recording session", () => {
    // Start a recording session so subsequent recordMcpCall
    // invocations land in calls.jsonl.
    const rec = runRecord({ name: "cli-capture-test" });
    expect(rec.status).toBe("recording");
    expect(fs.existsSync(rec.calls_path)).toBe(true);

    // Simulate what withCliCapture does for `signalman run foo`.
    recordMcpCall({
      tool: "cli.run",
      params: {
        positional: ["foo"],
        options: { format: "json" },
        flags: [],
        params: {},
      },
      result: { exit_code: 0 },
      started_at: "2026-05-13T10:00:00.000Z",
      finished_at: "2026-05-13T10:00:01.500Z",
      duration_ms: 1500,
    });

    const lines = fs
      .readFileSync(rec.calls_path, "utf-8")
      .split("\n")
      .filter((l) => l.trim().length > 0);
    expect(lines).toHaveLength(1);
    const ev = JSON.parse(lines[0]);
    expect(ev.tool).toBe("cli.run");
    expect(ev.ok).toBe(true);
    expect(ev.params_redacted.positional).toEqual(["foo"]);
    expect(ev.result_redacted.exit_code).toBe(0);
    expect(ev.duration_ms).toBe(1500);
  });

  it("captures error-path invocations with ok=false", () => {
    const rec = runRecord({ name: "cli-capture-err" });

    recordMcpCall({
      tool: "cli.run",
      params: { positional: ["broken-scenario"] },
      error: new Error("ScenarioNotFoundError: no such scenario"),
      started_at: "2026-05-13T10:00:00.000Z",
      finished_at: "2026-05-13T10:00:00.100Z",
      duration_ms: 100,
    });

    const lines = fs
      .readFileSync(rec.calls_path, "utf-8")
      .split("\n")
      .filter((l) => l.trim().length > 0);
    expect(lines).toHaveLength(1);
    const ev = JSON.parse(lines[0]);
    expect(ev.tool).toBe("cli.run");
    expect(ev.ok).toBe(false);
    expect(ev.error).toBeDefined();
    expect(ev.result_redacted).toBeUndefined();
  });

  it("redaction layer scrubs sensitive option values", () => {
    const rec = runRecord({ name: "cli-capture-redact" });

    recordMcpCall({
      tool: "cli.run",
      params: {
        positional: ["my-scenario"],
        options: {
          format: "json",
          // These keys match the SENSITIVE_KEY_RE in record.ts and
          // should be redacted before they land in calls.jsonl.
          token: "secret-abc-123",
          password: "hunter2",
          api_key: "sk_live_xxxxxxxxxxxxx",
        },
      },
      result: { exit_code: 0 },
    });

    const lines = fs
      .readFileSync(rec.calls_path, "utf-8")
      .split("\n")
      .filter((l) => l.trim().length > 0);
    const ev = JSON.parse(lines[0]);
    const opts = ev.params_redacted.options as Record<string, unknown>;
    expect(opts.format).toBe("json");
    expect(opts.token).not.toBe("secret-abc-123");
    expect(opts.password).not.toBe("hunter2");
    expect(opts.api_key).not.toBe("sk_live_xxxxxxxxxxxxx");
  });

  it("is a no-op when no recording session is active", () => {
    // No runRecord — recordMcpCall should silently no-op rather
    // than throw or create a fixture file in the wrong place.
    expect(() =>
      recordMcpCall({
        tool: "cli.list",
        params: { positional: [] },
        result: { exit_code: 0 },
      }),
    ).not.toThrow();
    // No recordings dir gets created when there's no active
    // session.
    const recordingsDir = path.join(projectRoot, ".signalman", "recordings");
    expect(fs.existsSync(recordingsDir)).toBe(false);
  });
});
