/**
 * v0.3.0-3 — envelope hash helper tests.
 *
 * Pure module. No I/O. Golden hashes pin the v0.3.0-3 wire shape so
 * a future refactor that accidentally changes canonicalisation
 * surfaces as a test failure rather than silently invalidating every
 * cached scenario result downstream.
 */

import { describe, it, expect } from "vitest";
import * as crypto from "node:crypto";

import {
  aggregateAgentVersions,
  aggregateVmLineageHashes,
  canonicalJson,
  classifyNetwork,
  computeScenarioHash,
  EnvelopeHashError,
  normalizeWorkflow,
  sanitizeSwitchName,
} from "../scenarios/envelope-hash.js";

function sha256Hex(input: string): string {
  return crypto.createHash("sha256").update(input, "utf8").digest("hex");
}

// ── canonicalJson ─────────────────────────────────────────────────

describe("canonicalJson", () => {
  it("returns sorted keys at every level", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalJson({ x: { z: 1, y: 2 } })).toBe('{"x":{"y":2,"z":1}}');
  });

  it("preserves array order (semantic in scenario YAML)", () => {
    expect(canonicalJson([3, 1, 2])).toBe("[3,1,2]");
  });

  it("renders null, booleans, and numbers as JSON literals", () => {
    expect(canonicalJson(null)).toBe("null");
    expect(canonicalJson(true)).toBe("true");
    expect(canonicalJson(false)).toBe("false");
    expect(canonicalJson(0)).toBe("0");
    expect(canonicalJson(-1.5)).toBe("-1.5");
  });

  it("omits undefined object fields entirely (not as null)", () => {
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
  });

  it("renders strings with JSON escaping", () => {
    expect(canonicalJson('he said "hi"')).toBe('"he said \\"hi\\""');
    expect(canonicalJson("line\nbreak")).toBe('"line\\nbreak"');
  });

  it("renders nested arrays + objects together", () => {
    expect(canonicalJson({ a: [{ y: 1, x: 2 }, "s"] })).toBe(
      '{"a":[{"x":2,"y":1},"s"]}',
    );
  });

  it("converts undefined array elements to null (json semantics)", () => {
    expect(canonicalJson([1, undefined, 3])).toBe("[1,null,3]");
  });

  it("throws EnvelopeHashError on non-finite numbers", () => {
    expect(() => canonicalJson(Number.NaN)).toThrowError(
      expect.objectContaining({
        name: "EnvelopeHashError",
        code: "unhashable_value",
      }),
    );
    expect(() => canonicalJson(Infinity)).toThrowError(
      expect.objectContaining({
        name: "EnvelopeHashError",
        code: "unhashable_value",
      }),
    );
  });

  it("throws EnvelopeHashError on unsupported types (function, symbol)", () => {
    expect(() => canonicalJson(() => 1)).toThrowError(
      expect.objectContaining({ code: "unhashable_value" }),
    );
    expect(() => canonicalJson(Symbol("x"))).toThrowError(
      expect.objectContaining({ code: "unhashable_value" }),
    );
  });
});

// ── normalizeWorkflow ─────────────────────────────────────────────

describe("normalizeWorkflow", () => {
  it("strips a leading UTF-8 BOM", () => {
    expect(normalizeWorkflow("﻿hello")).toBe("hello");
  });

  it("converts CRLF to LF", () => {
    expect(normalizeWorkflow("a\r\nb\r\nc")).toBe("a\nb\nc");
  });

  it("leaves LF content untouched", () => {
    expect(normalizeWorkflow("a\nb\nc")).toBe("a\nb\nc");
  });

  it("returns empty string for empty input", () => {
    expect(normalizeWorkflow("")).toBe("");
  });

  it("throws non_string_workflow when input is not a string", () => {
    expect(() =>
      normalizeWorkflow(42 as unknown as string),
    ).toThrowError(
      expect.objectContaining({
        name: "EnvelopeHashError",
        code: "non_string_workflow",
      }),
    );
  });
});

// ── computeScenarioHash ───────────────────────────────────────────

