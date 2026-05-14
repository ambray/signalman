import * as crypto from "node:crypto";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RegistryMcpSession, buildMcpServer } from "../mcp.js";
import { generateKeypair, signManifest } from "../signing.js";
import type { Manifest } from "../types.js";
import type { ServerHandle } from "../http/server.js";

describe("RegistryMcpSession", () => {
  let workdir: string;
  let storageRoot: string;
  let session: RegistryMcpSession;
  let startCalls: number;

  beforeEach(async () => {
    workdir = await fsp.mkdtemp(path.join(os.tmpdir(), "registry-mcp-"));
    storageRoot = path.join(workdir, "store");
    startCalls = 0;
    session = new RegistryMcpSession({
      startServer: async (): Promise<ServerHandle> => {
        startCalls += 1;
        return {
          server: undefined as never,
          port: 11111,
          host: "127.0.0.1",
          baseUrl: "http://127.0.0.1:11111",
          close: async () => undefined,
        };
      },
    });
  });

  afterEach(async () => {
    await session.stop();
    await fsp.rm(workdir, { recursive: true, force: true });
  });

  it("serve starts an injected server", async () => {
    const res = await session.serve({ storage_root: storageRoot });
    expect(res.baseUrl).toBe("http://127.0.0.1:11111");
    expect(res.already_running).toBe(false);
    expect(startCalls).toBe(1);
  });

  it("serve is idempotent", async () => {
    await session.serve({ storage_root: storageRoot });
    const second = await session.serve({ storage_root: storageRoot });
    expect(second.already_running).toBe(true);
    expect(startCalls).toBe(1);
  });

  it("status reports running state", async () => {
    expect(await session.status()).toEqual({ running: false });
    await session.serve({ storage_root: storageRoot });
    const s = await session.status();
    expect(s.running).toBe(true);
    expect(s.port).toBe(11111);
  });

  it("ensureStorage works without serve (CLI-like flow)", async () => {
    // No serve call — push/pull should still work against the
    // injected storage_root.
    const blob = Buffer.from("hello-mcp");
    const sha = crypto.createHash("sha256").update(blob).digest("hex");
    // Push the blob via the LocalFsRegistryStorage directly so the
    // manifest push doesn't fail the unknown-blob check.
    const storage = session.ensureStorage(storageRoot);
    await storage.putBlob({ body: blob });

    const manifest: Manifest = {
      name: "demo",
      version: "1.0.0",
      mediaType: "application/vnd.signalman.manifest+json",
      blobs: [
        { mediaType: "application/octet-stream", sha256: sha, size: blob.length },
      ],
      createdAt: "2026-05-14T12:00:00.000Z",
    };
    const push = await session.pushManifest({
      storage_root: storageRoot,
      manifest,
    });
    expect(push.manifest.name).toBe("demo");

    const pull = await session.pullManifest({
      storage_root: storageRoot,
      name: "demo",
      version: "1.0.0",
    });
    expect(pull.manifest?.name).toBe("demo");

    const list = await session.listVersions({
      storage_root: storageRoot,
      name: "demo",
    });
    expect(list.versions).toHaveLength(1);
  });

  it("verify returns ok=true on a valid manifest", async () => {
    const { publicKeyPem, privateKeyPem } = generateKeypair();
    const m: Manifest = {
      name: "demo",
      version: "1.0.0",
      mediaType: "application/vnd.signalman.manifest+json",
      blobs: [],
      createdAt: "2026-05-14T12:00:00.000Z",
    };
    const sig = signManifest(m, privateKeyPem);
    const signed = {
      ...m,
      signature: { signatureB64: sig.signatureB64, signedBy: sig.signedBy },
    };
    const manifestPath = path.join(workdir, "manifest.json");
    const pubPath = path.join(workdir, "key.pub.pem");
    await fsp.writeFile(manifestPath, JSON.stringify(signed), "utf-8");
    await fsp.writeFile(pubPath, publicKeyPem, "utf-8");
    const res = await session.verify({
      manifest_path: manifestPath,
      public_key_path: pubPath,
    });
    expect(res.ok).toBe(true);
    expect(res.signed_by).toBe(sig.signedBy);
  });

  it("verify returns ok=false with a tampered manifest", async () => {
    const { publicKeyPem, privateKeyPem } = generateKeypair();
    const m: Manifest = {
      name: "demo",
      version: "1.0.0",
      mediaType: "application/vnd.signalman.manifest+json",
      blobs: [],
      createdAt: "2026-05-14T12:00:00.000Z",
    };
    const sig = signManifest(m, privateKeyPem);
    const tampered = {
      ...m,
      version: "9.9.9",
      signature: { signatureB64: sig.signatureB64, signedBy: sig.signedBy },
    };
    const manifestPath = path.join(workdir, "manifest.json");
    const pubPath = path.join(workdir, "key.pub.pem");
    await fsp.writeFile(manifestPath, JSON.stringify(tampered), "utf-8");
    await fsp.writeFile(pubPath, publicKeyPem, "utf-8");
    const res = await session.verify({
      manifest_path: manifestPath,
      public_key_path: pubPath,
    });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("invalid");
  });

  it("keygen returns valid PEMs + a 16-hex fingerprint", async () => {
    const res = await session.keygen();
    expect(res.public_key_pem).toContain("BEGIN PUBLIC KEY");
    expect(res.private_key_pem).toContain("BEGIN PRIVATE KEY");
    expect(res.fingerprint).toMatch(/^[a-f0-9]{16}$/);
  });

  it("stop is a no-op when never served", async () => {
    expect(await session.stop()).toEqual({ closed: false });
  });
});

describe("buildMcpServer", () => {
  it("registers the seven registry tools", () => {
    const server = buildMcpServer();
    // The MCP SDK exposes the registered tool map on the internal
    // `_registeredTools` field; we sniff it to avoid driving the
    // stdio transport. If the SDK ever renames this field the test
    // becomes a tripwire that catches the SDK breaking change.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const internal = server as any;
    const registered = internal._registeredTools as
      | Record<string, unknown>
      | undefined;
    expect(registered).toBeDefined();
    const names = Object.keys(registered!);
    for (const tool of [
      "registry_serve",
      "registry_status",
      "registry_push_manifest",
      "registry_pull_manifest",
      "registry_list_versions",
      "registry_verify",
      "registry_keygen",
    ]) {
      expect(names).toContain(tool);
    }
  });
});
