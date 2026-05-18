// WS13 M4 Story 5 — virtual upstream pull-through (resolve / Batch / revision).

import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalFsRegistryStorage } from "../storage/registry-storage.js";
import {
  composeLfsPointer,
  hfManifestName,
  hfManifestVersion,
  proxyHfLfsBatch,
  proxyHfResolve,
  proxyHfRevision,
} from "../hf/index.js";
import type { UpstreamFetch } from "../cargo/index.js";

function sha256Hex(b: Buffer): string {
  return crypto.createHash("sha256").update(b).digest("hex");
}

function makeStub(impl: (url: string, init?: { method?: string; body?: string; headers?: Record<string, string> }) => { status: number; body: Buffer; headers?: Record<string, string> } | Promise<{ status: number; body: Buffer; headers?: Record<string, string> }>): UpstreamFetch {
  return async (url, init) => {
    const out = await impl(url, init);
    return { status: out.status, body: out.body, headers: out.headers ?? {} };
  };
}

describe("proxyHfRevision", () => {
  let root: string;
  let storage: LocalFsRegistryStorage;
  const ORG = "acme";
  const REPO = "demo-model";

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "hf-virt-"));
    storage = LocalFsRegistryStorage.fromRoot(root);
    storage.index.addVirtualUpstream({
      org: ORG,
      kind: "huggingface",
      upstreamUrl: "https://huggingface.co",
      config: {},
    });
  });

  afterEach(async () => {
    storage.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("populates hf_revision from upstream tree listing", async () => {
    const fetchStub = makeStub((url) => {
      if (url.endsWith(`/api/models/${ORG}/${REPO}/tree/v1`)) {
        return {
          status: 200,
          body: Buffer.from(
            JSON.stringify([
              {
                type: "file",
                path: "config.json",
                size: 42,
              },
              {
                type: "file",
                path: "weights.bin",
                size: 200_000_000,
                lfs: { oid: `sha256:${"a".repeat(64)}`, size: 200_000_000 },
              },
              { type: "directory", path: "subdir" },
            ]),
          ),
        };
      }
      return { status: 404, body: Buffer.alloc(0) };
    });
    const ok = await proxyHfRevision(
      { storage, index: storage.index, fetch: fetchStub },
      ORG,
      REPO,
      "model",
      "v1",
    );
    expect(ok).toBe(true);
    const rev = storage.index.getHfRevision(ORG, REPO, "model", "v1");
    expect(rev?.files.length).toBe(2);
    expect(rev?.files[1].lfs).toBe(true);
  });

  it("returns false when no upstreams are configured", async () => {
    storage.index.listVirtualUpstreams({ org: "other" });
    const ok = await proxyHfRevision(
      { storage, index: storage.index },
      "other",
      REPO,
      "model",
      "v1",
    );
    expect(ok).toBe(false);
  });

  it("audits a fetch_error + continues to the next upstream", async () => {
    const fetchStub: UpstreamFetch = async () => {
      throw new Error("network blip");
    };
    const ok = await proxyHfRevision(
      { storage, index: storage.index, fetch: fetchStub },
      ORG,
      REPO,
      "model",
      "v1",
    );
    expect(ok).toBe(false);
    const audit = storage.index.listAuditEntries({ action: "proxy_cache" });
    expect(audit.some((e) => e.detail?.phase === "metadata_fetch_error")).toBe(true);
  });

  it("audits an upstream 4XX response", async () => {
    const fetchStub = makeStub(() => ({ status: 500, body: Buffer.alloc(0) }));
    const ok = await proxyHfRevision(
      { storage, index: storage.index, fetch: fetchStub },
      ORG,
      REPO,
      "model",
      "v1",
    );
    expect(ok).toBe(false);
    const audit = storage.index.listAuditEntries({ action: "proxy_cache" });
    expect(audit.some((e) => e.detail?.phase === "metadata_upstream_error")).toBe(true);
  });

  it("continues past upstream 404", async () => {
    const fetchStub = makeStub(() => ({ status: 404, body: Buffer.alloc(0) }));
    const ok = await proxyHfRevision(
      { storage, index: storage.index, fetch: fetchStub },
      ORG,
      REPO,
      "model",
      "v1",
    );
    expect(ok).toBe(false);
  });

  it("rejects an empty tree response", async () => {
    const fetchStub = makeStub(() => ({ status: 200, body: Buffer.from("[]") }));
    const ok = await proxyHfRevision(
      { storage, index: storage.index, fetch: fetchStub },
      ORG,
      REPO,
      "model",
      "v1",
    );
    expect(ok).toBe(false);
    const audit = storage.index.listAuditEntries({ action: "proxy_cache" });
    expect(audit.some((e) => e.detail?.phase === "metadata_empty_tree")).toBe(true);
  });

  it("audits a parse error on malformed JSON", async () => {
    const fetchStub = makeStub(() => ({ status: 200, body: Buffer.from("not-json") }));
    const ok = await proxyHfRevision(
      { storage, index: storage.index, fetch: fetchStub },
      ORG,
      REPO,
      "model",
      "v1",
    );
    expect(ok).toBe(false);
    const audit = storage.index.listAuditEntries({ action: "proxy_cache" });
    expect(audit.some((e) => e.detail?.phase === "metadata_parse_error")).toBe(true);
  });
});

