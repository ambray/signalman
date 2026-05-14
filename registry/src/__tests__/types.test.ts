import { describe, expect, it } from "vitest";
import {
  formatBlobRef,
  parseBlobRef,
  RegistryError,
  REGISTRY_ERROR_CODES,
  validateManifestName,
  validateManifestVersion,
  validateSha256,
} from "../types.js";

const ZERO_SHA = "0".repeat(64);
const ALL_F = "f".repeat(64);
const MIXED_HEX = "deadbeef".repeat(8);

describe("parseBlobRef", () => {
  it("parses a minimal ref", () => {
    const ref = parseBlobRef(`application/octet-stream@sha256:${ZERO_SHA}`);
    expect(ref.mediaType).toBe("application/octet-stream");
    expect(ref.sha256).toBe(ZERO_SHA);
    expect(ref.size).toBeUndefined();
  });

  it("parses an optional size suffix", () => {
    const ref = parseBlobRef(`application/json@sha256:${ALL_F}?size=42`);
    expect(ref.size).toBe(42);
  });

  it("rejects an unknown digest", () => {
    expect(() =>
      parseBlobRef(`application/json@md5:${ZERO_SHA}`),
    ).toThrowError(RegistryError);
  });

  it("rejects whitespace in the media type", () => {
    let caught: unknown;
    try {
      parseBlobRef(`bad type@sha256:${ZERO_SHA}`);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RegistryError);
    expect((caught as RegistryError).code).toBe(REGISTRY_ERROR_CODES.BAD_BLOB_REF);
  });

  it("rejects too-short shas", () => {
    expect(() =>
      parseBlobRef(`application/octet-stream@sha256:deadbeef`),
    ).toThrowError(RegistryError);
  });

  it("rejects uppercase shas", () => {
    expect(() =>
      parseBlobRef(
        `application/octet-stream@sha256:${MIXED_HEX.toUpperCase()}`,
      ),
    ).toThrowError(RegistryError);
  });
});

describe("formatBlobRef", () => {
  it("round-trips a ref", () => {
    const original = `application/zip@sha256:${ZERO_SHA}?size=128`;
    const ref = parseBlobRef(original);
    expect(formatBlobRef(ref)).toBe(original);
  });

  it("omits ?size= when undefined", () => {
    expect(
      formatBlobRef({
        mediaType: "application/vnd.signalman.manifest+json",
        sha256: ALL_F,
      }),
    ).toBe(`application/vnd.signalman.manifest+json@sha256:${ALL_F}`);
  });

  it("rejects an invalid sha", () => {
    expect(() =>
      formatBlobRef({ mediaType: "x", sha256: "notahex" }),
    ).toThrowError(RegistryError);
  });

  it("rejects whitespace in the media type", () => {
    expect(() =>
      formatBlobRef({ mediaType: "bad type", sha256: ZERO_SHA }),
    ).toThrowError(RegistryError);
  });

  it("rejects an empty media type", () => {
    expect(() =>
      formatBlobRef({ mediaType: "", sha256: ZERO_SHA }),
    ).toThrowError(RegistryError);
  });
});

describe("validateManifestName", () => {
  it("accepts simple names", () => {
    for (const n of ["foo", "a", "my-svc", "team/svc", "org/sub/leaf"]) {
      expect(() => validateManifestName(n)).not.toThrow();
    }
  });

  it("rejects names that start with punctuation", () => {
    for (const n of ["-foo", ".foo", "/foo", "_foo"]) {
      expect(() => validateManifestName(n)).toThrowError(RegistryError);
    }
  });

  it("rejects uppercase", () => {
    expect(() => validateManifestName("Foo")).toThrowError(RegistryError);
  });

  it("rejects path traversal", () => {
    let caught: unknown;
    try {
      validateManifestName("foo/../bar");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RegistryError);
    expect((caught as RegistryError).code).toBe(REGISTRY_ERROR_CODES.BAD_NAME);
  });

  it("rejects too-long names", () => {
    expect(() => validateManifestName("a".repeat(300))).toThrowError(
      RegistryError,
    );
  });

  it("rejects empty names", () => {
    expect(() => validateManifestName("")).toThrowError(RegistryError);
  });
});

describe("validateManifestVersion", () => {
  it("accepts semver-ish versions", () => {
    for (const v of [
      "1.0.0",
      "0.1.0-rc.1",
      "2026-05-14T12:00:00Z",
      "abc123",
      "sha-0abcdef",
    ]) {
      expect(() => validateManifestVersion(v)).not.toThrow();
    }
  });

  it("rejects whitespace and slashes", () => {
    for (const v of ["1.0 0", "1/0", "1\t0", "1\n0"]) {
      expect(() => validateManifestVersion(v)).toThrowError(RegistryError);
    }
  });

  it("rejects '..' traversal", () => {
    expect(() => validateManifestVersion("..")).toThrowError(RegistryError);
    expect(() => validateManifestVersion("1.0..oops")).toThrowError(
      RegistryError,
    );
  });

  it("rejects empty + over-long versions", () => {
    expect(() => validateManifestVersion("")).toThrowError(RegistryError);
    expect(() => validateManifestVersion("x".repeat(300))).toThrowError(
      RegistryError,
    );
  });

  it("rejects DEL and control bytes", () => {
    expect(() => validateManifestVersion("1.0\x7f")).toThrowError(
      RegistryError,
    );
    expect(() => validateManifestVersion("1.0\x00")).toThrowError(
      RegistryError,
    );
  });
});

describe("validateSha256", () => {
  it("accepts a 64-hex lowercase string", () => {
    expect(() => validateSha256(ZERO_SHA)).not.toThrow();
  });

  it("rejects uppercase + short + non-hex inputs", () => {
    expect(() => validateSha256(MIXED_HEX.toUpperCase())).toThrowError(
      RegistryError,
    );
    expect(() => validateSha256("abc")).toThrowError(RegistryError);
    expect(() => validateSha256("z".repeat(64))).toThrowError(RegistryError);
  });
});

describe("RegistryError", () => {
  it("carries a stable code", () => {
    const e = new RegistryError(
      REGISTRY_ERROR_CODES.BLOB_NOT_FOUND,
      "the blob is missing",
    );
    expect(e.code).toBe("blob_not_found");
    expect(e.message).toContain("missing");
    expect(e.name).toBe("RegistryError");
    expect(e).toBeInstanceOf(Error);
  });
});
