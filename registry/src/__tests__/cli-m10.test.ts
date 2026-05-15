// WS6 wave-3 M10.6 — CLI tests for virtual / audit / forensic verbs.
//
// Drives runCli() directly (matches the existing CLI test pattern)
// against a temp storage root. No HTTP server involved; the verbs
// open the storage directly.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { runCli } from "../cli.js";
import { LocalFsRegistryStorage } from "../storage/registry-storage.js";

let dataDir: string;

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "signalman-cli-m10-"));
});

afterEach(async () => {
  await fs.rm(dataDir, { recursive: true, force: true });
});

describe("CLI virtual add/list/remove", () => {
  it("virtual add: rejects missing flags with usage exit 2", async () => {
    const r = await runCli(["virtual", "add"]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toMatch(/usage/);
  });

  it("virtual add → list → remove round-trip", async () => {
    const add = await runCli([
      "virtual",
      "add",
      "--storage-root",
      dataDir,
      "--org",
      "acme",
      "--kind",
      "cargo",
      "--upstream",
      "https://index.crates.io",
      "--resign",
    ]);
    expect(add.exitCode).toBe(0);
    const row = JSON.parse(add.stdout) as { id: string; org: string };
    expect(row.org).toBe("acme");
    expect(row.id).toBeTruthy();

    const list = await runCli([
      "virtual",
      "list",
      "--storage-root",
      dataDir,
      "--org",
      "acme",
    ]);
    expect(list.exitCode).toBe(0);
    const rows = JSON.parse(list.stdout) as Array<{ id: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(row.id);

    const rm = await runCli([
      "virtual",
      "remove",
      "--storage-root",
      dataDir,
      "--id",
      row.id,
    ]);
    expect(rm.exitCode).toBe(0);

    const list2 = await runCli([
      "virtual",
      "list",
      "--storage-root",
      dataDir,
      "--org",
      "acme",
    ]);
    expect(list2.exitCode).toBe(0);
    expect(JSON.parse(list2.stdout)).toEqual([]);
  });

  it("virtual add: rejects bad kind", async () => {
    const r = await runCli([
      "virtual",
      "add",
      "--storage-root",
      dataDir,
      "--org",
      "acme",
      "--kind",
      "garbage",
      "--upstream",
      "https://example.test",
    ]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toMatch(/unknown kind/);
  });

  it("virtual add: --allow / --deny comma-list parsed", async () => {
    const add = await runCli([
      "virtual",
      "add",
      "--storage-root",
      dataDir,
      "--org",
      "acme",
      "--kind",
      "cargo",
      "--upstream",
      "https://example.test",
      "--allow",
      "tokio*,serde",
      "--deny",
      "internal-*",
    ]);
    expect(add.exitCode).toBe(0);
    const row = JSON.parse(add.stdout) as {
      config: { allow_patterns?: string[]; deny_patterns?: string[] };
    };
    expect(row.config.allow_patterns).toEqual(["tokio*", "serde"]);
    expect(row.config.deny_patterns).toEqual(["internal-*"]);
  });
});

describe("CLI audit", () => {
  it("rejects missing --storage-root", async () => {
    const r = await runCli(["audit"]);
    expect(r.exitCode).toBe(2);
    // Usage line goes to stderr; exit code is the actionable signal.
  });

  it("returns empty array on empty registry", async () => {
    const r = await runCli([
      "audit",
      "--storage-root",
      dataDir,
    ]);
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual([]);
  });

  it("surfaces existing audit entries", async () => {
    // Seed an audit entry via direct storage access
    const storage = LocalFsRegistryStorage.fromRoot(dataDir);
    storage.index.appendAuditEntry({
      action: "upload",
      entityType: "cargo_crate",
      entityId: "cargo/acme/x@1.0.0",
      actor: "test-token-prefix",
    });
    storage.close();

    const r = await runCli([
      "audit",
      "--storage-root",
      dataDir,
      "--action",
      "upload",
    ]);
    expect(r.exitCode).toBe(0);
    const entries = JSON.parse(r.stdout) as Array<{ action: string }>;
    expect(entries).toHaveLength(1);
    expect(entries[0].action).toBe("upload");
  });

  it("rejects bad limit", async () => {
    const r = await runCli([
      "audit",
      "--storage-root",
      dataDir,
      "--limit",
      "-5",
    ]);
    expect(r.exitCode).toBe(2);
  });
});

describe("CLI forensic", () => {
  it("summary: empty registry returns zero total", async () => {
    const r = await runCli([
      "forensic",
      "summary",
      "--storage-root",
      dataDir,
    ]);
    expect(r.exitCode).toBe(0);
    const body = JSON.parse(r.stdout) as { total_manifests: number };
    expect(body.total_manifests).toBe(0);
  });

  it("upstreams: empty registry returns []", async () => {
    const r = await runCli([
      "forensic",
      "upstreams",
      "--storage-root",
      dataDir,
    ]);
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual([]);
  });

  it("rejects missing --storage-root", async () => {
    const r = await runCli(["forensic", "summary"]);
    expect(r.exitCode).toBe(2);
  });

  it("rejects unknown subcommand", async () => {
    const r = await runCli([
      "forensic",
      "garbage",
      "--storage-root",
      dataDir,
    ]);
    expect(r.exitCode).toBe(2);
  });
});
