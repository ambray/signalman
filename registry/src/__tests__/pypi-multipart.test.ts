// WS13 M1 — RFC 7578 multipart parser tests.

import { describe, expect, it } from "vitest";
import {
  extractBoundary,
  parseMultipart,
  PYPI_ERROR_CODES,
  PypiError,
} from "../pypi/index.js";

function expectPypiError(fn: () => unknown, code: string): void {
  let caught: unknown;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(PypiError);
  expect((caught as PypiError).code).toBe(code);
}

const CRLF = "\r\n";

function buildMultipart(boundary: string, parts: Array<{
  name: string;
  filename?: string;
  contentType?: string;
  body: Buffer | string;
}>): Buffer {
  const chunks: Buffer[] = [];
  for (const p of parts) {
    chunks.push(Buffer.from(`--${boundary}${CRLF}`));
    const dispBits = [`form-data; name="${p.name}"`];
    if (p.filename) dispBits.push(`filename="${p.filename}"`);
    chunks.push(Buffer.from(`Content-Disposition: ${dispBits.join("; ")}${CRLF}`));
    if (p.contentType) {
      chunks.push(Buffer.from(`Content-Type: ${p.contentType}${CRLF}`));
    }
    chunks.push(Buffer.from(CRLF));
    chunks.push(Buffer.isBuffer(p.body) ? p.body : Buffer.from(p.body));
    chunks.push(Buffer.from(CRLF));
  }
  chunks.push(Buffer.from(`--${boundary}--${CRLF}`));
  return Buffer.concat(chunks);
}

describe("extractBoundary", () => {
  it("returns null when Content-Type is not multipart", () => {
    expect(extractBoundary("application/json")).toBeNull();
    expect(extractBoundary(undefined)).toBeNull();
    expect(extractBoundary("")).toBeNull();
  });

  it("parses unquoted boundary", () => {
    expect(
      extractBoundary("multipart/form-data; boundary=abc123"),
    ).toBe("abc123");
  });

  it("parses quoted boundary + strips quotes", () => {
    expect(
      extractBoundary(`multipart/form-data; boundary="abc-123"`),
    ).toBe("abc-123");
  });

  it("is case-insensitive", () => {
    expect(
      extractBoundary("Multipart/Form-Data; BOUNDARY=X"),
    ).toBe("X");
  });

  it("throws when boundary param is missing", () => {
    expectPypiError(
      () => extractBoundary("multipart/form-data"),
      PYPI_ERROR_CODES.UPLOAD_INVALID,
    );
  });

  it("throws when boundary (quoted) contains invalid chars", () => {
    expectPypiError(
      () => extractBoundary(`multipart/form-data; boundary="has space"`),
      PYPI_ERROR_CODES.UPLOAD_INVALID,
    );
  });
});

