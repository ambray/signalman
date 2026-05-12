/**
 * Kernel debugger (kd.exe) session wrapper.
 *
 * Spawns `kd.exe` as a child process, wires its stdio to a line-oriented
 * event stream via {@link parseLine}, brackets user commands with a
 * UUID sentinel so we can tell when each command has finished, and
 * exposes promise-based `run`, `captureStack`, `captureAnalyze`, and
 * `saveDump` methods that the orchestrator calls from scenario workflow
 * tool blocks.
 *
 * Design constraints informed by how kd actually behaves:
 *
 * - kd has no machine-readable prompt. Our only reliable
 *   command-completion signal is the UUID sentinel we append to every
 *   command (`; .echo SIGNALMAN-<uuid>-END`). The parser in
 *   `parser.ts` recognizes these sentinels; the session holds the
 *   pending-command promise open until it sees the matching one.
 *
 * - Commands can only run when the VM is broken into the debugger. If
 *   the caller sends a command while the VM is running (state="running"),
 *   kd buffers the command and executes it on the next break. We do the
 *   same — queue commands and timeout if no break comes in time.
 *
 * - Output is async and unbounded. We buffer stdout chunks, split them
 *   on line boundaries, and feed each complete line through the parser.
 *   Partial trailing lines are held across chunks.
 *
 * - The `EventEmitter` parent class provides the `break`/`module-load`/
 *   `disconnect` event stream; consumers subscribe via `session.on(...)`.
 *
 * This module deliberately does NOT expose a raw-stdin `write()` — all
 * commands go through `run()` which enforces the sentinel bracketing.
 * Otherwise we risk a command's output being mis-attributed to a prior
 * command whose sentinel hasn't arrived yet.
 */

import { EventEmitter } from "node:events";
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  parseLine,
  splitLines,
  buildCommandWithSentinel,
  type KdSignal,
} from "./parser.js";

/**
 * Session-level lifecycle state.
 *
 * - `idle`: session created, kd not yet spawned.
 * - `starting`: kd spawned, waiting for the initial debug-target connect.
 * - `running`: VM is running under kd control; no output expected until
 *   the next break.
 * - `broken`: VM is stopped at a breakpoint / bugcheck / manual break;
 *   commands may be sent.
 * - `detaching`: caller invoked `detach()`, kd being shut down cleanly.
 * - `disconnected`: kd has exited or the target is permanently gone.
 */
export type KdSessionState =
  | "idle"
  | "starting"
  | "running"
  | "broken"
  | "detaching"
  | "disconnected";

export interface KdSessionOptions {
  /** Path to kd.exe. Defaults to `kd.exe` (looked up on PATH). */
  kdExe?: string;
  /**
   * Full argument list kd is invoked with — the caller builds this so
   * transport decisions (serial/pipe vs net vs file dump) are not
   * baked into this module. Typical value:
   *
   *   ['-k', 'com:pipe,port=\\\\.\\pipe\\kd-vm,baud=115200,reconnect',
   *    '-y', symbolPath,
   *    '-logo', logPath]
   */
  kdArgs: string[];
  /**
   * Optional environment overrides (merged over `process.env`). Useful
   * for `_NT_SYMBOL_PATH` and friends.
   */
  env?: NodeJS.ProcessEnv;
  /**
   * Factory used to spawn kd. Defaults to `child_process.spawn`; tests
   * inject a mock that returns a controllable fake process. Exposed as
   * an option rather than a DI construct because each session owns its
   * own process — no reason to thread it through a container.
   */
  spawnFn?: typeof spawn;
  /**
   * Per-command default timeout in milliseconds. Overridable per
   * `run()` call. Defaults to 60 seconds — long enough for `!analyze -v`
   * with cold symbols, short enough that a truly stuck command gets
   * noticed.
   */
  defaultCommandTimeoutMs?: number;
  /**
   * Modules to break on as they load, e.g. `['my-driver.sys']`. Sent as
   * `sxe ld <module>` immediately after kd attaches.
   */
  breakOnLoad?: string[];
  /**
   * If true (default), breaks into the debugger on VM bugcheck. Maps
   * to `.bugcheckstop 1; .reload` in the startup script.
   */
  breakOnBugcheck?: boolean;
}

