/**
 * v0.3.0-2 / C8 — runCopyWithProgress tests.
 *
 * Pure module. Tests inject fake `statSize`, `setInterval`,
 * `clearInterval`, and `runCopy` so nothing real (filesystem,
 * timers, PowerShell) is touched.
 *
 * The contract being tested:
 *
 *   1. Start event fires once with `(0, totalBytes)`.
 *   2. Heartbeats fire only for files at or above the threshold,
 *      every `heartbeatIntervalMs`, with `bytesTransferred` set to
 *      the sentinel `-1`.
 *   3. Complete event fires on success with `(totalBytes, totalBytes)`.
 *   4. No complete event fires on failure; heartbeat timer is always
 *      cleared (success or failure).
 *   5. A throwing progress consumer doesn't take down the copy.
 *   6. Input validation surfaces `non_absolute_path` / `source_missing`.
 */

import { describe, it, expect, vi } from "vitest";

import {
  runCopyWithProgress,
  CopyFileProgressError,
  HEARTBEAT_SENTINEL_BYTES,
  HEARTBEAT_SIZE_THRESHOLD_BYTES,
  HEARTBEAT_INTERVAL_MS,
} from "../provisioning/copy-file-progress.js";

// ── Test helpers ──────────────────────────────────────────────────

/**
 * Controllable interval scheduler. `tick()` fires the registered
 * callback once; the test decides when (no real time elapses).
 */
function makeFakeTimer() {
  const fns: Array<() => void> = [];
  let lastHandle = 0;
  return {
    setInterval(fn: () => void, _ms: number): unknown {
      fns.push(fn);
      return ++lastHandle;
    },
    clearInterval(_handle: unknown): void {
      // Real impl would dedupe by handle; for tests we just clear
      // all registered fns so subsequent ticks are no-ops.
      fns.length = 0;
    },
    tick(): void {
      // Fire each registered fn exactly once per tick.  Snapshot the
      // array so a heartbeat handler that schedules more work
      // doesn't poison this tick.
      const snapshot = fns.slice();
      for (const fn of snapshot) fn();
    },
    registeredCount(): number {
      return fns.length;
    },
  };
}

const ABS = process.platform === "win32" ? "C:\\src\\file.dat" : "/src/file.dat";

// ── Start + complete events ───────────────────────────────────────

describe("runCopyWithProgress — start + complete events", () => {
  it("emits start (0, total) and complete (total, total) on success", async () => {
    const progress = vi.fn();
    const totalBytes = 1024;
    const fakeTimer = makeFakeTimer();

    await runCopyWithProgress({
      hostPath: ABS,
      progress,
      statSize: () => totalBytes,
      setInterval: fakeTimer.setInterval,
      clearInterval: fakeTimer.clearInterval,
      runCopy: async () => {
        /* completes immediately */
      },
    });

    expect(progress).toHaveBeenCalledTimes(2);
    expect(progress).toHaveBeenNthCalledWith(1, 0, totalBytes);
    expect(progress).toHaveBeenNthCalledWith(2, totalBytes, totalBytes);
  });

  it("does NOT emit complete event when runCopy rejects", async () => {
    const progress = vi.fn();
    const fakeTimer = makeFakeTimer();
    const failure = new Error("Copy-VMFile failed");

    await expect(
      runCopyWithProgress({
        hostPath: ABS,
        progress,
        statSize: () => 1024,
        setInterval: fakeTimer.setInterval,
        clearInterval: fakeTimer.clearInterval,
        runCopy: async () => {
          throw failure;
        },
      }),
    ).rejects.toBe(failure);

    // Start event fired, but no complete event.
    expect(progress).toHaveBeenCalledTimes(1);
    expect(progress).toHaveBeenCalledWith(0, 1024);
  });

  it("propagates runCopy errors verbatim (no wrapping)", async () => {
    const fakeTimer = makeFakeTimer();
    const psError = new Error(
      "PowerShell command failed: Copy-VMFile : The system cannot find the path",
    );

    await expect(
      runCopyWithProgress({
        hostPath: ABS,
        statSize: () => 1024,
        setInterval: fakeTimer.setInterval,
        clearInterval: fakeTimer.clearInterval,
        runCopy: async () => {
          throw psError;
        },
      }),
    ).rejects.toBe(psError);
  });
});

