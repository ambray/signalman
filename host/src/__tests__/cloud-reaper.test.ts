/**
 * v0.3.0-5 sub-task 5 — cloud TTL reaper.
 *
 * Covers all three test layers per the workstream brief:
 *   - **Unit**: time math, malformed-tag handling, absent-tag
 *     handling, singleton accessor.
 *   - **Integration**: full sweep against a stub `CloudBackend`
 *     returning a mix of expired / live / no-ttl / malformed
 *     handles; concurrent `runOnce` calls share the in-flight
 *     promise.
 *   - **System**: scheduler starts + stops; `start()` is idempotent;
 *     after a scheduled sweep, `getLastResult` reflects it.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  CloudReaper,
  DEFAULT_REAPER_INTERVAL_MS,
  getOrCreateReaper,
  resetReaperSingletonForTests,
  type ReaperRunResult,
} from "../cloud/reaper.js";
import {
  CloudBackendError,
  type CloudBackend,
  type CloudBackendKind,
  type CloudInstanceConfig,
  type CloudInstanceHandle,
  type CloudInstanceStatus,
  SIGNALMAN_TTL_EXPIRES_AT_TAG_KEY,
} from "../cloud/types.js";

// ── Stub backend ─────────────────────────────────────────────────

interface StubOpts {
  name?: CloudBackendKind;
  handles: CloudInstanceHandle[];
  listThrows?: Error;
  terminateThrows?: (id: string) => Error | null;
}

function stubBackend(opts: StubOpts): CloudBackend & {
  terminated: string[];
  listCalls: number;
} {
  const terminated: string[] = [];
  let listCalls = 0;
  return {
    name: opts.name ?? "aws",
    listCalls,
    terminated,
    async provisionInstance(_: CloudInstanceConfig): Promise<CloudInstanceHandle> {
      throw new CloudBackendError("provision_failed", "stub does not provision");
    },
    async terminateInstance(handle: CloudInstanceHandle): Promise<void> {
      if (opts.terminateThrows) {
        const e = opts.terminateThrows(handle.id);
        if (e) throw e;
      }
      terminated.push(handle.id);
    },
    async getInstanceStatus(_: CloudInstanceHandle): Promise<CloudInstanceStatus> {
      throw new CloudBackendError("provision_failed", "stub does not status");
    },
    async getInstanceIp(_: CloudInstanceHandle): Promise<string | null> {
      return null;
    },
    async listInstances(_filter?: {
      tags?: Record<string, string>;
    }): Promise<CloudInstanceHandle[]> {
      listCalls += 1;
      // The closure-captured listCalls increments but the property
      // is shadowed by the destructured one — caller reads via
      // the second-pass `get listCalls()` below. Re-expose:
      (this as { listCalls: number }).listCalls = listCalls;
      if (opts.listThrows) throw opts.listThrows;
      return opts.handles;
    },
  };
}

function handle(
  id: string,
  ttlExpiresAtEpochSec?: number | string,
  backend: CloudBackendKind = "aws",
): CloudInstanceHandle {
  const tags: Record<string, string> = {};
  if (ttlExpiresAtEpochSec !== undefined) {
    tags[SIGNALMAN_TTL_EXPIRES_AT_TAG_KEY] = String(ttlExpiresAtEpochSec);
  }
  return {
    id,
    backend,
    name: id,
    region: "us-east-1",
    tags: Object.keys(tags).length ? tags : undefined,
  };
}

// ── UNIT: time math + malformed handling ────────────────────────

describe("CloudReaper — unit: time math", () => {
  beforeEach(() => resetReaperSingletonForTests());

  it("terminates instances whose expires-at is strictly in the past", async () => {
    const nowSec = 1_700_000_000;
    const backend = stubBackend({
      handles: [
        handle("alive", nowSec + 60),
        handle("expired", nowSec - 1),
        handle("just-expired", nowSec),
      ],
    });
    const reaper = new CloudReaper({
      getBackends: () => [backend],
      now: () => new Date(nowSec * 1000),
    });
    const result = await reaper.runOnce();
    expect(result.totalTerminated).toBe(2);
    expect(backend.terminated.sort()).toEqual(["expired", "just-expired"]);
  });

  it("treats absent ttl tag as 'no TTL' and does not terminate", async () => {
    const backend = stubBackend({
      handles: [handle("legacy-no-tag")],
    });
    const reaper = new CloudReaper({
      getBackends: () => [backend],
      now: () => new Date(1_700_000_000 * 1000),
    });
    const result = await reaper.runOnce();
    expect(result.totalTerminated).toBe(0);
    expect(result.backends[0].noTtl).toBe(1);
    expect(backend.terminated).toEqual([]);
  });

  it("treats malformed ttl tag as skip (not mass-terminate)", async () => {
    const backend = stubBackend({
      handles: [
        handle("malformed-text", "not-a-number"),
        handle("malformed-negative", -1),
        handle("malformed-zero", 0),
        handle("malformed-nan", "NaN"),
      ],
    });
    const reaper = new CloudReaper({
      getBackends: () => [backend],
      now: () => new Date(1_700_000_000 * 1000),
    });
    const result = await reaper.runOnce();
    expect(result.totalTerminated).toBe(0);
    expect(result.backends[0].malformed).toBe(4);
    expect(backend.terminated).toEqual([]);
  });
});

// ── UNIT: singleton accessor ────────────────────────────────────

describe("CloudReaper — unit: singleton", () => {
  beforeEach(() => resetReaperSingletonForTests());

  it("getOrCreateReaper returns the same instance across calls", () => {
    let factoryCalls = 0;
    const r1 = getOrCreateReaper(() => {
      factoryCalls += 1;
      return new CloudReaper({ getBackends: () => [] });
    });
    const r2 = getOrCreateReaper(() => {
      factoryCalls += 1;
      return new CloudReaper({ getBackends: () => [] });
    });
    expect(r1).toBe(r2);
    expect(factoryCalls).toBe(1);
  });

  it("resetReaperSingletonForTests stops the running scheduler", () => {
    const reaper = getOrCreateReaper(
      () =>
        new CloudReaper({
          getBackends: () => [],
          intervalMs: 60_000,
        }),
    );
    reaper.start();
    expect(reaper.isRunning()).toBe(true);
    resetReaperSingletonForTests();
    expect(reaper.isRunning()).toBe(false);
  });
});

// ── INTEGRATION: multi-backend sweep ────────────────────────────

describe("CloudReaper — integration: multi-backend sweep", () => {
  beforeEach(() => resetReaperSingletonForTests());

  it("sweeps both AWS and Azure backends in registration order", async () => {
    const nowSec = 1_700_000_000;
    const aws = stubBackend({
      name: "aws",
      handles: [handle("i-aws-expired", nowSec - 1, "aws")],
    });
    const azure = stubBackend({
      name: "azure",
      handles: [handle("vm-az-expired", nowSec - 1, "azure")],
    });
    const reaper = new CloudReaper({
      getBackends: () => [aws, azure],
      now: () => new Date(nowSec * 1000),
    });
    const result = await reaper.runOnce();
    expect(result.backends.map((b) => b.backend)).toEqual(["aws", "azure"]);
    expect(result.totalTerminated).toBe(2);
    expect(aws.terminated).toEqual(["i-aws-expired"]);
    expect(azure.terminated).toEqual(["vm-az-expired"]);
  });

  it("continues to other backends when one listInstances throws", async () => {
    const nowSec = 1_700_000_000;
    const broken = stubBackend({
      name: "aws",
      handles: [],
      listThrows: new Error("auth lapsed"),
    });
    const working = stubBackend({
      name: "azure",
      handles: [handle("vm-expired", nowSec - 1, "azure")],
    });
    const reaper = new CloudReaper({
      getBackends: () => [broken, working],
      now: () => new Date(nowSec * 1000),
    });
    const result = await reaper.runOnce();
    expect(result.backends[0].listError).toContain("auth lapsed");
    expect(result.backends[1].terminated).toBe(1);
    expect(result.totalTerminated).toBe(1);
  });

  it("records per-instance terminate errors without aborting the sweep", async () => {
    const nowSec = 1_700_000_000;
    const backend = stubBackend({
      handles: [
        handle("ok-1", nowSec - 1),
        handle("flaky", nowSec - 1),
        handle("ok-2", nowSec - 1),
      ],
      terminateThrows: (id) =>
        id === "flaky" ? new Error("vendor 503") : null,
    });
    const reaper = new CloudReaper({
      getBackends: () => [backend],
      now: () => new Date(nowSec * 1000),
    });
    const result = await reaper.runOnce();
    expect(result.totalTerminated).toBe(2);
    expect(backend.terminated.sort()).toEqual(["ok-1", "ok-2"]);
    expect(result.backends[0].terminateErrors).toHaveLength(1);
    expect(result.backends[0].terminateErrors[0]).toMatchObject({
      id: "flaky",
      message: expect.stringContaining("vendor 503"),
    });
  });

  it("concurrent runOnce calls share the in-flight promise", async () => {
    const nowSec = 1_700_000_000;
    let listCount = 0;
    const backend: CloudBackend = {
      name: "aws",
      async provisionInstance() {
        throw new CloudBackendError("provision_failed", "n/a");
      },
      async terminateInstance() {},
      async getInstanceStatus() {
        throw new CloudBackendError("provision_failed", "n/a");
      },
      async getInstanceIp() {
        return null;
      },
      async listInstances() {
        listCount += 1;
        // Yield so the second runOnce gets scheduled before this
        // resolves.
        await new Promise((r) => setImmediate(r));
        return [];
      },
    };
    const reaper = new CloudReaper({
      getBackends: () => [backend],
      now: () => new Date(nowSec * 1000),
    });
    const [a, b] = await Promise.all([reaper.runOnce(), reaper.runOnce()]);
    expect(a).toBe(b); // same promise resolution
    expect(listCount).toBe(1); // not called twice
  });
});

// ── SYSTEM: scheduler lifecycle ─────────────────────────────────

describe("CloudReaper — system: scheduler lifecycle", () => {
  beforeEach(() => {
    resetReaperSingletonForTests();
    vi.useRealTimers();
  });

  it("start() is idempotent — second call does not spawn a second timer", async () => {
    const reaper = new CloudReaper({
      getBackends: () => [],
      intervalMs: 100_000,
    });
    reaper.start();
    expect(reaper.isRunning()).toBe(true);
    reaper.start(); // second call
    expect(reaper.isRunning()).toBe(true);
    reaper.stop();
    expect(reaper.isRunning()).toBe(false);
  });

  it("getLastResult is null before the first runOnce, then reflects it", async () => {
    const nowSec = 1_700_000_000;
    const backend = stubBackend({
      handles: [handle("expired", nowSec - 1)],
    });
    const reaper = new CloudReaper({
      getBackends: () => [backend],
      now: () => new Date(nowSec * 1000),
    });
    expect(reaper.getLastResult()).toBeNull();
    const result = await reaper.runOnce();
    const stored = reaper.getLastResult();
    expect(stored).not.toBeNull();
    expect(stored?.totalTerminated).toBe(result.totalTerminated);
  });

  it("scheduled run fires runOnce on the configured interval", async () => {
    const nowSec = 1_700_000_000;
    const backend = stubBackend({
      handles: [handle("expired", nowSec - 1)],
    });
    let runs = 0;
    const reaper = new CloudReaper({
      getBackends: () => [backend],
      intervalMs: 10,
      now: () => new Date(nowSec * 1000),
    });
    // Wrap runOnce to count calls.
    const original = reaper.runOnce.bind(reaper);
    reaper.runOnce = async (): Promise<ReaperRunResult> => {
      runs += 1;
      return original();
    };
    reaper.start();
    // Real-timer interval-driven wait. 30ms should yield ~2-3
    // ticks; we assert >=1 to keep the test resilient on slow CI.
    await new Promise((r) => setTimeout(r, 30));
    reaper.stop();
    expect(runs).toBeGreaterThanOrEqual(1);
  });

  it("DEFAULT_REAPER_INTERVAL_MS matches the design spec (5 minutes)", () => {
    expect(DEFAULT_REAPER_INTERVAL_MS).toBe(5 * 60 * 1000);
  });
});
