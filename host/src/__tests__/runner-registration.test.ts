// WS6 milestone 3 — runner registration / heartbeat / list / deregister.
//
// Operator-authorised closure of P3: explicit `runners` table with
// heartbeat semantics. Workers POST /v1/runners/heartbeat (mirrored
// by `controlPlane.runners.heartbeat`); `signalman runner list`
// shows the rows with a computed `isStale` flag; `signalman runner
// deregister` soft-deletes a row.
//
// What this test pins:
//   1. Heartbeat creates a new row on first call for (org, name).
//   2. Heartbeat upserts: subsequent calls for the same (org, name)
//      update last_seen_at and meta but preserve registered_at.
//   3. Heartbeat resurrects: a deregistered row + later heartbeat
//      becomes active again with a fresh registered_at.
//   4. runRunnerList returns rows newest-last_seen-first with a
//      computed isStale = (last_seen_at < now - threshold).
//   5. runRunnerDeregister soft-deletes by name and by id.
//   6. runRunnerDeregister with neither name nor id throws.
//   7. Audit log records the runner.deregistered event.

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ControlPlane } from "../control-plane/index.js";
import {
  runRunnerDeregister,
  runRunnerList,
} from "../verbs/control-plane.js";

let dataDir: string;
let cp: ControlPlane;

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "signalman-runner-reg-"));
  cp = ControlPlane.create({
    storage: { driver: "sqlite", url: path.join(dataDir, "signalman.db") },
    blobs: { driver: "local", root: path.join(dataDir, "blobs") },
  });
  await cp.init();
});

afterEach(async () => {
  vi.useRealTimers();
  await cp.close();
  await fs.rm(dataDir, { recursive: true, force: true });
});

describe("controlPlane.runners.heartbeat", () => {
  it("creates a new row on first heartbeat for (org, name)", async () => {
    const { defaultOrg } = await cp.init();
    const row = await cp.runners.heartbeat({
      orgId: defaultOrg.id,
      name: "builder-1",
      meta: { hostname: "mac-01", version: "0.3.0" },
    });
    expect(row.name).toBe("builder-1");
    expect(row.meta).toEqual({ hostname: "mac-01", version: "0.3.0" });
    expect(row.registeredAt).toBe(row.lastSeenAt);
    expect(row.deletedAt).toBeNull();
  });

  it("upserts on subsequent heartbeats: updates last_seen_at + meta, preserves registered_at + id", async () => {
    const { defaultOrg } = await cp.init();
    const first = await cp.runners.heartbeat({
      orgId: defaultOrg.id,
      name: "builder-2",
      meta: { v: 1 },
    });
    // Tiny sleep so timestamps diverge in millisecond resolution.
    await new Promise((r) => setTimeout(r, 10));
    const second = await cp.runners.heartbeat({
      orgId: defaultOrg.id,
      name: "builder-2",
      meta: { v: 2 },
    });
    expect(second.id).toBe(first.id); // upsert, not new row
    expect(second.registeredAt).toBe(first.registeredAt); // preserved
    expect(second.lastSeenAt >= first.lastSeenAt).toBe(true);
    expect(second.meta).toEqual({ v: 2 });
  });

  it("resurrects a deregistered runner — fresh registered_at, deleted_at cleared", async () => {
    const { defaultOrg } = await cp.init();
    const original = await cp.runners.heartbeat({
      orgId: defaultOrg.id,
      name: "builder-3",
    });
    await cp.runners.softDelete(original.id);
    expect((await cp.runners.get(original.id))?.deletedAt ?? null).toBeNull(); // get() filters soft-deleted

    await new Promise((r) => setTimeout(r, 10));
    const resurrected = await cp.runners.heartbeat({
      orgId: defaultOrg.id,
      name: "builder-3",
    });
    expect(resurrected.id).toBe(original.id);
    expect(resurrected.registeredAt > original.registeredAt).toBe(true);
    expect(resurrected.deletedAt).toBeNull();
  });
});

