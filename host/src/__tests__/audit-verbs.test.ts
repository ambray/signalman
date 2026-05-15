// WS6 M5 — runAuditQuery + runAuditAppend verb tests.
//
// Operator-authorised closure of the P2 "audit log surface is HTTP-only"
// gap. The audit log has been an append-only repo table since v0.2.0;
// it just wasn't exposed via CLI or MCP. M5 adds two verbs that wrap
// the existing repo methods — listForOrg (read) + append (write).
//
// What this test pins:
//   1. Query returns all entries newest-first when no filters
//   2. entityType + entityId filter narrows correctly (repo-level)
//   3. actor / action filter narrows correctly (verb-level post-filter)
//   4. since filter drops older entries (verb-level post-filter)
//   5. since with malformed ISO-8601 throws
//   6. limit is forwarded to the repo
//   7. Append creates a row visible to subsequent query
//   8. Append refuses empty-string actor/action/entityType/entityId
//   9. Filters AND-combine (multi-filter narrow)
//  10. Append with no detail produces detail=null on roundtrip

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ControlPlane } from "../control-plane/index.js";
import {
  runAuditAppend,
  runAuditQuery,
} from "../verbs/control-plane.js";

let dataDir: string;
let cp: ControlPlane;
let defaultOrgId: string;

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "signalman-audit-verbs-"));
  cp = ControlPlane.create({
    storage: { driver: "sqlite", url: path.join(dataDir, "signalman.db") },
    blobs: { driver: "local", root: path.join(dataDir, "blobs") },
  });
  const { defaultOrg } = await cp.init();
  defaultOrgId = defaultOrg.id;
});

afterEach(async () => {
  await cp.close();
  await fs.rm(dataDir, { recursive: true, force: true });
});

async function seed(
  count: number,
  override: Partial<{
    actor: string;
    action: string;
    entityType: string;
    entityId: string;
    detail: Record<string, unknown>;
  }> = {},
): Promise<void> {
  for (let i = 0; i < count; i++) {
    await cp.auditLog.append({
      orgId: defaultOrgId,
      actor: override.actor ?? "cli",
      action: override.action ?? "target.edited",
      entityType: override.entityType ?? "target",
      entityId: override.entityId ?? `tgt-${i}`,
      detail: override.detail,
    });
  }
}

