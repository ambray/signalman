// v0.1.1 — npm facade tests.
//
// Coverage:
//   Path helpers:
//     - validateNpmPackageName: scoped + unscoped + reject malformed
//     - validateNpmOrgName
//     - npmManifestName composition
//     - packageFromManifestName inverse
//
//   Publish parser:
//     - parseNpmPublishBody: valid + malformed shapes
//     - publishVersionToStored: field passthrough
//
//   HTTP integration:
//     - PUT /npm/:org/:package: publish round-trip
//     - GET /npm/:org/:package: packument with versions
//     - GET /npm/:org/:package/-/<file>.tgz: tarball download
//     - Scoped packages (@scope/name)
//     - Per-org isolation
//     - Duplicate-publish rejection
//
//   Virtual:
//     - proxyNpmPackument: cache fill, allow/deny, audit log,
//       re-sign on cache
//     - proxyNpmTarball: cache + sha256 verify

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createServer, type ServerHandle } from "../http/server.js";
import {
  npmManifestName,
  packageFromManifestName,
  parseNpmPublishBody,
  publishVersionToStored,
  proxyNpmPackument,
  proxyNpmTarball,
  validateNpmOrgName,
  validateNpmPackageName,
} from "../npm/index.js";
import { LocalFsRegistryStorage } from "../storage/registry-storage.js";
import { generateKeypair } from "../signing.js";
import type { UpstreamFetch } from "../cargo/index.js";

const AUTH = "Bearer sk_TEST_0123456789ABCDEF";

// ── Path helpers ───────────────────────────────────────────────────

describe("npm path helpers", () => {
  it("validateNpmPackageName accepts unscoped", () => {
    expect(() => validateNpmPackageName("express")).not.toThrow();
    expect(() => validateNpmPackageName("lodash")).not.toThrow();
    expect(() => validateNpmPackageName("type-fest")).not.toThrow();
    expect(() => validateNpmPackageName("a")).not.toThrow();
  });

  it("validateNpmPackageName accepts scoped", () => {
    expect(() => validateNpmPackageName("@signalman/host")).not.toThrow();
    expect(() => validateNpmPackageName("@types/node")).not.toThrow();
  });

  it("validateNpmPackageName rejects malformed", () => {
    expect(() => validateNpmPackageName("")).toThrow();
    expect(() => validateNpmPackageName("a".repeat(215))).toThrow();
    expect(() => validateNpmPackageName("../etc/passwd")).toThrow();
    expect(() => validateNpmPackageName("UpperCase")).toThrow();
    expect(() => validateNpmPackageName("with spaces")).toThrow();
  });

  it("validateNpmOrgName accepts lowercase + hyphens", () => {
    expect(() => validateNpmOrgName("acme")).not.toThrow();
    expect(() => validateNpmOrgName("my-team")).not.toThrow();
  });

  it("validateNpmOrgName rejects bad shapes", () => {
    expect(() => validateNpmOrgName("Acme")).toThrow();
    expect(() => validateNpmOrgName("acme.io")).toThrow();
    expect(() => validateNpmOrgName("-acme")).toThrow();
  });

  it("npmManifestName composes storage names (matches npm lowercase invariant)", () => {
    expect(npmManifestName("acme", "express")).toBe("npm/acme/express");
    expect(npmManifestName("acme", "@signalman/host")).toBe("npm/acme/@signalman/host");
  });

  it("packageFromManifestName inverse parses cleanly", () => {
    expect(packageFromManifestName("npm/acme/express")).toEqual({
      org: "acme",
      packageName: "express",
    });
    expect(packageFromManifestName("npm/acme/@signalman/host")).toEqual({
      org: "acme",
      packageName: "@signalman/host",
    });
    expect(packageFromManifestName("cargo/acme/foo")).toBeNull();
  });
});

// ── Publish parser ─────────────────────────────────────────────────

