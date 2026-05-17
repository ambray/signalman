/**
 * AwsKmsProvider tests — WS9 Milestone 4.
 *
 * Mock the KMS client surface so tests don't hit AWS. The provider
 * accepts a `client: KmsClientLike` constructor option for exactly
 * this purpose. The mock client signs locally with a fresh ECDSA
 * P-256 keypair so verify() (which uses local crypto.verify against
 * the cached public-key bytes) produces real cryptographic round-trip
 * coverage — not just "did sign() get called".
 *
 * Tests cover:
 *   - sign + verify roundtrip with mocked kms:Sign + matching pubkey
 *   - fingerprint caching (single kms:GetPublicKey across N sign() calls)
 *   - publicKeyFor early-rejects ml-dsa-65 / non-P-256 keys
 *   - SignRequest validation paths (nonce, skew, payload, actor)
 *   - tampered envelope fails verify
 *   - cross-provider verify: AwsKmsProvider envelope verifies via
 *     LocalDiskProvider when both have the same public key (proves
 *     the "verify anywhere" property)
 *   - empty/zero-byte SDK response surfaces as io-error
 *   - listKeys returns empty (catalog is the source of truth)
 */

import * as crypto from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AwsKmsProvider,
  freshNonce,
  type KmsClientLike,
  LocalDiskProvider,
  SigningError,
  type PublicKeyRef,
} from "../control-plane/signing/index.js";

/**
 * Build a mock KMS client that signs locally with a real ECDSA P-256
 * keypair. Returns the mock + the matching public-key DER + a function
 * to retrieve call counts.
 */
function buildMockKms(): {
  client: KmsClientLike;
  publicKeyDer: Buffer;
  privateKey: crypto.KeyObject;
  callCounts: { sign: number; getPublicKey: number };
} {
  const { publicKey: publicKeyObj, privateKey: privateKeyObj } =
    crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const publicKeyDer = publicKeyObj.export({
    type: "spki",
    format: "der",
  }) as Buffer;
  const counts = { sign: 0, getPublicKey: 0 };

  const client: KmsClientLike = {
    send: vi.fn(async (cmd: unknown) => {
      // Discriminate by class name (the SDK commands carry their own).
      const name = (cmd as { constructor: { name: string } }).constructor.name;
      if (name === "SignCommand") {
        counts.sign += 1;
        const input = (cmd as { input: { Message?: Uint8Array } }).input;
        const sig = crypto.sign("sha256", input.Message!, privateKeyObj);
        return { Signature: new Uint8Array(sig) };
      }
      if (name === "GetPublicKeyCommand") {
        counts.getPublicKey += 1;
        return {
          PublicKey: new Uint8Array(publicKeyDer),
          SigningAlgorithms: ["ECDSA_SHA_256"],
        };
      }
      throw new Error(`unexpected KMS command: ${name}`);
    }) as KmsClientLike["send"],
  };
  return { client, publicKeyDer, privateKey: privateKeyObj, callCounts: counts };
}

function legacyActor() {
  return { kind: "service" as const, cn: "test", orgId: "default" };
}

function makeRequest(keyId: string, payload = "hello world") {
  return {
    keyId,
    payload: new TextEncoder().encode(payload),
    nonce: freshNonce(),
    requestedAt: new Date().toISOString(),
    purpose: "test.kms",
    actor: legacyActor(),
  };
}

describe("AwsKmsProvider: identity", () => {
  it("has the stable provider id + supports only ecdsa-p256-sha256 in M4", () => {
    const { client } = buildMockKms();
    const p = new AwsKmsProvider({
      region: "us-east-1",
      credentials: { access_key_id: "k", secret_access_key: "s" },
      client,
    });
    expect(p.id).toBe("aws-kms");
    expect(p.supportedAlgorithms).toEqual(["ecdsa-p256-sha256"]);
    expect(p.supportedAlgorithms).not.toContain("ed25519");
    expect(p.supportedAlgorithms).not.toContain("ml-dsa-65");
  });
});

