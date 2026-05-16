/**
 * Hybrid key tests — WS9 Milestone 1b.
 *
 * Hybrid = a single logical key composed of TWO sub-keys (one
 * classical Ed25519, one ML-DSA-65) sharing an alias on disk.
 * `provider.sign()` against a hybrid alias emits a SignEnvelope with
 * `signatures.length === 2` (classical first, PQ second by convention).
 *
 * Verifier modes (operator-configurable per call site):
 *   - "strict"          — every considered entry must verify
 *   - "transition"      — at least one considered entry must verify
 *   - "classical-only"  — PQ entries filtered out; every classical
 *                         entry must verify (so this also detects
 *                         tampered classical sigs)
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  LocalDiskProvider,
  freshNonce,
  publicKeyRefFromMldsa65,
  publicKeyRefFromPem,
  type PublicKeyRef,
  type SignEnvelope,
} from "../control-plane/signing/index.js";

function legacyActor() {
  return { kind: "service" as const, cn: "test", orgId: "default" };
}

function makeRequest(keyId: string, payload = "hello world") {
  return {
    keyId,
    payload: new TextEncoder().encode(payload),
    nonce: freshNonce(),
    requestedAt: new Date().toISOString(),
    purpose: "test.hybrid",
    actor: legacyActor(),
  };
}

/** Materialize hybrid key refs from filesystem state. */
function keyRefsFor(
  keysDir: string,
  alias: string,
): { classical: PublicKeyRef; pq: PublicKeyRef } {
  const classicalPubPem = fs.readFileSync(
    path.join(keysDir, `${alias}-ed25519.pub`),
    "utf-8",
  );
  const pqPubBytes = fs
    .readFileSync(path.join(keysDir, `${alias}-mldsa65.pub`))
    .subarray(4);
  return {
    classical: publicKeyRefFromPem(classicalPubPem),
    pq: publicKeyRefFromMldsa65(new Uint8Array(pqPubBytes)),
  };
}

/** Mutate one byte of the named entry's signature in a hybrid envelope. */
function tamperedSignature(env: SignEnvelope, algorithm: string): SignEnvelope {
  return {
    ...env,
    signatures: env.signatures.map((entry) => {
      if (entry.algorithm !== algorithm) return entry;
      const buf = Buffer.from(entry.signatureB64, "base64");
      // Flip a bit somewhere in the middle to make verification fail.
      buf[Math.floor(buf.length / 2)] ^= 0x01;
      return { ...entry, signatureB64: buf.toString("base64") };
    }),
  };
}

describe("hybrid signing: envelope shape", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "signalman-hybrid-test-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("sign(hybrid) emits exactly two SigEntry rows: classical first, PQ second", async () => {
    const p = new LocalDiskProvider({ keysDir: tmp });
    p.generateHybridKey("rel-signing");
    const env = await p.sign(makeRequest("rel-signing"));
    expect(env.signatures.length).toBe(2);
    expect(env.signatures[0]!.algorithm).toBe("ed25519");
    expect(env.signatures[1]!.algorithm).toBe("ml-dsa-65");
    // Different signedBy fingerprints (classical vs PQ public keys).
    expect(env.signatures[0]!.signedBy).not.toBe(env.signatures[1]!.signedBy);
    // Both algorithm-coded signedAt timestamps match (the provider
    // captures a single timestamp per sign() call).
    expect(env.signatures[0]!.signedAt).toBe(env.signatures[1]!.signedAt);
  });

  it("the nonce is echoed back from the request", async () => {
    const p = new LocalDiskProvider({ keysDir: tmp });
    p.generateHybridKey("h");
    const req = makeRequest("h");
    const env = await p.sign(req);
    expect(env.nonce).toBe(req.nonce);
  });

  it("the payloadSha256 is computed from the request payload", async () => {
    const p = new LocalDiskProvider({ keysDir: tmp });
    p.generateHybridKey("h");
    const req = makeRequest("h", "fixed payload");
    const env = await p.sign(req);
    // sha256("fixed payload") = stable.
    expect(env.payloadSha256).toMatch(/^[0-9a-f]{64}$/);
    // Recompute and compare.
    const crypto = await import("node:crypto");
    expect(env.payloadSha256).toBe(
      crypto.createHash("sha256").update(req.payload).digest("hex"),
    );
  });
});

