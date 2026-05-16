/**
 * WS9 Milestone 2 — storage + audit + replay-dedup tests.
 *
 * Covers:
 *   - Migrations 0090 (signing_provider_key) + 0091 (signing_nonce)
 *     apply cleanly via SqliteStorageDriver.migrate().
 *   - SigningProviderKeyRepo: insert, getByFingerprint, getByAlias,
 *     list, revoke, recordRotation; duplicate-fingerprint conflict.
 *   - SigningNonceRepo: insert, exists, sweepOlderThan; replay
 *     collision surfaces StorageConflictError.
 *   - LocalDiskProvider with audit + nonceRepo wired:
 *     - signing.requested + signing.completed rows written
 *     - replay attempt produces signing.failed:nonce-replay row
 *     - the second sign() with the same nonce throws
 *       SigningError("nonce-replay")
 *   - signSync() unchanged: bypasses audit + dedup entirely so the
 *     byte-parity invariant remains stable for legacy callers.
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  LocalDiskProvider,
  SIGNING_ACTION_CODES,
  SigningError,
  freshNonce,
  publicKeyRefFromPem,
} from "../control-plane/signing/index.js";
import { StorageConflictError } from "../control-plane/storage/driver.js";
import { SqliteStorageDriver } from "../control-plane/storage/sqlite.js";
import type { SqliteStorageDriver as SqliteStorageDriverType } from "../control-plane/storage/sqlite.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(
  __dirname,
  "..",
  "control-plane",
  "storage",
  "migrations",
);

function newStorage(): SqliteStorageDriverType {
  return new SqliteStorageDriver({
    path: ":memory:",
    migrationsDir: MIGRATIONS_DIR,
  });
}

async function bootstrapOrg(storage: SqliteStorageDriverType): Promise<string> {
  await storage.migrate();
  const org = await storage.orgs.create({
    name: "test-org",
    tier: "free",
  });
  return org.id;
}

function legacyActor(orgId = "default") {
  return { kind: "service" as const, cn: "test-actor", orgId };
}

function makeRequest(keyId: string, orgId = "default", payload = "hello") {
  return {
    keyId,
    payload: new TextEncoder().encode(payload),
    nonce: freshNonce(),
    requestedAt: new Date().toISOString(),
    purpose: "test.m2",
    actor: legacyActor(orgId),
  };
}

describe("WS9 M2 — migrations apply cleanly", () => {
  it("migrate() creates signing_provider_key + signing_nonce tables", async () => {
    const storage = newStorage();
    await storage.migrate();
    // Smoke: a list against the empty table returns []; a no-op
    // sweep returns 0.
    const keys = await storage.signingProviderKeys.list("nonexistent-org");
    expect(keys).toEqual([]);
    const swept = await storage.signingNonces.sweepOlderThan(new Date(0).toISOString());
    expect(swept).toBe(0);
    await storage.close();
  });
});

describe("SigningProviderKeyRepo", () => {
  let storage: SqliteStorageDriverType;
  let orgId: string;

  beforeEach(async () => {
    storage = newStorage();
    orgId = await bootstrapOrg(storage);
  });
  afterEach(async () => {
    await storage.close();
  });

  it("insert + getByFingerprint roundtrips a single-algorithm key row", async () => {
    const row = await storage.signingProviderKeys.insert({
      orgId,
      provider: "local-disk",
      keyId: "release-prod",
      algorithm: "ed25519",
      fingerprint: "a".repeat(16),
      publicKeyB64: "fake-pub-key-b64",
      addedBy: "service:test",
    });
    expect(row.id).toMatch(/^[A-Za-z0-9_]+$/);
    expect(row.algorithm).toBe("ed25519");
    expect(row.pairId).toBeNull();
    expect(row.revokedAt).toBeNull();

    const fetched = await storage.signingProviderKeys.getByFingerprint(
      orgId,
      "a".repeat(16),
    );
    expect(fetched?.id).toBe(row.id);
  });

  it("rejects a duplicate fingerprint within the same org with StorageConflictError", async () => {
    await storage.signingProviderKeys.insert({
      orgId,
      provider: "local-disk",
      keyId: "k1",
      algorithm: "ed25519",
      fingerprint: "b".repeat(16),
      publicKeyB64: "pk1",
      addedBy: "test",
    });
    await expect(
      storage.signingProviderKeys.insert({
        orgId,
        provider: "local-disk",
        keyId: "k2",
        algorithm: "ed25519",
        fingerprint: "b".repeat(16),
        publicKeyB64: "pk2",
        addedBy: "test",
      }),
    ).rejects.toThrow(StorageConflictError);
  });

  it("getByAlias returns both halves of a hybrid pair, classical-first", async () => {
    const pairId = "pair-1";
    await storage.signingProviderKeys.insert({
      orgId,
      provider: "local-disk",
      keyId: "rel-hybrid",
      algorithm: "ml-dsa-65",
      fingerprint: "p".repeat(16),
      publicKeyB64: "pq-pk",
      pairId,
      pairRole: "post-quantum",
      hybridAlias: "rel-hybrid",
      addedBy: "test",
    });
    await storage.signingProviderKeys.insert({
      orgId,
      provider: "local-disk",
      keyId: "rel-hybrid",
      algorithm: "ed25519",
      fingerprint: "c".repeat(16),
      publicKeyB64: "ed-pk",
      pairId,
      pairRole: "classical",
      hybridAlias: "rel-hybrid",
      addedBy: "test",
    });
    const halves = await storage.signingProviderKeys.getByAlias(orgId, "rel-hybrid");
    expect(halves.length).toBe(2);
    // Ordered classical first (alphabetical asc on pair_role: classical < post-quantum).
    expect(halves[0]!.pairRole).toBe("classical");
    expect(halves[1]!.pairRole).toBe("post-quantum");
  });

  it("revoke marks the row but leaves it queryable for past signatures", async () => {
    await storage.signingProviderKeys.insert({
      orgId,
      provider: "local-disk",
      keyId: "k1",
      algorithm: "ed25519",
      fingerprint: "d".repeat(16),
      publicKeyB64: "pk",
      addedBy: "test",
    });
    await storage.signingProviderKeys.revoke({
      orgId,
      fingerprint: "d".repeat(16),
      revokedBy: "test",
      reason: "key compromised",
    });
    const row = await storage.signingProviderKeys.getByFingerprint(
      orgId,
      "d".repeat(16),
    );
    expect(row?.revokedAt).not.toBeNull();
    expect(row?.revokeReason).toBe("key compromised");
    // list() default excludes revoked.
    const active = await storage.signingProviderKeys.list(orgId);
    expect(active.find((k) => k.fingerprint === "d".repeat(16))).toBeUndefined();
    const all = await storage.signingProviderKeys.list(orgId, {
      includeRevoked: true,
    });
    expect(all.find((k) => k.fingerprint === "d".repeat(16))).toBeDefined();
  });

  it("list filters by provider when requested", async () => {
    await storage.signingProviderKeys.insert({
      orgId,
      provider: "local-disk",
      keyId: "k1",
      algorithm: "ed25519",
      fingerprint: "e".repeat(16),
      publicKeyB64: "pk",
      addedBy: "test",
    });
    await storage.signingProviderKeys.insert({
      orgId,
      provider: "aws-kms",
      keyId: "arn",
      algorithm: "ecdsa-p256-sha256",
      fingerprint: "f".repeat(16),
      publicKeyB64: "pk",
      addedBy: "test",
    });
    const local = await storage.signingProviderKeys.list(orgId, {
      provider: "local-disk",
    });
    expect(local.length).toBe(1);
    expect(local[0]!.provider).toBe("local-disk");
  });

  it("recordRotation links old fingerprint to new", async () => {
    await storage.signingProviderKeys.insert({
      orgId,
      provider: "local-disk",
      keyId: "k",
      algorithm: "ed25519",
      fingerprint: "old".padEnd(16, "0"),
      publicKeyB64: "pk",
      addedBy: "test",
    });
    const newKey = await storage.signingProviderKeys.insert({
      orgId,
      provider: "local-disk",
      keyId: "k",
      algorithm: "ed25519",
      fingerprint: "new".padEnd(16, "0"),
      publicKeyB64: "pk2",
      addedBy: "test",
    });
    await storage.signingProviderKeys.recordRotation({
      orgId,
      oldFingerprint: "old".padEnd(16, "0"),
      newFingerprint: "new".padEnd(16, "0"),
    });
    const oldRow = await storage.signingProviderKeys.getByFingerprint(
      orgId,
      "old".padEnd(16, "0"),
    );
    expect(oldRow?.rotatedTo).toBe(newKey.id);
  });
});

describe("SigningNonceRepo", () => {
  let storage: SqliteStorageDriverType;

  beforeEach(async () => {
    storage = newStorage();
    await bootstrapOrg(storage);
  });
  afterEach(async () => {
    await storage.close();
  });

  it("insert + exists roundtrip", async () => {
    await storage.signingNonces.insert({
      orgId: "default",
      actorCn: "alice",
      nonce: "abc",
      requestedAt: new Date().toISOString(),
      fingerprint: null,
    });
    expect(await storage.signingNonces.exists("default", "alice", "abc")).toBe(true);
    expect(await storage.signingNonces.exists("default", "alice", "xyz")).toBe(false);
    expect(await storage.signingNonces.exists("default", "bob", "abc")).toBe(false);
  });

  it("duplicate (org, actor, nonce) collides with StorageConflictError", async () => {
    const row = {
      orgId: "default",
      actorCn: "alice",
      nonce: "n1",
      requestedAt: new Date().toISOString(),
      fingerprint: null,
    };
    await storage.signingNonces.insert(row);
    await expect(storage.signingNonces.insert(row)).rejects.toThrow(
      StorageConflictError,
    );
  });

  it("sweepOlderThan deletes rows past the cutoff and returns the count", async () => {
    await storage.signingNonces.insert({
      orgId: "default",
      actorCn: "a",
      nonce: "old",
      requestedAt: "2000-01-01T00:00:00.000Z",
      fingerprint: null,
    });
    await storage.signingNonces.insert({
      orgId: "default",
      actorCn: "a",
      nonce: "new",
      requestedAt: new Date().toISOString(),
      fingerprint: null,
    });
    const swept = await storage.signingNonces.sweepOlderThan("2020-01-01T00:00:00.000Z");
    expect(swept).toBe(1);
    expect(await storage.signingNonces.exists("default", "a", "old")).toBe(false);
    expect(await storage.signingNonces.exists("default", "a", "new")).toBe(true);
  });
});

describe("LocalDiskProvider with audit-log + replay-dedup wired", () => {
  let storage: SqliteStorageDriverType;
  let orgId: string;

  beforeEach(async () => {
    storage = newStorage();
    orgId = await bootstrapOrg(storage);
  });
  afterEach(async () => {
    await storage.close();
  });

  it("sign() writes signing.requested + signing.completed", async () => {
    const provider = newProviderWithInlineKey(storage, orgId);
    const req = makeRequest("inline", orgId);
    await provider.sign(req);
    const rows = await storage.auditLog.listForOrg(orgId);
    const actions = rows.map((r) => r.action);
    expect(actions).toContain(SIGNING_ACTION_CODES.REQUESTED);
    expect(actions).toContain(SIGNING_ACTION_CODES.COMPLETED);
    // No failure row on the happy path.
    expect(actions).not.toContain(SIGNING_ACTION_CODES.FAILED);
  });

  it("sign() with replay rejects the duplicate nonce + writes signing.failed:nonce-replay", async () => {
    const provider = newProviderWithInlineKey(storage, orgId);
    const req = makeRequest("inline", orgId);
    await provider.sign(req);
    await expect(provider.sign(req)).rejects.toMatchObject({
      name: "SigningError",
      code: "nonce-replay",
    });
    const rows = await storage.auditLog.listForOrg(orgId);
    const failed = rows.find((r) => r.action === SIGNING_ACTION_CODES.FAILED);
    expect(failed).toBeDefined();
    expect(failed?.detail).toMatchObject({ errorCode: "nonce-replay" });
  });

  it("signSync() bypasses audit + dedup entirely (byte-parity invariant)", () => {
    const provider = newProviderWithInlineKey(storage, orgId);
    const req = makeRequest("inline", orgId);
    const env1 = provider.signSync(req);
    // Same nonce again — sync path doesn't dedup, so this succeeds.
    const env2 = provider.signSync(req);
    expect(env1.signatures[0]!.signatureB64).toBe(env2.signatures[0]!.signatureB64);
  });

  it("sign() with key resolution failure writes signing.failed BEFORE the requested row (no entityId yet)", async () => {
    // Provider with audit + nonceRepo BUT pointing at a keysDir that's
    // empty — resolveForSign throws key-not-found.
    const fs = require("node:fs") as typeof import("node:fs");
    const osMod = require("node:os") as typeof import("node:os");
    const path = require("node:path") as typeof import("node:path");
    const tmp = fs.mkdtempSync(path.join(osMod.tmpdir(), "signalman-keyfail-"));
    try {
      const provider = new LocalDiskProvider({
        keysDir: tmp,
        auditLog: storage.auditLog,
        nonceRepo: storage.signingNonces,
        auditOrgId: orgId,
      });
      const req = makeRequest("nonexistent", orgId);
      await expect(provider.sign(req)).rejects.toThrow(SigningError);
      const rows = await storage.auditLog.listForOrg(orgId);
      const failed = rows.find((r) => r.action === SIGNING_ACTION_CODES.FAILED);
      expect(failed).toBeDefined();
      expect(failed?.detail).toMatchObject({ errorCode: "key-not-found" });
      // No requested or completed row — the failure happened before we
      // could resolve a fingerprint.
      expect(rows.find((r) => r.action === SIGNING_ACTION_CODES.REQUESTED)).toBeUndefined();
      expect(rows.find((r) => r.action === SIGNING_ACTION_CODES.COMPLETED)).toBeUndefined();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("sign() with signSync-stage failure (e.g. bad-nonce) writes signing.failed AFTER requested", async () => {
    const provider = newProviderWithInlineKey(storage, orgId);
    const req = makeRequest("inline", orgId);
    // Force a bad nonce so validateRequest in signSync rejects.
    const badReq = { ...req, nonce: "not-a-hex-string" };
    await expect(provider.sign(badReq)).rejects.toThrow(SigningError);
    const rows = await storage.auditLog.listForOrg(orgId);
    const failed = rows.find((r) => r.action === SIGNING_ACTION_CODES.FAILED);
    expect(failed).toBeDefined();
    expect(failed?.detail).toMatchObject({ errorCode: "nonce-malformed" });
    // The requested row WAS written before the validation failure.
    expect(rows.find((r) => r.action === SIGNING_ACTION_CODES.REQUESTED)).toBeDefined();
  });

  it("sign() with no auditLog/nonceRepo falls back to legacy semantics", async () => {
    // Provider constructed WITHOUT audit/nonceRepo — same as M1a/M1b behavior.
    const { kp, provider } = makeInlineProvider();
    const req = makeRequest("inline", orgId);
    const env = await provider.sign(req);
    expect(env.signatures.length).toBe(1);
    expect(env.signatures[0]!.algorithm).toBe("ed25519");
    expect(env.nonce).toBe(req.nonce);
    void kp;
    // No audit rows recorded.
    const rows = await storage.auditLog.listForOrg(orgId);
    expect(rows.map((r) => r.action)).not.toContain(SIGNING_ACTION_CODES.REQUESTED);
  });
});

// ── helpers ──────────────────────────────────────────────────────────

function makeInlineProvider(): {
  kp: { publicKeyPem: string; privateKeyPem: string };
  provider: LocalDiskProvider;
} {
  const crypto = require("node:crypto") as typeof import("node:crypto");
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const kp = {
    publicKeyPem: publicKey as string,
    privateKeyPem: privateKey as string,
  };
  return {
    kp,
    provider: LocalDiskProvider.fromInlinePem(kp.privateKeyPem),
  };
}

function newProviderWithInlineKey(
  storage: SqliteStorageDriverType,
  orgId: string,
): LocalDiskProvider {
  const crypto = require("node:crypto") as typeof import("node:crypto");
  const { privateKey } = crypto.generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  return LocalDiskProvider.fromInlinePem(privateKey as string, undefined, {
    auditLog: storage.auditLog,
    nonceRepo: storage.signingNonces,
    auditOrgId: orgId,
  });
}

// Mark unused imports as used for the tests above.
void publicKeyRefFromPem;
void SigningError;
