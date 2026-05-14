/**
 * v0.3.0-5 sub-task 6 — CLI surface for `signalman cloud creds`.
 *
 * System-layer coverage: argv → handler → SQLite-backed
 * ControlPlane round-trip. Tests use SIGNALMAN_DATA_DIR for an
 * isolated per-case database and SIGNALMAN_CRED_KEY for the
 * encryption key.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { cmdCloudCreds, type ParsedArgs } from "../cli.js";
import {
  resetEncryptionKeyForTests,
  SIGNALMAN_CRED_KEY_ENV,
} from "../cloud/credentials.js";

function argsFor(positional: string[], opts: Record<string, string> = {}): ParsedArgs {
  return {
    positional: [...positional],
    flags: new Set<string>(),
    options: new Map<string, string>(Object.entries(opts)),
    params: {},
  };
}

function captureStdout(): { restore: () => void; read: () => string } {
  const original = process.stdout.write.bind(process.stdout);
  let buf = "";
  (process.stdout as { write: (chunk: string | Uint8Array) => boolean }).write = (
    chunk: string | Uint8Array,
  ): boolean => {
    buf += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
    return true;
  };
  return {
    restore: () => {
      (process.stdout as { write: typeof original }).write = original;
    },
    read: () => buf,
  };
}

describe("signalman cloud creds — CLI surface", () => {
  let tmpDir: string;
  let prevDataDir: string | undefined;
  let prevCredKey: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sigman-creds-cli-"));
    prevDataDir = process.env.SIGNALMAN_DATA_DIR;
    prevCredKey = process.env[SIGNALMAN_CRED_KEY_ENV];
    process.env.SIGNALMAN_DATA_DIR = tmpDir;
    process.env[SIGNALMAN_CRED_KEY_ENV] = crypto.randomBytes(32).toString("base64");
    resetEncryptionKeyForTests();
  });

  afterEach(() => {
    if (prevDataDir !== undefined) process.env.SIGNALMAN_DATA_DIR = prevDataDir;
    else delete process.env.SIGNALMAN_DATA_DIR;
    if (prevCredKey !== undefined) process.env[SIGNALMAN_CRED_KEY_ENV] = prevCredKey;
    else delete process.env[SIGNALMAN_CRED_KEY_ENV];
    resetEncryptionKeyForTests();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("`creds get` on unconfigured org prints fallback message", async () => {
    const capture = captureStdout();
    try {
      const exit = await cmdCloudCreds(
        argsFor(["get"], { org: "acme", backend: "aws" }),
      );
      expect(exit).toBe(0);
      const out = capture.read();
      expect(out).toMatch(/No credential configured/);
      expect(out).toMatch(/SDK default credential chain/);
    } finally {
      capture.restore();
    }
  });

  it("`creds set --backend aws` stores AND `get` returns redacted hint", async () => {
    // Set
    {
      const capture = captureStdout();
      try {
        const exit = await cmdCloudCreds(
          argsFor(["set"], {
            org: "acme",
            backend: "aws",
            "access-key-id": "AKIAIOSFODNN7EXAMPLE",
            "secret-access-key": "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
          }),
        );
        expect(exit).toBe(0);
        const out = capture.read();
        expect(out).toMatch(/redacted hint: AKIA\*\*\*\*MPLE/);
        // Plaintext must not appear in stdout.
        expect(out).not.toContain("wJalrXUtnFEMI");
      } finally {
        capture.restore();
      }
    }
    // Get
    {
      const capture = captureStdout();
      try {
        const exit = await cmdCloudCreds(
          argsFor(["get"], { org: "acme", backend: "aws", format: "json" }),
        );
        expect(exit).toBe(0);
        const parsed = JSON.parse(capture.read()) as {
          redactedHint: string;
          encryptionMethod: string;
        };
        expect(parsed.redactedHint).toBe("AKIA****MPLE");
        expect(parsed.encryptionMethod).toBe("aes-gcm-env");
        // The JSON object must not contain ciphertext or plaintext.
        expect(JSON.stringify(parsed)).not.toContain("wJalrXUtnFEMI");
      } finally {
        capture.restore();
      }
    }
  });

  it("`creds set --backend azure` stores azure secret without leaking", async () => {
    const capture = captureStdout();
    try {
      const exit = await cmdCloudCreds(
        argsFor(["set"], {
          org: "acme",
          backend: "azure",
          "tenant-id": "11111111-2222-3333-4444-555555555555",
          "client-id": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
          "client-secret": "SUPER-SECRET-DO-NOT-LEAK",
        }),
      );
      expect(exit).toBe(0);
      const out = capture.read();
      expect(out).toMatch(/Stored Azure credential/);
      expect(out).not.toContain("SUPER-SECRET-DO-NOT-LEAK");
    } finally {
      capture.restore();
    }
  });

  it("`creds remove` deletes the row and `get` reverts to fallback", async () => {
    // Set then remove then get.
    const setCapture = captureStdout();
    try {
      await cmdCloudCreds(
        argsFor(["set"], {
          org: "acme",
          backend: "aws",
          "access-key-id": "AKIA-EXAMPLE-FOR-REMOVAL",
          "secret-access-key": "to-be-deleted",
        }),
      );
    } finally {
      setCapture.restore();
    }
    const removeCapture = captureStdout();
    try {
      const exit = await cmdCloudCreds(
        argsFor(["remove"], { org: "acme", backend: "aws" }),
      );
      expect(exit).toBe(0);
    } finally {
      removeCapture.restore();
    }
    const getCapture = captureStdout();
    try {
      await cmdCloudCreds(argsFor(["get"], { org: "acme", backend: "aws" }));
      expect(getCapture.read()).toMatch(/No credential configured/);
    } finally {
      getCapture.restore();
    }
  });

  it("`creds remove` is idempotent (removing non-existent row succeeds)", async () => {
    const capture = captureStdout();
    try {
      const exit = await cmdCloudCreds(
        argsFor(["remove"], { org: "acme", backend: "aws" }),
      );
      expect(exit).toBe(0);
    } finally {
      capture.restore();
    }
  });

  it("`creds set` rejects missing required args", async () => {
    await expect(
      cmdCloudCreds(argsFor(["set"], { org: "acme", backend: "aws" })),
    ).rejects.toThrowError();
  });

  it("`creds` requires --backend aws|azure", async () => {
    await expect(
      cmdCloudCreds(argsFor(["get"], { org: "acme", backend: "gcp" })),
    ).rejects.toThrowError();
  });
});
