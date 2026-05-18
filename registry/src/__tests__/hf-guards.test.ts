// WS13 M4 — guards: LFS pointer parse/compose/detect, size cap,
// Range header parsing, bearer redaction.

import { describe, expect, it } from "vitest";
import {
  HF_DEFAULT_MAX_BLOB_BYTES,
  HF_ERROR_CODES,
  HfError,
  classifyLfsByThreshold,
  composeLfsPointer,
  detectLfsPointer,
  enforceMaxBlobBytes,
  parseLfsPointer,
  parseRangeHeader,
  redactBearerToken,
  redactDetail,
} from "../hf/index.js";

function expectHfError(fn: () => unknown, code: string): void {
  let caught: unknown;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(HfError);
  expect((caught as HfError).code).toBe(code);
}

describe("LFS pointer parse / compose / detect", () => {
  const HEX = "a".repeat(64);
  const POINTER = `version https://git-lfs.github.com/spec/v1\noid sha256:${HEX}\nsize 123\n`;

  it("parses a canonical pointer", () => {
    const p = parseLfsPointer(Buffer.from(POINTER));
    expect(p.oid).toBe(`sha256:${HEX}`);
    expect(p.size).toBe(123);
    expect(p.version).toBe("https://git-lfs.github.com/spec/v1");
  });

  it("composes a canonical pointer round-tripping parseLfsPointer", () => {
    const out = composeLfsPointer(HEX, 123);
    const re = parseLfsPointer(out);
    expect(re.oid).toBe(`sha256:${HEX}`);
    expect(re.size).toBe(123);
  });

  it("rejects empty + oversize buffers", () => {
    expectHfError(
      () => parseLfsPointer(Buffer.from("")),
      HF_ERROR_CODES.OID_INVALID,
    );
    expectHfError(
      () => parseLfsPointer(Buffer.alloc(2048, 0x61)),
      HF_ERROR_CODES.OID_INVALID,
    );
  });

  it("rejects CRLF line endings", () => {
    const crlf = POINTER.replace(/\n/g, "\r\n");
    expectHfError(
      () => parseLfsPointer(Buffer.from(crlf)),
      HF_ERROR_CODES.OID_INVALID,
    );
  });

  it("rejects too few lines / missing keys / duplicates", () => {
    expectHfError(
      () => parseLfsPointer(Buffer.from("only one line\n")),
      HF_ERROR_CODES.OID_INVALID,
    );
    expectHfError(
      () => parseLfsPointer(Buffer.from(`version https://git-lfs.github.com/spec/v1\noid sha256:${HEX}\n`)),
      HF_ERROR_CODES.OID_INVALID,
    );
    expectHfError(
      () =>
        parseLfsPointer(
          Buffer.from(
            `version https://git-lfs.github.com/spec/v1\noid sha256:${HEX}\noid sha256:${HEX}\nsize 1\n`,
          ),
        ),
      HF_ERROR_CODES.OID_INVALID,
    );
  });

  it("rejects bad version / bad oid / bad size", () => {
    expectHfError(
      () =>
        parseLfsPointer(
          Buffer.from(`version http://other.example/v1\noid sha256:${HEX}\nsize 1\n`),
        ),
      HF_ERROR_CODES.OID_INVALID,
    );
    expectHfError(
      () =>
        parseLfsPointer(
          Buffer.from(
            `version https://git-lfs.github.com/spec/v1\noid sha512:${"a".repeat(128)}\nsize 1\n`,
          ),
        ),
      HF_ERROR_CODES.OID_INVALID,
    );
    expectHfError(
      () =>
        parseLfsPointer(
          Buffer.from(
            `version https://git-lfs.github.com/spec/v1\noid sha256:${HEX}\nsize -5\n`,
          ),
        ),
      HF_ERROR_CODES.OID_INVALID,
    );
  });

  it("rejects malformed line (missing ' ')", () => {
    expectHfError(
      () =>
        parseLfsPointer(
          Buffer.from(
            `versionhttps://git-lfs.github.com/spec/v1\noid sha256:${HEX}\nsize 1\n`,
          ),
        ),
      HF_ERROR_CODES.OID_INVALID,
    );
  });

  it("detectLfsPointer: positive + negative cases", () => {
    expect(detectLfsPointer(Buffer.from(POINTER))?.size).toBe(123);
    expect(detectLfsPointer(Buffer.from("random binary"))).toBeNull();
    expect(detectLfsPointer(Buffer.alloc(0))).toBeNull();
    expect(detectLfsPointer(Buffer.alloc(2048, 0x61))).toBeNull();
    // looks like it starts with 'version ' but body is garbage
    expect(detectLfsPointer(Buffer.from("version garbage"))).toBeNull();
  });

  it("composeLfsPointer rejects bad inputs", () => {
    expectHfError(
      () => composeLfsPointer("not-a-sha", 1),
      HF_ERROR_CODES.OID_INVALID,
    );
    expectHfError(
      () => composeLfsPointer(HEX, -1),
      HF_ERROR_CODES.OID_INVALID,
    );
  });
});

