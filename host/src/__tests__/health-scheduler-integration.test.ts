/**
 * Integration tests for the health scheduler tick.
 *
 * Layer: scheduler → repo + audit log + injected probe invoker, all
 * over an in-memory SQLite ControlPlane. Verifies that `runSchedulerTick`:
 *   - picks only due, active, undeleted schedules
 *   - advances `last_run_at` to `now`
 *   - emits `health-tick` on every run and `health-failed` on probe
 *     failures
 *   - writes an audit-log row per tick (pass vs fail vs error)
 *   - tolerates infrastructure errors without poisoning the loop
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ControlPlane } from "../control-plane/index.js";
import {
  runSchedulerTick,
  type ProbeInvoker,
  type SchedulerEvent,
} from "../control-plane/scheduler/index.js";
import type { HealthSchedule, Org, Target } from "../control-plane/types.js";

let dataDir: string;
let cp: ControlPlane;
let org: Org;
let target: Target;

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "signalman-scheduler-"));
  cp = ControlPlane.create({
    storage: { driver: "sqlite", url: path.join(dataDir, "signalman.db") },
    blobs: { driver: "local", root: path.join(dataDir, "blobs") },
  });
  const init = await cp.init();
  org = init.defaultOrg;
  target = await cp.targets.create({
    orgId: org.id,
    name: "t1",
    kind: "vm_test",
    connection: { vmName: "vm1" },
  });
});

afterEach(async () => {
  await cp.close();
  await fs.rm(dataDir, { recursive: true, force: true });
});

function makeFakeNow(initial: string | Date): { now: () => Date; advance: (ms: number) => void } {
  let ms = typeof initial === "string" ? Date.parse(initial) : initial.getTime();
  return {
    now: () => new Date(ms),
    advance: (delta) => {
      ms += delta;
    },
  };
}

/**
 * Anchor a fake clock to a schedule's createdAt + offset. Schedules
 * are created via `cp.healthSchedules.create()` which stamps real
 * time; tests need a fake clock that sits just after that real time
 * for `dueSchedules` arithmetic to make sense.
 */
function fakeNowAfter(schedule: HealthSchedule, offsetMs: number) {
  const base = new Date(Date.parse(schedule.createdAt) + offsetMs);
  return makeFakeNow(base);
}

function makeRecorder(): { events: SchedulerEvent[]; emit: (e: SchedulerEvent) => void } {
  const events: SchedulerEvent[] = [];
  return { events, emit: (e) => events.push(e) };
}

function passingInvoker(): ProbeInvoker {
  return async ({ schedule }) => ({
    reachable: true,
    probes: [{ name: "smoke", status: "pass" }],
    deploymentId: `dep-${schedule.id.slice(-4)}`,
  });
}

function failingInvoker(): ProbeInvoker {
  return async ({ schedule }) => ({
    reachable: true,
    probes: [{ name: "smoke", status: "fail" }],
    deploymentId: `dep-${schedule.id.slice(-4)}`,
  });
}