describe("proxyHfResolve", () => {
  let root: string;
  let storage: LocalFsRegistryStorage;
  const ORG = "acme";
  const REPO = "demo-model";

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "hf-virt-"));
    storage = LocalFsRegistryStorage.fromRoot(root);
    storage.index.addVirtualUpstream({
      org: ORG,
      kind: "huggingface",
      upstreamUrl: "https://huggingface.co",
      config: {},
    });
  });

  afterEach(async () => {
    storage.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("fetches + caches a non-LFS file", async () => {
    const body = Buffer.from('{"hidden":768}');
    const fetchStub = makeStub((url) => {
      if (url.includes("/resolve/v1/config.json")) {
        return { status: 200, body };
      }
      return { status: 404, body: Buffer.alloc(0) };
    });
    const ok = await proxyHfResolve(
      { storage, index: storage.index, fetch: fetchStub },
      ORG,
      REPO,
      "model",
      "v1",
      "config.json",
    );
    expect(ok).toBe(true);
    const m = await storage.getManifest(
      hfManifestName(ORG, REPO, "model"),
      hfManifestVersion("v1", "config.json"),
    );
    expect(m?.hfMetadata?.sha256).toBe(sha256Hex(body));
    expect(m?.hfMetadata?.lfs).toBe(false);
    const rev = storage.index.getHfRevision(ORG, REPO, "model", "v1");
    expect(rev?.files.find((f) => f.path === "config.json")).toBeDefined();
  });

  it("fetches + caches LFS bytes via the Batch API", async () => {
    const weights = Buffer.alloc(10 * 1024 * 1024, 0x42);
    const wHex = sha256Hex(weights);
    const pointer = composeLfsPointer(wHex, weights.length);
    const fetchStub = makeStub((url) => {
      if (url.endsWith("/resolve/v1/weights.bin")) {
        return { status: 200, body: pointer };
      }
      if (url.endsWith(".git/info/lfs/objects/batch")) {
        return {
          status: 200,
          body: Buffer.from(
            JSON.stringify({
              transfer: "basic",
              objects: [
                {
                  oid: `sha256:${wHex}`,
                  size: weights.length,
                  actions: {
                    download: {
                      href: "https://lfs.example/object/weights",
                    },
                  },
                },
              ],
            }),
          ),
        };
      }
      if (url === "https://lfs.example/object/weights") {
        return { status: 200, body: weights };
      }
      return { status: 404, body: Buffer.alloc(0) };
    });
    const ok = await proxyHfResolve(
      { storage, index: storage.index, fetch: fetchStub },
      ORG,
      REPO,
      "model",
      "v1",
      "weights.bin",
    );
    expect(ok).toBe(true);
    const m = await storage.getManifest(
      hfManifestName(ORG, REPO, "model"),
      hfManifestVersion("v1", "weights.bin"),
    );
    expect(m?.hfMetadata?.lfs).toBe(true);
    expect(m?.hfMetadata?.lfsOid).toBe(`sha256:${wHex}`);
  });

  it("forwards Bearer auth to upstream + redacts in the audit log", async () => {
    storage.close();
    await fs.rm(root, { recursive: true, force: true });
    root = await fs.mkdtemp(path.join(os.tmpdir(), "hf-virt-"));
    storage = LocalFsRegistryStorage.fromRoot(root);
    storage.index.addVirtualUpstream({
      org: ORG,
      kind: "huggingface",
      upstreamUrl: "https://huggingface.co",
      config: { auth_header_template: "Bearer hf_SECRET_pat_67890_xyz" },
    });
    const body = Buffer.from("private content");
    let sawAuth = false;
    const fetchStub = makeStub((url, init) => {
      if (init?.headers?.authorization === "Bearer hf_SECRET_pat_67890_xyz") {
        sawAuth = true;
      }
      if (url.includes("/resolve/v1/private.json")) {
        return { status: 200, body };
      }
      return { status: 404, body: Buffer.alloc(0) };
    });
    const ok = await proxyHfResolve(
      { storage, index: storage.index, fetch: fetchStub },
      ORG,
      REPO,
      "model",
      "v1",
      "private.json",
    );
    expect(ok).toBe(true);
    expect(sawAuth).toBe(true);
    const audit = storage.index.listAuditEntries({ action: "proxy_cache" });
    const json = JSON.stringify(audit);
    expect(json).not.toContain("hf_SECRET_pat_67890_xyz");
  });

  it("returns false on upstream 404 (cache miss propagation)", async () => {
    const fetchStub = makeStub(() => ({ status: 404, body: Buffer.alloc(0) }));
    const ok = await proxyHfResolve(
      { storage, index: storage.index, fetch: fetchStub },
      ORG,
      REPO,
      "model",
      "v1",
      "missing.json",
    );
    expect(ok).toBe(false);
  });

  it("audits an upstream 500", async () => {
    const fetchStub = makeStub(() => ({ status: 500, body: Buffer.alloc(0) }));
    const ok = await proxyHfResolve(
      { storage, index: storage.index, fetch: fetchStub },
      ORG,
      REPO,
      "model",
      "v1",
      "x.json",
    );
    expect(ok).toBe(false);
    const audit = storage.index.listAuditEntries({ action: "proxy_cache" });
    expect(audit.some((e) => e.detail?.phase === "resolve_upstream_error")).toBe(true);
  });

  it("returns false when LFS Batch response lacks a download action", async () => {
    const weights = Buffer.alloc(10 * 1024 * 1024, 0x42);
    const wHex = sha256Hex(weights);
    const pointer = composeLfsPointer(wHex, weights.length);
    const fetchStub = makeStub((url) => {
      if (url.endsWith("/resolve/v1/weights.bin")) {
        return { status: 200, body: pointer };
      }
      if (url.endsWith(".git/info/lfs/objects/batch")) {
        return {
          status: 200,
          body: Buffer.from(
            JSON.stringify({
              transfer: "basic",
              objects: [{ oid: `sha256:${wHex}`, size: weights.length, error: { code: 404, message: "no" } }],
            }),
          ),
        };
      }
      return { status: 404, body: Buffer.alloc(0) };
    });
    const ok = await proxyHfResolve(
      { storage, index: storage.index, fetch: fetchStub },
      ORG,
      REPO,
      "model",
      "v1",
      "weights.bin",
    );
    expect(ok).toBe(false);
  });

  it("returns false on Batch JSON parse error", async () => {
    const weights = Buffer.alloc(10, 0x42);
    const wHex = sha256Hex(weights);
    const pointer = composeLfsPointer(wHex, weights.length);
    const fetchStub = makeStub((url) => {
      if (url.endsWith("/resolve/v1/weights.bin")) {
        return { status: 200, body: pointer };
      }
      if (url.endsWith(".git/info/lfs/objects/batch")) {
        return { status: 200, body: Buffer.from("not-json") };
      }
      return { status: 404, body: Buffer.alloc(0) };
    });
    const ok = await proxyHfResolve(
      { storage, index: storage.index, fetch: fetchStub },
      ORG,
      REPO,
      "model",
      "v1",
      "weights.bin",
    );
    expect(ok).toBe(false);
  });

  it("returns false when the upstream LFS blob sha mismatches the declared OID", async () => {
    const real = Buffer.alloc(10, 0x42);
    const declared = Buffer.alloc(10, 0x43); // different bytes
    const declaredHex = sha256Hex(declared);
    const pointer = composeLfsPointer(declaredHex, declared.length);
    const fetchStub = makeStub((url) => {
      if (url.endsWith("/resolve/v1/weights.bin")) {
        return { status: 200, body: pointer };
      }
      if (url.endsWith(".git/info/lfs/objects/batch")) {
        return {
          status: 200,
          body: Buffer.from(
            JSON.stringify({
              objects: [
                {
                  oid: `sha256:${declaredHex}`,
                  size: declared.length,
                  actions: { download: { href: "https://lfs.example/x" } },
                },
              ],
            }),
          ),
        };
      }
      if (url === "https://lfs.example/x") {
        return { status: 200, body: real }; // lying upstream
      }
      return { status: 404, body: Buffer.alloc(0) };
    });
    const ok = await proxyHfResolve(
      { storage, index: storage.index, fetch: fetchStub },
      ORG,
      REPO,
      "model",
      "v1",
      "weights.bin",
    );
    expect(ok).toBe(false);
    const audit = storage.index.listAuditEntries({ action: "proxy_cache" });
    expect(audit.some((e) => e.detail?.phase === "lfs_blob_sha_mismatch")).toBe(true);
  });
});

