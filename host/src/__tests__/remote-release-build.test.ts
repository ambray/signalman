/**
 * End-to-end test for PR 8b: submit a `release.build` job over HTTP,
 * let a real worker claim + execute it, verify the release row +
 * artifacts land on the remote control plane.
 *
 * The "remote" product repo is a local git repo set up in-process
 * with a synthetic signalman.build.yaml that runs `node -e` build
 * commands. No real Example / network involvement.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as YAML from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ControlPlane } from "../control-plane/index.js";
import { startServer, type ServerHandle } from "../http/index.js";
import { HttpClient } from "../runner/client.js";
import { HttpControlPlane } from "../runner/http-control-plane.js";
import { defaultHandlers, runWorker } from "../runner/worker.js";

let dataDir: string;
let repoDir: string;
let cp: ControlPlane;
let server: ServerHandle;
let client: HttpClient;

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "signalman-remote-build-cp-"));
  repoDir = await fs.mkdtemp(path.join(os.tmpdir(), "signalman-remote-build-repo-"));
  cp = ControlPlane.create({
    storage: { driver: "sqlite", url: path.join(dataDir, "signalman.db") },
    blobs: { driver: "local", root: path.join(dataDir, "blobs") },
  });
  await cp.init();
  server = await startServer({ controlPlane: cp, host: "127.0.0.1", port: 0 });
  client = new HttpClient({ baseUrl: server.url });

  // Build a real local git repo with a signalman.build.yaml. The
  // runner will `git clone --branch <tag>` from it.
  await fs.writeFile(
    path.join(repoDir, "signalman.build.yaml"),
    YAML.stringify({
      schema_version: 1,
      components: [
        {
          name: "agent",
          build: {
            command: "node",
            // Tag interpolated into the JS one-liner via the executor's
            // ${TAG} substitution over args (env values aren't subbed
            // yet — that's a v0.3.x ask).
            args: [
              "-e",
              "require('fs').writeFileSync('agent.bin', 'agent-${TAG}')",
            ],
          },
          artifacts: [{ kind: "blob", path: "agent.bin" }],
        },
      ],
    }),
    "utf-8",
  );
  runGit(repoDir, ["init", "-b", "main"]);
  runGit(repoDir, ["config", "user.email", "test@example.invalid"]);
  runGit(repoDir, ["config", "user.name", "test"]);
  runGit(repoDir, ["add", "-A"]);
  runGit(repoDir, ["commit", "-m", "initial"]);
  runGit(repoDir, ["tag", "v1.0.0"]);
});

afterEach(async () => {
  await server.stop();
  await cp.close();
  await fs.rm(dataDir, { recursive: true, force: true });
  await fs.rm(repoDir, { recursive: true, force: true });
});

function runGit(cwd: string, args: string[]): void {
  const r = spawnSync("git", args, { cwd, stdio: "pipe" });
  if (r.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${r.stderr.toString("utf-8")}`,
    );
  }
}

const silentSink: NodeJS.WritableStream = Object.assign(
  Object.create(null) as object,
  { write: () => true, end: () => undefined, on: () => silentSink, emit: () => true },
) as unknown as NodeJS.WritableStream;

async function waitFor<T>(
  poll: () => Promise<T | undefined>,
  timeoutMs = 15_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await poll();
    if (r !== undefined) return r;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

describe("remote release.build — end-to-end", () => {
  it("submits a job, worker clones + builds + uploads, release lands as 'ready'", async () => {
    // 1. Register the synthetic repo as a product on the remote
    //    control plane. Use file:// for the repo URL so git can clone
    //    it without network.
    const { defaultOrg } = await cp.init();
    const product = await cp.products.create({
      orgId: defaultOrg.id,
      name: "p",
      repoUrl: repoDir, // local path; git accepts as a local clone source
    });

    // 2. Submit the job + start a worker pointed at this server.
    const submitted = await client.submitJob("release.build", {
      product_id: product.id,
      tag: "v1.0.0",
    });

    const controller = new AbortController();
    const workerPromise = runWorker({
      client,
      workerName: "test-worker",
      pollIntervalMs: 50,
      signal: controller.signal,
      handlers: defaultHandlers({
        client,
        out: silentSink,
        runnerId: "test-worker",
      }),
      out: silentSink,
    });

    // 3. Wait for the job to finish.
    const terminal = await waitFor(async () => {
      const j = await client.getJob(submitted.id);
      return j.status === "succeeded" || j.status === "failed" ? j : undefined;
    });
    controller.abort();
    await workerPromise;

    expect(terminal.status).toBe("succeeded");
    const result = terminal.result as {
      release_id: string;
      tag: string;
      manifest_sha256: string;
      artifact_count: number;
    };
    expect(result.tag).toBe("v1.0.0");
    expect(result.artifact_count).toBe(1);

    // 4. Verify the release + artifact + audit landed on the server.
    const release = await cp.releases.get(result.release_id);
    expect(release).not.toBeNull();
    expect(release!.status).toBe("ready");
    expect(release!.manifestSha256).toBe(result.manifest_sha256);
    expect(release!.builtAt).toBeTruthy();
    expect(release!.builtByRunnerId).toBe("test-worker");

    const artifacts = await cp.artifacts.listForRelease(release!.id);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].component).toBe("agent");
    expect(artifacts[0].sha256).toMatch(/^[a-f0-9]{64}$/);

    // 5. Verify the artifact bytes actually round-tripped through
    //    the BlobDriver (they're org-scoped on disk).
    const sha = artifacts[0].sha256!;
    const downloadRes = await fetch(`${server.url}/v1/blobs/${sha}`);
    expect(downloadRes.status).toBe(200);
    const downloaded = Buffer.from(await downloadRes.arrayBuffer()).toString(
      "utf-8",
    );
    expect(downloaded).toBe("agent-v1.0.0");
  });
});

describe("HttpControlPlane — repo round-trips", () => {
  it("create + getByTag returns the release we just made", async () => {
    const httpCp = new HttpControlPlane(client);
    const { defaultOrg } = await cp.init();
    const product = await cp.products.create({
      orgId: defaultOrg.id,
      name: "p",
      repoUrl: "u",
    });

    const r = await httpCp.releases.create({
      orgId: defaultOrg.id,
      productId: product.id,
      tag: "v9.9",
      commitSha: "abc",
    });
    expect(r.status).toBe("building");

    const found = await httpCp.releases.getByTag(product.id, "v9.9");
    expect(found?.id).toBe(r.id);

    const missing = await httpCp.releases.getByTag(product.id, "v100");
    expect(missing).toBeNull();
  });

  it("artifacts.create + auditLog.append round-trip", async () => {
    const httpCp = new HttpControlPlane(client);
    const { defaultOrg } = await cp.init();
    const product = await cp.products.create({
      orgId: defaultOrg.id,
      name: "p2",
      repoUrl: "u",
    });
    const release = await httpCp.releases.create({
      orgId: defaultOrg.id,
      productId: product.id,
      tag: "v1",
      commitSha: "c",
    });

    const art = await httpCp.artifacts.create({
      releaseId: release.id,
      component: "agent",
      kind: "blob",
      sha256: "a".repeat(64),
      sizeBytes: 100,
      blobUri: "file:///x",
    });
    expect(art.component).toBe("agent");

    const entry = await httpCp.auditLog.append({
      orgId: defaultOrg.id,
      actor: "test",
      action: "release.test",
      entityType: "release",
      entityId: release.id,
      detail: { tag: "v1" },
    });
    expect(entry.action).toBe("release.test");
    expect(entry.detail).toEqual({ tag: "v1" });
  });

  it("blobs.put streams a buffer and returns metadata", async () => {
    const httpCp = new HttpControlPlane(client);
    const meta = await httpCp.blobs.put({
      orgId: "ignored",
      body: Buffer.from("test-blob"),
    });
    expect(meta.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(meta.size).toBe(9);
  });
});
