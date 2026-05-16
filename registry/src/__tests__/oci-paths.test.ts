// WS10 (v0.5 OCI facade) — repository-name / reference / digest /
// tag parser tests. Hostile inputs include traversal attempts, mixed
// case (OCI spec is strict lowercase), separator-grammar abuse
// (`..`, `___`, `-_`), and the per-component vs whole-name length
// boundary.

import { describe, expect, it } from "vitest";
import {
  OciError,
  OCI_ERROR_CODES,
  ociManifestName,
  parseOciManifestName,
  parseOciReference,
  validateOciDigest,
  validateOciRepositoryName,
  validateOciTag,
} from "../oci/index.js";

const VALID_HEX = "a".repeat(64);

describe("validateOciRepositoryName", () => {
  it("accepts simple single-segment names", () => {
    expect(() => validateOciRepositoryName("alpine")).not.toThrow();
    expect(() => validateOciRepositoryName("nginx123")).not.toThrow();
  });

  it("accepts multi-segment names", () => {
    expect(() => validateOciRepositoryName("team/svc")).not.toThrow();
    expect(() => validateOciRepositoryName("acme/sdk/runtime")).not.toThrow();
    expect(() => validateOciRepositoryName("library/alpine")).not.toThrow();
  });

  it("accepts the spec's separator variants between alphanumeric runs", () => {
    expect(() => validateOciRepositoryName("foo.bar")).not.toThrow();
    expect(() => validateOciRepositoryName("foo_bar")).not.toThrow();
    expect(() => validateOciRepositoryName("foo__bar")).not.toThrow();
    expect(() => validateOciRepositoryName("foo-bar")).not.toThrow();
    expect(() => validateOciRepositoryName("foo--bar")).not.toThrow();
  });

  it("rejects uppercase characters per spec", () => {
    expectOciError(
      () => validateOciRepositoryName("Alpine"),
      OCI_ERROR_CODES.NAME_INVALID,
    );
    expectOciError(
      () => validateOciRepositoryName("team/SVC"),
      OCI_ERROR_CODES.NAME_INVALID,
    );
  });

  it("rejects empty name + segments", () => {
    expectOciError(() => validateOciRepositoryName(""), OCI_ERROR_CODES.NAME_INVALID);
    expectOciError(
      () => validateOciRepositoryName("foo//bar"),
      OCI_ERROR_CODES.NAME_INVALID,
    );
    expectOciError(
      () => validateOciRepositoryName("/leading"),
      OCI_ERROR_CODES.NAME_INVALID,
    );
    expectOciError(
      () => validateOciRepositoryName("trailing/"),
      OCI_ERROR_CODES.NAME_INVALID,
    );
  });

  it("rejects forbidden separator runs like ___ and -_", () => {
    expectOciError(
      () => validateOciRepositoryName("foo___bar"),
      OCI_ERROR_CODES.NAME_INVALID,
    );
    expectOciError(
      () => validateOciRepositoryName("foo-_bar"),
      OCI_ERROR_CODES.NAME_INVALID,
    );
    expectOciError(
      () => validateOciRepositoryName("foo._bar"),
      OCI_ERROR_CODES.NAME_INVALID,
    );
  });

  it("rejects a leading separator", () => {
    expectOciError(
      () => validateOciRepositoryName(".foo"),
      OCI_ERROR_CODES.NAME_INVALID,
    );
    expectOciError(
      () => validateOciRepositoryName("_bar"),
      OCI_ERROR_CODES.NAME_INVALID,
    );
    expectOciError(
      () => validateOciRepositoryName("-baz"),
      OCI_ERROR_CODES.NAME_INVALID,
    );
  });

  it("rejects names that exceed the 255-char cap", () => {
    const long = "a".repeat(256);
    expectOciError(() => validateOciRepositoryName(long), OCI_ERROR_CODES.NAME_INVALID);
  });

  it("rejects non-string input", () => {
    expectOciError(
      () => validateOciRepositoryName(undefined as unknown as string),
      OCI_ERROR_CODES.NAME_INVALID,
    );
    expectOciError(
      () => validateOciRepositoryName(42 as unknown as string),
      OCI_ERROR_CODES.NAME_INVALID,
    );
  });
});

describe("validateOciTag", () => {
  it("accepts canonical tags", () => {
    expect(() => validateOciTag("v1.0.0")).not.toThrow();
    expect(() => validateOciTag("latest")).not.toThrow();
    expect(() => validateOciTag("3.20")).not.toThrow();
    expect(() => validateOciTag("staging-2026.05")).not.toThrow();
  });

  it("rejects tags starting with - or .", () => {
    expectOciError(() => validateOciTag("-v1"), OCI_ERROR_CODES.MANIFEST_INVALID);
    expectOciError(() => validateOciTag(".latest"), OCI_ERROR_CODES.MANIFEST_INVALID);
  });

  it("rejects 129-char tags (spec max 128)", () => {
    expectOciError(
      () => validateOciTag("v" + "1".repeat(129)),
      OCI_ERROR_CODES.MANIFEST_INVALID,
    );
  });

  it("rejects empty + non-string inputs", () => {
    expectOciError(() => validateOciTag(""), OCI_ERROR_CODES.MANIFEST_INVALID);
    expectOciError(
      () => validateOciTag(null as unknown as string),
      OCI_ERROR_CODES.MANIFEST_INVALID,
    );
  });

  it("rejects whitespace + slashes", () => {
    expectOciError(() => validateOciTag("v 1"), OCI_ERROR_CODES.MANIFEST_INVALID);
    expectOciError(() => validateOciTag("v/1"), OCI_ERROR_CODES.MANIFEST_INVALID);
  });
});

