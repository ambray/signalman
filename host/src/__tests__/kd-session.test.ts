import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
  KdSession,
  KdCommandTimeoutError,
  KdSessionStateError,
  DEFAULT_COMMAND_TIMEOUT_MS,
} from "../kernel-debug/kd-session.js";

// ─── Fake child process ─────────────────────────────────────────────
//
// We don't want these tests to spawn actual `kd.exe` — that would
// require a real VM and is useless for unit coverage. Instead each test
// creates a `FakeChildProcess` that exposes stdin (a writable stream
// the SUT writes commands into) and stdout/stderr (writable streams
// the test drives to simulate kd output). The shape mimics
// `ChildProcess` closely enough that TypeScript's structural typing
// accepts it via `as unknown as ChildProcess`.

class FakeChildProcess extends EventEmitter {
  public readonly stdin: PassThrough;
  public readonly stdout: PassThrough;
  public readonly stderr: PassThrough;
  /** Lines the session wrote to stdin. Populated by the stdin sniffer. */
  public readonly stdinLines: string[] = [];
  /**
   * Buffer of incomplete stdin (no trailing newline yet). Flushed into
   * `stdinLines` when a newline arrives.
   */
  private stdinBuffer = "";
  public killed = false;

  constructor() {
    super();
    this.stdin = new PassThrough();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.stdin.on("data", (chunk: Buffer) => {
      this.stdinBuffer += chunk.toString("utf8");
      const parts = this.stdinBuffer.split("\n");
      this.stdinBuffer = parts.pop() ?? "";
      for (const line of parts) {
        this.stdinLines.push(line);
      }
    });
  }

  /** Push a chunk to stdout so the session parses it as kd output. */
  emitStdout(text: string): void {
    this.stdout.write(text);
  }

  emitStderr(text: string): void {
    this.stderr.write(text);
  }

  /** Simulate kd exit. */
  simulateExit(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.emit("exit", code, signal);
  }

  /** Simulate a spawn error. */
  simulateError(err: Error): void {
    this.emit("error", err);
  }

  kill(): boolean {
    this.killed = true;
    this.simulateExit(null, "SIGTERM");
    return true;
  }
}

/**
 * Spawn factory that returns our fake. Because `KdSession` calls the
 * spawn function synchronously during `start()`, the factory also
 * stashes the FakeChildProcess in a caller-provided capture object so
 * tests can drive it.
 */
function makeFakeSpawn(capture: { proc: FakeChildProcess | null }) {
  return ((): FakeChildProcess => {
    const proc = new FakeChildProcess();
    capture.proc = proc;
    return proc;
    // Cast via unknown; the runtime duck-types spawn's return.
  }) as unknown as typeof import("node:child_process").spawn;
}

// Helper: flush the microtask + I/O queue so stream data has been
// processed by the session before we assert.
async function flush(): Promise<void> {
  await new Promise((r) => setImmediate(r));
}

// ─── Construction + startup ─────────────────────────────────────────

describe("KdSession — construction", () => {
  it("starts in 'idle' state", () => {
    const s = new KdSession({ kdArgs: ["-k", "pipe"] });
    expect(s.state).toBe("idle");
  });

  it("uses default timeout when not specified", () => {
    expect(DEFAULT_COMMAND_TIMEOUT_MS).toBe(60_000);
  });
});

