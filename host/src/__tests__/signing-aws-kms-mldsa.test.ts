/**
 * AwsKmsProvider ml-dsa-65 path — WS9 v0.5.1 M8.
 *
 * Lifts the M4 algorithm gate to recognize KMS keys with KeySpec=ML_DSA_65
 * (returned as FIPS 204 SPKI from kms:GetPublicKey, signed via
 * SigningAlgorithm=ML_DSA_SHAKE_256). Verify is local through
 * @noble/post-quantum against the cached raw FIPS 204 bytes.
 *
 * The mocked KMS client below answers GetPublicKey with a real
 * FIPS 204 SPKI wrapper around a freshly generated ML-DSA-65
 * keypair, and Sign by calling @noble/post-quantum locally. End-to-end
 * sign+verify exercises the SPKI parser, the BIT STRING extractor,
 * and the per-algorithm verify dispatch.
 */

import { Buffer } from "node:buffer";

import { ml_dsa65 } from "@noble/post-quantum/ml-dsa.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AwsKmsProvider,
  freshNonce,
  type KmsClientLike,
  type PublicKeyRef,
} from "../control-plane/signing/index.js";

/** Build an SPKI wrapper around a raw FIPS 204 ML-DSA-65 public key.
 *  Matches what AWS KMS returns for KeySpec=ML_DSA_65. */
function wrapMldsa65Spki(rawPub: Uint8Array): Buffer {
  // AlgorithmIdentifier: SEQUENCE { OID id-ml-dsa-65 }
  // OID 2.16.840.1.101.3.4.3.18: 06 0B 60 86 48 01 65 03 04 03 12
  const oidBytes = Buffer.from([
    0x06, 0x0b, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x03, 0x12,
  ]);
  const algId = Buffer.concat([
    Buffer.from([0x30, 0x0b]), // SEQUENCE, length 11
    oidBytes,
  ]); // 13 bytes total
  // BIT STRING: tag 03, length (1953 = 0x07A1, long form 2 bytes), unused-bits=0, raw bytes
  const bitStringLen = rawPub.length + 1; // +1 for the unused-bits byte
  // 1953 in DER long-form: 82 07 A1
  const bitStringHeader = Buffer.from([
    0x03,
    0x82,
    (bitStringLen >> 8) & 0xff,
    bitStringLen & 0xff,
    0x00, // unused-bits = 0
  ]);
  const innerLen = algId.length + bitStringHeader.length + rawPub.length;
  // Outer SEQUENCE: tag 30, length (long-form 2 bytes for ~1969)
  const outerHeader = Buffer.from([
    0x30,
    0x82,
    (innerLen >> 8) & 0xff,
    innerLen & 0xff,
  ]);
  return Buffer.concat([outerHeader, algId, bitStringHeader, Buffer.from(rawPub)]);
}

function buildMldsaKms(): {
  client: KmsClientLike;
  rawPublicKey: Uint8Array;
  secretKey: Uint8Array;
} {
  const kp = ml_dsa65.keygen();
  const rawPublicKey = kp.publicKey;
  const secretKey = kp.secretKey;
  const spki = wrapMldsa65Spki(rawPublicKey);
  const client: KmsClientLike = {
    send: vi.fn(async (cmd: unknown) => {
      const name = (cmd as { constructor: { name: string } }).constructor.name;
      if (name === "GetPublicKeyCommand") {
        return { PublicKey: new Uint8Array(spki) };
      }
      if (name === "SignCommand") {
        const input = (cmd as { input: { Message?: Uint8Array } }).input;
        const sig = ml_dsa65.sign(input.Message!, secretKey);
        return { Signature: sig };
      }
      throw new Error(`unexpected KMS command: ${name}`);
    }) as KmsClientLike["send"],
  };
  return { client, rawPublicKey, secretKey };
}

function makeRequest(keyId: string, payload = "ml-dsa via kms") {
  return {
    keyId,
    payload: new TextEncoder().encode(payload),
    nonce: freshNonce(),
    requestedAt: new Date().toISOString(),
    purpose: "test.kms.mldsa",
    actor: { kind: "service" as const, cn: "test", orgId: "default" },
  };
}

