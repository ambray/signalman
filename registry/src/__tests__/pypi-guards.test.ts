// WS13 M1 — parseUploadBody + error helpers.

import * as crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  parseUploadBody,
  PYPI_ERROR_CODES,
  PypiError,
  pypiErrorStatus,
  toEnvelope,
  asPypiError,
  type ParsedMultipart,
} from "../pypi/index.js";

function multipartFromFields(
  fields: Array<{ name: string; filename?: string; body: Buffer | string; contentType?: string }>,
): ParsedMultipart {
  return {
    fields: fields.map((f) => {
      const out: { name: string; body: Buffer; filename?: string; contentType?: string } = {
        name: f.name,
        body: Buffer.isBuffer(f.body) ? f.body : Buffer.from(f.body),
      };
      if (f.filename) out.filename = f.filename;
      if (f.contentType) out.contentType = f.contentType;
      return out;
    }),
  };
}

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

const WHEEL_BYTES = Buffer.from("pretend-wheel-bytes");
const WHEEL_SHA = crypto.createHash("sha256").update(WHEEL_BYTES).digest("hex");

const SDIST_BYTES = Buffer.from("pretend-sdist-bytes");
const SDIST_SHA = crypto.createHash("sha256").update(SDIST_BYTES).digest("hex");

describe("parseUploadBody — happy path", () => {
  it("parses a canonical wheel upload", () => {
    const parsed = parseUploadBody(
      multipartFromFields([
        { name: ":action", body: "file_upload" },
        { name: "name", body: "Requests" },
        { name: "version", body: "2.28.1" },
        { name: "filetype", body: "bdist_wheel" },
        { name: "sha256_digest", body: WHEEL_SHA },
        {
          name: "content",
          filename: "requests-2.28.1-py3-none-any.whl",
          body: WHEEL_BYTES,
          contentType: "application/octet-stream",
        },
      ]),
    );
    expect(parsed.filename).toBe("requests-2.28.1-py3-none-any.whl");
    expect(parsed.filetype).toBe("bdist_wheel");
    expect(parsed.version).toBe("2.28.1");
    expect(parsed.packageName).toBe("requests");
    expect(parsed.declaredSha256).toBe(WHEEL_SHA);
    expect(parsed.content.equals(WHEEL_BYTES)).toBe(true);
  });

  it("parses a canonical sdist upload", () => {
    const parsed = parseUploadBody(
      multipartFromFields([
        { name: ":action", body: "file_upload" },
        { name: "name", body: "pkg" },
        { name: "version", body: "1.0" },
        { name: "filetype", body: "sdist" },
        { name: "sha256_digest", body: SDIST_SHA },
        {
          name: "content",
          filename: "pkg-1.0.tar.gz",
          body: SDIST_BYTES,
        },
      ]),
    );
    expect(parsed.filetype).toBe("sdist");
    expect(parsed.version).toBe("1.0");
    expect(parsed.declaredSha256).toBe(SDIST_SHA);
  });

  it("normalises the name field (PEP 503)", () => {
    const parsed = parseUploadBody(
      multipartFromFields([
        { name: ":action", body: "file_upload" },
        { name: "name", body: "Foo_Bar.Baz" },
        { name: "version", body: "1.0" },
        { name: "filetype", body: "sdist" },
        { name: "sha256_digest", body: SDIST_SHA },
        { name: "content", filename: "Foo_Bar.Baz-1.0.tar.gz", body: SDIST_BYTES },
      ]),
    );
    expect(parsed.packageName).toBe("foo-bar-baz");
  });

  it("captures non-required PEP 345 fields verbatim", () => {
    const parsed = parseUploadBody(
      multipartFromFields([
        { name: ":action", body: "file_upload" },
        { name: "name", body: "pkg" },
        { name: "version", body: "1.0" },
        { name: "filetype", body: "sdist" },
        { name: "sha256_digest", body: SDIST_SHA },
        { name: "content", filename: "pkg-1.0.tar.gz", body: SDIST_BYTES },
        { name: "requires_python", body: ">=3.8" },
        { name: "summary", body: "A demo package" },
        { name: "classifiers", body: "License :: OSI Approved" },
        { name: "classifiers", body: "Programming Language :: Python :: 3" },
      ]),
    );
    expect(parsed.fields.requires_python).toBe(">=3.8");
    expect(parsed.fields.summary).toBe("A demo package");
    expect(Array.isArray(parsed.fields.classifiers)).toBe(true);
    expect((parsed.fields.classifiers as string[]).length).toBe(2);
  });
});

