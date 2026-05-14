#!/usr/bin/env node
/**
 * `signalman-registry` MCP server.
 *
 * Exposes the registry's high-value operations as MCP tools so that
 * agent-driven workflows (push-then-verify, list-then-pull) work
 * without shelling out to the HTTP CLI. Mirrors the host's MCP
 * server pattern (`McpServer` + zod parameter shapes + stdio
 * transport) so existing agent integrations slot in unchanged.
 *
 * Tools (all `registry_*`):
 *   - `registry_serve`         — boot the HTTP API in-process
 *   - `registry_status`        — health + listening port
 *   - `registry_push_manifest` — push a JSON manifest body
 *   - `registry_pull_manifest` — pull + verify a manifest
 *   - `registry_list_versions` — list manifest versions by name
 *   - `registry_verify`        — verify a manifest file against a pubkey
 *   - `registry_keygen`        — generate an Ed25519 keypair
 *
 * The serve tool returns a tool-managed handle — the MCP client
 * keeps a single registry instance per session. A `registry_status`
 * call resolves the current port; `registry_serve` is idempotent
 * (re-calling is a no-op while the instance is alive).
 *
 * Storage: each MCP session backs a single LocalFsRegistryStorage
 * rooted at the `storage_root` parameter to `registry_serve`. Tools
 * other than `registry_serve` may pass the same root; if a server
 * is already running, the call uses that instance.
 */

import * as fsp from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  fingerprintPublicKey,
  generateKeypair,
  SignatureVerificationError,
  verifyManifestInline,
} from "./signing.js";
import { LocalFsRegistryStorage } from "./storage/registry-storage.js";
import { createServer, type ServerHandle } from "./http/server.js";
import type { AppOptions } from "./http/app.js";
import {
  validateManifestName,
  validateManifestVersion,
  type Manifest,
} from "./types.js";

interface RegistrySession {
  storage: LocalFsRegistryStorage;
  serverHandle: ServerHandle | null;
}

interface SessionOptions {
  /** Override `createServer` for tests. */
  startServer?: (opts: AppOptions & { host?: string; port?: number }) => Promise<ServerHandle>;
}

/**
 * Session state lives on the registry instance so two MCP clients
 * cannot accidentally share the same handle. Tests inject their
 * own session to avoid the singleton path.
 */
export class RegistryMcpSession {
  private session: RegistrySession | null = null;
  private readonly startServer: NonNullable<SessionOptions["startServer"]>;

  constructor(opts: SessionOptions = {}) {
    this.startServer = opts.startServer ?? createServer;
  }

  async serve(input: {
    storage_root: string;
    host?: string;
    port?: number;
  }): Promise<{ baseUrl: string; port: number; host: string; already_running: boolean }> {
    if (this.session?.serverHandle) {
      const h = this.session.serverHandle;
      return {
        baseUrl: h.baseUrl,
        port: h.port,
        host: h.host,
        already_running: true,
      };
    }
    const storage = this.session?.storage
      ?? LocalFsRegistryStorage.fromRoot(input.storage_root);
    const handle = await this.startServer({
      storage,
      ...(input.host ? { host: input.host } : {}),
      ...(input.port !== undefined ? { port: input.port } : {}),
    });
    this.session = { storage, serverHandle: handle };
    return {
      baseUrl: handle.baseUrl,
      port: handle.port,
      host: handle.host,
      already_running: false,
    };
  }

  async status(): Promise<{
    running: boolean;
    baseUrl?: string;
    port?: number;
  }> {
    if (!this.session?.serverHandle) return { running: false };
    return {
      running: true,
      baseUrl: this.session.serverHandle.baseUrl,
      port: this.session.serverHandle.port,
    };
  }

  async stop(): Promise<{ closed: boolean }> {
    if (!this.session) return { closed: false };
    const { storage, serverHandle } = this.session;
    if (serverHandle) await serverHandle.close();
    storage.close();
    this.session = null;
    return { closed: true };
  }

  /** Ensure a session exists for tool calls that do not start the HTTP server. */
  ensureStorage(storage_root: string): LocalFsRegistryStorage {
    if (!this.session) {
      this.session = {
        storage: LocalFsRegistryStorage.fromRoot(storage_root),
        serverHandle: null,
      };
    }
    return this.session.storage;
  }

  async pushManifest(input: {
    storage_root: string;
    manifest: Manifest;
  }): Promise<{ manifest: Manifest }> {
    validateManifestName(input.manifest.name);
    validateManifestVersion(input.manifest.version);
    const storage = this.ensureStorage(input.storage_root);
    const stored = await storage.putManifest(input.manifest);
    return { manifest: stored };
  }

  async pullManifest(input: {
    storage_root: string;
    name: string;
    version: string;
  }): Promise<{ manifest: Manifest | null }> {
    validateManifestName(input.name);
    validateManifestVersion(input.version);
    const storage = this.ensureStorage(input.storage_root);
    const manifest = await storage.getManifest(input.name, input.version);
    return { manifest };
  }

  async listVersions(input: {
    storage_root: string;
    name: string;
  }): Promise<{ versions: Awaited<ReturnType<LocalFsRegistryStorage["listManifestVersions"]>> }> {
    validateManifestName(input.name);
    const storage = this.ensureStorage(input.storage_root);
    return { versions: await storage.listManifestVersions(input.name) };
  }