/**
 * An event emitted by the session. The session forwards a subset of
 * parsed signals to consumers.
 */
export type KdSessionEvent =
  | { type: "break"; reason: "bugcheck" | "break-instruction" | "module-load" | "manual"; bugcheckCode?: string; detail?: string }
  | { type: "module-load"; module: string; range?: string }
  | { type: "disconnect"; reason: string }
  | { type: "stdout-line"; line: string }
  | { type: "stderr-line"; line: string };

/**
 * Internal pending-command record. Lives from `run()` invocation until
 * the matching sentinel is seen on stdout (or the timeout fires).
 */
interface PendingCommand {
  readonly uuid: string;
  /** Output lines collected after we sent the command, before the sentinel. */
  readonly outputLines: string[];
  readonly resolve: (output: string) => void;
  readonly reject: (err: Error) => void;
  /** Timeout handle so we can clear it if the command completes normally. */
  timer: ReturnType<typeof setTimeout> | null;
}

/**
 * Thrown when `run()` times out waiting for its command sentinel.
 */
export class KdCommandTimeoutError extends Error {
  constructor(
    public readonly command: string,
    public readonly timeoutMs: number,
    public readonly partialOutput: string,
  ) {
    super(
      `kd command timed out after ${timeoutMs}ms: ${command.slice(0, 80)}`,
    );
    this.name = "KdCommandTimeoutError";
  }
}

/**
 * Thrown when a command is attempted before the session has started,
 * or after the session has disconnected.
 */
export class KdSessionStateError extends Error {
  constructor(
    public readonly state: KdSessionState,
    public readonly operation: string,
  ) {
    super(`Cannot ${operation} while session is in state '${state}'`);
    this.name = "KdSessionStateError";
  }
}

/**
 * Events emitted on the EventEmitter interface. Typed separately so
 * callers using `on`/`once` get autocomplete. The payload is always a
 * single {@link KdSessionEvent}-like object, narrowed to the specific
 * variant for the event name.
 */
export interface KdSessionEventMap {
  break: [Extract<KdSessionEvent, { type: "break" }>];
  "module-load": [Extract<KdSessionEvent, { type: "module-load" }>];
  disconnect: [Extract<KdSessionEvent, { type: "disconnect" }>];
  "stdout-line": [Extract<KdSessionEvent, { type: "stdout-line" }>];
  "stderr-line": [Extract<KdSessionEvent, { type: "stderr-line" }>];
}

/**
 * Default command timeout (60 seconds). Exposed as a constant so tests
 * and callers can share the same value without hard-coding it.
 */
export const DEFAULT_COMMAND_TIMEOUT_MS = 60_000;

/**
 * Kernel debug session. See the module docstring for design notes.
 *
 * Typical usage:
 *
 *     const session = new KdSession({
 *       kdArgs: ['-k', 'com:pipe,port=\\\\.\\pipe\\kd-vm,baud=115200,reconnect'],
 *       breakOnLoad: ['my-driver.sys'],
 *     });
 *     session.on('break', (ev) => console.log('broke:', ev));
 *     await session.start();
 *     // ... VM runs until a break ...
 *     const stack = await session.captureStack();
 *     await session.resume();
 *     await session.detach();
 */
export class KdSession extends EventEmitter {
  private readonly opts: Required<
    Omit<KdSessionOptions, "env" | "breakOnLoad" | "breakOnBugcheck">
  > & {
    env: NodeJS.ProcessEnv | undefined;
    breakOnLoad: string[];
    breakOnBugcheck: boolean;
  };

  private proc: ChildProcess | null = null;
  private _state: KdSessionState = "idle";

  /** Tail of stdout that doesn't end on a line boundary yet. */
  private stdoutResidual = "";
  private stderrResidual = "";

  private pending: PendingCommand | null = null;

  constructor(opts: KdSessionOptions) {
    super();
    this.opts = {
      kdExe: opts.kdExe ?? "kd.exe",
      kdArgs: opts.kdArgs,
      env: opts.env,
      spawnFn: opts.spawnFn ?? spawn,
      defaultCommandTimeoutMs:
        opts.defaultCommandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
      breakOnLoad: opts.breakOnLoad ?? [],
      breakOnBugcheck: opts.breakOnBugcheck ?? true,
    };
  }