describe("KdSession — start()", () => {
  let cap: { proc: FakeChildProcess | null };
  beforeEach(() => {
    cap = { proc: null };
  });

  it("transitions idle → running after start", async () => {
    const s = new KdSession({ kdArgs: ["-k"], spawnFn: makeFakeSpawn(cap) });
    expect(s.state).toBe("idle");
    await s.start();
    expect(s.state).toBe("running");
    expect(cap.proc).not.toBeNull();
  });

  it("sends 'g' on startup to resume the target", async () => {
    const s = new KdSession({ kdArgs: ["-k"], spawnFn: makeFakeSpawn(cap) });
    await s.start();
    await flush();
    expect(cap.proc!.stdinLines).toContain("g");
  });

  it("sends '.bugcheckstop 1' when breakOnBugcheck is on (default)", async () => {
    const s = new KdSession({ kdArgs: ["-k"], spawnFn: makeFakeSpawn(cap) });
    await s.start();
    expect(cap.proc!.stdinLines).toContain(".bugcheckstop 1");
  });

  it("does NOT send '.bugcheckstop 1' when breakOnBugcheck is off", async () => {
    const s = new KdSession({
      kdArgs: ["-k"],
      spawnFn: makeFakeSpawn(cap),
      breakOnBugcheck: false,
    });
    await s.start();
    expect(cap.proc!.stdinLines).not.toContain(".bugcheckstop 1");
  });

  it("sends 'sxe ld <mod>' for each breakOnLoad entry", async () => {
    const s = new KdSession({
      kdArgs: ["-k"],
      spawnFn: makeFakeSpawn(cap),
      breakOnLoad: ["ospiri.sys", "silo.sys"],
    });
    await s.start();
    expect(cap.proc!.stdinLines).toContain("sxe ld ospiri.sys");
    expect(cap.proc!.stdinLines).toContain("sxe ld silo.sys");
  });

  it("passes kdArgs through to spawn", async () => {
    const spawnSpy = vi.fn(makeFakeSpawn(cap));
    const s = new KdSession({
      kdArgs: ["-k", "com:pipe,port=foo"],
      spawnFn: spawnSpy as unknown as typeof import("node:child_process").spawn,
    });
    await s.start();
    expect(spawnSpy).toHaveBeenCalledWith(
      "kd.exe",
      ["-k", "com:pipe,port=foo"],
      expect.objectContaining({ stdio: ["pipe", "pipe", "pipe"] }),
    );
  });

  it("throws when called twice", async () => {
    const s = new KdSession({ kdArgs: ["-k"], spawnFn: makeFakeSpawn(cap) });
    await s.start();
    await expect(s.start()).rejects.toThrow(KdSessionStateError);
  });

  it("merges env over process.env", async () => {
    const spawnSpy = vi.fn(makeFakeSpawn(cap));
    const s = new KdSession({
      kdArgs: ["-k"],
      env: { _NT_SYMBOL_PATH: "srv*C:\\Symbols" },
      spawnFn: spawnSpy as unknown as typeof import("node:child_process").spawn,
    });
    await s.start();
    const env = (spawnSpy.mock.calls[0][2] as { env: NodeJS.ProcessEnv }).env;
    expect(env._NT_SYMBOL_PATH).toBe("srv*C:\\Symbols");
  });
});

// ─── Command round-trip ─────────────────────────────────────────────

