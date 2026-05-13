import { describe, it, expect, vi } from "vitest";
import {
  AssertionEvaluator,
  resolveJsonPath,
  compareValues,
  type Assertion,
  type CommandResult,
  type EvaluationContext,
} from "../scenarios/assertions.js";

// ---------------------------------------------------------------------------
// Helper to create a minimal evaluation context
// ---------------------------------------------------------------------------

function makeCtx(overrides: Partial<EvaluationContext> = {}): EvaluationContext {
  return {
    commandResults: new Map(),
    screenshots: new Map(),
    scenarioDir: "/tmp/test-scenario",
    ...overrides,
  };
}

function makeCmd(
  stdout: string,
  exitCode: number = 0,
  stderr: string = "",
): CommandResult {
  return { exitCode, stdout, stderr, durationMs: 10 };
}

// ===========================================================================
// resolveJsonPath
// ===========================================================================

describe("resolveJsonPath", () => {
  it("resolves a top-level key", () => {
    expect(resolveJsonPath({ name: "test" }, "name")).toBe("test");
  });

  it("resolves nested dot notation", () => {
    const obj = { summary: { pass: 6, fail: 1 } };
    expect(resolveJsonPath(obj, "summary.pass")).toBe(6);
  });

  it("resolves array index", () => {
    const obj = { results: [{ id: "a" }, { id: "b" }] };
    expect(resolveJsonPath(obj, "results[0].id")).toBe("a");
    expect(resolveJsonPath(obj, "results[1].id")).toBe("b");
  });

  it("resolves simple filter", () => {
    const obj = {
      results: [
        { test_id: "P1-assign-suspended", result: "pass" },
        { test_id: "P2-terminate-process", result: "fail" },
      ],
    };
    expect(
      resolveJsonPath(obj, "results[?test_id=='P1-assign-suspended'].result"),
    ).toBe("pass");
  });

  it("returns undefined for missing key", () => {
    expect(resolveJsonPath({ a: 1 }, "b")).toBeUndefined();
  });

  it("returns undefined for missing nested key", () => {
    expect(resolveJsonPath({ a: { b: 1 } }, "a.c")).toBeUndefined();
  });

  it("returns undefined for out-of-bounds array index", () => {
    expect(resolveJsonPath({ arr: [1] }, "arr[5]")).toBeUndefined();
  });

  it("returns undefined for null input", () => {
    expect(resolveJsonPath(null, "key")).toBeUndefined();
  });

  it("returns the object itself for empty path", () => {
    const obj = { x: 1 };
    expect(resolveJsonPath(obj, "")).toEqual(obj);
  });

  it("handles deeply nested paths", () => {
    const obj = { a: { b: { c: { d: 42 } } } };
    expect(resolveJsonPath(obj, "a.b.c.d")).toBe(42);
  });

  it("handles filter with no match", () => {
    const obj = { items: [{ id: "a" }] };
    expect(resolveJsonPath(obj, "items[?id=='z']")).toBeUndefined();
  });

  it("handles boolean values", () => {
    const obj = { summary: { api_available: true } };
    expect(resolveJsonPath(obj, "summary.api_available")).toBe(true);
  });
});

// ===========================================================================
// compareValues
// ===========================================================================

describe("compareValues", () => {
  it("eq: equal numbers", () => {
    expect(compareValues(6, 6, "eq")).toBe(true);
  });

  it("eq: unequal numbers", () => {
    expect(compareValues(5, 6, "eq")).toBe(false);
  });

  it("eq: booleans", () => {
    expect(compareValues(true, true, "eq")).toBe(true);
    expect(compareValues(true, false, "eq")).toBe(false);
  });

  it("not_eq: different values", () => {
    expect(compareValues("blocked", "allow", "not_eq")).toBe(true);
  });

  it("not_eq: same values", () => {
    expect(compareValues("allow", "allow", "not_eq")).toBe(false);
  });

  it("gte: greater or equal", () => {
    expect(compareValues(6, 6, "gte")).toBe(true);
    expect(compareValues(7, 6, "gte")).toBe(true);
    expect(compareValues(5, 6, "gte")).toBe(false);
  });

  it("lte: less or equal", () => {
    expect(compareValues(5, 6, "lte")).toBe(true);
    expect(compareValues(6, 6, "lte")).toBe(true);
    expect(compareValues(7, 6, "lte")).toBe(false);
  });

  it("gt: strictly greater", () => {
    expect(compareValues(7, 6, "gt")).toBe(true);
    expect(compareValues(6, 6, "gt")).toBe(false);
  });

  it("lt: strictly less", () => {
    expect(compareValues(5, 6, "lt")).toBe(true);
    expect(compareValues(6, 6, "lt")).toBe(false);
  });

  it("contains: substring", () => {
    expect(compareValues("hello world", "world", "contains")).toBe(true);
    expect(compareValues("hello", "world", "contains")).toBe(false);
  });

  it("includes: array membership with exact value semantics", () => {
    expect(compareValues(["click", "key"], "click", "includes")).toBe(true);
    expect(compareValues(["type"], "click", "includes")).toBe(false);
    expect(compareValues([{ id: "a" }], { id: "a" }, "includes")).toBe(true);
  });

  it("defaults to eq for unknown comparison", () => {
    expect(compareValues(1, 1, "unknown_op")).toBe(true);
  });
});