  /** Lifecycle state. Read-only. */
  get state(): KdSessionState {
    return this._state;
  }

  /**
   * Spawn `kd.exe` and wire up I/O. Resolves once the child process is
   * spawned and stdio streams are attached. Does NOT wait for the VM to
   * reach a breakable state — callers that need to know when the target
   * has connected should listen for the first `break` event.
   */
  async start(): Promise<void> {
    if (this._state !== "idle") {
      throw new KdSessionStateError(this._state, "start");
    }
    this._state = "starting";

    const spawnOptions: SpawnOptions = {
      stdio: ["pipe", "pipe", "pipe"],
      env: this.opts.env ? { ...process.env, ...this.opts.env } : process.env,
      windowsHide: true,
    };
    this.proc = this.opts.spawnFn(
      this.opts.kdExe,
      this.opts.kdArgs,
      spawnOptions,
    );

    if (!this.proc.stdout || !this.proc.stderr || !this.proc.stdin) {
      throw new Error("kd.exe child process did not expose stdio streams");
    }

    this.proc.stdout.on("data", (chunk: Buffer) => {
      this.handleStdoutChunk(chunk.toString("utf8"));
    });
    this.proc.stderr.on("data", (chunk: Buffer) => {
      this.handleStderrChunk(chunk.toString("utf8"));
    });
    this.proc.on("exit", (code, signal) => {
      this.handleExit(code, signal);
    });
    this.proc.on("error", (err) => {
      this.handleSpawnError(err);
    });

    // Startup script: configure break-on-load + break-on-bugcheck, then
    // resume the target so it runs until the next break. We send these
    // as fire-and-forget; no sentinel bracketing because the target may
    // not be broken-in yet.
    const startup: string[] = [];
    if (this.opts.breakOnBugcheck) {
      startup.push(".bugcheckstop 1");
    }
    for (const module of this.opts.breakOnLoad) {
      // sxe ld <module> — break on module load.
      startup.push(`sxe ld ${module}`);
    }
    // Resume execution; if the VM is already running, this is a no-op.
    startup.push("g");
    for (const line of startup) {
      this.sendRawLine(line);
    }
    this._state = "running";
  }

  /**
   * Run a single kd command and return everything kd wrote to stdout
   * between the command and its sentinel.
   *
   * Only one command can be in flight at a time. Callers that need
   * parallel work should issue commands sequentially with `await`, or
   * use the compound form `kn; r; !thread` in a single command.
   *
   * Note: kd only executes commands when the VM is broken-in. If you
   * call `run()` while the VM is running, kd will queue the command
   * internally and execute it on the next break — your promise resolves
   * (or times out) at that point.
   */
  async run(userCommand: string, timeoutMs?: number): Promise<string> {
    if (this._state === "idle") {
      throw new KdSessionStateError(this._state, "run command");
    }
    if (this._state === "disconnected" || this._state === "detaching") {
      throw new KdSessionStateError(this._state, "run command");
    }
    if (this.pending) {
      throw new Error(
        "Another command is in flight; await the previous run() first",
      );
    }
    if (!this.proc?.stdin) {
      throw new Error("kd child process has no stdin");
    }

    const uuid = randomUUID();
    const { fullCommand } = buildCommandWithSentinel(userCommand, uuid);
    const effectiveTimeout = timeoutMs ?? this.opts.defaultCommandTimeoutMs;

    return new Promise<string>((resolve, reject) => {
      const pending: PendingCommand = {
        uuid,
        outputLines: [],
        resolve,
        reject,
        timer: null,
      };
      pending.timer = setTimeout(() => {
        // On timeout, clear the pending command and reject. The output
        // that did arrive is included so the caller can still diagnose
        // partial progress.
        if (this.pending === pending) {
          this.pending = null;
          reject(
            new KdCommandTimeoutError(
              userCommand,
              effectiveTimeout,
              pending.outputLines.join("\n"),
            ),
          );
        }
      }, effectiveTimeout);
      this.pending = pending;
      this.sendRawLine(fullCommand);
    });
  }

