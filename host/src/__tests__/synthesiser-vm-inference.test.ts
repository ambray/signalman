/**
 * v0.3.0-1 follow-up — synthesiser VM-inference tests.
 *
 * Covers the new `extractVmReferencesFromCalls` helper plus the
 * end-to-end behaviour: a recording referencing real VM names
 * produces a setup.yaml with those names instead of the legacy
 * `recorded-vm` placeholder.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  extractVmReferencesFromCalls,
  recordMcpCall,
  runRecord,
  runRecordFinalize,
  _resetRecordCaptureForTests,
} from "../verbs/record.js";

// ── extractVmReferencesFromCalls — pure helper ────────────────────

describe("extractVmReferencesFromCalls", () => {
  it("returns empty array for no calls", () => {
    expect(extractVmReferencesFromCalls([])).toEqual([]);
  });

  it("returns empty array when no calls reference VMs", () => {
    expect(
      extractVmReferencesFromCalls([
        { tool: "signalman_list", params_redacted: {} },
        { tool: "signalman_describe", params_redacted: { id: "smoke" } },
      ]),
    ).toEqual([]);
  });

  it("extracts the vm param from one call", () => {
    expect(
      extractVmReferencesFromCalls([
        {
          tool: "vm_run_command",
          params_redacted: { vm: "endpoint-1", command: "hostname" },
        },
      ]),
    ).toEqual(["endpoint-1"]);
  });

  it("dedupes vm references across multiple calls", () => {
    expect(
      extractVmReferencesFromCalls([
        {
          tool: "vm_run_command",
          params_redacted: { vm: "endpoint-1", command: "hostname" },
        },
        {
          tool: "vm_copy_file",
          params_redacted: { vm: "endpoint-1", src: "/x", dst: "/y" },
        },
        {
          tool: "vm_run_command",
          params_redacted: { vm: "endpoint-2", command: "uptime" },
        },
      ]),
    ).toEqual(["endpoint-1", "endpoint-2"]);
  });

  it("returns names sorted alphabetically", () => {
    expect(
      extractVmReferencesFromCalls([
        { tool: "vm_run_command", params_redacted: { vm: "zeta" } },
        { tool: "vm_run_command", params_redacted: { vm: "alpha" } },
        { tool: "vm_run_command", params_redacted: { vm: "middle" } },
      ]),
    ).toEqual(["alpha", "middle", "zeta"]);
  });

  it("accepts both vm and vm_name param keys", () => {
    expect(
      extractVmReferencesFromCalls([
        { tool: "older_tool", params_redacted: { vm_name: "old-style-vm" } },
        { tool: "vm_run_command", params_redacted: { vm: "new-style-vm" } },
      ]),
    ).toEqual(["new-style-vm", "old-style-vm"]);
  });

  it("ignores non-string vm values defensively", () => {
    expect(
      extractVmReferencesFromCalls([
        // @ts-expect-error — types from JSON capture may drift
        { tool: "vm_run_command", params_redacted: { vm: 42 } },
        // @ts-expect-error — same
        { tool: "vm_run_command", params_redacted: { vm: null } },
        { tool: "vm_run_command", params_redacted: { vm: "real-vm" } },
      ]),
    ).toEqual(["real-vm"]);
  });

  it("ignores empty-string vm values", () => {
    expect(
      extractVmReferencesFromCalls([
        { tool: "vm_run_command", params_redacted: { vm: "" } },
        { tool: "vm_run_command", params_redacted: { vm: "real-vm" } },
      ]),
    ).toEqual(["real-vm"]);
  });

  it("rejects names with unsafe characters", () => {
    // A corrupted recording with shell-metacharacter VM names
    // shouldn't produce a setup.yaml with names the orchestrator
    // would later choke on. Drop them silently.
    expect(
      extractVmReferencesFromCalls([
        { tool: "vm_run_command", params_redacted: { vm: "../../../etc/passwd" } },
        { tool: "vm_run_command", params_redacted: { vm: "bad name with spaces" } },
        { tool: "vm_run_command", params_redacted: { vm: "endpoint-1" } },
      ]),
    ).toEqual(["endpoint-1"]);
  });

  it("respects the 64-char name length cap", () => {
    const tooLong = "a".repeat(65);
    const ok = "a".repeat(64);
    expect(
      extractVmReferencesFromCalls([
        { tool: "vm_run_command", params_redacted: { vm: tooLong } },
        { tool: "vm_run_command", params_redacted: { vm: ok } },
      ]),
    ).toEqual([ok]);
  });

  it("skips calls with no params_redacted object", () => {
    expect(
      extractVmReferencesFromCalls([
        // @ts-expect-error — sparse recordings may omit fields
        { tool: "vm_run_command" },
        // @ts-expect-error — params is the wrong shape
        { tool: "vm_run_command", params_redacted: "stringly typed" },
        { tool: "vm_run_command", params_redacted: { vm: "real-vm" } },
      ]),
    ).toEqual(["real-vm"]);
  });
});

// ── End-to-end: setup.yaml carries the inferred VMs ───────────────

function makeProject(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "signalman-synth-vm-"));
  fs.mkdirSync(path.join(root, ".signalman"), { recursive: true });
  return root;
}

describe("synthesizeScenarioFromCalls — VM inference end-to-end", () => {
  let root: string;
  let priorCwd: string;

  beforeEach(() => {
    root = makeProject();
    priorCwd = process.cwd();
    process.chdir(root);
    _resetRecordCaptureForTests();
  });

  afterEach(() => {
    process.chdir(priorCwd);
    fs.rmSync(root, { recursive: true, force: true });
    _resetRecordCaptureForTests();
  });

  it("emits the recorded VM name in setup.yaml when one is observed", () => {
    const r = runRecord({ name: "single-vm-flow", duration_seconds: 60 }, root);
    recordMcpCall(
      {
        tool: "signalman_advanced_vm_run_command",
        params: { vm: "endpoint-1", command: "hostname" },
        result: { content: [{ type: "text", text: "ok" }] },
      },
      root,
    );

    const finalized = runRecordFinalize(
      { recording_path: r.recording_path, scenario_id: "candidate/single" },
      root,
    );

    const setup = fs.readFileSync(finalized.setup_path, "utf-8");
    expect(setup).toContain("name: endpoint-1");
    expect(setup).not.toContain("name: recorded-vm");
  });

  it("emits multiple VM entries when multiple names are observed", () => {
    const r = runRecord({ name: "multi-vm-flow", duration_seconds: 60 }, root);
    recordMcpCall(
      {
        tool: "signalman_advanced_vm_run_command",
        params: { vm: "endpoint-a", command: "hostname" },
        result: { content: [] },
      },
      root,
    );
    recordMcpCall(
      {
        tool: "signalman_advanced_vm_run_command",
        params: { vm: "endpoint-b", command: "hostname" },
        result: { content: [] },
      },
      root,
    );

    const finalized = runRecordFinalize(
      { recording_path: r.recording_path, scenario_id: "candidate/multi" },
      root,
    );

    const setup = fs.readFileSync(finalized.setup_path, "utf-8");
    expect(setup).toContain("name: endpoint-a");
    expect(setup).toContain("name: endpoint-b");
    // Placeholder is gone now that real names were inferred.
    expect(setup).not.toContain("name: recorded-vm");
  });

  it("falls back to recorded-vm placeholder when no VM references are observed", () => {
    const r = runRecord({ name: "no-vm-flow", duration_seconds: 60 }, root);
    // signalman_list doesn't carry a vm param; the synthesiser
    // has no real name to infer.
    recordMcpCall(
      {
        tool: "signalman_list",
        params: {},
        result: { content: [] },
      },
      root,
    );

    const finalized = runRecordFinalize(
      { recording_path: r.recording_path, scenario_id: "candidate/empty" },
      root,
    );

    const setup = fs.readFileSync(finalized.setup_path, "utf-8");
    expect(setup).toContain("name: recorded-vm");
  });
});
