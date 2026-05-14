/**
 * v0.3.0-5 sub-task 5 — CLI surface tests for `signalman cloud reaper`.
 *
 * System-layer coverage of the CLI verb wiring: parses argv,
 * dispatches to cmdCloudReaper, captures stdout, asserts the
 * structured output the operator (or a wrapping script) sees.
 *
 * The reaper itself uses the same `getOrCreateReaper` singleton
 * the MCP tools use, so a CLI run + an MCP status call see the
 * same state in a single host process. Tests reset the singleton
 * between cases to keep them independent.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { cmdCloudReaper, type ParsedArgs } from "../cli.js";
import {
  CloudReaper,
  getOrCreateReaper,
  resetReaperSingletonForTests,
} from "../cloud/reaper.js";
import {
  registerCloudBackend,
  resetRegistryForTests,
} from "../cloud/registry.js";
import {
  CloudBackendError,
  SIGNALMAN_TTL_EXPIRES_AT_TAG_KEY,
  type CloudBackend,
  type CloudInstanceConfig,
  type CloudInstanceHandle,
  type CloudInstanceStatus,
} from "../cloud/types.js";

function argsFor(positional: string[], flags: Record<string, string> = {}): ParsedArgs {
  return {
    positional: [...positional],
    flags: new Set<string>(),
    options: new Map<string, string>(Object.entries(flags)),
    params: {},
  };
}

function captureStdout(): { restore: () => void; read: () => string } {
  const original = process.stdout.write.bind(process.stdout);
  let buf = "";
  // Cast because TS overload resolution gets noisy with our shim.
  (process.stdout as { write: (chunk: string | Uint8Array) => boolean }).write = (
    chunk: string | Uint8Array,
  ): boolean => {
    buf += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
    return true;
  };
  return {
    restore: () => {
      (process.stdout as { write: typeof original }).write = original;
    },
    read: () => buf,
  };
}

function stubBackend(handles: CloudInstanceHandle[]): CloudBackend {
  const terminated: string[] = [];
  return {
    name: "aws",
    async provisionInstance(_: CloudInstanceConfig): Promise<CloudInstanceHandle> {
      throw new CloudBackendError("provision_failed", "stub");
    },
    async terminateInstance(handle: CloudInstanceHandle): Promise<void> {
      terminated.push(handle.id);
    },
    async getInstanceStatus(_: CloudInstanceHandle): Promise<CloudInstanceStatus> {
      throw new CloudBackendError("provision_failed", "stub");
    },
    async getInstanceIp(_: CloudInstanceHandle): Promise<string | null> {
      return null;
    },
    async listInstances(): Promise<CloudInstanceHandle[]> {
      return handles;
    },
  };
}

describe("signalman cloud reaper — CLI surface", () => {
  beforeEach(() => {
    resetRegistryForTests();
    resetReaperSingletonForTests();
  });

  afterEach(() => {
    resetReaperSingletonForTests();
  });

  it("`reaper run` with an empty-listing backend prints zero-terminated summary + returns 0", async () => {
    // Pre-register a stub backend so the CLI's lazy aws/azure
    // imports are skipped (it only imports when the registry is
    // empty). The stub's listInstances returns nothing.
    const backend = stubBackend([]);
    registerCloudBackend("aws", () => backend);
    getOrCreateReaper(
      () => new CloudReaper({ getBackends: () => [backend] }),
    );

    const capture = captureStdout();
    try {
      const exit = await cmdCloudReaper(argsFor(["run"]));
      expect(exit).toBe(0);
      const out = capture.read();
      expect(out).toMatch(/Reaper sweep complete/);
      expect(out).toMatch(/terminated: 0/);
    } finally {
      capture.restore();
    }
  });

  it("`reaper run --format=json` emits parseable JSON", async () => {
    const backend = stubBackend([]);
    registerCloudBackend("aws", () => backend);
    getOrCreateReaper(
      () => new CloudReaper({ getBackends: () => [backend] }),
    );

    const capture = captureStdout();
    try {
      const exit = await cmdCloudReaper(argsFor(["run"], { format: "json" }));
      expect(exit).toBe(0);
      const out = capture.read();
      const parsed = JSON.parse(out) as { totalTerminated: number; backends: unknown[] };
      expect(parsed.totalTerminated).toBe(0);
      expect(Array.isArray(parsed.backends)).toBe(true);
    } finally {
      capture.restore();
    }
  });

  it("`reaper run` reports terminate of past-TTL instances", async () => {
    // Pre-register a stub AWS backend so the dynamic import of
    // aws.js sees an existing factory (force: true) and doesn't
    // overwrite it. We pre-populate the reaper singleton instead
    // of relying on the lazy CLI dynamic-import path.
    const nowSec = 1_700_000_000;
    const backend = stubBackend([
      {
        id: "i-expired",
        backend: "aws",
        name: "test",
        region: "us-east-1",
        tags: { [SIGNALMAN_TTL_EXPIRES_AT_TAG_KEY]: String(nowSec - 1) },
      },
    ]);
    registerCloudBackend("aws", () => backend);
    // Force the singleton to use the test fixture clock.
    getOrCreateReaper(
      () =>
        new CloudReaper({
          getBackends: () => [backend],
          now: () => new Date(nowSec * 1000),
        }),
    );

    const capture = captureStdout();
    try {
      const exit = await cmdCloudReaper(argsFor(["run"]));
      expect(exit).toBe(0);
      const out = capture.read();
      expect(out).toMatch(/terminated: 1/);
    } finally {
      capture.restore();
    }
  });

  it("`reaper run` exits non-zero when a backend's listInstances fails", async () => {
    const broken: CloudBackend = {
      name: "aws",
      async provisionInstance() {
        throw new CloudBackendError("provision_failed", "stub");
      },
      async terminateInstance() {},
      async getInstanceStatus() {
        throw new CloudBackendError("provision_failed", "stub");
      },
      async getInstanceIp() {
        return null;
      },
      async listInstances() {
        throw new Error("auth lapsed");
      },
    };
    registerCloudBackend("aws", () => broken);
    getOrCreateReaper(
      () => new CloudReaper({ getBackends: () => [broken] }),
    );

    const capture = captureStdout();
    try {
      const exit = await cmdCloudReaper(argsFor(["run"]));
      expect(exit).toBe(4);
      const out = capture.read();
      expect(out).toMatch(/listError=auth lapsed/);
    } finally {
      capture.restore();
    }
  });

  it("`reaper status` before any run prints 'has not run' message", async () => {
    const capture = captureStdout();
    try {
      const exit = await cmdCloudReaper(argsFor(["status"]));
      expect(exit).toBe(0);
      const out = capture.read();
      expect(out).toMatch(/has not run/);
    } finally {
      capture.restore();
    }
  });

  it("`reaper status` after a run reflects totalTerminated", async () => {
    const nowSec = 1_700_000_000;
    const backend = stubBackend([
      {
        id: "i-expired",
        backend: "aws",
        name: "test",
        region: "us-east-1",
        tags: { [SIGNALMAN_TTL_EXPIRES_AT_TAG_KEY]: String(nowSec - 1) },
      },
    ]);
    registerCloudBackend("aws", () => backend);
    getOrCreateReaper(
      () =>
        new CloudReaper({
          getBackends: () => [backend],
          now: () => new Date(nowSec * 1000),
        }),
    );

    // Run first — swallow its stdout so test output stays clean.
    const preRunCapture = captureStdout();
    try {
      await cmdCloudReaper(argsFor(["run"]));
    } finally {
      preRunCapture.restore();
    }

    const capture = captureStdout();
    try {
      const exit = await cmdCloudReaper(argsFor(["status"], { format: "json" }));
      expect(exit).toBe(0);
      const parsed = JSON.parse(capture.read()) as {
        lastResult: { totalTerminated: number };
      };
      expect(parsed.lastResult.totalTerminated).toBe(1);
    } finally {
      capture.restore();
    }
  });
});
