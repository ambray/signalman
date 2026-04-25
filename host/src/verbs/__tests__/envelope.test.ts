import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  computeScenarioHash,
  EventQueue,
  exitCodeFor,
  agentVersion,
} from "../../output/envelope.js";

function tmpScenario(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "envelope-test-"));
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

describe("computeScenarioHash", () => {
  it("returns a sha256:<64hex> string", () => {
    const dir = tmpScenario({
      "setup.yaml": "name: smoke\nversion: '1.0'\nvms: []\n",
    });
    const h = computeScenarioHash(dir);
    expect(h).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("is deterministic across runs over identical inputs", () => {
    const a = tmpScenario({
      "setup.yaml": "name: smoke\nversion: '1.0'\nvms: []\n",
      "assertions.yaml": "assertions: []\n",
      "workflow.md": "# Hello\n",
    });
    const b = tmpScenario({
      "setup.yaml": "name: smoke\nversion: '1.0'\nvms: []\n",
      "assertions.yaml": "assertions: []\n",
      "workflow.md": "# Hello\n",
    });
    expect(computeScenarioHash(a)).toBe(computeScenarioHash(b));
  });

  it("is invariant to YAML key order (canonicalised)", () => {
    const a = tmpScenario({
      "setup.yaml": "name: smoke\nversion: '1.0'\nvms: []\n",
    });
    const b = tmpScenario({
      "setup.yaml": "vms: []\nversion: '1.0'\nname: smoke\n",
    });
    expect(computeScenarioHash(a)).toBe(computeScenarioHash(b));
  });

  it("is invariant to workflow.md trailing whitespace", () => {
    const a = tmpScenario({
      "setup.yaml": "name: smoke\nversion: '1.0'\nvms: []\n",
      "workflow.md": "# Hello\n\n",
    });
    const b = tmpScenario({
      "setup.yaml": "name: smoke\nversion: '1.0'\nvms: []\n",
      "workflow.md": "# Hello",
    });
    expect(computeScenarioHash(a)).toBe(computeScenarioHash(b));
  });

  it("changes when setup content changes", () => {
    const a = tmpScenario({
      "setup.yaml": "name: smoke\nversion: '1.0'\nvms: []\n",
    });
    const b = tmpScenario({
      "setup.yaml": "name: not-smoke\nversion: '1.0'\nvms: []\n",
    });
    expect(computeScenarioHash(a)).not.toBe(computeScenarioHash(b));
  });

  it("throws when setup.yaml is missing", () => {
    const dir = tmpScenario({});
    expect(() => computeScenarioHash(dir)).toThrow(/Missing setup\.yaml/);
  });
});

describe("EventQueue", () => {
  it("preserves insertion order via seq", () => {
    const q = new EventQueue();
    q.push({ type: "run.started", scenario_id: "s" });
    q.push({ type: "step.started", step_index: 0, kind: "x" });
    q.push({ type: "run.finished", result: "pass" });
    const all = q.all();
    expect(all.map((e) => e.seq)).toEqual([0, 1, 2]);
    expect(all.map((e) => e.type)).toEqual(["run.started", "step.started", "run.finished"]);
  });

  it("drain(since) returns events past the cursor only", () => {
    const q = new EventQueue();
    for (let i = 0; i < 5; i++) q.push({ type: "log", message: String(i) });
    const got = q.drain(2);
    expect(got.events.map((e) => e.seq)).toEqual([2, 3, 4]);
    expect(got.nextSeq).toBe(5);
  });

  it("drain respects limit", () => {
    const q = new EventQueue();
    for (let i = 0; i < 100; i++) q.push({ type: "log", message: String(i) });
    const got = q.drain(0, 10);
    expect(got.events).toHaveLength(10);
    expect(got.nextSeq).toBe(10);
  });

  it("waitForNext resolves when an event arrives", async () => {
    const q = new EventQueue();
    const waiter = q.waitForNext(0, 5_000);
    setTimeout(() => q.push({ type: "log", message: "hi" }), 10);
    await waiter;
    expect(q.all()).toHaveLength(1);
  });

  it("waitForNext returns immediately when terminal", async () => {
    const q = new EventQueue();
    q.finish();
    const t0 = Date.now();
    await q.waitForNext(0, 5_000);
    expect(Date.now() - t0).toBeLessThan(50);
  });

  it("isTerminal flips after finish()", () => {
    const q = new EventQueue();
    expect(q.isTerminal()).toBe(false);
    q.finish();
    expect(q.isTerminal()).toBe(true);
  });
});

describe("exitCodeFor", () => {
  it("maps result -> exit code per design doc §5", () => {
    expect(exitCodeFor({ result: "pass" })).toBe(0);
    expect(exitCodeFor({ result: "fail", breakdown: "assertion" })).toBe(1);
    expect(exitCodeFor({ result: "fail", breakdown: "workflow" })).toBe(2);
    expect(exitCodeFor({ result: "error", breakdown: "setup" })).toBe(3);
    expect(exitCodeFor({ result: "error", breakdown: "infra" })).toBe(4);
    expect(exitCodeFor({ result: "error", breakdown: "validation" })).toBe(5);
  });
});

describe("agentVersion", () => {
  it("returns 'signalman/<version>' shape", () => {
    expect(agentVersion()).toMatch(/^signalman\/[^\s]+/);
  });
});
