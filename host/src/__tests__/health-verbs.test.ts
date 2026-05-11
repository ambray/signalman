/**
 * Tests for the health-check and health-history verbs.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ControlPlane } from "../control-plane/index.js";
import {
  runHealthCheck,
  runHealthHistory,
  runReleaseDeploy,
  runTargetAdd,
} from "../verbs/control-plane.js";
import type {
  DeployBackend,
  DeployVmHandle,
  ExecResult,
} from "../control-plane/deploy/backend.js";
import type { CheckpointHandle, VMHandle } from "../hypervisors/interface.js";

let dataDir: string;
let cp: ControlPlane;

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "signalman-health-verbs-"));
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
  { write: () => true, end: () => undefined, on: () => silentSink, emit: () => true },
) as unknown as NodeJS.WritableStream;

function fakeBackend(
  responder: (command: string, args?: string[]) => ExecResult,
): DeployBackend {
  const handle: VMHandle = {
    id: "fake",
    name: "X",
    backend: "fake" as unknown as VMHandle["backend"],
  } as VMHandle;
  return {
    async resolveVm(): Promise<DeployVmHandle> {
      return { handle, vmName: "X" };
    },
    async createCheckpoint(_h, label): Promise<CheckpointHandle> {
      return { id: label, vmHandle: handle, label } as CheckpointHandle;
    },
    async restoreCheckpoint() {},
    async deleteCheckpoint() {},
    async copyFileToVM() {},
    async isVmReachable() {
      return { reachable: true, detail: "ok" };
    },
    async executeInGuest(_h, command, args) {
      return responder(command, args);
    },
  };
}

async function seedActiveDeployment(probes: object[] = []): Promise<{
  product: { id: string; orgId: string };
  release: { id: string };
}> {
  const { defaultOrg } = await cp.init();
  const product = await cp.products.create({
    orgId: defaultOrg.id,
    name: "p",
    repoUrl: "u",
  });
  const release = await cp.releases.create({
    orgId: defaultOrg.id,
    productId: product.id,
    tag: "v1",
    commitSha: "c",
  });
  await cp.releases.update(release.id, {
    status: "ready",
    buildYamlJson: JSON.stringify({
      schema_version: 1,
      components: [
        {
          name: "agent",
          build: { command: "node", args: ["-e", "void 0"] },
          artifacts: [{ kind: "blob", path: "x" }],
        },
      ],
      probes,
    }),
  });
  const blob = await cp.blobs.put({
    orgId: defaultOrg.id,
    body: Buffer.from("x"),
  });
  await cp.artifacts.create({
    releaseId: release.id,
    component: "agent",
    kind: "blob",
    sha256: blob.sha256,
    sizeBytes: blob.size,
    blobUri: blob.uri,
  });
  await runTargetAdd(cp, {
    name: "t",
    kind: "vm_test",
    connection: { vmName: "X" },
  });
  await runReleaseDeploy(
    cp,
    { releaseId: release.id, targetName: "t" },
    {
      backend: fakeBackend(() => ({ exitCode: 0, stdout: "", stderr: "" })),
      out: silentSink,
    },
  );
  return { product, release };
}

describe("runHealthCheck", () => {
  it("runs all declared probes against the active deployment", async () => {
    await seedActiveDeployment([
      { kind: "command", name: "a", command: "x" },
      { kind: "command", name: "b", command: "y" },
    ]);
    const result = await runHealthCheck(
      cp,
      { targetName: "t" },
      {
        backend: fakeBackend(() => ({ exitCode: 0, stdout: "", stderr: "" })),
        out: silentSink,
      },
    );
    expect(result.reachability.reachable).toBe(true);
    expect(result.probes).toHaveLength(2);
    expect(result.probes.map((p) => p.name).sort()).toEqual(["a", "b"]);
    expect(result.probes.every((p) => p.status === "pass")).toBe(true);
  });

  it("limits probes via probeNames filter", async () => {
    await seedActiveDeployment([
      { kind: "command", name: "a", command: "x" },
      { kind: "command", name: "b", command: "y" },
    ]);
    const result = await runHealthCheck(
      cp,
      { targetName: "t", probeNames: ["b"] },
      {
        backend: fakeBackend(() => ({ exitCode: 0, stdout: "", stderr: "" })),
        out: silentSink,
      },
    );
    expect(result.probes).toHaveLength(1);
    expect(result.probes[0].name).toBe("b");
  });

  it("rejects an unknown probe name", async () => {
    await seedActiveDeployment([
      { kind: "command", name: "a", command: "x" },
    ]);
    await expect(
      runHealthCheck(
        cp,
        { targetName: "t", probeNames: ["does-not-exist"] },
        {
          backend: fakeBackend(() => ({ exitCode: 0, stdout: "", stderr: "" })),
          out: silentSink,
        },
      ),
    ).rejects.toThrow(/unknown probe name/);
  });

  it("appends rows to the active deployment's health_check history", async () => {
    const seeded = await seedActiveDeployment([
      { kind: "command", name: "a", command: "x" },
    ]);
    // Initial deploy already recorded one round. Run health-check
    // again to add a second round.
    await runHealthCheck(
      cp,
      { targetName: "t" },
      {
        backend: fakeBackend(() => ({ exitCode: 0, stdout: "", stderr: "" })),
        out: silentSink,
      },
    );
    const deployments = await cp.deployments.listForTarget(
      (await cp.targets.getByName(seeded.product.orgId, "t"))!.id,
    );
    const checks = await cp.healthChecks.listForDeployment(deployments[0].id);
    // One round at deploy + one round on-demand = 4 rows
    //   (vm_reachable, a) × 2.
    expect(checks).toHaveLength(4);
  });

  it("errors when the target has no active deployment", async () => {
    await runTargetAdd(cp, {
      name: "empty",
      kind: "vm_test",
      connection: { vmName: "X" },
    });
    await expect(
      runHealthCheck(
        cp,
        { targetName: "empty" },
        {
          backend: fakeBackend(() => ({ exitCode: 0, stdout: "", stderr: "" })),
          out: silentSink,
        },
      ),
    ).rejects.toThrow(/no active deployment/);
  });
});

describe("runHealthHistory", () => {
  it("returns deployments + checks for a target", async () => {
    await seedActiveDeployment([
      { kind: "command", name: "a", command: "x" },
    ]);
    const entries = await runHealthHistory(cp, { targetName: "t" });
    expect(entries).toHaveLength(1);
    expect(entries[0].checks.length).toBeGreaterThan(0);
  });

  it("throws on unknown target", async () => {
    await expect(
      runHealthHistory(cp, { targetName: "nope" }),
    ).rejects.toThrow(/target not found/);
  });
});
