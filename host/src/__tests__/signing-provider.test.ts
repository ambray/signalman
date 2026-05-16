/**
 * LocalDiskProvider unit tests — WS9 Milestones 1a + 1b.
 *
 * Covers the new provider abstraction directly; the legacy
 * signManifest/verifyManifest shim is tested separately in
 * signing.test.ts (preserved from v0.4.x) and signing-byte-parity.test.ts.
 *
 * Milestone 1b additions are in signing-mldsa.test.ts and
 * signing-hybrid.test.ts (ML-DSA-65 + hybrid keys + verifier modes).
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  AlgorithmNotImplementedError,
  LocalDiskProvider,
  type SignRequest,
  SigningError,
  freshNonce,
  publicKeyRefFromPem,
} from "../control-plane/signing/index.js";

function ed25519Keypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  return { publicKeyPem: publicKey as string, privateKeyPem: privateKey as string };
}

function ecdsaP256Keypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  return { publicKeyPem: publicKey as string, privateKeyPem: privateKey as string };
}

function rsaKeypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  return { publicKeyPem: publicKey as string, privateKeyPem: privateKey as string };
}

function legacyActor() {
  return { kind: "service" as const, cn: "test", orgId: "default" };
}

function makeRequest(overrides: Partial<SignRequest> = {}): SignRequest {
  return {
    keyId: "inline",
    payload: new TextEncoder().encode("hello world"),
    nonce: freshNonce(),
    requestedAt: new Date().toISOString(),
    purpose: "test.unit",
    actor: legacyActor(),
    ...overrides,
  };
}

describe("LocalDiskProvider: identity", () => {
  it("has the stable provider id and the v0.5.0 algorithm support set", () => {
    const p = new LocalDiskProvider();
    expect(p.id).toBe("local-disk");
    expect(p.supportedAlgorithms).toContain("ed25519");
    expect(p.supportedAlgorithms).toContain("ecdsa-p256-sha256");
    // Milestone 1b: ml-dsa-65 is now supported.
    expect(p.supportedAlgorithms).toContain("ml-dsa-65");
  });
});

describe("LocalDiskProvider.fromInlinePem: algorithm detection", () => {
  it("accepts an Ed25519 PEM and reports algorithm=ed25519", async () => {
    const kp = ed25519Keypair();
    const p = LocalDiskProvider.fromInlinePem(kp.privateKeyPem);
    const env = await p.sign(makeRequest());
    expect(env.signatures[0]!.algorithm).toBe("ed25519");
  });

  it("accepts an ECDSA P-256 PEM and reports algorithm=ecdsa-p256-sha256", async () => {
    const kp = ecdsaP256Keypair();
    const p = LocalDiskProvider.fromInlinePem(kp.privateKeyPem);
    const env = await p.sign(makeRequest());
    expect(env.signatures[0]!.algorithm).toBe("ecdsa-p256-sha256");
  });

  it("rejects RSA at PEM-load time with a stable SigningError code", () => {
    const kp = rsaKeypair();
    expect(() => LocalDiskProvider.fromInlinePem(kp.privateKeyPem)).toThrow(
      SigningError,
    );
    try {
      LocalDiskProvider.fromInlinePem(kp.privateKeyPem);
    } catch (err) {
      expect((err as SigningError).code).toBe("unknown-algorithm");
    }
  });

  it("rejects an EC key on a non-P-256 curve", () => {
    const { privateKey } = crypto.generateKeyPairSync("ec", {
      namedCurve: "secp384r1",
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    expect(() => LocalDiskProvider.fromInlinePem(privateKey as string)).toThrow(
      SigningError,
    );
  });
});

describe("LocalDiskProvider.sign: SignRequest validation", () => {
  let providerKp: ReturnType<typeof ed25519Keypair>;
  let provider: LocalDiskProvider;
  beforeEach(() => {
    providerKp = ed25519Keypair();
    provider = LocalDiskProvider.fromInlinePem(providerKp.privateKeyPem);
  });

  it("rejects an empty payload", async () => {
    await expect(
      provider.sign(makeRequest({ payload: new Uint8Array(0) })),
    ).rejects.toThrow(/payload/);
  });

  it("rejects an empty purpose", async () => {
    await expect(provider.sign(makeRequest({ purpose: "" }))).rejects.toThrow(
      /purpose/,
    );
  });

  it("rejects an actor with empty cn", async () => {
    await expect(
      provider.sign(
        makeRequest({ actor: { kind: "service", cn: "", orgId: "default" } }),
      ),
    ).rejects.toThrow(/actor/);
  });

  it("rejects a non-hex nonce", async () => {
    await expect(
      provider.sign(makeRequest({ nonce: "not-a-hex-string-not-a-hex-stri" })),
    ).rejects.toThrow(/nonce/);
  });

  it("rejects a nonce of the wrong length", async () => {
    await expect(
      provider.sign(makeRequest({ nonce: "abcd" })),
    ).rejects.toThrow(/nonce/);
  });

  it("rejects a requestedAt that is not RFC 3339", async () => {
    await expect(
      provider.sign(makeRequest({ requestedAt: "not a date" })),
    ).rejects.toThrow(/skew|requestedAt/);
  });

  it("rejects a requestedAt with skew > 60s", async () => {
    const farPast = new Date(Date.now() - 5 * 60_000).toISOString();
    await expect(
      provider.sign(makeRequest({ requestedAt: farPast })),
    ).rejects.toThrow(/skew/);
  });

  it("accepts a fresh request with no errors", async () => {
    const env = await provider.sign(makeRequest());
    expect(env.signatures.length).toBe(1);
    expect(env.signatures[0]!.signatureB64).toMatch(/^[A-Za-z0-9+/=]+$/);
  });
});

describe("LocalDiskProvider.sign + verify roundtrip", () => {
  it("Ed25519: sign then verify against the matching public key returns ok=true", async () => {
    const kp = ed25519Keypair();
    const p = LocalDiskProvider.fromInlinePem(kp.privateKeyPem);
    const req = makeRequest();
    const env = await p.sign(req);
    const keyRef = publicKeyRefFromPem(kp.publicKeyPem);
    const result = await p.verify(env, req.payload, [keyRef], "strict");
    expect(result.ok).toBe(true);
  });

  it("ECDSA P-256: sign then verify against the matching public key returns ok=true", async () => {
    const kp = ecdsaP256Keypair();
    const p = LocalDiskProvider.fromInlinePem(kp.privateKeyPem);
    const req = makeRequest();
    const env = await p.sign(req);
    const keyRef = publicKeyRefFromPem(kp.publicKeyPem);
    const result = await p.verify(env, req.payload, [keyRef], "strict");
    expect(result.ok).toBe(true);
  });

  it("verify against a different public key returns ok=false with fingerprint-mismatch", async () => {
    const signerKp = ed25519Keypair();
    const otherKp = ed25519Keypair();
    const p = LocalDiskProvider.fromInlinePem(signerKp.privateKeyPem);
    const req = makeRequest();
    const env = await p.sign(req);
    const otherKeyRef = publicKeyRefFromPem(otherKp.publicKeyPem);
    const result = await p.verify(env, req.payload, [otherKeyRef], "strict");
    expect(result.ok).toBe(false);
    expect(result.reasonCode).toBe("fingerprint-mismatch");
  });

  it("verify against a tampered payload returns ok=false with bad-signature (payload-sha mismatch)", async () => {
    const kp = ed25519Keypair();
    const p = LocalDiskProvider.fromInlinePem(kp.privateKeyPem);
    const req = makeRequest();
    const env = await p.sign(req);
    const tampered = new TextEncoder().encode("hello WORLD");
    const keyRef = publicKeyRefFromPem(kp.publicKeyPem);
    const result = await p.verify(env, tampered, [keyRef], "strict");
    expect(result.ok).toBe(false);
    expect(result.reasonCode).toBe("bad-signature");
  });

  it("verify with a malformed envelope (empty signatures) returns ok=false", async () => {
    const kp = ed25519Keypair();
    const keyRef = publicKeyRefFromPem(kp.publicKeyPem);
    const result = new LocalDiskProvider().verifySync(
      {
        signatures: [],
        nonce: "0".repeat(32),
        payloadSha256: crypto
          .createHash("sha256")
          .update("abc")
          .digest("hex"),
      },
      new TextEncoder().encode("abc"),
      [keyRef],
      "strict",
    );
    expect(result.ok).toBe(false);
  });
});

describe("LocalDiskProvider.signSync (sync escape hatch for legacy callers)", () => {
  it("returns the same bytes as sign()", async () => {
    const kp = ed25519Keypair();
    const p = LocalDiskProvider.fromInlinePem(kp.privateKeyPem);
    // Reuse the exact same SignRequest for both paths so Ed25519's
    // deterministic property gives us a stable equality.
    const req: SignRequest = {
      ...makeRequest(),
      // Pin the nonce + timestamp so signedAt timestamp differences
      // don't affect signature bytes (they only affect SigEntry.signedAt).
    };
    const envAsync = await p.sign(req);
    const envSync = p.signSync(req);
    expect(envSync.signatures[0]!.signatureB64).toBe(
      envAsync.signatures[0]!.signatureB64,
    );
  });
});

describe("LocalDiskProvider.fingerprint", () => {
  it("returns the same fingerprint for the same public key consistently", async () => {
    const kp = ed25519Keypair();
    const p = LocalDiskProvider.fromInlinePem(kp.privateKeyPem);
    const fp1 = await p.fingerprint("inline");
    const fp2 = await p.fingerprint("inline");
    expect(fp1).toBe(fp2);
    expect(fp1).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("LocalDiskProvider.listKeys: filesystem enumeration", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "signalman-signing-test-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("returns an empty list when keysDir doesn't exist", async () => {
    const p = new LocalDiskProvider({
      keysDir: path.join(tmp, "definitely-not-a-real-dir"),
    });
    const keys = await p.listKeys();
    expect(keys).toEqual([]);
  });

  it("returns an empty list when keysDir is empty", async () => {
    const p = new LocalDiskProvider({ keysDir: tmp });
    const keys = await p.listKeys();
    expect(keys).toEqual([]);
  });

  it("enumerates one entry per *.pub file under keysDir", async () => {
    const kp1 = ed25519Keypair();
    const kp2 = ecdsaP256Keypair();
    fs.writeFileSync(path.join(tmp, "signing.pub"), kp1.publicKeyPem);
    fs.writeFileSync(path.join(tmp, "signing.key"), kp1.privateKeyPem);
    fs.writeFileSync(path.join(tmp, "ecdsa-key.pub"), kp2.publicKeyPem);
    fs.writeFileSync(path.join(tmp, "ecdsa-key.key"), kp2.privateKeyPem);

    const p = new LocalDiskProvider({ keysDir: tmp });
    const keys = await p.listKeys();
    expect(keys.map((k) => k.keyId).sort()).toEqual(["default", "ecdsa-key"]);
    const ed25519Key = keys.find((k) => k.keyId === "default");
    expect(ed25519Key?.algorithm).toBe("ed25519");
    const ecdsaKey = keys.find((k) => k.keyId === "ecdsa-key");
    expect(ecdsaKey?.algorithm).toBe("ecdsa-p256-sha256");
  });

  it("skips files that don't parse as supported signing keys", async () => {
    const kp1 = ed25519Keypair();
    const kpRsa = rsaKeypair();
    fs.writeFileSync(path.join(tmp, "signing.pub"), kp1.publicKeyPem);
    fs.writeFileSync(path.join(tmp, "rsa-key.pub"), kpRsa.publicKeyPem);
    fs.writeFileSync(path.join(tmp, "garbage.pub"), "not a PEM file at all");

    const p = new LocalDiskProvider({ keysDir: tmp });
    const keys = await p.listKeys();
    // Ed25519 key is enumerated; RSA + garbage skipped.
    expect(keys.map((k) => k.keyId)).toEqual(["default"]);
  });
});

describe("LocalDiskProvider: sign by alias from keysDir", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "signalman-signing-test-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("the legacy 'default' alias resolves to signing.{pub,key}", async () => {
    const kp = ed25519Keypair();
    fs.writeFileSync(path.join(tmp, "signing.key"), kp.privateKeyPem);
    fs.writeFileSync(path.join(tmp, "signing.pub"), kp.publicKeyPem);

    const p = new LocalDiskProvider({ keysDir: tmp });
    const env = await p.sign(makeRequest({ keyId: "default" }));
    expect(env.signatures[0]!.algorithm).toBe("ed25519");

    const keyRef = publicKeyRefFromPem(kp.publicKeyPem);
    const verify = await p.verify(
      env,
      makeRequest().payload,
      [keyRef],
      "strict",
    );
    expect(verify.ok).toBe(true);
  });

  it("a custom alias resolves to <alias>.{pub,key}", async () => {
    const kp = ed25519Keypair();
    fs.writeFileSync(path.join(tmp, "myalias.key"), kp.privateKeyPem);
    fs.writeFileSync(path.join(tmp, "myalias.pub"), kp.publicKeyPem);

    const p = new LocalDiskProvider({ keysDir: tmp });
    const env = await p.sign(makeRequest({ keyId: "myalias" }));
    expect(env.signatures.length).toBe(1);
  });

  it("rejects an alias containing path separators", async () => {
    const p = new LocalDiskProvider({ keysDir: tmp });
    await expect(
      p.sign(makeRequest({ keyId: "../escape" })),
    ).rejects.toThrow(SigningError);
  });

  it("surfaces key-not-found for a missing alias", async () => {
    const p = new LocalDiskProvider({ keysDir: tmp });
    await expect(
      p.sign(makeRequest({ keyId: "no-such-key" })),
    ).rejects.toThrow(/key file not found|key-not-found|no key files found/);
  });
});

describe("AlgorithmNotImplementedError", () => {
  // Milestone 1b ships ml-dsa-65; positive ML-DSA-65 + hybrid tests
  // live in signing-mldsa.test.ts and signing-hybrid.test.ts. This
  // suite keeps the type-shape assertion so a future algorithm
  // addition (slh-dsa, rsa-2048) lands the error path consistently.
  it("extends SigningError with a stable code and an algorithm-named message", () => {
    const err = new AlgorithmNotImplementedError("ml-dsa-65");
    expect(err).toBeInstanceOf(SigningError);
    expect(err.code).toBe("algorithm-not-implemented");
    expect(err.message).toContain("ml-dsa-65");
  });
});
