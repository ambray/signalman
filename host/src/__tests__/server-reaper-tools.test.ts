/**
 * v0.3.0-5 sub-task 5 — MCP envelope contract for the reaper tools.
 *
 * Mirrors the pattern in `server-cloud-tools.test.ts`: we don't
 * boot the full MCP server (existing smoke tests cover that), we
 * verify the envelope shape callers depend on. The helper mirror
 * `asCloudMcpResult` is a structural copy — a future refactor of
 * the in-server helper has to touch both, making contract drift
 * explicit instead of silent.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { CloudBackendError } from "../cloud/types.js";
import {
  CloudReaper,
  resetReaperSingletonForTests,
  getOrCreateReaper,
} from "../cloud/reaper.js";

async function asCloudMcpResultMirror<T>(
  fn: () => Promise<T>,
): Promise<{
  content: { type: "text"; text: string }[];
  isError?: boolean;
}> {
  try {
    const value = await fn();
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ ok: true, value }, null, 2),
        },
      ],
    };
  } catch (err) {
    const e = err as CloudBackendError;
    const payload = {
      ok: false,
      error: {
        code: e?.code ?? "unknown",
        message: (err as Error)?.message ?? String(err),
      },
    };
    return {
      content: [
        { type: "text" as const, text: JSON.stringify(payload, null, 2) },
      ],
      isError: true,
    };
  }
}

// ── signalman_reaper_run_once ───────────────────────────────────

describe("signalman_reaper_run_once — envelope", () => {
  beforeEach(() => resetReaperSingletonForTests());

  it("returns { ok: true, value: { startedAt, finishedAt, backends, totalTerminated } }", async () => {
    const reaper = getOrCreateReaper(
      () =>
        new CloudReaper({
          getBackends: () => [],
          now: () => new Date(1_700_000_000 * 1000),
        }),
    );
    const result = await asCloudMcpResultMirror(() => reaper.runOnce());
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text) as {
      ok: boolean;
      value: { startedAt: string; finishedAt: string; backends: unknown[]; totalTerminated: number };
    };
    expect(parsed.ok).toBe(true);
    expect(typeof parsed.value.startedAt).toBe("string");
    expect(typeof parsed.value.finishedAt).toBe("string");
    expect(Array.isArray(parsed.value.backends)).toBe(true);
    expect(parsed.value.totalTerminated).toBe(0);
  });
});

// ── signalman_reaper_status ─────────────────────────────────────

describe("signalman_reaper_status — envelope", () => {
  beforeEach(() => resetReaperSingletonForTests());

  it("returns { ok: true, value: { isRunning, lastResult: null } } before any sweep", async () => {
    const reaper = getOrCreateReaper(
      () => new CloudReaper({ getBackends: () => [] }),
    );
    const result = await asCloudMcpResultMirror(async () => ({
      isRunning: reaper.isRunning(),
      lastResult: reaper.getLastResult(),
    }));
    const parsed = JSON.parse(result.content[0].text) as {
      ok: boolean;
      value: { isRunning: boolean; lastResult: unknown };
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.value.isRunning).toBe(false);
    expect(parsed.value.lastResult).toBeNull();
  });

  it("reflects the most recent runOnce in lastResult", async () => {
    const reaper = getOrCreateReaper(
      () =>
        new CloudReaper({
          getBackends: () => [],
          now: () => new Date(1_700_000_000 * 1000),
        }),
    );
    await reaper.runOnce();
    const result = await asCloudMcpResultMirror(async () => ({
      isRunning: reaper.isRunning(),
      lastResult: reaper.getLastResult(),
    }));
    const parsed = JSON.parse(result.content[0].text) as {
      ok: boolean;
      value: { isRunning: boolean; lastResult: { totalTerminated: number } };
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.value.lastResult).not.toBeNull();
    expect(parsed.value.lastResult.totalTerminated).toBe(0);
  });
});
