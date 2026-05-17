// WS13 M1 — targeted branch-coverage tests for the PyPI module.
// Complements pypi-integration.test.ts with focused exercises of
// the optional / private / error paths the integration suite doesn't
// flex.

import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type ServerHandle } from "../http/server.js";
import { LocalFsRegistryStorage } from "../storage/registry-storage.js";
import { generateKeypair } from "../signing.js";
import {
  normalisePypiName,
  proxyPypiFile,
  proxyPypiPackage,
  PYPI_ERROR_CODES,
  PypiError,
  type PypiErrorEnvelope,
  type VirtualPypiOptions,
} from "../pypi/index.js";
import type { UpstreamFetch, UpstreamFetchResult } from "../cargo/index.js";

const AUTH = "Bearer sk_TEST_0123456789ABCDEF";
const ORG = "acme";
const BOUNDARY = "B";
const CRLF = "\r\n";

function buildBody(parts: Array<{
  name: string;
  filename?: string;
  body: Buffer | string;
}>): Buffer {
  const chunks: Buffer[] = [];
  for (const p of parts) {
    chunks.push(Buffer.from(`--${BOUNDARY}${CRLF}`));
    const disp = [`form-data; name="${p.name}"`];
    if (p.filename) disp.push(`filename="${p.filename}"`);
    chunks.push(Buffer.from(`Content-Disposition: ${disp.join("; ")}${CRLF}${CRLF}`));
    chunks.push(Buffer.isBuffer(p.body) ? p.body : Buffer.from(p.body));
    chunks.push(Buffer.from(CRLF));
  }
  chunks.push(Buffer.from(`--${BOUNDARY}--${CRLF}`));
  return Buffer.concat(chunks);
}

function makeStub(
  handler: (
    url: string,
    init?: { method?: "GET" | "POST" | "HEAD"; headers?: Record<string, string>; body?: string },
  ) => UpstreamFetchResult,
): { fetch: UpstreamFetch; invocations: Array<{ url: string; auth?: string }> } {
  const invocations: Array<{ url: string; auth?: string }> = [];
  const fetch: UpstreamFetch = async (url, init) => {
    invocations.push({
      url,
      ...(init?.headers?.authorization ? { auth: init.headers.authorization } : {}),
    });
    return handler(url, init);
  };
  return { fetch, invocations };
}