describe("AwsKmsProvider: sign + verify roundtrip", () => {
  it("signs via kms:Sign and verifies locally (no KMS roundtrip on verify)", async () => {
    const { client, publicKeyDer, callCounts } = buildMockKms();
    const p = new AwsKmsProvider({
      region: "us-east-1",
      credentials: { access_key_id: "k", secret_access_key: "s" },
      client,
    });
    const req = makeRequest("arn:aws:kms:us-east-1:1234:key/abc");
    const env = await p.sign(req);
    expect(env.signatures.length).toBe(1);
    expect(env.signatures[0]!.algorithm).toBe("ecdsa-p256-sha256");
    // Build PublicKeyRef from the cached bytes — same shape the
    // catalog would persist.
    const keyRef: PublicKeyRef = {
      keyId: req.keyId,
      provider: "aws-kms",
      algorithm: "ecdsa-p256-sha256",
      publicKeyB64: publicKeyDer.toString("base64"),
      fingerprint: env.signatures[0]!.signedBy,
    };
    const verify = await p.verify(env, req.payload, [keyRef], "strict");
    expect(verify.ok).toBe(true);
    // verify() did NOT touch KMS — counts unchanged after verify.
    const signsBeforeVerify = callCounts.sign;
    const getsBeforeVerify = callCounts.getPublicKey;
    await p.verify(env, req.payload, [keyRef], "strict");
    expect(callCounts.sign).toBe(signsBeforeVerify);
    expect(callCounts.getPublicKey).toBe(getsBeforeVerify);
  });

  it("fingerprint() caches across calls — one kms:GetPublicKey per ARN", async () => {
    const { client, callCounts } = buildMockKms();
    const p = new AwsKmsProvider({
      region: "us-east-1",
      credentials: { access_key_id: "k", secret_access_key: "s" },
      client,
    });
    const arn = "arn:aws:kms:us-east-1:1234:key/abc";
    const fp1 = await p.fingerprint(arn);
    const fp2 = await p.fingerprint(arn);
    expect(fp1).toBe(fp2);
    expect(callCounts.getPublicKey).toBe(1);
  });

  it("multiple sign() calls reuse the cached public key after first GetPublicKey", async () => {
    const { client, callCounts } = buildMockKms();
    const p = new AwsKmsProvider({
      region: "us-east-1",
      credentials: { access_key_id: "k", secret_access_key: "s" },
      client,
    });
    await p.sign(makeRequest("arn1"));
    await p.sign(makeRequest("arn1"));
    await p.sign(makeRequest("arn1"));
    expect(callCounts.getPublicKey).toBe(1);
    expect(callCounts.sign).toBe(3);
  });

  it("tampered envelope payload fails verify with bad-signature", async () => {
    const { client, publicKeyDer } = buildMockKms();
    const p = new AwsKmsProvider({
      region: "us-east-1",
      credentials: { access_key_id: "k", secret_access_key: "s" },
      client,
    });
    const req = makeRequest("arn");
    const env = await p.sign(req);
    const keyRef: PublicKeyRef = {
      keyId: req.keyId,
      provider: "aws-kms",
      algorithm: "ecdsa-p256-sha256",
      publicKeyB64: publicKeyDer.toString("base64"),
      fingerprint: env.signatures[0]!.signedBy,
    };
    const tampered = new TextEncoder().encode("hello WORLD!");
    const v = await p.verify(env, tampered, [keyRef], "strict");
    expect(v.ok).toBe(false);
    expect(v.reasonCode).toBe("bad-signature");
  });

  it("wrong-key verify fails with fingerprint-mismatch", async () => {
    const { client } = buildMockKms();
    const p = new AwsKmsProvider({
      region: "us-east-1",
      credentials: { access_key_id: "k", secret_access_key: "s" },
      client,
    });
    const req = makeRequest("arn");
    const env = await p.sign(req);
    // A different P-256 key — same algorithm, different fingerprint.
    const otherPub = crypto.generateKeyPairSync("ec", {
      namedCurve: "prime256v1",
    }).publicKey;
    const otherDer = otherPub.export({ type: "spki", format: "der" }) as Buffer;
    const otherFp = crypto.createHash("sha256").update(otherDer).digest("hex").slice(0, 16);
    const wrong: PublicKeyRef = {
      keyId: "arn",
      provider: "aws-kms",
      algorithm: "ecdsa-p256-sha256",
      publicKeyB64: otherDer.toString("base64"),
      fingerprint: otherFp,
    };
    const v = await p.verify(env, req.payload, [wrong], "strict");
    expect(v.ok).toBe(false);
    expect(v.reasonCode).toBe("fingerprint-mismatch");
  });
});

