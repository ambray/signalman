// WS13 M4 — HfError envelope + redaction + canonical 404 body.

import { ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import {
  HF_ERROR_CODES,
  HfError,
  asHfError,
  hfErrorStatus,
  toEnvelope,
  writeHfError,
} from "../hf/index.js";

interface FakeRes {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  headersSent: boolean;
  setHeader(k: string, v: string | number): void;
  end(b: string): void;
}

function makeFakeRes(): FakeRes {
  return {
    statusCode: 0,
    headers: {},
    body: "",
    headersSent: false,
    setHeader(k, v) {
      this.headers[k.toLowerCase()] = String(v);
    },
    end(b) {
      this.body = b;
      this.headersSent = true;
    },
  };
}

describe("hfErrorStatus", () => {
  it("maps codes to canonical statuses", () => {
    expect(hfErrorStatus(HF_ERROR_CODES.UNAUTHORIZED)).toBe(401);
    expect(hfErrorStatus(HF_ERROR_CODES.REPO_NOT_FOUND)).toBe(404);
    expect(hfErrorStatus(HF_ERROR_CODES.REVISION_NOT_FOUND)).toBe(404);
    expect(hfErrorStatus(HF_ERROR_CODES.FILE_NOT_FOUND)).toBe(404);
    expect(hfErrorStatus(HF_ERROR_CODES.BLOB_NOT_FOUND)).toBe(404);
    expect(hfErrorStatus(HF_ERROR_CODES.CONFLICT)).toBe(409);
    expect(hfErrorStatus(HF_ERROR_CODES.REVISION_EXISTS)).toBe(409);
    expect(hfErrorStatus(HF_ERROR_CODES.TOO_LARGE)).toBe(413);
    expect(hfErrorStatus(HF_ERROR_CODES.RANGE_INVALID)).toBe(416);
    expect(hfErrorStatus(HF_ERROR_CODES.LFS_UNSUPPORTED_OPERATION)).toBe(422);
    expect(hfErrorStatus(HF_ERROR_CODES.ORG_INVALID)).toBe(400);
    expect(hfErrorStatus(HF_ERROR_CODES.UPLOAD_INVALID)).toBe(400);
    expect(hfErrorStatus(HF_ERROR_CODES.LFS_BATCH_INVALID)).toBe(400);
    expect(hfErrorStatus(HF_ERROR_CODES.PATH_INVALID)).toBe(400);
    expect(hfErrorStatus(HF_ERROR_CODES.OID_INVALID)).toBe(400);
    expect(hfErrorStatus(HF_ERROR_CODES.REVISION_INVALID)).toBe(400);
    expect(hfErrorStatus(HF_ERROR_CODES.REPO_INVALID)).toBe(400);
    expect(hfErrorStatus(HF_ERROR_CODES.REPO_TYPE_INVALID)).toBe(400);
  });
});

describe("toEnvelope", () => {
  it("produces the standard envelope shape", () => {
    const env = toEnvelope(
      new HfError(HF_ERROR_CODES.UPLOAD_INVALID, "bad", { foo: "bar" }),
    );
    expect(env.errors[0].code).toBe(HF_ERROR_CODES.UPLOAD_INVALID);
    expect(env.errors[0].message).toBe("bad");
    expect(env.errors[0].detail).toEqual({ foo: "bar" });
  });
  it("omits detail when absent", () => {
    const env = toEnvelope(new HfError(HF_ERROR_CODES.UPLOAD_INVALID, "x"));
    expect(env.errors[0].detail).toBeUndefined();
  });
  it("redacts bearer tokens in message + detail", () => {
    const env = toEnvelope(
      new HfError(
        HF_ERROR_CODES.UNAUTHORIZED,
        "auth: Bearer hf_secret_pat_12345 failed",
        { Authorization: "Bearer hf_secret_pat_12345" },
      ),
    );
    expect(env.errors[0].message).not.toContain("hf_secret_pat_12345");
    expect(JSON.stringify(env.errors[0].detail)).not.toContain(
      "hf_secret_pat_12345",
    );
  });
});

describe("writeHfError", () => {
  it("emits HF-canonical body for REPO_NOT_FOUND", () => {
    const res = makeFakeRes();
    writeHfError(
      res as unknown as ServerResponse,
      new HfError(HF_ERROR_CODES.REPO_NOT_FOUND, "nope"),
    );
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: "Repository not found" });
  });
  it("emits HF-canonical body for REVISION_NOT_FOUND", () => {
    const res = makeFakeRes();
    writeHfError(
      res as unknown as ServerResponse,
      new HfError(HF_ERROR_CODES.REVISION_NOT_FOUND, "nope"),
    );
    expect(JSON.parse(res.body)).toEqual({ error: "Revision not found" });
  });
  it("emits HF-canonical body for FILE_NOT_FOUND", () => {
    const res = makeFakeRes();
    writeHfError(
      res as unknown as ServerResponse,
      new HfError(HF_ERROR_CODES.FILE_NOT_FOUND, "nope"),
    );
    expect(JSON.parse(res.body)).toEqual({ error: "Entry not found" });
  });
  it("emits the generic envelope for non-Q7 errors", () => {
    const res = makeFakeRes();
    writeHfError(
      res as unknown as ServerResponse,
      new HfError(HF_ERROR_CODES.UPLOAD_INVALID, "x"),
    );
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({
      errors: [{ code: HF_ERROR_CODES.UPLOAD_INVALID, message: "x" }],
    });
  });
  it("returns early when headers already sent", () => {
    const res = makeFakeRes();
    res.headersSent = true;
    writeHfError(
      res as unknown as ServerResponse,
      new HfError(HF_ERROR_CODES.UPLOAD_INVALID, "x"),
    );
    expect(res.body).toBe("");
  });
});

describe("asHfError", () => {
  it("returns the same HfError instance", () => {
    const e = new HfError(HF_ERROR_CODES.UPLOAD_INVALID, "x");
    expect(asHfError(e)).toBe(e);
  });
  it("wraps generic Error into UPLOAD_INVALID", () => {
    const wrapped = asHfError(new Error("oops"));
    expect(wrapped.code).toBe(HF_ERROR_CODES.UPLOAD_INVALID);
    expect(wrapped.message).toContain("oops");
  });
  it("wraps non-Error values", () => {
    const wrapped = asHfError("string-rejection");
    expect(wrapped.code).toBe(HF_ERROR_CODES.UPLOAD_INVALID);
    expect(wrapped.message).toContain("internal");
  });
  it("redacts a Bearer token in the wrapped message", () => {
    const wrapped = asHfError(new Error("Bearer hf_leak_token_xyz failed"));
    expect(wrapped.message).not.toContain("hf_leak_token_xyz");
  });
});