describe("proxyHfLfsBatch", () => {
  let root: string;
  let storage: LocalFsRegistryStorage;
  const ORG = "acme";
  const REPO = "demo-model";

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "hf-virt-"));
    storage = LocalFsRegistryStorage.fromRoot(root);
    storage.index.addVirtualUpstream({
      org: ORG,
      kind: "huggingface",
      upstreamUrl: "https://huggingface.co",
      config: {},
    });
  });

  afterEach(async () => {
    storage.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("populates each requested OID via the upstream Batch API", async () => {
    const bytes1 = Buffer.alloc(100, 0x42);
    const hex1 = sha256Hex(bytes1);
    const bytes2 = Buffer.alloc(50, 0x43);
    const hex2 = sha256Hex(bytes2);
    const fetchStub = makeStub((url) => {
      if (url.endsWith(".git/info/lfs/objects/batch")) {
        // We make ONE call per OID for simplicity (the impl issues
        // one batch per OID). Inspect the body to figure out which.
        return {
          status: 200,
          body: Buffer.from(
            JSON.stringify({
              objects: [{
                oid: `sha256:${hex1}`,
                size: bytes1.length,
                actions: { download: { href: `https://lfs.example/${hex1}` } },
              }],
            }),
          ),
        };
      }
      if (url === `https://lfs.example/${hex1}`) {
        return { status: 200, body: bytes1 };
      }
      if (url === `https://lfs.example/${hex2}`) {
        return { status: 200, body: bytes2 };
      }
      return { status: 404, body: Buffer.alloc(0) };
    });
    // Override: track the second batch
    let callIdx = 0;
    const responses = [
      Buffer.from(JSON.stringify({
        objects: [{
          oid: `sha256:${hex1}`,
          size: bytes1.length,
          actions: { download: { href: `https://lfs.example/${hex1}` } },
        }],
      })),
      Buffer.from(JSON.stringify({
        objects: [{
          oid: `sha256:${hex2}`,
          size: bytes2.length,
          actions: { download: { href: `https://lfs.example/${hex2}` } },
        }],
      })),
    ];
    const fetcher2 = makeStub((url) => {
      if (url.endsWith(".git/info/lfs/objects/batch")) {
        const out = responses[callIdx++ % responses.length];
        return { status: 200, body: out };
      }
      if (url === `https://lfs.example/${hex1}`) return { status: 200, body: bytes1 };
      if (url === `https://lfs.example/${hex2}`) return { status: 200, body: bytes2 };
      return { status: 404, body: Buffer.alloc(0) };
    });
    void fetchStub;

    const populated = await proxyHfLfsBatch(
      { storage, index: storage.index, fetch: fetcher2 },
      ORG,
      REPO,
      [
        { oid: `sha256:${hex1}`, size: bytes1.length },
        { oid: `sha256:${hex2}`, size: bytes2.length },
      ],
    );
    expect(populated.size).toBe(2);
    expect(await storage.statBlob(hex1)).not.toBeNull();
    expect(await storage.statBlob(hex2)).not.toBeNull();
  });

  it("returns an empty set when no upstream is configured", async () => {
    storage.close();
    root = await fs.mkdtemp(path.join(os.tmpdir(), "hf-virt-"));
    storage = LocalFsRegistryStorage.fromRoot(root);
    const populated = await proxyHfLfsBatch(
      { storage, index: storage.index },
      ORG,
      REPO,
      [{ oid: `sha256:${"a".repeat(64)}`, size: 1 }],
    );
    expect(populated.size).toBe(0);
  });

  it("skips malformed OIDs without throwing", async () => {
    const fetchStub = makeStub(() => ({ status: 500, body: Buffer.alloc(0) }));
    const populated = await proxyHfLfsBatch(
      { storage, index: storage.index, fetch: fetchStub },
      ORG,
      REPO,
      [
        { oid: "not-a-sha", size: 1 },
        { oid: "alsobogus", size: 1 },
      ],
    );
    expect(populated.size).toBe(0);
  });

  it("returns an empty set on upstream 500", async () => {
    const hex = "f".repeat(64);
    const fetchStub = makeStub((url) => {
      if (url.endsWith(".git/info/lfs/objects/batch")) {
        return { status: 500, body: Buffer.alloc(0) };
      }
      return { status: 404, body: Buffer.alloc(0) };
    });
    const populated = await proxyHfLfsBatch(
      { storage, index: storage.index, fetch: fetchStub },
      ORG,
      REPO,
      [{ oid: `sha256:${hex}`, size: 1 }],
    );
    expect(populated.size).toBe(0);
  });

  it("returns empty when the Batch fetch itself rejects", async () => {
    const hex = "e".repeat(64);
    const fetchStub: UpstreamFetch = async () => {
      throw new Error("network down");
    };
    const populated = await proxyHfLfsBatch(
      { storage, index: storage.index, fetch: fetchStub },
      ORG,
      REPO,
      [{ oid: `sha256:${hex}`, size: 1 }],
    );
    expect(populated.size).toBe(0);
  });

  it("returns empty when the blob fetch returns 503", async () => {
    const real = Buffer.alloc(10, 0x42);
    const realHex = sha256Hex(real);
    const fetchStub = makeStub((url) => {
      if (url.endsWith(".git/info/lfs/objects/batch")) {
        return {
          status: 200,
          body: Buffer.from(
            JSON.stringify({
              objects: [{
                oid: `sha256:${realHex}`,
                size: real.length,
                actions: { download: { href: "https://lfs.example/x" } },
              }],
            }),
          ),
        };
      }
      if (url === "https://lfs.example/x") {
        return { status: 503, body: Buffer.alloc(0) };
      }
      return { status: 404, body: Buffer.alloc(0) };
    });
    const populated = await proxyHfLfsBatch(
      { storage, index: storage.index, fetch: fetchStub },
      ORG,
      REPO,
      [{ oid: `sha256:${realHex}`, size: real.length }],
    );
    expect(populated.size).toBe(0);
  });

  it("returns empty when the blob fetch throws", async () => {
    const real = Buffer.alloc(10, 0x42);
    const realHex = sha256Hex(real);
    let calls = 0;
    const fetchStub: UpstreamFetch = async () => {
      calls += 1;
      if (calls === 1) {
        return {
          status: 200,
          body: Buffer.from(JSON.stringify({
            objects: [{
              oid: `sha256:${realHex}`,
              size: real.length,
              actions: { download: { href: "https://lfs.example/x" } },
            }],
          })),
          headers: {},
        };
      }
      throw new Error("blob fetch died");
    };
    const populated = await proxyHfLfsBatch(
      { storage, index: storage.index, fetch: fetchStub },
      ORG,
      REPO,
      [{ oid: `sha256:${realHex}`, size: real.length }],
    );
    expect(populated.size).toBe(0);
  });
});

