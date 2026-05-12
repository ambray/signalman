/**
 * Integration tests for the deploy executor, using a fake DeployBackend
 * that records calls and lets tests inject failures at specific stages.
 *
 * Covers: happy-path deploy, supersede semantics, pre-deploy checkpoint
 * + restore-on-failure, rollback, blob staging to the (fake) guest.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ControlPlane } from "../control-plane/index.js";
import {
  DeployHealthFailedError,
  runDeploy,
  runRollback,
} from "../control-plane/deploy/index.js";
import type {
  DeployBackend,
  DeployVmHandle,
} from "../control-plane/deploy/backend.js";
import type {
  CheckpointHandle,
  VMHandle,
} from "../hypervisors/interface.js";
import type {
  Org,
  Product,
  Release,
  Target,
  TargetConnection,
} from "../control-plane/types.js";

interface CopyRecord {
  hostPath: string;
  guestPath: string;
  contents: Buffer;
}

interface FakeBackendState {
  copies: CopyRecord[];
  checkpoints: { label: string; restored: boolean; deleted: boolean }[];
  failures: {
    onCopy?: number; // throw on the Nth copyFileToVM call (0-based)
    onProbe?: { reachable: boolean; detail: string };
    onCheckpointCreate?: boolean;
  };
}

function makeFakeBackend(): { backend: DeployBackend; state: FakeBackendState } {
  const state: FakeBackendState = {
    copies: [],
    checkpoints: [],
    failures: {},
  };
  let copyN = 0;
  const handle: VMHandle = {
    id: "fake-vm",
    name: "Win11_demo",
    backend: "fake" as unknown as VMHandle["backend"],
  } as VMHandle;
  const backend: DeployBackend = {
    async resolveVm(_connection: TargetConnection): Promise<DeployVmHandle> {
      return { handle, vmName: "Win11_demo" };
    },
    async createCheckpoint(_h: VMHandle, label: string): Promise<CheckpointHandle> {
      if (state.failures.onCheckpointCreate) {
        throw new Error("simulated checkpoint create failure");
      }
      state.checkpoints.push({ label, restored: false, deleted: false });
      return { id: label, vmHandle: handle, label } as CheckpointHandle;
    },
    async restoreCheckpoint(checkpoint: CheckpointHandle): Promise<void> {
      const c = state.checkpoints.find((c) => c.label === checkpoint.label);
      if (c) c.restored = true;
    },
    async deleteCheckpoint(checkpoint: CheckpointHandle): Promise<void> {
      const c = state.checkpoints.find((c) => c.label === checkpoint.label);
      if (c) c.deleted = true;
    },
    async copyFileToVM(_h: VMHandle, hostPath: string, guestPath: string): Promise<void> {
      const i = copyN++;
      if (state.failures.onCopy === i) {
        throw new Error(`simulated copy failure on call ${i}`);
      }
      const contents = await fs.readFile(hostPath);
      state.copies.push({ hostPath, guestPath, contents });
    },
    async isVmReachable(): Promise<{ reachable: boolean; detail?: string }> {
      if (state.failures.onProbe) {
        return state.failures.onProbe;
      }
      return { reachable: true, detail: "ip=10.0.0.5" };
    },
    async executeInGuest() {
      // Existing executor tests don't seed declared probes; the
      // executor never calls this. Provide a benign default so the
      // interface is satisfied without surprising the test.
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
  return { backend, state };
}

const silentSink: NodeJS.WritableStream = Object.assign(
  Object.create(null) as object,
  {
    write: () => true,
    end: () => undefined,
    on: () => silentSink,
    emit: () => true,
  },
) as unknown as NodeJS.WritableStream;

interface Harness {
  dataDir: string;
  cp: ControlPlane;
  org: Org;
  product: Product;
  release: Release;
  target: Target;
}

async function setup(): Promise<Harness> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "signalman-deploy-test-"));
  const cp = ControlPlane.create({
    storage: { driver: "sqlite", url: path.join(dataDir, "signalman.db") },
    blobs: { driver: "local", root: path.join(dataDir, "blobs") },
  });
  const { defaultOrg } = await cp.init();
  const product = await cp.products.create({
    orgId: defaultOrg.id,
    name: "example-product",
    repoUrl: "u",
  });
  const release = await cp.releases.create({
    orgId: defaultOrg.id,
    productId: product.id,
    tag: "v1",
    commitSha: "abc",
  });
  await cp.releases.update(release.id, {
    status: "ready",
    manifestSha256: "f".repeat(64),
  });

  // Seed two blob artifacts.
  const blob1 = await cp.blobs.put({
    orgId: defaultOrg.id,
    body: Buffer.from("agent-binary"),
  });
  await cp.artifacts.create({
    releaseId: release.id,
    component: "agent",
    kind: "blob",
    sha256: blob1.sha256,
    sizeBytes: blob1.size,
    blobUri: blob1.uri,
  });
  const blob2 = await cp.blobs.put({
    orgId: defaultOrg.id,
    body: Buffer.from("driver-msi"),
  });
  await cp.artifacts.create({
    releaseId: release.id,
    component: "driver",
    kind: "blob",
    sha256: blob2.sha256,
    sizeBytes: blob2.size,
    blobUri: blob2.uri,
  });
  // Plus an image-ref artifact (skipped by staging).
  await cp.artifacts.create({
    releaseId: release.id,
    component: "backend",
    kind: "image_ref",
    imageRef: "example-backend:v1",
  });

  const target = await cp.targets.create({
    orgId: defaultOrg.id,
    name: "win11-demo",
    kind: "vm_demo",
    connection: { backend: "fake", vmName: "Win11_demo" },
  });
  // refresh release row (we updated it)
  const fresh = await cp.releases.get(release.id);
  return { dataDir, cp, org: defaultOrg, product, release: fresh!, target };
}

async function tearDown(h: Harness): Promise<void> {
  await h.cp.close();
  await fs.rm(h.dataDir, { recursive: true, force: true });
}

describe("runDeploy — happy path", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await setup();
  });
  afterEach(() => tearDown(h));

  it("stages blob artifacts + manifest, promotes deployment, drops checkpoint", async () => {
    const { backend, state } = makeFakeBackend();
    const result = await runDeploy({
      controlPlane: h.cp,
      orgId: h.org.id,
      releaseId: h.release.id,
      targetId: h.target.id,
      backend,
      out: silentSink,
    });

    expect(result.deployment.status).toBe("active");
    expect(result.deployment.completedAt).toBeTruthy();
    expect(result.healthSummary.pass).toBe(1);

    // 2 blob artifacts + 1 manifest = 3 copies; image_ref artifact skipped.
    expect(state.copies).toHaveLength(3);
    const guestPaths = state.copies.map((c) => c.guestPath).sort();
    expect(guestPaths).toEqual(
      [
        `C:/signalman-staging/${h.release.id}/agent.bin`,
        `C:/signalman-staging/${h.release.id}/driver.bin`,
        `C:/signalman-staging/${h.release.id}/manifest.json`,
      ].sort(),
    );

    // manifest.json content includes artifacts.
    const manifestCopy = state.copies.find((c) => c.guestPath.endsWith("manifest.json"))!;
    const manifest = JSON.parse(manifestCopy.contents.toString("utf-8")) as {
      release_id: string;
      artifacts: Array<{ component: string; kind: string }>;
    };
    expect(manifest.release_id).toBe(h.release.id);
    expect(manifest.artifacts).toHaveLength(3);

    // Checkpoint was created and deleted (not restored).
    expect(state.checkpoints).toHaveLength(1);
    expect(state.checkpoints[0].deleted).toBe(true);
    expect(state.checkpoints[0].restored).toBe(false);

    // Health check row landed.
    const checks = await h.cp.healthChecks.listForDeployment(result.deployment.id);
    expect(checks).toHaveLength(1);
    expect(checks[0].probeName).toBe("vm_reachable");
    expect(checks[0].status).toBe("pass");
  });

  it("supersedes the previous active deployment", async () => {
    const { backend } = makeFakeBackend();

    // First deploy.
    const first = await runDeploy({
      controlPlane: h.cp,
      orgId: h.org.id,
      releaseId: h.release.id,
      targetId: h.target.id,
      backend,
      out: silentSink,
    });

    // Create a second release at a different tag.
    const release2 = await h.cp.releases.create({
      orgId: h.org.id,
      productId: h.product.id,
      tag: "v2",
      commitSha: "def",
    });
    await h.cp.releases.update(release2.id, { status: "ready" });
    const blob = await h.cp.blobs.put({
      orgId: h.org.id,
      body: Buffer.from("agent-v2"),
    });
    await h.cp.artifacts.create({
      releaseId: release2.id,
      component: "agent",
      kind: "blob",
      sha256: blob.sha256,
      sizeBytes: blob.size,
      blobUri: blob.uri,
    });

    const second = await runDeploy({
      controlPlane: h.cp,
      orgId: h.org.id,
      releaseId: release2.id,
      targetId: h.target.id,
      backend,
      out: silentSink,
    });

    expect(second.deployment.status).toBe("active");
    expect(second.deployment.previousDeploymentId).toBe(first.deployment.id);
    const oldRow = await h.cp.deployments.get(first.deployment.id);
    expect(oldRow?.status).toBe("superseded");
  });
});

describe("runDeploy — failure modes", () => {
  it("restores checkpoint on copy failure, marks deployment failed", async () => {
    const h = await setup();
    try {
      const { backend, state } = makeFakeBackend();
      state.failures.onCopy = 0; // throw on the first copy

      await expect(
        runDeploy({
          controlPlane: h.cp,
          orgId: h.org.id,
          releaseId: h.release.id,
          targetId: h.target.id,
          backend,
          out: silentSink,
        }),
      ).rejects.toThrow(/simulated copy failure/);

      // Checkpoint was created, restored, deleted.
      expect(state.checkpoints[0].restored).toBe(true);
      expect(state.checkpoints[0].deleted).toBe(true);

      const deployments = await h.cp.deployments.listForTarget(h.target.id);
      expect(deployments[0].status).toBe("failed");
    } finally {
      await tearDown(h);
    }
  });

  it("DeployHealthFailedError when the probe fails", async () => {
    const h = await setup();
    try {
      const { backend, state } = makeFakeBackend();
      state.failures.onProbe = { reachable: false, detail: "VM stopped" };

      await expect(
        runDeploy({
          controlPlane: h.cp,
          orgId: h.org.id,
          releaseId: h.release.id,
          targetId: h.target.id,
          backend,
          out: silentSink,
        }),
      ).rejects.toBeInstanceOf(DeployHealthFailedError);

      // Checkpoint restored — failed health → rollback.
      expect(state.checkpoints[0].restored).toBe(true);

      // Health-check row records the failure.
      const deployments = await h.cp.deployments.listForTarget(h.target.id);
      const checks = await h.cp.healthChecks.listForDeployment(deployments[0].id);
      expect(checks).toHaveLength(1);
      expect(checks[0].status).toBe("fail");
    } finally {
      await tearDown(h);
    }
  });

  it("refuses to deploy a release that is not ready", async () => {
    const h = await setup();
    try {
      // Mark the release back to building.
      await h.cp.releases.update(h.release.id, { status: "building" });
      const { backend } = makeFakeBackend();
      await expect(
        runDeploy({
          controlPlane: h.cp,
          orgId: h.org.id,
          releaseId: h.release.id,
          targetId: h.target.id,
          backend,
          out: silentSink,
        }),
      ).rejects.toThrow(/not ready/);
    } finally {
      await tearDown(h);
    }
  });
});

describe("runRollback", () => {
  it("redeploys the previous superseded release", async () => {
    const h = await setup();
    try {
      const { backend } = makeFakeBackend();

      // Deploy v1.
      await runDeploy({
        controlPlane: h.cp,
        orgId: h.org.id,
        releaseId: h.release.id,
        targetId: h.target.id,
        backend,
        out: silentSink,
      });

      // Deploy v2 (supersedes v1).
      const release2 = await h.cp.releases.create({
        orgId: h.org.id,
        productId: h.product.id,
        tag: "v2",
        commitSha: "def",
      });
      await h.cp.releases.update(release2.id, { status: "ready" });
      const blob = await h.cp.blobs.put({ orgId: h.org.id, body: Buffer.from("v2") });
      await h.cp.artifacts.create({
        releaseId: release2.id,
        component: "agent",
        kind: "blob",
        sha256: blob.sha256,
        sizeBytes: blob.size,
        blobUri: blob.uri,
      });
      await runDeploy({
        controlPlane: h.cp,
        orgId: h.org.id,
        releaseId: release2.id,
        targetId: h.target.id,
        backend,
        out: silentSink,
      });

      // Roll back — should redeploy v1.
      const result = await runRollback({
        controlPlane: h.cp,
        orgId: h.org.id,
        targetId: h.target.id,
        backend,
        out: silentSink,
      });
      expect(result.release.tag).toBe("v1");
      expect(result.deployment.status).toBe("active");

      // The previously-active v2 deployment is now superseded.
      const all = await h.cp.deployments.listForTarget(h.target.id);
      const v2Deployments = all.filter((d) => d.releaseId === release2.id);
      expect(v2Deployments.every((d) => d.status === "superseded")).toBe(true);
    } finally {
      await tearDown(h);
    }
  });

  it("throws when no superseded deployment exists", async () => {
    const h = await setup();
    try {
      const { backend } = makeFakeBackend();
      await expect(
        runRollback({
          controlPlane: h.cp,
          orgId: h.org.id,
          targetId: h.target.id,
          backend,
          out: silentSink,
        }),
      ).rejects.toThrow(/no superseded deployment/);
    } finally {
      await tearDown(h);
    }
  });
});
