/**
 * Tests for cross-process trace correlation primitives (P3.d — closes
 * audit C10-residual). Covers trace-id generation/validation, the
 * AsyncLocalStorage propagation contract, and gRPC metadata shape.
 *
 * Header injection on the actual gRPC wire is exercised by the
 * orchestrator-events integration tests via the shared `currentTrace()`
 * pickup; this file pins the primitives directly.
 */

import { describe, it, expect } from "vitest";

import {
  TRACE_HEADER_NAMES,
  TRACE_ID_LENGTH,
  currentTrace,
  isValidTraceId,
  newTraceId,
  parseTraceId,
  runWithTrace,
  traceMetadata,
  type TraceContext,
} from "../output/trace.js";

describe("newTraceId()", () => {
  it("returns a 32-char lowercase hex string", () => {
    const id = newTraceId();
    expect(id).toHaveLength(TRACE_ID_LENGTH);
    expect(id).toMatch(/^[0-9a-f]{32}$/);
  });

  it("returns distinct values across calls", () => {
    const ids = new Set(Array.from({ length: 64 }, newTraceId));
    expect(ids.size).toBe(64);
  });
});

describe("isValidTraceId()", () => {
  it("accepts a freshly generated id", () => {
    expect(isValidTraceId(newTraceId())).toBe(true);
  });

  it("rejects shape mismatches", () => {
    expect(isValidTraceId("")).toBe(false);
    expect(isValidTraceId("ABC")).toBe(false);
    expect(isValidTraceId("a".repeat(31))).toBe(false);
    expect(isValidTraceId("a".repeat(33))).toBe(false);
    // Uppercase is rejected — we canonicalise to lowercase to keep
    // wire and log-grep behaviour consistent.
    expect(isValidTraceId("A".repeat(32))).toBe(false);
    // Dashed UUID form must go through parseTraceId first.
    expect(isValidTraceId("550e8400-e29b-41d4-a716-446655440000")).toBe(false);
  });

  it("rejects non-string inputs", () => {
    expect(isValidTraceId(undefined)).toBe(false);
    expect(isValidTraceId(null)).toBe(false);
    expect(isValidTraceId(42)).toBe(false);
    expect(isValidTraceId({})).toBe(false);
  });
});

describe("parseTraceId()", () => {
  it("strips dashes and lowercases dashed UUID input", () => {
    const out = parseTraceId("550E8400-E29B-41D4-A716-446655440000");
    expect(out).toBe("550e8400e29b41d4a716446655440000");
    expect(out).toHaveLength(32);
  });

  it("passes through canonical lowercase hex unchanged", () => {
    const id = newTraceId();
    expect(parseTraceId(id)).toBe(id);
  });

  it("throws with the field label on malformed input", () => {
    expect(() => parseTraceId("not-a-trace-id", "trace_id")).toThrow(/trace_id/);
    expect(() => parseTraceId("zzz", "custom_field")).toThrow(/custom_field/);
  });

  it("rejects whitespace and empty strings", () => {
    expect(() => parseTraceId("")).toThrow();
    expect(() => parseTraceId("  ")).toThrow();
    expect(() => parseTraceId(" 550e8400e29b41d4a716446655440000 ")).toThrow();
  });
});