describe("hybrid verifier: strict mode", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "signalman-hybrid-test-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("passes when BOTH entries verify against their matching public keys", async () => {
    const p = new LocalDiskProvider({ keysDir: tmp });
    p.generateHybridKey("h");
    const req = makeRequest("h");
    const env = await p.sign(req);
    const refs = keyRefsFor(tmp, "h");
    const result = await p.verify(env, req.payload, [refs.classical, refs.pq], "strict");
    expect(result.ok).toBe(true);
  });

  it("fails when the classical signature is tampered (the other half still verifies, but strict requires both)", async () => {
    const p = new LocalDiskProvider({ keysDir: tmp });
    p.generateHybridKey("h");
    const req = makeRequest("h");
    const env = await p.sign(req);
    const tampered = tamperedSignature(env, "ed25519");
    const refs = keyRefsFor(tmp, "h");
    const result = await p.verify(tampered, req.payload, [refs.classical, refs.pq], "strict");
    expect(result.ok).toBe(false);
    expect(result.reasonCode).toBe("bad-signature");
  });

  it("fails when the PQ signature is tampered", async () => {
    const p = new LocalDiskProvider({ keysDir: tmp });
    p.generateHybridKey("h");
    const req = makeRequest("h");
    const env = await p.sign(req);
    const tampered = tamperedSignature(env, "ml-dsa-65");
    const refs = keyRefsFor(tmp, "h");
    const result = await p.verify(tampered, req.payload, [refs.classical, refs.pq], "strict");
    expect(result.ok).toBe(false);
    expect(result.reasonCode).toBe("bad-signature");
  });

  it("fails when a needed PublicKeyRef is missing (e.g. only classical supplied)", async () => {
    const p = new LocalDiskProvider({ keysDir: tmp });
    p.generateHybridKey("h");
    const req = makeRequest("h");
    const env = await p.sign(req);
    const refs = keyRefsFor(tmp, "h");
    const result = await p.verify(env, req.payload, [refs.classical], "strict");
    expect(result.ok).toBe(false);
    expect(result.reasonCode).toBe("fingerprint-mismatch");
  });
});

describe("hybrid verifier: transition mode", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "signalman-hybrid-test-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("passes when both entries verify", async () => {
    const p = new LocalDiskProvider({ keysDir: tmp });
    p.generateHybridKey("h");
    const req = makeRequest("h");
    const env = await p.sign(req);
    const refs = keyRefsFor(tmp, "h");
    const result = await p.verify(env, req.payload, [refs.classical, refs.pq], "transition");
    expect(result.ok).toBe(true);
  });

  it("passes when only the classical signature verifies (PQ half tampered)", async () => {
    const p = new LocalDiskProvider({ keysDir: tmp });
    p.generateHybridKey("h");
    const req = makeRequest("h");
    const env = await p.sign(req);
    const tampered = tamperedSignature(env, "ml-dsa-65");
    const refs = keyRefsFor(tmp, "h");
    const result = await p.verify(tampered, req.payload, [refs.classical, refs.pq], "transition");
    expect(result.ok).toBe(true);
  });

  it("passes when only the PQ signature verifies (classical half tampered) — covers the Ed25519-break scenario", async () => {
    const p = new LocalDiskProvider({ keysDir: tmp });
    p.generateHybridKey("h");
    const req = makeRequest("h");
    const env = await p.sign(req);
    const tampered = tamperedSignature(env, "ed25519");
    const refs = keyRefsFor(tmp, "h");
    const result = await p.verify(tampered, req.payload, [refs.classical, refs.pq], "transition");
    expect(result.ok).toBe(true);
  });

  it("fails when BOTH signatures are tampered", async () => {
    const p = new LocalDiskProvider({ keysDir: tmp });
    p.generateHybridKey("h");
    const req = makeRequest("h");
    const env = await p.sign(req);
    const t1 = tamperedSignature(env, "ed25519");
    const t2 = tamperedSignature(t1, "ml-dsa-65");
    const refs = keyRefsFor(tmp, "h");
    const result = await p.verify(t2, req.payload, [refs.classical, refs.pq], "transition");
    expect(result.ok).toBe(false);
    expect(result.reasonCode).toBe("bad-signature");
  });
});