describe("AwsKmsProvider M8: ml-dsa-65 sign + verify", () => {
  it("detects ml-dsa-65 from KMS SPKI + extracts raw 1952-byte public key", async () => {
    const { client, rawPublicKey } = buildMldsaKms();
    const p = new AwsKmsProvider({
      region: "us-east-1",
      credentials: { access_key_id: "k", secret_access_key: "s" },
      client,
    });
    const cached = await p.fetchPublicKey("arn:aws:kms:us-east-1:1234:key/pq");
    expect(cached.algorithm).toBe("ml-dsa-65");
    expect(cached.publicKeyDer.length).toBe(1952);
    expect(Buffer.from(cached.publicKeyDer).equals(Buffer.from(rawPublicKey))).toBe(true);
    expect(cached.fingerprint).toMatch(/^[0-9a-f]{16}$/);
  });

  it("sign() emits an ml-dsa-65 SigEntry; verify() roundtrips locally", async () => {
    const { client, rawPublicKey } = buildMldsaKms();
    const p = new AwsKmsProvider({
      region: "us-east-1",
      credentials: { access_key_id: "k", secret_access_key: "s" },
      client,
    });
    const req = makeRequest("arn:aws:kms:us-east-1:1234:key/pq");
    const env = await p.sign(req);
    expect(env.signatures.length).toBe(1);
    expect(env.signatures[0]!.algorithm).toBe("ml-dsa-65");
    const keyRef: PublicKeyRef = {
      keyId: req.keyId,
      provider: "aws-kms",
      algorithm: "ml-dsa-65",
      publicKeyB64: Buffer.from(rawPublicKey).toString("base64"),
      fingerprint: env.signatures[0]!.signedBy,
    };
    const verify = await p.verify(env, req.payload, [keyRef], "strict");
    expect(verify.ok).toBe(true);
  });

  it("tampered ml-dsa-65 envelope fails verify", async () => {
    const { client, rawPublicKey } = buildMldsaKms();
    const p = new AwsKmsProvider({
      region: "us-east-1",
      credentials: { access_key_id: "k", secret_access_key: "s" },
      client,
    });
    const req = makeRequest("arn");
    const env = await p.sign(req);
    const tampered = new TextEncoder().encode("DIFFERENT PAYLOAD");
    const keyRef: PublicKeyRef = {
      keyId: req.keyId,
      provider: "aws-kms",
      algorithm: "ml-dsa-65",
      publicKeyB64: Buffer.from(rawPublicKey).toString("base64"),
      fingerprint: env.signatures[0]!.signedBy,
    };
    const v = await p.verify(env, tampered, [keyRef], "strict");
    expect(v.ok).toBe(false);
    expect(v.reasonCode).toBe("bad-signature");
  });

  it("supportedAlgorithms now lists ml-dsa-65", () => {
    const { client } = buildMldsaKms();
    const p = new AwsKmsProvider({
      region: "us-east-1",
      credentials: { access_key_id: "k", secret_access_key: "s" },
      client,
    });
    expect(p.supportedAlgorithms).toContain("ml-dsa-65");
    expect(p.supportedAlgorithms).toContain("ecdsa-p256-sha256");
  });

  it("cachePublicKey accepts ml-dsa-65 (was rejected in M4)", async () => {
    const { client, rawPublicKey } = buildMldsaKms();
    const p = new AwsKmsProvider({
      region: "us-east-1",
      credentials: { access_key_id: "k", secret_access_key: "s" },
      client,
    });
    expect(() =>
      p.cachePublicKey({
        keyId: "arn:cached",
        publicKeyDer: Buffer.from(rawPublicKey),
        algorithm: "ml-dsa-65",
        fingerprint: "deadbeefcafef00d",
      }),
    ).not.toThrow();
  });

  it("rejects an SPKI with bad ML-DSA-65 BIT STRING (wrong unused-bits)", async () => {
    // Construct a malformed SPKI: correct OID + BIT STRING tag but
    // unused-bits != 0. Should surface io-error.
    const oidBytes = Buffer.from([
      0x06, 0x0b, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x03, 0x12,
    ]);
    const malformed = Buffer.concat([
      Buffer.from([0x30, 0x05]), // outer SEQUENCE len 5 (synthetic)
      oidBytes,
      Buffer.from([0x03, 0x02, 0x07, 0xff]), // BIT STRING, len 2, unused-bits=7
    ]);
    const client: KmsClientLike = {
      send: (async () =>
        ({ PublicKey: new Uint8Array(malformed) })) as KmsClientLike["send"],
    };
    const p = new AwsKmsProvider({
      region: "us-east-1",
      credentials: { access_key_id: "k", secret_access_key: "s" },
      client,
    });
    await expect(p.fetchPublicKey("arn:bad-ml")).rejects.toMatchObject({
      code: "io-error",
    });
  });
});