describe("KdSession — run()", () => {
  let cap: { proc: FakeChildProcess | null };
  beforeEach(() => {
    cap = { proc: null };
  });

  it("sends the command bracketed with a sentinel", async () => {
    const s = new KdSession({ kdArgs: ["-k"], spawnFn: makeFakeSpawn(cap) });
    await s.start();
    cap.proc!.stdinLines.length = 0;

    // Fire the command without awaiting — we need to simulate the
    // sentinel reply before the promise can resolve.
    const pending = s.run("kn");
    await flush();

    // Last stdin line should be `kn; .echo SIGNALMAN-<uuid>-END`.
    const last = cap.proc!.stdinLines[cap.proc!.stdinLines.length - 1];
    expect(last).toMatch(/^kn; \.echo SIGNALMAN-[0-9a-f-]+-END$/);

    // Extract the uuid kd is expecting.
    const uuidMatch = /SIGNALMAN-([0-9a-f-]+)-END$/.exec(last)!;
    expect(uuidMatch).not.toBeNull();
    const uuid = uuidMatch[1];

    // Simulate kd echoing some output then the sentinel.
    cap.proc!.emitStdout(
      `ospiri!HandleIoctl+0x3a\nnt!IofCallDriver+0x56\nSIGNALMAN-${uuid}-END\n`,
    );
    await flush();
    const output = await pending;
    expect(output).toContain("ospiri!HandleIoctl");
    expect(output).toContain("IofCallDriver");
    expect(output).not.toContain("SIGNALMAN-");
  });

  it("rejects a second run() while the first is pending", async () => {
    const s = new KdSession({ kdArgs: ["-k"], spawnFn: makeFakeSpawn(cap) });
    await s.start();
    const first = s.run("kn");
    await flush();
    await expect(s.run("!analyze -v")).rejects.toThrow(/in flight/);
    // Unblock first to avoid dangling timer.
    const uuid = extractLastUuid(cap.proc!);
    cap.proc!.emitStdout(`SIGNALMAN-${uuid}-END\n`);
    await flush();
    await first;
  });

  it("times out when no sentinel arrives", async () => {
    const s = new KdSession({
      kdArgs: ["-k"],
      spawnFn: makeFakeSpawn(cap),
      defaultCommandTimeoutMs: 50,
    });
    await s.start();
    const pending = s.run("kn");
    await expect(pending).rejects.toThrow(KdCommandTimeoutError);
  });

  it("includes partial output on timeout", async () => {
    const s = new KdSession({
      kdArgs: ["-k"],
      spawnFn: makeFakeSpawn(cap),
      defaultCommandTimeoutMs: 100,
    });
    await s.start();
    const pending = s.run("kn");
    await flush();
    cap.proc!.emitStdout("partial frame 1\npartial frame 2\n");
    await flush();
    try {
      await pending;
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(KdCommandTimeoutError);
      const e = err as KdCommandTimeoutError;
      expect(e.partialOutput).toContain("partial frame 1");
      expect(e.partialOutput).toContain("partial frame 2");
      expect(e.timeoutMs).toBe(100);
      expect(e.command).toBe("kn");
    }
  });

  it("honors per-call timeoutMs override", async () => {
    const s = new KdSession({
      kdArgs: ["-k"],
      spawnFn: makeFakeSpawn(cap),
      defaultCommandTimeoutMs: 10_000,
    });
    await s.start();
    const start = Date.now();
    await expect(s.run("kn", 40)).rejects.toThrow(KdCommandTimeoutError);
    const elapsed = Date.now() - start;
    // Sanity check: rejected well under the default 10s.
    expect(elapsed).toBeLessThan(500);
  });

  it("rejects when session is disconnected", async () => {
    const s = new KdSession({ kdArgs: ["-k"], spawnFn: makeFakeSpawn(cap) });
    await s.start();
    cap.proc!.simulateExit(0);
    await flush();
    await expect(s.run("kn")).rejects.toThrow(KdSessionStateError);
  });

  it("rejects when session has never started", async () => {
    const s = new KdSession({ kdArgs: ["-k"], spawnFn: makeFakeSpawn(cap) });
    await expect(s.run("kn")).rejects.toThrow(KdSessionStateError);
  });

  it("ignores stale sentinels from a timed-out command", async () => {
    const s = new KdSession({
      kdArgs: ["-k"],
      spawnFn: makeFakeSpawn(cap),
      defaultCommandTimeoutMs: 50,
    });
    await s.start();
    const firstAttempt = s.run("kn");
    await flush();
    const staleUuid = extractLastUuid(cap.proc!);
    await expect(firstAttempt).rejects.toThrow(KdCommandTimeoutError);

    // Stale sentinel arrives AFTER timeout. Should not crash or resolve
    // a future command with wrong data.
    cap.proc!.emitStdout(`SIGNALMAN-${staleUuid}-END\n`);
    await flush();

    // Now issue a fresh command — it should not get the stale output.
    const next = s.run("!thread", 50);
    await flush();
    const freshUuid = extractLastUuid(cap.proc!);
    cap.proc!.emitStdout(`fresh output\nSIGNALMAN-${freshUuid}-END\n`);
    await flush();
    expect(await next).toContain("fresh output");
  });
});