// ===========================================================================
// json_field assertion type
// ===========================================================================

describe("json_field assertions", () => {
  it("evaluates a basic field match", async () => {
    const ctx = makeCtx({
      commandResults: new Map([
        ["step-1", makeCmd('{"summary":{"pass":6,"fail":1}}')],
      ]),
    });
    const evaluator = new AssertionEvaluator(ctx);
    const result = await evaluator.evaluate({
      id: "test-1",
      type: "json_field",
      source: "step-1",
      field: "summary.pass",
      expected: 6,
    });
    expect(result.passed).toBe(true);
    expect(result.actual).toBe(6);
  });

  it("evaluates nested boolean field", async () => {
    const ctx = makeCtx({
      commandResults: new Map([
        ["step-1", makeCmd('{"summary":{"api_available":true}}')],
      ]),
    });
    const evaluator = new AssertionEvaluator(ctx);
    const result = await evaluator.evaluate({
      id: "test-2",
      type: "json_field",
      source: "step-1",
      field: "summary.api_available",
      expected: true,
    });
    expect(result.passed).toBe(true);
  });

  it("evaluates with gte comparison", async () => {
    const ctx = makeCtx({
      commandResults: new Map([
        ["s1", makeCmd('{"summary":{"pass":8}}')],
      ]),
    });
    const evaluator = new AssertionEvaluator(ctx);
    const result = await evaluator.evaluate({
      id: "gte-test",
      type: "json_field",
      source: "s1",
      field: "summary.pass",
      expected: 6,
      comparison: "gte",
    });
    expect(result.passed).toBe(true);
  });

  it("fails when field is missing", async () => {
    const ctx = makeCtx({
      commandResults: new Map([
        ["s1", makeCmd('{"a":1}')],
      ]),
    });
    const evaluator = new AssertionEvaluator(ctx);
    const result = await evaluator.evaluate({
      id: "missing",
      type: "json_field",
      source: "s1",
      field: "b.c",
      expected: 1,
    });
    expect(result.passed).toBe(false);
    expect(result.message).toContain("not found");
  });

  it("fails when source is missing", async () => {
    const evaluator = new AssertionEvaluator(makeCtx());
    const result = await evaluator.evaluate({
      id: "no-source",
      type: "json_field",
      source: "nonexistent",
      field: "x",
      expected: 1,
    });
    expect(result.passed).toBe(false);
    expect(result.message).toContain("not found");
  });

  it("fails on invalid JSON", async () => {
    const ctx = makeCtx({
      commandResults: new Map([
        ["s1", makeCmd("not json")],
      ]),
    });
    const evaluator = new AssertionEvaluator(ctx);
    const result = await evaluator.evaluate({
      id: "bad-json",
      type: "json_field",
      source: "s1",
      field: "x",
      expected: 1,
    });
    expect(result.passed).toBe(false);
    expect(result.message).toContain("parse JSON");
  });

  it("evaluates array index path", async () => {
    const ctx = makeCtx({
      commandResults: new Map([
        ["s1", makeCmd('{"results":[{"test_id":"P1"},{"test_id":"P2"}]}')],
      ]),
    });
    const evaluator = new AssertionEvaluator(ctx);
    const result = await evaluator.evaluate({
      id: "arr",
      type: "json_field",
      source: "s1",
      field: "results[1].test_id",
      expected: "P2",
    });
    expect(result.passed).toBe(true);
  });

  it("evaluates array membership for UI action hints", async () => {
    const ctx = makeCtx({
      commandResults: new Map([
        [
          "ui-snapshot",
          makeCmd(
            JSON.stringify({
              elements: [
                { automation_id: "2", actions: ["click"] },
                { automation_id: "1001", actions: ["type", "key"] },
              ],
            }),
          ),
        ],
      ]),
    });
    const evaluator = new AssertionEvaluator(ctx);
    const result = await evaluator.evaluate({
      id: "ui-action-clickable",
      type: "json_field",
      source: "ui-snapshot",
      field: "elements[?automation_id=='2'].actions",
      comparison: "includes",
      expected: "click",
    });

    expect(result.passed).toBe(true);
    expect(result.actual).toEqual(["click"]);
  });

  it("evaluates filter path", async () => {
    const ctx = makeCtx({
      commandResults: new Map([
        [
          "s1",
          makeCmd(
            '{"results":[{"test_id":"P1","result":"pass"},{"test_id":"P2","result":"fail"}]}',
          ),
        ],
      ]),
    });
    const evaluator = new AssertionEvaluator(ctx);
    const result = await evaluator.evaluate({
      id: "filter",
      type: "json_field",
      source: "s1",
      field: "results[?test_id=='P1'].result",
      expected: "pass",
    });
    expect(result.passed).toBe(true);
  });

  it("evaluates not_eq comparison", async () => {
    const ctx = makeCtx({
      commandResults: new Map([
        ["s1", makeCmd('{"summary":{"error":0}}')],
      ]),
    });
    const evaluator = new AssertionEvaluator(ctx);
    const result = await evaluator.evaluate({
      id: "not-eq",
      type: "json_field",
      source: "s1",
      field: "summary.error",
      expected: 5,
      comparison: "not_eq",
    });
    expect(result.passed).toBe(true);
  });

  it("errors when 'source' property missing", async () => {
    const evaluator = new AssertionEvaluator(makeCtx());
    const result = await evaluator.evaluate({
      id: "no-src",
      type: "json_field",
      field: "x",
      expected: 1,
    });
    expect(result.passed).toBe(false);
    expect(result.message).toContain("missing 'source'");
  });

  it("errors when 'field' property missing", async () => {
    const evaluator = new AssertionEvaluator(makeCtx());
    const result = await evaluator.evaluate({
      id: "no-field",
      type: "json_field",
      source: "s1",
      expected: 1,
    });
    expect(result.passed).toBe(false);
    expect(result.message).toContain("missing 'field'");
  });
});