// ── Heartbeat behaviour ───────────────────────────────────────────

describe("runCopyWithProgress — heartbeat machinery", () => {
  it("does NOT start a heartbeat for files below the threshold", async () => {
    const progress = vi.fn();
    const fakeTimer = makeFakeTimer();

    await runCopyWithProgress({
      hostPath: ABS,
      progress,
      statSize: () => 50 * 1024 * 1024, // 50 MB, under 100 MB threshold
      setInterval: fakeTimer.setInterval,
      clearInterval: fakeTimer.clearInterval,
      runCopy: async () => undefined,
    });

    // No heartbeat was scheduled; only start + complete fired.
    expect(progress).toHaveBeenCalledTimes(2);
    expect(progress).toHaveBeenNthCalledWith(1, 0, 50 * 1024 * 1024);
    expect(progress).toHaveBeenNthCalledWith(
      2,
      50 * 1024 * 1024,
      50 * 1024 * 1024,
    );
  });

  it("starts a heartbeat for files at or above the threshold", async () => {
    const progress = vi.fn();
    const fakeTimer = makeFakeTimer();

    // Use a slow runCopy so heartbeats can fire while it's in
    // flight. We resolve it explicitly via a deferred.
    let resolveCopy!: () => void;
    const copyPromise = new Promise<void>((resolve) => {
      resolveCopy = resolve;
    });

    const runPromise = runCopyWithProgress({
      hostPath: ABS,
      progress,
      statSize: () => HEARTBEAT_SIZE_THRESHOLD_BYTES, // exactly the threshold
      setInterval: fakeTimer.setInterval,
      clearInterval: fakeTimer.clearInterval,
      runCopy: () => copyPromise,
    });

    // Allow microtasks to run so the heartbeat is registered.
    await Promise.resolve();

    // Tick twice — should produce two heartbeat events.
    fakeTimer.tick();
    fakeTimer.tick();

    resolveCopy();
    await runPromise;

    // Expected calls in order: start, heartbeat, heartbeat, complete.
    expect(progress).toHaveBeenCalledTimes(4);
    expect(progress).toHaveBeenNthCalledWith(
      1,
      0,
      HEARTBEAT_SIZE_THRESHOLD_BYTES,
    );
    expect(progress).toHaveBeenNthCalledWith(
      2,
      HEARTBEAT_SENTINEL_BYTES,
      HEARTBEAT_SIZE_THRESHOLD_BYTES,
    );
    expect(progress).toHaveBeenNthCalledWith(
      3,
      HEARTBEAT_SENTINEL_BYTES,
      HEARTBEAT_SIZE_THRESHOLD_BYTES,
    );
    expect(progress).toHaveBeenNthCalledWith(
      4,
      HEARTBEAT_SIZE_THRESHOLD_BYTES,
      HEARTBEAT_SIZE_THRESHOLD_BYTES,
    );
  });

  it("clears the heartbeat timer on success", async () => {
    const fakeTimer = makeFakeTimer();

    await runCopyWithProgress({
      hostPath: ABS,
      progress: vi.fn(),
      statSize: () => HEARTBEAT_SIZE_THRESHOLD_BYTES,
      setInterval: fakeTimer.setInterval,
      clearInterval: fakeTimer.clearInterval,
      runCopy: async () => undefined,
    });

    // After completion, clearInterval should have removed the
    // registered fn so further ticks are no-ops.
    expect(fakeTimer.registeredCount()).toBe(0);
  });

  it("clears the heartbeat timer on failure", async () => {
    const fakeTimer = makeFakeTimer();

    await expect(
      runCopyWithProgress({
        hostPath: ABS,
        progress: vi.fn(),
        statSize: () => HEARTBEAT_SIZE_THRESHOLD_BYTES,
        setInterval: fakeTimer.setInterval,
        clearInterval: fakeTimer.clearInterval,
        runCopy: async () => {
          throw new Error("boom");
        },
      }),
    ).rejects.toThrow("boom");

    expect(fakeTimer.registeredCount()).toBe(0);
  });

  it("honors a custom heartbeat threshold", async () => {
    const progress = vi.fn();
    const fakeTimer = makeFakeTimer();

    let resolveCopy!: () => void;
    const copyPromise = new Promise<void>((resolve) => {
      resolveCopy = resolve;
    });

    const runPromise = runCopyWithProgress({
      hostPath: ABS,
      progress,
      statSize: () => 1024, // small, but...
      heartbeatThresholdBytes: 512, // ...threshold is even smaller, so heartbeat fires
      setInterval: fakeTimer.setInterval,
      clearInterval: fakeTimer.clearInterval,
      runCopy: () => copyPromise,
    });

    await Promise.resolve();
    fakeTimer.tick();
    resolveCopy();
    await runPromise;

    expect(progress).toHaveBeenCalledTimes(3);
    expect(progress).toHaveBeenNthCalledWith(2, HEARTBEAT_SENTINEL_BYTES, 1024);
  });

  it("honors a custom heartbeat interval (passes to setInterval)", async () => {
    const setIntervalSpy = vi.fn((_fn: () => void, _ms: number) => 42);
    const clearIntervalSpy = vi.fn();

    await runCopyWithProgress({
      hostPath: ABS,
      progress: vi.fn(),
      statSize: () => HEARTBEAT_SIZE_THRESHOLD_BYTES,
      setInterval: setIntervalSpy,
      clearInterval: clearIntervalSpy,
      heartbeatIntervalMs: 7_500,
      runCopy: async () => undefined,
    });

    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 7_500);
    expect(clearIntervalSpy).toHaveBeenCalledWith(42);
  });

  it("uses the default interval of HEARTBEAT_INTERVAL_MS when not overridden", async () => {
    const setIntervalSpy = vi.fn((_fn: () => void, _ms: number) => 0);

    await runCopyWithProgress({
      hostPath: ABS,
      progress: vi.fn(),
      statSize: () => HEARTBEAT_SIZE_THRESHOLD_BYTES,
      setInterval: setIntervalSpy,
      clearInterval: vi.fn(),
      runCopy: async () => undefined,
    });

    expect(setIntervalSpy).toHaveBeenCalledWith(
      expect.any(Function),
      HEARTBEAT_INTERVAL_MS,
    );
  });
});

