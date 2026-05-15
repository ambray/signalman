// WS6 wave-3 M10.4 — cargo virtual-registry pull-through tests.
//
// Coverage:
//   - virtual_upstream CRUD (add idempotent, list filter, remove)
//   - nameMatchesPatterns: allow + deny + default-allow
//   - proxyCargoSparseIndex: cache fill, allow/deny enforcement,
//     upstream error fall-through, dedup (won't re-cache)
//   - proxyCargoDownload: tarball fetch + content-addressed cache
//   - Re-sign on cache: when resign_on_cache + signing key, manifest
//     has an operator Ed25519 signature on read
//   - Audit log records proxy_cache events with upstream_url
//   - Provenance: proxy-cached manifests carry
//     source='proxy_cache' + upstreamUrl
//   - HTTP integration: local-miss + upstream-hit serves NDJSON
//   - HTTP integration: download falls through to upstream

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createServer, type ServerHandle } from "../http/server.js";
import {
  cargoManifestName,
  nameMatchesPatterns,
  proxyCargoDownload,
  proxyCargoSparseIndex,
  type UpstreamFetch,
} from "../cargo/index.js";
import { LocalFsRegistryStorage } from "../storage/registry-storage.js";
import { generateKeypair, verifyManifest } from "../signing.js";
import type { CargoManifestMetadata, Manifest } from "../types.js";

const AUTH = "Bearer sk_TEST_0123456789ABCDEF";

// ── Pattern matching (pure) ────────────────────────────────────────

describe("nameMatchesPatterns", () => {
  it("default (no patterns) allows all", () => {
    expect(nameMatchesPatterns("serde", {})).toBe(true);
    expect(nameMatchesPatterns("tokio-util", {})).toBe(true);
  });

  it("allow_patterns: only listed names pass", () => {
    expect(
      nameMatchesPatterns("serde", { allow_patterns: ["serde", "tokio*"] }),
    ).toBe(true);
    expect(
      nameMatchesPatterns("tokio-util", { allow_patterns: ["serde", "tokio*"] }),
    ).toBe(true);
    expect(
      nameMatchesPatterns("rand", { allow_patterns: ["serde", "tokio*"] }),
    ).toBe(false);
  });

  it("deny_patterns: listed names rejected", () => {
    expect(
      nameMatchesPatterns("internal-tool", {
        deny_patterns: ["internal-*"],
      }),
    ).toBe(false);
    expect(
      nameMatchesPatterns("serde", { deny_patterns: ["internal-*"] }),
    ).toBe(true);
  });

  it("deny wins over allow", () => {
    expect(
      nameMatchesPatterns("internal-secret", {
        allow_patterns: ["*"],
        deny_patterns: ["internal-*"],
      }),
    ).toBe(false);
  });

  it("? matches single char", () => {
    expect(nameMatchesPatterns("rust", { allow_patterns: ["rus?"] })).toBe(true);
    expect(nameMatchesPatterns("rusty", { allow_patterns: ["rus?"] })).toBe(false);
  });
});

// ── Virtual upstream CRUD (storage layer) ──────────────────────────

describe("virtual_upstream CRUD", () => {
  let dataDir: string;
  let storage: LocalFsRegistryStorage;
  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "signalman-vu-crud-"));
    storage = LocalFsRegistryStorage.fromRoot(dataDir);
  });
  afterEach(async () => {
    storage.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  it("add then list returns the row", () => {
    const u = storage.index.addVirtualUpstream({
      org: "acme",
      kind: "cargo",
      upstreamUrl: "https://index.crates.io",
    });
    expect(u.id).toBeTruthy();
    const list = storage.index.listVirtualUpstreams({ org: "acme" });
    expect(list).toHaveLength(1);
    expect(list[0].upstreamUrl).toBe("https://index.crates.io");
  });

  it("add is idempotent on (org, kind, upstream_url)", () => {
    const a = storage.index.addVirtualUpstream({
      org: "acme",
      kind: "cargo",
      upstreamUrl: "https://example.test/cargo",
    });
    const b = storage.index.addVirtualUpstream({
      org: "acme",
      kind: "cargo",
      upstreamUrl: "https://example.test/cargo",
    });
    expect(a.id).toBe(b.id);
  });

  it("list filters by org + kind + includeDisabled", () => {
    storage.index.addVirtualUpstream({
      org: "acme",
      kind: "cargo",
      upstreamUrl: "https://a.test",
    });
    storage.index.addVirtualUpstream({
      org: "acme",
      kind: "npm",
      upstreamUrl: "https://b.test",
    });
    storage.index.addVirtualUpstream({
      org: "beta",
      kind: "cargo",
      upstreamUrl: "https://c.test",
    });
    const cargoAcme = storage.index.listVirtualUpstreams({ org: "acme", kind: "cargo" });
    expect(cargoAcme.map((u) => u.upstreamUrl)).toEqual(["https://a.test"]);
    const allAcme = storage.index.listVirtualUpstreams({ org: "acme" });
    expect(allAcme).toHaveLength(2);
  });

  it("remove deletes the row", () => {
    const u = storage.index.addVirtualUpstream({
      org: "acme",
      kind: "cargo",
      upstreamUrl: "https://a.test",
    });
    storage.index.removeVirtualUpstream(u.id);
    expect(storage.index.getVirtualUpstream(u.id)).toBeNull();
  });

  it("rejects non-http URLs", () => {
    expect(() =>
      storage.index.addVirtualUpstream({
        org: "acme",
        kind: "cargo",
        upstreamUrl: "ftp://example.test",
      }),
    ).toThrow(/http\(s\)/);
  });
});