// ===========================================================================
// file_exists assertion type
// ===========================================================================

describe("file_exists assertions", () => {
  it("passes when guest callback returns true and expected true", async () => {
    const ctx = makeCtx({
      guestFileExists: vi.fn().mockResolvedValue(true),
    });
    const evaluator = new AssertionEvaluator(ctx);
    const result = await evaluator.evaluate({
      id: "fe-1",
      type: "file_exists",
      path: "C:\\test\\file.txt",
      expected: true,
    });
    expect(result.passed).toBe(true);
  });

  it("fails when guest callback returns false and expected true", async () => {
    const ctx = makeCtx({
      guestFileExists: vi.fn().mockResolvedValue(false),
    });
    const evaluator = new AssertionEvaluator(ctx);
    const result = await evaluator.evaluate({
      id: "fe-2",
      type: "file_exists",
      path: "C:\\missing.txt",
      expected: true,
    });
    expect(result.passed).toBe(false);
  });

  it("errors when path is missing", async () => {
    const evaluator = new AssertionEvaluator(makeCtx());
    const result = await evaluator.evaluate({
      id: "fe-3",
      type: "file_exists",
      expected: true,
    });
    expect(result.passed).toBe(false);
    expect(result.message).toContain("missing 'path'");
  });
});

// ===========================================================================
// exit_code assertion type
// ===========================================================================