  /** Convenience: `kn` (top-of-stack for the current thread). */
  captureStack(timeoutMs?: number): Promise<string> {
    return this.run("kn", timeoutMs);
  }

  /** Convenience: `~*kn` (top-of-stack for all threads). */
  captureAllStacks(timeoutMs?: number): Promise<string> {
    return this.run("~*kn", timeoutMs);
  }

  /**
   * Convenience: `!analyze -v`. Note that this can take minutes on cold
   * symbol caches; pass a larger `timeoutMs` if needed.
   */
  captureAnalyze(timeoutMs?: number): Promise<string> {
    return this.run("!analyze -v", timeoutMs);
  }

  /**
   * Save a full crash dump to `path` (from kd's perspective — the path
   * is a guest path, not a host path). Typical caller on the Windows
   * host side passes a path on the SMB dump share mounted as `Z:\` in
   * the VM, so the dump lands in host-visible storage.
   */
  async saveDump(path: string, timeoutMs?: number): Promise<void> {
    // `.dump /f` writes a full kernel dump. Escape the path naively —
    // kd doesn't have a shell, so embedded spaces are safe inside
    // double quotes.
    await this.run(`.dump /f "${path.replace(/"/g, '\\"')}"`, timeoutMs);
  }

  /**
   * Resume execution (send `g`). Does not wait for the next break; that
   * is delivered asynchronously via the `break` event.
   */
  resume(): void {
    if (this._state === "disconnected" || this._state === "detaching") {
      throw new KdSessionStateError(this._state, "resume");
    }
    this.sendRawLine("g");
  }

