/**
 * v0.3.0-5 sub-task 5 — budget gate.
 *
 * Three layers per the workstream brief:
 *   - **Unit**: month-bounds math, threshold dispatch, singleton
 *     accessor.
 *   - **Integration**: gate wired to an in-memory SQLite storage
 *     driver; provision flow that records start + terminate.
 *   - **System**: budget-exceeded raises before any vendor API
 *     call; budget warning surfaces at the soft-warn boundary.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CloudBudgetGate,
  monthBoundsUtc,
  getBudgetGate,
  setBudgetGate,
} from "../cloud/budget.js";
import {
  CloudBackendError,
  type CloudInstanceConfig,
} from "../cloud/types.js";
import { SqliteStorageDriver } from "../control-plane/storage/sqlite.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(
  __dirname,
  "..",
  "control-plane",
  "storage",
  "migrations",
);

function newStorage(): SqliteStorageDriver {
  return new SqliteStorageDriver({ path: ":memory:", migrationsDir: MIGRATIONS_DIR });
}

// ── UNIT: month-bounds math ───────────────────────────────────────

describe("monthBoundsUtc — calendar-month boundaries (UTC)", () => {
  it("returns [first of month 00:00Z, first of next month 00:00Z)", () => {
    const at = new Date(Date.UTC(2026, 4, 14, 13, 45, 12)); // May 14 2026 UTC
    const { startedAtFrom, startedAtTo } = monthBoundsUtc(at);
    expect(startedAtFrom).toBe("2026-05-01T00:00:00.000Z");
    expect(startedAtTo).toBe("2026-06-01T00:00:00.000Z");
  });

  it("rolls over December correctly", () => {
    const at = new Date(Date.UTC(2026, 11, 31, 23, 59, 59));
    const { startedAtFrom, startedAtTo } = monthBoundsUtc(at);
    expect(startedAtFrom).toBe("2026-12-01T00:00:00.000Z");
    expect(startedAtTo).toBe("2027-01-01T00:00:00.000Z");
  });

  it("first-millisecond-of-month is included in its own month", () => {
    const at = new Date(Date.UTC(2026, 5, 1, 0, 0, 0, 0));
    const { startedAtFrom } = monthBoundsUtc(at);
    expect(startedAtFrom).toBe("2026-06-01T00:00:00.000Z");
  });
});

// ── UNIT: singleton accessor ──────────────────────────────────────

describe("setBudgetGate / getBudgetGate", () => {
  afterEach(() => setBudgetGate(null));

  it("returns null when not set (back-compat)", () => {
    setBudgetGate(null);
    expect(getBudgetGate()).toBeNull();
  });

  it("stores and returns the same instance", () => {
    const storage = newStorage();
    const gate = new CloudBudgetGate({
      budgets: storage.cloudBudgets,
      usage: storage.cloudUsage,
    });
    setBudgetGate(gate);
    expect(getBudgetGate()).toBe(gate);
  });

  it("clears the singleton when set to null", () => {
    setBudgetGate(
      new CloudBudgetGate({
        budgets: newStorage().cloudBudgets,
        usage: newStorage().cloudUsage,
      }),
    );
    setBudgetGate(null);
    expect(getBudgetGate()).toBeNull();
  });
});

// ── INTEGRATION: gate + storage ──────────────────────────────────

describe("CloudBudgetGate — integration with in-memory SQLite", () => {
  let storage: SqliteStorageDriver;

  beforeEach(async () => {
    storage = newStorage();
    await storage.migrate();
  });

  afterEach(async () => {
    await storage.close();
  });

  it("allows + flags warned: false when no budget is configured (unlimited)", async () => {
    const gate = new CloudBudgetGate({
      budgets: storage.cloudBudgets,
      usage: storage.cloudUsage,
    });
    const result = await gate.check("default", 1_000_000);
    expect(result.allowed).toBe(true);
    expect(result.warned).toBe(false);
    expect(result.limitCents).toBe(Number.POSITIVE_INFINITY);
  });

  it("flags warned: true when usage crosses softWarnPct", async () => {
    await storage.cloudBudgets.upsert({
      orgId: "acme",
      monthlyCentsLimit: 1000,
      softWarnPct: 80,
    });
    const fixedNow = new Date("2026-05-14T12:00:00.000Z");
    // Pre-seed 700¢ of usage in May 2026.
    await storage.cloudUsage.recordStart({
      orgId: "acme",
      backend: "aws",
      instanceId: "i-existing",
      instanceType: "t3.medium",
      region: "us-east-1",
      startedAt: "2026-05-10T00:00:00.000Z",
      estimatedCents: 700,
    });
    const gate = new CloudBudgetGate({
      budgets: storage.cloudBudgets,
      usage: storage.cloudUsage,
      now: () => fixedNow,
    });
    // Adding 100¢ => 800¢ total / 1000 limit = 80% → warned.
    const result = await gate.check("acme", 100);
    expect(result.allowed).toBe(true);
    expect(result.warned).toBe(true);
    expect(result.usageCents).toBe(700);
    expect(result.estimatedCents).toBe(100);
    expect(result.pctAfter).toBe(80);
  });

  it("throws budget_exceeded at 100%", async () => {
    await storage.cloudBudgets.upsert({
      orgId: "acme",
      monthlyCentsLimit: 1000,
    });
    await storage.cloudUsage.recordStart({
      orgId: "acme",
      backend: "aws",
      instanceId: "i-near-limit",
      instanceType: "t3.medium",
      region: "us-east-1",
      startedAt: "2026-05-10T00:00:00.000Z",
      estimatedCents: 950,
    });
    const fixedNow = new Date("2026-05-14T12:00:00.000Z");
    const gate = new CloudBudgetGate({
      budgets: storage.cloudBudgets,
      usage: storage.cloudUsage,
      now: () => fixedNow,
    });
    // Adding 100¢ => 1050¢ > 1000¢ limit.
    await expect(gate.check("acme", 100)).rejects.toThrowError(
      /budget_exceeded|exceed budget/i,
    );
    await expect(gate.check("acme", 100)).rejects.toBeInstanceOf(
      CloudBackendError,
    );
  });

  it("scopes usage to the calendar month — last month's spend doesn't count", async () => {
    await storage.cloudBudgets.upsert({
      orgId: "acme",
      monthlyCentsLimit: 1000,
    });
    // Last month's usage shouldn't roll over.
    await storage.cloudUsage.recordStart({
      orgId: "acme",
      backend: "aws",
      instanceId: "i-april",
      instanceType: "t3.medium",
      region: "us-east-1",
      startedAt: "2026-04-15T00:00:00.000Z",
      estimatedCents: 900,
    });
    const fixedNow = new Date("2026-05-14T12:00:00.000Z");
    const gate = new CloudBudgetGate({
      budgets: storage.cloudBudgets,
      usage: storage.cloudUsage,
      now: () => fixedNow,
    });
    const result = await gate.check("acme", 100);
    expect(result.allowed).toBe(true);
    expect(result.usageCents).toBe(0); // April spend ignored.
  });

  it("checkForConfig derives estimate from the cost table", async () => {
    await storage.cloudBudgets.upsert({
      orgId: "acme",
      monthlyCentsLimit: 100, // very small to trip the warn easily
    });
    const fixedNow = new Date("2026-05-14T12:00:00.000Z");
    const gate = new CloudBudgetGate({
      budgets: storage.cloudBudgets,
      usage: storage.cloudUsage,
      now: () => fixedNow,
    });
    const config: CloudInstanceConfig = {
      region: "us-east-1",
      instance_type: "t3.medium",
      image_ref: "ami-test",
      name: "test",
      org_id: "acme",
      ttl_minutes: 60,
    };
    const result = await gate.checkForConfig(config);
    // t3.medium @ us-east-1 for 60 min = 4¢.
    expect(result.estimatedCents).toBe(4);
    expect(result.usageCents).toBe(0);
  });

  it("recordStart inserts a usage row visible to subsequent gate checks", async () => {
    await storage.cloudBudgets.upsert({
      orgId: "acme",
      monthlyCentsLimit: 1000,
    });
    const fixedNow = new Date("2026-05-14T12:00:00.000Z");
    const gate = new CloudBudgetGate({
      budgets: storage.cloudBudgets,
      usage: storage.cloudUsage,
      now: () => fixedNow,
    });
    await gate.recordStart({
      orgId: "acme",
      backend: "aws",
      instanceId: "i-fresh",
      instanceType: "t3.medium",
      region: "us-east-1",
      ttlMinutes: 60,
    });
    const result = await gate.check("acme", 0);
    expect(result.usageCents).toBe(4); // the row we just recorded.
  });

  it("recordTerminate is idempotent on unknown instance", async () => {
    const gate = new CloudBudgetGate({
      budgets: storage.cloudBudgets,
      usage: storage.cloudUsage,
    });
    // No row exists; should not throw.
    await expect(
      gate.recordTerminate({ orgId: "acme", instanceId: "i-never-existed" }),
    ).resolves.toBeUndefined();
  });
});

// ── SYSTEM: full provision flow with gate ─────────────────────────

describe("CloudBudgetGate — system: gates a provision flow", () => {
  it("end-to-end: gate→recordStart→sumForRange reflects new usage", async () => {
    const storage = newStorage();
    await storage.migrate();
    try {
      await storage.cloudBudgets.upsert({
        orgId: "acme",
        monthlyCentsLimit: 10_000,
      });
      const fixedNow = new Date("2026-05-14T12:00:00.000Z");
      const gate = new CloudBudgetGate({
        budgets: storage.cloudBudgets,
        usage: storage.cloudUsage,
        now: () => fixedNow,
      });

      // Provision 5 t3.medium 60-min VMs (4¢ each = 20¢).
      for (let i = 0; i < 5; i++) {
        const config: CloudInstanceConfig = {
          region: "us-east-1",
          instance_type: "t3.medium",
          image_ref: "ami-test",
          name: `test-${i}`,
          org_id: "acme",
          ttl_minutes: 60,
        };
        const result = await gate.checkForConfig(config);
        expect(result.allowed).toBe(true);
        await gate.recordStart({
          orgId: "acme",
          backend: "aws",
          instanceId: `i-fake-${i}`,
          instanceType: config.instance_type,
          region: config.region,
          ttlMinutes: 60,
        });
      }

      const { startedAtFrom, startedAtTo } = monthBoundsUtc(fixedNow);
      const total = await storage.cloudUsage.sumForRange({
        orgId: "acme",
        startedAtFrom,
        startedAtTo,
      });
      expect(total).toBe(20);
    } finally {
      await storage.close();
    }
  });
});