describe("exit_code assertions", () => {
  it("passes when exit code matches expected", async () => {
    const ctx = makeCtx({
      commandResults: new Map([["s1", makeCmd("ok", 0)]]),
    });
    const evaluator = new AssertionEvaluator(ctx);
    const result = await evaluator.evaluate({
      id: "ec-1",
      type: "exit_code",
      source: "s1",
      expected: 0,
    });
    expect(result.passed).toBe(true);
  });

  it("fails when exit code does not match", async () => {
    const ctx = makeCtx({
      commandResults: new Map([["s1", makeCmd("error", 1)]]),
    });
    const evaluator = new AssertionEvaluator(ctx);
    const result = await evaluator.evaluate({
      id: "ec-2",
      type: "exit_code",
      source: "s1",
      expected: 0,
    });
    expect(result.passed).toBe(false);
    expect(result.actual).toBe(1);
  });

  it("uses last command result when no source specified", async () => {
    const ctx = makeCtx({
      commandResults: new Map([
        ["s1", makeCmd("first", 0)],
        ["s2", makeCmd("last", 42)],
      ]),
    });
    const evaluator = new AssertionEvaluator(ctx);
    const result = await evaluator.evaluate({
      id: "ec-3",
      type: "exit_code",
      expected: 42,
    });
    expect(result.passed).toBe(true);
  });

  it("errors when expected is missing", async () => {
    const evaluator = new AssertionEvaluator(makeCtx());
    const result = await evaluator.evaluate({
      id: "ec-4",
      type: "exit_code",
    });
    expect(result.passed).toBe(false);
    expect(result.message).toContain("missing 'expected'");
  });
});

// ===========================================================================
// stdout_matches assertion type
// ===========================================================================

describe("stdout_matches assertions", () => {
  it("passes when pattern matches stdout", async () => {
    const ctx = makeCtx({
      commandResults: new Map([["s1", makeCmd("Status: Running")]]),
    });
    const evaluator = new AssertionEvaluator(ctx);
    const result = await evaluator.evaluate({
      id: "sm-1",
      type: "stdout_matches",
      source: "s1",
      pattern: "Running|Restricted",
      expected: true,
    });
    expect(result.passed).toBe(true);
  });

  it("fails when pattern does not match", async () => {
    const ctx = makeCtx({
      commandResults: new Map([["s1", makeCmd("Status: Stopped")]]),
    });
    const evaluator = new AssertionEvaluator(ctx);
    const result = await evaluator.evaluate({
      id: "sm-2",
      type: "stdout_matches",
      source: "s1",
      pattern: "Running|Restricted",
      expected: true,
    });
    expect(result.passed).toBe(false);
  });

  it("passes when expected=false and pattern does not match", async () => {
    const ctx = makeCtx({
      commandResults: new Map([["s1", makeCmd("Status: Stopped")]]),
    });
    const evaluator = new AssertionEvaluator(ctx);
    const result = await evaluator.evaluate({
      id: "sm-3",
      type: "stdout_matches",
      source: "s1",
      pattern: "Running",
      expected: false,
    });
    expect(result.passed).toBe(true);
  });

  it("errors when pattern is missing", async () => {
    const evaluator = new AssertionEvaluator(makeCtx());
    const result = await evaluator.evaluate({
      id: "sm-4",
      type: "stdout_matches",
      source: "s1",
      expected: true,
    });
    expect(result.passed).toBe(false);
    expect(result.message).toContain("missing 'pattern'");
  });
});

// ===========================================================================
// stdout_contains assertion type
// ===========================================================================

describe("stdout_contains assertions", () => {
  it("passes when stdout contains expected string", async () => {
    const ctx = makeCtx({
      commandResults: new Map([
        ["s1", makeCmd("P1-compose-smoke passed")],
      ]),
    });
    const evaluator = new AssertionEvaluator(ctx);
    const result = await evaluator.evaluate({
      id: "sc-1",
      type: "stdout_contains",
      source: "s1",
      expected: "P1-compose-smoke",
    });
    expect(result.passed).toBe(true);
  });

  it("fails when stdout does not contain expected", async () => {
    const ctx = makeCtx({
      commandResults: new Map([["s1", makeCmd("some other output")]]),
    });
    const evaluator = new AssertionEvaluator(ctx);
    const result = await evaluator.evaluate({
      id: "sc-2",
      type: "stdout_contains",
      source: "s1",
      expected: "missing-string",
    });
    expect(result.passed).toBe(false);
  });
});

// ===========================================================================
// network_reachable assertion type
// ===========================================================================