  /**
   * Cleanly shut down kd. Sends `qd` (quit and detach) and waits for
   * the process to exit. Safe to call multiple times; subsequent calls
   * return immediately.
   */
  async detach(): Promise<void> {
    if (this._state === "disconnected") return;
    if (this._state === "detaching") return;
    if (this._state === "idle") {
      this._state = "disconnected";
      return;
    }
    this._state = "detaching";

    const proc = this.proc;
    if (!proc) {
      this._state = "disconnected";
      return;
    }

    // qd = quit and detach (leave target running). We don't wait for
    // a sentinel here because kd is exiting — it won't echo back.
    try {
      this.sendRawLine("qd");
    } catch {
      // If stdin is already closed, fall through to kill.
    }

    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try {
          proc.kill();
        } catch {
          // Process may already be dead.
        }
        resolve();
      }, 5_000);
      proc.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  // ─── Internal: stdout/stderr wiring ────────────────────────────────

  /**
   * Synchronous emergency shutdown for process-exit paths.
   *
   * Node's `exit` event cannot wait for async work, so callers that are
   * already shutting down use this best-effort path instead of `detach()`.
   * It sends `qd` when stdin is still writable, then kills the child
   * immediately. Normal scenario teardown should still call `detach()`.
   */
  forceTerminate(): void {
    if (this._state === "disconnected") return;
    if (this._state === "idle") {
      this._state = "disconnected";
      return;
    }
    this._state = "detaching";

    const proc = this.proc;
    if (!proc) {
      this._state = "disconnected";
      return;
    }

    try {
      this.sendRawLine("qd");
    } catch {
      // stdin may already be closed during process teardown.
    }
    try {
      proc.kill();
    } catch {
      // Process may already be dead.
    }
  }

  private handleStdoutChunk(chunk: string): void {
    const { complete, residual } = splitLines(chunk, this.stdoutResidual);
    this.stdoutResidual = residual;
    for (const line of complete) {
      this.emitTyped("stdout-line", { type: "stdout-line", line });
      this.handleParsedSignal(line, parseLine(line));
    }
  }

  private handleStderrChunk(chunk: string): void {
    const { complete, residual } = splitLines(chunk, this.stderrResidual);
    this.stderrResidual = residual;
    for (const line of complete) {
      this.emitTyped("stderr-line", { type: "stderr-line", line });
    }
  }

  private handleParsedSignal(line: string, signal: KdSignal): void {
    switch (signal.kind) {
      case "command-sentinel": {
        const current = this.pending;
        if (current && current.uuid === signal.uuid) {
          // Command completed.
          if (current.timer) {
            clearTimeout(current.timer);
          }
          this.pending = null;
          current.resolve(current.outputLines.join("\n"));
        }
        // Sentinel from a stale/unknown uuid: silently drop. This can
        // happen if a previous command timed out and its sentinel
        // arrives late; we've already moved on.
        return;
      }
      case "bugcheck": {
        this._state = "broken";
        this.emitTyped("break", {
          type: "break",
          reason: "bugcheck",
          bugcheckCode: signal.code,
        });
        return;
      }
      case "break-instruction": {
        this._state = "broken";
        this.emitTyped("break", {
          type: "break",
          reason: "break-instruction",
          detail: signal.detail,
        });
        return;
      }
      case "module-load": {
        this.emitTyped("module-load", {
          type: "module-load",
          module: signal.module,
          range: signal.range,
        });
        // If this module was on our break-on-load list, the VM will
        // break automatically; we don't need to mark broken ourselves
        // (a separate `break-instruction` line comes next).
        return;
      }
      case "disconnect": {
        this._state = "disconnected";
        this.emitTyped("disconnect", {
          type: "disconnect",
          reason: signal.reason,
        });
        if (this.pending) {
          const { reject, timer } = this.pending;
          if (timer) clearTimeout(timer);
          this.pending = null;
          reject(new Error(`Disconnected: ${signal.reason}`));
        }
        return;
      }
      case "none": {
        // If we're in the middle of a command, accumulate the line.
        // Otherwise it's ambient output (kd chatter, symbol loader
        // progress, etc.) — already forwarded via `stdout-line`.
        if (this.pending) {
          this.pending.outputLines.push(line);
        }
        return;
      }
    }
  }

  private handleExit(
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    const prev = this._state;
    this._state = "disconnected";
    this.proc = null;
    // Flush any pending command.
    if (this.pending) {
      const { reject, timer } = this.pending;
      if (timer) clearTimeout(timer);
      const detail = signal ? `signal=${signal}` : `code=${code}`;
      reject(new Error(`kd exited before sentinel (${detail})`));
      this.pending = null;
    }
    // Only emit disconnect if we weren't deliberately detaching.
    if (prev !== "detaching") {
      this.emitTyped("disconnect", {
        type: "disconnect",
        reason: signal ? `exit signal ${signal}` : `exit code ${code}`,
      });
    }
  }

  private handleSpawnError(err: Error): void {
    this._state = "disconnected";
    this.emitTyped("disconnect", {
      type: "disconnect",
      reason: `spawn error: ${err.message}`,
    });
    if (this.pending) {
      const { reject, timer } = this.pending;
      if (timer) clearTimeout(timer);
      reject(err);
      this.pending = null;
    }
  }

  /**
   * Write a raw line to kd's stdin. Appends `\n`. Throws if stdin is
   * unavailable.
   */
  private sendRawLine(line: string): void {
    if (!this.proc?.stdin || this.proc.stdin.destroyed) {
      throw new Error("kd stdin is not available");
    }
    this.proc.stdin.write(`${line}\n`);
  }

  /** Type-safe event emitter helper. */
  private emitTyped<K extends keyof KdSessionEventMap>(
    event: K,
    payload: KdSessionEventMap[K][0],
  ): void {
    this.emit(event, payload);
  }

  // Augment the EventEmitter signatures for type-safe on/once.
  on<K extends keyof KdSessionEventMap>(
    event: K,
    listener: (...args: KdSessionEventMap[K]) => void,
  ): this;
  on(event: string, listener: (...args: unknown[]) => void): this;
  on(event: string, listener: (...args: unknown[]) => void): this {
    return super.on(event, listener);
  }

  once<K extends keyof KdSessionEventMap>(
    event: K,
    listener: (...args: KdSessionEventMap[K]) => void,
  ): this;
  once(event: string, listener: (...args: unknown[]) => void): this;
  once(event: string, listener: (...args: unknown[]) => void): this {
    return super.once(event, listener);
  }
}