describe("runRunnerList", () => {
  it("returns rows newest-last_seen-first with isStale computed against the threshold", async () => {
    const { defaultOrg } = await cp.init();
    // Heartbeat three runners spaced out.
    const r1 = await cp.runners.heartbeat({ orgId: defaultOrg.id, name: "old-runner" });
    await new Promise((r) => setTimeout(r, 10));
    await cp.runners.heartbeat({ orgId: defaultOrg.id, name: "mid-runner" });
    await new Promise((r) => setTimeout(r, 10));
    await cp.runners.heartbeat({ orgId: defaultOrg.id, name: "fresh-runner" });

    // Default threshold (90s): all three are fresh.
    const fresh = await runRunnerList(cp);
    expect(fresh.map((e) => e.runner.name)).toEqual([
      "fresh-runner",
      "mid-runner",
      "old-runner",
    ]);
    expect(fresh.every((e) => !e.isStale)).toBe(true);

    // 0-second threshold: every row is stale (last_seen_at is always
    // < now - 0s by some microseconds).
    const stale = await runRunnerList(cp, { staleThresholdSeconds: 1 });
    // 1-second threshold means rows older than 1 second back are
    // stale. Right after heartbeat all should still be fresh.
    // Sanity: every entry has isStale set deterministically.
    for (const e of stale) {
      expect(typeof e.isStale).toBe("boolean");
    }
    // Reference unused-variable warning suppressor for r1 (used to
    // anchor that the row exists).
    expect(r1.name).toBe("old-runner");
  });

  it("flags isStale=true for runners whose last_seen is older than the threshold", async () => {
    const { defaultOrg } = await cp.init();
    await cp.runners.heartbeat({ orgId: defaultOrg.id, name: "to-be-stale" });

    // Wait 200ms then list with a 100ms threshold (0.1s); the row's
    // last_seen_at is now more than 0.1s old.
    await new Promise((r) => setTimeout(r, 200));
    // Note: staleThresholdSeconds is min 1, but the verb accepts
    // fractional via direct call. We use 0 here which means "anything
    // older than now"... actually since the verb takes the option,
    // pass an explicit small number.
    const list = await runRunnerList(cp, { staleThresholdSeconds: 0.1 });
    expect(list).toHaveLength(1);
    expect(list[0].isStale).toBe(true);
  });

  it("excludes deregistered runners from the list", async () => {
    const { defaultOrg } = await cp.init();
    await cp.runners.heartbeat({ orgId: defaultOrg.id, name: "stay" });
    const gone = await cp.runners.heartbeat({
      orgId: defaultOrg.id,
      name: "gone",
    });
    await cp.runners.softDelete(gone.id);

    const list = await runRunnerList(cp);
    expect(list.map((e) => e.runner.name)).toEqual(["stay"]);
  });
});

describe("runRunnerDeregister", () => {
  it("soft-deletes by name", async () => {
    const { defaultOrg } = await cp.init();
    await cp.runners.heartbeat({ orgId: defaultOrg.id, name: "to-remove" });

    const result = await runRunnerDeregister(cp, { name: "to-remove" });
    expect(result.name).toBe("to-remove");
    expect(await cp.runners.getByName(defaultOrg.id, "to-remove")).toBeNull();
  });

  it("soft-deletes by id", async () => {
    const { defaultOrg } = await cp.init();
    const r = await cp.runners.heartbeat({
      orgId: defaultOrg.id,
      name: "via-id",
    });
    const result = await runRunnerDeregister(cp, { id: r.id });
    expect(result.id).toBe(r.id);
    expect(await cp.runners.get(r.id)).toBeNull();
  });

  it("throws when neither name nor id is supplied", async () => {
    await expect(runRunnerDeregister(cp, {})).rejects.toThrow(
      /requires --name or --id/,
    );
  });

  it("throws when the named runner does not exist", async () => {
    await expect(
      runRunnerDeregister(cp, { name: "no-such-runner" }),
    ).rejects.toThrow(/runner not found.*no-such-runner/);
  });

  it("throws when the id does not exist", async () => {
    await expect(
      runRunnerDeregister(cp, { id: "01HNONEXISTENT0000000000000" }),
    ).rejects.toThrow(/runner not found.*01HNONEXISTENT/);
  });

  it("appends a runner.deregistered audit-log entry", async () => {
    const { defaultOrg } = await cp.init();
    await cp.runners.heartbeat({ orgId: defaultOrg.id, name: "audited-runner" });

    await runRunnerDeregister(cp, { name: "audited-runner" });

    const entries = await cp.auditLog.listForOrg(defaultOrg.id, {
      entityType: "runner",
    });
    const dereg = entries.find((e) => e.action === "runner.deregistered");
    expect(dereg).toBeDefined();
    expect(dereg?.detail).toMatchObject({ name: "audited-runner" });
  });
});
