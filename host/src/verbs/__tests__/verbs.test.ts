/**
 * Unit tests for `signalman.list / describe / plan / record / status`.
 *
 * Each verb is exercised against a temp `.signalman/scenarios/` tree
 * so the test is independent of the repo's own scenarios.
 */

import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runList } from "../list.js";
import { runDescribe, ScenarioNotFoundError } from "../describe.js";
import { runPlan, ParameterUnresolvedError } from "../plan.js";
import {
  _resetRecordCaptureForTests,
  recordMcpCall,
  runRecord,
  runRecordFinalize,
} from "../record.js";
import { runStatus } from "../status.js";
import { _resetForTests } from "../run-store.js";

function makeProject(scenarios: Record<string, Record<string, string>>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "verbs-test-"));
  fs.mkdirSync(path.join(root, ".signalman", "scenarios"), { recursive: true });
  for (const [id, files] of Object.entries(scenarios)) {
    const dir = path.join(root, ".signalman", "scenarios", ...id.split("/"));
    fs.mkdirSync(dir, { recursive: true });
    for (const [name, content] of Object.entries(files)) {
      fs.writeFileSync(path.join(dir, name), content);
    }
  }
  return root;
}

const minimalSetup = `name: Smoke
version: "1.0"
tags: [smoke]
vms:
  - name: endpoint-1
    template: win11-base
    guest_agent_port: 50051
`;

beforeEach(() => {
  _resetForTests();
  _resetRecordCaptureForTests();
});

describe("signalman.list", () => {
  it("enumerates scenarios", () => {
    const root = makeProject({
      smoke: { "setup.yaml": minimalSetup },
      "mygroup/v2/scenario-b": { "setup.yaml": minimalSetup },
    });
    const out = runList({}, root);
    expect(out.scenarios.map((s) => s.id).sort()).toEqual([
      "mygroup/v2/scenario-b",
      "smoke",
    ]);
    for (const s of out.scenarios) {
      expect(s.scenario_hash).toMatch(/^sha256:/);
      expect(s.tags).toEqual(["smoke"]);
    }
  });

  it("retains sub-directory ids with forward slashes", () => {
    const root = makeProject({
      "mygroup/v2/scenario-a": { "setup.yaml": minimalSetup },
    });
    const out = runList({}, root);
    expect(out.scenarios[0].id).toBe("mygroup/v2/scenario-a");
  });

  it("filters by tag", () => {
    const root = makeProject({
      a: { "setup.yaml": minimalSetup },
      b: { "setup.yaml": minimalSetup.replace("[smoke]", "[other]") },
    });
    const out = runList({ tag: "smoke" }, root);
    expect(out.scenarios).toHaveLength(1);
    expect(out.scenarios[0].id).toBe("a");
  });

  it("filters by glob pattern", () => {
    const root = makeProject({
      "mygroup/v2/a": { "setup.yaml": minimalSetup },
      "mygroup/v2/b": { "setup.yaml": minimalSetup },
      "smoke": { "setup.yaml": minimalSetup },
    });
    const out = runList({ pattern: "mygroup/**" }, root);
    expect(out.scenarios.map((s) => s.id).sort()).toEqual(["mygroup/v2/a", "mygroup/v2/b"]);
  });

  it("surfaces YAML parse errors per-entry without failing the whole call", () => {
    const root = makeProject({
      good: { "setup.yaml": minimalSetup },
      bad: { "setup.yaml": "not: valid: yaml: here:\n  - [\n" },
    });
    const out = runList({}, root);
    expect(out.scenarios).toHaveLength(2);
    const bad = out.scenarios.find((s) => s.id === "bad");
    expect(bad?.error).toMatch(/yaml-parse/);
  });
});

