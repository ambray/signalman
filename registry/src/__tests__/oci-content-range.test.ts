// WS10 M2 — Content-Range parsing tests.
//
// The OCI Distribution Spec is unambiguous about the grammar:
//   "Content-Range <range> MUST match ^[0-9]+-[0-9]+$"
// (§Pushing a Blob in Chunks). Anything else gets 416 BLOB_UPLOAD_INVALID
// with the spec error envelope. These tests pin every reject path.

import { describe, expect, it } from "vitest";
import {
  contentRangeLength,
  OciError,
  OCI_ERROR_CODES,
  parseContentRange,
} from "../oci/index.js";

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

describe("parseContentRange", () => {
  it("parses a canonical first chunk", () => {
    expect(parseContentRange("0-499")).toEqual({ start: 0, end: 499 });
  });

  it("parses a non-zero start", () => {
    expect(parseContentRange("500-999")).toEqual({ start: 500, end: 999 });
  });

  it("parses a single-byte range", () => {
    expect(parseContentRange("0-0")).toEqual({ start: 0, end: 0 });
  });

  it("rejects missing header", () => {
    expectOciError(
      () => parseContentRange(undefined),
      OCI_ERROR_CODES.BLOB_UPLOAD_INVALID,
    );
  });

  it("rejects an empty value", () => {
    expectOciError(
      () => parseContentRange(""),
      OCI_ERROR_CODES.BLOB_UPLOAD_INVALID,
    );
  });

  it("rejects bytes= prefix (HTTP Range syntax, not OCI)", () => {
    expectOciError(
      () => parseContentRange("bytes=0-499"),
      OCI_ERROR_CODES.BLOB_UPLOAD_INVALID,
    );
  });

  it("rejects negative numbers", () => {
    expectOciError(
      () => parseContentRange("-1-100"),
      OCI_ERROR_CODES.BLOB_UPLOAD_INVALID,
    );
  });

  it("rejects non-numeric segments", () => {
    expectOciError(
      () => parseContentRange("a-b"),
      OCI_ERROR_CODES.BLOB_UPLOAD_INVALID,
    );
  });

  it("rejects end < start", () => {
    expectOciError(
      () => parseContentRange("500-100"),
      OCI_ERROR_CODES.BLOB_UPLOAD_INVALID,
    );
  });

  it("rejects unsafe integers", () => {
    const tooLarge = "9007199254740993-9007199254740994"; // > MAX_SAFE_INTEGER
    expectOciError(
      () => parseContentRange(tooLarge),
      OCI_ERROR_CODES.BLOB_UPLOAD_INVALID,
    );
  });

  it("rejects trailing junk", () => {
    expectOciError(
      () => parseContentRange("0-499 "),
      OCI_ERROR_CODES.BLOB_UPLOAD_INVALID,
    );
    expectOciError(
      () => parseContentRange("0-499/1000"),
      OCI_ERROR_CODES.BLOB_UPLOAD_INVALID,
    );
  });
});

describe("contentRangeLength", () => {
  it("returns 1 for a single-byte range", () => {
    expect(contentRangeLength({ start: 0, end: 0 })).toBe(1);
  });

  it("returns end - start + 1 (inclusive)", () => {
    expect(contentRangeLength({ start: 0, end: 499 })).toBe(500);
    expect(contentRangeLength({ start: 500, end: 999 })).toBe(500);
    expect(contentRangeLength({ start: 1024, end: 2047 })).toBe(1024);
  });
});