describe("parseNpmPublishBody", () => {
  function buildBody(opts: {
    name: string;
    version: string;
    tarball: Buffer;
    extra?: Record<string, unknown>;
  }): Buffer {
    const body = {
      name: opts.name,
      versions: {
        [opts.version]: {
          name: opts.name,
          version: opts.version,
          ...opts.extra,
        },
      },
      _attachments: {
        [`${opts.name}-${opts.version}.tgz`]: {
          content_type: "application/octet-stream",
          data: opts.tarball.toString("base64"),
          length: opts.tarball.length,
        },
      },
    };
    return Buffer.from(JSON.stringify(body), "utf-8");
  }

  it("parses a valid publish body", () => {
    const tarball = Buffer.from("tarball-bytes");
    const body = buildBody({ name: "mypkg", version: "1.0.0", tarball });
    const parsed = parseNpmPublishBody(body);
    expect(parsed.version.name).toBe("mypkg");
    expect(parsed.version.version).toBe("1.0.0");
    expect(parsed.tarball.equals(tarball)).toBe(true);
    expect(parsed.attachmentName).toBe("mypkg-1.0.0.tgz");
  });

  it("rejects non-JSON body", () => {
    expect(() => parseNpmPublishBody(Buffer.from("not json"))).toThrow(/not valid JSON/);
  });

  it("rejects missing name", () => {
    expect(() =>
      parseNpmPublishBody(Buffer.from(JSON.stringify({ versions: {}, _attachments: {} }))),
    ).toThrow(/name/);
  });

  it("rejects multi-version publish", () => {
    const body = {
      name: "mypkg",
      versions: {
        "1.0.0": { name: "mypkg", version: "1.0.0" },
        "1.1.0": { name: "mypkg", version: "1.1.0" },
      },
      _attachments: {},
    };
    expect(() => parseNpmPublishBody(Buffer.from(JSON.stringify(body)))).toThrow(
      /exactly one version/,
    );
  });

  it("rejects name mismatch between top-level + version", () => {
    const body = {
      name: "mypkg",
      versions: { "1.0.0": { name: "different", version: "1.0.0" } },
      _attachments: { "x.tgz": { data: "" } },
    };
    expect(() => parseNpmPublishBody(Buffer.from(JSON.stringify(body)))).toThrow(/must match/);
  });

  it("rejects missing _attachments", () => {
    const body = {
      name: "mypkg",
      versions: { "1.0.0": { name: "mypkg", version: "1.0.0" } },
    };
    expect(() => parseNpmPublishBody(Buffer.from(JSON.stringify(body)))).toThrow(
      /_attachments/,
    );
  });

  it("rejects attachment-length mismatch", () => {
    const tarball = Buffer.from("real");
    const body = {
      name: "mypkg",
      versions: { "1.0.0": { name: "mypkg", version: "1.0.0" } },
      _attachments: {
        "mypkg-1.0.0.tgz": {
          data: tarball.toString("base64"),
          length: 999, // wrong
        },
      },
    };
    expect(() => parseNpmPublishBody(Buffer.from(JSON.stringify(body)))).toThrow(
      /mismatches decoded/,
    );
  });
});

describe("publishVersionToStored", () => {
  it("passes through declared fields", () => {
    const meta = publishVersionToStored(
      {
        name: "express",
        version: "4.18.0",
        dependencies: { qs: "6.10.0" },
        license: "MIT",
        keywords: ["http", "web"],
      },
      "sha1-abc",
      "sha512-xyz",
    );
    expect(meta.name).toBe("express");
    expect(meta.version).toBe("4.18.0");
    expect(meta.shasum).toBe("sha1-abc");
    expect(meta.integrity).toBe("sha512-xyz");
    expect(meta.dependencies).toEqual({ qs: "6.10.0" });
    expect(meta.license).toBe("MIT");
    expect(meta.keywords).toEqual(["http", "web"]);
  });
});

// ── HTTP integration ───────────────────────────────────────────────

