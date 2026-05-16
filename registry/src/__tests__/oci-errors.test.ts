// WS10 (v0.5 OCI facade) — error envelope tests.
//
// The OCI spec mandates an exact JSON shape on 4XX responses
// (`{errors: [{code, message, detail?}]}`) and the status code per
// error code is the registry's contract with clients (Docker CLI
// + crane treat 404 vs 405 vs 416 differently).

import { describe, expect, it } from "vitest";
import {
  OciError,
  OCI_ERROR_CODES,
  envelope,
  maxStatus,
  ociErrorStatus,
  toEnvelope,
} from "../oci/index.js";

describe("OciError", () => {
  it("preserves code + message + detail", () => {
    const err = new OciError(
      OCI_ERROR_CODES.NAME_INVALID,
      "bad",
      { hint: "lowercase only" },
    );
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe(OCI_ERROR_CODES.NAME_INVALID);
    expect(err.message).toBe("bad");
    expect(err.detail).toEqual({ hint: "lowercase only" });
    expect(err.name).toBe("OciError");
  });

  it("permits a missing detail", () => {
    const err = new OciError(OCI_ERROR_CODES.UNAUTHORIZED, "authn required");
    expect(err.detail).toBeUndefined();
  });
});

describe("ociErrorStatus", () => {
  it("maps UNAUTHORIZED to 401", () => {
    expect(ociErrorStatus(OCI_ERROR_CODES.UNAUTHORIZED)).toBe(401);
  });

  it("maps DENIED to 403", () => {
    expect(ociErrorStatus(OCI_ERROR_CODES.DENIED)).toBe(403);
  });

  it("maps all *_UNKNOWN codes to 404", () => {
    expect(ociErrorStatus(OCI_ERROR_CODES.NAME_UNKNOWN)).toBe(404);
    expect(ociErrorStatus(OCI_ERROR_CODES.MANIFEST_UNKNOWN)).toBe(404);
    expect(ociErrorStatus(OCI_ERROR_CODES.BLOB_UNKNOWN)).toBe(404);
    expect(ociErrorStatus(OCI_ERROR_CODES.BLOB_UPLOAD_UNKNOWN)).toBe(404);
  });

  it("maps UNSUPPORTED to 405", () => {
    expect(ociErrorStatus(OCI_ERROR_CODES.UNSUPPORTED)).toBe(405);
  });

  it("maps BLOB_UPLOAD_INVALID to 416 (out-of-order Content-Range)", () => {
    expect(ociErrorStatus(OCI_ERROR_CODES.BLOB_UPLOAD_INVALID)).toBe(416);
  });

  it("maps TOOMANYREQUESTS to 429", () => {
    expect(ociErrorStatus(OCI_ERROR_CODES.TOOMANYREQUESTS)).toBe(429);
  });

  it("maps invalid-input codes to 400", () => {
    expect(ociErrorStatus(OCI_ERROR_CODES.NAME_INVALID)).toBe(400);
    expect(ociErrorStatus(OCI_ERROR_CODES.DIGEST_INVALID)).toBe(400);
    expect(ociErrorStatus(OCI_ERROR_CODES.MANIFEST_INVALID)).toBe(400);
    expect(ociErrorStatus(OCI_ERROR_CODES.MANIFEST_BLOB_UNKNOWN)).toBe(400);
    expect(ociErrorStatus(OCI_ERROR_CODES.SIZE_INVALID)).toBe(400);
  });
});

describe("toEnvelope", () => {
  it("emits a single-entry envelope without detail when none was supplied", () => {
    const env = toEnvelope(
      new OciError(OCI_ERROR_CODES.MANIFEST_UNKNOWN, "no such manifest"),
    );
    expect(env).toEqual({
      errors: [
        {
          code: "MANIFEST_UNKNOWN",
          message: "no such manifest",
        },
      ],
    });
    // `detail` MUST be absent (not "detail": undefined) so the wire
    // payload matches the spec example exactly.
    expect("detail" in env.errors[0]).toBe(false);
  });

  it("includes detail when present", () => {
    const env = toEnvelope(
      new OciError(OCI_ERROR_CODES.BLOB_UPLOAD_INVALID, "out of order", {
        expected_offset: 1024,
        got: 512,
      }),
    );
    expect(env.errors[0].detail).toEqual({ expected_offset: 1024, got: 512 });
  });
});

describe("envelope (multi-error)", () => {
  it("composes an array of errors verbatim", () => {
    const env = envelope([
      new OciError(OCI_ERROR_CODES.MANIFEST_BLOB_UNKNOWN, "layer 0 missing"),
      new OciError(OCI_ERROR_CODES.MANIFEST_BLOB_UNKNOWN, "layer 1 missing"),
    ]);
    expect(env.errors).toHaveLength(2);
    expect(env.errors[0].code).toBe("MANIFEST_BLOB_UNKNOWN");
    expect(env.errors[1].message).toBe("layer 1 missing");
  });

  it("returns an empty errors array for an empty input", () => {
    const env = envelope([]);
    expect(env.errors).toEqual([]);
  });
});

describe("maxStatus", () => {
  it("picks the highest mapped status", () => {
    const errs = [
      new OciError(OCI_ERROR_CODES.NAME_INVALID, "1"),
      new OciError(OCI_ERROR_CODES.UNAUTHORIZED, "2"),
      new OciError(OCI_ERROR_CODES.MANIFEST_UNKNOWN, "3"),
    ];
    expect(maxStatus(errs)).toBe(404);
  });

  it("returns 400 for an empty input", () => {
    expect(maxStatus([])).toBe(400);
  });

  it("returns 429 when any TOOMANYREQUESTS is present", () => {
    const errs = [
      new OciError(OCI_ERROR_CODES.NAME_INVALID, "1"),
      new OciError(OCI_ERROR_CODES.TOOMANYREQUESTS, "2"),
    ];
    expect(maxStatus(errs)).toBe(429);
  });
});
