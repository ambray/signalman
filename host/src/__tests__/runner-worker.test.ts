/**
 * Tests for the runner worker loop against a real HTTP control plane.
 *
 * Runs the worker for a bounded window (AbortController fires after
 * the assertions are satisfied) and asserts the on-the-wire state
 * transitions: pending → claimed → running → succeeded (or failed).
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { ControlPlane } from "../control-plane/index.js";
import { startServer, type ServerHandle } from "../http/index.js";
import {
  HttpClient,
  type JobHandler,
  runWorker,
} from "../runner/worker.js";
import type { Job } from "../control-plane/types.js";

let dataDir: string;
let cp: ControlPlane;
let server: ServerHandle;
let client: HttpClient;

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "signalman-runner-"));
  cp = ControlPlane.create({
    storage: { driver: "sqlite", url: path.join(dataDir, "signalman.db") },
    blobs: { driver: "local", root: path.join(dataDir, "blobs") },
  });
  await cp.init();
  server = await startServer({ controlPlane: cp, host: "127.0.0.1", port: 0 });
  client = new HttpClient({ baseUrl: server.url });
});

afterEach(async () => {
  await server.stop();
  await cp.close();
  await fs.rm(dataDir, { recursive: true, force: true });
});

const silentSink: NodeJS.WritableStream = Object.assign(
  Object.create(null) as object,
  { write: () => true, end: () => undefined, on: () => silentSink, emit: () => true },
) as unknown as NodeJS.WritableStream;

/**
 * Run the worker in the background, then poll the control plane until
 * `predicate` is satisfied or the deadline elapses. Stops the worker
 * before returning.
 */
async function runWorkerUntil(
  handlers: Record<string, JobHandler>,
  predicate: () => Promise<boolean>,
  timeoutMs = 3_000,
): Promise<void> {
  const controller = new AbortController();
  const workerPromise = runWorker({
    client,
    workerName: "test-worker",
    pollIntervalMs: 50,
    signal: controller.signal,
    handlers,
    out: silentSink,
  });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      controller.abort();
      await workerPromise;
      return;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  controller.abort();
  await workerPromise;
  throw new Error(`runWorkerUntil timed out after ${timeoutMs}ms`);
}

describe("runWorker — noop happy path", () => {
  it("claims a pending noop, runs it, marks succeeded", async () => {
    const submitted = await client.submitJob("noop", { duration_ms: 5 });
    await runWorkerUntil(
      // Use the real default handlers' noop.
      // Inlined here to avoid the test depending on import ordering.
      {
        noop: async (job: Job) => {
          const d = (job.input.duration_ms as number) ?? 1;
          await new Promise((r) => setTimeout(r, d));
          return { result: { ok: true, slept_ms: d } };
        },
      },
      async () => {
        const j = await client.getJob(submitted.id);
        return j.status === "succeeded";
      },
    );

    const final = await client.getJob(submitted.id);
    expect(final.status).toBe("succeeded");
    expect(final.result).toEqual({ ok: true, slept_ms: 5 });
    expect(final.claimedBy).toBe("test-worker");
    expect(final.completedAt).toBeTruthy();
  });
});

describe("runWorker — failure paths", () => {
  it("handler that throws marks the job failed with the error message", async () => {
    const submitted = await client.submitJob("blowup", {});
    await runWorkerUntil(
      {
        blowup: async () => {
          throw new Error("intentional blowup");
        },
      },
      async () => {
        const j = await client.getJob(submitted.id);
        return j.status === "failed";
      },
    );
    const final = await client.getJob(submitted.id);
    expect(final.status).toBe("failed");
    expect(final.error).toMatch(/intentional blowup/);
  });

  it("unknown job kind → failed with 'no handler' message", async () => {
    const submitted = await client.submitJob("unknown-kind", {});
    await runWorkerUntil(
      // Empty handler map — anything claimed fails fast.
      {},
      async () => {
        const j = await client.getJob(submitted.id);
        return j.status === "failed";
      },
    );
    const final = await client.getJob(submitted.id);
    expect(final.status).toBe("failed");
    expect(final.error).toMatch(/no handler registered/);
  });
});

describe("runWorker — concurrent safety", () => {
  it("two workers don't both run the same job", async () => {
    const submitted = await client.submitJob("noop", { duration_ms: 50 });
    let executions = 0;
    const slowNoop: JobHandler = async () => {
      executions += 1;
      await new Promise((r) => setTimeout(r, 80));
      return { result: { ok: true } };
    };

    // Two workers racing.
    const c1 = new AbortController();
    const c2 = new AbortController();
    const w1 = runWorker({
      client,
      workerName: "w1",
      pollIntervalMs: 25,
      signal: c1.signal,
      handlers: { noop: slowNoop },
      out: silentSink,
    });
    const w2 = runWorker({
      client,
      workerName: "w2",
      pollIntervalMs: 25,
      signal: c2.signal,
      handlers: { noop: slowNoop },
      out: silentSink,
    });

    // Poll until succeeded.
    for (let i = 0; i < 200; i++) {
      const j = await client.getJob(submitted.id);
      if (j.status === "succeeded") break;
      await new Promise((r) => setTimeout(r, 20));
    }
    c1.abort();
    c2.abort();
    await Promise.all([w1, w2]);

    expect(executions).toBe(1);
    const final = await client.getJob(submitted.id);
    expect(final.status).toBe("succeeded");
    expect(["w1", "w2"]).toContain(final.claimedBy);
  });
});

describe("default handlers — release.build stub", () => {
  it("release.build kind fails with PR 8b deferral message", async () => {
    const { defaultHandlers } = await import("../runner/worker.js");
    const submitted = await client.submitJob("release.build", {
      product_id: "x",
      tag: "v1",
    });
    await runWorkerUntil(defaultHandlers(), async () => {
      const j = await client.getJob(submitted.id);
      return j.status === "failed";
    });
    const final = await client.getJob(submitted.id);
    expect(final.error).toMatch(/lands in PR 8b/);
  });
});