// ─── Event emission ─────────────────────────────────────────────────

describe("KdSession — break event emission", () => {
  let cap: { proc: FakeChildProcess | null };
  beforeEach(() => {
    cap = { proc: null };
  });

  it("emits 'break' with bugcheck code on *** Fatal System Error", async () => {
    const s = new KdSession({ kdArgs: ["-k"], spawnFn: makeFakeSpawn(cap) });
    const breaks: unknown[] = [];
    s.on("break", (ev) => breaks.push(ev));
    await s.start();
    cap.proc!.emitStdout("*** Fatal System Error: 0xd1\n");
    await flush();
    expect(breaks).toHaveLength(1);
    expect(breaks[0]).toMatchObject({
      type: "break",
      reason: "bugcheck",
      bugcheckCode: "0xd1",
    });
    expect(s.state).toBe("broken");
  });

  it("emits 'break' for BUGCHECK_CODE: in !analyze output", async () => {
    const s = new KdSession({ kdArgs: ["-k"], spawnFn: makeFakeSpawn(cap) });
    const breaks: unknown[] = [];
    s.on("break", (ev) => breaks.push(ev));
    await s.start();
    cap.proc!.emitStdout("BUGCHECK_CODE:  d1\n");
    await flush();
    expect(breaks[0]).toMatchObject({
      reason: "bugcheck",
      bugcheckCode: "0xd1",
    });
  });

  it("emits 'break' for Break instruction exception", async () => {
    const s = new KdSession({ kdArgs: ["-k"], spawnFn: makeFakeSpawn(cap) });
    const breaks: unknown[] = [];
    s.on("break", (ev) => breaks.push(ev));
    await s.start();
    cap.proc!.emitStdout(
      "Break instruction exception - code 80000003 (first chance)\n",
    );
    await flush();
    expect(breaks[0]).toMatchObject({
      type: "break",
      reason: "break-instruction",
    });
  });

  it("emits 'module-load' for ModLoad lines", async () => {
    const s = new KdSession({ kdArgs: ["-k"], spawnFn: makeFakeSpawn(cap) });
    const loads: unknown[] = [];
    s.on("module-load", (ev) => loads.push(ev));
    await s.start();
    cap.proc!.emitStdout(
      "ModLoad: fffff807`b3a00000 fffff807`b3a16000   ospiri.sys\n",
    );
    await flush();
    expect(loads[0]).toMatchObject({
      type: "module-load",
      module: "ospiri.sys",
    });
  });

  it("emits 'disconnect' when kd reports connection loss", async () => {
    const s = new KdSession({ kdArgs: ["-k"], spawnFn: makeFakeSpawn(cap) });
    const disc: unknown[] = [];
    s.on("disconnect", (ev) => disc.push(ev));
    await s.start();
    cap.proc!.emitStdout("Debuggee is not connected\n");
    await flush();
    expect(disc).toHaveLength(1);
    expect(s.state).toBe("disconnected");
  });

  it("emits 'disconnect' when kd exits unexpectedly", async () => {
    const s = new KdSession({ kdArgs: ["-k"], spawnFn: makeFakeSpawn(cap) });
    const disc: unknown[] = [];
    s.on("disconnect", (ev) => disc.push(ev));
    await s.start();
    cap.proc!.simulateExit(1);
    await flush();
    expect(disc[0]).toMatchObject({
      type: "disconnect",
      reason: expect.stringContaining("exit code 1"),
    });
  });

  it("rejects in-flight command on unexpected exit", async () => {
    const s = new KdSession({ kdArgs: ["-k"], spawnFn: makeFakeSpawn(cap) });
    await s.start();
    const pending = s.run("kn");
    const expectation = expect(pending).rejects.toThrow(/kd exited/);
    await flush();
    cap.proc!.simulateExit(1);
    await expectation;
  });

  it("rejects in-flight command on disconnect marker", async () => {
    const s = new KdSession({ kdArgs: ["-k"], spawnFn: makeFakeSpawn(cap) });
    await s.start();
    const pending = s.run("kn");
    // Attach the rejection handler *before* driving the event that
    // causes the rejection, otherwise Node briefly sees an unhandled
    // promise between stream emit and the `await expect(...)` below.
    const expectation = expect(pending).rejects.toThrow(/Disconnected/);
    await flush();
    cap.proc!.emitStdout("Connection closed\n");
    await expectation;
  });

  it("emits 'stdout-line' for every line", async () => {
    const s = new KdSession({ kdArgs: ["-k"], spawnFn: makeFakeSpawn(cap) });
    const lines: string[] = [];
    s.on("stdout-line", (ev) => lines.push(ev.line));
    await s.start();
    cap.proc!.emitStdout("line one\nline two\nline three\n");
    await flush();
    expect(lines).toEqual(["line one", "line two", "line three"]);
  });

  it("emits 'stderr-line' for stderr lines", async () => {
    const s = new KdSession({ kdArgs: ["-k"], spawnFn: makeFakeSpawn(cap) });
    const lines: string[] = [];
    s.on("stderr-line", (ev) => lines.push(ev.line));
    await s.start();
    cap.proc!.emitStderr("error: something\n");
    await flush();
    expect(lines).toEqual(["error: something"]);
  });

  it("handles output arriving in multiple chunks", async () => {
    const s = new KdSession({ kdArgs: ["-k"], spawnFn: makeFakeSpawn(cap) });
    const lines: string[] = [];
    s.on("stdout-line", (ev) => lines.push(ev.line));
    await s.start();
    cap.proc!.emitStdout("part");
    cap.proc!.emitStdout("ial\nnext");
    cap.proc!.emitStdout(" line\n");
    await flush();
    expect(lines).toEqual(["partial", "next line"]);
  });
});