describe("AwsKmsProvider: cross-provider verify", () => {
  it("AwsKmsProvider-produced envelope verifies through LocalDiskProvider (verify-anywhere property)", async () => {
    const { client, publicKeyDer } = buildMockKms();
    const aws = new AwsKmsProvider({
      region: "us-east-1",
      credentials: { access_key_id: "k", secret_access_key: "s" },
      client,
    });
    const req = makeRequest("arn");
    const env = await aws.sign(req);
    const keyRef: PublicKeyRef = {
      keyId: req.keyId,
      provider: "aws-kms",
      algorithm: "ecdsa-p256-sha256",
      publicKeyB64: publicKeyDer.toString("base64"),
      fingerprint: env.signatures[0]!.signedBy,
    };
    // Verify via LocalDiskProvider — proves that a third-party
    // verifier (CI, registry, etc.) with NO KMS access can still
    // verify cloud-KMS-produced signatures using only the cached
    // public-key bytes from the catalog.
    const local = new LocalDiskProvider();
    const v = await local.verify(env, req.payload, [keyRef], "strict");
    expect(v.ok).toBe(true);
  });
});

describe("AwsKmsProvider: SignRequest validation", () => {
  let provider: AwsKmsProvider;
  let client: KmsClientLike;
  beforeEach(() => {
    ({ client } = buildMockKms());
    provider = new AwsKmsProvider({
      region: "us-east-1",
      credentials: { access_key_id: "k", secret_access_key: "s" },
      client,
    });
  });

  it("rejects empty payload", async () => {
    await expect(
      provider.sign({
        ...makeRequest("arn"),
        payload: new Uint8Array(0),
      }),
    ).rejects.toThrow(/payload/);
  });

  it("rejects empty purpose", async () => {
    await expect(
      provider.sign({ ...makeRequest("arn"), purpose: "" }),
    ).rejects.toThrow(/purpose/);
  });

  it("rejects missing actor.cn", async () => {
    await expect(
      provider.sign({
        ...makeRequest("arn"),
        actor: { kind: "service", cn: "", orgId: "default" },
      }),
    ).rejects.toThrow(/actor/);
  });

  it("rejects malformed nonce", async () => {
    await expect(
      provider.sign({ ...makeRequest("arn"), nonce: "not-hex-not-hex-not-hex-not-hex-" }),
    ).rejects.toThrow(/nonce/);
  });

  it("rejects requestedAt skew > 60s", async () => {
    await expect(
      provider.sign({
        ...makeRequest("arn"),
        requestedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
      }),
    ).rejects.toThrow(/skew/);
  });
});