describe("traceMetadata()", () => {
  it("emits trace-id and run-id always", () => {
    const md = traceMetadata({ traceId: "a".repeat(32), runId: "run_x" });
    expect(md[TRACE_HEADER_NAMES.traceId]).toBe("a".repeat(32));
    expect(md[TRACE_HEADER_NAMES.runId]).toBe("run_x");
    expect(md[TRACE_HEADER_NAMES.vmName]).toBeUndefined();
  });

  it("includes vm-name when populated", () => {
    const md = traceMetadata({
      traceId: "a".repeat(32),
      runId: "run_x",
      vmName: "endpoint-1",
    });
    expect(md[TRACE_HEADER_NAMES.vmName]).toBe("endpoint-1");
  });

  it("omits vm-name when empty string (service-level call)", () => {
    const md = traceMetadata({
      traceId: "a".repeat(32),
      runId: "run_x",
      vmName: "",
    });
    expect(md[TRACE_HEADER_NAMES.vmName]).toBeUndefined();
  });

  it("uses canonical lowercase header names matching gRPC conventions", () => {
    expect(TRACE_HEADER_NAMES.traceId).toBe("signalman-trace-id");
    expect(TRACE_HEADER_NAMES.runId).toBe("signalman-run-id");
    expect(TRACE_HEADER_NAMES.vmName).toBe("signalman-vm-name");
    for (const name of Object.values(TRACE_HEADER_NAMES)) {
      expect(name).toBe(name.toLowerCase());
    }
  });
});

describe("runWithTrace + currentTrace", () => {
  it("currentTrace returns undefined outside any traced run", () => {
    expect(currentTrace()).toBeUndefined();
  });

  it("currentTrace returns the supplied context inside runWithTrace", async () => {
    const ctx: TraceContext = {
      traceId: newTraceId(),
      runId: "run_x",
      vmName: "endpoint-1",
    };
    await runWithTrace(ctx, async () => {
      expect(currentTrace()).toEqual(ctx);
    });
  });

  it("propagates across await boundaries (the whole point)", async () => {
    const ctx: TraceContext = { traceId: newTraceId(), runId: "r" };
    await runWithTrace(ctx, async () => {
      await new Promise((r) => setTimeout(r, 1));
      expect(currentTrace()?.traceId).toBe(ctx.traceId);
      await Promise.resolve();
      expect(currentTrace()?.traceId).toBe(ctx.traceId);
    });
  });

  it("does not leak context outside the wrapped fn", async () => {
    const ctx: TraceContext = { traceId: newTraceId(), runId: "r" };
    await runWithTrace(ctx, async () => {
      expect(currentTrace()).toBeDefined();
    });
    expect(currentTrace()).toBeUndefined();
  });

  it("when trace is undefined, fn runs un-traced (no-op wrapper)", async () => {
    await runWithTrace(undefined, async () => {
      expect(currentTrace()).toBeUndefined();
    });
  });

  it("nested calls override the outer context (innermost wins)", async () => {
    const outer: TraceContext = { traceId: "a".repeat(32), runId: "outer" };
    const inner: TraceContext = { traceId: "b".repeat(32), runId: "inner" };
    await runWithTrace(outer, async () => {
      expect(currentTrace()?.runId).toBe("outer");
      await runWithTrace(inner, async () => {
        expect(currentTrace()?.runId).toBe("inner");
      });
      // Inner exited; outer restored.
      expect(currentTrace()?.runId).toBe("outer");
    });
  });

  it("isolates concurrent runs (the multi-VM-at-scale guarantee)", async () => {
    // The whole point of ALS: two parallel runWithTrace calls with
    // distinct contexts must not bleed into each other, even when they
    // both await with overlapping timelines.
    const a: TraceContext = { traceId: "a".repeat(32), runId: "A" };
    const b: TraceContext = { traceId: "b".repeat(32), runId: "B" };

    const observed: Array<{ from: string; saw: string | undefined }> = [];

    await Promise.all([
      runWithTrace(a, async () => {
        observed.push({ from: "A", saw: currentTrace()?.runId });
        await new Promise((r) => setTimeout(r, 5));
        observed.push({ from: "A", saw: currentTrace()?.runId });
      }),
      runWithTrace(b, async () => {
        await new Promise((r) => setTimeout(r, 1));
        observed.push({ from: "B", saw: currentTrace()?.runId });
        await new Promise((r) => setTimeout(r, 5));
        observed.push({ from: "B", saw: currentTrace()?.runId });
      }),
    ]);

    // Every observation from "A" must have seen runId "A"; from "B"
    // must have seen "B". No cross-talk.
    for (const o of observed) {
      expect(o.saw).toBe(o.from);
    }
  });
});
