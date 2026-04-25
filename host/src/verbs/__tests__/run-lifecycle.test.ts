/**
 * Integration test: full `signalman.run` lifecycle.
 *
 * Issues a handle via runRun() with a fake executor, drains events
 * via runStatus() until terminal, and asserts that the envelope
 * matches the events emitted.
 */

import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runRun, type RunExecutor } from "../run.js";
import { runStatus } from "../status.js";
import { _resetForTests } from "../run-store.js";

function makeProject(scenarios: Record<string, Record<string, string>>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "run-lifecycle-test-"));
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

beforeEach(() => _resetForTests());

describe("run lifecycle (handle → events → envelope)", () => {
  it("issues a run_id immediately, then streams events to terminal", async () => {
    const root = makeProject({ smoke: { "setup.yaml": minimalSetup } });

    const fakeExecutor: RunExecutor = async (ctx) => {
      ctx.emit({ type: "step.started", step_index: 0, kind: "vm.start", vm: "endpoint-1" });
      await new Promise((r) => setTimeout(r, 5));
      ctx.emit({ type: "step.completed", step_index: 0, duration_ms: 5 });
      ctx.emit({ type: "assertion.passed", id: "a1" });
      return {
        result: "pass",
        assertions: {
          total: 1,
          passed: 1,
          failed: 0,
          results: [{ id: "a1", passed: true, severity: "high" }],
        },
        errors: [],
      };
    };

    const handle = await runRun({ id: "smoke" }, fakeExecutor, root);
    expect(handle.run_id).toMatch(/^run_/);
    expect(handle.scenario_hash).toMatch(/^sha256:/);
    expect(handle.status).toBe("running");

    // Drain until terminal.
    let since = 0;
    let envelope = null;
    let safety = 30;
    const collected: string[] = [];
    while (envelope === null && safety-- > 0) {
      const status = await runStatus({ run_id: handle.run_id, since_event_seq: since, wait_ms: 500 });
      if ("events" in status) {
        for (const e of status.events) {
          collected.push(e.type);
          since = e.seq + 1;
        }
        if (status.envelope) {
          envelope = status.envelope;
        }
      }
    }
    expect(envelope).not.toBeNull();
    expect(envelope!.result).toBe("pass");
    expect(envelope!.exit_code).toBe(0);
    expect(envelope!.scenario_id).toBe("smoke");
    expect(envelope!.assertions.total).toBe(1);
    expect(envelope!.assertions.passed).toBe(1);
    // Events should include run.started and run.finished bookends.
    expect(collected[0]).toBe("run.started");
    expect(collected[collected.length - 1]).toBe("run.finished");
    // Step + assertion events appear between bookends.
    expect(collected).toContain("step.started");
    expect(collected).toContain("step.completed");
    expect(collected).toContain("assertion.passed");
  });

  it("maps fail+assertion -> exit_code 1", async () => {
    const root = makeProject({ smoke: { "setup.yaml": minimalSetup } });
    const failer: RunExecutor = async () => ({
      result: "fail",
      assertions: { total: 1, passed: 0, failed: 1, results: [{ id: "x", passed: false, severity: "critical" }] },
      errors: [],
      breakdown: "assertion",
    });
    const handle = await runRun({ id: "smoke" }, failer, root);
    // Wait for terminal
    let envelope = null;
    let safety = 20;
    while (envelope === null && safety-- > 0) {
      const status = await runStatus({ run_id: handle.run_id, wait_ms: 500 });
      if ("envelope" in status) envelope = status.envelope;
    }
    expect(envelope!.exit_code).toBe(1);
  });

  it("maps error+infra -> exit_code 4", async () => {
    const root = makeProject({ smoke: { "setup.yaml": minimalSetup } });
    const erroring: RunExecutor = async () => {
      throw new Error("backend-unavailable");
    };
    const handle = await runRun({ id: "smoke" }, erroring, root);
    let envelope = null;
    let safety = 20;
    while (envelope === null && safety-- > 0) {
      const status = await runStatus({ run_id: handle.run_id, wait_ms: 500 });
      if ("envelope" in status) envelope = status.envelope;
    }
    expect(envelope!.result).toBe("error");
    expect(envelope!.exit_code).toBe(4);
    expect(envelope!.errors).toContain("backend-unavailable");
  });

  it("writes last-run.json into recordings/", async () => {
    const root = makeProject({ smoke: { "setup.yaml": minimalSetup } });
    const passer: RunExecutor = async () => ({
      result: "pass",
      assertions: { total: 0, passed: 0, failed: 0, results: [] },
      errors: [],
    });
    const handle = await runRun({ id: "smoke" }, passer, root);
    // Wait for terminal
    let safety = 20;
    while (safety-- > 0) {
      const status = await runStatus({ run_id: handle.run_id, wait_ms: 500 });
      if ("envelope" in status && status.envelope) break;
    }
    const lastRunPath = path.join(root, ".signalman", "recordings", "smoke", "last-run.json");
    expect(fs.existsSync(lastRunPath)).toBe(true);
    const lr = JSON.parse(fs.readFileSync(lastRunPath, "utf-8"));
    expect(lr.result).toBe("pass");
  });
});