describe("npm HTTP integration", () => {
  let dataDir: string;
  let storage: LocalFsRegistryStorage;
  let server: ServerHandle;
  let base: string;

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "signalman-npm-"));
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

  function buildPublishBody(
    name: string,
    version: string,
    tarball: Buffer,
    extra: Record<string, unknown> = {},
  ): Buffer {
    return Buffer.from(
      JSON.stringify({
        name,
        versions: {
          [version]: { name, version, ...extra },
        },
        _attachments: {
          [`${name}-${version}.tgz`]: {
            content_type: "application/octet-stream",
            data: tarball.toString("base64"),
            length: tarball.length,
          },
        },
      }),
      "utf-8",
    );
  }

  it("publishes + reads packument + downloads tarball", async () => {
    const tarball = Buffer.from("tgz-bytes-v1");
    const pub = await fetch(`${base}/npm/acme/mypkg`, {
      method: "PUT",
      headers: { authorization: AUTH, "content-type": "application/json" },
      body: buildPublishBody("mypkg", "1.0.0", tarball, {
        dependencies: { lodash: "4.17.0" },
      }),
    });
    expect(pub.status).toBe(201);

    // Packument
    const pkg = await fetch(`${base}/npm/acme/mypkg`, {
      headers: { authorization: AUTH },
    });
    expect(pkg.status).toBe(200);
    const body = (await pkg.json()) as {
      name: string;
      "dist-tags": { latest: string };
      versions: Record<string, { dist: { tarball: string; integrity: string } }>;
    };
    expect(body.name).toBe("mypkg");
    expect(body["dist-tags"].latest).toBe("1.0.0");
    expect(body.versions["1.0.0"].dist.integrity).toMatch(/^sha512-/);
    expect(body.versions["1.0.0"].dist.tarball).toContain("/npm/acme/mypkg/-/mypkg-1.0.0.tgz");

    // Tarball
    const tgz = await fetch(`${base}/npm/acme/mypkg/-/mypkg-1.0.0.tgz`, {
      headers: { authorization: AUTH },
    });
    expect(tgz.status).toBe(200);
    const got = Buffer.from(await tgz.arrayBuffer());
    expect(got.equals(tarball)).toBe(true);
  });

  it("scoped packages work end-to-end", async () => {
    const tarball = Buffer.from("scoped-bytes");
    const pub = await fetch(
      `${base}/npm/acme/${encodeURIComponent("@signalman/host")}`,
      {
        method: "PUT",
        headers: { authorization: AUTH, "content-type": "application/json" },
        body: buildPublishBody("@signalman/host", "0.1.0", tarball),
      },
    );
    expect(pub.status).toBe(201);

    const pkg = await fetch(
      `${base}/npm/acme/${encodeURIComponent("@signalman/host")}`,
      { headers: { authorization: AUTH } },
    );
    expect(pkg.status).toBe(200);
    const body = (await pkg.json()) as {
      name: string;
      versions: Record<string, { dist: { tarball: string } }>;
    };
    expect(body.name).toBe("@signalman/host");
    expect(body.versions["0.1.0"].dist.tarball).toContain("host-0.1.0.tgz");

    // Download — tarball URL uses basename
    const tgz = await fetch(
      `${base}/npm/acme/${encodeURIComponent("@signalman/host")}/-/host-0.1.0.tgz`,
      { headers: { authorization: AUTH } },
    );
    expect(tgz.status).toBe(200);
    const got = Buffer.from(await tgz.arrayBuffer());
    expect(got.equals(tarball)).toBe(true);
  });

  it("404 for unknown package", async () => {
    const r = await fetch(`${base}/npm/acme/nope`, {
      headers: { authorization: AUTH },
    });
    expect(r.status).toBe(404);
  });

  it("404 for unknown version", async () => {
    await fetch(`${base}/npm/acme/x`, {
      method: "PUT",
      headers: { authorization: AUTH, "content-type": "application/json" },
      body: buildPublishBody("x", "1.0.0", Buffer.from("a")),
    });
    const r = await fetch(`${base}/npm/acme/x/-/x-2.0.0.tgz`, {
      headers: { authorization: AUTH },
    });
    expect(r.status).toBe(404);
  });

  it("duplicate publish rejected", async () => {
    const t1 = Buffer.from("first");
    const t2 = Buffer.from("second");
    const r1 = await fetch(`${base}/npm/acme/x`, {
      method: "PUT",
      headers: { authorization: AUTH, "content-type": "application/json" },
      body: buildPublishBody("x", "1.0.0", t1),
    });
    expect(r1.status).toBe(201);
    const r2 = await fetch(`${base}/npm/acme/x`, {
      method: "PUT",
      headers: { authorization: AUTH, "content-type": "application/json" },
      body: buildPublishBody("x", "1.0.0", t2),
    });
    expect(r2.status).toBeGreaterThanOrEqual(400);
    expect(r2.status).toBeLessThan(500);
  });

  it("per-org isolation", async () => {
    await fetch(`${base}/npm/acme/shared`, {
      method: "PUT",
      headers: { authorization: AUTH, "content-type": "application/json" },
      body: buildPublishBody("shared", "1.0.0", Buffer.from("acme-bytes")),
    });
    await fetch(`${base}/npm/beta/shared`, {
      method: "PUT",
      headers: { authorization: AUTH, "content-type": "application/json" },
      body: buildPublishBody("shared", "2.0.0", Buffer.from("beta-bytes")),
    });
    const acmePkg = (await (await fetch(`${base}/npm/acme/shared`, {
      headers: { authorization: AUTH },
    })).json()) as { "dist-tags": { latest: string } };
    expect(acmePkg["dist-tags"].latest).toBe("1.0.0");
    const betaPkg = (await (await fetch(`${base}/npm/beta/shared`, {
      headers: { authorization: AUTH },
    })).json()) as { "dist-tags": { latest: string } };
    expect(betaPkg["dist-tags"].latest).toBe("2.0.0");
  });

  it("audit log records 'upload' on publish", async () => {
    await fetch(`${base}/npm/acme/x`, {
      method: "PUT",
      headers: { authorization: AUTH, "content-type": "application/json" },
      body: buildPublishBody("x", "1.0.0", Buffer.from("bytes")),
    });
    const entries = storage.index.listAuditEntries({
      action: "upload",
      entityType: "manifest",
    });
    expect(entries).toHaveLength(1);
    expect(entries[0].entityId).toBe("npm/acme/x@1.0.0");
    expect((entries[0].detail as { kind: string }).kind).toBe("npm");
  });

  it("provenance after publish: source='upload'", async () => {
    await fetch(`${base}/npm/acme/x`, {
      method: "PUT",
      headers: { authorization: AUTH, "content-type": "application/json" },
      body: buildPublishBody("x", "1.0.0", Buffer.from("bytes")),
    });
    const prov = storage.index.getProvenance("npm/acme/x", "1.0.0");
    expect(prov?.source).toBe("upload");
    expect(prov?.fetchedBy).toBeTruthy();
  });

  it("oversized publish refused", async () => {
    // 51 MiB > 50 MiB default cap
    const big = Buffer.alloc(51 * 1024 * 1024);
    let refused = false;
    try {
      const r = await fetch(`${base}/npm/acme/big`, {
        method: "PUT",
        headers: { authorization: AUTH, "content-type": "application/json" },
        body: buildPublishBody("big", "1", big),
      });
      refused = r.status >= 400;
    } catch {
      refused = true;
    }
    expect(refused).toBe(true);
  });

  it("publish: body name must match URL path", async () => {
    const r = await fetch(`${base}/npm/acme/expected`, {
      method: "PUT",
      headers: { authorization: AUTH, "content-type": "application/json" },
      body: buildPublishBody("different", "1.0.0", Buffer.from("x")),
    });
    expect(r.status).toBe(400);
  });

  it("non-npm manifest at npm path returns bad_manifest on download", async () => {
    // Direct PUT a non-npm manifest under the npm namespace
    const tarball = Buffer.from("bytes");
    const sha = crypto.createHash("sha256").update(tarball).digest("hex");
    await fetch(`${base}/v1/blobs/${sha}`, {
      method: "PUT",
      headers: { authorization: AUTH, "content-type": "application/octet-stream" },
      body: tarball,
    });
    await fetch(
      `${base}/v1/manifests/${encodeURIComponent("npm/acme/notnpm")}/1.0.0`,
      {
        method: "PUT",
        headers: { authorization: AUTH, "content-type": "application/json" },
        body: JSON.stringify({
          name: "npm/acme/notnpm",
          version: "1.0.0",
          mediaType: "application/octet-stream",
          // No `kind: "npm"`, so this is a generic manifest at an
          // npm-shaped path
          blobs: [{ mediaType: "application/octet-stream", sha256: sha }],
          createdAt: "2026-05-15T12:00:00.000Z",
        }),
      },
    );
    const r = await fetch(`${base}/npm/acme/notnpm/-/notnpm-1.0.0.tgz`, {
      headers: { authorization: AUTH },
    });
    expect(r.status).toBe(404);
    const err = (await r.json()) as { error: { code: string } };
    expect(err.error.code).toBe("bad_manifest");
  });
});