describe("proxyHfResolve — re-signing + filtering", () => {
  let root: string;
  let storage: LocalFsRegistryStorage;
  const ORG = "acme";
  const REPO = "demo-model";

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "hf-virt-"));
    storage = LocalFsRegistryStorage.fromRoot(root);
  });

  afterEach(async () => {
    storage.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("re-signs the cached manifest when resign_on_cache is true", async () => {
    const { generateKeypair } = await import("../signing.js");
    const kp = generateKeypair();
    storage.index.addVirtualUpstream({
      org: ORG,
      kind: "huggingface",
      upstreamUrl: "https://huggingface.co",
      config: { resign_on_cache: true },
    });
    const body = Buffer.from("signed content");
    const fetchStub = makeStub(() => ({ status: 200, body }));
    const ok = await proxyHfResolve(
      { storage, index: storage.index, fetch: fetchStub, signingPrivateKeyPem: kp.privateKeyPem },
      ORG,
      REPO,
      "model",
      "v1",
      "x.bin",
    );
    expect(ok).toBe(true);
    const m = await storage.getManifest(
      hfManifestName(ORG, REPO, "model"),
      hfManifestVersion("v1", "x.bin"),
    );
    expect(m?.signature).toBeDefined();
  });

  it("does NOT skip when allow_patterns matches the (org/repo)", async () => {
    storage.index.addVirtualUpstream({
      org: ORG,
      kind: "huggingface",
      upstreamUrl: "https://huggingface.co",
      config: { allow_patterns: [`${ORG}/*`] },
    });
    const body = Buffer.from("matched");
    const fetchStub = makeStub(() => ({ status: 200, body }));
    const ok = await proxyHfResolve(
      { storage, index: storage.index, fetch: fetchStub },
      ORG,
      REPO,
      "model",
      "v1",
      "x.bin",
    );
    expect(ok).toBe(true);
  });

  it("returns false when proxyHfResolve fetch itself rejects", async () => {
    storage.index.addVirtualUpstream({
      org: ORG,
      kind: "huggingface",
      upstreamUrl: "https://huggingface.co",
      config: {},
    });
    const fetchStub: UpstreamFetch = async () => {
      throw new Error("network down");
    };
    const ok = await proxyHfResolve(
      { storage, index: storage.index, fetch: fetchStub },
      ORG,
      REPO,
      "model",
      "v1",
      "x.bin",
    );
    expect(ok).toBe(false);
    const audit = storage.index.listAuditEntries({ action: "proxy_cache" });
    expect(audit.some((e) => e.detail?.phase === "resolve_fetch_error")).toBe(true);
  });

  it("falls back gracefully when re-sign throws", async () => {
    storage.index.addVirtualUpstream({
      org: ORG,
      kind: "huggingface",
      upstreamUrl: "https://huggingface.co",
      config: { resign_on_cache: true },
    });
    const body = Buffer.from("oops");
    const fetchStub = makeStub(() => ({ status: 200, body }));
    // Pass an invalid PEM to force a sign error.
    const ok = await proxyHfResolve(
      { storage, index: storage.index, fetch: fetchStub, signingPrivateKeyPem: "not-a-pem" },
      ORG,
      REPO,
      "model",
      "v1",
      "x.bin",
    );
    expect(ok).toBe(true); // resign_error is non-fatal; the manifest gets stored unsigned
    const audit = storage.index.listAuditEntries({ action: "proxy_cache" });
    expect(audit.some((e) => e.detail?.phase === "resign_error")).toBe(true);
  });

  it("skips when allow_patterns doesn't match the (org/repo)", async () => {
    storage.index.addVirtualUpstream({
      org: ORG,
      kind: "huggingface",
      upstreamUrl: "https://huggingface.co",
      config: { allow_patterns: ["other-org/*"] },
    });
    const fetchStub = makeStub(() => ({ status: 200, body: Buffer.from("never reached") }));
    const ok = await proxyHfResolve(
      { storage, index: storage.index, fetch: fetchStub },
      ORG,
      REPO,
      "model",
      "v1",
      "x.bin",
    );
    expect(ok).toBe(false);
  });
});
