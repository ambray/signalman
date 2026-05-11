/**
 * HTTP tests for the PR 8 job endpoints. Exercises submit/claim/
 * complete/fail end-to-end via the loopback-bypass server.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ControlPlane } from "../control-plane/index.js";
import { startServer, type ServerHandle } from "../http/index.js";

let dataDir: string;
let cp: ControlPlane;
let server: ServerHandle;
let baseUrl: string;

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "signalman-http-jobs-"));
  cp = ControlPlane.create({
    storage: { driver: "sqlite", url: path.join(dataDir, "signalman.db") },
    blobs: { driver: "local", root: path.join(dataDir, "blobs") },
  });
  await cp.init();
  server = await startServer({ controlPlane: cp, host: "127.0.0.1", port: 0 });
  baseUrl = server.url;
});

afterEach(async () => {
  await server.stop();
  await cp.close();
  await fs.rm(dataDir, { recursive: true, force: true });
});

async function api(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let parsed: unknown = null;
  try {
    parsed = res.status === 204 ? null : await res.json();
  } catch {
    parsed = null;
  }
  return { status: res.status, body: parsed };
}

describe("POST /v1/jobs", () => {
  it("creates a pending job with input", async () => {
    const r = await api("POST", "/v1/jobs", {
      kind: "noop",
      input: { duration_ms: 5 },
    });
    expect(r.status).toBe(201);
    const job = (r.body as { job: { status: string; kind: string; input: unknown } })
      .job;
    expect(job.status).toBe("pending");
    expect(job.kind).toBe("noop");
    expect(job.input).toEqual({ duration_ms: 5 });
  });

  it("kind is required → 400", async () => {
    const r = await api("POST", "/v1/jobs", { input: {} });
    expect(r.status).toBe(400);
  });
});

describe("claim → complete cycle", () => {
  it("POST /v1/jobs/claim returns the only pending job once, then null", async () => {
    await api("POST", "/v1/jobs", { kind: "noop" });
    const a = await api("POST", "/v1/jobs/claim", { claimed_by: "w1" });
    expect(a.status).toBe(200);
    const firstJob = (a.body as { job: { id: string; status: string } | null }).job;
    expect(firstJob).not.toBeNull();
    expect(firstJob!.status).toBe("claimed");

    const b = await api("POST", "/v1/jobs/claim", { claimed_by: "w2" });
    expect((b.body as { job: unknown }).job).toBeNull();
  });

  it("POST /v1/jobs/:id/complete sets succeeded + writes result", async () => {
    const created = await api("POST", "/v1/jobs", { kind: "noop" });
    const id = (created.body as { job: { id: string } }).job.id;
    await api("POST", "/v1/jobs/claim", { claimed_by: "w" });
    const done = await api("POST", `/v1/jobs/${id}/complete`, {
      result: { ok: true, slept_ms: 5 },
    });
    expect(done.status).toBe(200);
    const job = (
      done.body as { job: { status: string; result: Record<string, unknown> } }
    ).job;
    expect(job.status).toBe("succeeded");
    expect(job.result).toEqual({ ok: true, slept_ms: 5 });
  });

  it("POST /v1/jobs/:id/fail sets failed + writes error", async () => {
    const created = await api("POST", "/v1/jobs", { kind: "noop" });
    const id = (created.body as { job: { id: string } }).job.id;
    const failed = await api("POST", `/v1/jobs/${id}/fail`, {
      error: "intentional",
    });
    expect(failed.status).toBe(200);
    const job = (failed.body as { job: { status: string; error: string } }).job;
    expect(job.status).toBe("failed");
    expect(job.error).toBe("intentional");
  });
});

describe("GET /v1/jobs", () => {
  it("returns the org's jobs, newest first; ?status= filters", async () => {
    const a = await api("POST", "/v1/jobs", { kind: "a" });
    const b = await api("POST", "/v1/jobs", { kind: "b" });
    const idA = (a.body as { job: { id: string } }).job.id;
    await api("POST", `/v1/jobs/${idA}/fail`, { error: "x" });

    const all = await api("GET", "/v1/jobs");
    expect((all.body as { jobs: unknown[] }).jobs).toHaveLength(2);

    const pending = await api("GET", "/v1/jobs?status=pending");
    const pendingJobs = (pending.body as { jobs: Array<{ id: string }> }).jobs;
    expect(pendingJobs.map((j) => j.id)).toEqual([
      (b.body as { job: { id: string } }).job.id,
    ]);

    const bad = await api("GET", "/v1/jobs?status=bogus");
    expect(bad.status).toBe(400);
  });
});

describe("org scoping", () => {
  it("a job created in org A is not visible from org B", async () => {
    const orgB = await cp.orgs.create({ name: "org-b" });
    // Sneak a job into org B directly via the repo (bypassing the
    // default-org HTTP path).
    const bJob = await cp.jobs.create({ orgId: orgB.id, kind: "secret" });
    const list = await api("GET", "/v1/jobs");
    expect(
      (list.body as { jobs: Array<{ id: string }> }).jobs.find(
        (j) => j.id === bJob.id,
      ),
    ).toBeUndefined();
    const direct = await api("GET", `/v1/jobs/${bJob.id}`);
    expect(direct.status).toBe(404);
  });
});