// ─── Convenience methods ────────────────────────────────────────────

describe("KdSession — convenience wrappers", () => {
  let cap: { proc: FakeChildProcess | null };
  beforeEach(() => {
    cap = { proc: null };
  });

  async function startAndGetProc(): Promise<{
    session: KdSession;
    proc: FakeChildProcess;
  }> {
    const session = new KdSession({
      kdArgs: ["-k"],
      spawnFn: makeFakeSpawn(cap),
    });
    await session.start();
    cap.proc!.stdinLines.length = 0;
    return { session, proc: cap.proc! };
  }

  it("captureStack sends `kn`", async () => {
    const { session, proc } = await startAndGetProc();
    const p = session.captureStack();
    await flush();
    expect(proc.stdinLines[0]).toMatch(/^kn; \.echo SIGNALMAN/);
    const uuid = extractLastUuid(proc);
    proc.emitStdout(`SIGNALMAN-${uuid}-END\n`);
    await p;
  });

  it("captureAllStacks sends `~*kn`", async () => {
    const { session, proc } = await startAndGetProc();
    const p = session.captureAllStacks();
    await flush();
    expect(proc.stdinLines[0]).toMatch(/^~\*kn; \.echo SIGNALMAN/);
    const uuid = extractLastUuid(proc);
    proc.emitStdout(`SIGNALMAN-${uuid}-END\n`);
    await p;
  });

  it("captureAnalyze sends `!analyze -v`", async () => {
    const { session, proc } = await startAndGetProc();
    const p = session.captureAnalyze();
    await flush();
    expect(proc.stdinLines[0]).toMatch(/^!analyze -v; \.echo SIGNALMAN/);
    const uuid = extractLastUuid(proc);
    proc.emitStdout(`SIGNALMAN-${uuid}-END\n`);
    await p;
  });

  it("saveDump sends `.dump /f \"<path>\"`", async () => {
    const { session, proc } = await startAndGetProc();
    const p = session.saveDump("Z:\\crash.dmp");
    await flush();
    expect(proc.stdinLines[0]).toMatch(
      /^\.dump \/f "Z:\\crash\.dmp"; \.echo SIGNALMAN/,
    );
    const uuid = extractLastUuid(proc);
    proc.emitStdout(`SIGNALMAN-${uuid}-END\n`);
    await p;
  });

  it("saveDump escapes embedded quotes", async () => {
    const { session, proc } = await startAndGetProc();
    const p = session.saveDump('Z:\\weird"path.dmp');
    await flush();
    expect(proc.stdinLines[0]).toContain('"Z:\\weird\\"path.dmp"');
    const uuid = extractLastUuid(proc);
    proc.emitStdout(`SIGNALMAN-${uuid}-END\n`);
    await p;
  });

  it("resume sends `g`", async () => {
    const { session, proc } = await startAndGetProc();
    session.resume();
    await flush();
    expect(proc.stdinLines).toContain("g");
  });

  it("resume throws when disconnected", async () => {
    const { session, proc } = await startAndGetProc();
    proc.simulateExit(0);
    await flush();
    expect(() => session.resume()).toThrow(KdSessionStateError);
  });
});