describe("AwsKmsProvider: error mapping", () => {
  it("maps NotFoundException to key-not-found", async () => {
    const client: KmsClientLike = {
      send: (async () => {
        const err = new Error("key not found");
        err.name = "NotFoundException";
        throw err;
      }) as KmsClientLike["send"],
    };
    const p = new AwsKmsProvider({
      region: "us-east-1",
      credentials: { access_key_id: "k", secret_access_key: "s" },
      client,
    });
    await expect(p.fingerprint("arn:missing")).rejects.toMatchObject({
      code: "key-not-found",
    });
  });

  it("maps AccessDeniedException to key-revoked", async () => {
    const client: KmsClientLike = {
      send: (async () => {
        const err = new Error("denied");
        err.name = "AccessDeniedException";
        throw err;
      }) as KmsClientLike["send"],
    };
    const p = new AwsKmsProvider({
      region: "us-east-1",
      credentials: { access_key_id: "k", secret_access_key: "s" },
      client,
    });
    await expect(p.fingerprint("arn:locked")).rejects.toMatchObject({
      code: "key-revoked",
    });
  });

  it("maps ThrottlingException to io-error", async () => {
    const client: KmsClientLike = {
      send: (async () => {
        const err = new Error("rate limited");
        err.name = "ThrottlingException";
        throw err;
      }) as KmsClientLike["send"],
    };
    const p = new AwsKmsProvider({
      region: "us-east-1",
      credentials: { access_key_id: "k", secret_access_key: "s" },
      client,
    });
    await expect(p.fingerprint("arn:throttled")).rejects.toMatchObject({
      code: "io-error",
    });
  });

  it("surfaces empty Signature response as io-error", async () => {
    const { client: realClient, publicKeyDer } = buildMockKms();
    void publicKeyDer;
    const client: KmsClientLike = {
      send: (async (cmd: unknown) => {
        const name = (cmd as { constructor: { name: string } }).constructor.name;
        if (name === "SignCommand") return { Signature: undefined };
        // Fall through to real mock for GetPublicKey.
        return realClient.send(cmd as never);
      }) as KmsClientLike["send"],
    };
    const p = new AwsKmsProvider({
      region: "us-east-1",
      credentials: { access_key_id: "k", secret_access_key: "s" },
      client,
    });
    await expect(p.sign(makeRequest("arn"))).rejects.toMatchObject({
      code: "io-error",
    });
  });
});

describe("AwsKmsProvider: algorithm rejection", () => {
  it("rejects ml-dsa-65 envelopes in verify with algorithm-not-implemented", async () => {
    const { client } = buildMockKms();
    const p = new AwsKmsProvider({
      region: "us-east-1",
      credentials: { access_key_id: "k", secret_access_key: "s" },
      client,
    });
    const fakeKey: PublicKeyRef = {
      keyId: "arn:pq",
      provider: "aws-kms",
      algorithm: "ml-dsa-65",
      publicKeyB64: Buffer.from("fake").toString("base64"),
      fingerprint: "deadbeefcafef00d",
    };
    const fakeEnv = {
      signatures: [
        {
          signatureB64: Buffer.from("sig").toString("base64"),
          signedBy: "deadbeefcafef00d",
          algorithm: "ml-dsa-65" as const,
          signedAt: new Date().toISOString(),
        },
      ],
      nonce: "0".repeat(32),
      payloadSha256: crypto
        .createHash("sha256")
        .update("x")
        .digest("hex"),
    };
    const result = await p.verify(
      fakeEnv,
      new TextEncoder().encode("x"),
      [fakeKey],
      "strict",
    );
    expect(result.ok).toBe(false);
    expect(result.reasonCode).toBe("algorithm-not-implemented");
  });

  it("rejects an ed25519 KMS key surfacing during GetPublicKey", async () => {
    // Build a real Ed25519 key + a client that returns its SPKI.
    const edPub = crypto.generateKeyPairSync("ed25519").publicKey;
    const edDer = edPub.export({ type: "spki", format: "der" }) as Buffer;
    const client: KmsClientLike = {
      send: (async (cmd: unknown) => {
        const name = (cmd as { constructor: { name: string } }).constructor.name;
        if (name === "GetPublicKeyCommand") {
          return { PublicKey: new Uint8Array(edDer) };
        }
        throw new Error("unexpected");
      }) as KmsClientLike["send"],
    };
    const p = new AwsKmsProvider({
      region: "us-east-1",
      credentials: { access_key_id: "k", secret_access_key: "s" },
      client,
    });
    await expect(p.fingerprint("arn:ed25519")).rejects.toMatchObject({
      code: "algorithm-not-implemented",
    });
  });
});