describe("computeScenarioHash — contract", () => {
  it("returns 64-char lowercase hex", () => {
    const h = computeScenarioHash({
      setup: { name: "smoke" },
      assertions: { assertions: [] },
      workflow: "",
    });
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when setup changes", () => {
    const h1 = computeScenarioHash({
      setup: { name: "smoke" },
      assertions: {},
      workflow: "",
    });
    const h2 = computeScenarioHash({
      setup: { name: "smoke", version: "1.0" },
      assertions: {},
      workflow: "",
    });
    expect(h1).not.toBe(h2);
  });

  it("changes when assertions change", () => {
    const h1 = computeScenarioHash({
      setup: { name: "smoke" },
      assertions: { assertions: [] },
      workflow: "",
    });
    const h2 = computeScenarioHash({
      setup: { name: "smoke" },
      assertions: { assertions: [{ id: "a1" }] },
      workflow: "",
    });
    expect(h1).not.toBe(h2);
  });

  it("changes when workflow changes", () => {
    const h1 = computeScenarioHash({
      setup: { name: "smoke" },
      assertions: {},
      workflow: "# Workflow\n\nStep 1.",
    });
    const h2 = computeScenarioHash({
      setup: { name: "smoke" },
      assertions: {},
      workflow: "# Workflow\n\nStep 2.",
    });
    expect(h1).not.toBe(h2);
  });

  it("identical setups in different key orders produce identical hashes", () => {
    const h1 = computeScenarioHash({
      setup: { a: 1, b: 2 },
      assertions: {},
      workflow: "",
    });
    const h2 = computeScenarioHash({
      setup: { b: 2, a: 1 },
      assertions: {},
      workflow: "",
    });
    expect(h1).toBe(h2);
  });

  it("CRLF vs LF workflows produce identical hashes", () => {
    const h1 = computeScenarioHash({
      setup: { name: "smoke" },
      assertions: {},
      workflow: "line1\nline2\n",
    });
    const h2 = computeScenarioHash({
      setup: { name: "smoke" },
      assertions: {},
      workflow: "line1\r\nline2\r\n",
    });
    expect(h1).toBe(h2);
  });

  it("BOM-prefixed workflow content produces the same hash as bare", () => {
    const h1 = computeScenarioHash({
      setup: { name: "smoke" },
      assertions: {},
      workflow: "hello",
    });
    const h2 = computeScenarioHash({
      setup: { name: "smoke" },
      assertions: {},
      workflow: "﻿hello",
    });
    expect(h1).toBe(h2);
  });

  it("empty assertions and assertions-with-empty-array are distinguishable", () => {
    // Operator intent: "no assertions file" vs "explicit empty list"
    // are different. Our combiner runs each through canonicalJson so
    // {} and { assertions: [] } produce different hashes; this is
    // a feature, not a bug.
    const h1 = computeScenarioHash({
      setup: { name: "smoke" },
      assertions: {},
      workflow: "",
    });
    const h2 = computeScenarioHash({
      setup: { name: "smoke" },
      assertions: { assertions: [] },
      workflow: "",
    });
    expect(h1).not.toBe(h2);
  });
});

// ── Golden hashes (stability promise) ─────────────────────────────

describe("computeScenarioHash — golden hashes", () => {
  // Once v0.3.0-3 ships, the canonical-JSON shape and the resulting
  // hash for any given input are frozen. A canonicalisation change
  // that re-keys downstream caches will fail one of these.

  it("hash of minimal setup is stable", () => {
    // Manually compute the expected hash so we don't drift.
    const setupCanon = '{"name":"smoke"}';
    const assertionsCanon = "{}";
    const workflowNorm = "";
    const setupSha = sha256Hex(setupCanon);
    const assertionsSha = sha256Hex(assertionsCanon);
    const workflowSha = sha256Hex(workflowNorm);
    const combined =
      `{"assertions":"${assertionsSha}","setup":"${setupSha}","workflow":"${workflowSha}"}`;
    const expected = sha256Hex(combined);

    expect(
      computeScenarioHash({
        setup: { name: "smoke" },
        assertions: {},
        workflow: "",
      }),
    ).toBe(expected);
  });
});

// ── classifyNetwork ───────────────────────────────────────────────