// ─── Detach + cleanup ───────────────────────────────────────────────

describe("KdSession — detach()", () => {
  let cap: { proc: FakeChildProcess | null };
  beforeEach(() => {
    cap = { proc: null };
  });

  it("sends `qd` on clean detach", async () => {
    const s = new KdSession({ kdArgs: ["-k"], spawnFn: makeFakeSpawn(cap) });
    await s.start();
    cap.proc!.stdinLines.length = 0;
    const pending = s.detach();
    await flush();
    expect(cap.proc!.stdinLines).toContain("qd");
    // Simulate kd exiting cleanly in response.
    cap.proc!.simulateExit(0);
    await pending;
    expect(s.state).toBe("disconnected");
  });

  it("is idempotent (second detach is a no-op)", async () => {
    const s = new KdSession({ kdArgs: ["-k"], spawnFn: makeFakeSpawn(cap) });
    await s.start();
    const p1 = s.detach();
    await flush();
    cap.proc!.simulateExit(0);
    await p1;
    // Second call should not throw and should return quickly.
    await s.detach();
    expect(s.state).toBe("disconnected");
  });

  it("detach from idle transitions to disconnected without spawning", async () => {
    const spawnSpy = vi.fn(makeFakeSpawn(cap));
    const s = new KdSession({
      kdArgs: ["-k"],
      spawnFn: spawnSpy as unknown as typeof import("node:child_process").spawn,
    });
    await s.detach();
    expect(spawnSpy).not.toHaveBeenCalled();
    expect(s.state).toBe("disconnected");
  });

  it("force-kills kd if `qd` is ignored", async () => {
    const s = new KdSession({ kdArgs: ["-k"], spawnFn: makeFakeSpawn(cap) });
    await s.start();
    vi.useFakeTimers();
    const pending = s.detach();
    // Advance past the 5-second kill timer.
    await vi.advanceTimersByTimeAsync(6_000);
    await pending;
    expect(cap.proc!.killed).toBe(true);
    vi.useRealTimers();
  });

  it("does not emit 'disconnect' on deliberate detach", async () => {
    const s = new KdSession({ kdArgs: ["-k"], spawnFn: makeFakeSpawn(cap) });
    const disc: unknown[] = [];
    s.on("disconnect", (ev) => disc.push(ev));
    await s.start();
    const p = s.detach();
    await flush();
    cap.proc!.simulateExit(0);
    await p;
    expect(disc).toHaveLength(0);
  });
});

// ─── once() + stdin-destroyed paths ────────────────────────────────

