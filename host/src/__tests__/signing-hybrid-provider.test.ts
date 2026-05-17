/**
 * HybridProvider composition tests — WS9 v0.5.1 M7.
 *
 * The provider composes two leaf SigningProviders into one hybrid.
 * v0.5.1 supports three concrete shapes:
 *   - LocalDisk-classical + LocalDisk-PQ
 *   - AwsKms-classical + LocalDisk-PQ (the registration path
 *     exercised by signing-verbs-hybrid-kms.test.ts)
 *   - AwsKms-classical + AwsKms-PQ (deferred; both-KMS path is
 *     gated on AwsKmsProvider supporting ml-dsa-65)
 *
 * These tests cover the composition pattern itself with mocked leaf
 * providers. End-to-end registration + verify is covered separately.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AwsKmsProvider,
  freshNonce,
  HybridProvider,
  type KmsClientLike,
  LocalDiskProvider,
  type PublicKeyRef,
  type SigningProvider,
  SigningError,
  type SignRequest,
} from "../control-plane/signing/index.js";

function legacyActor() {
  return { kind: "service" as const, cn: "test", orgId: "default" };
}

function makeRequest(keyId: string, payload = "hello hybrid"): SignRequest {
  return {
    keyId,
    payload: new TextEncoder().encode(payload),
    nonce: freshNonce(),
    requestedAt: new Date().toISOString(),
    purpose: "test.hybrid-provider",
    actor: legacyActor(),
  };
}

/** Mocked KMS client (same shape as in signing-aws-kms.test.ts). */
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
        return { PublicKey: new Uint8Array(publicKeyDer) };
      }
      if (name === "SignCommand") {
        const input = (cmd as { input: { Message?: Uint8Array } }).input;
        const sig = crypto.sign("sha256", input.Message!, privObj);
        return { Signature: new Uint8Array(sig) };
      }
      throw new Error(`unexpected: ${name}`);
    }) as KmsClientLike["send"],
  };
  return { client, publicKeyDer, privateKey: privObj };
}

describe("HybridProvider: constructor validation", () => {
  function classicalLeaf(): SigningProvider {
    return new LocalDiskProvider();
  }
  function pqLeaf(): SigningProvider {
    return new LocalDiskProvider();
  }

  it("rejects a classical leaf that only supports ml-dsa-65", () => {
    // Fake provider that ONLY supports ml-dsa-65 — invalid for the
    // classical slot.
    const bad: SigningProvider = {
      id: "fake",
      supportedAlgorithms: ["ml-dsa-65"],
      sign: () => Promise.reject(new Error("nope")),
      verify: () => Promise.reject(new Error("nope")),
      fingerprint: () => Promise.reject(new Error("nope")),
      listKeys: () => Promise.resolve([]),
    };
    expect(
      () =>
        new HybridProvider({
          classical: bad,
          pq: pqLeaf(),
          classicalKeyId: "c",
          pqKeyId: "p",
        }),
    ).toThrow(SigningError);
  });

  it("rejects a pq leaf that doesn't support ml-dsa-65", () => {
    const bad: SigningProvider = {
      id: "fake",
      supportedAlgorithms: ["ed25519"],
      sign: () => Promise.reject(new Error("nope")),
      verify: () => Promise.reject(new Error("nope")),
      fingerprint: () => Promise.reject(new Error("nope")),
      listKeys: () => Promise.resolve([]),
    };
    expect(
      () =>
        new HybridProvider({
          classical: classicalLeaf(),
          pq: bad,
          classicalKeyId: "c",
          pqKeyId: "p",
        }),
    ).toThrow(SigningError);
  });

  it("accepts two valid leaves", () => {
    const p = new HybridProvider({
      classical: classicalLeaf(),
      pq: pqLeaf(),
      classicalKeyId: "c",
      pqKeyId: "p",
    });
    expect(p.id).toBe("hybrid");
    expect(p.supportedAlgorithms).toContain("ed25519");
    expect(p.supportedAlgorithms).toContain("ml-dsa-65");
  });
});