describe("AwsKmsProvider: additional error-code mappings", () => {
  function clientThrowing(name: string): KmsClientLike {
    return {
      send: (async () => {
        const err = new Error(`KMS ${name}`);
        err.name = name;
        throw err;
      }) as KmsClientLike["send"],
    };
  }
  function newProvider(client: KmsClientLike): AwsKmsProvider {
    return new AwsKmsProvider({
      region: "us-east-1",
      credentials: { access_key_id: "k", secret_access_key: "s" },
      client,
    });
  }

  it("maps DisabledException to key-revoked", async () => {
    const p = newProvider(clientThrowing("DisabledException"));
    await expect(p.fingerprint("arn:dis")).rejects.toMatchObject({ code: "key-revoked" });
  });

  it("maps KMSInvalidStateException to key-revoked", async () => {
    const p = newProvider(clientThrowing("KMSInvalidStateException"));
    await expect(p.fingerprint("arn:bad")).rejects.toMatchObject({ code: "key-revoked" });
  });

  it("maps ValidationException to unknown-algorithm", async () => {
    const p = newProvider(clientThrowing("ValidationException"));
    await expect(p.fingerprint("arn:val")).rejects.toMatchObject({ code: "unknown-algorithm" });
  });

  it("maps LimitExceededException to io-error", async () => {
    const p = newProvider(clientThrowing("LimitExceededException"));
    await expect(p.fingerprint("arn:limit")).rejects.toMatchObject({ code: "io-error" });
  });

  it("falls through to io-error on unknown error name", async () => {
    const p = newProvider(clientThrowing("SomeRandomError"));
    await expect(p.fingerprint("arn:weird")).rejects.toMatchObject({ code: "io-error" });
  });
});

describe("AwsKmsProvider: verify edge cases", () => {
  it("returns ok=false when envelope.signatures is empty", async () => {
    const { client, publicKeyDer } = buildMockKms();
    const p = new AwsKmsProvider({
      region: "us-east-1",
      credentials: { access_key_id: "k", secret_access_key: "s" },
      client,
    });
    const fakeKey: PublicKeyRef = {
      keyId: "arn",
      provider: "aws-kms",
      algorithm: "ecdsa-p256-sha256",
      publicKeyB64: publicKeyDer.toString("base64"),
      fingerprint: "deadbeefcafef00d",
    };
    const result = await p.verify(
      {
        signatures: [],
        nonce: "0".repeat(32),
        payloadSha256: crypto
          .createHash("sha256")
          .update("x")
          .digest("hex"),
      },
      new TextEncoder().encode("x"),
      [fakeKey],
      "strict",
    );
    expect(result.ok).toBe(false);
    expect(result.reasonCode).toBe("bad-signature");
  });

  it("returns ok=false when no keys are supplied", async () => {
    const { client, publicKeyDer } = buildMockKms();
    const p = new AwsKmsProvider({
      region: "us-east-1",
      credentials: { access_key_id: "k", secret_access_key: "s" },
      client,
    });
    const env = await p.sign(makeRequest("arn"));
    void publicKeyDer;
    const result = await p.verify(env, makeRequest("arn").payload, [], "strict");
    expect(result.ok).toBe(false);
    expect(result.reasonCode).toBe("fingerprint-mismatch");
  });

  it("classical-only mode with PQ-only envelope rejects (no signatures consider-able)", async () => {
    const { client, publicKeyDer } = buildMockKms();
    const p = new AwsKmsProvider({
      region: "us-east-1",
      credentials: { access_key_id: "k", secret_access_key: "s" },
      client,
    });
    const result = await p.verify(
      {
        signatures: [
          {
            signatureB64: "AAAA",
            signedBy: "deadbeefcafef00d",
            algorithm: "ml-dsa-65" as const,
            signedAt: new Date().toISOString(),
          },
        ],
        nonce: "0".repeat(32),
        payloadSha256: crypto.createHash("sha256").update("x").digest("hex"),
      },
      new TextEncoder().encode("x"),
      [
        {
          keyId: "arn",
          provider: "aws-kms",
          algorithm: "ml-dsa-65",
          publicKeyB64: publicKeyDer.toString("base64"),
          fingerprint: "deadbeefcafef00d",
        },
      ],
      "classical-only",
    );
    expect(result.ok).toBe(false);
    expect(result.reasonCode).toBe("bad-signature");
  });

  it("transition mode succeeds when one valid + one tampered (constructed envelope)", async () => {
    const { client, publicKeyDer } = buildMockKms();
    const p = new AwsKmsProvider({
      region: "us-east-1",
      credentials: { access_key_id: "k", secret_access_key: "s" },
      client,
    });
    const req = makeRequest("arn");
    const goodEnv = await p.sign(req);
    const goodEntry = goodEnv.signatures[0]!;
    // Build a second entry with a tampered signature against a different fingerprint.
    const tamperedEntry = {
      signatureB64: Buffer.alloc(64, 0xff).toString("base64"),
      signedBy: "deadbeefcafef00d",
      algorithm: "ecdsa-p256-sha256" as const,
      signedAt: new Date().toISOString(),
    };
    const env = {
      ...goodEnv,
      signatures: [tamperedEntry, goodEntry],
    };
    const keyRef: PublicKeyRef = {
      keyId: req.keyId,
      provider: "aws-kms",
      algorithm: "ecdsa-p256-sha256",
      publicKeyB64: publicKeyDer.toString("base64"),
      fingerprint: goodEntry.signedBy,
    };
    const v = await p.verify(env, req.payload, [keyRef], "transition");
    expect(v.ok).toBe(true);
  });

  it("transition mode reports first failure when nothing verifies", async () => {
    const { client, publicKeyDer } = buildMockKms();
    const p = new AwsKmsProvider({
      region: "us-east-1",
      credentials: { access_key_id: "k", secret_access_key: "s" },
      client,
    });
    const fakeKey: PublicKeyRef = {
      keyId: "arn",
      provider: "aws-kms",
      algorithm: "ecdsa-p256-sha256",
      publicKeyB64: publicKeyDer.toString("base64"),
      fingerprint: "wrongfingerprint",
    };
    const result = await p.verify(
      {
        signatures: [
          {
            signatureB64: "AAAA",
            signedBy: "differentfp00000",
            algorithm: "ecdsa-p256-sha256" as const,
            signedAt: new Date().toISOString(),
          },
        ],
        nonce: "0".repeat(32),
        payloadSha256: crypto.createHash("sha256").update("x").digest("hex"),
      },
      new TextEncoder().encode("x"),
      [fakeKey],
      "transition",
    );
    expect(result.ok).toBe(false);
    expect(result.reasonCode).toBe("fingerprint-mismatch");
  });
});

