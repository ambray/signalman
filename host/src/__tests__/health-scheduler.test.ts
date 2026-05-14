/**
 * Unit tests for the health scheduler (v0.4.0-3 / Epic 3, WS3).
 *
 * Layer: pure logic — `dueSchedules` decision, repo CRUD on the
 * SqliteHealthScheduleRepo. The integration test
 * (health-scheduler-integration.test.ts) covers tick orchestration
 * end-to-end.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteStorageDriver } from "../control-plane/storage/sqlite.js";
import { dueSchedules } from "../control-plane/scheduler/index.js";
import type { HealthSchedule, Org, Target } from "../control-plane/types.js";
import { StorageNotFoundError } from "../control-plane/storage/driver.js";

let driver: SqliteStorageDriver;
let org: Org;
let target: Target;

beforeEach(async () => {
  driver = new SqliteStorageDriver({ path: ":memory:" });
  await driver.migrate();
  org = await driver.orgs.create({ name: "acme" });
  target = await driver.targets.create({
    orgId: org.id,
    name: "t1",
    kind: "vm_test",
    connection: { vmName: "vm1" },
  });
});

afterEach(async () => {
  await driver.close();
});

describe("HealthScheduleRepo (sqlite)", () => {
  it("creates a schedule with sane defaults", async () => {
    const s = await driver.healthSchedules.create({
      orgId: org.id,
      targetId: target.id,
      intervalSeconds: 120,
      probeNames: ["smoke"],
    });
    expect(s.id).toMatch(/^[0-9A-Z]{26}$/);
    expect(s.orgId).toBe(org.id);
    expect(s.targetId).toBe(target.id);
    expect(s.intervalSeconds).toBe(120);
    expect(s.probeNames).toEqual(["smoke"]);
    expect(s.active).toBe(true);
    expect(s.lastRunAt).toBeNull();
  });

  it("rejects intervals < 60s at the schema level", async () => {
    await expect(
      driver.healthSchedules.create({
        orgId: org.id,
        targetId: target.id,
        intervalSeconds: 5,
        probeNames: [],
      }),
    ).rejects.toBeDefined();
  });

  it("listForOrg returns undeleted schedules", async () => {
    const a = await driver.healthSchedules.create({
      orgId: org.id,
      targetId: target.id,
      intervalSeconds: 60,
      probeNames: [],
    });
    const b = await driver.healthSchedules.create({
      orgId: org.id,
      targetId: target.id,
      intervalSeconds: 120,
      probeNames: [],
    });
    await driver.healthSchedules.softDelete(b.id);
    const list = await driver.healthSchedules.listForOrg(org.id);
    expect(list.map((x) => x.id)).toEqual([a.id]);
  });

  it("listActive filters out disabled schedules", async () => {
    const a = await driver.healthSchedules.create({
      orgId: org.id,
      targetId: target.id,
      intervalSeconds: 60,
      probeNames: [],
    });
    const b = await driver.healthSchedules.create({
      orgId: org.id,
      targetId: target.id,
      intervalSeconds: 60,
      probeNames: [],
      active: false,
    });
    const active = await driver.healthSchedules.listActive(org.id);
    expect(active.map((x) => x.id).sort()).toEqual([a.id].sort());
    expect(active.map((x) => x.id)).not.toContain(b.id);
  });

  it("update toggles active and patches probeNames", async () => {
    const s = await driver.healthSchedules.create({
      orgId: org.id,
      targetId: target.id,
      intervalSeconds: 60,
      probeNames: ["a"],
    });
    const updated = await driver.healthSchedules.update(s.id, {
      active: false,
      probeNames: ["a", "b"],
    });
    expect(updated.active).toBe(false);
    expect(updated.probeNames).toEqual(["a", "b"]);
  });

  it("update advances lastRunAt without clobbering other fields", async () => {
    const s = await driver.healthSchedules.create({
      orgId: org.id,
      targetId: target.id,
      intervalSeconds: 60,
      probeNames: ["a"],
    });
    const t = "2026-05-14T12:00:00.000Z";
    const updated = await driver.healthSchedules.update(s.id, {
      lastRunAt: t,
    });
    expect(updated.lastRunAt).toBe(t);
    expect(updated.probeNames).toEqual(["a"]);
    expect(updated.active).toBe(true);
  });

  it("softDelete makes the schedule invisible to get/list", async () => {
    const s = await driver.healthSchedules.create({
      orgId: org.id,
      targetId: target.id,
      intervalSeconds: 60,
      probeNames: [],
    });
    await driver.healthSchedules.softDelete(s.id);
    expect(await driver.healthSchedules.get(s.id)).toBeNull();
    await expect(
      driver.healthSchedules.softDelete(s.id),
    ).rejects.toBeInstanceOf(StorageNotFoundError);
  });

  it("listForTarget filters by target", async () => {
    const otherTarget = await driver.targets.create({
      orgId: org.id,
      name: "t2",
      kind: "vm_test",
      connection: { vmName: "vm2" },
    });
    const a = await driver.healthSchedules.create({
      orgId: org.id,
      targetId: target.id,
      intervalSeconds: 60,
      probeNames: [],
    });
    await driver.healthSchedules.create({
      orgId: org.id,
      targetId: otherTarget.id,
      intervalSeconds: 60,
      probeNames: [],
    });
    const forT1 = await driver.healthSchedules.listForTarget(target.id);
    expect(forT1.map((x) => x.id)).toEqual([a.id]);
  });
});

describe("dueSchedules decision (pure)", () => {
  const base: HealthSchedule = {
    id: "01J0000000000000000000000A",
    orgId: "org",
    targetId: "tgt",
    intervalSeconds: 60,
    probeNames: [],
    lastRunAt: null,
    active: true,
    createdAt: "2026-05-14T12:00:00.000Z",
    updatedAt: "2026-05-14T12:00:00.000Z",
    deletedAt: null,
  };
  const t0 = Date.parse(base.createdAt);

  it("returns nothing when nothing is due", () => {
    expect(dueSchedules([base], t0 + 30 * 1000)).toEqual([]);
  });

  it("fires a never-run schedule once its grace window elapses", () => {
    expect(dueSchedules([base], t0 + 60 * 1000)).toHaveLength(1);
  });

  it("re-fires once lastRunAt + interval elapses", () => {
    const ran = {
      ...base,
      lastRunAt: "2026-05-14T12:05:00.000Z",
    };
    const lastMs = Date.parse(ran.lastRunAt);
    // Just before due: not yet.
    expect(dueSchedules([ran], lastMs + 30 * 1000)).toEqual([]);
    // At the boundary: due.
    expect(dueSchedules([ran], lastMs + 60 * 1000)).toHaveLength(1);
  });

  it("skips schedules with unparseable timestamps", () => {
    const broken = { ...base, createdAt: "not-a-date" };
    expect(dueSchedules([broken], t0 + 9999)).toEqual([]);
  });

  it("partitions a heterogeneous list correctly", () => {
    const fresh: HealthSchedule = { ...base, id: "fresh" };
    const stale: HealthSchedule = {
      ...base,
      id: "stale",
      lastRunAt: "2026-05-14T11:00:00.000Z",
    };
    const t = Date.parse("2026-05-14T12:00:30.000Z");
    const due = dueSchedules([fresh, stale], t);
    expect(due.map((s) => s.id)).toEqual(["stale"]);
  });
});