describe("hybrid verifier: classical-only mode", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "signalman-hybrid-test-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("ignores the PQ entry and verifies only the classical half (which must be untampered)", async () => {
    const p = new LocalDiskProvider({ keysDir: tmp });
    p.generateHybridKey("h");
    const req = makeRequest("h");
    const env = await p.sign(req);
    const tamperedPq = tamperedSignature(env, "ml-dsa-65");
    const refs = keyRefsFor(tmp, "h");
    // Even with the PQ sig tampered, classical-only mode passes because
    // it filtered the PQ entry out.
    const result = await p.verify(tamperedPq, req.payload, [refs.classical], "classical-only");
    expect(result.ok).toBe(true);
  });

  it("fails when the classical signature is tampered (classical-only requires the remaining classical entry to verify)", async () => {
    const p = new LocalDiskProvider({ keysDir: tmp });
    p.generateHybridKey("h");
    const req = makeRequest("h");
    const env = await p.sign(req);
    const tamperedEd = tamperedSignature(env, "ed25519");
    const refs = keyRefsFor(tmp, "h");
    const result = await p.verify(tamperedEd, req.payload, [refs.classical], "classical-only");
    expect(result.ok).toBe(false);
    expect(result.reasonCode).toBe("bad-signature");
  });

  it("fails when the envelope is PQ-only and classical-only mode filters out the only entry", async () => {
    // Construct a PQ-only envelope by signing with a PQ-only key.
    const p = new LocalDiskProvider({ keysDir: tmp });
    const gen = p.generateHybridKey("pq-solo");
    fs.unlinkSync(gen.classicalKeyPath);
    fs.unlinkSync(gen.classicalPubPath);
    fs.renameSync(gen.pqKeyPath, path.join(tmp, "pq-solo.key"));
    fs.renameSync(gen.pqPubPath, path.join(tmp, "pq-solo.pub"));

    const req = makeRequest("pq-solo");
    const env = await p.sign(req);
    expect(env.signatures.length).toBe(1);
    expect(env.signatures[0]!.algorithm).toBe("ml-dsa-65");

    const pqPubBytes = fs.readFileSync(path.join(tmp, "pq-solo.pub")).subarray(4);
    const pqRef = publicKeyRefFromMldsa65(new Uint8Array(pqPubBytes));

    const result = await p.verify(env, req.payload, [pqRef], "classical-only");
    expect(result.ok).toBe(false);
    expect(result.reasonCode).toBe("bad-signature");
    expect(result.reason).toMatch(/PQ-only|no signatures matched/);
  });
});

describe("hybrid resolution: partial-pair failures", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "signalman-hybrid-test-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("surfaces hybrid-pair-incomplete when only the classical half is present", async () => {
    const p = new LocalDiskProvider({ keysDir: tmp });
    const gen = p.generateHybridKey("h");
    fs.unlinkSync(gen.pqKeyPath);
    fs.unlinkSync(gen.pqPubPath);
    // <alias>-ed25519.* is present; <alias>-mldsa65.* is not; flat
    // <alias>.* is not. Resolution should refuse rather than silently
    // downgrade to classical-only.
    await expect(p.sign(makeRequest("h"))).rejects.toThrow(/hybrid-pair-incomplete|missing one half/);
  });

  it("surfaces hybrid-pair-incomplete when only the PQ half is present", async () => {
    const p = new LocalDiskProvider({ keysDir: tmp });
    const gen = p.generateHybridKey("h");
    fs.unlinkSync(gen.classicalKeyPath);
    fs.unlinkSync(gen.classicalPubPath);
    await expect(p.sign(makeRequest("h"))).rejects.toThrow(/hybrid-pair-incomplete|missing one half/);
  });
});
