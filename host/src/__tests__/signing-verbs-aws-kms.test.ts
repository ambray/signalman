/**
 * `signalman signing keys add --provider aws-kms` flow — WS9 M4.
 *
 * Tests the registration verb that fetches a KMS key's public bytes,
 * computes its fingerprint, and persists a catalog row. The verb
 * accepts a mocked KMS client (test seam in KeysAddInput) so the
 * test doesn't hit AWS.
 *
 * Cross-cuts:
 *   - The freshly registered catalog row carries the cached
 *     `public_key_b64` so subsequent verify() never round-trips KMS.
 *   - runSigningVerify (M3) recognizes aws-kms rows the same way it
 *     recognizes local-disk rows — the algorithm dispatch is
 *     universal, proven by an end-to-end sign-via-KMS → verify
 *     test where the verifier reads from the catalog.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AwsKmsProvider,
  freshNonce,
  type KmsClientLike,
  SIGNING_ACTION_CODES,
  SigningError,
} from "../control-plane/signing/index.js";
import { ControlPlane } from "../control-plane/index.js";
import { SqliteStorageDriver } from "../control-plane/storage/sqlite.js";
import {
  runSigningKeysAdd,
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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "signalman-ws9-m4-"));
  const storage = new SqliteStorageDriver({
    path: ":memory:",
    migrationsDir: MIGRATIONS_DIR,
  });
  await storage.migrate();
  const org = await storage.orgs.create({ name: "test-org", tier: "free" });
  const cp = Object.create(ControlPlane.prototype) as ControlPlane;
  (cp as unknown as { storage: SqliteStorageDriver }).storage = storage;
  (cp as unknown as { defaultOrg: { id: string } }).defaultOrg = {
    id: org.id,
  };
  (cp as unknown as { initialized: boolean }).initialized = true;
  return { cp, orgId: org.id, tmp };
}

/**
 * Build a mock KMS client backed by a real ECDSA P-256 keypair. Same
 * shape as the one in `signing-aws-kms.test.ts` but stripped down to
 * what registration needs (sign + get public key).
 */
function buildMockKms(): {
  client: KmsClientLike;
  publicKeyDer: Buffer;
  privateKey: crypto.KeyObject;
} {
  const { publicKey: pubObj, privateKey: privObj } = crypto.generateKeyPairSync(
    "ec",
    { namedCurve: "prime256v1" },
  );
  const publicKeyDer = pubObj.export({ type: "spki", format: "der" }) as Buffer;
  const client: KmsClientLike = {
    send: vi.fn(async (cmd: unknown) => {
      const name = (cmd as { constructor: { name: string } }).constructor.name;
      if (name === "GetPublicKeyCommand") {
        return {
          PublicKey: new Uint8Array(publicKeyDer),
          SigningAlgorithms: ["ECDSA_SHA_256"],
        };
      }
      if (name === "SignCommand") {
        const input = (cmd as { input: { Message?: Uint8Array } }).input;
        const sig = crypto.sign("sha256", input.Message!, privObj);
        return { Signature: new Uint8Array(sig) };
      }
      throw new Error(`unexpected KMS command: ${name}`);
    }) as KmsClientLike["send"],
  };
  return { client, publicKeyDer, privateKey: privObj };
}