// ── proxyCargoSparseIndex (with mock upstream) ─────────────────────

describe("proxyCargoSparseIndex", () => {
  let dataDir: string;
  let storage: LocalFsRegistryStorage;
  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "signalman-vu-proxy-"));
    storage = LocalFsRegistryStorage.fromRoot(dataDir);
  });
  afterEach(async () => {
    storage.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  function configureUpstream(
    config: import("../storage/sqlite-index.js").VirtualUpstreamConfig = {},
  ): void {
    storage.index.addVirtualUpstream({
      org: "acme",
      kind: "cargo",
      upstreamUrl: "https://index.example.test",
      config,
    });
  }

  function mockFetch(
    map: Record<string, { status: number; body: string | Buffer }>,
  ): UpstreamFetch {
    return async (url) => {
      const v = map[url];
      if (!v) return { status: 404, headers: {}, body: Buffer.alloc(0) };
      const body = typeof v.body === "string" ? Buffer.from(v.body) : v.body;
      return { status: v.status, headers: {}, body };
    };
  }

  it("caches upstream sparse-index entries on local miss", async () => {
    configureUpstream();
    const fakeMeta: CargoManifestMetadata = {
      name: "tokio",
      vers: "1.0.0",
      deps: [],
      cksum: "a".repeat(64),
      features: {},
      yanked: false,
    };
    const fetcher = mockFetch({
      "https://index.example.test/to/ki/tokio": {
        status: 200,
        body: JSON.stringify(fakeMeta) + "\n",
      },
    });
    const ndjson = await proxyCargoSparseIndex(
      { storage, index: storage.index, fetch: fetcher },
      "acme",
      "tokio",
    );
    expect(ndjson).not.toBeNull();
    const parsed = JSON.parse(ndjson!.trim()) as CargoManifestMetadata;
    expect(parsed.name).toBe("tokio");

    // Cached for next time — local read works
    const m = storage.index.getManifest(cargoManifestName("acme", "tokio"), "1.0.0");
    expect(m?.kind).toBe("cargo");
    expect(m?.cargoMetadata?.cksum).toBe("a".repeat(64));
    const prov = storage.index.getProvenance(
      cargoManifestName("acme", "tokio"),
      "1.0.0",
    );
    expect(prov?.source).toBe("proxy_cache");
    expect(prov?.upstreamUrl).toBe("https://index.example.test");
  });

  it("returns null when no upstream configured", async () => {
    const fetcher = mockFetch({});
    const ndjson = await proxyCargoSparseIndex(
      { storage, index: storage.index, fetch: fetcher },
      "acme",
      "tokio",
    );
    expect(ndjson).toBeNull();
  });

  it("returns null when upstream 404s + does not cache", async () => {
    configureUpstream();
    const fetcher = mockFetch({});
    const ndjson = await proxyCargoSparseIndex(
      { storage, index: storage.index, fetch: fetcher },
      "acme",
      "tokio",
    );
    expect(ndjson).toBeNull();
    const m = storage.index.getManifest(cargoManifestName("acme", "tokio"), "1.0.0");
    expect(m).toBeNull();
  });

  it("honours deny_patterns: blocked names return null", async () => {
    configureUpstream({ deny_patterns: ["internal-*"] });
    const fetcher = mockFetch({
      "https://index.example.test/in/te/internal-secret": {
        status: 200,
        body: JSON.stringify({
          name: "internal-secret",
          vers: "1",
          deps: [],
          cksum: "f".repeat(64),
        }) + "\n",
      },
    });
    const ndjson = await proxyCargoSparseIndex(
      { storage, index: storage.index, fetch: fetcher },
      "acme",
      "internal-secret",
    );
    expect(ndjson).toBeNull();
  });

  it("re-signs cached manifest when resign_on_cache + signing key present", async () => {
    configureUpstream({ resign_on_cache: true });
    const keypair = generateKeypair();
    const fakeMeta: CargoManifestMetadata = {
      name: "tokio",
      vers: "1.0.0",
      deps: [],
      cksum: "a".repeat(64),
      features: {},
      yanked: false,
    };
    const fetcher = mockFetch({
      "https://index.example.test/to/ki/tokio": {
        status: 200,
        body: JSON.stringify(fakeMeta) + "\n",
      },
    });
    await proxyCargoSparseIndex(
      {
        storage,
        index: storage.index,
        fetch: fetcher,
        signingPrivateKeyPem: keypair.privateKeyPem,
      },
      "acme",
      "tokio",
    );
    const m = storage.index.getManifest(cargoManifestName("acme", "tokio"), "1.0.0");
    expect(m?.signature).toBeDefined();
    expect(m?.signature?.signedBy).toBeTruthy();
    // Verify the signature against the operator's public key.
    const canonical = storage.index.getCanonicalBytes(
      cargoManifestName("acme", "tokio"),
      "1.0.0",
    );
    expect(canonical).not.toBeNull();
    expect(verifyManifest(canonical!, m!.signature!, keypair.publicKeyPem)).toBe(true);
  });

  it("audit log records proxy_cache for each cached version", async () => {
    configureUpstream();
    const fetcher = mockFetch({
      "https://index.example.test/to/ki/tokio": {
        status: 200,
        body:
          JSON.stringify({
            name: "tokio",
            vers: "1.0.0",
            deps: [],
            cksum: "a".repeat(64),
            features: {},
            yanked: false,
          }) +
          "\n" +
          JSON.stringify({
            name: "tokio",
            vers: "1.1.0",
            deps: [],
            cksum: "b".repeat(64),
            features: {},
            yanked: false,
          }) +
          "\n",
      },
    });
    await proxyCargoSparseIndex(
      { storage, index: storage.index, fetch: fetcher },
      "acme",
      "tokio",
    );
    const entries = storage.index.listAuditEntries({
      action: "proxy_cache",
      entityType: "cargo_crate",
    });
    expect(entries).toHaveLength(2);
    expect(
      entries.every(
        (e) => (e.detail as { upstream_url: string }).upstream_url === "https://index.example.test",
      ),
    ).toBe(true);
  });

  it("does not re-cache versions already stored locally", async () => {
    configureUpstream();
    const fetcher = mockFetch({
      "https://index.example.test/to/ki/tokio": {
        status: 200,
        body: JSON.stringify({
          name: "tokio",
          vers: "1.0.0",
          deps: [],
          cksum: "a".repeat(64),
          features: {},
          yanked: false,
        }) + "\n",
      },
    });
    await proxyCargoSparseIndex(
      { storage, index: storage.index, fetch: fetcher },
      "acme",
      "tokio",
    );
    await proxyCargoSparseIndex(
      { storage, index: storage.index, fetch: fetcher },
      "acme",
      "tokio",
    );
    // Audit log only has one cargo_crate proxy_cache entry — the
    // second call sees the cached row and skips.
    const cargoEntries = storage.index.listAuditEntries({
      action: "proxy_cache",
      entityType: "cargo_crate",
    });
    expect(cargoEntries).toHaveLength(1);
  });
});

