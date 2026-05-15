// WS6 wave-3 M10.5 — forensic + provenance HTTP route tests.
//
// Coverage:
//   - manifestCountsByKindAndSource: aggregate query
//   - artifactsByUpstream: aggregate query
//   - GET /v1/provenance/manifest/:name/:version: returns
//     {manifest, provenance} for cargo + generic kinds
//   - GET /v1/audit: filters AND-combine; default limit; max cap
//   - GET /v1/forensic/summary: rolled-up by-kind view
//   - GET /v1/forensic/upstreams: per-upstream artifact counts

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createServer, type ServerHandle } from "../http/server.js";
import {
  cargoManifestName,
  type CargoPublishMetadata,
} from "../cargo/index.js";
import { LocalFsRegistryStorage } from "../storage/registry-storage.js";
import type { Manifest } from "../types.js";

const AUTH = "Bearer sk_TEST_0123456789ABCDEF";

function buildPublishBody(meta: CargoPublishMetadata, tarball: Buffer): Buffer {
  const metaJson = Buffer.from(JSON.stringify(meta), "utf-8");
  const head = Buffer.alloc(4);
  head.writeUInt32LE(metaJson.length, 0);
  const tarHead = Buffer.alloc(4);
  tarHead.writeUInt32LE(tarball.length, 0);
  return Buffer.concat([head, metaJson, tarHead, tarball]);
}

// ── Aggregate queries on SqliteManifestIndex ───────────────────────

describe("forensic aggregate queries", () => {
  let dataDir: string;
  let storage: LocalFsRegistryStorage;

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "signalman-forensic-q-"));
    storage = LocalFsRegistryStorage.fromRoot(dataDir);
  });
  afterEach(async () => {
    storage.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  it("manifestCountsByKindAndSource: empty registry returns []", () => {
    expect(storage.index.manifestCountsByKindAndSource()).toEqual([]);
  });

  it("manifestCountsByKindAndSource: groups by (kind, source)", async () => {
    // Seed via direct storage calls. Use distinct shas so blob
    // checks pass.
    const sha = (s: string) =>
      crypto.createHash("sha256").update(s).digest("hex");

    // Upload three blobs
    await storage.putBlob({ body: Buffer.from("a"), contentType: "application/octet-stream" });
    await storage.putBlob({ body: Buffer.from("b"), contentType: "application/octet-stream" });
    await storage.putBlob({ body: Buffer.from("c"), contentType: "application/octet-stream" });

    // Manifest 1: generic, source=manifest_create
    await storage.putManifest({
      name: "g1",
      version: "1",
      mediaType: "application/json",
      blobs: [{ mediaType: "application/octet-stream", sha256: sha("a") }],
      createdAt: "2026-05-15T00:00:00Z",
    });
    // Manifest 2: cargo, source=upload
    await storage.putManifest(
      {
        name: "cargo/acme/x",
        version: "1.0.0",
        mediaType: "application/json",
        kind: "cargo",
        blobs: [{ mediaType: "application/x-tar", sha256: sha("b") }],
        cargoMetadata: {
          name: "x",
          vers: "1.0.0",
          deps: [],
          cksum: sha("b"),
          features: {},
          yanked: false,
        },
        createdAt: "2026-05-15T00:00:00Z",
      },
      { source: "upload", fetchedAt: "2026-05-15T00:00:00Z" },
    );
    // Manifest 3: cargo, source=proxy_cache
    await storage.putManifest(
      {
        name: "cargo/acme/y",
        version: "2.0.0",
        mediaType: "application/json",
        kind: "cargo",
        blobs: [{ mediaType: "application/x-tar", sha256: sha("c") }],
        cargoMetadata: {
          name: "y",
          vers: "2.0.0",
          deps: [],
          cksum: sha("c"),
          features: {},
          yanked: false,
        },
        createdAt: "2026-05-15T00:00:00Z",
      },
      {
        source: "proxy_cache",
        upstreamUrl: "https://index.crates.io",
        fetchedAt: "2026-05-15T00:00:00Z",
      },
    );

    const counts = storage.index.manifestCountsByKindAndSource();
    const map = Object.fromEntries(
      counts.map((c) => [`${c.kind}:${c.source}`, c.count]),
    );
    expect(map["generic:manifest_create"]).toBe(1);
    expect(map["cargo:upload"]).toBe(1);
    expect(map["cargo:proxy_cache"]).toBe(1);
  });

  it("artifactsByUpstream: returns counts for proxy_cache manifests only", async () => {
    const sha = (s: string) =>
      crypto.createHash("sha256").update(s).digest("hex");
    await storage.putBlob({ body: Buffer.from("a"), contentType: "application/octet-stream" });
    await storage.putBlob({ body: Buffer.from("b"), contentType: "application/octet-stream" });
    await storage.putBlob({ body: Buffer.from("c"), contentType: "application/octet-stream" });
    await storage.putManifest(
      {
        name: "cargo/acme/x",
        version: "1.0.0",
        mediaType: "json",
        kind: "cargo",
        blobs: [{ mediaType: "application/x-tar", sha256: sha("a") }],
        cargoMetadata: {
          name: "x",
          vers: "1.0.0",
          deps: [],
          cksum: sha("a"),
          features: {},
          yanked: false,
        },
        createdAt: "2026-05-15T00:00:00Z",
      },
      {
        source: "proxy_cache",
        upstreamUrl: "https://index.crates.io",
        fetchedAt: "2026-05-15T00:00:00Z",
      },
    );
    await storage.putManifest(
      {
        name: "cargo/acme/y",
        version: "1.0.0",
        mediaType: "json",
        kind: "cargo",
        blobs: [{ mediaType: "application/x-tar", sha256: sha("b") }],
        cargoMetadata: {
          name: "y",
          vers: "1.0.0",
          deps: [],
          cksum: sha("b"),
          features: {},
          yanked: false,
        },
        createdAt: "2026-05-15T00:00:00Z",
      },
      {
        source: "proxy_cache",
        upstreamUrl: "https://index.crates.io",
        fetchedAt: "2026-05-15T00:00:00Z",
      },
    );
    // A non-proxy manifest shouldn't appear
    await storage.putManifest({
      name: "internal/svc",
      version: "1.0",
      mediaType: "json",
      blobs: [{ mediaType: "application/octet-stream", sha256: sha("c") }],
      createdAt: "2026-05-15T00:00:00Z",
    });
    const rows = storage.index.artifactsByUpstream();
    expect(rows).toEqual([
      { upstreamUrl: "https://index.crates.io", count: 2 },
    ]);
  });
});