describe("runSigningKeysAdd: provider=aws-kms", () => {
  let cp: ControlPlane;
  let orgId: string;
  let tmp: string;
  beforeEach(async () => {
    ({ cp, orgId, tmp } = await newCp());
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("registers an existing KMS key + inserts catalog row + audit row", async () => {
    const { client, publicKeyDer } = buildMockKms();
    const arn = "arn:aws:kms:us-east-1:1234:key/abc";
    const result = await runSigningKeysAdd(cp, orgId, {
      provider: "aws-kms",
      alias: "prod-signing",
      keyId: arn,
      awsKmsClient: client,
      actor: "test-actor",
    });
    expect(result.added.length).toBe(1);
    const row = result.added[0]!;
    expect(row.provider).toBe("aws-kms");
    expect(row.algorithm).toBe("ecdsa-p256-sha256");
    expect(row.keyId).toBe(arn);
    // Catalog row carries the cached SPKI bytes, base64-encoded.
    expect(row.publicKeyB64).toBe(publicKeyDer.toString("base64"));
    expect(row.fingerprint).toMatch(/^[0-9a-f]{16}$/);

    // Audit row recorded.
    const auditRows = await cp.auditLog.listForOrg(orgId);
    const added = auditRows.find(
      (r) => r.action === SIGNING_ACTION_CODES.KEY_ADDED,
    );
    expect(added).toBeDefined();
    expect(added?.detail).toMatchObject({
      provider: "aws-kms",
      keyId: arn,
      algorithm: "ecdsa-p256-sha256",
    });
  });

  it("hybrid via aws-kms requires --pq-key-id or --pq-fallback (v0.5.1 M7+)", async () => {
    // v0.5.1 M7 ships hybrid via aws-kms; bare --algorithm hybrid
    // without specifying the PQ half is rejected with an actionable
    // message pointing at the two valid forms.
    const { client } = buildMockKms();
    await expect(
      runSigningKeysAdd(cp, orgId, {
        provider: "aws-kms",
        alias: "h",
        algorithm: "hybrid",
        keyId: "arn",
        awsKmsClient: client,
        actor: "test",
      }),
    ).rejects.toThrow(/pq-key-id.*pq-fallback|pq-fallback.*pq-key-id/);
  });

  it("rejects --algorithm ed25519 for aws-kms (Ed25519 via KMS deferred)", async () => {
    const { client } = buildMockKms();
    await expect(
      runSigningKeysAdd(cp, orgId, {
        provider: "aws-kms",
        alias: "h",
        algorithm: "ed25519",
        keyId: "arn",
        awsKmsClient: client,
        actor: "test",
      }),
    ).rejects.toThrow(/aws-kms supports ecdsa-p256-sha256 or hybrid/);
  });

  it("requires --key-id for aws-kms", async () => {
    const { client } = buildMockKms();
    await expect(
      runSigningKeysAdd(cp, orgId, {
        provider: "aws-kms",
        alias: "h",
        awsKmsClient: client,
        actor: "test",
      }),
    ).rejects.toThrow(/--key-id/);
  });

  it("a registered KMS key signs + verifies through the catalog round-trip", async () => {
    const { client, privateKey } = buildMockKms();
    const arn = "arn:aws:kms:us-east-1:1234:key/abc";
    await runSigningKeysAdd(cp, orgId, {
      provider: "aws-kms",
      alias: "prod",
      keyId: arn,
      awsKmsClient: client,
      actor: "test",
    });
    // Build the same provider (sharing the mocked client) and sign.
    const provider = new AwsKmsProvider({
      region: "us-east-1",
      credentials: { access_key_id: "k", secret_access_key: "s" },
      client,
    });
    const payload = new TextEncoder().encode("release manifest");
    const env = await provider.sign({
      keyId: arn,
      payload,
      nonce: freshNonce(),
      requestedAt: new Date().toISOString(),
      purpose: "test.kms.roundtrip",
      actor: { kind: "service", cn: "test", orgId },
    });
    // Verify via the host's catalog-driven runSigningVerify — proves
    // that an aws-kms-produced envelope verifies through the same
    // path that local-disk envelopes go through, with NO KMS access.
    const result = await runSigningVerify(cp, orgId, {
      envelope: env,
      payload,
      mode: "transition",
    });
    expect(result.ok).toBe(true);
    expect(result.matchedKeys.length).toBe(1);
    expect(result.matchedKeys[0]!.algorithm).toBe("ecdsa-p256-sha256");
    void privateKey; // silence unused
  });

  it("surfaces key-not-found from KMS error cleanly", async () => {
    const client: KmsClientLike = {
      send: (async () => {
        const err = new Error("missing");
        err.name = "NotFoundException";
        throw err;
      }) as KmsClientLike["send"],
    };
    await expect(
      runSigningKeysAdd(cp, orgId, {
        provider: "aws-kms",
        alias: "missing",
        keyId: "arn:missing",
        awsKmsClient: client,
        actor: "test",
      }),
    ).rejects.toMatchObject({ code: "key-not-found" });
  });

  it("an unsupported provider still surfaces the clean error from M3", async () => {
    await expect(
      runSigningKeysAdd(cp, orgId, {
        provider: "azure-key-vault",
        alias: "h",
        actor: "test",
      }),
    ).rejects.toThrow(/not yet supported/);
  });
});

// ── v0.5.1 M7: hybrid via aws-kms (KMS classical + local-fallback PQ) ─

describe("runSigningKeysAdd: provider=aws-kms --algorithm hybrid", () => {
  let cp: ControlPlane;
  let orgId: string;
  let tmp: string;
  beforeEach(async () => {
    ({ cp, orgId, tmp } = await newCp());
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("hybrid with --pq-fallback local: registers two paired catalog rows (aws-kms classical + local-disk PQ)", async () => {
    const { client, publicKeyDer } = buildMockKms();
    const arn = "arn:aws:kms:us-east-1:1234:key/abc";
    const result = await runSigningKeysAdd(cp, orgId, {
      provider: "aws-kms",
      alias: "hybrid-prod",
      algorithm: "hybrid",
      keyId: arn,
      pqFallback: "local",
      keysDir: tmp,
      awsKmsClient: client,
      actor: "test",
    });
    expect(result.added.length).toBe(2);

    // Classical half (AWS KMS, ECDSA P-256).
    const classical = result.added.find((r) => r.pairRole === "classical")!;
    expect(classical.provider).toBe("aws-kms");
    expect(classical.algorithm).toBe("ecdsa-p256-sha256");
    expect(classical.keyId).toBe(arn);
    expect(classical.publicKeyB64).toBe(publicKeyDer.toString("base64"));
    expect(classical.hybridAlias).toBe("hybrid-prod");

    // PQ half (LocalDisk, ML-DSA-65).
    const pq = result.added.find((r) => r.pairRole === "post-quantum")!;
    expect(pq.provider).toBe("local-disk");
    expect(pq.algorithm).toBe("ml-dsa-65");
    expect(pq.keyId).toBe("hybrid-prod-mldsa65");
    expect(pq.hybridAlias).toBe("hybrid-prod");

    // Both rows share the pair_id.
    expect(classical.pairId).toBe(pq.pairId);
    expect(classical.pairId).not.toBeNull();

    // PQ key files exist on disk.
    expect(fs.existsSync(path.join(tmp, "hybrid-prod-mldsa65.key"))).toBe(true);
    expect(fs.existsSync(path.join(tmp, "hybrid-prod-mldsa65.pub"))).toBe(true);

    // Audit row records hybrid detail.
    const auditRows = await cp.auditLog.listForOrg(orgId);
    const added = auditRows.find(
      (r) => r.action === SIGNING_ACTION_CODES.KEY_ADDED,
    );
    expect(added?.detail).toMatchObject({
      provider: "aws-kms",
      algorithm: "hybrid",
      pqProvider: "local-disk",
      hybridAlias: "hybrid-prod",
    });
  });

  it("hybrid with --pq-key-id (both-KMS path) is deferred with a clean error", async () => {
    const { client } = buildMockKms();
    await expect(
      runSigningKeysAdd(cp, orgId, {
        provider: "aws-kms",
        alias: "h",
        algorithm: "hybrid",
        keyId: "arn:classical",
        pqKeyId: "arn:pq",
        awsKmsClient: client,
        actor: "test",
      }),
    ).rejects.toMatchObject({ code: "algorithm-not-implemented" });
  });

  it("rejects --pq-key-id and --pq-fallback together", async () => {
    const { client } = buildMockKms();
    await expect(
      runSigningKeysAdd(cp, orgId, {
        provider: "aws-kms",
        alias: "h",
        algorithm: "hybrid",
        keyId: "arn",
        pqKeyId: "arn-pq",
        pqFallback: "local",
        awsKmsClient: client,
        actor: "test",
      }),
    ).rejects.toThrow(/not both/);
  });

  it("rejects hybrid without --pq-key-id or --pq-fallback", async () => {
    const { client } = buildMockKms();
    await expect(
      runSigningKeysAdd(cp, orgId, {
        provider: "aws-kms",
        alias: "h",
        algorithm: "hybrid",
        keyId: "arn",
        awsKmsClient: client,
        actor: "test",
      }),
    ).rejects.toThrow(/pq-key-id.*pq-fallback/);
  });

  it("end-to-end: hybrid-aws-kms key signs (via HybridProvider composition) and verifies through runSigningVerify", async () => {
    const { client, privateKey } = buildMockKms();
    const arn = "arn:aws:kms:us-east-1:1234:key/abc";
    const added = await runSigningKeysAdd(cp, orgId, {
      provider: "aws-kms",
      alias: "e2e",
      algorithm: "hybrid",
      keyId: arn,
      pqFallback: "local",
      keysDir: tmp,
      awsKmsClient: client,
      actor: "test",
    });

    // Reconstruct the HybridProvider with the same mocked KMS client
    // + LocalDiskProvider against the keysDir where the PQ half was
    // written.
    const { AwsKmsProvider } = await import(
      "../control-plane/signing/index.js"
    );
    const { HybridProvider } = await import(
      "../control-plane/signing/index.js"
    );
    const { LocalDiskProvider: Lp } = await import(
      "../control-plane/signing/index.js"
    );
    const aws = new AwsKmsProvider({
      region: "us-east-1",
      credentials: { access_key_id: "k", secret_access_key: "s" },
      client,
    });
    const lp = new Lp({ keysDir: tmp });
    const hybrid = new HybridProvider({
      classical: aws,
      pq: lp,
      classicalKeyId: arn,
      pqKeyId: "e2e-mldsa65",
    });
    const payload = new TextEncoder().encode("release manifest hybrid");
    const env = await hybrid.sign({
      keyId: "ignored",
      payload,
      nonce: freshNonce(),
      requestedAt: new Date().toISOString(),
      purpose: "test.hybrid-aws-kms.e2e",
      actor: { kind: "service", cn: "test", orgId },
    });
    expect(env.signatures.length).toBe(2);

    // Verify through the catalog-driven runSigningVerify — proves
    // that hybrid AWS-KMS envelopes verify the same way LocalDisk
    // hybrid envelopes do, with no AWS access on the verify side.
    const result = await runSigningVerify(cp, orgId, {
      envelope: env,
      payload,
      mode: "strict",
    });
    expect(result.ok).toBe(true);
    expect(result.matchedKeys.length).toBe(2);
    void added;
    void privateKey;
  });
});