describe("parseUploadBody — reject paths", () => {
  it("rejects when :action is not file_upload", () => {
    expectPypiError(
      () =>
        parseUploadBody(
          multipartFromFields([
            { name: ":action", body: "something_else" },
            { name: "name", body: "pkg" },
            { name: "version", body: "1.0" },
            { name: "filetype", body: "sdist" },
            { name: "sha256_digest", body: SDIST_SHA },
            { name: "content", filename: "pkg-1.0.tar.gz", body: SDIST_BYTES },
          ]),
        ),
      PYPI_ERROR_CODES.UPLOAD_INVALID,
    );
  });

  it("rejects missing required fields", () => {
    expectPypiError(
      () => parseUploadBody(multipartFromFields([{ name: ":action", body: "file_upload" }])),
      PYPI_ERROR_CODES.NAME_INVALID,
    );
  });

  it("rejects missing version", () => {
    expectPypiError(
      () =>
        parseUploadBody(
          multipartFromFields([
            { name: ":action", body: "file_upload" },
            { name: "name", body: "pkg" },
          ]),
        ),
      PYPI_ERROR_CODES.VERSION_INVALID,
    );
  });

  it("rejects unsupported filetype", () => {
    expectPypiError(
      () =>
        parseUploadBody(
          multipartFromFields([
            { name: ":action", body: "file_upload" },
            { name: "name", body: "pkg" },
            { name: "version", body: "1.0" },
            { name: "filetype", body: "bdist_egg" },
            { name: "sha256_digest", body: SDIST_SHA },
            { name: "content", filename: "pkg-1.0.egg", body: SDIST_BYTES },
          ]),
        ),
      PYPI_ERROR_CODES.UNSUPPORTED_FILETYPE,
    );
  });

  it("rejects missing content field", () => {
    expectPypiError(
      () =>
        parseUploadBody(
          multipartFromFields([
            { name: ":action", body: "file_upload" },
            { name: "name", body: "pkg" },
            { name: "version", body: "1.0" },
            { name: "filetype", body: "sdist" },
            { name: "sha256_digest", body: SDIST_SHA },
          ]),
        ),
      PYPI_ERROR_CODES.UPLOAD_INVALID,
    );
  });

  it("rejects content field without filename=", () => {
    expectPypiError(
      () =>
        parseUploadBody(
          multipartFromFields([
            { name: ":action", body: "file_upload" },
            { name: "name", body: "pkg" },
            { name: "version", body: "1.0" },
            { name: "filetype", body: "sdist" },
            { name: "sha256_digest", body: SDIST_SHA },
            { name: "content", body: SDIST_BYTES },
          ]),
        ),
      PYPI_ERROR_CODES.UPLOAD_INVALID,
    );
  });

  it("rejects filename / filetype mismatch", () => {
    expectPypiError(
      () =>
        parseUploadBody(
          multipartFromFields([
            { name: ":action", body: "file_upload" },
            { name: "name", body: "pkg" },
            { name: "version", body: "1.0" },
            { name: "filetype", body: "bdist_wheel" },
            { name: "sha256_digest", body: SDIST_SHA },
            { name: "content", filename: "pkg-1.0.tar.gz", body: SDIST_BYTES },
          ]),
        ),
      PYPI_ERROR_CODES.UNSUPPORTED_FILETYPE,
    );
  });

  it("rejects wheel filename whose distribution doesn't match form name", () => {
    expectPypiError(
      () =>
        parseUploadBody(
          multipartFromFields([
            { name: ":action", body: "file_upload" },
            { name: "name", body: "pkg" },
            { name: "version", body: "1.0" },
            { name: "filetype", body: "bdist_wheel" },
            { name: "sha256_digest", body: WHEEL_SHA },
            {
              name: "content",
              filename: "other-1.0-py3-none-any.whl",
              body: WHEEL_BYTES,
            },
          ]),
        ),
      PYPI_ERROR_CODES.FILENAME_INVALID,
    );
  });

  it("rejects wheel filename whose version doesn't match form version", () => {
    expectPypiError(
      () =>
        parseUploadBody(
          multipartFromFields([
            { name: ":action", body: "file_upload" },
            { name: "name", body: "pkg" },
            { name: "version", body: "1.0" },
            { name: "filetype", body: "bdist_wheel" },
            { name: "sha256_digest", body: WHEEL_SHA },
            {
              name: "content",
              filename: "pkg-2.0-py3-none-any.whl",
              body: WHEEL_BYTES,
            },
          ]),
        ),
      PYPI_ERROR_CODES.FILENAME_INVALID,
    );
  });

  it("rejects sdist filename / form mismatch", () => {
    expectPypiError(
      () =>
        parseUploadBody(
          multipartFromFields([
            { name: ":action", body: "file_upload" },
            { name: "name", body: "pkg" },
            { name: "version", body: "1.0" },
            { name: "filetype", body: "sdist" },
            { name: "sha256_digest", body: SDIST_SHA },
            { name: "content", filename: "other-1.0.tar.gz", body: SDIST_BYTES },
          ]),
        ),
      PYPI_ERROR_CODES.FILENAME_INVALID,
    );
  });

  it("rejects malformed sha256_digest", () => {
    expectPypiError(
      () =>
        parseUploadBody(
          multipartFromFields([
            { name: ":action", body: "file_upload" },
            { name: "name", body: "pkg" },
            { name: "version", body: "1.0" },
            { name: "filetype", body: "sdist" },
            { name: "sha256_digest", body: "not-hex" },
            { name: "content", filename: "pkg-1.0.tar.gz", body: SDIST_BYTES },
          ]),
        ),
      PYPI_ERROR_CODES.DIGEST_INVALID,
    );
  });

  it("rejects when computed sha256 disagrees with declared sha256_digest", () => {
    expectPypiError(
      () =>
        parseUploadBody(
          multipartFromFields([
            { name: ":action", body: "file_upload" },
            { name: "name", body: "pkg" },
            { name: "version", body: "1.0" },
            { name: "filetype", body: "sdist" },
            { name: "sha256_digest", body: "0".repeat(64) },
            { name: "content", filename: "pkg-1.0.tar.gz", body: SDIST_BYTES },
          ]),
        ),
      PYPI_ERROR_CODES.DIGEST_MISMATCH,
    );
  });
});