describe("runSchedulerTick", () => {
  it("does nothing when no schedules exist", async () => {
    const fake = makeFakeNow("2026-05-14T12:00:00.000Z");
    const rec = makeRecorder();
    const processed = await runSchedulerTick({
      controlPlane: cp,
      invoke: passingInvoker(),
      now: fake.now,
      emit: rec.emit,
    });
    expect(processed).toBe(0);
    expect(rec.events).toEqual([]);
  });

  it("fires a due schedule, advances lastRunAt, and emits health-tick", async () => {
    const schedule = await cp.healthSchedules.create({
      orgId: org.id,
      targetId: target.id,
      intervalSeconds: 60,
      probeNames: ["smoke"],
    });
    // Not due yet at +30s.
    const fake = fakeNowAfter(schedule, 30_000);
    const rec1 = makeRecorder();
    expect(
      await runSchedulerTick({
        controlPlane: cp,
        invoke: passingInvoker(),
        now: fake.now,
        emit: rec1.emit,
      }),
    ).toBe(0);

    // Advance past the interval and tick again.
    fake.advance(60_000);
    const rec2 = makeRecorder();
    expect(
      await runSchedulerTick({
        controlPlane: cp,
        invoke: passingInvoker(),
        now: fake.now,
        emit: rec2.emit,
      }),
    ).toBe(1);
    const reloaded = await cp.healthSchedules.get(schedule.id);
    expect(reloaded?.lastRunAt).toBe(fake.now().toISOString());
    expect(rec2.events.map((e) => e.kind)).toEqual(["health-tick"]);
  });

  it("emits health-failed when a probe fails", async () => {
    const schedule = await cp.healthSchedules.create({
      orgId: org.id,
      targetId: target.id,
      intervalSeconds: 60,
      probeNames: ["smoke"],
    });
    const fake = fakeNowAfter(schedule, 90_000);
    const rec = makeRecorder();
    await runSchedulerTick({
      controlPlane: cp,
      invoke: failingInvoker(),
      now: fake.now,
      emit: rec.emit,
    });
    expect(rec.events.map((e) => e.kind)).toEqual([
      "health-tick",
      "health-failed",
    ]);
  });

  it("emits health-failed when reachability fails", async () => {
    const schedule = await cp.healthSchedules.create({
      orgId: org.id,
      targetId: target.id,
      intervalSeconds: 60,
      probeNames: [],
    });
    const fake = fakeNowAfter(schedule, 90_000);
    const rec = makeRecorder();
    const unreachable: ProbeInvoker = async () => ({
      reachable: false,
      probes: [],
      deploymentId: null,
      detail: "no route",
    });
    await runSchedulerTick({
      controlPlane: cp,
      invoke: unreachable,
      now: fake.now,
      emit: rec.emit,
    });
    expect(rec.events.map((e) => e.kind)).toEqual([
      "health-tick",
      "health-failed",
    ]);
  });

  it("skips disabled schedules", async () => {
    const schedule = await cp.healthSchedules.create({
      orgId: org.id,
      targetId: target.id,
      intervalSeconds: 60,
      probeNames: [],
      active: false,
    });
    const fake = fakeNowAfter(schedule, 90_000);
    const rec = makeRecorder();
    const processed = await runSchedulerTick({
      controlPlane: cp,
      invoke: passingInvoker(),
      now: fake.now,
      emit: rec.emit,
    });
    expect(processed).toBe(0);
    expect(rec.events).toEqual([]);
  });

  it("emits schedule-error and advances watermark on invoker throw", async () => {
    const schedule = await cp.healthSchedules.create({
      orgId: org.id,
      targetId: target.id,
      intervalSeconds: 60,
      probeNames: [],
    });
    const fake = fakeNowAfter(schedule, 90_000);
    const rec = makeRecorder();
    const throwingInvoker: ProbeInvoker = async () => {
      throw new Error("backend unavailable");
    };
    await runSchedulerTick({
      controlPlane: cp,
      invoke: throwingInvoker,
      now: fake.now,
      emit: rec.emit,
    });
    expect(rec.events.map((e) => e.kind)).toEqual(["schedule-error"]);
    const reloaded = await cp.healthSchedules.get(schedule.id);
    // Watermark advanced so the next tick doesn't re-spam the same
    // broken schedule.
    expect(reloaded?.lastRunAt).toBe(fake.now().toISOString());
  });

  it("appends an audit-log row on every fired schedule", async () => {
    const schedule = await cp.healthSchedules.create({
      orgId: org.id,
      targetId: target.id,
      intervalSeconds: 60,
      probeNames: [],
    });
    const fake = fakeNowAfter(schedule, 90_000);
    await runSchedulerTick({
      controlPlane: cp,
      invoke: passingInvoker(),
      now: fake.now,
      emit: () => undefined,
    });
    const audit = await cp.auditLog.listForOrg(org.id, {
      entityType: "health_schedule",
    });
    expect(audit.some((a) => a.action === "health.scheduled.pass")).toBe(true);
  });

  it("processes multiple due schedules in one tick", async () => {
    const target2 = await cp.targets.create({
      orgId: org.id,
      name: "t2",
      kind: "vm_test",
      connection: { vmName: "vm2" },
    });
    const s1 = await cp.healthSchedules.create({
      orgId: org.id,
      targetId: target.id,
      intervalSeconds: 60,
      probeNames: [],
    });
    await cp.healthSchedules.create({
      orgId: org.id,
      targetId: target2.id,
      intervalSeconds: 60,
      probeNames: [],
    });
    const fake = fakeNowAfter(s1, 90_000);
    const rec = makeRecorder();
    const processed = await runSchedulerTick({
      controlPlane: cp,
      invoke: passingInvoker(),
      now: fake.now,
      emit: rec.emit,
    });
    expect(processed).toBe(2);
  });

  it("ignores soft-deleted schedules", async () => {
    const schedule = await cp.healthSchedules.create({
      orgId: org.id,
      targetId: target.id,
      intervalSeconds: 60,
      probeNames: [],
    });
    const fake = fakeNowAfter(schedule, 90_000);
    await cp.healthSchedules.softDelete(schedule.id);
    const rec = makeRecorder();
    const processed = await runSchedulerTick({
      controlPlane: cp,
      invoke: passingInvoker(),
      now: fake.now,
      emit: rec.emit,
    });
    expect(processed).toBe(0);
    expect(rec.events).toEqual([]);
  });
});

