/**
 * ML-DSA-65 single-algorithm tests — WS9 Milestone 1b.
 *
 * Covers the PQ half of the abstraction in isolation. Hybrid (paired
 * Ed25519 + ML-DSA-65) tests live in signing-hybrid.test.ts.
 *
 * ML-DSA-65 (FIPS 204):
 *   - Public key: 1952 bytes
 *   - Secret key: 4032 bytes
 *   - Signature: ~3309 bytes (varies; non-deterministic by default)
 *   - File format on disk: 4-byte 'MLDA' magic + raw bytes.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  LocalDiskProvider,
  SigningError,
  freshNonce,
  publicKeyRefFromMldsa65,
} from "../control-plane/signing/index.js";

function legacyActor() {
  return { kind: "service" as const, cn: "test", orgId: "default" };
}

function makeRequest(keyId: string, payload = "hello") {
  return {
    keyId,
    payload: new TextEncoder().encode(payload),
    nonce: freshNonce(),
    requestedAt: new Date().toISOString(),
    purpose: "test.mldsa",
    actor: legacyActor(),
  };
}

describe("ML-DSA-65: file layout + key generation", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "signalman-mldsa-test-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("generateHybridKey writes both halves with the documented sizes + MLDA magic", () => {
    const p = new LocalDiskProvider({ keysDir: tmp });
    const result = p.generateHybridKey("test-key");

    // Classical half — PEM PKCS#8 + SPKI PEM.
    expect(fs.existsSync(result.classicalKeyPath)).toBe(true);
    expect(fs.existsSync(result.classicalPubPath)).toBe(true);
    expect(fs.readFileSync(result.classicalKeyPath, "utf-8")).toContain("BEGIN PRIVATE KEY");
    expect(fs.readFileSync(result.classicalPubPath, "utf-8")).toContain("BEGIN PUBLIC KEY");

    // PQ half — MLDA magic + FIPS 204 raw bytes.
    const pqPub = fs.readFileSync(result.pqPubPath);
    const pqKey = fs.readFileSync(result.pqKeyPath);
    expect(pqPub.subarray(0, 4).toString("ascii")).toBe("MLDA");
    expect(pqKey.subarray(0, 4).toString("ascii")).toBe("MLDA");
    expect(pqPub.length).toBe(4 + 1952); // magic + FIPS 204 public-key bytes
    expect(pqKey.length).toBe(4 + 4032); // magic + FIPS 204 secret-key bytes

    // Fingerprints are 16-hex.
    expect(result.classicalFingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(result.pqFingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(result.classicalFingerprint).not.toBe(result.pqFingerprint);
  });

  it("rejects an alias with path separators", () => {
    const p = new LocalDiskProvider({ keysDir: tmp });
    expect(() => p.generateHybridKey("../escape")).toThrow(SigningError);
    expect(() => p.generateHybridKey("a/b")).toThrow(SigningError);
    expect(() => p.generateHybridKey("")).toThrow(SigningError);
  });
});

describe("ML-DSA-65: sign + verify roundtrip", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "signalman-mldsa-test-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("signs and verifies a PQ-only key (no classical half)", async () => {
    // Generate the PQ half via generateHybridKey then remove the classical
    // half so resolution falls through to the PQ-only single-algorithm
    // path.
    const p = new LocalDiskProvider({ keysDir: tmp });
    const gen = p.generateHybridKey("pq-only");
    fs.unlinkSync(gen.classicalKeyPath);
    fs.unlinkSync(gen.classicalPubPath);
    // Rename `<alias>-mldsa65.{pub,key}` → `<alias>.{pub,key}` so it
    // resolves via the flat single-algorithm path. This is the layout
    // the M2 CLI will write when operator opts `--algorithm ml-dsa-65`.
    fs.renameSync(gen.pqKeyPath, path.join(tmp, "pq-only.key"));
    fs.renameSync(gen.pqPubPath, path.join(tmp, "pq-only.pub"));

    const env = await p.sign(makeRequest("pq-only"));
    expect(env.signatures.length).toBe(1);
    expect(env.signatures[0]!.algorithm).toBe("ml-dsa-65");
    expect(env.signatures[0]!.signatureB64.length).toBeGreaterThan(0);

    // Recover the PQ public key from disk to construct a PublicKeyRef.
    const pqPubBytes = fs.readFileSync(path.join(tmp, "pq-only.pub")).subarray(4);
    const keyRef = publicKeyRefFromMldsa65(new Uint8Array(pqPubBytes));
    expect(keyRef.algorithm).toBe("ml-dsa-65");
    expect(keyRef.fingerprint).toBe(env.signatures[0]!.signedBy);

    const verify = await p.verify(env, makeRequest("pq-only").payload, [keyRef], "strict");
    expect(verify.ok).toBe(true);
  });

  it("ML-DSA-65 signing is NOT deterministic (FIPS 204 default)", async () => {
    const p = new LocalDiskProvider({ keysDir: tmp });
    const gen = p.generateHybridKey("nondet");
    fs.unlinkSync(gen.classicalKeyPath);
    fs.unlinkSync(gen.classicalPubPath);
    fs.renameSync(gen.pqKeyPath, path.join(tmp, "nondet.key"));
    fs.renameSync(gen.pqPubPath, path.join(tmp, "nondet.pub"));

    const req = makeRequest("nondet", "stable payload");
    const a = await p.sign(req);
    const b = await p.sign({ ...req, nonce: freshNonce() });
    // Signatures differ (FIPS 204 default randomizes the commitment).
    expect(a.signatures[0]!.signatureB64).not.toBe(b.signatures[0]!.signatureB64);
    // Yet both verify against the same key + same payload.
    const pqPubBytes = fs.readFileSync(path.join(tmp, "nondet.pub")).subarray(4);
    const keyRef = publicKeyRefFromMldsa65(new Uint8Array(pqPubBytes));
    expect((await p.verify(a, req.payload, [keyRef], "strict")).ok).toBe(true);
    expect((await p.verify(b, req.payload, [keyRef], "strict")).ok).toBe(true);
  });

  it("rejects an ML-DSA-65 file whose magic header is missing", () => {
    const p = new LocalDiskProvider({ keysDir: tmp });
    // Plant a file that looks like a PQ key by filename but lacks the
    // MLDA magic — resolution should error out cleanly.
    fs.writeFileSync(path.join(tmp, "bad-mldsa.pub"), Buffer.alloc(1956, 0));
    fs.writeFileSync(path.join(tmp, "bad-mldsa.key"), Buffer.alloc(4036, 0));
    // The flat alias path treats files lacking MLDA as classical PEM,
    // which will fail PEM-parse with an io-error. Either way we get a
    // SigningError, not a silent fall-through.
    return expect(p.sign(makeRequest("bad-mldsa"))).rejects.toThrow(SigningError);
  });

  it("rejects an ML-DSA-65 file whose payload size is wrong", () => {
    const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), "signalman-mldsa-bad-"));
    try {
      const p = new LocalDiskProvider({ keysDir: tmp2 });
      // MLDA magic + 100 bytes (wrong size).
      const wrong = Buffer.concat([Buffer.from("MLDA"), Buffer.alloc(100, 0)]);
      fs.writeFileSync(path.join(tmp2, "short.pub"), wrong);
      fs.writeFileSync(path.join(tmp2, "short.key"), wrong);
      return expect(p.sign(makeRequest("short"))).rejects.toThrow(/ML-DSA-65/);
    } finally {
      fs.rmSync(tmp2, { recursive: true, force: true });
    }
  });
});

describe("publicKeyRefFromMldsa65", () => {
  it("rejects wrong-length public key bytes", () => {
    expect(() => publicKeyRefFromMldsa65(new Uint8Array(100))).toThrow(SigningError);
    expect(() => publicKeyRefFromMldsa65(new Uint8Array(1951))).toThrow(SigningError);
  });

  it("accepts 1952 bytes and produces a 16-hex fingerprint", () => {
    const bytes = new Uint8Array(1952);
    bytes[0] = 0xff;
    bytes[1951] = 0x42;
    const ref = publicKeyRefFromMldsa65(bytes);
    expect(ref.algorithm).toBe("ml-dsa-65");
    expect(ref.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(ref.publicKeyB64).toBe(Buffer.from(bytes).toString("base64"));
  });
});