describe("HybridProvider over two LocalDiskProvider leaves", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "signalman-hp-localdisk-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("sign emits two SigEntries (classical + ml-dsa-65) in correct order", async () => {
    // Set up two LocalDiskProvider instances against the same tmp.
    // First, generate a hybrid key (M1b style) — this gives us a
    // classical and a PQ keypair on disk under one alias.
    const setup = new LocalDiskProvider({ keysDir: tmp });
    const gen = setup.generateHybridKey("hybrid-test");
    // Now split into two leaf providers: each LocalDiskProvider
    // points at the SAME keysDir. The classical leaf resolves
    // alias "hybrid-test-ed25519" via the flat-alias path; the PQ
    // leaf resolves alias "hybrid-test-mldsa65" via the same path.
    // Wait — these aliases collide with the M1b paired-file detection.
    // Easier: use absolute key paths for the classical leaf and the
    // alias-as-keyId form for PQ via a separate alias.
    void gen;
    // Simpler: use two SEPARATE keysDir directories for the two
    // leaves. classicalDir has only ed25519 files; pqDir has only
    // mldsa65 files.
    const classicalDir = fs.mkdtempSync(path.join(os.tmpdir(), "hp-c-"));
    const pqDir = fs.mkdtempSync(path.join(os.tmpdir(), "hp-pq-"));
    try {
      const classicalLp = new LocalDiskProvider({ keysDir: classicalDir });
      const classicalGen = classicalLp.generateHybridKey("c");
      // Discard the PQ half from classicalDir — we want pure classical.
      fs.unlinkSync(classicalGen.pqKeyPath);
      fs.unlinkSync(classicalGen.pqPubPath);
      // Move classical half to flat alias.
      fs.renameSync(
        classicalGen.classicalKeyPath,
        path.join(classicalDir, "c.key"),
      );
      fs.renameSync(
        classicalGen.classicalPubPath,
        path.join(classicalDir, "c.pub"),
      );
      const pqLp = new LocalDiskProvider({ keysDir: pqDir });
      const pqGen = pqLp.generateHybridKey("p");
      fs.unlinkSync(pqGen.classicalKeyPath);
      fs.unlinkSync(pqGen.classicalPubPath);
      fs.renameSync(pqGen.pqKeyPath, path.join(pqDir, "p.key"));
      fs.renameSync(pqGen.pqPubPath, path.join(pqDir, "p.pub"));

      const hp = new HybridProvider({
        classical: classicalLp,
        pq: pqLp,
        classicalKeyId: "c",
        pqKeyId: "p",
      });
      const env = await hp.sign(makeRequest("hybrid"));
      expect(env.signatures.length).toBe(2);
      expect(env.signatures[0]!.algorithm).toBe("ed25519");
      expect(env.signatures[1]!.algorithm).toBe("ml-dsa-65");
      // Nonces echo.
      expect(env.nonce).toMatch(/^[0-9a-f]{32}$/);
    } finally {
      fs.rmSync(classicalDir, { recursive: true, force: true });
      fs.rmSync(pqDir, { recursive: true, force: true });
    }
  });
});