describe("KdSession - forceTerminate()", () => {
  let cap: { proc: FakeChildProcess | null };
  beforeEach(() => {
    cap = { proc: null };
  });

  it("sends qd and kills synchronously", async () => {
    const s = new KdSession({ kdArgs: ["-k"], spawnFn: makeFakeSpawn(cap) });
    await s.start();
    cap.proc!.stdinLines.length = 0;

    s.forceTerminate();

    expect(cap.proc!.stdinLines).toContain("qd");
    expect(cap.proc!.killed).toBe(true);
    expect(s.state).toBe("disconnected");
  });

  it("from idle transitions to disconnected without spawning", () => {
    const spawnSpy = vi.fn(makeFakeSpawn(cap));
    const s = new KdSession({
      kdArgs: ["-k"],
      spawnFn: spawnSpy as unknown as typeof import("node:child_process").spawn,
    });

    s.forceTerminate();

    expect(spawnSpy).not.toHaveBeenCalled();
    expect(s.state).toBe("disconnected");
  });
});

describe("KdSession — typed once() + raw-line send guard", () => {
  let cap: { proc: FakeChildProcess | null };
  beforeEach(() => {
    cap = { proc: null };
  });

  it("once() fires exactly once and removes its listener", async () => {
    const s = new KdSession({ kdArgs: ["-k"], spawnFn: makeFakeSpawn(cap) });
    let calls = 0;
    s.once("break", () => {
      calls++;
    });
    await s.start();
    cap.proc!.emitStdout("*** Fatal System Error: 0xd1\n");
    await flush();
    // Second break — once() listener should NOT fire again.
    cap.proc!.emitStdout("*** Fatal System Error: 0x7e\n");
    await flush();
    expect(calls).toBe(1);
  });

  it("run() rejects when stdin is destroyed mid-session", async () => {
    const s = new KdSession({ kdArgs: ["-k"], spawnFn: makeFakeSpawn(cap) });
    await s.start();
    // Destroy stdin — simulates the subprocess having closed its
    // input side (e.g. the kd process has exited but we haven't
    // observed the 'exit' event yet).
    cap.proc!.stdin.destroy();
    await flush();
    await expect(s.run("kn")).rejects.toThrow(/kd stdin is not available/);
  });
});

// ─── Spawn error handling ───────────────────────────────────────────

describe("KdSession — spawn error paths", () => {
  it("handles a spawn `error` event", async () => {
    const cap: { proc: FakeChildProcess | null } = { proc: null };
    const s = new KdSession({ kdArgs: ["-k"], spawnFn: makeFakeSpawn(cap) });
    const disc: unknown[] = [];
    s.on("disconnect", (ev) => disc.push(ev));
    await s.start();
    cap.proc!.simulateError(new Error("ENOENT: kd not found"));
    await flush();
    expect(s.state).toBe("disconnected");
    expect(disc[0]).toMatchObject({
      type: "disconnect",
      reason: expect.stringContaining("ENOENT"),
    });
  });

  it("rejects in-flight command on spawn error", async () => {
    const cap: { proc: FakeChildProcess | null } = { proc: null };
    const s = new KdSession({ kdArgs: ["-k"], spawnFn: makeFakeSpawn(cap) });
    await s.start();
    const pending = s.run("kn");
    const expectation = expect(pending).rejects.toThrow(/boom/);
    await flush();
    cap.proc!.simulateError(new Error("boom"));
    await expectation;
  });
});

// ─── Helpers for tests ──────────────────────────────────────────────

function extractLastUuid(proc: FakeChildProcess): string {
  const last = proc.stdinLines[proc.stdinLines.length - 1];
  const match = /SIGNALMAN-([0-9a-f-]+)-END$/.exec(last);
  if (!match) throw new Error(`no sentinel in last stdin line: ${last}`);
  return match[1];
}

// ─── Teardown ──────────────────────────────────────────────────────

afterEach(() => {
  vi.useRealTimers();
});