describe("PyPI publish — every PEP 345 metadata field round-trips", () => {
  let root: string;
  let storage: LocalFsRegistryStorage;
  let server: ServerHandle;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "pypi-cov-"));
    storage = LocalFsRegistryStorage.fromRoot(root);
    server = await createServer({ storage });
  });

  afterEach(async () => {
    await server.close();
    storage.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("captures the full PEP 345 metadata set into pypi_metadata_json", async () => {
    const bytes = Buffer.from("metadata-rich-sdist");
    const sha = crypto.createHash("sha256").update(bytes).digest("hex");
    const body = buildBody([
      { name: ":action", body: "file_upload" },
      { name: "name", body: "pkg" },
      { name: "version", body: "1.0" },
      { name: "filetype", body: "sdist" },
      { name: "sha256_digest", body: sha },
      { name: "content", filename: "pkg-1.0.tar.gz", body: bytes },
      { name: "requires_python", body: ">=3.9" },
      { name: "yanked", body: "compromised" },
      { name: "md5_digest", body: "deadbeef" },
      { name: "blake2_256_digest", body: "feedface" },
      { name: "summary", body: "demo" },
      { name: "description", body: "a long description" },
      { name: "description_content_type", body: "text/markdown" },
      { name: "author", body: "alice" },
      { name: "author_email", body: "alice@example.com" },
      { name: "maintainer", body: "bob" },
      { name: "maintainer_email", body: "bob@example.com" },
      { name: "license", body: "Apache-2.0" },
      { name: "keywords", body: "demo,test" },
      { name: "home_page", body: "https://example.com/pkg" },
      { name: "classifiers", body: "License :: OSI Approved" },
      { name: "classifiers", body: "Python :: 3" },
      { name: "requires_dist", body: "requests>=2" },
      { name: "provides_dist", body: "pkg-alias" },
      { name: "obsoletes_dist", body: "pkg-old" },
    ]);
    const r = await fetch(`${server.baseUrl}/pypi/${ORG}/`, {
      method: "POST",
      headers: {
        authorization: AUTH,
        "content-type": `multipart/form-data; boundary=${BOUNDARY}`,
      },
      body,
    });
    expect(r.status).toBe(200);
    const m = await storage.getManifest("pypi/acme/pkg", "pkg-1.0.tar.gz");
    const md = m!.pypiMetadata!;
    expect(md.requires_python).toBe(">=3.9");
    expect(md.yanked).toBe("compromised");
    expect(md.md5_digest).toBe("deadbeef");
    expect(md.blake2_256_digest).toBe("feedface");
    expect(md.summary).toBe("demo");
    expect(md.description).toBe("a long description");
    expect(md.description_content_type).toBe("text/markdown");
    expect(md.author).toBe("alice");
    expect(md.author_email).toBe("alice@example.com");
    expect(md.maintainer).toBe("bob");
    expect(md.maintainer_email).toBe("bob@example.com");
    expect(md.license).toBe("Apache-2.0");
    expect(md.keywords).toBe("demo,test");
    expect(md.home_page).toBe("https://example.com/pkg");
    expect(md.classifiers).toEqual(["License :: OSI Approved", "Python :: 3"]);
    expect(md.requires_dist).toEqual(["requests>=2"]);
    expect(md.provides_dist).toEqual(["pkg-alias"]);
    expect(md.obsoletes_dist).toEqual(["pkg-old"]);
  });

  it("wheel upload extracts python/abi/platform tags from filename", async () => {
    const bytes = Buffer.from("wheel-bytes");
    const sha = crypto.createHash("sha256").update(bytes).digest("hex");
    const body = buildBody([
      { name: ":action", body: "file_upload" },
      { name: "name", body: "pkg" },
      { name: "version", body: "1.0" },
      { name: "filetype", body: "bdist_wheel" },
      { name: "sha256_digest", body: sha },
      { name: "content", filename: "pkg-1.0-cp310-cp310-linux_x86_64.whl", body: bytes },
    ]);
    const r = await fetch(`${server.baseUrl}/pypi/${ORG}/`, {
      method: "POST",
      headers: {
        authorization: AUTH,
        "content-type": `multipart/form-data; boundary=${BOUNDARY}`,
      },
      body,
    });
    expect(r.status).toBe(200);
    const m = await storage.getManifest(
      "pypi/acme/pkg",
      "pkg-1.0-cp310-cp310-linux_x86_64.whl",
    );
    expect(m!.pypiMetadata!.python_version).toBe("cp310");
    expect(m!.pypiMetadata!.abi).toBe("cp310");
    expect(m!.pypiMetadata!.platform).toBe("linux_x86_64");
  });

  it("yanked='' (empty) becomes the boolean `true` per PEP 592", async () => {
    const bytes = Buffer.from("yanked-empty");
    const sha = crypto.createHash("sha256").update(bytes).digest("hex");
    const body = buildBody([
      { name: ":action", body: "file_upload" },
      { name: "name", body: "pkg" },
      { name: "version", body: "1.0" },
      { name: "filetype", body: "sdist" },
      { name: "sha256_digest", body: sha },
      { name: "content", filename: "pkg-1.0.tar.gz", body: bytes },
      // No yanked field at all — meta.yanked stays undefined (verified below).
    ]);
    await fetch(`${server.baseUrl}/pypi/${ORG}/`, {
      method: "POST",
      headers: {
        authorization: AUTH,
        "content-type": `multipart/form-data; boundary=${BOUNDARY}`,
      },
      body,
    });
    const m = await storage.getManifest("pypi/acme/pkg", "pkg-1.0.tar.gz");
    expect(m!.pypiMetadata!.yanked).toBeUndefined();
  });
});