describe("signalman.describe", () => {
  it("returns parsed setup, assertions, workflow, hash", () => {
    const root = makeProject({
      smoke: {
        "setup.yaml": minimalSetup,
        "assertions.yaml": "assertions: []\npass_threshold: 1.0\n",
        "workflow.md": "# Smoke\n",
      },
    });
    const out = runDescribe({ id: "smoke" }, root);
    expect(out.scenario_hash).toMatch(/^sha256:/);
    expect((out.setup as { name: string }).name).toBe("Smoke");
    expect(out.workflow_markdown).toBe("# Smoke\n");
  });

  it("throws ScenarioNotFoundError for unknown id", () => {
    const root = makeProject({});
    expect(() => runDescribe({ id: "missing" }, root)).toThrow(ScenarioNotFoundError);
  });

  it("rejects path traversal", () => {
    const root = makeProject({ smoke: { "setup.yaml": minimalSetup } });
    expect(() => runDescribe({ id: "../../etc/passwd" }, root)).toThrow(/Invalid scenario id/);
  });
});

describe("signalman.plan", () => {
  it("returns vms, steps, affected_resources, warnings", () => {
    const root = makeProject({
      smoke: {
        "setup.yaml":
          minimalSetup +
          "setup:\n  - action: vm_run_command\n    vm: endpoint-1\n    command: dir\n",
        "workflow.md":
          "## Step\n\n```tool\nvm_run_command:\n  vm: endpoint-1\n  command: ipconfig\n```\n",
      },
    });
    const out = runPlan({ id: "smoke" }, root);
    expect(out.vms).toHaveLength(1);
    expect(out.affected_resources.vms).toEqual(["endpoint-1"]);
    // Steps: vm.start (1) + tool.vm_run_command (setup) + tool.vm_run_command (workflow)
    expect(out.steps.length).toBeGreaterThanOrEqual(3);
    expect(out.warnings).toEqual([]);
  });

  it("warns on ${secret:NAME} references", () => {
    const root = makeProject({
      smoke: {
        "setup.yaml":
          minimalSetup +
          "parameters:\n  api_key: \"${secret:EXAMPLE_API_KEY}\"\n",
      },
    });
    const out = runPlan({ id: "smoke" }, root);
    expect(out.warnings.some((w) => w.includes("secret-reference"))).toBe(true);
  });

  it("substitutes ${param:NAME} from supplied parameters", () => {
    const root = makeProject({
      smoke: {
        "setup.yaml":
          minimalSetup +
          "setup:\n  - action: vm_run_command\n    vm: endpoint-1\n    command: \"${param:cmd}\"\n",
      },
    });
    const out = runPlan({ id: "smoke", parameters: { cmd: "ipconfig" } }, root);
    const step = out.steps.find((s) => s.kind === "tool.vm_run_command");
    expect(step).toBeDefined();
    expect((step?.params as { command?: string })?.command).toBe("ipconfig");
  });

  it("throws ParameterUnresolvedError for missing param without default", () => {
    const root = makeProject({
      smoke: {
        "setup.yaml":
          minimalSetup +
          "setup:\n  - action: vm_run_command\n    vm: endpoint-1\n    command: \"${param:missing}\"\n",
      },
    });
    expect(() => runPlan({ id: "smoke" }, root)).toThrow(ParameterUnresolvedError);
  });

  it("falls back to default in ${param:NAME:-default}", () => {
    const root = makeProject({
      smoke: {
        "setup.yaml":
          minimalSetup +
          "setup:\n  - action: vm_run_command\n    vm: endpoint-1\n    command: \"${param:cmd:-dir}\"\n",
      },
    });
    const out = runPlan({ id: "smoke" }, root);
    const step = out.steps.find((s) => s.kind === "tool.vm_run_command");
    expect((step?.params as { command?: string })?.command).toBe("dir");
  });
});