// ── HTTP integration ───────────────────────────────────────────────

describe("forensic HTTP routes", () => {
  let dataDir: string;
  let storage: LocalFsRegistryStorage;
  let server: ServerHandle;
  let base: string;

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "signalman-forensic-"));
    storage = LocalFsRegistryStorage.fromRoot(dataDir);
    server = await createServer({
      storage,
      port: 0,
      auth: { acceptAnyValidShape: true },
    });
    base = `http://127.0.0.1:${server.port}`;
  });
  afterEach(async () => {
    await server.close();
    storage.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  async function publishCargo(
    org: string,
    name: string,
    version: string,
    tarball: Buffer,
  ): Promise<void> {
    const body = buildPublishBody({ name, vers: version, deps: [] }, tarball);
    const r = await fetch(`${base}/cargo/${org}/api/v1/crates/new`, {
      method: "PUT",
      headers: {
        authorization: AUTH,
        "content-type": "application/octet-stream",
      },
      body,
    });
    if (r.status !== 200) {
      throw new Error(`publish failed: ${r.status} ${await r.text()}`);
    }
  }

  it("GET /v1/provenance/manifest/:name/:version returns body + provenance", async () => {
    await publishCargo("acme", "mycrate", "1.0.0", Buffer.from("bytes"));
    const r = await fetch(
      `${base}/v1/provenance/manifest/${encodeURIComponent("cargo/acme/mycrate")}/1.0.0`,
      { headers: { authorization: AUTH } },
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      manifest: Manifest;
      provenance: { source: string; fetchedBy?: string };
    };
    expect(body.manifest.kind).toBe("cargo");
    expect(body.provenance.source).toBe("upload");
    expect(body.provenance.fetchedBy).toBeTruthy();
  });

  it("GET /v1/provenance/manifest/... 404s for unknown manifest", async () => {
    const r = await fetch(
      `${base}/v1/provenance/manifest/nope/1.0.0`,
      { headers: { authorization: AUTH } },
    );
    expect(r.status).toBe(404);
  });

  it("GET /v1/audit returns recent ingest events", async () => {
    await publishCargo("acme", "mycrate", "1.0.0", Buffer.from("bytes"));
    const r = await fetch(`${base}/v1/audit`, {
      headers: { authorization: AUTH },
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      entries: Array<{ action: string; entityType: string }>;
      filters: object;
    };
    expect(body.entries.length).toBeGreaterThan(0);
    expect(body.entries.some((e) => e.action === "upload")).toBe(true);
  });

  it("GET /v1/audit filters by action + entity_type", async () => {
    await publishCargo("acme", "x", "1", Buffer.from("a"));
    await publishCargo("acme", "y", "1", Buffer.from("b"));
    // Yank one
    await fetch(`${base}/cargo/acme/api/v1/crates/x/1/yank`, {
      method: "DELETE",
      headers: { authorization: AUTH },
    });
    const r = await fetch(
      `${base}/v1/audit?action=yank&entity_type=cargo_crate`,
      { headers: { authorization: AUTH } },
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      entries: Array<{ action: string; entityId: string }>;
    };
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0].action).toBe("yank");
    expect(body.entries[0].entityId).toBe("cargo/acme/x@1");
  });

  it("GET /v1/audit rejects malformed since", async () => {
    const r = await fetch(`${base}/v1/audit?since=not-an-iso-date`, {
      headers: { authorization: AUTH },
    });
    expect(r.status).toBe(400);
  });

  it("GET /v1/audit rejects bad limit", async () => {
    const r = await fetch(`${base}/v1/audit?limit=-1`, {
      headers: { authorization: AUTH },
    });
    expect(r.status).toBe(400);
  });

  it("GET /v1/audit clamps limit to max", async () => {
    const r = await fetch(`${base}/v1/audit?limit=999999`, {
      headers: { authorization: AUTH },
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { filters: { limit: number } };
    expect(body.filters.limit).toBe(1000);
  });

  it("GET /v1/forensic/summary rolls up by kind", async () => {
    await publishCargo("acme", "x", "1", Buffer.from("a"));
    await publishCargo("acme", "y", "2", Buffer.from("b"));
    const r = await fetch(`${base}/v1/forensic/summary`, {
      headers: { authorization: AUTH },
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      total_manifests: number;
      by_kind: Record<string, Record<string, number>>;
    };
    expect(body.total_manifests).toBe(2);
    expect(body.by_kind.cargo?.upload).toBe(2);
  });

  it("GET /v1/forensic/upstreams returns proxy_cache counts per upstream", async () => {
    // Seed two proxy_cache manifests with the same upstream
    const sha = (s: string) =>
      crypto.createHash("sha256").update(s).digest("hex");
    await storage.putBlob({
      body: Buffer.from("a"),
      contentType: "application/octet-stream",
    });
    await storage.putBlob({
      body: Buffer.from("b"),
      contentType: "application/octet-stream",
    });
    await storage.putManifest(
      {
        name: "cargo/acme/x",
        version: "1.0.0",
        mediaType: "json",
        kind: "cargo",
        blobs: [{ mediaType: "application/x-tar", sha256: sha("a") }],
        cargoMetadata: {
          name: "x",
          vers: "1.0.0",
          deps: [],
          cksum: sha("a"),
          features: {},
          yanked: false,
        },
        createdAt: "2026-05-15T00:00:00Z",
      },
      {
        source: "proxy_cache",
        upstreamUrl: "https://index.crates.io",
        fetchedAt: "2026-05-15T00:00:00Z",
      },
    );
    await storage.putManifest(
      {
        name: "cargo/acme/y",
        version: "1.0.0",
        mediaType: "json",
        kind: "cargo",
        blobs: [{ mediaType: "application/x-tar", sha256: sha("b") }],
        cargoMetadata: {
          name: "y",
          vers: "1.0.0",
          deps: [],
          cksum: sha("b"),
          features: {},
          yanked: false,
        },
        createdAt: "2026-05-15T00:00:00Z",
      },
      {
        source: "proxy_cache",
        upstreamUrl: "https://index.crates.io",
        fetchedAt: "2026-05-15T00:00:00Z",
      },
    );
    const r = await fetch(`${base}/v1/forensic/upstreams`, {
      headers: { authorization: AUTH },
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      upstreams: Array<{ upstream_url: string; manifest_count: number }>;
    };
    expect(body.upstreams).toEqual([
      { upstream_url: "https://index.crates.io", manifest_count: 2 },
    ]);
  });
});