// ── No-progress-callback bypass ───────────────────────────────────

describe("runCopyWithProgress — no progress callback", () => {
  it("skips all event emission when progress is undefined", async () => {
    const setIntervalSpy = vi.fn();
    const clearIntervalSpy = vi.fn();

    await runCopyWithProgress({
      hostPath: ABS,
      statSize: () => HEARTBEAT_SIZE_THRESHOLD_BYTES,
      setInterval: setIntervalSpy,
      clearInterval: clearIntervalSpy,
      runCopy: async () => undefined,
    });

    // No progress callback → no heartbeat timer registered either.
    expect(setIntervalSpy).not.toHaveBeenCalled();
    expect(clearIntervalSpy).not.toHaveBeenCalled();
  });
});

// ── Misbehaving progress consumer doesn't break the copy ──────────

describe("runCopyWithProgress — robustness", () => {
  it("swallows errors from the progress callback on start", async () => {
    const fakeTimer = makeFakeTimer();
    const progress = vi.fn().mockImplementation(() => {
      throw new Error("consumer is broken");
    });

    await expect(
      runCopyWithProgress({
        hostPath: ABS,
        progress,
        statSize: () => 1024,
        setInterval: fakeTimer.setInterval,
        clearInterval: fakeTimer.clearInterval,
        runCopy: async () => undefined,
      }),
    ).resolves.toBeUndefined();

    // Both start and complete invocations attempted; both threw,
    // both were swallowed.
    expect(progress).toHaveBeenCalledTimes(2);
  });

  it("swallows errors from heartbeat callback invocations", async () => {
    const fakeTimer = makeFakeTimer();
    const progress = vi.fn().mockImplementation((bytes: number) => {
      // Throw only on the heartbeat sentinel; let start + complete
      // pass through cleanly.
      if (bytes === HEARTBEAT_SENTINEL_BYTES) {
        throw new Error("heartbeat consumer is broken");
      }
    });

    let resolveCopy!: () => void;
    const copyPromise = new Promise<void>((resolve) => {
      resolveCopy = resolve;
    });

    const runPromise = runCopyWithProgress({
      hostPath: ABS,
      progress,
      statSize: () => HEARTBEAT_SIZE_THRESHOLD_BYTES,
      setInterval: fakeTimer.setInterval,
      clearInterval: fakeTimer.clearInterval,
      runCopy: () => copyPromise,
    });

    await Promise.resolve();
    fakeTimer.tick(); // heartbeat throws — wrapper swallows
    fakeTimer.tick(); // another one
    resolveCopy();
    await runPromise;

    // Start (1), 2 heartbeats (2,3), complete (4). All four fire.
    expect(progress).toHaveBeenCalledTimes(4);
  });
});