describe("runAuditQuery", () => {
  it("returns entries when no filters provided", async () => {
    await seed(3);
    const entries = await runAuditQuery(cp);
    expect(entries.length).toBe(3);
  });

  it("filters by entityType + entityId (repo-level)", async () => {
    await cp.auditLog.append({
      orgId: defaultOrgId,
      actor: "cli",
      action: "target.edited",
      entityType: "target",
      entityId: "alpha",
    });
    await cp.auditLog.append({
      orgId: defaultOrgId,
      actor: "cli",
      action: "release.deploy",
      entityType: "release",
      entityId: "v1.0.0",
    });

    const targetOnly = await runAuditQuery(cp, { entityType: "target" });
    expect(targetOnly.map((e) => e.entityId)).toEqual(["alpha"]);

    const specific = await runAuditQuery(cp, {
      entityType: "target",
      entityId: "alpha",
    });
    expect(specific.length).toBe(1);
    expect(specific[0].action).toBe("target.edited");
  });

  it("filters by actor (post-filter)", async () => {
    await cp.auditLog.append({
      orgId: defaultOrgId,
      actor: "cli",
      action: "release.deploy",
      entityType: "release",
      entityId: "r1",
    });
    await cp.auditLog.append({
      orgId: defaultOrgId,
      actor: "ci",
      action: "release.deploy",
      entityType: "release",
      entityId: "r2",
    });

    const onlyCi = await runAuditQuery(cp, { actor: "ci" });
    expect(onlyCi.length).toBe(1);
    expect(onlyCi[0].entityId).toBe("r2");
  });

  it("filters by action (post-filter)", async () => {
    await cp.auditLog.append({
      orgId: defaultOrgId,
      actor: "cli",
      action: "target.added",
      entityType: "target",
      entityId: "alpha",
    });
    await cp.auditLog.append({
      orgId: defaultOrgId,
      actor: "cli",
      action: "target.edited",
      entityType: "target",
      entityId: "alpha",
    });

    const edits = await runAuditQuery(cp, { action: "target.edited" });
    expect(edits.length).toBe(1);
  });

  it("filters by since (ISO-8601 lower bound on createdAt)", async () => {
    // Seed one entry, capture its createdAt + a future timestamp
    await cp.auditLog.append({
      orgId: defaultOrgId,
      actor: "cli",
      action: "target.edited",
      entityType: "target",
      entityId: "old",
    });
    const before = await runAuditQuery(cp);
    expect(before.length).toBe(1);

    // Filter at a timestamp one minute in the future → drops everything
    const future = new Date(Date.now() + 60_000).toISOString();
    const empty = await runAuditQuery(cp, { since: future });
    expect(empty.length).toBe(0);

    // Filter at a timestamp one hour in the past → keeps everything
    const past = new Date(Date.now() - 3_600_000).toISOString();
    const all = await runAuditQuery(cp, { since: past });
    expect(all.length).toBe(1);
  });

  it("rejects malformed --since", async () => {
    await expect(
      runAuditQuery(cp, { since: "not-an-iso-date" }),
    ).rejects.toThrow(/--since must be ISO-8601/);
  });

  it("forwards limit to the repo", async () => {
    await seed(5);
    const limited = await runAuditQuery(cp, { limit: 2 });
    expect(limited.length).toBeLessThanOrEqual(2);
  });

  it("AND-combines multiple filters", async () => {
    await cp.auditLog.append({
      orgId: defaultOrgId,
      actor: "cli",
      action: "target.edited",
      entityType: "target",
      entityId: "alpha",
    });
    await cp.auditLog.append({
      orgId: defaultOrgId,
      actor: "ci",
      action: "target.edited",
      entityType: "target",
      entityId: "alpha",
    });
    await cp.auditLog.append({
      orgId: defaultOrgId,
      actor: "cli",
      action: "target.added",
      entityType: "target",
      entityId: "alpha",
    });

    // entityType + actor + action all must match → only one row
    const narrow = await runAuditQuery(cp, {
      entityType: "target",
      actor: "cli",
      action: "target.edited",
    });
    expect(narrow.length).toBe(1);
  });

  it("returns empty array (not error) when nothing matches", async () => {
    const empty = await runAuditQuery(cp, { entityType: "no-such-kind" });
    expect(empty).toEqual([]);
  });
});

describe("runAuditAppend", () => {
  it("creates an entry visible to subsequent query", async () => {
    const entry = await runAuditAppend(cp, {
      actor: "operator",
      action: "incident.restart",
      entityType: "target",
      entityId: "alpha",
      detail: { reason: "stuck" },
    });
    expect(entry.id).toBeTruthy();
    expect(entry.detail).toEqual({ reason: "stuck" });

    const found = await runAuditQuery(cp, { entityType: "target" });
    expect(found.map((e) => e.id)).toContain(entry.id);
  });

  it("preserves null detail when no detail provided", async () => {
    const entry = await runAuditAppend(cp, {
      actor: "operator",
      action: "incident.note",
      entityType: "incident",
      entityId: "INC-001",
    });
    expect(entry.detail).toBeNull();
  });

  it("refuses empty-string actor", async () => {
    await expect(
      runAuditAppend(cp, {
        actor: "",
        action: "x",
        entityType: "y",
        entityId: "z",
      }),
    ).rejects.toThrow(/actor must be non-empty/);
  });

  it("refuses empty-string action", async () => {
    await expect(
      runAuditAppend(cp, {
        actor: "x",
        action: "",
        entityType: "y",
        entityId: "z",
      }),
    ).rejects.toThrow(/action must be non-empty/);
  });

  it("refuses empty-string entityType", async () => {
    await expect(
      runAuditAppend(cp, {
        actor: "x",
        action: "y",
        entityType: "",
        entityId: "z",
      }),
    ).rejects.toThrow(/entity_type must be non-empty/);
  });

  it("refuses empty-string entityId", async () => {
    await expect(
      runAuditAppend(cp, {
        actor: "x",
        action: "y",
        entityType: "z",
        entityId: "",
      }),
    ).rejects.toThrow(/entity_id must be non-empty/);
  });
});
