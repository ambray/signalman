/**
 * Tests for the result-envelope error helpers added in P3.a (audit C6
 * close — structured error envelope replacing stringly-typed errors).
 *
 * Scenario-hash and event-queue tests live in `scenarios.test.ts` and the
 * verb-level lifecycle tests; this file covers only the new error-shape
 * surface introduced for v0.1.0 P3.a.
 */

import { describe, expect, it } from "vitest";

import {
  envelopeError,
  envelopeErrorFromThrown,
  envelopeErrorMessages,
  isEnvelopeError,
  type EnvelopeError,
  type EnvelopeErrorCategory,
} from "../output/envelope.js";

describe("envelopeError()", () => {
  it("builds a record with only the required fields when nothing else supplied", () => {
    const e = envelopeError({
      code: "BACKEND_UNAVAILABLE",
      message: "No hypervisor backend available",
      category: "infra",
    });
    expect(e).toEqual({
      code: "BACKEND_UNAVAILABLE",
      message: "No hypervisor backend available",
      category: "infra",
    });
    expect(e.details).toBeUndefined();
    expect(e.cause).toBeUndefined();
  });

  it("attaches optional details and cause when provided", () => {
    const cause = envelopeError({
      code: "GUEST_TIMEOUT",
      message: "agent did not register within 60s",
      category: "infra",
    });
    const e = envelopeError({
      code: "SETUP_STEP_FAILED",
      message: "could not provision endpoint-1",
      category: "setup",
      details: { vm: "endpoint-1", step: 3 },
      cause,
    });
    expect(e.details).toEqual({ vm: "endpoint-1", step: 3 });
    expect(e.cause).toBe(cause);
  });

  it("preserves opaque codes the consumer hasn't standardised", () => {
    // Forward-compat: unknown codes flow through unchanged.
    const e = envelopeError({
      code: "EXT_FUTURE_CONDITION_42" as EnvelopeError["code"],
      message: "future",
      category: "internal",
    });
    expect(e.code).toBe("EXT_FUTURE_CONDITION_42");
  });
});

describe("envelopeErrorFromThrown()", () => {
  const fallback = { code: "INTERNAL_ERROR" as const, category: "infra" as EnvelopeErrorCategory };

  it("wraps a plain Error preserving message + name + stack", () => {
    const err = new Error("boom");
    const enveloped = envelopeErrorFromThrown(err, fallback);
    expect(enveloped.code).toBe("INTERNAL_ERROR");
    expect(enveloped.message).toBe("boom");
    expect(enveloped.category).toBe("infra");
    expect(enveloped.details).toMatchObject({ name: "Error" });
    expect(typeof enveloped.details!.stack).toBe("string");
  });

  it("wraps a non-Error thrown value via String() coercion", () => {
    const enveloped = envelopeErrorFromThrown("string-thrown", fallback);
    expect(enveloped.message).toBe("string-thrown");
    expect(enveloped.code).toBe("INTERNAL_ERROR");
    // No `name`/`stack` — there was no Error to extract from.
    expect(enveloped.details).toBeUndefined();
  });

  it("wraps a thrown number/object via String()", () => {
    expect(envelopeErrorFromThrown(42, fallback).message).toBe("42");
    expect(envelopeErrorFromThrown({ kind: "weird" }, fallback).message).toBe(
      "[object Object]",
    );
  });

  it("passes through an already-shaped EnvelopeError without re-wrapping", () => {
    const original: EnvelopeError = {
      code: "BACKEND_UNAVAILABLE",
      message: "no backend",
      category: "infra",
      details: { tried: ["hyperv"] },
    };
    const enveloped = envelopeErrorFromThrown(original, fallback);
    expect(enveloped).toBe(original);
    // Specifically: fallback.code is NOT applied.
    expect(enveloped.code).toBe("BACKEND_UNAVAILABLE");
  });

  it("recognises an Error subclass", () => {
    class CustomError extends Error {
      constructor(msg: string) {
        super(msg);
        this.name = "CustomError";
      }
    }
    const enveloped = envelopeErrorFromThrown(new CustomError("nope"), fallback);
    expect(enveloped.message).toBe("nope");
    expect(enveloped.details).toMatchObject({ name: "CustomError" });
  });
});

describe("isEnvelopeError()", () => {
  it("accepts a minimal valid record", () => {
    expect(
      isEnvelopeError({ code: "X", message: "y", category: "infra" }),
    ).toBe(true);
  });

  it("accepts a record with extra fields (forward-compat)", () => {
    expect(
      isEnvelopeError({
        code: "X",
        message: "y",
        category: "infra",
        details: { extra: 1 },
        cause: { code: "Z", message: "w", category: "internal" },
        future_field: "ignored",
      }),
    ).toBe(true);
  });

  it("rejects null, primitives, and shape mismatches", () => {
    expect(isEnvelopeError(null)).toBe(false);
    expect(isEnvelopeError(undefined)).toBe(false);
    expect(isEnvelopeError("string")).toBe(false);
    expect(isEnvelopeError(42)).toBe(false);
    expect(isEnvelopeError({})).toBe(false);
    expect(isEnvelopeError({ code: "X" })).toBe(false); // missing message/category
    expect(isEnvelopeError({ code: 1, message: "m", category: "infra" })).toBe(false);
    expect(isEnvelopeError({ code: "X", message: "m", category: 0 })).toBe(false);
  });
});

describe("envelopeErrorMessages()", () => {
  it("formats structured errors as bracketed code + message strings", () => {
    const errors: EnvelopeError[] = [
      { code: "BACKEND_UNAVAILABLE", message: "no backend", category: "infra" },
      { code: "GUEST_TIMEOUT", message: "agent silent", category: "infra" },
    ];
    expect(envelopeErrorMessages(errors)).toEqual([
      "[BACKEND_UNAVAILABLE] no backend",
      "[GUEST_TIMEOUT] agent silent",
    ]);
  });

  it("returns an empty array for no errors", () => {
    expect(envelopeErrorMessages([])).toEqual([]);
  });
});

describe("EnvelopeError JSON round-trip", () => {
  it("survives JSON.stringify/parse with details and cause intact", () => {
    const e = envelopeError({
      code: "SETUP_STEP_FAILED",
      message: "couldn't provision",
      category: "setup",
      details: { vm: "endpoint-1", attempted_at: "2026-04-25T00:00:00Z" },
      cause: envelopeError({
        code: "GUEST_TIMEOUT",
        message: "no heartbeat",
        category: "infra",
      }),
    });
    const round = JSON.parse(JSON.stringify(e)) as EnvelopeError;
    expect(round).toEqual(e);
    expect(round.cause?.code).toBe("GUEST_TIMEOUT");
  });
});