describe("network_reachable assertions", () => {
  it("passes when network reachability matches expected", async () => {
    const ctx = makeCtx({
      guestNetworkReachable: vi.fn().mockResolvedValue(false),
    });
    const evaluator = new AssertionEvaluator(ctx);
    const result = await evaluator.evaluate({
      id: "nr-1",
      type: "network_reachable",
      host: "api.openai.com",
      port: 443,
      expected: false,
    });
    expect(result.passed).toBe(true);
    expect(ctx.guestNetworkReachable).toHaveBeenCalledWith(
      "api.openai.com",
      443,
    );
  });

  it("fails when callback is not provided", async () => {
    const evaluator = new AssertionEvaluator(makeCtx());
    const result = await evaluator.evaluate({
      id: "nr-2",
      type: "network_reachable",
      host: "api.openai.com",
      port: 443,
      expected: false,
    });
    expect(result.passed).toBe(false);
    expect(result.message).toContain("requires guestNetworkReachable");
  });

  it("errors when host is missing", async () => {
    const evaluator = new AssertionEvaluator(makeCtx());
    const result = await evaluator.evaluate({
      id: "nr-3",
      type: "network_reachable",
      port: 443,
      expected: false,
    });
    expect(result.passed).toBe(false);
    expect(result.message).toContain("missing 'host'");
  });
});

// ===========================================================================
// process_running assertion type
// ===========================================================================

describe("process_running assertions", () => {
  it("passes when process running matches expected", async () => {
    const ctx = makeCtx({
      guestProcessRunning: vi.fn().mockResolvedValue(true),
    });
    const evaluator = new AssertionEvaluator(ctx);
    const result = await evaluator.evaluate({
      id: "pr-1",
      type: "process_running",
      name: "Cursor.exe",
      expected: true,
    });
    expect(result.passed).toBe(true);
    expect(ctx.guestProcessRunning).toHaveBeenCalledWith("Cursor.exe");
  });

  it("fails when callback is not provided", async () => {
    const evaluator = new AssertionEvaluator(makeCtx());
    const result = await evaluator.evaluate({
      id: "pr-2",
      type: "process_running",
      name: "test.exe",
      expected: true,
    });
    expect(result.passed).toBe(false);
    expect(result.message).toContain("requires guestProcessRunning");
  });
});

// ===========================================================================
// Unknown assertion type
// ===========================================================================

describe("unknown assertion type", () => {
  it("returns error for unknown type", async () => {
    const evaluator = new AssertionEvaluator(makeCtx());
    const result = await evaluator.evaluate({
      id: "unk-1",
      type: "nonexistent_type",
    });
    expect(result.passed).toBe(false);
    expect(result.message).toContain("Unknown assertion type");
  });
});

// ===========================================================================
// evaluateAll
// ===========================================================================

describe("evaluateAll", () => {
  it("evaluates multiple assertions and returns all results", async () => {
    const ctx = makeCtx({
      commandResults: new Map([
        ["s1", makeCmd('{"pass":true}', 0)],
        ["s2", makeCmd("hello world", 0)],
      ]),
    });
    const evaluator = new AssertionEvaluator(ctx);
    const results = await evaluator.evaluateAll([
      {
        id: "a1",
        type: "json_field",
        source: "s1",
        field: "pass",
        expected: true,
      },
      {
        id: "a2",
        type: "stdout_contains",
        source: "s2",
        expected: "hello",
      },
      {
        id: "a3",
        type: "exit_code",
        source: "s1",
        expected: 0,
      },
    ]);
    expect(results).toHaveLength(3);
    expect(results[0].passed).toBe(true);
    expect(results[1].passed).toBe(true);
    expect(results[2].passed).toBe(true);
  });

  it("includes duration_ms in results", async () => {
    const evaluator = new AssertionEvaluator(makeCtx());
    const results = await evaluator.evaluateAll([
      { id: "d1", type: "exit_code", expected: 0 },
    ]);
    expect(results[0].duration_ms).toBeGreaterThanOrEqual(0);
  });

  it("includes severity in results", async () => {
    const evaluator = new AssertionEvaluator(makeCtx());
    const results = await evaluator.evaluateAll([
      { id: "s1", type: "exit_code", expected: 0, severity: "critical" },
      { id: "s2", type: "exit_code", expected: 0 },
    ]);
    expect(results[0].severity).toBe("critical");
    expect(results[1].severity).toBe("medium"); // default
  });
});