// ── proxyCargoDownload (with mock upstream) ────────────────────────

describe("proxyCargoDownload", () => {
  let dataDir: string;
  let storage: LocalFsRegistryStorage;
  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "signalman-vu-dl-"));
    storage = LocalFsRegistryStorage.fromRoot(dataDir);
    storage.index.addVirtualUpstream({
      org: "acme",
      kind: "cargo",
      upstreamUrl: "https://index.example.test",
    });
  });
  afterEach(async () => {
    storage.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  it("fetches + caches the tarball; sha256 returned", async () => {
    const bytes = Buffer.from("upstream-tarball-bytes");
    const expectedSha = crypto.createHash("sha256").update(bytes).digest("hex");
    const fetcher: UpstreamFetch = async (url) => {
      if (url === "https://index.example.test/tokio/1.0.0/download") {
        return { status: 200, headers: {}, body: bytes };
      }
      return { status: 404, headers: {}, body: Buffer.alloc(0) };
    };
    const result = await proxyCargoDownload(
      { storage, index: storage.index, fetch: fetcher },
      "acme",
      "tokio",
      "1.0.0",
    );
    expect(result).not.toBeNull();
    expect(result!.sha256).toBe(expectedSha);
    expect(result!.bytes.equals(bytes)).toBe(true);

    // Blob is cached
    const stat = await storage.statBlob(expectedSha);
    expect(stat).not.toBeNull();
  });

  it("returns null when upstream 404s", async () => {
    const fetcher: UpstreamFetch = async () => ({
      status: 404,
      headers: {},
      body: Buffer.alloc(0),
    });
    const result = await proxyCargoDownload(
      { storage, index: storage.index, fetch: fetcher },
      "acme",
      "tokio",
      "1.0.0",
    );
    expect(result).toBeNull();
  });
});