describe("parseMultipart", () => {
  const b = "BOUNDARYZ";

  it("parses a simple text-only body", () => {
    const body = buildMultipart(b, [
      { name: "field1", body: "value1" },
      { name: "field2", body: "value2" },
    ]);
    const parsed = parseMultipart(body, b);
    expect(parsed.fields).toHaveLength(2);
    expect(parsed.fields[0]).toMatchObject({ name: "field1" });
    expect(parsed.fields[0].body.toString("utf-8")).toBe("value1");
    expect(parsed.fields[1].body.toString("utf-8")).toBe("value2");
  });

  it("preserves binary content with embedded null bytes", () => {
    const binary = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xde, 0xad, 0xbe, 0xef]);
    const body = buildMultipart(b, [
      { name: "content", filename: "blob.bin", body: binary, contentType: "application/octet-stream" },
    ]);
    const parsed = parseMultipart(body, b);
    expect(parsed.fields[0].body.equals(binary)).toBe(true);
    expect(parsed.fields[0].filename).toBe("blob.bin");
    expect(parsed.fields[0].contentType).toBe("application/octet-stream");
  });

  it("rejects bodies that don't start with the boundary", () => {
    expectPypiError(
      () => parseMultipart(Buffer.from("not a multipart body"), b),
      PYPI_ERROR_CODES.UPLOAD_INVALID,
    );
  });

  it("rejects parts missing Content-Disposition", () => {
    const body = Buffer.from(
      `--${b}${CRLF}Content-Type: text/plain${CRLF}${CRLF}value${CRLF}--${b}--${CRLF}`,
    );
    expectPypiError(
      () => parseMultipart(body, b),
      PYPI_ERROR_CODES.UPLOAD_INVALID,
    );
  });

  it("rejects parts where Content-Disposition lacks name=", () => {
    const body = Buffer.from(
      `--${b}${CRLF}Content-Disposition: form-data${CRLF}${CRLF}value${CRLF}--${b}--${CRLF}`,
    );
    expectPypiError(
      () => parseMultipart(body, b),
      PYPI_ERROR_CODES.UPLOAD_INVALID,
    );
  });

  it("rejects non-form-data dispositions", () => {
    const body = Buffer.from(
      `--${b}${CRLF}Content-Disposition: attachment; name="x"${CRLF}${CRLF}v${CRLF}--${b}--${CRLF}`,
    );
    expectPypiError(
      () => parseMultipart(body, b),
      PYPI_ERROR_CODES.UPLOAD_INVALID,
    );
  });

  it("rejects bodies that end without the closing boundary", () => {
    const body = Buffer.from(
      `--${b}${CRLF}Content-Disposition: form-data; name="x"${CRLF}${CRLF}value${CRLF}`,
    );
    expectPypiError(
      () => parseMultipart(body, b),
      PYPI_ERROR_CODES.UPLOAD_INVALID,
    );
  });

  it("rejects malformed header lines (missing ':')", () => {
    const body = Buffer.from(
      `--${b}${CRLF}NoColon${CRLF}${CRLF}v${CRLF}--${b}--${CRLF}`,
    );
    expectPypiError(
      () => parseMultipart(body, b),
      PYPI_ERROR_CODES.UPLOAD_INVALID,
    );
  });

  it("rejects part headers without the blank-line terminator", () => {
    const body = Buffer.from(
      `--${b}${CRLF}Content-Disposition: form-data; name="x"${CRLF}v${CRLF}--${b}--${CRLF}`,
    );
    expectPypiError(
      () => parseMultipart(body, b),
      PYPI_ERROR_CODES.UPLOAD_INVALID,
    );
  });

  it("rejects bodies where a part has no terminating boundary", () => {
    // Construct one part header followed by content that never reaches a delimiter.
    const body = Buffer.from(
      `--${b}${CRLF}Content-Disposition: form-data; name="x"${CRLF}${CRLF}value-but-no-end`,
    );
    expectPypiError(
      () => parseMultipart(body, b),
      PYPI_ERROR_CODES.UPLOAD_INVALID,
    );
  });

  it("handles a body with one text field + one file field", () => {
    const body = buildMultipart(b, [
      { name: ":action", body: "file_upload" },
      {
        name: "content",
        filename: "pkg-1.0.tar.gz",
        body: Buffer.from("sdist-bytes"),
        contentType: "application/octet-stream",
      },
    ]);
    const parsed = parseMultipart(body, b);
    expect(parsed.fields).toHaveLength(2);
    expect(parsed.fields[0].body.toString("utf-8")).toBe("file_upload");
    expect(parsed.fields[1].filename).toBe("pkg-1.0.tar.gz");
    expect(parsed.fields[1].body.toString("utf-8")).toBe("sdist-bytes");
  });

  it("supports repeated field names (e.g. classifiers)", () => {
    const body = buildMultipart(b, [
      { name: "classifiers", body: "License :: OSI Approved" },
      { name: "classifiers", body: "Programming Language :: Python :: 3" },
    ]);
    const parsed = parseMultipart(body, b);
    expect(parsed.fields).toHaveLength(2);
    expect(parsed.fields.every((f) => f.name === "classifiers")).toBe(true);
  });
});