describe("AwsKmsProvider: real-client construction", () => {
  it("constructs a real KMSClient when no client override is passed", () => {
    // Validates the production constructor path (no `client:` opt).
    // We don't make any KMS calls — just exercise the construction.
    const p = new AwsKmsProvider({
      region: "us-east-1",
      credentials: { access_key_id: "k", secret_access_key: "s" },
    });
    expect(p.id).toBe("aws-kms");
    expect(p.supportedAlgorithms).toContain("ecdsa-p256-sha256");
  });
});

describe("AwsKmsProvider: listKeys + cachePublicKey", () => {
  it("listKeys returns empty (catalog is the source of truth)", async () => {
    const { client } = buildMockKms();
    const p = new AwsKmsProvider({
      region: "us-east-1",
      credentials: { access_key_id: "k", secret_access_key: "s" },
      client,
    });
    const keys = await p.listKeys();
    expect(keys).toEqual([]);
  });

  it("cachePublicKey() pre-populates without a kms:GetPublicKey call", async () => {
    const { client, publicKeyDer, callCounts } = buildMockKms();
    const p = new AwsKmsProvider({
      region: "us-east-1",
      credentials: { access_key_id: "k", secret_access_key: "s" },
      client,
    });
    const fp = crypto
      .createHash("sha256")
      .update(publicKeyDer)
      .digest("hex")
      .slice(0, 16);
    p.cachePublicKey({
      keyId: "arn:cached",
      publicKeyDer,
      algorithm: "ecdsa-p256-sha256",
      fingerprint: fp,
    });
    expect(await p.fingerprint("arn:cached")).toBe(fp);
    expect(callCounts.getPublicKey).toBe(0);
  });

  it("cachePublicKey() rejects non-ecdsa-p256 algorithms", () => {
    const { client } = buildMockKms();
    const p = new AwsKmsProvider({
      region: "us-east-1",
      credentials: { access_key_id: "k", secret_access_key: "s" },
      client,
    });
    expect(() =>
      p.cachePublicKey({
        keyId: "x",
        publicKeyDer: Buffer.from("x"),
        algorithm: "ml-dsa-65",
        fingerprint: "deadbeef00000000",
      }),
    ).toThrow(SigningError);
  });
});
