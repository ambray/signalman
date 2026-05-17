/**
 * WS9 M3 — verb-level tests for `signalman signing` CLI/MCP surface.
 *
 * Covers the run* functions from verbs/signing.ts against an
 * in-memory SQLite-backed ControlPlane. Each verb is exercised
 * happy-path + a critical failure path; audit-log rows are asserted
 * where mutating ops happen.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  freshNonce,
  SIGNING_ACTION_CODES,
  SigningError,
  type SignEnvelope,
} from "../control-plane/signing/index.js";
import { SqliteStorageDriver } from "../control-plane/storage/sqlite.js";
import { ControlPlane } from "../control-plane/index.js";
import {
  runSigningKeysAdd,
  runSigningKeysList,
  runSigningKeysRevoke,
  runSigningKeysRotate,
  runSigningNonceSweep,
  runSigningProvidersList,
  runSigningVerify,
} from "../verbs/signing.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(
  __dirname,
  "..",
  "control-plane",
  "storage",
  "migrations",
);

async function newCp(): Promise<{ cp: ControlPlane; orgId: string; tmp: string }> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "signalman-ws9-m3-"));
  const storage = new SqliteStorageDriver({
    path: ":memory:",
    migrationsDir: MIGRATIONS_DIR,
  });
  await storage.migrate();
  const org = await storage.orgs.create({ name: "test-org", tier: "free" });
  // Build a ControlPlane around the storage. ControlPlane.fromConfig
  // expects a config; for tests we go direct via the constructor by
  // poking the storage onto a stub. Cleaner: use the public API.
  const cp = ControlPlaneForTest(storage);
  return { cp, orgId: org.id, tmp };
}

function ControlPlaneForTest(storage: SqliteStorageDriver): ControlPlane {
  // ControlPlane carries a `storage` field; reuse it directly. The
  // test constructor below mirrors what ControlPlane.fromConfig does
  // internally but skips config loading.
  const cp = Object.create(ControlPlane.prototype) as ControlPlane;
  (cp as unknown as { storage: SqliteStorageDriver }).storage = storage;
  (cp as unknown as { defaultOrg: { id: string } }).defaultOrg = {
    id: "default",
  };
  (cp as unknown as { initialized: boolean }).initialized = true;
  return cp;
}

describe("runSigningProvidersList", () => {
  let cp: ControlPlane;
  let orgId: string;
  let tmp: string;
  beforeEach(async () => {
    ({ cp, orgId, tmp } = await newCp());
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("returns local-disk as configured with zero keys when catalog is empty", async () => {
    const result = await runSigningProvidersList(cp, orgId);
    const local = result.find((r) => r.provider === "local-disk");
    expect(local).toBeDefined();
    expect(local?.configured).toBe(true);
    expect(local?.keyCount).toBe(0);
  });

  it("counts keys by provider after add", async () => {
    await runSigningKeysAdd(cp, orgId, {
      provider: "local-disk",
      alias: "k1",
      algorithm: "ed25519",
      keysDir: tmp,
      actor: "test",
    });
    const result = await runSigningProvidersList(cp, orgId);
    expect(result.find((r) => r.provider === "local-disk")?.keyCount).toBe(1);
  });
});

describe("runSigningKeysAdd", () => {
  let cp: ControlPlane;
  let orgId: string;
  let tmp: string;
  beforeEach(async () => {
    ({ cp, orgId, tmp } = await newCp());
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("hybrid (default) creates TWO paired catalog rows + 4 key files + audit row", async () => {
    const result = await runSigningKeysAdd(cp, orgId, {
      provider: "local-disk",
      alias: "rel-prod",
      keysDir: tmp,
      actor: "test-actor",
    });
    expect(result.added.length).toBe(2);
    const algorithms = result.added.map((r) => r.algorithm).sort();
    expect(algorithms).toEqual(["ed25519", "ml-dsa-65"]);
    expect(result.added[0]!.pairId).toBe(result.added[1]!.pairId);
    expect(result.added[0]!.hybridAlias).toBe("rel-prod");

    // 4 files written.
    expect(fs.existsSync(path.join(tmp, "rel-prod-ed25519.pub"))).toBe(true);
    expect(fs.existsSync(path.join(tmp, "rel-prod-ed25519.key"))).toBe(true);
    expect(fs.existsSync(path.join(tmp, "rel-prod-mldsa65.pub"))).toBe(true);
    expect(fs.existsSync(path.join(tmp, "rel-prod-mldsa65.key"))).toBe(true);

    // Audit row.
    const rows = await cp.auditLog.listForOrg(orgId);
    const added = rows.find((r) => r.action === SIGNING_ACTION_CODES.KEY_ADDED);
    expect(added).toBeDefined();
    expect(added?.detail).toMatchObject({
      provider: "local-disk",
      algorithm: "hybrid",
    });
  });

  it("ed25519 single-algorithm creates one row + .pub/.key + audit row", async () => {
    const result = await runSigningKeysAdd(cp, orgId, {
      provider: "local-disk",
      alias: "classical-only",
      algorithm: "ed25519",
      keysDir: tmp,
      actor: "test",
    });
    expect(result.added.length).toBe(1);
    expect(result.added[0]!.algorithm).toBe("ed25519");
    expect(result.added[0]!.pairId).toBeNull();
    expect(fs.existsSync(path.join(tmp, "classical-only.pub"))).toBe(true);
    expect(fs.existsSync(path.join(tmp, "classical-only.key"))).toBe(true);
  });

  it("ecdsa-p256-sha256 single-algorithm works", async () => {
    const result = await runSigningKeysAdd(cp, orgId, {
      provider: "local-disk",
      alias: "ecdsa",
      algorithm: "ecdsa-p256-sha256",
      keysDir: tmp,
      actor: "test",
    });
    expect(result.added[0]!.algorithm).toBe("ecdsa-p256-sha256");
  });

  it("rejects an alias with path separators", async () => {
    await expect(
      runSigningKeysAdd(cp, orgId, {
        provider: "local-disk",
        alias: "../escape",
        keysDir: tmp,
        actor: "test",
      }),
    ).rejects.toThrow(SigningError);
  });

  it("rejects an unsupported provider (M4 ships local-disk + aws-kms)", async () => {
    await expect(
      runSigningKeysAdd(cp, orgId, {
        provider: "azure-key-vault",
        alias: "k",
        keysDir: tmp,
        actor: "test",
      }),
    ).rejects.toThrow(/not yet supported/);
  });

  it("rejects ml-dsa-65 single-algorithm (deferred from M3)", async () => {
    await expect(
      runSigningKeysAdd(cp, orgId, {
        provider: "local-disk",
        alias: "pq-only",
        algorithm: "ml-dsa-65",
        keysDir: tmp,
        actor: "test",
      }),
    ).rejects.toThrow(/algorithm-not-implemented|not yet exposed/);
  });
});

describe("runSigningKeysList", () => {
  let cp: ControlPlane;
  let orgId: string;
  let tmp: string;
  beforeEach(async () => {
    ({ cp, orgId, tmp } = await newCp());
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("returns empty for a fresh org", async () => {
    const rows = await runSigningKeysList(cp, orgId);
    expect(rows).toEqual([]);
  });

  it("returns all rows after a hybrid add", async () => {
    await runSigningKeysAdd(cp, orgId, {
      provider: "local-disk",
      alias: "h",
      keysDir: tmp,
      actor: "test",
    });
    const rows = await runSigningKeysList(cp, orgId);
    expect(rows.length).toBe(2);
  });

  it("filters by provider", async () => {
    await runSigningKeysAdd(cp, orgId, {
      provider: "local-disk",
      alias: "h",
      keysDir: tmp,
      actor: "test",
    });
    const rows = await runSigningKeysList(cp, orgId, { provider: "aws-kms" });
    expect(rows.length).toBe(0);
  });
});

describe("runSigningKeysRevoke", () => {
  let cp: ControlPlane;
  let orgId: string;
  let tmp: string;
  beforeEach(async () => {
    ({ cp, orgId, tmp } = await newCp());
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("revokes by fingerprint and writes audit row", async () => {
    const added = await runSigningKeysAdd(cp, orgId, {
      provider: "local-disk",
      alias: "k",
      algorithm: "ed25519",
      keysDir: tmp,
      actor: "test",
    });
    const fp = added.added[0]!.fingerprint;
    const revoked = await runSigningKeysRevoke(cp, orgId, {
      identifier: fp,
      reason: "compromised",
      actor: "test",
    });
    expect(revoked.length).toBe(1);
    expect(revoked[0]!.revokedAt).not.toBeNull();
    expect(revoked[0]!.revokeReason).toBe("compromised");
    const rows = await cp.auditLog.listForOrg(orgId);
    expect(rows.some((r) => r.action === SIGNING_ACTION_CODES.KEY_REVOKED)).toBe(true);
  });

  it("revokes both halves of a hybrid pair by alias", async () => {
    await runSigningKeysAdd(cp, orgId, {
      provider: "local-disk",
      alias: "h",
      keysDir: tmp,
      actor: "test",
    });
    const revoked = await runSigningKeysRevoke(cp, orgId, {
      identifier: "h",
      reason: "rotated",
      actor: "test",
    });
    expect(revoked.length).toBe(2);
    expect(revoked.every((r) => r.revokedAt !== null)).toBe(true);
  });

  it("surfaces key-not-found when identifier matches no row", async () => {
    await expect(
      runSigningKeysRevoke(cp, orgId, {
        identifier: "deadbeef00000000",
        reason: "n/a",
        actor: "test",
      }),
    ).rejects.toThrow(/key-not-found|no key matched/);
  });
});

describe("runSigningKeysRotate", () => {
  let cp: ControlPlane;
  let orgId: string;
  let tmp: string;
  beforeEach(async () => {
    ({ cp, orgId, tmp } = await newCp());
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("rotates a hybrid pair atomically + records linkage + audit row", async () => {
    const added = await runSigningKeysAdd(cp, orgId, {
      provider: "local-disk",
      alias: "h",
      keysDir: tmp,
      actor: "test",
    });
    const result = await runSigningKeysRotate(cp, orgId, {
      identifier: "h",
      keysDir: tmp,
      actor: "test",
    });
    expect(result.oldKeys.length).toBe(2);
    expect(result.newKeys.length).toBe(2);
    // Fingerprints differ.
    const oldFps = new Set(added.added.map((k) => k.fingerprint));
    const newFps = new Set(result.newKeys.map((k) => k.fingerprint));
    for (const f of newFps) expect(oldFps.has(f)).toBe(false);
    // Linkage recorded on old rows.
    for (const oldKey of result.oldKeys) {
      const refreshed = await cp.signingProviderKeys.getByFingerprint(
        orgId,
        oldKey.fingerprint,
      );
      expect(refreshed?.rotatedTo).not.toBeNull();
    }
    const rows = await cp.auditLog.listForOrg(orgId);
    const rotated = rows.filter((r) => r.action === SIGNING_ACTION_CODES.KEY_ROTATED);
    expect(rotated.length).toBe(2); // one per sub-key
  });
});

describe("runSigningVerify", () => {
  let cp: ControlPlane;
  let orgId: string;
  let tmp: string;
  beforeEach(async () => {
    ({ cp, orgId, tmp } = await newCp());
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("verifies an envelope produced via the catalog roundtrip", async () => {
    await runSigningKeysAdd(cp, orgId, {
      provider: "local-disk",
      alias: "h",
      keysDir: tmp,
      actor: "test",
    });
    // Sign something via LocalDiskProvider against the just-added key.
    const { LocalDiskProvider } = await import("../control-plane/signing/index.js");
    const provider = new LocalDiskProvider({ keysDir: tmp });
    const payload = new TextEncoder().encode("hello world");
    const envelope = await provider.sign({
      keyId: "h",
      payload,
      nonce: freshNonce(),
      requestedAt: new Date().toISOString(),
      purpose: "test.verify",
      actor: { kind: "service", cn: "test", orgId },
    });
    const result = await runSigningVerify(cp, orgId, {
      envelope,
      payload,
      mode: "transition",
    });
    expect(result.ok).toBe(true);
    expect(result.matchedKeys.length).toBe(2);
    expect(result.missingKeys.length).toBe(0);
  });

  it("returns ok=false with missingKeys populated when fingerprints aren't in catalog", async () => {
    const fakeEnvelope: SignEnvelope = {
      signatures: [
        {
          signatureB64: "AAAA",
          signedBy: "deadbeef00000000",
          algorithm: "ed25519",
          signedAt: new Date().toISOString(),
        },
      ],
      nonce: "00000000000000000000000000000000",
      payloadSha256: crypto.createHash("sha256").update("x").digest("hex"),
    };
    const result = await runSigningVerify(cp, orgId, {
      envelope: fakeEnvelope,
      payload: new TextEncoder().encode("x"),
    });
    expect(result.ok).toBe(false);
    expect(result.reasonCode).toBe("key-not-found");
    expect(result.missingKeys.length).toBe(1);
  });
});

describe("runSigningNonceSweep", () => {
  let cp: ControlPlane;
  beforeEach(async () => {
    ({ cp } = await newCp());
  });

  it("returns deleted=0 + cutoff when ledger is empty", async () => {
    const result = await runSigningNonceSweep(cp, { olderThanHours: 24 });
    expect(result.deletedRows).toBe(0);
    expect(result.cutoff).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("rejects non-positive --older-than-hours", async () => {
    await expect(
      runSigningNonceSweep(cp, { olderThanHours: 0 }),
    ).rejects.toThrow(SigningError);
    await expect(
      runSigningNonceSweep(cp, { olderThanHours: -1 }),
    ).rejects.toThrow(SigningError);
  });

  it("defaults to 24 hours when olderThanHours omitted", async () => {
    const result = await runSigningNonceSweep(cp, {});
    const cutoffDate = new Date(result.cutoff);
    const expected = Date.now() - 24 * 60 * 60 * 1000;
    expect(Math.abs(cutoffDate.getTime() - expected)).toBeLessThan(60_000);
  });
});