describe("npm HTTP with virtual upstream", () => {
  let dataDir: string;
  let storage: LocalFsRegistryStorage;
  let server: ServerHandle;
  let base: string;

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "signalman-npm-vh-"));
    storage = LocalFsRegistryStorage.fromRoot(dataDir);
    storage.index.addVirtualUpstream({
      org: "acme",
      kind: "npm",
      upstreamUrl: "https://registry.example.test",
    });
    const integrity = "sha512-" + Buffer.from("c".repeat(64)).toString("base64");
    const tarball = Buffer.from("upstream-bytes-v1");
    const fetcher: UpstreamFetch = async (url) => {
      if (url === "https://registry.example.test/express") {
        return {
          status: 200,
          headers: {},
          body: Buffer.from(
            JSON.stringify({
              name: "express",
              versions: {
                "4.18.0": {
                  name: "express",
                  version: "4.18.0",
                  dist: { integrity },
                },
              },
            }),
          ),
        };
      }
      if (url === "https://registry.example.test/express/-/express-4.18.0.tgz") {
        return { status: 200, headers: {}, body: tarball };
      }
      return { status: 404, headers: {}, body: Buffer.alloc(0) };
    };
    server = await createServer({
      storage,
      port: 0,
      auth: { acceptAnyValidShape: true },
      virtualUpstreamFetch: fetcher,
    });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterEach(async () => {
    await server.close();
    storage.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  it("packument miss + upstream hit returns aggregated JSON", async () => {
    const r = await fetch(`${base}/npm/acme/express`, {
      headers: { authorization: AUTH },
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      name: string;
      versions: Record<string, unknown>;
    };
    expect(body.name).toBe("express");
    expect(body.versions["4.18.0"]).toBeDefined();
  });

  it("tarball miss + upstream hit returns bytes", async () => {
    // First touch the packument so the manifest is cached
    await fetch(`${base}/npm/acme/express`, {
      headers: { authorization: AUTH },
    });
    const tgz = await fetch(`${base}/npm/acme/express/-/express-4.18.0.tgz`, {
      headers: { authorization: AUTH },
    });
    expect(tgz.status).toBe(200);
    const got = Buffer.from(await tgz.arrayBuffer());
    expect(got.toString("utf-8")).toBe("upstream-bytes-v1");
  });
});

// ── Virtual pull-through ───────────────────────────────────────────

describe("npm virtual pull-through", () => {
  let dataDir: string;
  let storage: LocalFsRegistryStorage;

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "signalman-npm-virtual-"));
    storage = LocalFsRegistryStorage.fromRoot(dataDir);
    storage.index.addVirtualUpstream({
      org: "acme",
      kind: "npm",
      upstreamUrl: "https://registry.example.test",
    });
  });

  afterEach(async () => {
    storage.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  it("caches an upstream packument + serves locally", async () => {
    const integrity = "sha512-" + Buffer.from("a".repeat(64)).toString("base64");
    const upstreamPackument = {
      name: "express",
      versions: {
        "4.18.0": {
          name: "express",
          version: "4.18.0",
          dependencies: { qs: "6.10.0" },
          dist: { integrity, shasum: "abc123" },
        },
      },
    };
    const fetcher: UpstreamFetch = async (url) => {
      if (url === "https://registry.example.test/express") {
        return { status: 200, headers: {}, body: Buffer.from(JSON.stringify(upstreamPackument)) };
      }
      return { status: 404, headers: {}, body: Buffer.alloc(0) };
    };
    const result = await proxyNpmPackument(
      { storage, index: storage.index, fetch: fetcher },
      "acme",
      "express",
    );
    expect(result).not.toBeNull();
    const parsed = JSON.parse(result!) as {
      name: string;
      versions: Record<string, { name: string }>;
    };
    expect(parsed.name).toBe("express");
    expect(parsed.versions["4.18.0"].name).toBe("express");

    // Cached locally
    const stored = storage.index.getManifest("npm/acme/express", "4.18.0");
    expect(stored?.kind).toBe("npm");
    expect(stored?.npmMetadata?.integrity).toBe(integrity);
    const prov = storage.index.getProvenance("npm/acme/express", "4.18.0");
    expect(prov?.source).toBe("proxy_cache");
    expect(prov?.upstreamUrl).toBe("https://registry.example.test");
  });

  it("returns null when no upstream configured", async () => {
    const storage2 = LocalFsRegistryStorage.fromRoot(
      await fs.mkdtemp(path.join(os.tmpdir(), "signalman-no-up-")),
    );
    const result = await proxyNpmPackument(
      { storage: storage2, index: storage2.index, fetch: async () => ({ status: 404, headers: {}, body: Buffer.alloc(0) }) },
      "acme",
      "express",
    );
    expect(result).toBeNull();
    storage2.close();
  });

  it("upstream 404 returns null + no cache", async () => {
    const fetcher: UpstreamFetch = async () => ({ status: 404, headers: {}, body: Buffer.alloc(0) });
    const result = await proxyNpmPackument(
      { storage, index: storage.index, fetch: fetcher },
      "acme",
      "express",
    );
    expect(result).toBeNull();
    expect(storage.index.getManifest("npm/acme/express", "4.18.0")).toBeNull();
  });

  it("deny_patterns blocks upstream lookup", async () => {
    storage.index.addVirtualUpstream({
      org: "beta",
      kind: "npm",
      upstreamUrl: "https://registry.example.test",
      config: { deny_patterns: ["@internal/*"] },
    });
    let called = false;
    const fetcher: UpstreamFetch = async () => {
      called = true;
      return { status: 200, headers: {}, body: Buffer.alloc(0) };
    };
    const result = await proxyNpmPackument(
      { storage, index: storage.index, fetch: fetcher },
      "beta",
      "@internal/secret",
    );
    expect(result).toBeNull();
    expect(called).toBe(false);
  });

  it("re-signs cached manifest when resign_on_cache + key present", async () => {
    storage.index.addVirtualUpstream({
      org: "gamma",
      kind: "npm",
      upstreamUrl: "https://registry.example.test",
      config: { resign_on_cache: true },
    });
    const keypair = generateKeypair();
    const integrity = "sha512-" + Buffer.from("b".repeat(64)).toString("base64");
    const fetcher: UpstreamFetch = async (url) => {
      if (url === "https://registry.example.test/express") {
        return {
          status: 200,
          headers: {},
          body: Buffer.from(
            JSON.stringify({
              name: "express",
              versions: {
                "4.18.0": {
                  name: "express",
                  version: "4.18.0",
                  dist: { integrity },
                },
              },
            }),
          ),
        };
      }
      return { status: 404, headers: {}, body: Buffer.alloc(0) };
    };
    await proxyNpmPackument(
      {
        storage,
        index: storage.index,
        fetch: fetcher,
        signingPrivateKeyPem: keypair.privateKeyPem,
      },
      "gamma",
      "express",
    );
    const cached = storage.index.getManifest("npm/gamma/express", "4.18.0");
    expect(cached?.signature).toBeDefined();
  });

  it("proxyNpmTarball fetches + caches the bytes", async () => {
    const tarball = Buffer.from("upstream-tarball");
    const expectedSha = crypto.createHash("sha256").update(tarball).digest("hex");
    const fetcher: UpstreamFetch = async (url) => {
      if (url.endsWith("/express/-/express-4.18.0.tgz")) {
        return { status: 200, headers: {}, body: tarball };
      }
      return { status: 404, headers: {}, body: Buffer.alloc(0) };
    };
    const result = await proxyNpmTarball(
      { storage, index: storage.index, fetch: fetcher },
      "acme",
      "express",
      "4.18.0",
    );
    expect(result).not.toBeNull();
    expect(result!.sha256).toBe(expectedSha);
    expect(result!.bytes.equals(tarball)).toBe(true);
    const stat = await storage.statBlob(expectedSha);
    expect(stat).not.toBeNull();
  });

  it("integrity-as-sha256 produces a content-addressed blob sha", async () => {
    // When upstream uses sha256 integrity, the blob sha derives
    // directly from it (vs the synthetic-hash fallback for sha512).
    const sha256Bytes = "a".repeat(32);
    const sha256B64 = Buffer.from(sha256Bytes).toString("base64");
    const integrity = `sha256-${sha256B64}`;
    const fetcher: UpstreamFetch = async () => ({
      status: 200,
      headers: {},
      body: Buffer.from(
        JSON.stringify({
          name: "express",
          versions: {
            "4.18.0": { name: "express", version: "4.18.0", dist: { integrity } },
          },
        }),
      ),
    });
    const result = await proxyNpmPackument(
      { storage, index: storage.index, fetch: fetcher },
      "acme",
      "express",
    );
    expect(result).not.toBeNull();
    const m = storage.index.getManifest("npm/acme/express", "4.18.0");
    expect(m?.blobs[0]?.sha256).toBe(Buffer.from(sha256Bytes).toString("hex"));
  });

  it("upstream version without integrity is skipped", async () => {
    const fetcher: UpstreamFetch = async () => ({
      status: 200,
      headers: {},
      body: Buffer.from(
        JSON.stringify({
          name: "express",
          versions: {
            "4.18.0": { name: "express", version: "4.18.0", dist: {} },
          },
        }),
      ),
    });
    const result = await proxyNpmPackument(
      { storage, index: storage.index, fetch: fetcher },
      "acme",
      "express",
    );
    expect(result).toBeNull();
  });

  it("upstream fetch error is logged + returns null", async () => {
    const fetcher: UpstreamFetch = async () => {
      throw new Error("network down");
    };
    const result = await proxyNpmPackument(
      { storage, index: storage.index, fetch: fetcher },
      "acme",
      "express",
    );
    expect(result).toBeNull();
    const entries = storage.index.listAuditEntries({
      action: "proxy_cache",
      entityType: "virtual_upstream",
    });
    expect(entries.some((e) => (e.detail as { phase: string }).phase === "fetch_error")).toBe(true);
  });

  it("upstream non-JSON body is rejected", async () => {
    const fetcher: UpstreamFetch = async () => ({
      status: 200,
      headers: {},
      body: Buffer.from("<html>not json</html>"),
    });
    const result = await proxyNpmPackument(
      { storage, index: storage.index, fetch: fetcher },
      "acme",
      "express",
    );
    expect(result).toBeNull();
  });

  it("proxyNpmTarball returns null when no upstream covers org", async () => {
    const result = await proxyNpmTarball(
      { storage, index: storage.index, fetch: async () => ({ status: 200, headers: {}, body: Buffer.alloc(0) }) },
      "no-org",
      "express",
      "4.18.0",
    );
    expect(result).toBeNull();
  });

  it("proxyNpmTarball 404 fall-through returns null", async () => {
    const result = await proxyNpmTarball(
      { storage, index: storage.index, fetch: async () => ({ status: 404, headers: {}, body: Buffer.alloc(0) }) },
      "acme",
      "express",
      "4.18.0",
    );
    expect(result).toBeNull();
  });

  it("audit log records proxy_cache on packument cache", async () => {
    const integrity = "sha512-" + Buffer.from("a".repeat(64)).toString("base64");
    const fetcher: UpstreamFetch = async () => ({
      status: 200,
      headers: {},
      body: Buffer.from(
        JSON.stringify({
          name: "express",
          versions: {
            "4.18.0": { name: "express", version: "4.18.0", dist: { integrity } },
          },
        }),
      ),
    });
    await proxyNpmPackument(
      { storage, index: storage.index, fetch: fetcher },
      "acme",
      "express",
    );
    const entries = storage.index.listAuditEntries({
      action: "proxy_cache",
      entityType: "manifest",
    });
    expect(entries.length).toBeGreaterThan(0);
    const e = entries[0];
    expect((e.detail as { kind: string }).kind).toBe("npm");
    expect((e.detail as { upstream_url: string }).upstream_url).toBe(
      "https://registry.example.test",
    );
  });
});
