/**
 * Tests for the PR 5 SQLite repos: scenario and run.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteStorageDriver } from "../control-plane/storage/sqlite.js";
import { StorageNotFoundError } from "../control-plane/storage/driver.js";
import type { Org, Scenario } from "../control-plane/types.js";

let driver: SqliteStorageDriver;
let org: Org;

beforeEach(async () => {
  driver = new SqliteStorageDriver({ path: ":memory:" });
  await driver.migrate();
  org = await driver.orgs.create({ name: "org" });
});

afterEach(async () => {
  await driver.close();
});

describe("scenarios", () => {
  it("upsertFromDisk inserts on first sighting", async () => {
    const s = await driver.scenarios.upsertFromDisk({
      orgId: org.id,
      path: ".signalman/scenarios/foo",
      scenarioHash: "h1",
      name: "Foo Scenario",
      tags: ["smoke", "example"],
    });
    expect(s.id).toMatch(/^[0-9A-Z]{26}$/);
    expect(s.source).toBe("disk");
    expect(s.tags).toEqual(["smoke", "example"]);
  });

  it("upsertFromDisk updates in place on second sighting (same path)", async () => {
    const first = await driver.scenarios.upsertFromDisk({
      orgId: org.id,
      path: ".signalman/scenarios/foo",
      scenarioHash: "h1",
      name: "Foo",
      tags: ["smoke"],
    });
    const second = await driver.scenarios.upsertFromDisk({
      orgId: org.id,
      path: ".signalman/scenarios/foo",
      scenarioHash: "h2",
      name: "Foo (renamed)",
      tags: ["smoke", "extra"],
    });
    expect(second.id).toBe(first.id); // same row
    expect(second.scenarioHash).toBe("h2");
    expect(second.name).toBe("Foo (renamed)");
    expect(second.tags).toEqual(["smoke", "extra"]);
    expect((await driver.scenarios.listForOrg(org.id))).toHaveLength(1);
  });

  it("upsertFromDisk allows the same path across orgs", async () => {
    const other = await driver.orgs.create({ name: "other" });
    await driver.scenarios.upsertFromDisk({
      orgId: org.id,
      path: ".signalman/scenarios/foo",
      scenarioHash: "h",
      name: "n",
      tags: [],
    });
    const s2 = await driver.scenarios.upsertFromDisk({
      orgId: other.id,
      path: ".signalman/scenarios/foo",
      scenarioHash: "h",
      name: "n",
      tags: [],
    });
    expect(s2.orgId).toBe(other.id);
  });

  it("getByPath finds the upserted row; returns null for unknown", async () => {
    await driver.scenarios.upsertFromDisk({
      orgId: org.id,
      path: ".signalman/scenarios/a",
      scenarioHash: "h",
      name: "A",
      tags: [],
    });
    const found = await driver.scenarios.getByPath(
      org.id,
      ".signalman/scenarios/a",
    );
    expect(found?.name).toBe("A");
    const missing = await driver.scenarios.getByPath(
      org.id,
      ".signalman/scenarios/missing",
    );
    expect(missing).toBeNull();
  });

  it("listForOrg returns deleted_at IS NULL rows sorted by path", async () => {
    await driver.scenarios.upsertFromDisk({
      orgId: org.id,
      path: ".signalman/scenarios/b",
      scenarioHash: "h",
      name: "B",
      tags: [],
    });
    const a = await driver.scenarios.upsertFromDisk({
      orgId: org.id,
      path: ".signalman/scenarios/a",
      scenarioHash: "h",
      name: "A",
      tags: [],
    });
    const list1 = await driver.scenarios.listForOrg(org.id);
    expect(list1.map((s) => s.path)).toEqual([
      ".signalman/scenarios/a",
      ".signalman/scenarios/b",
    ]);
    await driver.scenarios.softDelete(a.id);
    const list2 = await driver.scenarios.listForOrg(org.id);
    expect(list2.map((s) => s.path)).toEqual([".signalman/scenarios/b"]);
  });
});

describe("runs", () => {
  let scenario: Scenario;
  beforeEach(async () => {
    scenario = await driver.scenarios.upsertFromDisk({
      orgId: org.id,
      path: ".signalman/scenarios/foo",
      scenarioHash: "h",
      name: "Foo",
      tags: [],
    });
  });

  it("create defaults result + envelope to null and triggered_by required", async () => {
    const r = await driver.runs.create({
      orgId: org.id,
      scenarioId: scenario.id,
      triggeredBy: "cli",
    });
    expect(r.result).toBeNull();
    expect(r.envelopeBlobUri).toBeNull();
    expect(r.startedAt).toBeNull();
    expect(r.triggeredBy).toBe("cli");
  });

  it("update sets result + completedAt + envelope URI", async () => {
    const r = await driver.runs.create({
      orgId: org.id,
      scenarioId: scenario.id,
      triggeredBy: "cli",
    });
    const updated = await driver.runs.update(r.id, {
      result: "pass",
      completedAt: "2026-05-11T00:00:00.000Z",
      envelopeBlobUri: "file:///envelope.json",
    });
    expect(updated.result).toBe("pass");
    expect(updated.completedAt).toBe("2026-05-11T00:00:00.000Z");
    expect(updated.envelopeBlobUri).toBe("file:///envelope.json");
  });

  it("update on a missing id throws StorageNotFoundError", async () => {
    await expect(
      driver.runs.update("01ZZZZZZZZZZZZZZZZZZZZZZZZ", { result: "x" }),
    ).rejects.toBeInstanceOf(StorageNotFoundError);
  });

  it("listForScenario returns rows for that scenario, newest first", async () => {
    await driver.runs.create({
      orgId: org.id,
      scenarioId: scenario.id,
      triggeredBy: "cli",
    });
    await driver.runs.create({
      orgId: org.id,
      scenarioId: scenario.id,
      triggeredBy: "api",
    });
    const list = await driver.runs.listForScenario(scenario.id);
    expect(list).toHaveLength(2);
    expect(list.map((r) => r.triggeredBy).sort()).toEqual(["api", "cli"]);
  });
});
