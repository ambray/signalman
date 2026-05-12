/**
 * Tests for the product/release verb functions in
 * verbs/control-plane.ts (the in-process surface both the CLI and the
 * MCP server call into).
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as YAML from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ControlPlane } from "../control-plane/index.js";
import {
  runProductAdd,
  runProductList,
  runProductRemove,
  runReleaseBuild,
  runReleaseList,
  runReleaseShow,
} from "../verbs/control-plane.js";

let dataDir: string;
let cp: ControlPlane;

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "signalman-verbs-"));
  cp = ControlPlane.create({
    storage: { driver: "sqlite", url: path.join(dataDir, "signalman.db") },
    blobs: { driver: "local", root: path.join(dataDir, "blobs") },
  });
  await cp.init();
});

afterEach(async () => {
  await cp.close();
  await fs.rm(dataDir, { recursive: true, force: true });
});

const silentSink: NodeJS.WritableStream = Object.assign(
  Object.create(null) as object,
  {
    write: () => true,
    end: () => undefined,
    on: () => silentSink,
    emit: () => true,
  },
) as unknown as NodeJS.WritableStream;

describe("product verbs", () => {
  it("add → list → remove cycle", async () => {
    const p = await runProductAdd(cp, {
      name: "example-product",
      repoUrl: "https://example.invalid/example.git",
    });
    expect(p.name).toBe("example-product");
    expect(p.buildYamlPath).toBe("signalman.build.yaml");

    const list1 = await runProductList(cp);
    expect(list1.map((x) => x.name)).toEqual(["example-product"]);

    await runProductRemove(cp, { name: "example-product" });
    const list2 = await runProductList(cp);
    expect(list2).toEqual([]);
  });

  it("remove throws on unknown name", async () => {
    await expect(
      runProductRemove(cp, { name: "nope" }),
    ).rejects.toThrow(/product not found/);
  });

  it("add records an audit log entry", async () => {
    const p = await runProductAdd(cp, {
      name: "p1",
      repoUrl: "u",
    });
    const audit = await cp.auditLog.listForOrg(p.orgId);
    expect(audit.some((a) => a.action === "product.added")).toBe(true);
  });
});

describe("release build/list/show via verbs", () => {
  it("build a release with a pre-cloned workDir", async () => {
    const product = await runProductAdd(cp, {
      name: "p",
      repoUrl: "https://example.invalid/p.git",
    });

    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "signalman-vw-"));
    try {
      await fs.writeFile(
        path.join(workDir, "signalman.build.yaml"),
        YAML.stringify({
          schema_version: 1,
          components: [
            {
              name: "x",
              build: {
                command: "node",
                args: [
                  "-e",
                  "require('fs').writeFileSync('out.bin', 'hello-${TAG}')",
                ],
              },
              artifacts: [{ kind: "blob", path: "out.bin" }],
            },
          ],
        }),
        "utf-8",
      );

      const result = await runReleaseBuild(
        cp,
        { productName: "p", tag: "v0.0.1", workDir, commitSha: "c".repeat(40) },
        { out: silentSink },
      );
      expect(result.release.status).toBe("ready");
      expect(result.artifacts).toHaveLength(1);
      // workDir is operator-owned (not auto-cleaned by the verb when
      // explicitly passed); content should still be there.
      expect(await fs.stat(path.join(workDir, "out.bin"))).toBeTruthy();
      void product;
    } finally {
      await fs.rm(workDir, { recursive: true, force: true });
    }
  });

  it("releaseBuild surfaces 'product not found'", async () => {
    await expect(
      runReleaseBuild(cp, { productName: "nope", tag: "v" }),
    ).rejects.toThrow(/product not found/);
  });

  it("releaseList filters by product and status", async () => {
    const p1 = await runProductAdd(cp, { name: "p1", repoUrl: "u" });
    const p2 = await runProductAdd(cp, { name: "p2", repoUrl: "u" });
    // Seed two releases directly via the repo (avoid the executor
    // cost — this verb-level test only cares about filtering).
    const r1 = await cp.releases.create({
      orgId: p1.orgId,
      productId: p1.id,
      tag: "v1",
      commitSha: "c",
    });
    await cp.releases.update(r1.id, { status: "ready" });
    await cp.releases.create({
      orgId: p2.orgId,
      productId: p2.id,
      tag: "v1",
      commitSha: "c",
    });

    const all = await runReleaseList(cp, {});
    expect(all).toHaveLength(2);
    const onlyP1 = await runReleaseList(cp, { productName: "p1" });
    expect(onlyP1.map((e) => e.product.name)).toEqual(["p1"]);
    const onlyReady = await runReleaseList(cp, { status: "ready" });
    expect(onlyReady.map((e) => e.release.tag)).toEqual(["v1"]);
    expect(onlyReady[0].product.name).toBe("p1");
  });

  it("releaseShow returns release + product + artifacts", async () => {
    const product = await runProductAdd(cp, { name: "p", repoUrl: "u" });
    const release = await cp.releases.create({
      orgId: product.orgId,
      productId: product.id,
      tag: "v1",
      commitSha: "c",
    });
    await cp.artifacts.create({
      releaseId: release.id,
      component: "agent",
      kind: "blob",
      sha256: "a".repeat(64),
      sizeBytes: 100,
      blobUri: "file:///x",
    });

    const result = await runReleaseShow(cp, { releaseId: release.id });
    expect(result.release.id).toBe(release.id);
    expect(result.product.name).toBe("p");
    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts[0].component).toBe("agent");
  });

  it("releaseShow throws on unknown id", async () => {
    await expect(
      runReleaseShow(cp, { releaseId: "01ZZZZZZZZZZZZZZZZZZZZZZZZ" }),
    ).rejects.toThrow(/release not found/);
  });
});