describe("classifyNetwork", () => {
  it("returns 'pre-started' for operator-managed VMs", () => {
    expect(classifyNetwork({ pre_started: true })).toBe("pre-started");
  });

  it("returns 'pre-started' even when network is also declared (operator owns it)", () => {
    expect(
      classifyNetwork({
        pre_started: true,
        network: { switch: "MySwitch" },
      }),
    ).toBe("pre-started");
  });

  it("returns 'default' when no network block is declared", () => {
    expect(classifyNetwork({})).toBe("default");
    expect(classifyNetwork({ network: undefined })).toBe("default");
  });

  it("returns the sanitised switch name when declared", () => {
    expect(
      classifyNetwork({ network: { switch: "Default Switch" } }),
    ).toBe("default-switch");
    expect(
      classifyNetwork({ network: { switch: "Isolated Lab Switch" } }),
    ).toBe("isolated-lab-switch");
  });

  it("returns 'default' when switch is the empty string", () => {
    expect(classifyNetwork({ network: { switch: "" } })).toBe("default");
  });

  it("returns 'default' when switch sanitises to empty", () => {
    expect(classifyNetwork({ network: { switch: "---" } })).toBe("default");
  });

  it("ephemeral flag alone doesn't change the class (still uses switch / default)", () => {
    expect(
      classifyNetwork({ ephemeral: true, network: { switch: "MySwitch" } }),
    ).toBe("myswitch");
    expect(classifyNetwork({ ephemeral: true })).toBe("default");
  });
});

describe("sanitizeSwitchName", () => {
  it("lowercases and replaces spaces with hyphens", () => {
    expect(sanitizeSwitchName("Default Switch")).toBe("default-switch");
  });

  it("preserves digits, hyphens, and underscores", () => {
    expect(sanitizeSwitchName("Lab-Switch_42")).toBe("lab-switch_42");
  });

  it("collapses runs of unsafe characters into one hyphen", () => {
    expect(sanitizeSwitchName("a   b///c")).toBe("a-b-c");
  });

  it("trims leading and trailing hyphens", () => {
    expect(sanitizeSwitchName("---abc---")).toBe("abc");
  });
});

// ── aggregateVmLineageHashes ──────────────────────────────────────

describe("aggregateVmLineageHashes", () => {
  it("returns empty string for empty input", () => {
    expect(aggregateVmLineageHashes([])).toBe("");
  });

  it("returns the single hash verbatim for one-element input", () => {
    const h = "a".repeat(64);
    expect(aggregateVmLineageHashes([h])).toBe(h);
  });

  it("returns SHA-256 of sorted-canonical-JSON for multi-element input", () => {
    const a = "a".repeat(64);
    const b = "b".repeat(64);
    const expected = sha256Hex(canonicalJson([a, b]));
    expect(aggregateVmLineageHashes([a, b])).toBe(expected);
  });

  it("is order-independent (sorted before hashing)", () => {
    const a = "a".repeat(64);
    const b = "b".repeat(64);
    const c = "c".repeat(64);
    expect(aggregateVmLineageHashes([c, a, b])).toBe(
      aggregateVmLineageHashes([a, b, c]),
    );
  });

  it("does not mutate the caller's array", () => {
    const arr = ["z", "a", "m"];
    const snap = arr.slice();
    aggregateVmLineageHashes(arr);
    expect(arr).toEqual(snap);
  });
});

// ── aggregateAgentVersions ────────────────────────────────────────

describe("aggregateAgentVersions", () => {
  it("returns undefined for empty input", () => {
    expect(aggregateAgentVersions([])).toBeUndefined();
  });

  it("returns undefined when all entries are undefined", () => {
    expect(aggregateAgentVersions([undefined, undefined])).toBeUndefined();
  });

  it("returns undefined when all entries are empty strings", () => {
    expect(aggregateAgentVersions(["", ""])).toBeUndefined();
  });

  it("returns the single version verbatim", () => {
    expect(aggregateAgentVersions(["0.2.1"])).toBe("0.2.1");
  });

  it("returns the single unique version when duplicates are present", () => {
    expect(aggregateAgentVersions(["0.2.1", "0.2.1", "0.2.1"])).toBe("0.2.1");
  });

  it("returns sorted comma-joined unique versions for multi-version input", () => {
    expect(aggregateAgentVersions(["0.2.1", "0.1.5", "0.2.1"])).toBe(
      "0.1.5,0.2.1",
    );
  });

  it("ignores undefined entries before aggregating", () => {
    expect(
      aggregateAgentVersions([undefined, "0.2.1", undefined, "0.1.5"]),
    ).toBe("0.1.5,0.2.1");
  });
});

// ── Error type ergonomics ─────────────────────────────────────────

describe("EnvelopeHashError", () => {
  it("is an Error subclass with stable code", () => {
    const e = new EnvelopeHashError("unhashable_value", "test");
    expect(e).toBeInstanceOf(Error);
    expect(e).toBeInstanceOf(EnvelopeHashError);
    expect(e.code).toBe("unhashable_value");
    expect(e.name).toBe("EnvelopeHashError");
  });
});