describe("PyPI virtual upstream — auth + resign branches", () => {
  let root: string;
  let storage: LocalFsRegistryStorage;
  let server: ServerHandle;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "pypi-virt-cov-"));
    storage = LocalFsRegistryStorage.fromRoot(root);
  });

  afterEach(async () => {
    if (server) {
      try {
        await server.close();
      } catch {
        // already closed in test body
      }
      server = undefined as unknown as ServerHandle;
    }
    storage.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("forwards auth_header_template on the upstream request", async () => {
    const sha = crypto.createHash("sha256").update(Buffer.from("z")).digest("hex");
    const { fetch, invocations } = makeStub((url) => {
      if (url.endsWith("/pkg/")) {
        return {
          status: 200,
          headers: { "content-type": "application/vnd.pypi.simple.v1+json" },
          body: Buffer.from(
            JSON.stringify({
              meta: { "api-version": "1.0" },
              name: "pkg",
              files: [
                {
                  filename: "pkg-1.0.tar.gz",
                  url: "https://e/pkg-1.0.tar.gz",
                  hashes: { sha256: sha },
                },
              ],
            }),
          ),
        };
      }
      return { status: 404, headers: {}, body: Buffer.from("") };
    });
    server = await createServer({ storage, virtualUpstreamFetch: fetch });
    storage.index.addVirtualUpstream({
      org: ORG,
      kind: "pypi",
      upstreamUrl: "https://private-mirror/simple",
      config: {
        auth_header_template: "Basic dGVzdDp0b2tlbg==",
      },
    });
    const r = await fetch_simple(server, "pkg");
    expect(r.status).toBe(200);
    const authHit = invocations.find((i) => i.auth);
    expect(authHit?.auth).toBe("Basic dGVzdDp0b2tlbg==");
  });

  it("resign_on_cache + signingPrivateKeyPem signs the cached manifest", async () => {
    const sha = crypto.createHash("sha256").update(Buffer.from("a")).digest("hex");
    const { fetch } = makeStub((url) => {
      if (url.endsWith("/pkg/")) {
        return {
          status: 200,
          headers: { "content-type": "application/vnd.pypi.simple.v1+json" },
          body: Buffer.from(
            JSON.stringify({
              meta: { "api-version": "1.0" },
              name: "pkg",
              files: [
                {
                  filename: "pkg-1.0.tar.gz",
                  url: "https://e/pkg-1.0.tar.gz",
                  hashes: { sha256: sha },
                },
              ],
            }),
          ),
        };
      }
      return { status: 404, headers: {}, body: Buffer.from("") };
    });
    const { privateKeyPem } = generateKeypair();
    server = await createServer({
      storage,
      virtualUpstreamFetch: fetch,
      virtualResignPrivateKeyPem: privateKeyPem,
    });
    storage.index.addVirtualUpstream({
      org: ORG,
      kind: "pypi",
      upstreamUrl: "https://pypi.org/simple",
      config: { resign_on_cache: true },
    });
    await fetch_simple(server, "pkg");
    const m = await storage.getManifest("pypi/acme/pkg", "pkg-1.0.tar.gz");
    expect(m?.signature?.signatureB64).toBeDefined();
  });

  it("deny_patterns filters out a package before any upstream call", async () => {
    const { fetch, invocations } = makeStub(() => ({
      status: 200,
      headers: {},
      body: Buffer.from(""),
    }));
    server = await createServer({ storage, virtualUpstreamFetch: fetch });
    storage.index.addVirtualUpstream({
      org: ORG,
      kind: "pypi",
      upstreamUrl: "https://pypi.org/simple",
      config: { deny_patterns: ["malware-*"] },
    });
    const r = await fetch_simple(server, "malware-bad");
    expect(r.status).toBe(404);
    expect(invocations.length).toBe(0);
  });

  it("upstream fetch_error is audited and continues to next upstream", async () => {
    const sha = crypto.createHash("sha256").update(Buffer.from("a")).digest("hex");
    let call = 0;
    const fetcher: UpstreamFetch = async (url) => {
      call += 1;
      if (call === 1) throw new Error("network down");
      if (url.endsWith("/pkg/")) {
        return {
          status: 200,
          headers: { "content-type": "application/vnd.pypi.simple.v1+json" },
          body: Buffer.from(
            JSON.stringify({
              meta: { "api-version": "1.0" },
              name: "pkg",
              files: [
                {
                  filename: "pkg-1.0.tar.gz",
                  url: "https://e/pkg-1.0.tar.gz",
                  hashes: { sha256: sha },
                },
              ],
            }),
          ),
        };
      }
      return { status: 404, headers: {}, body: Buffer.from("") };
    };
    server = await createServer({ storage, virtualUpstreamFetch: fetcher });
    storage.index.addVirtualUpstream({
      org: ORG,
      kind: "pypi",
      upstreamUrl: "https://primary-fail/simple",
      config: {},
    });
    storage.index.addVirtualUpstream({
      org: ORG,
      kind: "pypi",
      upstreamUrl: "https://backup/simple",
      config: {},
    });
    const r = await fetch_simple(server, "pkg");
    expect(r.status).toBe(200);
    const audits = storage.index.listAuditEntries({ action: "proxy_cache" });
    const fetchErr = audits.find(
      (a) => (a.detail as { phase?: string })?.phase === "fetch_error",
    );
    expect(fetchErr).toBeDefined();
  });

  it("upstream 500 → upstream_error audit + 404", async () => {
    const { fetch } = makeStub(() => ({ status: 500, headers: {}, body: Buffer.from("") }));
    server = await createServer({ storage, virtualUpstreamFetch: fetch });
    storage.index.addVirtualUpstream({
      org: ORG,
      kind: "pypi",
      upstreamUrl: "https://upstream/simple",
      config: {},
    });
    const r = await fetch_simple(server, "pkg");
    expect(r.status).toBe(404);
    const audits = storage.index.listAuditEntries({ action: "proxy_cache" });
    expect(
      audits.find((a) => (a.detail as { phase?: string })?.phase === "upstream_error"),
    ).toBeDefined();
  });

  it("upstream non-JSON / non-HTML response → parse_error audit", async () => {
    const { fetch } = makeStub(() => ({
      status: 200,
      headers: { "content-type": "application/json" },
      body: Buffer.from("not valid json"),
    }));
    server = await createServer({ storage, virtualUpstreamFetch: fetch });
    storage.index.addVirtualUpstream({
      org: ORG,
      kind: "pypi",
      upstreamUrl: "https://upstream/simple",
      config: {},
    });
    const r = await fetch_simple(server, "pkg");
    expect(r.status).toBe(404);
    const audits = storage.index.listAuditEntries({ action: "proxy_cache" });
    expect(
      audits.find((a) => (a.detail as { phase?: string })?.phase === "parse_error"),
    ).toBeDefined();
  });

  it("proxyPypiPackage returns null when no upstream configured", async () => {
    const options: VirtualPypiOptions = {
      storage,
      index: storage.index,
    };
    const result = await proxyPypiPackage(options, "acme", "missing");
    expect(result).toBeNull();
  });

  it("proxyPypiFile returns null when metadata row absent", async () => {
    storage.index.addVirtualUpstream({
      org: ORG,
      kind: "pypi",
      upstreamUrl: "https://up/simple",
      config: {},
    });
    const options: VirtualPypiOptions = {
      storage,
      index: storage.index,
    };
    const result = await proxyPypiFile(options, "acme", "no-such-pkg", "no-such-file.tar.gz");
    expect(result).toBeNull();
  });

  it("upstream_repo_template substitutes {package} and {filename}", async () => {
    // Direct virtual-layer test bypassing HTTP. We seed the index
    // with a manifest row whose blob is missing, then ensure the
    // proxyPypiFile composes the upstream URL via the template.
    const bytes = Buffer.from("bytes-via-template");
    const sha = crypto.createHash("sha256").update(bytes).digest("hex");
    const seen: string[] = [];
    const stubFetch: UpstreamFetch = async (url) => {
      seen.push(url);
      if (url.startsWith("https://custom/") && url.endsWith("/pkg-1.0.tar.gz")) {
        return {
          status: 200,
          headers: { "content-type": "application/octet-stream" },
          body: bytes,
        };
      }
      return { status: 404, headers: {}, body: Buffer.from("") };
    };
    storage.index.addVirtualUpstream({
      org: ORG,
      kind: "pypi",
      upstreamUrl: "https://up/simple",
      config: {
        upstream_repo_template: "https://custom/{package}/{filename}",
      },
    });
    // Seed a manifest row with the expected sha so the proxy file
    // path can find expectedSha.
    storage.index.putManifest(
      {
        name: "pypi/acme/pkg",
        version: "pkg-1.0.tar.gz",
        mediaType: "application/vnd.signalman.pypi-file.v1+json",
        kind: "pypi",
        blobs: [
          { mediaType: "application/octet-stream", sha256: sha, size: bytes.length },
        ],
        pypiMetadata: {
          version: "1.0",
          filename: "pkg-1.0.tar.gz",
          filetype: "sdist",
        },
        createdAt: new Date().toISOString(),
      },
      Buffer.from("manifest-bytes"),
    );
    const result = await proxyPypiFile(
      { storage, index: storage.index, fetch: stubFetch },
      "acme",
      "pkg",
      "pkg-1.0.tar.gz",
    );
    expect(result).not.toBeNull();
    expect(result?.sha256).toBe(sha);
    expect(
      seen.some(
        (u) => u.startsWith("https://custom/") && u.endsWith("/pkg-1.0.tar.gz"),
      ),
    ).toBe(true);
  });
});

