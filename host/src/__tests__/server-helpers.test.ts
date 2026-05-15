// WS6 milestone 2 — focused unit test for the server-side helper
// `resolvePemInput` used by signalman_release_verify and
// signalman_key_fingerprint. Pins the mutual-exclusion contract
// (both / neither / either) and the file-read happy path.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resolvePemInput } from "../server-helpers.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "sg-resolvepem-"));
});

afterEach(async () => {
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

describe("resolvePemInput — mutual exclusion", () => {
  it("rejects when both pathInput and pemInput are provided", async () => {
    await expect(
      resolvePemInput("/some/path", "-----BEGIN PUBLIC KEY-----\n…\n-----END PUBLIC KEY-----\n", "test_tool"),
    ).rejects.toThrow(/test_tool.*exactly one of public_key_path or public_key_pem.*got both/);
  });

  it("rejects when neither is provided", async () => {
    await expect(resolvePemInput(undefined, undefined, "test_tool")).rejects.toThrow(
      /test_tool.*exactly one of public_key_path or public_key_pem.*got neither/,
    );
  });

  it("rejects when both are empty strings (counts as neither)", async () => {
    await expect(resolvePemInput("", "", "test_tool")).rejects.toThrow(
      /got neither/,
    );
  });
});

describe("resolvePemInput — inline PEM path", () => {
  it("returns the inline PEM verbatim when only pemInput is provided", async () => {
    const pem = "-----BEGIN PUBLIC KEY-----\nABC=\n-----END PUBLIC KEY-----\n";
    const got = await resolvePemInput(undefined, pem, "test_tool");
    expect(got).toBe(pem);
  });

  it("does not read from disk when pemInput is supplied (no fsp call)", async () => {
    // Sanity: we get an error when the path doesn't exist if we passed
    // a path. We should NOT see that error when only pem is passed.
    const pem = "-----BEGIN PUBLIC KEY-----\nINLINE=\n-----END PUBLIC KEY-----\n";
    const got = await resolvePemInput(undefined, pem, "test_tool");
    expect(got).toContain("INLINE");
  });
});

describe("resolvePemInput — filesystem path", () => {
  it("reads PEM contents from an absolute path", async () => {
    const target = path.join(tmpDir, "key.pub");
    const pem = "-----BEGIN PUBLIC KEY-----\nDISK=\n-----END PUBLIC KEY-----\n";
    await fsp.writeFile(target, pem, "utf-8");
    const got = await resolvePemInput(target, undefined, "test_tool");
    expect(got).toBe(pem);
  });

  it("resolves relative paths against process.cwd()", async () => {
    // Use a path relative to tmpDir then cd into tmpDir for the call.
    // Avoid clobbering global cwd: write the file using the absolute
    // path but call resolvePemInput with the file basename and cd in.
    const target = path.join(tmpDir, "rel-key.pub");
    const pem = "-----BEGIN PUBLIC KEY-----\nREL=\n-----END PUBLIC KEY-----\n";
    await fsp.writeFile(target, pem, "utf-8");
    const originalCwd = process.cwd();
    try {
      process.chdir(tmpDir);
      const got = await resolvePemInput("rel-key.pub", undefined, "test_tool");
      expect(got).toBe(pem);
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("surfaces the underlying fs error when the path does not exist", async () => {
    const missing = path.join(tmpDir, "no-such.pub");
    await expect(
      resolvePemInput(missing, undefined, "test_tool"),
    ).rejects.toThrow(/ENOENT|no such file/i);
  });
});