// ── Validation ────────────────────────────────────────────────────

describe("runCopyWithProgress — validation", () => {
  it("rejects empty hostPath with non_absolute_path", async () => {
    await expect(
      runCopyWithProgress({
        hostPath: "",
        runCopy: async () => undefined,
      }),
    ).rejects.toMatchObject({
      name: "CopyFileProgressError",
      code: "non_absolute_path",
    });
  });

  it("rejects a relative hostPath with non_absolute_path", async () => {
    await expect(
      runCopyWithProgress({
        hostPath: "relative/file.txt",
        runCopy: async () => undefined,
      }),
    ).rejects.toMatchObject({
      name: "CopyFileProgressError",
      code: "non_absolute_path",
    });
  });

  it("accepts a Windows absolute path", async () => {
    await expect(
      runCopyWithProgress({
        hostPath: "C:\\temp\\file.dat",
        statSize: () => 100,
        runCopy: async () => undefined,
      }),
    ).resolves.toBeUndefined();
  });

  it("accepts a UNC absolute path", async () => {
    await expect(
      runCopyWithProgress({
        hostPath: "\\\\server\\share\\file.dat",
        statSize: () => 100,
        runCopy: async () => undefined,
      }),
    ).resolves.toBeUndefined();
  });

  it("accepts a POSIX absolute path", async () => {
    await expect(
      runCopyWithProgress({
        hostPath: "/tmp/file.dat",
        statSize: () => 100,
        runCopy: async () => undefined,
      }),
    ).resolves.toBeUndefined();
  });

  it("surfaces stat failure as source_missing", async () => {
    await expect(
      runCopyWithProgress({
        hostPath: ABS,
        statSize: () => {
          throw new Error("ENOENT");
        },
        runCopy: async () => undefined,
      }),
    ).rejects.toMatchObject({
      name: "CopyFileProgressError",
      code: "source_missing",
    });
  });
});

// ── Error type ergonomics ─────────────────────────────────────────

describe("CopyFileProgressError", () => {
  it("is an Error subclass", () => {
    const e = new CopyFileProgressError("non_absolute_path", "test");
    expect(e).toBeInstanceOf(Error);
    expect(e).toBeInstanceOf(CopyFileProgressError);
  });

  it("carries a stable code field", () => {
    const e = new CopyFileProgressError("source_missing", "test");
    expect(e.code).toBe("source_missing");
  });

  it("name is CopyFileProgressError so stack traces and switch-on-name work", () => {
    const e = new CopyFileProgressError("non_absolute_path", "test");
    expect(e.name).toBe("CopyFileProgressError");
  });
});
