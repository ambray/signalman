/**
 * v0.3.0-5 sub-task 6 — per-org credentials at rest.
 *
 * Three layers:
 *   - **Unit**: encryption round-trip, fail-loud on missing key,
 *     redaction-hint format, decryption rejection on tampered
 *     ciphertext.
 *   - **Integration**: setCredential / loadCredentialForOrg
 *     against an in-memory SQLite repo.
 *   - **System**: full credential-rotation flow (set → get →
 *     update → get → remove → get).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as crypto from "node:crypto";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  decryptCredential,
  encryptCredential,
  ENCRYPTION_METHOD_AES_GCM_ENV,
  loadCredentialForOrg,
  loadEncryptionKey,
  redactionHint,
  resetEncryptionKeyForTests,
  setCredential,
  SIGNALMAN_CRED_KEY_ENV,
  type AwsCredentialPlaintext,
  type AzureCredentialPlaintext,
} from "../cloud/credentials.js";
import { CloudBackendError } from "../cloud/types.js";
import { SqliteStorageDriver } from "../control-plane/storage/sqlite.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(
  __dirname,
  "..",
  "control-plane",
  "storage",
  "migrations",
);

async function withTestKey<T>(fn: () => Promise<T> | T): Promise<T> {
  const previous = process.env[SIGNALMAN_CRED_KEY_ENV];
  process.env[SIGNALMAN_CRED_KEY_ENV] = crypto.randomBytes(32).toString("base64");
  resetEncryptionKeyForTests();
  try {
    // Await INSIDE the try so the finally runs after the body
    // resolves (not before). A naive `return fn()` returns the
    // pending promise and the finally fires synchronously, which
    // ends up wiping the env var before the body runs.
    return await fn();
  } finally {
    if (previous !== undefined) process.env[SIGNALMAN_CRED_KEY_ENV] = previous;
    else delete process.env[SIGNALMAN_CRED_KEY_ENV];
    resetEncryptionKeyForTests();
  }
}

function newStorage(): SqliteStorageDriver {
  return new SqliteStorageDriver({
    path: ":memory:",
    migrationsDir: MIGRATIONS_DIR,
  });
}

// ── UNIT: encryption + decryption ────────────────────────────────

describe("loadEncryptionKey", () => {
  beforeEach(() => resetEncryptionKeyForTests());

  it("throws CloudBackendError(invalid_config) when env var is unset", () => {
    delete process.env[SIGNALMAN_CRED_KEY_ENV];
    resetEncryptionKeyForTests();
    expect(() => loadEncryptionKey()).toThrowError(/SIGNALMAN_CRED_KEY/);
    try {
      loadEncryptionKey();
    } catch (e) {
      expect(e).toBeInstanceOf(CloudBackendError);
      expect((e as CloudBackendError).code).toBe("invalid_config");
    }
  });

  it("throws when env var decodes to wrong length", () => {
    process.env[SIGNALMAN_CRED_KEY_ENV] = Buffer.from("too-short").toString("base64");
    resetEncryptionKeyForTests();
    expect(() => loadEncryptionKey()).toThrowError(/32 bytes/);
    delete process.env[SIGNALMAN_CRED_KEY_ENV];
    resetEncryptionKeyForTests();
  });

  it("returns the 32-byte key when properly set", () => {
    const key = crypto.randomBytes(32);
    process.env[SIGNALMAN_CRED_KEY_ENV] = key.toString("base64");
    resetEncryptionKeyForTests();
    expect(loadEncryptionKey().equals(key)).toBe(true);
    delete process.env[SIGNALMAN_CRED_KEY_ENV];
    resetEncryptionKeyForTests();
  });

  it("caches the key across calls (env var removal doesn't break subsequent reads)", () => {
    const key = crypto.randomBytes(32);
    process.env[SIGNALMAN_CRED_KEY_ENV] = key.toString("base64");
    resetEncryptionKeyForTests();
    loadEncryptionKey(); // primes cache
    delete process.env[SIGNALMAN_CRED_KEY_ENV];
    expect(loadEncryptionKey().equals(key)).toBe(true);
    resetEncryptionKeyForTests();
  });
});

describe("encryptCredential / decryptCredential round-trip", () => {
  it("encrypts AWS credentials and decrypts back to the original plaintext", async () => {
    await withTestKey(() => {
      const plaintext: AwsCredentialPlaintext = {
        access_key_id: "AKIAIOSFODNN7EXAMPLE",
        secret_access_key: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      };
      const blob = encryptCredential(plaintext);
      expect(blob).not.toContain(plaintext.access_key_id);
      expect(blob).not.toContain(plaintext.secret_access_key);
      const decrypted = decryptCredential(blob) as AwsCredentialPlaintext;
      expect(decrypted).toEqual(plaintext);
    });
  });

  it("encrypts Azure credentials with optional session_token", async () => {
    await withTestKey(() => {
      const plaintext: AzureCredentialPlaintext = {
        tenant_id: "11111111-2222-3333-4444-555555555555",
        client_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        client_secret: "super-secret-token-value",
      };
      const blob = encryptCredential(plaintext);
      expect(blob).not.toContain(plaintext.client_secret);
      const decrypted = decryptCredential(blob) as AzureCredentialPlaintext;
      expect(decrypted).toEqual(plaintext);
    });
  });

  it("produces different ciphertexts on repeated encrypts (random IV)", async () => {
    await withTestKey(() => {
      const plaintext: AwsCredentialPlaintext = {
        access_key_id: "AKIAEXAMPLE",
        secret_access_key: "secret",
      };
      const b1 = encryptCredential(plaintext);
      const b2 = encryptCredential(plaintext);
      expect(b1).not.toBe(b2);
      expect(decryptCredential(b1)).toEqual(decryptCredential(b2));
    });
  });

  it("refuses to decrypt a tampered ciphertext (auth tag mismatch)", async () => {
    await withTestKey(() => {
      const blob = encryptCredential({
        access_key_id: "AKIAEXAMPLE",
        secret_access_key: "secret",
      });
      // Flip one bit in the middle of the ciphertext.
      const buf = Buffer.from(blob, "base64");
      buf[20] ^= 0x01;
      const tampered = buf.toString("base64");
      expect(() => decryptCredential(tampered)).toThrowError(/failed to decrypt/);
    });
  });

  it("refuses to decrypt a too-short blob", async () => {
    await withTestKey(() => {
      expect(() => decryptCredential("YWJjZA==")).toThrowError(
        /ciphertext too short/,
      );
    });
  });

  it("refuses to decrypt with a different key", async () => {
    let blob: string;
    await withTestKey(() => {
      blob = encryptCredential({
        access_key_id: "AKIAEXAMPLE",
        secret_access_key: "secret",
      });
    });
    // Different key.
    await withTestKey(() => {
      expect(() => decryptCredential(blob)).toThrowError(/failed to decrypt/);
    });
  });
});

describe("redactionHint", () => {
  it("AWS hint is first-4 + ****  + last-4 of access_key_id", () => {
    const hint = redactionHint("aws", {
      access_key_id: "AKIAIOSFODNN7EXAMPLE",
      secret_access_key: "secret",
    });
    expect(hint).toBe("AKIA****MPLE");
  });

  it("AWS hint falls back to AKIA**** for short keys", () => {
    const hint = redactionHint("aws", {
      access_key_id: "short",
      secret_access_key: "secret",
    });
    expect(hint).toBe("AKIA****");
  });

  it("Azure hint shows partial client_id only", () => {
    const hint = redactionHint("azure", {
      tenant_id: "11111111-2222-3333-4444-555555555555",
      client_id: "abcdefab-bbbb-cccc-dddd-eeeeeeeeeeee",
      client_secret: "secret",
    });
    expect(hint).toMatch(/^client_id=abcdefab.*eeee$/);
    expect(hint).not.toContain("secret");
  });

  it("Azure hint never includes client_secret", () => {
    const hint = redactionHint("azure", {
      tenant_id: "t",
      client_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      client_secret: "DO-NOT-LEAK",
    });
    expect(hint).not.toContain("DO-NOT-LEAK");
  });
});

// ── INTEGRATION: repo + encryption pipeline ──────────────────────

describe("setCredential + loadCredentialForOrg — integration", () => {
  let storage: SqliteStorageDriver;

  beforeEach(async () => {
    storage = newStorage();
    await storage.migrate();
  });

  afterEach(async () => {
    await storage.close();
  });

  it("set + load round-trip via repo (encrypted at rest)", async () => {
    await withTestKey(async () => {
      const plaintext: AwsCredentialPlaintext = {
        access_key_id: "AKIAEXAMPLE12345678",
        secret_access_key: "secret-value-here",
      };
      const result = await setCredential(
        storage.cloudCredentials,
        "acme",
        "aws",
        plaintext,
      );
      expect(result.redactedHint).toBe("AKIA****5678");
      // Repo row holds ciphertext, not plaintext.
      const row = await storage.cloudCredentials.get("acme", "aws");
      expect(row).not.toBeNull();
      expect(row!.ciphertextB64).not.toContain("AKIAEXAMPLE");
      expect(row!.ciphertextB64).not.toContain("secret-value-here");
      expect(row!.encryptionMethod).toBe(ENCRYPTION_METHOD_AES_GCM_ENV);
      // Loader decrypts cleanly.
      const loaded = await loadCredentialForOrg(storage.cloudCredentials, "acme", "aws");
      expect(loaded).toEqual(plaintext);
    });
  });

  it("loadCredentialForOrg returns null when no row exists (fallback path)", async () => {
    await withTestKey(async () => {
      const loaded = await loadCredentialForOrg(
        storage.cloudCredentials,
        "acme",
        "aws",
      );
      expect(loaded).toBeNull();
    });
  });

  it("upsert rotates the credential (new ciphertext, same row id)", async () => {
    await withTestKey(async () => {
      await setCredential(storage.cloudCredentials, "acme", "aws", {
        access_key_id: "AKIA-ORIGINAL-KEY",
        secret_access_key: "old-secret",
      });
      const before = await storage.cloudCredentials.get("acme", "aws");
      await setCredential(storage.cloudCredentials, "acme", "aws", {
        access_key_id: "AKIA-ROTATED-KEY",
        secret_access_key: "new-secret",
      });
      const after = await storage.cloudCredentials.get("acme", "aws");
      expect(after).not.toBeNull();
      // Same row id (upsert keeps the existing row).
      expect(after!.id).toBe(before!.id);
      // New ciphertext.
      expect(after!.ciphertextB64).not.toBe(before!.ciphertextB64);
      // Loader returns the new plaintext.
      const loaded = (await loadCredentialForOrg(
        storage.cloudCredentials,
        "acme",
        "aws",
      )) as AwsCredentialPlaintext;
      expect(loaded.secret_access_key).toBe("new-secret");
    });
  });

  it("remove is idempotent", async () => {
    await withTestKey(async () => {
      await expect(
        storage.cloudCredentials.remove("acme", "aws"),
      ).resolves.toBeUndefined();
      await expect(
        storage.cloudCredentials.remove("acme", "aws"),
      ).resolves.toBeUndefined();
    });
  });

  it("loadCredentialForOrg refuses unknown encryption_method", async () => {
    await withTestKey(async () => {
      await storage.cloudCredentials.upsert({
        orgId: "acme",
        backend: "aws",
        ciphertextB64: "AAAA",
        encryptionMethod: "kms-rotation-v2",
        redactedHint: "x",
      });
      await expect(
        loadCredentialForOrg(storage.cloudCredentials, "acme", "aws"),
      ).rejects.toThrowError(/unsupported encryption_method/);
    });
  });
});

// ── SYSTEM: full lifecycle ──────────────────────────────────────

describe("Credentials — system: full set→get→update→remove lifecycle", () => {
  it("operator workflow end-to-end", async () => {
    const storage = newStorage();
    await storage.migrate();
    try {
      await withTestKey(async () => {
        // Initially nothing.
        expect(await storage.cloudCredentials.get("acme", "aws")).toBeNull();

        // Set Azure creds for one org.
        await setCredential(storage.cloudCredentials, "acme", "azure", {
          tenant_id: "tenant-X",
          client_id: "client-Y",
          client_secret: "secret-Z",
        });

        // Set AWS creds for the same org.
        await setCredential(storage.cloudCredentials, "acme", "aws", {
          access_key_id: "AKIAACMEEXAMPLE12345",
          secret_access_key: "acme-secret",
        });

        // listForOrg returns both.
        const all = await storage.cloudCredentials.listForOrg("acme");
        expect(all).toHaveLength(2);
        expect(all.map((c) => c.backend).sort()).toEqual(["aws", "azure"]);

        // Rotate AWS.
        await setCredential(storage.cloudCredentials, "acme", "aws", {
          access_key_id: "AKIAACMEROTATEDABCD",
          secret_access_key: "rotated-secret",
        });
        const rotated = (await loadCredentialForOrg(
          storage.cloudCredentials,
          "acme",
          "aws",
        )) as AwsCredentialPlaintext;
        expect(rotated.secret_access_key).toBe("rotated-secret");

        // Remove Azure.
        await storage.cloudCredentials.remove("acme", "azure");
        expect(await storage.cloudCredentials.get("acme", "azure")).toBeNull();

        // AWS still present.
        expect(
          await loadCredentialForOrg(storage.cloudCredentials, "acme", "aws"),
        ).not.toBeNull();
      });
    } finally {
      await storage.close();
    }
  });
});