// ── HTTP integration: end-to-end pull-through ──────────────────────

describe("cargo virtual-registry HTTP integration", () => {
  let dataDir: string;
  let storage: LocalFsRegistryStorage;
  let server: ServerHandle;
  let base: string;

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "signalman-vu-http-"));
    storage = LocalFsRegistryStorage.fromRoot(dataDir);
    storage.index.addVirtualUpstream({
      org: "acme",
      kind: "cargo",
      upstreamUrl: "https://index.example.test",
    });
    const tarball = Buffer.from("upstream-bytes-v1");
    const cksum = crypto.createHash("sha256").update(tarball).digest("hex");
    const upstreamFetch: UpstreamFetch = async (url) => {
      if (url === "https://index.example.test/to/ki/tokio") {
        const meta = {
          name: "tokio",
          vers: "1.0.0",
          deps: [],
          cksum,
          features: {},
          yanked: false,
        };
        return { status: 200, headers: {}, body: Buffer.from(JSON.stringify(meta) + "\n") };
      }
      if (url === "https://index.example.test/tokio/1.0.0/download") {
        return { status: 200, headers: {}, body: tarball };
      }
      return { status: 404, headers: {}, body: Buffer.alloc(0) };
    };
    server = await createServer({
      storage,
      port: 0,
      auth: { acceptAnyValidShape: true },
      virtualUpstreamFetch: upstreamFetch,
    });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterEach(async () => {
    await server.close();
    storage.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  it("sparse-index miss + upstream hit returns NDJSON", async () => {
    const r = await fetch(`${base}/cargo/acme/index/to/ki/tokio`, {
      headers: { authorization: AUTH },
    });
    expect(r.status).toBe(200);
    const text = await r.text();
    const entry = JSON.parse(text.trim()) as CargoManifestMetadata;
    expect(entry.name).toBe("tokio");
    expect(entry.vers).toBe("1.0.0");
  });

  it("download miss + upstream hit returns tarball bytes", async () => {
    // First touch the sparse index so the manifest gets cached
    await fetch(`${base}/cargo/acme/index/to/ki/tokio`, {
      headers: { authorization: AUTH },
    });
    // Now request download
    const r = await fetch(
      `${base}/cargo/acme/api/v1/crates/tokio/1.0.0/download`,
      { headers: { authorization: AUTH } },
    );
    expect(r.status).toBe(200);
    const bytes = Buffer.from(await r.arrayBuffer());
    expect(bytes.toString("utf-8")).toBe("upstream-bytes-v1");
  });

  it("second call serves from cache (mock upstream not invoked)", async () => {
    let calls = 0;
    await server.close();
    server = await createServer({
      storage,
      port: 0,
      auth: { acceptAnyValidShape: true },
      virtualUpstreamFetch: async (url) => {
        calls += 1;
        if (url === "https://index.example.test/to/ki/tokio") {
          return {
            status: 200,
            headers: {},
            body: Buffer.from(
              JSON.stringify({
                name: "tokio",
                vers: "1.0.0",
                deps: [],
                cksum: "f".repeat(64),
                features: {},
                yanked: false,
              }) + "\n",
            ),
          };
        }
        return { status: 404, headers: {}, body: Buffer.alloc(0) };
      },
    });
    base = `http://127.0.0.1:${server.port}`;
    await fetch(`${base}/cargo/acme/index/to/ki/tokio`, {
      headers: { authorization: AUTH },
    });
    expect(calls).toBe(1);
    // Second sparse-index call hits cache (storage holds the row);
    // upstream not consulted.
    await fetch(`${base}/cargo/acme/index/to/ki/tokio`, {
      headers: { authorization: AUTH },
    });
    expect(calls).toBe(1);
  });
});