describe("validateOciDigest", () => {
  it("accepts valid lowercase sha256 digests", () => {
    expect(validateOciDigest(`sha256:${VALID_HEX}`)).toBe(VALID_HEX);
  });

  it("rejects mixed-case digests", () => {
    expectOciError(
      () => validateOciDigest(`sha256:${VALID_HEX.toUpperCase()}`),
      OCI_ERROR_CODES.DIGEST_INVALID,
    );
  });

  it("rejects other algorithms at v0.5", () => {
    expectOciError(
      () => validateOciDigest(`sha512:${VALID_HEX}`),
      OCI_ERROR_CODES.DIGEST_INVALID,
    );
  });

  it("rejects malformed lengths + types", () => {
    expectOciError(
      () => validateOciDigest("sha256:deadbeef"),
      OCI_ERROR_CODES.DIGEST_INVALID,
    );
    expectOciError(
      () => validateOciDigest(VALID_HEX),
      OCI_ERROR_CODES.DIGEST_INVALID,
    );
    expectOciError(
      () => validateOciDigest(123 as unknown as string),
      OCI_ERROR_CODES.DIGEST_INVALID,
    );
  });
});

describe("parseOciReference", () => {
  it("recognises a digest reference", () => {
    const ref = parseOciReference(`sha256:${VALID_HEX}`);
    expect(ref.kind).toBe("digest");
    if (ref.kind === "digest") {
      expect(ref.value).toBe(`sha256:${VALID_HEX}`);
      expect(ref.hex).toBe(VALID_HEX);
    }
  });

  it("recognises a tag reference", () => {
    const ref = parseOciReference("v1.0.0");
    expect(ref.kind).toBe("tag");
    if (ref.kind === "tag") expect(ref.value).toBe("v1.0.0");
  });

  it("rejects empty + non-string input", () => {
    expectOciError(
      () => parseOciReference(""),
      OCI_ERROR_CODES.MANIFEST_INVALID,
    );
    expectOciError(
      () => parseOciReference(undefined as unknown as string),
      OCI_ERROR_CODES.MANIFEST_INVALID,
    );
  });

  it("rejects malformed digest-shaped refs with DIGEST_INVALID", () => {
    expectOciError(
      () => parseOciReference("sha256:notenoughhex"),
      OCI_ERROR_CODES.DIGEST_INVALID,
    );
  });

  it("rejects malformed tag refs with MANIFEST_INVALID", () => {
    expectOciError(
      () => parseOciReference("-bad-leading-tag"),
      OCI_ERROR_CODES.MANIFEST_INVALID,
    );
  });
});

describe("ociManifestName", () => {
  it("composes storage names with the oci/ prefix", () => {
    expect(ociManifestName("acme", "team/svc")).toBe("oci/acme/team/svc");
    expect(ociManifestName("acme", "alpine")).toBe("oci/acme/alpine");
  });

  it("rejects bad org names via the cargo org validator", () => {
    expect(() => ociManifestName("BadOrg", "alpine")).toThrow();
  });

  it("rejects repository names that fail the OCI grammar", () => {
    expectOciError(
      () => ociManifestName("acme", "Bad/Name"),
      OCI_ERROR_CODES.NAME_INVALID,
    );
  });
});

describe("parseOciManifestName", () => {
  it("round-trips composed names", () => {
    const composed = ociManifestName("acme", "team/svc");
    expect(parseOciManifestName(composed)).toEqual({
      org: "acme",
      repo: "team/svc",
    });
  });

  it("returns null when the prefix is absent", () => {
    expect(parseOciManifestName("cargo/acme/foo")).toBeNull();
    expect(parseOciManifestName("npm/acme/foo")).toBeNull();
    expect(parseOciManifestName("foo")).toBeNull();
  });

  it("returns null when the org or repo is empty", () => {
    expect(parseOciManifestName("oci//foo")).toBeNull();
    expect(parseOciManifestName("oci/acme")).toBeNull();
    expect(parseOciManifestName("oci/acme/")).toBeNull();
  });

  it("preserves multi-segment repos verbatim", () => {
    expect(parseOciManifestName("oci/acme/team/sub/svc")).toEqual({
      org: "acme",
      repo: "team/sub/svc",
    });
  });
});

// ── Helper ─────────────────────────────────────────────────────────

function expectOciError(fn: () => unknown, code: string): void {
  let caught: unknown;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(OciError);
  expect((caught as OciError).code).toBe(code);
}
