/**
 * Tests for the PR 3 verb wrappers — target add/list/remove and the
 * deploy/rollback verbs' resolution paths (releaseId vs product+tag,
 * target-by-name).
 *
 * Uses a fake DeployBackend so we exercise the verb plumbing without
 * standing up Hyper-V; the executor itself is covered separately in
 * deploy-executor.test.ts.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ControlPlane } from "../control-plane/index.js";
import {
  runProductAdd,
  runReleaseDeploy,
  runReleaseRollback,
  runTargetAdd,
  runTargetList,
  runTargetRemove,
} from "../verbs/control-plane.js";
import type { CheckpointHandle, VMHandle } from "../hypervisors/interface.js";
import type {
  DeployBackend,
  DeployVmHandle,
} from "../control-plane/deploy/backend.js";

let dataDir: string;
let cp: ControlPlane;

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "signalman-deploy-verbs-"));
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

function makeFakeBackend(): DeployBackend {
  const handle: VMHandle = {
    id: "fake-vm",
    name: "Win11_demo",
    backend: "fake" as unknown as VMHandle["backend"],
  } as VMHandle;
  return {
    async resolveVm(): Promise<DeployVmHandle> {
      return { handle, vmName: "Win11_demo" };
    },
    async createCheckpoint(_h: VMHandle, label: string): Promise<CheckpointHandle> {
      return { id: label, vmHandle: handle, label } as CheckpointHandle;
    },
    async restoreCheckpoint() {},
    async deleteCheckpoint() {},
    async copyFileToVM() {},
    async isVmReachable() {
      return { reachable: true, detail: "ok" };
    },
    async executeInGuest() {
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
}

describe("target verbs", () => {
  it("add → list → remove cycle", async () => {
    const t = await runTargetAdd(cp, {
      name: "win11-demo",
      kind: "vm_demo",
      connection: { backend: "service", vmName: "Win11_demo" },
    });
    expect(t.name).toBe("win11-demo");

    const list1 = await runTargetList(cp);
    expect(list1.map((x) => x.name)).toEqual(["win11-demo"]);

    await runTargetRemove(cp, { name: "win11-demo" });
    expect(await runTargetList(cp)).toEqual([]);
  });

  it("audit-logs target.added", async () => {
    const t = await runTargetAdd(cp, {
      name: "x",
      kind: "vm_test",
      connection: { vmName: "X" },
    });
    const audit = await cp.auditLog.listForOrg(t.orgId);
    expect(audit.some((a) => a.action === "target.added")).toBe(true);
  });

  it("remove throws on unknown name", async () => {
    await expect(
      runTargetRemove(cp, { name: "nope" }),
    ).rejects.toThrow(/target not found/);
  });
});

describe("deploy verb — release resolution", () => {
  it("resolves release by product + tag", async () => {
    const product = await runProductAdd(cp, { name: "example", repoUrl: "u" });
    const release = await cp.releases.create({
      orgId: product.orgId,
      productId: product.id,
      tag: "v1",
      commitSha: "c",
    });
    await cp.releases.update(release.id, { status: "ready" });
    await runTargetAdd(cp, {
      name: "win11-demo",
      kind: "vm_demo",
      connection: { vmName: "Win11_demo" },
    });

    const result = await runReleaseDeploy(
      cp,
      { productName: "example", tag: "v1", targetName: "win11-demo" },
      { backend: makeFakeBackend(), out: silentSink },
    );
    expect(result.deployment.status).toBe("active");
    expect(result.release.id).toBe(release.id);
  });

  it("resolves release by explicit releaseId", async () => {
    const product = await runProductAdd(cp, { name: "example", repoUrl: "u" });
    const release = await cp.releases.create({
      orgId: product.orgId,
      productId: product.id,
      tag: "v1",
      commitSha: "c",
    });
    await cp.releases.update(release.id, { status: "ready" });
    await runTargetAdd(cp, {
      name: "t",
      kind: "vm_test",
      connection: { vmName: "T" },
    });

    const result = await runReleaseDeploy(
      cp,
      { releaseId: release.id, targetName: "t" },
      { backend: makeFakeBackend(), out: silentSink },
    );
    expect(result.deployment.status).toBe("active");
  });

  it("errors when neither identifier is provided", async () => {
    await runTargetAdd(cp, { name: "t", kind: "vm_test", connection: {} });
    await expect(
      runReleaseDeploy(
        cp,
        { targetName: "t" },
        { backend: makeFakeBackend(), out: silentSink },
      ),
    ).rejects.toThrow(/--release|--product/);
  });

  it("errors when product+tag combo doesn't match any release", async () => {
    const product = await runProductAdd(cp, { name: "p", repoUrl: "u" });
    await runTargetAdd(cp, { name: "t", kind: "vm_test", connection: {} });
    await expect(
      runReleaseDeploy(
        cp,
        { productName: "p", tag: "nope", targetName: "t" },
        { backend: makeFakeBackend(), out: silentSink },
      ),
    ).rejects.toThrow(/no release for/);
    void product;
  });
});

describe("rollback verb", () => {
  it("rolls back to the previous superseded release", async () => {
    const product = await runProductAdd(cp, { name: "p", repoUrl: "u" });
    const r1 = await cp.releases.create({
      orgId: product.orgId,
      productId: product.id,
      tag: "v1",
      commitSha: "c1",
    });
    await cp.releases.update(r1.id, { status: "ready" });
    const r2 = await cp.releases.create({
      orgId: product.orgId,
      productId: product.id,
      tag: "v2",
      commitSha: "c2",
    });
    await cp.releases.update(r2.id, { status: "ready" });
    await runTargetAdd(cp, {
      name: "t",
      kind: "vm_test",
      connection: { vmName: "T" },
    });
    const backend = makeFakeBackend();

    await runReleaseDeploy(
      cp,
      { releaseId: r1.id, targetName: "t" },
      { backend, out: silentSink },
    );
    await runReleaseDeploy(
      cp,
      { releaseId: r2.id, targetName: "t" },
      { backend, out: silentSink },
    );
    const result = await runReleaseRollback(
      cp,
      { targetName: "t" },
      { backend, out: silentSink },
    );
    expect(result.release.tag).toBe("v1");
  });
});
