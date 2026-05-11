/**
 * Tests for ControlPlane facade + default-org bootstrap.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ControlPlane,
  DEFAULT_ORG_NAME,
  ensureDefaultOrg,
  resolveControlPlaneConfig,
} from "../control-plane/index.js";
import { SqliteStorageDriver } from "../control-plane/storage/sqlite.js";

let dataDir: string;
let cp: ControlPlane;

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "signalman-cp-"));
  cp = ControlPlane.create({
    storage: { driver: "sqlite", url: path.join(dataDir, "signalman.db") },
    blobs: { driver: "local", root: path.join(dataDir, "blobs") },
  });
});

afterEach(async () => {
  await cp.close();
  await fs.rm(dataDir, { recursive: true, force: true });
});

describe("init", () => {
  it("runs migrations and creates the default org", async () => {
    const { defaultOrg } = await cp.init();
    expect(defaultOrg.name).toBe(DEFAULT_ORG_NAME);
    expect(defaultOrg.tier).toBe("free");
  });

  it("is idempotent across multiple calls", async () => {
    const a = await cp.init();
    const b = await cp.init();
    expect(b.defaultOrg.id).toBe(a.defaultOrg.id);
    const orgs = await cp.orgs.list();
    expect(orgs).toHaveLength(1);
  });

  it("survives process restart (fresh ControlPlane on same DB file)", async () => {
    const { defaultOrg } = await cp.init();
    await cp.close();

    const reopened = ControlPlane.create({
      storage: { driver: "sqlite", url: path.join(dataDir, "signalman.db") },
      blobs: { driver: "local", root: path.join(dataDir, "blobs") },
    });
    try {
      const { defaultOrg: again } = await reopened.init();
      expect(again.id).toBe(defaultOrg.id);
    } finally {
      await reopened.close();
    }
  });
});

describe("ensureDefaultOrg (direct call)", () => {
  it("creates on first call, returns existing on subsequent", async () => {
    await cp.storage.migrate();
    const a = await ensureDefaultOrg(cp.storage);
    const b = await ensureDefaultOrg(cp.storage);
    expect(b.id).toBe(a.id);
  });
});

describe("resolveControlPlaneConfig", () => {
  it("returns the user's config when fully specified", () => {
    const out = resolveControlPlaneConfig({
      storage: { driver: "sqlite", url: "/explicit/path.db" },
      blobs: { driver: "local", root: "/explicit/blobs" },
    });
    expect(out.storage.url).toBe("/explicit/path.db");
    expect(out.blobs.root).toBe("/explicit/blobs");
  });

  it("falls back to SIGNALMAN_DATA_DIR when set", () => {
    const prior = process.env.SIGNALMAN_DATA_DIR;
    // Use an absolute path that's platform-correct (Windows would
    // otherwise prepend the current drive in path.resolve).
    const requested = path.resolve(os.tmpdir(), "sm-test-data-dir");
    process.env.SIGNALMAN_DATA_DIR = requested;
    try {
      const out = resolveControlPlaneConfig();
      expect(out.storage.url).toBe(path.join(requested, "signalman.db"));
      expect(out.blobs.root).toBe(path.join(requested, "blobs"));
    } finally {
      if (prior === undefined) delete process.env.SIGNALMAN_DATA_DIR;
      else process.env.SIGNALMAN_DATA_DIR = prior;
    }
  });

  it("falls back to ~/.signalman when no env or config", () => {
    const prior = process.env.SIGNALMAN_DATA_DIR;
    delete process.env.SIGNALMAN_DATA_DIR;
    try {
      const out = resolveControlPlaneConfig();
      expect(out.storage.url).toBe(
        path.join(os.homedir(), ".signalman", "signalman.db"),
      );
    } finally {
      if (prior !== undefined) process.env.SIGNALMAN_DATA_DIR = prior;
    }
  });
});

describe("repo accessors", () => {
  it("forward to the underlying storage driver", async () => {
    await cp.init();
    expect(cp.orgs).toBe(cp.storage.orgs);
    expect(cp.products).toBe(cp.storage.products);
    expect(cp.releases).toBe(cp.storage.releases);
    expect(cp.artifacts).toBe(cp.storage.artifacts);
    expect(cp.auditLog).toBe(cp.storage.auditLog);
  });
});

describe("storage path", () => {
  it("creates the parent directory for the SQLite file when missing", async () => {
    // First-boot from a vanilla home dir hits this path: the
    // ~/.signalman directory does not exist yet, but we want
    // ControlPlane.init() to Just Work without manual mkdir.
    const inner = path.join(dataDir, "nested", "subdir-does-not-exist");
    const cp2 = ControlPlane.create({
      storage: { driver: "sqlite", url: path.join(inner, "x.db") },
      blobs: { driver: "local", root: path.join(inner, "blobs") },
    });
    try {
      await cp2.init();
      expect(await fs.stat(path.join(inner, "x.db"))).toBeTruthy();
    } finally {
      await cp2.close();
    }
  });
});

// ── Direct driver smoke (sanity check that storage path used here ──
// matches what ControlPlane wires up) ──────────────────────────────
describe("driver smoke", () => {
  it("SqliteStorageDriver in :memory: also boots cleanly", async () => {
    const d = new SqliteStorageDriver({ path: ":memory:" });
    try {
      await d.migrate();
      const o = await d.orgs.create({ name: "smoke" });
      expect(o.name).toBe("smoke");
    } finally {
      await d.close();
    }
  });
});