describe("HybridProvider verify: strict / transition / classical-only", () => {
  /**
   * Build a HybridProvider over an AwsKms classical + LocalDisk PQ
   * — same shape as the operator-facing AWS-KMS + local-fallback
   * registration path. Returns the provider + the public-key refs
   * needed to verify against.
   */
  async function buildHybridProvider(): Promise<{
    provider: HybridProvider;
    classicalKeyRef: PublicKeyRef;
    pqKeyRef: PublicKeyRef;
    cleanup: () => void;
  }> {
    const { client, publicKeyDer } = buildMockKms();
    const aws = new AwsKmsProvider({
      region: "us-east-1",
      credentials: { access_key_id: "k", secret_access_key: "s" },
      client,
    });
    const classicalArn = "arn:aws:kms:us-east-1:1234:key/abc";
    const classicalFp = await aws.fingerprint(classicalArn);

    const pqDir = fs.mkdtempSync(path.join(os.tmpdir(), "hp-verify-pq-"));
    const pqLp = new LocalDiskProvider({ keysDir: pqDir });
    const pqGen = pqLp.generateHybridKey("pq-half");
    // Discard classical half.
    fs.unlinkSync(pqGen.classicalKeyPath);
    fs.unlinkSync(pqGen.classicalPubPath);
    fs.renameSync(pqGen.pqKeyPath, path.join(pqDir, "pq-half.key"));
    fs.renameSync(pqGen.pqPubPath, path.join(pqDir, "pq-half.pub"));

    const provider = new HybridProvider({
      classical: aws,
      pq: pqLp,
      classicalKeyId: classicalArn,
      pqKeyId: "pq-half",
    });

    const classicalKeyRef: PublicKeyRef = {
      keyId: classicalArn,
      provider: "aws-kms",
      algorithm: "ecdsa-p256-sha256",
      publicKeyB64: publicKeyDer.toString("base64"),
      fingerprint: classicalFp,
    };
    const pqPubBytes = fs.readFileSync(path.join(pqDir, "pq-half.pub")).subarray(4);
    const pqKeyRef: PublicKeyRef = {
      keyId: "pq-half",
      provider: "local-disk",
      algorithm: "ml-dsa-65",
      publicKeyB64: Buffer.from(pqPubBytes).toString("base64"),
      fingerprint: crypto
        .createHash("sha256")
        .update(pqPubBytes)
        .digest("hex")
        .slice(0, 16),
    };

    return {
      provider,
      classicalKeyRef,
      pqKeyRef,
      cleanup: () => fs.rmSync(pqDir, { recursive: true, force: true }),
    };
  }

  it("strict: passes when both halves verify", async () => {
    const { provider, classicalKeyRef, pqKeyRef, cleanup } =
      await buildHybridProvider();
    try {
      const req = makeRequest("doesnt-matter-hybrid-routes");
      const env = await provider.sign(req);
      const result = await provider.verify(
        env,
        req.payload,
        [classicalKeyRef, pqKeyRef],
        "strict",
      );
      expect(result.ok).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("strict: fails when classical sig is tampered", async () => {
    const { provider, classicalKeyRef, pqKeyRef, cleanup } =
      await buildHybridProvider();
    try {
      const req = makeRequest("h");
      const env = await provider.sign(req);
      // Tamper classical entry.
      const tampered = {
        ...env,
        signatures: env.signatures.map((s) =>
          s.algorithm === "ecdsa-p256-sha256"
            ? {
                ...s,
                signatureB64: Buffer.from(s.signatureB64, "base64")
                  .map((b, i) => (i === 5 ? b ^ 0x01 : b))
                  .toString("base64"),
              }
            : s,
        ),
      };
      const result = await provider.verify(
        tampered,
        req.payload,
        [classicalKeyRef, pqKeyRef],
        "strict",
      );
      expect(result.ok).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("transition: passes when classical valid + PQ tampered", async () => {
    const { provider, classicalKeyRef, pqKeyRef, cleanup } =
      await buildHybridProvider();
    try {
      const req = makeRequest("h");
      const env = await provider.sign(req);
      const tampered = {
        ...env,
        signatures: env.signatures.map((s) =>
          s.algorithm === "ml-dsa-65"
            ? {
                ...s,
                signatureB64: Buffer.from(s.signatureB64, "base64")
                  .map((b, i) => (i === 10 ? b ^ 0x01 : b))
                  .toString("base64"),
              }
            : s,
        ),
      };
      const result = await provider.verify(
        tampered,
        req.payload,
        [classicalKeyRef, pqKeyRef],
        "transition",
      );
      expect(result.ok).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("transition: passes when PQ valid + classical tampered", async () => {
    const { provider, classicalKeyRef, pqKeyRef, cleanup } =
      await buildHybridProvider();
    try {
      const req = makeRequest("h");
      const env = await provider.sign(req);
      const tampered = {
        ...env,
        signatures: env.signatures.map((s) =>
          s.algorithm === "ecdsa-p256-sha256"
            ? {
                ...s,
                signatureB64: Buffer.from(s.signatureB64, "base64")
                  .map((b, i) => (i === 7 ? b ^ 0x01 : b))
                  .toString("base64"),
              }
            : s,
        ),
      };
      const result = await provider.verify(
        tampered,
        req.payload,
        [classicalKeyRef, pqKeyRef],
        "transition",
      );
      expect(result.ok).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("transition: fails when BOTH tampered", async () => {
    const { provider, classicalKeyRef, pqKeyRef, cleanup } =
      await buildHybridProvider();
    try {
      const req = makeRequest("h");
      const env = await provider.sign(req);
      const tampered = {
        ...env,
        signatures: env.signatures.map((s) => ({
          ...s,
          signatureB64: Buffer.from(s.signatureB64, "base64")
            .map((b, i) => (i === 9 ? b ^ 0x01 : b))
            .toString("base64"),
        })),
      };
      const result = await provider.verify(
        tampered,
        req.payload,
        [classicalKeyRef, pqKeyRef],
        "transition",
      );
      expect(result.ok).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("classical-only: passes when classical valid (PQ entry filtered)", async () => {
    const { provider, classicalKeyRef, pqKeyRef, cleanup } =
      await buildHybridProvider();
    try {
      const req = makeRequest("h");
      const env = await provider.sign(req);
      // Even tamper the PQ entry — classical-only ignores it.
      const tampered = {
        ...env,
        signatures: env.signatures.map((s) =>
          s.algorithm === "ml-dsa-65"
            ? {
                ...s,
                signatureB64: Buffer.alloc(64, 0xff).toString("base64"),
              }
            : s,
        ),
      };
      const result = await provider.verify(
        tampered,
        req.payload,
        [classicalKeyRef],
        "classical-only",
      );
      expect(result.ok).toBe(true);
      void pqKeyRef;
    } finally {
      cleanup();
    }
  });
});

describe("HybridProvider verify: defensive error paths", () => {
  function makeKeyRef(algorithm: "ed25519" | "ml-dsa-65"): PublicKeyRef {
    return {
      keyId: "x",
      provider: "test",
      algorithm,
      publicKeyB64: "AAAA",
      fingerprint: "deadbeefcafef00d",
    };
  }
  async function makeHybrid(): Promise<HybridProvider> {
    return new HybridProvider({
      classical: new LocalDiskProvider(),
      pq: new LocalDiskProvider(),
      classicalKeyId: "c",
      pqKeyId: "p",
    });
  }

  it("returns ok=false on empty envelope.signatures", async () => {
    const hp = await makeHybrid();
    const r = await hp.verify(
      {
        signatures: [],
        nonce: "0".repeat(32),
        payloadSha256: crypto.createHash("sha256").update("x").digest("hex"),
      },
      new TextEncoder().encode("x"),
      [makeKeyRef("ed25519")],
      "strict",
    );
    expect(r.ok).toBe(false);
    expect(r.reasonCode).toBe("bad-signature");
  });

  it("returns ok=false on empty keys array", async () => {
    const hp = await makeHybrid();
    const r = await hp.verify(
      {
        signatures: [
          {
            signatureB64: "AAAA",
            signedBy: "deadbeefcafef00d",
            algorithm: "ed25519",
            signedAt: new Date().toISOString(),
          },
        ],
        nonce: "0".repeat(32),
        payloadSha256: crypto.createHash("sha256").update("x").digest("hex"),
      },
      new TextEncoder().encode("x"),
      [],
      "strict",
    );
    expect(r.ok).toBe(false);
    expect(r.reasonCode).toBe("fingerprint-mismatch");
  });

  it("returns bad-signature on payloadSha256 mismatch (fast-fail)", async () => {
    const hp = await makeHybrid();
    const r = await hp.verify(
      {
        signatures: [
          {
            signatureB64: "AAAA",
            signedBy: "deadbeefcafef00d",
            algorithm: "ed25519",
            signedAt: new Date().toISOString(),
          },
        ],
        nonce: "0".repeat(32),
        // Wrong hash for "x".
        payloadSha256: "0".repeat(64),
      },
      new TextEncoder().encode("x"),
      [makeKeyRef("ed25519")],
      "strict",
    );
    expect(r.ok).toBe(false);
    expect(r.reasonCode).toBe("bad-signature");
    expect(r.reason).toMatch(/payloadSha256 mismatch/);
  });

  it("returns fingerprint-mismatch when no key matches the entry", async () => {
    const hp = await makeHybrid();
    const r = await hp.verify(
      {
        signatures: [
          {
            signatureB64: "AAAA",
            signedBy: "differentfp00000",
            algorithm: "ed25519",
            signedAt: new Date().toISOString(),
          },
        ],
        nonce: "0".repeat(32),
        payloadSha256: crypto.createHash("sha256").update("x").digest("hex"),
      },
      new TextEncoder().encode("x"),
      [makeKeyRef("ed25519")],
      "strict",
    );
    expect(r.ok).toBe(false);
    expect(r.reasonCode).toBe("fingerprint-mismatch");
  });

  it("classical-only mode rejects PQ-only envelopes with bad-signature", async () => {
    const hp = await makeHybrid();
    const r = await hp.verify(
      {
        signatures: [
          {
            signatureB64: "AAAA",
            signedBy: "deadbeefcafef00d",
            algorithm: "ml-dsa-65",
            signedAt: new Date().toISOString(),
          },
        ],
        nonce: "0".repeat(32),
        payloadSha256: crypto.createHash("sha256").update("x").digest("hex"),
      },
      new TextEncoder().encode("x"),
      [makeKeyRef("ml-dsa-65")],
      "classical-only",
    );
    expect(r.ok).toBe(false);
    expect(r.reasonCode).toBe("bad-signature");
  });

  it("transition mode returns firstFailure when nothing verifies", async () => {
    const hp = await makeHybrid();
    // Wrong fingerprint on the only entry → fingerprint-mismatch
    // surfaces as firstFailure in transition mode.
    const r = await hp.verify(
      {
        signatures: [
          {
            signatureB64: "AAAA",
            signedBy: "wrong0000000000",
            algorithm: "ed25519",
            signedAt: new Date().toISOString(),
          },
        ],
        nonce: "0".repeat(32),
        payloadSha256: crypto.createHash("sha256").update("x").digest("hex"),
      },
      new TextEncoder().encode("x"),
      [makeKeyRef("ed25519")],
      "transition",
    );
    expect(r.ok).toBe(false);
    expect(r.reasonCode).toBe("fingerprint-mismatch");
  });
});

describe("HybridProvider sign: defensive error paths", () => {
  it("throws internal-error when classical leaf returns no classical entry", async () => {
    const fakeClassical: SigningProvider = {
      id: "fake-c",
      supportedAlgorithms: ["ed25519"],
      sign: async () => ({
        signatures: [],
        nonce: "0".repeat(32),
        payloadSha256: "abc",
      }),
      verify: () => Promise.reject(new Error("nope")),
      fingerprint: () => Promise.resolve("c0000000000000000"),
      listKeys: () => Promise.resolve([]),
    };
    const pqDir = fs.mkdtempSync(path.join(os.tmpdir(), "hp-empty-pq-"));
    try {
      const pqLp = new LocalDiskProvider({ keysDir: pqDir });
      const pqGen = pqLp.generateHybridKey("p");
      fs.unlinkSync(pqGen.classicalKeyPath);
      fs.unlinkSync(pqGen.classicalPubPath);
      fs.renameSync(pqGen.pqKeyPath, path.join(pqDir, "p.key"));
      fs.renameSync(pqGen.pqPubPath, path.join(pqDir, "p.pub"));

      const hp = new HybridProvider({
        classical: fakeClassical,
        pq: pqLp,
        classicalKeyId: "c",
        pqKeyId: "p",
      });
      await expect(hp.sign(makeRequest("h"))).rejects.toThrow(
        /classical leaf returned no classical entries/,
      );
    } finally {
      fs.rmSync(pqDir, { recursive: true, force: true });
    }
  });

  it("throws internal-error when PQ leaf returns no ml-dsa-65 entry", async () => {
    const classicalDir = fs.mkdtempSync(path.join(os.tmpdir(), "hp-noPq-c-"));
    try {
      const cLp = new LocalDiskProvider({ keysDir: classicalDir });
      const cGen = cLp.generateHybridKey("c");
      fs.unlinkSync(cGen.pqKeyPath);
      fs.unlinkSync(cGen.pqPubPath);
      fs.renameSync(cGen.classicalKeyPath, path.join(classicalDir, "c.key"));
      fs.renameSync(cGen.classicalPubPath, path.join(classicalDir, "c.pub"));

      const fakePq: SigningProvider = {
        id: "fake-pq",
        supportedAlgorithms: ["ml-dsa-65"],
        sign: async () => ({
          signatures: [],
          nonce: "0".repeat(32),
          payloadSha256: "abc",
        }),
        verify: () => Promise.reject(new Error("nope")),
        fingerprint: () => Promise.resolve("p0000000000000000"),
        listKeys: () => Promise.resolve([]),
      };
      const hp = new HybridProvider({
        classical: cLp,
        pq: fakePq,
        classicalKeyId: "c",
        pqKeyId: "p",
      });
      await expect(hp.sign(makeRequest("h"))).rejects.toThrow(
        /pq leaf returned no ml-dsa-65 entries/,
      );
    } finally {
      fs.rmSync(classicalDir, { recursive: true, force: true });
    }
  });

  it("throws internal-error when leaves disagree on payloadSha256", async () => {
    // Build a fake PQ leaf that returns the right shape but a
    // mutated payloadSha256 — should surface as internal-error.
    const classicalDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "hp-disagree-c-"),
    );
    try {
      const cLp = new LocalDiskProvider({ keysDir: classicalDir });
      const cGen = cLp.generateHybridKey("c");
      fs.unlinkSync(cGen.pqKeyPath);
      fs.unlinkSync(cGen.pqPubPath);
      fs.renameSync(cGen.classicalKeyPath, path.join(classicalDir, "c.key"));
      fs.renameSync(cGen.classicalPubPath, path.join(classicalDir, "c.pub"));

      const liarPq: SigningProvider = {
        id: "liar-pq",
        supportedAlgorithms: ["ml-dsa-65"],
        sign: async () => ({
          signatures: [
            {
              signatureB64: "ZmFrZQ==",
              signedBy: "p0000000000000000",
              algorithm: "ml-dsa-65",
              signedAt: new Date().toISOString(),
            },
          ],
          nonce: "0".repeat(32),
          payloadSha256: "MISMATCH",
        }),
        verify: () => Promise.reject(new Error("nope")),
        fingerprint: () => Promise.resolve("p0000000000000000"),
        listKeys: () => Promise.resolve([]),
      };
      const hp = new HybridProvider({
        classical: cLp,
        pq: liarPq,
        classicalKeyId: "c",
        pqKeyId: "p",
      });
      await expect(hp.sign(makeRequest("h"))).rejects.toThrow(
        /leaf payloadSha256 disagreement/,
      );
    } finally {
      fs.rmSync(classicalDir, { recursive: true, force: true });
    }
  });
});

describe("HybridProvider: fingerprint + listKeys + rotate", () => {
  it("fingerprint() returns the classical-half fingerprint", async () => {
    const { client } = buildMockKms();
    const aws = new AwsKmsProvider({
      region: "us-east-1",
      credentials: { access_key_id: "k", secret_access_key: "s" },
      client,
    });
    const pqDir = fs.mkdtempSync(path.join(os.tmpdir(), "hp-fp-pq-"));
    try {
      const pqLp = new LocalDiskProvider({ keysDir: pqDir });
      const pqGen = pqLp.generateHybridKey("p");
      fs.unlinkSync(pqGen.classicalKeyPath);
      fs.unlinkSync(pqGen.classicalPubPath);
      fs.renameSync(pqGen.pqKeyPath, path.join(pqDir, "p.key"));
      fs.renameSync(pqGen.pqPubPath, path.join(pqDir, "p.pub"));

      const hp = new HybridProvider({
        classical: aws,
        pq: pqLp,
        classicalKeyId: "arn",
        pqKeyId: "p",
      });
      const fp = await hp.fingerprint("ignored");
      const classicalFp = await aws.fingerprint("arn");
      expect(fp).toBe(classicalFp);
    } finally {
      fs.rmSync(pqDir, { recursive: true, force: true });
    }
  });

  it("listKeys() returns union of leaf listKeys()", async () => {
    const { client } = buildMockKms();
    const aws = new AwsKmsProvider({
      region: "us-east-1",
      credentials: { access_key_id: "k", secret_access_key: "s" },
      client,
    });
    // AwsKmsProvider.listKeys returns []; LocalDisk listKeys returns
    // whatever's in its keysDir. So total = LocalDisk's view.
    const pqDir = fs.mkdtempSync(path.join(os.tmpdir(), "hp-ls-pq-"));
    try {
      const pqLp = new LocalDiskProvider({ keysDir: pqDir });
      const pqGen = pqLp.generateHybridKey("k1");
      fs.unlinkSync(pqGen.classicalKeyPath);
      fs.unlinkSync(pqGen.classicalPubPath);
      fs.renameSync(pqGen.pqKeyPath, path.join(pqDir, "k1.key"));
      fs.renameSync(pqGen.pqPubPath, path.join(pqDir, "k1.pub"));

      const hp = new HybridProvider({
        classical: aws,
        pq: pqLp,
        classicalKeyId: "arn",
        pqKeyId: "k1",
      });
      const keys = await hp.listKeys();
      // PQ leaf has one key; AWS leaf has zero (returns []).
      expect(keys.length).toBe(1);
      expect(keys[0]!.algorithm).toBe("ml-dsa-65");
    } finally {
      fs.rmSync(pqDir, { recursive: true, force: true });
    }
  });

  it("rotate() rejects when classical leaf lacks rotate()", async () => {
    const noRotateLeaf: SigningProvider = {
      id: "no-rotate",
      supportedAlgorithms: ["ed25519"],
      sign: () => Promise.reject(new Error("nope")),
      verify: () => Promise.reject(new Error("nope")),
      fingerprint: () => Promise.resolve("aaaabbbbccccdddd"),
      listKeys: () => Promise.resolve([]),
      // rotate omitted intentionally
    };
    const pqDir = fs.mkdtempSync(path.join(os.tmpdir(), "hp-rot-pq-"));
    try {
      const pqLp = new LocalDiskProvider({ keysDir: pqDir });
      const hp = new HybridProvider({
        classical: noRotateLeaf,
        pq: pqLp,
        classicalKeyId: "c",
        pqKeyId: "p",
      });
      await expect(hp.rotate("ignored")).rejects.toThrow(
        /classical leaf does not implement rotate/,
      );
    } finally {
      fs.rmSync(pqDir, { recursive: true, force: true });
    }
  });
});
