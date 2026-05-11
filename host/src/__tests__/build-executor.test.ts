/**
 * Integration tests for the build executor.
 *
 * Builds against a synthetic "product repo" in a temp dir — no real
 * Example checkout needed. Components run `node -e` to produce dummy
 * artifact files; failure modes use exit-code-1 or missing-artifact
 * configurations.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as YAML from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ControlPlane } from "../control-plane/index.js";
import {
  ComponentBuildError,
  MissingArtifactError,
  ReleaseAlreadyExistsError,
  runBuild,
} from "../control-plane/build/index.js";

interface Harness {
  dataDir: string;
  workDir: string;
  cp: ControlPlane;
  orgId: string;
  productId: string;
}

async function makeHarness(buildYaml: unknown): Promise<Harness> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "signalman-build-test-"));
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "signalman-build-work-"));

  const cp = ControlPlane.create({
    storage: { driver: "sqlite", url: path.join(dataDir, "signalman.db") },
    blobs: { driver: "local", root: path.join(dataDir, "blobs") },
  });
  const { defaultOrg } = await cp.init();
  const product = await cp.products.create({
    orgId: defaultOrg.id,
    name: "test-product",
    repoUrl: "https://example.invalid/test.git",
  });

  await fs.writeFile(
    path.join(workDir, "signalman.build.yaml"),
    YAML.stringify(buildYaml),
    "utf-8",
  );

  return {
    dataDir,
    workDir,
    cp,
    orgId: defaultOrg.id,
    productId: product.id,
  };
}

async function tearDown(h: Harness): Promise<void> {
  await h.cp.close();
  await fs.rm(h.dataDir, { recursive: true, force: true });
  await fs.rm(h.workDir, { recursive: true, force: true });
}

// A silent write-sink so test output isn't polluted with build chatter.
const silentSink: NodeJS.WritableStream = Object.assign(
  Object.create(null) as object,
  {
    write: (_chunk: string | Buffer) => true,
    end: () => undefined,
    on: () => silentSink,
    emit: () => true,
  },
) as unknown as NodeJS.WritableStream;

// Cross-platform Node one-liner for component build commands.
// We use `node -e <expr>` to keep tests platform-independent.
function nodeWriteFile(dest: string, contents: string): string[] {
  // The arg is a JS expression; escape carefully.
  const expr = `require('fs').writeFileSync(${JSON.stringify(dest)}, ${JSON.stringify(contents)})`;
  return ["-e", expr];
}

describe("runBuild — happy path", () => {
  let h: Harness;

  beforeEach(async () => {
    h = await makeHarness({
      schema_version: 1,
      components: [
        {
          name: "agent",
          build: { command: "node", args: nodeWriteFile("agent.bin", "agent-binary-${TAG}") },
          artifacts: [{ kind: "blob", path: "agent.bin" }],
        },
        {
          name: "backend",
          build: { command: "node", args: ["-e", "void 0"] },
          artifacts: [{ kind: "image_ref", ref: "example-backend:${TAG}" }],
        },
      ],
    });
  });
  afterEach(() => tearDown(h));

  it("builds, marks release ready, catalogs artifacts", async () => {
    const result = await runBuild({
      controlPlane: h.cp,
      orgId: h.orgId,
      productId: h.productId,
      tag: "v1.0.0",
      commitSha: "c".repeat(40),
      workDir: h.workDir,
      out: silentSink,
    });

    expect(result.release.status).toBe("ready");
    expect(result.release.tag).toBe("v1.0.0");
    expect(result.release.manifestSha256).toBe(result.manifestSha256);
    expect(result.artifacts).toHaveLength(2);

    const agent = result.artifacts.find((a) => a.component === "agent")!;
    expect(agent.kind).toBe("blob");
    expect(agent.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(agent.blobUri).toMatch(/^file:\/\//);

    const backend = result.artifacts.find((a) => a.component === "backend")!;
    expect(backend.kind).toBe("image_ref");
    expect(backend.imageRef).toBe("example-backend:v1.0.0");

    // Audit log captured both started and completed.
    const audit = await h.cp.auditLog.listForOrg(h.orgId);
    const actions = audit.map((a) => a.action).sort();
    expect(actions).toContain("release.build.started");
    expect(actions).toContain("release.build.completed");
  });
});

describe("runBuild — failure modes", () => {
  it("ComponentBuildError when a component exits non-zero", async () => {
    const h = await makeHarness({
      schema_version: 1,
      components: [
        {
          name: "failing",
          build: { command: "node", args: ["-e", "process.exit(7)"] },
          artifacts: [{ kind: "blob", path: "anything" }],
        },
      ],
    });
    try {
      await expect(
        runBuild({
          controlPlane: h.cp,
          orgId: h.orgId,
          productId: h.productId,
          tag: "v1",
          commitSha: "c".repeat(40),
          workDir: h.workDir,
          out: silentSink,
        }),
      ).rejects.toBeInstanceOf(ComponentBuildError);

      // Release was created then marked failed.
      const release = await h.cp.releases.getByTag(h.productId, "v1");
      expect(release?.status).toBe("failed");
    } finally {
      await tearDown(h);
    }
  });

  it("MissingArtifactError when a build succeeds but produces nothing", async () => {
    const h = await makeHarness({
      schema_version: 1,
      components: [
        {
          name: "ghost",
          // succeeds, doesn't produce the declared blob
          build: { command: "node", args: ["-e", "void 0"] },
          artifacts: [{ kind: "blob", path: "missing.bin" }],
        },
      ],
    });
    try {
      await expect(
        runBuild({
          controlPlane: h.cp,
          orgId: h.orgId,
          productId: h.productId,
          tag: "v1",
          commitSha: "c".repeat(40),
          workDir: h.workDir,
          out: silentSink,
        }),
      ).rejects.toBeInstanceOf(MissingArtifactError);

      const release = await h.cp.releases.getByTag(h.productId, "v1");
      expect(release?.status).toBe("failed");
    } finally {
      await tearDown(h);
    }
  });

  it("refuses to rebuild an existing ready release at the same tag", async () => {
    const h = await makeHarness({
      schema_version: 1,
      components: [
        {
          name: "small",
          build: { command: "node", args: nodeWriteFile("out.bin", "data") },
          artifacts: [{ kind: "blob", path: "out.bin" }],
        },
      ],
    });
    try {
      await runBuild({
        controlPlane: h.cp,
        orgId: h.orgId,
        productId: h.productId,
        tag: "v1",
        commitSha: "c".repeat(40),
        workDir: h.workDir,
        out: silentSink,
      });
      // Second build at the same tag should refuse.
      await expect(
        runBuild({
          controlPlane: h.cp,
          orgId: h.orgId,
          productId: h.productId,
          tag: "v1",
          commitSha: "c".repeat(40),
          workDir: h.workDir,
          out: silentSink,
        }),
      ).rejects.toBeInstanceOf(ReleaseAlreadyExistsError);
    } finally {
      await tearDown(h);
    }
  });

  it("retries a previously-failed release at the same tag", async () => {
    // First config: failing build.
    const h = await makeHarness({
      schema_version: 1,
      components: [
        {
          name: "fail",
          build: { command: "node", args: ["-e", "process.exit(1)"] },
          artifacts: [{ kind: "blob", path: "x" }],
        },
      ],
    });
    try {
      await expect(
        runBuild({
          controlPlane: h.cp,
          orgId: h.orgId,
          productId: h.productId,
          tag: "v1",
          commitSha: "c".repeat(40),
          workDir: h.workDir,
          out: silentSink,
        }),
      ).rejects.toBeInstanceOf(ComponentBuildError);

      // Now swap in a working build.yaml and retry.
      await fs.writeFile(
        path.join(h.workDir, "signalman.build.yaml"),
        YAML.stringify({
          schema_version: 1,
          components: [
            {
              name: "ok",
              build: { command: "node", args: nodeWriteFile("ok.bin", "good") },
              artifacts: [{ kind: "blob", path: "ok.bin" }],
            },
          ],
        }),
        "utf-8",
      );

      const result = await runBuild({
        controlPlane: h.cp,
        orgId: h.orgId,
        productId: h.productId,
        tag: "v1",
        commitSha: "c".repeat(40),
        workDir: h.workDir,
        out: silentSink,
      });
      expect(result.release.status).toBe("ready");
    } finally {
      await tearDown(h);
    }
  });

  it("validation error surfaces before any release row is created", async () => {
    const h = await makeHarness({ schema_version: 2 /* invalid */ });
    try {
      await expect(
        runBuild({
          controlPlane: h.cp,
          orgId: h.orgId,
          productId: h.productId,
          tag: "v1",
          commitSha: "c".repeat(40),
          workDir: h.workDir,
          out: silentSink,
        }),
      ).rejects.toThrow(/invalid/);
      const r = await h.cp.releases.getByTag(h.productId, "v1");
      expect(r).toBeNull();
    } finally {
      await tearDown(h);
    }
  });
});

describe("runBuild — variable substitution end-to-end", () => {
  it("expands ${TAG} into build args + artifact refs", async () => {
    const h = await makeHarness({
      schema_version: 1,
      components: [
        {
          name: "tagged",
          build: { command: "node", args: nodeWriteFile("out-${TAG}.bin", "ok") },
          artifacts: [{ kind: "blob", path: "out-${TAG}.bin" }],
        },
        {
          name: "image",
          build: { command: "node", args: ["-e", "void 0"] },
          artifacts: [{ kind: "image_ref", ref: "img:${COMMIT_SHORT}" }],
        },
      ],
    });
    try {
      const result = await runBuild({
        controlPlane: h.cp,
        orgId: h.orgId,
        productId: h.productId,
        tag: "v9.9.9",
        commitSha: "abcdef0" + "0".repeat(33),
        workDir: h.workDir,
        out: silentSink,
      });
      expect(result.release.status).toBe("ready");
      const image = result.artifacts.find((a) => a.component === "image")!;
      expect(image.imageRef).toBe("img:abcdef0");
    } finally {
      await tearDown(h);
    }
  });
});