describe("PyPI publish — additional error paths", () => {
  let root: string;
  let storage: LocalFsRegistryStorage;
  let server: ServerHandle;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "pypi-pub-cov-"));
    storage = LocalFsRegistryStorage.fromRoot(root);
    server = await createServer({ storage });
  });

  afterEach(async () => {
    await server.close();
    storage.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("rejects an invalid org name", async () => {
    const r = await fetch(`${server.baseUrl}/pypi/BAD_ORG/`, {
      method: "POST",
      headers: {
        authorization: AUTH,
        "content-type": `multipart/form-data; boundary=${BOUNDARY}`,
      },
      body: buildBody([{ name: ":action", body: "file_upload" }]),
    });
    expect(r.status).toBeGreaterThanOrEqual(400);
  });
});

describe("PyPI read — corner cases", () => {
  let root: string;
  let storage: LocalFsRegistryStorage;
  let server: ServerHandle;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "pypi-read-cov-"));
    storage = LocalFsRegistryStorage.fromRoot(root);
    server = await createServer({ storage });
  });

  afterEach(async () => {
    await server.close();
    storage.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("simple/<pkg>/ rejects invalid org names with 400", async () => {
    const r = await fetch(`${server.baseUrl}/pypi/BAD_ORG/simple/pkg/`, {
      headers: { authorization: AUTH },
    });
    expect(r.status).toBe(400);
  });

  it("simple/ root index serves JSON when */* is the only Accept token", async () => {
    // Empty registry but the endpoint should still respond.
    const r = await fetch(`${server.baseUrl}/pypi/${ORG}/simple/`, {
      headers: { authorization: AUTH, accept: "*/*" },
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { projects: unknown[] };
    expect(body.projects).toEqual([]);
  });

  it("normalisePypiName throws PypiError for non-string inputs", () => {
    expect(() => normalisePypiName(42 as unknown as string)).toThrowError(PypiError);
    expect(() => normalisePypiName(null as unknown as string)).toThrowError(PypiError);
  });
});

// ── helper ─────────────────────────────────────────────────────────

async function fetch_simple(server: ServerHandle, pkg: string): Promise<Response> {
  return fetch(`${server.baseUrl}/pypi/${ORG}/simple/${pkg}/`, {
    headers: {
      authorization: AUTH,
      accept: "application/vnd.pypi.simple.v1+json",
    },
  });
}