describe("startScheduler loop", () => {
  it("ticks at the configured interval and stops cleanly", async () => {
    const { startScheduler } = await import(
      "../control-plane/scheduler/index.js"
    );
    const schedule = await cp.healthSchedules.create({
      orgId: org.id,
      targetId: target.id,
      intervalSeconds: 60,
      probeNames: [],
    });
    const fake = fakeNowAfter(schedule, 90_000);
    let invokeCount = 0;
    const handle = startScheduler({
      controlPlane: cp,
      invoke: async () => {
        invokeCount += 1;
        return {
          reachable: true,
          probes: [],
          deploymentId: null,
        };
      },
      now: fake.now,
      tickIntervalMs: 20,
      emit: () => undefined,
    });
    await new Promise((res) => setTimeout(res, 80));
    await handle.stop();
    expect(invokeCount).toBeGreaterThanOrEqual(1);
  });

  it("surfaces tick-level throws as schedule-error events and keeps looping", async () => {
    const { startScheduler } = await import(
      "../control-plane/scheduler/index.js"
    );
    // Closing the control plane mid-flight forces listActive() to
    // throw on the next tick — simulates a transient DB outage.
    let invokeCount = 0;
    const events: SchedulerEvent[] = [];
    const handle = startScheduler({
      controlPlane: cp,
      invoke: async () => {
        invokeCount += 1;
        return { reachable: true, probes: [], deploymentId: null };
      },
      tickIntervalMs: 10,
      emit: (e) => events.push(e),
    });
    // Let it complete at least one tick, then close the DB out from
    // under it.
    await new Promise((res) => setTimeout(res, 30));
    await cp.close();
    await new Promise((res) => setTimeout(res, 30));
    await handle.stop();
    expect(events.some((e) => e.kind === "schedule-error")).toBe(true);
    // Test cleanup expects an open cp; re-open for afterEach.
    cp = ControlPlane.create({
      storage: { driver: "sqlite", url: path.join(dataDir, "signalman.db") },
      blobs: { driver: "local", root: path.join(dataDir, "blobs") },
    });
    await cp.init();
  });
});

describe("schedule verb integration", () => {
  it("verb-layer add → list → disable round trip persists state", async () => {
    const {
      runScheduleAdd,
      runScheduleList,
      runScheduleDisable,
      runScheduleRemove,
    } = await import("../verbs/control-plane.js");

    const entry = await runScheduleAdd(cp, {
      targetName: target.name,
      intervalSeconds: 120,
      probeNames: ["smoke"],
    });
    expect(entry.schedule.intervalSeconds).toBe(120);

    let list = await runScheduleList(cp);
    expect(list).toHaveLength(1);
    expect(list[0].target.name).toBe(target.name);

    const disabled = await runScheduleDisable(cp, { id: entry.schedule.id });
    expect(disabled.active).toBe(false);

    await runScheduleRemove(cp, { id: entry.schedule.id });
    list = await runScheduleList(cp);
    expect(list).toEqual([]);
  });

  it("verb-layer add rejects intervals < 60s before hitting the DB", async () => {
    const { runScheduleAdd } = await import("../verbs/control-plane.js");
    await expect(
      runScheduleAdd(cp, {
        targetName: target.name,
        intervalSeconds: 30,
        probeNames: [],
      }),
    ).rejects.toThrow(/interval-seconds must be >= 60/);
  });

  it("verb-layer add fails cleanly on unknown target", async () => {
    const { runScheduleAdd } = await import("../verbs/control-plane.js");
    await expect(
      runScheduleAdd(cp, {
        targetName: "no-such-target",
        intervalSeconds: 60,
        probeNames: [],
      }),
    ).rejects.toThrow(/target not found/);
  });
});
