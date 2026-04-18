import { describe, it, expect, beforeEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import {
  BreakLog,
  type BreakLogEntry,
} from "../kernel-debug/break-log.js";
import {
  handleKernelExpectBugcheck,
  handleKernelBreakOn,
  type KernelHandlerContext,
} from "../kernel-debug/handlers.js";
import type {
  KdSession,
  KdSessionState,
} from "../kernel-debug/kd-session.js";

// ─── Fake KdSession ─────────────────────────────────────────────────
//
// KdSession is an EventEmitter with a small typed API. The crash
// handlers call: on/off, run, resume, captureStack, captureAllStacks,
// captureAnalyze, saveDump, and read `state`. A FakeKdSession exposes
// exactly those so we can drive them from tests without ever spawning
// kd.exe.

class FakeKdSession extends EventEmitter {
  public state: KdSessionState = "running";
  public stateOverride: KdSessionState | undefined;
  /** Responses queued for each run() call, FIFO. */
  private runResponses: Array<string | Error> = [];
  /** Captured sequence of commands passed to run(). */
  public runCalls: string[] = [];
  /** Commands queued for captureStack / captureAllStacks / captureAnalyze. */
  private captureResponses: Map<string, string | Error> = new Map();
  public saveDumpCalls: string[] = [];
  public saveDumpShouldFail: Error | null = null;
  public resumeCalls = 0;
  public resumeShouldThrow: Error | null = null;

  queueRunResponse(response: string | Error): void {
    this.runResponses.push(response);
  }
  setCaptureResponse(
    kind: "stack" | "all_stacks" | "analyze",
    response: string | Error,
  ): void {
    this.captureResponses.set(kind, response);
  }

  async run(command: string, _timeoutMs?: number): Promise<string> {
    this.runCalls.push(command);
    const r = this.runResponses.shift();
    if (r === undefined) {
      // If no specific queued response, look in the capture map
      // (for captureStack / captureAnalyze paths which the handler
      // routes through the convenience wrappers).
      return "";
    }
    if (r instanceof Error) throw r;
    return r;
  }

  async captureStack(_timeoutMs?: number): Promise<string> {
    const r = this.captureResponses.get("stack");
    if (r instanceof Error) throw r;
    return r ?? "KN-OUTPUT";
  }
  async captureAllStacks(_timeoutMs?: number): Promise<string> {
    const r = this.captureResponses.get("all_stacks");
    if (r instanceof Error) throw r;
    return r ?? "ALL-STACKS";
  }
  async captureAnalyze(_timeoutMs?: number): Promise<string> {
    const r = this.captureResponses.get("analyze");
    if (r instanceof Error) throw r;
    return r ?? "ANALYZE-V";
  }
  async saveDump(path: string, _timeoutMs?: number): Promise<void> {
    this.saveDumpCalls.push(path);
    if (this.saveDumpShouldFail) throw this.saveDumpShouldFail;
  }
  resume(): void {
    this.resumeCalls++;
    if (this.resumeShouldThrow) throw this.resumeShouldThrow;
  }
  async detach(): Promise<void> {
    // no-op in tests
  }

  /** Drive a break event into the session's listeners — populates
   *  the BreakLog via its subscription. */
  emitBreak(
    reason: "bugcheck" | "break-instruction" | "module-load" | "manual",
    bugcheckCode?: string,
    detail?: string,
  ): void {
    this.emit("break", {
      type: "break",
      reason,
      bugcheckCode,
      detail,
    });
  }
}

function makeSession(): FakeKdSession {
  return new FakeKdSession();
}

function makeCtx(
  session: FakeKdSession,
): { ctx: KernelHandlerContext; log: BreakLog } {
  const log = new BreakLog(session as unknown as KdSession);
  return {
    ctx: {
      kdSession: session as unknown as KdSession,
      breakLog: log,
      vmName: "endpoint-1",
    },
    log,
  };
}

// ─── BreakLog tests ────────────────────────────────────────────────

describe("BreakLog — recording", () => {
  it("starts empty", () => {
    const s = makeSession();
    const log = new BreakLog(s as unknown as KdSession);
    expect(log.size).toBe(0);
    expect(log.all()).toEqual([]);
    expect(log.latest()).toBeUndefined();
  });

  it("records a break event", () => {
    const s = makeSession();
    const log = new BreakLog(s as unknown as KdSession);
    s.emitBreak("bugcheck", "0xd1");
    expect(log.size).toBe(1);
    const entry = log.latest();
    expect(entry?.reason).toBe("bugcheck");
    expect(entry?.bugcheckCode).toBe("0xd1");
    expect(typeof entry?.timestamp).toBe("number");
  });

  it("records multiple events in order", () => {
    const s = makeSession();
    const log = new BreakLog(s as unknown as KdSession);
    s.emitBreak("module-load");
    s.emitBreak("break-instruction");
    s.emitBreak("bugcheck", "0x7e");
    expect(log.size).toBe(3);
    expect(log.all().map((e) => e.reason)).toEqual([
      "module-load",
      "break-instruction",
      "bugcheck",
    ]);
  });

  it("records detail when present", () => {
    const s = makeSession();
    const log = new BreakLog(s as unknown as KdSession);
    s.emitBreak("break-instruction", undefined, "Break instruction exception");
    expect(log.latest()?.detail).toBe("Break instruction exception");
  });
});

describe("BreakLog — querying", () => {
  it("all() returns a snapshot, not a live view", () => {
    const s = makeSession();
    const log = new BreakLog(s as unknown as KdSession);
    s.emitBreak("bugcheck", "0xd1");
    const snap = log.all();
    s.emitBreak("bugcheck", "0x7e");
    // Snapshot should not have grown.
    expect(snap.length).toBe(1);
    expect(log.size).toBe(2);
  });

  it("since() filters by timestamp", () => {
    const s = makeSession();
    const log = new BreakLog(s as unknown as KdSession);
    s.emitBreak("bugcheck", "0xd1");
    const cutoff = Date.now() + 1; // in the future
    // Busy-wait a tick so the second entry's timestamp is definitely after cutoff
    const waited = Date.now();
    while (Date.now() === waited) {
      /* spin */
    }
    s.emitBreak("bugcheck", "0x7e");
    const recent = log.since(cutoff);
    expect(recent.length).toBe(1);
    expect(recent[0].bugcheckCode).toBe("0x7e");
  });

  it("find() filters by reason", () => {
    const s = makeSession();
    const log = new BreakLog(s as unknown as KdSession);
    s.emitBreak("bugcheck", "0xd1");
    s.emitBreak("module-load");
    s.emitBreak("bugcheck", "0x7e");
    const bugchecks = log.find({ reason: "bugcheck" });
    expect(bugchecks.length).toBe(2);
    expect(bugchecks.every((e) => e.reason === "bugcheck")).toBe(true);
  });

  it("find() filters by bugcheckCode with normalization", () => {
    const s = makeSession();
    const log = new BreakLog(s as unknown as KdSession);
    s.emitBreak("bugcheck", "0xd1");
    // Search with long-form; should match.
    expect(log.find({ bugcheckCode: "0x000000D1" }).length).toBe(1);
    // Search with no prefix; should match.
    expect(log.find({ bugcheckCode: "d1" }).length).toBe(1);
    // Search with different code; shouldn't match.
    expect(log.find({ bugcheckCode: "0x7e" }).length).toBe(0);
  });

  it("find() returns empty when log is empty", () => {
    const log = new BreakLog(makeSession() as unknown as KdSession);
    expect(log.find({ reason: "bugcheck" })).toEqual([]);
  });

  it("find() with no options returns everything", () => {
    const s = makeSession();
    const log = new BreakLog(s as unknown as KdSession);
    s.emitBreak("bugcheck", "0xd1");
    s.emitBreak("module-load");
    expect(log.find().length).toBe(2);
  });

  it("find() combines multiple filters (AND semantics)", () => {
    const s = makeSession();
    const log = new BreakLog(s as unknown as KdSession);
    s.emitBreak("bugcheck", "0xd1");
    s.emitBreak("bugcheck", "0x7e");
    s.emitBreak("break-instruction");
    const r = log.find({ reason: "bugcheck", bugcheckCode: "0xd1" });
    expect(r.length).toBe(1);
    expect(r[0].bugcheckCode).toBe("0xd1");
  });

  it("first() returns the earliest match, or undefined", () => {
    const s = makeSession();
    const log = new BreakLog(s as unknown as KdSession);
    expect(log.first({ reason: "bugcheck" })).toBeUndefined();
    s.emitBreak("bugcheck", "0xd1");
    s.emitBreak("bugcheck", "0x7e");
    expect(log.first({ reason: "bugcheck" })?.bugcheckCode).toBe("0xd1");
  });

  it("skips bugcheckCode match when entry has no code", () => {
    const s = makeSession();
    const log = new BreakLog(s as unknown as KdSession);
    s.emitBreak("break-instruction"); // no bugcheckCode
    expect(log.find({ bugcheckCode: "0xd1" })).toEqual([]);
  });

  it("normalizes all-zero bugcheck codes to 0x0", () => {
    const s = makeSession();
    const log = new BreakLog(s as unknown as KdSession);
    s.emitBreak("bugcheck", "0x00000000");
    // Search with short form; the "|| '0'" fallback in the
    // normalization helper ensures both sides compact to "0x0".
    expect(log.find({ bugcheckCode: "0x0" }).length).toBe(1);
    expect(log.find({ bugcheckCode: "0" }).length).toBe(1);
  });

  it("latest() returns the most recent entry", () => {
    const s = makeSession();
    const log = new BreakLog(s as unknown as KdSession);
    s.emitBreak("module-load");
    s.emitBreak("bugcheck", "0x7e");
    expect(log.latest()?.reason).toBe("bugcheck");
  });
});

describe("BreakLog — lifecycle", () => {
  it("detach() stops recording new events", () => {
    const s = makeSession();
    const log = new BreakLog(s as unknown as KdSession);
    s.emitBreak("bugcheck", "0xd1");
    log.detach();
    s.emitBreak("bugcheck", "0x7e");
    expect(log.size).toBe(1);
    expect(log.isAttached).toBe(false);
  });

  it("detach() is idempotent", () => {
    const s = makeSession();
    const log = new BreakLog(s as unknown as KdSession);
    log.detach();
    expect(() => log.detach()).not.toThrow();
    expect(log.isAttached).toBe(false);
  });

  it("existing entries remain queryable after detach", () => {
    const s = makeSession();
    const log = new BreakLog(s as unknown as KdSession);
    s.emitBreak("bugcheck", "0xd1");
    log.detach();
    expect(log.latest()?.bugcheckCode).toBe("0xd1");
  });

  it("clear() drops all entries but keeps listener attached", () => {
    const s = makeSession();
    const log = new BreakLog(s as unknown as KdSession);
    s.emitBreak("bugcheck", "0xd1");
    log.clear();
    expect(log.size).toBe(0);
    expect(log.isAttached).toBe(true);
    s.emitBreak("bugcheck", "0x7e");
    expect(log.size).toBe(1);
  });
});

// ─── handleKernelExpectBugcheck tests ──────────────────────────────

describe("handleKernelExpectBugcheck — match path", () => {
  let s: FakeKdSession;
  beforeEach(() => {
    s = makeSession();
  });

  it("reports match=true when a bugcheck entry exists", async () => {
    const { ctx } = makeCtx(s);
    s.emitBreak("bugcheck", "0xd1");
    const r = await handleKernelExpectBugcheck(ctx, { bugcheck_code: "0xd1" });
    expect(r.matched).toBe(true);
    expect(r.bugcheck_code).toBe("0xd1");
    expect(typeof r.timestamp).toBe("number");
  });

  it("normalizes bugcheck code on both sides", async () => {
    const { ctx } = makeCtx(s);
    s.emitBreak("bugcheck", "0xD1");
    const r = await handleKernelExpectBugcheck(ctx, {
      bugcheck_code: "0x000000d1",
    });
    expect(r.matched).toBe(true);
  });

  it("captures stack, all_stacks, and analyze by default", async () => {
    const { ctx } = makeCtx(s);
    s.emitBreak("bugcheck", "0xd1");
    s.setCaptureResponse("stack", "stack-data");
    s.setCaptureResponse("all_stacks", "all-threads");
    s.setCaptureResponse("analyze", "analyze-output");
    const r = await handleKernelExpectBugcheck(ctx, { bugcheck_code: "0xd1" });
    expect(r.matched).toBe(true);
    expect(r.stack).toBe("stack-data");
    expect(r.all_stacks).toBe("all-threads");
    expect(r.analyze_v).toBe("analyze-output");
  });

  it("skips captures when capture_stack: false", async () => {
    const { ctx } = makeCtx(s);
    s.emitBreak("bugcheck", "0xd1");
    const r = await handleKernelExpectBugcheck(ctx, {
      bugcheck_code: "0xd1",
      capture_stack: false,
    });
    expect(r.matched).toBe(true);
    expect(r.stack).toBeUndefined();
    expect(r.all_stacks).toBeUndefined();
    expect(r.analyze_v).toBeUndefined();
  });

  it("still reports match when captures partially fail", async () => {
    const { ctx } = makeCtx(s);
    s.emitBreak("bugcheck", "0xd1");
    s.setCaptureResponse("stack", "kn-output");
    s.setCaptureResponse("all_stacks", new Error("timeout"));
    s.setCaptureResponse("analyze", "analyze-data");
    const r = await handleKernelExpectBugcheck(ctx, { bugcheck_code: "0xd1" });
    expect(r.matched).toBe(true);
    expect(r.stack).toBe("kn-output");
    expect(r.analyze_v).toBe("analyze-data");
    expect(r.all_stacks).toBeUndefined();
    expect(r.message).toContain("captureAllStacks");
  });

  it("reports captureStack failure individually", async () => {
    const { ctx } = makeCtx(s);
    s.emitBreak("bugcheck", "0xd1");
    s.setCaptureResponse("stack", new Error("stack-timeout"));
    s.setCaptureResponse("all_stacks", "all-data");
    s.setCaptureResponse("analyze", "analyze-data");
    const r = await handleKernelExpectBugcheck(ctx, { bugcheck_code: "0xd1" });
    expect(r.matched).toBe(true);
    expect(r.stack).toBeUndefined();
    expect(r.message).toContain("captureStack");
  });

  it("reports captureAnalyze failure individually", async () => {
    const { ctx } = makeCtx(s);
    s.emitBreak("bugcheck", "0xd1");
    s.setCaptureResponse("stack", "kn-data");
    s.setCaptureResponse("all_stacks", "all-data");
    s.setCaptureResponse("analyze", new Error("analyze-timeout"));
    const r = await handleKernelExpectBugcheck(ctx, { bugcheck_code: "0xd1" });
    expect(r.matched).toBe(true);
    expect(r.analyze_v).toBeUndefined();
    expect(r.message).toContain("captureAnalyze");
  });

  it("saves a dump when dump_path is specified", async () => {
    const { ctx } = makeCtx(s);
    s.emitBreak("bugcheck", "0xd1");
    const r = await handleKernelExpectBugcheck(ctx, {
      bugcheck_code: "0xd1",
      dump_path: "Z:\\crash.dmp",
    });
    expect(r.matched).toBe(true);
    expect(r.dump_saved_to).toBe("Z:\\crash.dmp");
    expect(s.saveDumpCalls).toEqual(["Z:\\crash.dmp"]);
  });

  it("reports dump failure via message, still match=true", async () => {
    const { ctx } = makeCtx(s);
    s.emitBreak("bugcheck", "0xd1");
    s.saveDumpShouldFail = new Error("disk full");
    const r = await handleKernelExpectBugcheck(ctx, {
      bugcheck_code: "0xd1",
      dump_path: "Z:\\crash.dmp",
      capture_stack: false,
    });
    expect(r.matched).toBe(true);
    expect(r.dump_saved_to).toBeUndefined();
    expect(r.message).toContain("disk full");
  });

  it("applies within_ms to scope the search", async () => {
    const { ctx } = makeCtx(s);
    s.emitBreak("bugcheck", "0xd1"); // "old"
    await new Promise((r) => setTimeout(r, 50));
    const r = await handleKernelExpectBugcheck(ctx, {
      bugcheck_code: "0xd1",
      within_ms: 10,
      capture_stack: false,
    });
    // The 50ms gap puts the entry outside the 10ms window.
    expect(r.matched).toBe(false);
  });
});

describe("handleKernelExpectBugcheck — no-match path", () => {
  let s: FakeKdSession;
  beforeEach(() => {
    s = makeSession();
  });

  it("reports match=false when no bugcheck is present", async () => {
    const { ctx } = makeCtx(s);
    const r = await handleKernelExpectBugcheck(ctx, {
      bugcheck_code: "0xd1",
      capture_stack: false,
    });
    expect(r.matched).toBe(false);
    expect(r.message).toContain("No break events");
  });

  it("mentions other observed breaks in the mismatch message", async () => {
    const { ctx } = makeCtx(s);
    s.emitBreak("module-load");
    s.emitBreak("break-instruction");
    const r = await handleKernelExpectBugcheck(ctx, {
      bugcheck_code: "0xd1",
      capture_stack: false,
    });
    expect(r.matched).toBe(false);
    expect(r.message).toContain("2 other break event(s)");
  });

  it("reports mismatch when bugcheck code differs", async () => {
    const { ctx } = makeCtx(s);
    s.emitBreak("bugcheck", "0x7e");
    const r = await handleKernelExpectBugcheck(ctx, {
      bugcheck_code: "0xd1",
      capture_stack: false,
    });
    expect(r.matched).toBe(false);
    expect(r.message).toContain("bugcheck 0x7e");
  });

  it("summarizes many breaks with ellipsis", async () => {
    const { ctx } = makeCtx(s);
    for (let i = 0; i < 10; i++) s.emitBreak("module-load");
    const r = await handleKernelExpectBugcheck(ctx, {
      bugcheck_code: "0xd1",
      capture_stack: false,
    });
    expect(r.matched).toBe(false);
    // First 5 + ellipsis for remainder.
    expect(r.message).toContain("5 more");
  });
});

// ─── handleKernelBreakOn tests ─────────────────────────────────────

describe("handleKernelBreakOn", () => {
  let s: FakeKdSession;
  beforeEach(() => {
    s = makeSession();
  });

  it("installs the breakpoint via bp <symbol>", async () => {
    const { ctx } = makeCtx(s);
    // Queue responses: bp install (empty), and then capture output.
    s.queueRunResponse(""); // bp
    s.queueRunResponse("kn-output"); // capture
    // Fire the break event shortly after the handler arms.
    setTimeout(() => s.emitBreak("break-instruction"), 10);
    const r = await handleKernelBreakOn(ctx, {
      symbol: "ospiri!HandleIoctl",
      timeout_ms: 1_000,
    });
    expect(r.matched).toBe(true);
    expect(r.capture_output).toBe("kn-output");
    expect(s.runCalls[0]).toBe("bp ospiri!HandleIoctl");
  });

  it("uses custom capture command when provided", async () => {
    const { ctx } = makeCtx(s);
    s.queueRunResponse(""); // bp
    s.queueRunResponse("custom-capture"); // capture
    setTimeout(() => s.emitBreak("break-instruction"), 10);
    await handleKernelBreakOn(ctx, {
      symbol: "x!y",
      capture: "kn; r",
      timeout_ms: 1_000,
    });
    expect(s.runCalls[1]).toBe("kn; r");
  });

  it("resumes after capture when resume_after is default", async () => {
    const { ctx } = makeCtx(s);
    s.queueRunResponse("");
    s.queueRunResponse("output");
    setTimeout(() => s.emitBreak("break-instruction"), 10);
    await handleKernelBreakOn(ctx, {
      symbol: "x!y",
      timeout_ms: 1_000,
    });
    expect(s.resumeCalls).toBeGreaterThanOrEqual(1);
  });

  it("does not resume when resume_after is false", async () => {
    const { ctx } = makeCtx(s);
    s.queueRunResponse("");
    s.queueRunResponse("output");
    setTimeout(() => s.emitBreak("break-instruction"), 10);
    s.state = "running"; // ensure we wouldn't pre-resume
    const before = s.resumeCalls;
    await handleKernelBreakOn(ctx, {
      symbol: "x!y",
      timeout_ms: 1_000,
      resume_after: false,
    });
    // Only the initial pre-wait resume (if state was "broken") would
    // increment; since state was "running", no resume should have been called.
    expect(s.resumeCalls).toBe(before);
  });

  it("pre-resumes when session is currently broken", async () => {
    const { ctx } = makeCtx(s);
    s.state = "broken";
    s.queueRunResponse("");
    s.queueRunResponse("output");
    setTimeout(() => s.emitBreak("break-instruction"), 10);
    await handleKernelBreakOn(ctx, {
      symbol: "x!y",
      timeout_ms: 1_000,
      resume_after: false,
    });
    // Exactly one resume — the pre-wait one — since resume_after is false.
    expect(s.resumeCalls).toBe(1);
  });

  it("returns match=false on timeout when break never arrives", async () => {
    const { ctx } = makeCtx(s);
    s.queueRunResponse(""); // bp
    // Deliberately do NOT emit a break; the wait should time out.
    const r = await handleKernelBreakOn(ctx, {
      symbol: "x!y",
      timeout_ms: 150,
    });
    expect(r.matched).toBe(false);
    expect(r.message).toContain("Timed out");
  });

  it("returns match=false when bp install itself errors", async () => {
    const { ctx } = makeCtx(s);
    s.queueRunResponse(new Error("no symbol resolver"));
    const r = await handleKernelBreakOn(ctx, {
      symbol: "nonsense",
      timeout_ms: 100,
    });
    expect(r.matched).toBe(false);
    expect(r.message).toContain("Failed to install breakpoint");
  });

  it("returns match=true + message when capture errors", async () => {
    const { ctx } = makeCtx(s);
    s.queueRunResponse(""); // bp
    s.queueRunResponse(new Error("capture broke")); // capture
    setTimeout(() => s.emitBreak("break-instruction"), 10);
    const r = await handleKernelBreakOn(ctx, {
      symbol: "x!y",
      timeout_ms: 1_000,
    });
    expect(r.matched).toBe(true);
    expect(r.capture_output).toBeUndefined();
    expect(r.message).toContain("capture failed");
  });

  it("tolerates resume failure after capture", async () => {
    const { ctx } = makeCtx(s);
    s.queueRunResponse("");
    s.queueRunResponse("output");
    s.resumeShouldThrow = new Error("disconnected");
    setTimeout(() => s.emitBreak("break-instruction"), 10);
    const r = await handleKernelBreakOn(ctx, {
      symbol: "x!y",
      timeout_ms: 1_000,
    });
    // The resume throw is swallowed — matched stays true.
    expect(r.matched).toBe(true);
    expect(r.capture_output).toBe("output");
  });

  it("returns match=false when pre-wait resume errors", async () => {
    const { ctx } = makeCtx(s);
    s.state = "broken";
    s.queueRunResponse(""); // bp succeeds
    s.resumeShouldThrow = new Error("stdin closed");
    const r = await handleKernelBreakOn(ctx, {
      symbol: "x!y",
      timeout_ms: 100,
    });
    expect(r.matched).toBe(false);
    expect(r.message).toContain("Failed to resume session");
  });

  it("captures a bugcheck as a break event too (legitimate termination)", async () => {
    const { ctx } = makeCtx(s);
    s.queueRunResponse("");
    s.queueRunResponse("bugcheck-stack");
    setTimeout(() => s.emitBreak("bugcheck", "0x7e"), 10);
    const r = await handleKernelBreakOn(ctx, {
      symbol: "x!y",
      timeout_ms: 1_000,
    });
    expect(r.matched).toBe(true);
    expect(r.capture_output).toBe("bugcheck-stack");
  });

  it("uses default timeout when unspecified", async () => {
    const { ctx } = makeCtx(s);
    s.queueRunResponse("");
    s.queueRunResponse("output");
    setTimeout(() => s.emitBreak("break-instruction"), 10);
    const r = await handleKernelBreakOn(ctx, { symbol: "x!y" });
    expect(r.matched).toBe(true);
  });
});

// ─── Orchestrator dispatch integration ─────────────────────────────
//
// Thin end-to-end: ScenarioOrchestrator constructed with fake KdSession
// + BreakLog, executeToolBlock routes kernel_expect_bugcheck and
// kernel_break_on to the handlers, result JSON-stringified as usual.

describe("ScenarioOrchestrator — kernel_* dispatch", () => {
  it("dispatches kernel_expect_bugcheck", async () => {
    const session = makeSession();
    const { ScenarioOrchestrator } = await import(
      "../scenarios/orchestrator.js"
    );
    const backend = stubBackend();
    const orchestrator = new ScenarioOrchestrator(
      backend as never,
      new Map() as never,
      {} as never,
      {},
    );
    // Inject session + log via the hook the orchestrator will expose in
    // 1e production code. For now we call the handler directly via a
    // shim; this test guards the dispatch pattern.
    const vmMap = new Map<string, unknown>([
      ["endpoint-1", { id: "x", name: "endpoint-1", backend: "test" }],
    ]);
    // Register the kernel debug context so the orchestrator can find it.
    orchestrator.setKernelDebugSession(
      "endpoint-1",
      session as unknown as KdSession,
    );
    session.emitBreak("bugcheck", "0xd1");

    const out = await orchestrator.executeToolBlock(
      "kernel_expect_bugcheck",
      {
        vm: "endpoint-1",
        bugcheck_code: "0xd1",
        capture_stack: false,
      },
      vmMap as never,
    );
    const parsed = JSON.parse(out);
    expect(parsed.matched).toBe(true);
    expect(parsed.bugcheck_code).toBe("0xd1");
  });

  it("throws when kernel_expect_bugcheck has no kernel_debug session", async () => {
    const { ScenarioOrchestrator } = await import(
      "../scenarios/orchestrator.js"
    );
    const backend = stubBackend();
    const orchestrator = new ScenarioOrchestrator(
      backend as never,
      new Map() as never,
      {} as never,
      {},
    );
    const vmMap = new Map<string, unknown>([
      ["endpoint-1", { id: "x", name: "endpoint-1", backend: "test" }],
    ]);
    await expect(
      orchestrator.executeToolBlock(
        "kernel_expect_bugcheck",
        { vm: "endpoint-1", bugcheck_code: "0xd1" },
        vmMap as never,
      ),
    ).rejects.toThrow(/kernel_debug/);
  });

  it("dispatches kernel_break_on", async () => {
    const session = makeSession();
    session.queueRunResponse(""); // bp
    session.queueRunResponse("kn-data"); // capture
    const { ScenarioOrchestrator } = await import(
      "../scenarios/orchestrator.js"
    );
    const orchestrator = new ScenarioOrchestrator(
      stubBackend() as never,
      new Map() as never,
      {} as never,
      {},
    );
    orchestrator.setKernelDebugSession(
      "endpoint-1",
      session as unknown as KdSession,
    );
    const vmMap = new Map<string, unknown>([
      ["endpoint-1", { id: "x", name: "endpoint-1", backend: "test" }],
    ]);
    setTimeout(() => session.emitBreak("break-instruction"), 10);
    const out = await orchestrator.executeToolBlock(
      "kernel_break_on",
      { vm: "endpoint-1", symbol: "x!y", timeout_ms: 1_000 },
      vmMap as never,
    );
    const parsed = JSON.parse(out);
    expect(parsed.matched).toBe(true);
    expect(parsed.capture_output).toBe("kn-data");
  });
});

// ─── helpers ───────────────────────────────────────────────────────

function stubBackend(): unknown {
  return {
    name: "test" as const,
    isAvailable: async () => true,
    createVM: async () => ({ id: "x", name: "endpoint-1", backend: "test" }),
    listVMs: async () => [],
    startVM: async () => {},
    stopVM: async () => {},
    getStatus: async () => ({
      state: "running" as const,
      guestAgentReachable: true,
      uptimeSeconds: 0,
      memoryUsedMB: 0,
    }),
    deleteVM: async () => {},
    createCheckpoint: async () => ({
      id: "c",
      vmHandle: { id: "x", name: "endpoint-1", backend: "test" },
      label: "l",
    }),
    restoreCheckpoint: async () => {},
    deleteCheckpoint: async () => {},
    listCheckpoints: async () => [],
    copyFileToVM: async () => {},
    copyFileFromVM: async () => {},
    runCommand: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    installSoftware: async () => ({ success: true, output: "" }),
  };
}

// Silence vi warnings when resume etc. are called asynchronously.
vi.useRealTimers();