describe("pypiErrorStatus", () => {
  it("maps every code to the canonical HTTP status", () => {
    expect(pypiErrorStatus(PYPI_ERROR_CODES.UNAUTHORIZED)).toBe(401);
    expect(pypiErrorStatus(PYPI_ERROR_CODES.PACKAGE_NOT_FOUND)).toBe(404);
    expect(pypiErrorStatus(PYPI_ERROR_CODES.FILE_NOT_FOUND)).toBe(404);
    expect(pypiErrorStatus(PYPI_ERROR_CODES.CONFLICT)).toBe(409);
    expect(pypiErrorStatus(PYPI_ERROR_CODES.UNSUPPORTED_FILETYPE)).toBe(415);
    expect(pypiErrorStatus(PYPI_ERROR_CODES.NAME_INVALID)).toBe(400);
    expect(pypiErrorStatus(PYPI_ERROR_CODES.VERSION_INVALID)).toBe(400);
    expect(pypiErrorStatus(PYPI_ERROR_CODES.FILENAME_INVALID)).toBe(400);
    expect(pypiErrorStatus(PYPI_ERROR_CODES.DIGEST_INVALID)).toBe(400);
    expect(pypiErrorStatus(PYPI_ERROR_CODES.DIGEST_MISMATCH)).toBe(400);
    expect(pypiErrorStatus(PYPI_ERROR_CODES.UPLOAD_INVALID)).toBe(400);
  });
});

describe("toEnvelope + asPypiError", () => {
  it("toEnvelope emits the expected shape", () => {
    const env = toEnvelope(new PypiError(PYPI_ERROR_CODES.DIGEST_INVALID, "bad"));
    expect(env).toEqual({
      errors: [{ code: "DIGEST_INVALID", message: "bad" }],
    });
  });

  it("toEnvelope passes through detail when present", () => {
    const env = toEnvelope(
      new PypiError(PYPI_ERROR_CODES.UPLOAD_INVALID, "x", { hint: "y" }),
    );
    expect(env.errors[0].detail).toEqual({ hint: "y" });
  });

  it("asPypiError wraps unknown thrown values", () => {
    const wrapped = asPypiError(new Error("boom"));
    expect(wrapped).toBeInstanceOf(PypiError);
    expect(wrapped.code).toBe(PYPI_ERROR_CODES.UPLOAD_INVALID);
  });

  it("asPypiError returns existing PypiError unchanged", () => {
    const orig = new PypiError(PYPI_ERROR_CODES.NAME_INVALID, "bad name");
    expect(asPypiError(orig)).toBe(orig);
  });
});
