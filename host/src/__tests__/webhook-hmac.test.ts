/**
 * Unit tests for HMAC-SHA256 signing/verification (Epic 2 / WS3).
 */

import { describe, expect, it } from "vitest";
import {
  SIGNALMAN_SIGNATURE_HEADER,
  signBody,
  verifySignature,
} from "../control-plane/events/index.js";

describe("signBody", () => {
  it("produces a deterministic sha256=<hex> string for the same secret + body", () => {
    const s1 = signBody("topsecret", "hello");
    const s2 = signBody("topsecret", "hello");
    expect(s1).toBe(s2);
    expect(s1).toMatch(/^sha256=[0-9a-f]{64}$/);
  });

  it("differs across secrets", () => {
    const s1 = signBody("k1", "hello");
    const s2 = signBody("k2", "hello");
    expect(s1).not.toBe(s2);
  });

  it("differs across bodies", () => {
    expect(signBody("k", "a")).not.toBe(signBody("k", "b"));
  });
});

describe("verifySignature", () => {
  it("returns true for a body signed with the matching secret", () => {
    const body = JSON.stringify({ kind: "release-built", releaseId: "r" });
    const sig = signBody("topsecret", body);
    expect(verifySignature("topsecret", body, sig)).toBe(true);
  });

  it("returns false when the secret is wrong", () => {
    const body = "hello";
    const sig = signBody("topsecret", body);
    expect(verifySignature("wrong", body, sig)).toBe(false);
  });

  it("returns false when the body is mutated", () => {
    const body = "hello";
    const sig = signBody("topsecret", body);
    expect(verifySignature("topsecret", "hello!", sig)).toBe(false);
  });

  it("tolerates a bare-hex signature (no sha256= prefix)", () => {
    const body = "hello";
    const sig = signBody("k", body);
    const bare = sig.slice("sha256=".length);
    expect(verifySignature("k", body, bare)).toBe(true);
  });

  it("returns false on a signature of mismatched length without throwing", () => {
    // 32-byte hex (half the real digest) — must fail closed.
    expect(verifySignature("k", "hello", "sha256=abc")).toBe(false);
  });
});

describe("header constant", () => {
  it("exports the canonical signature header name", () => {
    expect(SIGNALMAN_SIGNATURE_HEADER).toBe("x-signalman-signature");
  });
});
