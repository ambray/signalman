/**
 * v0.3.0-5 sub-task 8 commit 2 — per-org backend resolution.
 *
 * Bridges the credential storage (sub-task 6 commit 2) into the
 * AwsBackend / AzureBackend constructor paths. When a caller
 * passes org_id AND a credential row exists for (org, kind),
 * provision uses those credentials; otherwise it falls back to
 * the registry's default backend (SDK default credential chain).
 *
 * Three layers:
 *   - **Unit**: resolver dispatch logic — no creds → default,
 *     creds → custom builder, unsupported kind → throws
 *   - **Integration**: full pipeline with in-memory SQLite for
 *     the credentials repo + a stub builder; verifies the
 *     decrypted plaintext gets handed to the builder
 *   - **System**: provision flow end-to-end with a configured
 *     credential row, observing the backend was constructed
 *     with the per-org plaintext rather than the registry default
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as crypto from "node:crypto";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  resolveBackendForOrg,
} from "../cloud/per-org-backend.js";
import {
  resetEncryptionKeyForTests,
  setCredential,
  SIGNALMAN_CRED_KEY_ENV,
} from "../cloud/credentials.js";
import {
  CloudBackendError,
  type CloudBackend,
  type CloudInstanceConfig,
  type CloudInstanceHandle,
  type CloudInstanceStatus,
} from "../cloud/types.js";
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
    return await fn();
  } finally {
    if (previous !== undefined) process.env[SIGNALMAN_CRED_KEY_ENV] = previous;
    else delete process.env[SIGNALMAN_CRED_KEY_ENV];
    resetEncryptionKeyForTests();
  }
}

function makeStubBackend(label: string): CloudBackend {
  return {
    name: "aws",
    async provisionInstance(_: CloudInstanceConfig): Promise<CloudInstanceHandle> {
      return {
        id: `i-${label}`,
        backend: "aws",
        name: label,
        region: "us-east-1",
      };
    },
    async terminateInstance(): Promise<void> {},
    async getInstanceStatus(_: CloudInstanceHandle): Promise<CloudInstanceStatus> {
      throw new CloudBackendError("provision_failed", "stub");
    },
    async getInstanceIp() {
      return null;
    },
    async listInstances() {
      return [];
    },
  };
}

function newStorage(): SqliteStorageDriver {
  return new SqliteStorageDriver({
    path: ":memory:",
    migrationsDir: MIGRATIONS_DIR,
  });
}

// ── UNIT: resolver dispatch logic ────────────────────────────────

describe("resolveBackendForOrg — unit", () => {
  let storage: SqliteStorageDriver;

  beforeEach(async () => {
    storage = newStorage();
    await storage.migrate();
  });

  afterEach(async () => {
    await storage.close();
  });

  it("returns default backend when no credential row exists", async () => {
    await withTestKey(async () => {
      const defaultBackend = makeStubBackend("default-stub");
      let buildCalls = 0;
      const result = await resolveBackendForOrg("aws", "acme", {
        credentialsRepo: storage.cloudCredentials,
        defaultBackend: () => defaultBackend,
        buildBackendWithCreds: () => {
          buildCalls += 1;
          return makeStubBackend("with-creds");
        },
      });
      expect(result).toBe(defaultBackend);
      expect(buildCalls).toBe(0);
    });
  });

  it("calls buildBackendWithCreds when a credential row exists", async () => {
    await withTestKey(async () => {
      await setCredential(storage.cloudCredentials, "acme", "aws", {
        access_key_id: "AKIAEXAMPLE12345678",
        secret_access_key: "stub-secret",
      });
      const receivedPlaintexts: unknown[] = [];
      const result = await resolveBackendForOrg("aws", "acme", {
        credentialsRepo: storage.cloudCredentials,
        defaultBackend: () => {
          throw new Error("default should not be called");
        },
        buildBackendWithCreds: (kind, plaintext) => {
          receivedPlaintexts.push({ kind, plaintext });
          return makeStubBackend("creds-stub");
        },
      });
      expect(result.name).toBe("aws");
      expect(receivedPlaintexts).toHaveLength(1);
      expect(receivedPlaintexts[0]).toMatchObject({
        kind: "aws",
        plaintext: {
          access_key_id: "AKIAEXAMPLE12345678",
          secret_access_key: "stub-secret",
        },
      });
    });
  });

  it("supports an async builder", async () => {
    await withTestKey(async () => {
      await setCredential(storage.cloudCredentials, "acme", "aws", {
        access_key_id: "AKIA-ASYNC",
        secret_access_key: "secret",
      });
      const result = await resolveBackendForOrg("aws", "acme", {
        credentialsRepo: storage.cloudCredentials,
        defaultBackend: () => {
          throw new Error("default should not be called");
        },
        buildBackendWithCreds: async () => {
          await new Promise((r) => setImmediate(r));
          return makeStubBackend("async-stub");
        },
      });
      expect(result.name).toBe("aws");
    });
  });

  it("rejects unsupported kinds", async () => {
    await expect(
      resolveBackendForOrg("gcp" as never, "acme", {
        credentialsRepo: storage.cloudCredentials,
        defaultBackend: () => makeStubBackend("d"),
        buildBackendWithCreds: () => makeStubBackend("c"),
      }),
    ).rejects.toThrowError(/unsupported.*gcp/i);
  });

  it("propagates decryption failure (does NOT silently fall back to default)", async () => {
    // Set creds with one key, then change the key — decrypt will
    // fail. The resolver must propagate, not silently return the
    // default backend (privilege-escalation surprise).
    let storedBlob: string | undefined;
    await withTestKey(async () => {
      await setCredential(storage.cloudCredentials, "acme", "aws", {
        access_key_id: "AKIA-WILL-MISMATCH",
        secret_access_key: "secret",
      });
      const row = await storage.cloudCredentials.get("acme", "aws");
      storedBlob = row?.ciphertextB64;
    });
    // Different key, same stored ciphertext.
    await withTestKey(async () => {
      // Sanity: the row still exists.
      const row = await storage.cloudCredentials.get("acme", "aws");
      expect(row?.ciphertextB64).toBe(storedBlob);
      await expect(
        resolveBackendForOrg("aws", "acme", {
          credentialsRepo: storage.cloudCredentials,
          defaultBackend: () => makeStubBackend("d"),
          buildBackendWithCreds: () => makeStubBackend("c"),
        }),
      ).rejects.toThrowError(/failed to decrypt/);
    });
  });
});

// ── INTEGRATION: full pipeline via SqliteStorageDriver ───────────

describe("resolveBackendForOrg — integration", () => {
  it("set creds for one org, default backend for another", async () => {
    const storage = newStorage();
    await storage.migrate();
    try {
      await withTestKey(async () => {
        // org "acme" has creds.
        await setCredential(storage.cloudCredentials, "acme", "aws", {
          access_key_id: "AKIA-ACME",
          secret_access_key: "acme-secret",
        });
        // org "globex" has none.

        const builderCalledFor: string[] = [];
        const opts = {
          credentialsRepo: storage.cloudCredentials,
          defaultBackend: () => makeStubBackend("default"),
          buildBackendWithCreds: (_kind: "aws" | "azure", _p: unknown) => {
            builderCalledFor.push("per-org");
            return makeStubBackend("per-org");
          },
        };

        const acme = await resolveBackendForOrg("aws", "acme", opts);
        const globex = await resolveBackendForOrg("aws", "globex", opts);

        expect(builderCalledFor).toEqual(["per-org"]);
        // acme used the per-org backend; globex used the default.
        // Both are stub instances; verify by the unique handle id
        // their provisionInstance returns.
        const acmeHandle = await acme.provisionInstance({
          region: "us-east-1",
          instance_type: "t3.medium",
          image_ref: "ami-x",
          name: "test",
        });
        const globexHandle = await globex.provisionInstance({
          region: "us-east-1",
          instance_type: "t3.medium",
          image_ref: "ami-x",
          name: "test",
        });
        expect(acmeHandle.id).toBe("i-per-org");
        expect(globexHandle.id).toBe("i-default");
      });
    } finally {
      await storage.close();
    }
  });

  it("Azure credential row routes to Azure builder", async () => {
    const storage = newStorage();
    await storage.migrate();
    try {
      await withTestKey(async () => {
        await setCredential(storage.cloudCredentials, "acme", "azure", {
          tenant_id: "T",
          client_id: "C",
          client_secret: "S",
        });
        const kinds: string[] = [];
        await resolveBackendForOrg("azure", "acme", {
          credentialsRepo: storage.cloudCredentials,
          defaultBackend: () => makeStubBackend("d"),
          buildBackendWithCreds: (kind, _p) => {
            kinds.push(kind);
            return makeStubBackend("azure-creds");
          },
        });
        expect(kinds).toEqual(["azure"]);
      });
    } finally {
      await storage.close();
    }
  });
});

// ── SYSTEM: end-to-end provision with per-org creds ─────────────

describe("resolveBackendForOrg — system: end-to-end provision flow", () => {
  it("provision via per-org backend lands the right handle", async () => {
    const storage = newStorage();
    await storage.migrate();
    try {
      await withTestKey(async () => {
        await setCredential(storage.cloudCredentials, "acme", "aws", {
          access_key_id: "AKIA-SYSTEM",
          secret_access_key: "system-secret",
        });

        // Capture what plaintext the builder received.
        let receivedSecret = "";
        const backend = await resolveBackendForOrg("aws", "acme", {
          credentialsRepo: storage.cloudCredentials,
          defaultBackend: () => {
            throw new Error("default path should not run");
          },
          buildBackendWithCreds: (_kind, plaintext) => {
            receivedSecret = (plaintext as { secret_access_key: string })
              .secret_access_key;
            return makeStubBackend("system-stub");
          },
        });
        const handle = await backend.provisionInstance({
          region: "us-east-1",
          instance_type: "t3.medium",
          image_ref: "ami-x",
          name: "test",
        });
        expect(handle.id).toBe("i-system-stub");
        expect(receivedSecret).toBe("system-secret");
      });
    } finally {
      await storage.close();
    }
  });
});