describe("signalman.record", () => {
  it("starts a durable recording session", () => {
    const root = makeProject({});
    const r = runRecord({ name: "Demo Flow", duration_seconds: 30 }, root);

    expect(r.status).toBe("recording");
    expect(r.recording_id).toMatch(/^rec_/);
    expect(r.name).toBe("Demo Flow");
    expect(r.safe_name).toBe("demo-flow");
    expect(r.duration_seconds).toBe(30);
    expect(r.recording_path).toContain(path.join(".signalman", "recordings", "demo-flow"));
    expect(fs.existsSync(r.state_path)).toBe(true);
    expect(fs.existsSync(r.calls_path)).toBe(true);

    const state = JSON.parse(fs.readFileSync(r.state_path, "utf-8"));
    expect(state).toMatchObject({
      schema_version: 1,
      status: "recording",
      recording_id: r.recording_id,
      name: "Demo Flow",
      safe_name: "demo-flow",
      duration_seconds: 30,
      captured_call_count: 0,
      calls_path: "calls.jsonl",
    });
    expect(fs.readFileSync(r.calls_path, "utf-8")).toBe("");
  });

  it("defaults duration and rejects unsafe record names", () => {
    const root = makeProject({});
    const r = runRecord({ name: "demo" }, root);

    expect(r.duration_seconds).toBe(600);
    expect(() => runRecord({ name: "   " }, root)).toThrow(/must not be empty/);
    expect(() => runRecord({ name: "!!!" }, root)).toThrow(/letter or number/);
  });

  it("rejects invalid durations", () => {
    const root = makeProject({});

    expect(() => runRecord({ name: "demo", duration_seconds: 0 }, root)).toThrow(/duration_seconds/);
    expect(() => runRecord({ name: "demo", duration_seconds: 86_401 }, root)).toThrow(/duration_seconds/);
    expect(() => runRecord({ name: "demo", duration_seconds: 1.5 }, root)).toThrow(/duration_seconds/);
  });

  it("appends redacted MCP calls to active recordings", () => {
    const root = makeProject({});
    const r = runRecord({ name: "Demo Flow", duration_seconds: 30 }, root);

    recordMcpCall(
      {
        tool: "signalman_plan",
        params: {
          id: "demo",
          authToken: "secret-token",
          nested: { password: "secret-password" },
        },
        result: {
          url: "https://user:pass@example.test/path",
          output: "x".repeat(4_200),
        },
        started_at: "2026-05-10T00:00:00.000Z",
        finished_at: "2026-05-10T00:00:00.010Z",
        duration_ms: 10,
      },
      root,
    );

    const lines = fs.readFileSync(r.calls_path, "utf-8").trim().split(/\r?\n/);
    expect(lines).toHaveLength(1);
    const event = JSON.parse(lines[0]);
    expect(event).toMatchObject({
      schema_version: 1,
      seq: 0,
      recording_id: r.recording_id,
      tool: "signalman_plan",
      ok: true,
      duration_ms: 10,
    });
    expect(event.params_redacted.authToken).toBe("[redacted]");
    expect(event.params_redacted.nested.password).toBe("[redacted]");
    expect(event.result_redacted.url).not.toContain("user:pass");
    expect(event.result_redacted.output).toContain("[truncated ");

    const state = JSON.parse(fs.readFileSync(r.state_path, "utf-8"));
    expect(state.captured_call_count).toBe(1);
  });

  it("rediscovers active recordings after process-local state is reconstituted", () => {
    const root = makeProject({});
    const r = runRecord({ name: "Demo Flow", duration_seconds: 30 }, root);
    _resetRecordCaptureForTests();

    recordMcpCall(
      {
        tool: "signalman_status",
        params: { run_id: "run_1" },
        error: new Error("not found"),
      },
      root,
    );

    const event = JSON.parse(fs.readFileSync(r.calls_path, "utf-8").trim());
    expect(event).toMatchObject({
      seq: 0,
      tool: "signalman_status",
      ok: false,
      error: { name: "Error", message: "not found" },
    });
  });

  it("finalizes a recording into deterministic candidate scenario files", () => {
    const root = makeProject({});
    const r = runRecord({ name: "Demo Flow", duration_seconds: 30 }, root);
    recordMcpCall(
      {
        tool: "signalman_advanced_vm_run_command",
        params: { vm: "endpoint-1", command: "hostname", authToken: "secret-token" },
        result: { content: [{ type: "text", text: "ok" }] },
      },
      root,
    );
    recordMcpCall(
      {
        tool: "signalman_list",
        params: {},
        result: { content: [] },
      },
      root,
    );
    fs.appendFileSync(r.calls_path, "{not-json}\n");

    const finalized = runRecordFinalize(
      { recording_path: r.recording_path, scenario_id: "recorded/demo-flow" },
      root,
    );

    expect(finalized).toMatchObject({
      status: "finalized",
      recording_id: r.recording_id,
      scenario_id: "recorded/demo-flow",
      captured_call_count: 2,
      emitted_tool_blocks: 1,
      skipped_call_count: 1,
      malformed_line_count: 1,
    });
    const setup = fs.readFileSync(finalized.setup_path, "utf-8");
    const workflow = fs.readFileSync(finalized.workflow_path, "utf-8");
    const assertions = fs.readFileSync(finalized.assertions_path, "utf-8");
    expect(setup).toContain("name: Demo Flow candidate");
    expect(setup).toContain("pre_started: true");
    expect(workflow).toContain("vm_run_command:");
    expect(workflow).toContain('authToken: "[redacted]"');
    expect(workflow).toContain("Skipped recorded MCP call 1: signalman_list");
    expect(workflow).toContain("1 malformed calls.jsonl line(s) were ignored");
    expect(assertions).toContain("assertions: []");

    const state = JSON.parse(fs.readFileSync(r.state_path, "utf-8"));
    expect(state.status).toBe("finalized");
    expect(state.scenario_id).toBe("recorded/demo-flow");
  });

  it("refuses to overwrite finalized candidate scenarios unless forced", () => {
    const root = makeProject({});
    const r = runRecord({ name: "Demo Flow", duration_seconds: 30 }, root);
    runRecordFinalize({ recording_path: r.recording_path, scenario_id: "demo-flow" }, root);

    expect(() =>
      runRecordFinalize({ recording_path: r.recording_path, scenario_id: "demo-flow" }, root),
    ).toThrow(/already exists/);
    expect(
      runRecordFinalize({ recording_path: r.recording_path, scenario_id: "demo-flow", force: true }, root)
        .status,
    ).toBe("finalized");
  });

  it("validates finalize lookup and scenario id inputs defensively", () => {
    const root = makeProject({});
    const r = runRecord({ name: "Demo Flow", duration_seconds: 30 }, root);

    expect(() =>
      runRecordFinalize({ recording_path: r.recording_path, scenario_id: "../escape" }, root),
    ).toThrow(/scenario_id/);
    expect(() => runRecordFinalize({ recording_id: "../bad" }, root)).toThrow(/recording_id/);
    expect(() => runRecordFinalize({}, root)).toThrow(/record finalize requires/);
  });

  it("surfaces malformed recording state as a validation error", () => {
    const root = makeProject({});
    const badDir = path.join(root, ".signalman", "recordings", "bad", "rec_bad");
    fs.mkdirSync(badDir, { recursive: true });
    fs.writeFileSync(path.join(badDir, "state.json"), "{not-json}\n");

    expect(() => runRecordFinalize({ recording_path: badDir }, root)).toThrow(
      /cannot read recording state/,
    );
  });

  it("rejects unsafe calls_path values from recording state", () => {
    const root = makeProject({});
    const r = runRecord({ name: "Demo Flow", duration_seconds: 30 }, root);
    const state = JSON.parse(fs.readFileSync(r.state_path, "utf-8"));
    fs.writeFileSync(r.state_path, JSON.stringify({ ...state, calls_path: "../calls.jsonl" }));

    expect(() => runRecordFinalize({ recording_path: r.recording_path }, root)).toThrow(
      /unsafe calls_path/,
    );
  });
});

describe("signalman.status (env mode)", () => {
  it("returns service_status + agent_version when no run_id", async () => {
    const r = await runStatus({});
    expect("service_status" in r ? r.service_status : null).toBe("ok");
  });

  it("returns not-found for unknown run_id", async () => {
    const r = await runStatus({ run_id: "no-such-run" });
    expect("status" in r ? r.status : null).toBe("not-found");
  });
});