  async verify(input: {
    manifest_path: string;
    public_key_path: string;
  }): Promise<{ ok: boolean; signed_by?: string; error?: string }> {
    const raw = await fsp.readFile(input.manifest_path, "utf-8");
    const publicKeyPem = await fsp.readFile(input.public_key_path, "utf-8");
    const manifest = JSON.parse(raw) as Manifest;
    try {
      verifyManifestInline(manifest, publicKeyPem);
      return { ok: true, signed_by: manifest.signature?.signedBy };
    } catch (err) {
      if (err instanceof SignatureVerificationError) {
        return { ok: false, error: err.message };
      }
      throw err;
    }
  }

  async keygen(): Promise<{
    public_key_pem: string;
    private_key_pem: string;
    fingerprint: string;
  }> {
    const keypair = generateKeypair();
    return {
      public_key_pem: keypair.publicKeyPem,
      private_key_pem: keypair.privateKeyPem,
      fingerprint: fingerprintPublicKey(keypair.publicKeyPem),
    };
  }
}

/**
 * Build a configured `McpServer` that exposes the registry tools.
 * Exported so tests can probe the registration table without
 * speaking the stdio transport.
 */
export function buildMcpServer(
  session: RegistryMcpSession = new RegistryMcpSession(),
): McpServer {
  const server = new McpServer({
    name: "signalman-registry",
    version: "0.0.1",
  });

  server.tool(
    "registry_serve",
    "Boot the registry HTTP API in-process. Returns the bound base URL. Idempotent — re-calling returns the existing handle.",
    {
      storage_root: z.string().describe("Filesystem root for blobs + SQLite catalog."),
      host: z.string().optional().describe("Bind host. Defaults to 127.0.0.1."),
      port: z.number().int().min(0).max(65535).optional().describe("Bind port. Pass 0 for kernel-assigned."),
    },
    async (params) => asMcpResult(await session.serve(params)),
  );

  server.tool(
    "registry_status",
    "Report whether the registry HTTP server is running and on what port.",
    {},
    async () => asMcpResult(await session.status()),
  );

  server.tool(
    "registry_push_manifest",
    "Insert a manifest into the registry's catalog. The manifest body must reference only blobs the registry already has.",
    {
      storage_root: z.string(),
      manifest: z
        .object({
          name: z.string(),
          version: z.string(),
          mediaType: z.string(),
          blobs: z.array(
            z.object({
              mediaType: z.string(),
              sha256: z.string(),
              size: z.number().int().nonnegative().optional(),
              name: z.string().optional(),
            }),
          ),
          annotations: z.record(z.string(), z.string()).optional(),
          signature: z
            .object({
              signatureB64: z.string(),
              signedBy: z.string(),
            })
            .optional(),
          createdAt: z.string(),
        })
        .describe("Full manifest object — see @signalman/registry types.Manifest."),
    },
    async (params) =>
      asMcpResult(
        await session.pushManifest(
          params as { storage_root: string; manifest: Manifest },
        ),
      ),
  );

  server.tool(
    "registry_pull_manifest",
    "Pull a manifest by (name, version). Returns null if unknown.",
    {
      storage_root: z.string(),
      name: z.string(),
      version: z.string(),
    },
    async (params) =>
      asMcpResult(
        await session.pullManifest(
          params as { storage_root: string; name: string; version: string },
        ),
      ),
  );

  server.tool(
    "registry_list_versions",
    "List all versions of a given manifest name, newest first.",
    {
      storage_root: z.string(),
      name: z.string(),
    },
    async (params) =>
      asMcpResult(
        await session.listVersions(
          params as { storage_root: string; name: string },
        ),
      ),
  );

  server.tool(
    "registry_verify",
    "Verify a manifest JSON file against an Ed25519 public-key PEM file. Returns {ok, signed_by} on success or {ok:false, error} on signature failure.",
    {
      manifest_path: z.string(),
      public_key_path: z.string(),
    },
    async (params) =>
      asMcpResult(
        await session.verify(
          params as { manifest_path: string; public_key_path: string },
        ),
      ),
  );

  server.tool(
    "registry_keygen",
    "Generate a fresh Ed25519 keypair. Returns both PEMs + the 16-hex-char public-key fingerprint. Caller is responsible for persisting these.",
    {},
    async () => asMcpResult(await session.keygen()),
  );

  return server;
}

function asMcpResult(value: unknown): {
  content: Array<{ type: "text"; text: string }>;
} {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  };
}

// Top-level invocation when run via `signalman-registry mcp` /
// `npm run mcp`. Tests import buildMcpServer / RegistryMcpSession
// directly so they don't trigger this path.
const invokedDirectly =
  process.argv[1] && process.argv[1].endsWith("mcp.js");
if (invokedDirectly) {
  const server = buildMcpServer();
  const transport = new StdioServerTransport();
  server.connect(transport).catch((err: unknown) => {
    process.stderr.write(`mcp connect failed: ${(err as Error).stack ?? err}\n`);
    process.exit(1);
  });
}