describe("enforceMaxBlobBytes", () => {
  it("accepts under cap", () => {
    enforceMaxBlobBytes(1024);
    enforceMaxBlobBytes(HF_DEFAULT_MAX_BLOB_BYTES);
  });
  it("rejects over cap", () => {
    expectHfError(
      () => enforceMaxBlobBytes(HF_DEFAULT_MAX_BLOB_BYTES + 1),
      HF_ERROR_CODES.TOO_LARGE,
    );
  });
  it("honours an explicit cap override", () => {
    enforceMaxBlobBytes(100, 1000);
    expectHfError(
      () => enforceMaxBlobBytes(1001, 1000),
      HF_ERROR_CODES.TOO_LARGE,
    );
  });
  it("rejects non-finite / negative", () => {
    expectHfError(() => enforceMaxBlobBytes(-1), HF_ERROR_CODES.TOO_LARGE);
    expectHfError(
      () => enforceMaxBlobBytes(Number.NaN),
      HF_ERROR_CODES.TOO_LARGE,
    );
  });
});

describe("classifyLfsByThreshold", () => {
  it("returns false for <= threshold; true for >", () => {
    expect(classifyLfsByThreshold(1024)).toBe(false);
    expect(classifyLfsByThreshold(5 * 1024 * 1024)).toBe(false);
    expect(classifyLfsByThreshold(5 * 1024 * 1024 + 1)).toBe(true);
    expect(classifyLfsByThreshold(2, 1)).toBe(true);
    expect(classifyLfsByThreshold(1, 1)).toBe(false);
  });
});

describe("parseRangeHeader", () => {
  it("returns null when absent / empty", () => {
    expect(parseRangeHeader(undefined, 100)).toBeNull();
    expect(parseRangeHeader("", 100)).toBeNull();
  });
  it("parses bytes=start-end", () => {
    expect(parseRangeHeader("bytes=0-9", 100)).toEqual({ start: 0, end: 9 });
    expect(parseRangeHeader("bytes=10-50", 100)).toEqual({ start: 10, end: 50 });
  });
  it("parses bytes=start- (open-ended)", () => {
    expect(parseRangeHeader("bytes=10-", 100)).toEqual({ start: 10, end: 99 });
  });
  it("parses bytes=-N (suffix)", () => {
    expect(parseRangeHeader("bytes=-10", 100)).toEqual({ start: 90, end: 99 });
    // suffix larger than total clamps to whole content
    expect(parseRangeHeader("bytes=-200", 100)).toEqual({ start: 0, end: 99 });
  });
  it("clamps end to total-1", () => {
    expect(parseRangeHeader("bytes=0-200", 100)).toEqual({ start: 0, end: 99 });
  });
  it("rejects non-bytes / multi-range / bad shape", () => {
    expectHfError(
      () => parseRangeHeader("items=0-1", 100),
      HF_ERROR_CODES.RANGE_INVALID,
    );
    expectHfError(
      () => parseRangeHeader("bytes=0-1,5-6", 100),
      HF_ERROR_CODES.RANGE_INVALID,
    );
    expectHfError(
      () => parseRangeHeader("bytes=0to10", 100),
      HF_ERROR_CODES.RANGE_INVALID,
    );
    expectHfError(
      () => parseRangeHeader("bytes=-", 100),
      HF_ERROR_CODES.RANGE_INVALID,
    );
    expectHfError(
      () => parseRangeHeader("bytes=10-5", 100),
      HF_ERROR_CODES.RANGE_INVALID,
    );
    expectHfError(
      () => parseRangeHeader("bytes=200-300", 100),
      HF_ERROR_CODES.RANGE_INVALID,
    );
    expectHfError(
      () => parseRangeHeader("bytes=abc-def", 100),
      HF_ERROR_CODES.RANGE_INVALID,
    );
    expectHfError(
      () => parseRangeHeader("bytes=0-abc", 100),
      HF_ERROR_CODES.RANGE_INVALID,
    );
    expectHfError(
      () => parseRangeHeader("bytes=-0", 100),
      HF_ERROR_CODES.RANGE_INVALID,
    );
    expectHfError(
      () => parseRangeHeader("bytes=-abc", 100),
      HF_ERROR_CODES.RANGE_INVALID,
    );
  });
});

describe("redactBearerToken + redactDetail", () => {
  it("redacts inline Bearer tokens", () => {
    const s = "auth failed: Bearer hf_abc123XYZ_token";
    expect(redactBearerToken(s)).toContain("<redacted>");
    expect(redactBearerToken(s)).not.toContain("hf_abc123XYZ_token");
  });
  it("leaves non-bearer strings alone", () => {
    expect(redactBearerToken("hello world")).toBe("hello world");
  });
  it("redactDetail walks string fields + arrays", () => {
    const got = redactDetail({
      msg: "Bearer hf_secret_token_12345",
      items: ["Bearer hf_other_secret"],
      n: 42,
    });
    expect(JSON.stringify(got)).not.toContain("hf_secret_token_12345");
    expect(JSON.stringify(got)).not.toContain("hf_other_secret");
  });
  it("redactDetail redacts Authorization-key + auth_header_template", () => {
    const got = redactDetail({
      Authorization: "Bearer hf_secret",
      auth_header_template: "Bearer {token}",
      other: "ok",
    });
    expect((got as Record<string, unknown>).Authorization).toBe("<redacted>");
    expect((got as Record<string, unknown>).auth_header_template).toBe("<redacted>");
  });
  it("passes through primitives + null", () => {
    expect(redactDetail(null)).toBeNull();
    expect(redactDetail(42)).toBe(42);
    expect(redactDetail(true)).toBe(true);
  });
});
