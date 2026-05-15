// WS6 milestone 3 — runTargetEdit verb tests.
//
// Operator-authorised closure of the P3 "no target edit verb" gap.
// Editable fields: name + connection. Kind is NOT editable (would
// invalidate past deployments' backend assumptions). Past deployment
// rows are NOT updated by this verb — rollback / health-check against
// a target reads the row's *current* connection (the post-edit one).
//
// What this test pins:
//   1. Edit name only → name swaps; old name no longer resolves
//   2. Edit connection only → connection swaps; name preserved
//   3. Edit both → both swap atomically
//   4. No-op (neither field) → throws operator-friendly error
//   5. Unknown name → throws "target not found"
//   6. Past deployment still references the same target_id and
//      preserves its own row state — the edit doesn't cascade
//   7. Audit log records target.edited with before/after detail

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ControlPlane } from "../control-plane/index.js";
import { runTargetAdd, runTargetEdit } from "../verbs/control-plane.js";

let dataDir: string;
let cp: ControlPlane;

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "signalman-target-edit-"));
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

describe("runTargetEdit", () => {
  it("edits name only — connection preserved", async () => {
    await runTargetAdd(cp, {
      name: "win11-test",
      kind: "vm_test",
      connection: { vmName: "Win11_test", backend: "hyperv" },
    });

    const updated = await runTargetEdit(cp, {
      name: "win11-test",
      newName: "win11-test-1",
    });

    expect(updated.name).toBe("win11-test-1");
    expect(updated.connection).toEqual({
      vmName: "Win11_test",
      backend: "hyperv",
    });
    expect(updated.kind).toBe("vm_test");
  });

  it("edits connection only — name preserved", async () => {
    await runTargetAdd(cp, {
      name: "win11-test",
      kind: "vm_test",
      connection: { vmName: "Win11_test_old" },
    });

    const updated = await runTargetEdit(cp, {
      name: "win11-test",
      newConnection: { vmName: "Win11_test_new", backend: "hyperv" },
    });

    expect(updated.name).toBe("win11-test");
    expect(updated.connection).toEqual({
      vmName: "Win11_test_new",
      backend: "hyperv",
    });
  });

  it("edits both atomically", async () => {
    await runTargetAdd(cp, {
      name: "old-name",
      kind: "vm_test",
      connection: { vmName: "OldVM" },
    });

    const updated = await runTargetEdit(cp, {
      name: "old-name",
      newName: "new-name",
      newConnection: { vmName: "NewVM" },
    });

    expect(updated.name).toBe("new-name");
    expect(updated.connection).toEqual({ vmName: "NewVM" });
  });

  it("old name no longer resolves after rename", async () => {
    const { defaultOrg } = await cp.init();
    await runTargetAdd(cp, {
      name: "alpha",
      kind: "vm_test",
      connection: { vmName: "A" },
    });

    await runTargetEdit(cp, { name: "alpha", newName: "beta" });

    expect(await cp.targets.getByName(defaultOrg.id, "alpha")).toBeNull();
    const found = await cp.targets.getByName(defaultOrg.id, "beta");
    expect(found?.name).toBe("beta");
  });

  it("throws when neither newName nor newConnection is supplied", async () => {
    await runTargetAdd(cp, {
      name: "win11-test",
      kind: "vm_test",
      connection: { vmName: "Win11" },
    });

    await expect(runTargetEdit(cp, { name: "win11-test" })).rejects.toThrow(
      /at least one of --new-name or --connection/,
    );
  });

  it("throws when the target name does not exist", async () => {
    await expect(
      runTargetEdit(cp, {
        name: "no-such-target",
        newName: "renamed",
      }),
    ).rejects.toThrow(/target not found: no-such-target/);
  });

  it("does NOT update kind (no path through the API)", async () => {
    // No `kind` field on the runTargetEdit input by design — pin
    // the surface so a future refactor that adds one trips this
    // test and forces an explicit decision.
    const added = await runTargetAdd(cp, {
      name: "stays-vm-test",
      kind: "vm_test",
      connection: { vmName: "X" },
    });
    expect(added.kind).toBe("vm_test");

    const updated = await runTargetEdit(cp, {
      name: "stays-vm-test",
      newName: "renamed",
      newConnection: { vmName: "Y" },
    });
    expect(updated.kind).toBe("vm_test"); // unchanged
  });

  it("past deployment rows still reference the same target_id (no cascade)", async () => {
    const { defaultOrg } = await cp.init();
    const target = await runTargetAdd(cp, {
      name: "preserve-history",
      kind: "vm_test",
      connection: { vmName: "OriginalVM" },
    });

    // Synthesize a release + deployment via direct repo calls (the
    // full deploy executor is heavier and not needed for this pin).
    const product = await cp.products.create({
      orgId: defaultOrg.id,
      name: "p",
      repoUrl: "u",
    });
    const release = await cp.releases.create({
      orgId: defaultOrg.id,
      productId: product.id,
      tag: "v1.0.0",
      commitSha: "deadbeef",
      status: "ready",
    });
    const deployment = await cp.deployments.create({
      orgId: defaultOrg.id,
      releaseId: release.id,
      targetId: target.id,
    });

    // Edit the target.
    const updated = await runTargetEdit(cp, {
      name: "preserve-history",
      newName: "renamed-target",
      newConnection: { vmName: "NewVM" },
    });
    expect(updated.id).toBe(target.id);

    // Deployment row still points at the same target_id — the edit
    // does not cascade.
    const reloaded = await cp.deployments.get(deployment.id);
    expect(reloaded?.targetId).toBe(target.id);
    // And getActiveForTarget by the same target_id still finds it.
    // (The new pending deployment lacks `active` status, so we
    // check the listForTarget shape instead.)
    const list = await cp.deployments.listForTarget(target.id);
    expect(list.map((d) => d.id)).toContain(deployment.id);
  });

  it("appends a target.edited audit-log entry with before/after detail", async () => {
    const { defaultOrg } = await cp.init();
    await runTargetAdd(cp, {
      name: "audited",
      kind: "vm_test",
      connection: { vmName: "Original" },
    });

    await runTargetEdit(cp, {
      name: "audited",
      newName: "audited-2",
      newConnection: { vmName: "Changed" },
    });

    const entries = await cp.auditLog.listForOrg(defaultOrg.id, {
      entityType: "target",
    });
    const editEntry = entries.find((e) => e.action === "target.edited");
    expect(editEntry).toBeDefined();
    expect(editEntry?.detail).toMatchObject({
      before: { name: "audited", connection: { vmName: "Original" } },
      after: { name: "audited-2", connection: { vmName: "Changed" } },
    });
  });
});
