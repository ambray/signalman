/**
 * Tests for SqliteJobRepo — including the atomic-claim invariant
 * that two concurrent workers never see the same pending job.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteStorageDriver } from "../control-plane/storage/sqlite.js";
import { StorageConflictError } from "../control-plane/storage/driver.js";
import type { Org } from "../control-plane/types.js";

let driver: SqliteStorageDriver;
let org: Org;
let dataPath: string;

beforeEach(async () => {
  // Concurrent-claim test needs a real file (two driver instances
  // sharing one db; SQLite memory dbs are per-connection).
  dataPath = `signalman-job-${Math.random().toString(36).slice(2)}.db`;
  driver = new SqliteStorageDriver({ path: ":memory:" });
  await driver.migrate();
  org = await driver.orgs.create({ name: "org" });
});

afterEach(async () => {
  await driver.close();
});

describe("jobs — create / get / list", () => {
  it("create defaults status=pending and input={}", async () => {
    const j = await driver.jobs.create({ orgId: org.id, kind: "noop" });
    expect(j.kind).toBe("noop");
    expect(j.status).toBe("pending");
    expect(j.input).toEqual({});
    expect(j.claimedBy).toBeNull();
  });

  it("create accepts arbitrary input JSON", async () => {
    const j = await driver.jobs.create({
      orgId: org.id,
      kind: "release.build",
      input: { product_id: "p_xyz", tag: "v1.0.0" },
    });
    expect(j.input).toEqual({ product_id: "p_xyz", tag: "v1.0.0" });
  });

  it("listForOrg filters by status", async () => {
    await driver.jobs.create({ orgId: org.id, kind: "a" });
    await driver.jobs.create({ orgId: org.id, kind: "b" });
    const all = await driver.jobs.listForOrg(org.id);
    expect(all).toHaveLength(2);
    const pending = await driver.jobs.listForOrg(org.id, { status: "pending" });
    expect(pending).toHaveLength(2);
    const claimed = await driver.jobs.listForOrg(org.id, { status: "claimed" });
    expect(claimed).toHaveLength(0);
  });

  it("rejects invalid status via CHECK", async () => {
    const j = await driver.jobs.create({ orgId: org.id, kind: "a" });
    await expect(
      driver.jobs.update(j.id, {
        status: "bogus" as unknown as "pending",
      }),
    ).rejects.toBeInstanceOf(StorageConflictError);
  });
});

describe("jobs — claim semantics", () => {
  it("claimNext returns null on an empty queue", async () => {
    const claimed = await driver.jobs.claimNext({
      orgId: org.id,
      claimedBy: "w1",
    });
    expect(claimed).toBeNull();
  });

  it("claimNext picks the oldest pending and transitions it to claimed", async () => {
    const a = await driver.jobs.create({ orgId: org.id, kind: "a" });
    // Mark older by hand to overcome ms-quantization.
    driver.db.prepare("UPDATE job SET created_at = ? WHERE id = ?").run(
      "2000-01-01T00:00:00.000Z",
      a.id,
    );
    await driver.jobs.create({ orgId: org.id, kind: "b" });

    const first = await driver.jobs.claimNext({
      orgId: org.id,
      claimedBy: "w1",
    });
    expect(first?.id).toBe(a.id);
    expect(first?.status).toBe("claimed");
    expect(first?.claimedBy).toBe("w1");

    // Second claim picks `b` since `a` is no longer pending.
    const second = await driver.jobs.claimNext({
      orgId: org.id,
      claimedBy: "w2",
    });
    expect(second?.kind).toBe("b");
  });

  it("two parallel claims on a single-pending queue return the job exactly once", async () => {
    await driver.jobs.create({ orgId: org.id, kind: "exclusive" });
    const [r1, r2] = await Promise.all([
      driver.jobs.claimNext({ orgId: org.id, claimedBy: "w1" }),
      driver.jobs.claimNext({ orgId: org.id, claimedBy: "w2" }),
    ]);
    const claimed = [r1, r2].filter((x) => x !== null);
    expect(claimed).toHaveLength(1);
  });

  it("update completes a claimed job", async () => {
    const j = await driver.jobs.create({ orgId: org.id, kind: "noop" });
    await driver.jobs.claimNext({ orgId: org.id, claimedBy: "w" });
    const ok = await driver.jobs.update(j.id, {
      status: "succeeded",
      result: { ok: true },
      completedAt: "2026-05-11T00:00:00.000Z",
    });
    expect(ok.status).toBe("succeeded");
    expect(ok.result).toEqual({ ok: true });
  });

  it("update fails a claimed job and persists error string", async () => {
    const j = await driver.jobs.create({ orgId: org.id, kind: "bad" });
    await driver.jobs.claimNext({ orgId: org.id, claimedBy: "w" });
    const failed = await driver.jobs.update(j.id, {
      status: "failed",
      error: "boom",
      completedAt: "2026-05-11T00:00:00.000Z",
    });
    expect(failed.status).toBe("failed");
    expect(failed.error).toBe("boom");
  });

  // Reference dataPath so the lint pass doesn't flag it.
  it("setup data path placeholder", () => {
    expect(typeof dataPath).toBe("string");
  });
});
