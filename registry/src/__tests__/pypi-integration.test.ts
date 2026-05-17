// WS13 M1 — HTTP integration for the PyPI facade.
//
// Boots a real server with LocalFsRegistryStorage. Covers:
//   - /pypi/<org>/simple/  (root index, both HTML + JSON)
//   - /pypi/<org>/simple/<pkg>/  (per-package, both formats)
//   - /pypi/<org>/files/<pkg>/<filename>  (binary fetch)
//   - POST /pypi/<org>/  (twine upload, valid + reject cases)
//   - virtual upstream pull-through against a stubbed pypi.org

import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type ServerHandle } from "../http/server.js";
import { LocalFsRegistryStorage } from "../storage/registry-storage.js";
import {
  PYPI_ERROR_CODES,
  type PypiErrorEnvelope,
} from "../pypi/index.js";
import type { UpstreamFetch } from "../cargo/index.js";

const AUTH = "Bearer sk_TEST_0123456789ABCDEF";
const ORG = "acme";

const CRLF = "\r\n";
const BOUNDARY = "BOUNDARYZZ";

function buildTwineBody(parts: Array<{
  name: string;
  filename?: string;
  body: Buffer | string;
  contentType?: string;
}>): Buffer {
  const chunks: Buffer[] = [];
  for (const p of parts) {
    chunks.push(Buffer.from(`--${BOUNDARY}${CRLF}`));
    const dispBits = [`form-data; name="${p.name}"`];
    if (p.filename) dispBits.push(`filename="${p.filename}"`);
    chunks.push(Buffer.from(`Content-Disposition: ${dispBits.join("; ")}${CRLF}`));
    if (p.contentType) {
      chunks.push(Buffer.from(`Content-Type: ${p.contentType}${CRLF}`));
    }
    chunks.push(Buffer.from(CRLF));
    chunks.push(Buffer.isBuffer(p.body) ? p.body : Buffer.from(p.body));
    chunks.push(Buffer.from(CRLF));
  }
  chunks.push(Buffer.from(`--${BOUNDARY}--${CRLF}`));
  return Buffer.concat(chunks);
}

async function uploadFile(
  server: ServerHandle,
  upload: {
    name: string;
    version: string;
    filetype: "sdist" | "bdist_wheel";
    filename: string;
    content: Buffer;
    extra?: Record<string, string | string[]>;
  },
): Promise<Response> {
  const sha = crypto.createHash("sha256").update(upload.content).digest("hex");
  const parts: Parameters<typeof buildTwineBody>[0] = [
    { name: ":action", body: "file_upload" },
    { name: "name", body: upload.name },
    { name: "version", body: upload.version },
    { name: "filetype", body: upload.filetype },
    { name: "sha256_digest", body: sha },
    {
      name: "content",
      filename: upload.filename,
      body: upload.content,
      contentType: "application/octet-stream",
    },
  ];
  for (const [k, v] of Object.entries(upload.extra ?? {})) {
    if (Array.isArray(v)) {
      for (const item of v) parts.push({ name: k, body: item });
    } else {
      parts.push({ name: k, body: v });
    }
  }
  return fetch(`${server.baseUrl}/pypi/${ORG}/`, {
    method: "POST",
    headers: {
      authorization: AUTH,
      "content-type": `multipart/form-data; boundary=${BOUNDARY}`,
    },
    body: buildTwineBody(parts),
  });
}

describe("PyPI HTTP integration", () => {
  let root: string;
  let storage: LocalFsRegistryStorage;
  let server: ServerHandle;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "pypi-int-"));
    storage = LocalFsRegistryStorage.fromRoot(root);
    server = await createServer({ storage });
  });

  afterEach(async () => {
    await server.close();
    storage.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  describe("publish (POST /pypi/<org>/)", () => {
    it("accepts a canonical wheel upload + 200s", async () => {
      const r = await uploadFile(server, {
        name: "requests",
        version: "2.28.1",
        filetype: "bdist_wheel",
        filename: "requests-2.28.1-py3-none-any.whl",
        content: Buffer.from("wheel-bytes"),
      });
      expect(r.status).toBe(200);

      // The manifest row landed.
      const m = await storage.getManifest(
        "pypi/acme/requests",
        "requests-2.28.1-py3-none-any.whl",
      );
      expect(m).not.toBeNull();
      expect(m?.kind).toBe("pypi");
      expect(m?.pypiMetadata?.filetype).toBe("bdist_wheel");
      expect(m?.pypiMetadata?.version).toBe("2.28.1");
      expect(m?.pypiMetadata?.python_version).toBe("py3");
    });

    it("accepts a sdist upload", async () => {
      const r = await uploadFile(server, {
        name: "pkg",
        version: "1.0",
        filetype: "sdist",
        filename: "pkg-1.0.tar.gz",
        content: Buffer.from("sdist-bytes"),
      });
      expect(r.status).toBe(200);
    });

    it("captures PEP 345 metadata fields verbatim", async () => {
      await uploadFile(server, {
        name: "pkg",
        version: "1.0",
        filetype: "sdist",
        filename: "pkg-1.0.tar.gz",
        content: Buffer.from("sdist-bytes"),
        extra: {
          requires_python: ">=3.9",
          summary: "demo",
          classifiers: ["License :: OSI Approved", "Programming Language :: Python :: 3"],
        },
      });
      const m = await storage.getManifest("pypi/acme/pkg", "pkg-1.0.tar.gz");
      expect(m?.pypiMetadata?.requires_python).toBe(">=3.9");
      expect(m?.pypiMetadata?.summary).toBe("demo");
      expect(m?.pypiMetadata?.classifiers).toHaveLength(2);
    });

    it("audit-logs action='upload' on success", async () => {
      await uploadFile(server, {
        name: "pkg",
        version: "1.0",
        filetype: "sdist",
        filename: "pkg-1.0.tar.gz",
        content: Buffer.from("sdist-bytes-audit"),
      });
      const audits = storage.index.listAuditEntries({
        action: "upload",
        entityType: "manifest",
      });
      const entry = audits.find(
        (e) => e.entityId === "pypi/acme/pkg@pkg-1.0.tar.gz",
      );
      expect(entry).toBeDefined();
      expect(entry?.detail).toMatchObject({ kind: "pypi", filetype: "sdist" });
    });

    it("re-uploading identical bytes is idempotent (still 200)", async () => {
      const bytes = Buffer.from("idem-sdist");
      const a = await uploadFile(server, {
        name: "pkg",
        version: "1.0",
        filetype: "sdist",
        filename: "pkg-1.0.tar.gz",
        content: bytes,
      });
      const b = await uploadFile(server, {
        name: "pkg",
        version: "1.0",
        filetype: "sdist",
        filename: "pkg-1.0.tar.gz",
        content: bytes,
      });
      expect(a.status).toBe(200);
      expect(b.status).toBe(200);
    });

    it("re-uploading different bytes for same filename rejects with 409 CONFLICT", async () => {
      await uploadFile(server, {
        name: "pkg",
        version: "1.0",
        filetype: "sdist",
        filename: "pkg-1.0.tar.gz",
        content: Buffer.from("v1-bytes"),
      });
      const r = await uploadFile(server, {
        name: "pkg",
        version: "1.0",
        filetype: "sdist",
        filename: "pkg-1.0.tar.gz",
        content: Buffer.from("v2-bytes-different"),
      });
      expect(r.status).toBe(409);
      const env = (await r.json()) as PypiErrorEnvelope;
      expect(env.errors[0].code).toBe(PYPI_ERROR_CODES.CONFLICT);
    });

    it("rejects non-multipart Content-Type with 400", async () => {
      const r = await fetch(`${server.baseUrl}/pypi/${ORG}/`, {
        method: "POST",
        headers: { authorization: AUTH, "content-type": "application/json" },
        body: JSON.stringify({ name: "pkg" }),
      });
      expect(r.status).toBe(400);
    });

    it("rejects POST with no body", async () => {
      const r = await fetch(`${server.baseUrl}/pypi/${ORG}/`, {
        method: "POST",
        headers: {
          authorization: AUTH,
          "content-type": `multipart/form-data; boundary=${BOUNDARY}`,
        },
      });
      // No body stream → router may not even reach our handler; if it does, 400.
      expect([400, 500]).toContain(r.status);
    });

    it("rejects digest mismatch", async () => {
      const body = buildTwineBody([
        { name: ":action", body: "file_upload" },
        { name: "name", body: "pkg" },
        { name: "version", body: "1.0" },
        { name: "filetype", body: "sdist" },
        { name: "sha256_digest", body: "0".repeat(64) },
        {
          name: "content",
          filename: "pkg-1.0.tar.gz",
          body: Buffer.from("real-bytes"),
        },
      ]);
      const r = await fetch(`${server.baseUrl}/pypi/${ORG}/`, {
        method: "POST",
        headers: {
          authorization: AUTH,
          "content-type": `multipart/form-data; boundary=${BOUNDARY}`,
        },
        body,
      });
      expect(r.status).toBe(400);
      const env = (await r.json()) as PypiErrorEnvelope;
      expect(env.errors[0].code).toBe(PYPI_ERROR_CODES.DIGEST_MISMATCH);
    });
  });

  describe("read — /simple/", () => {
    beforeEach(async () => {
      await uploadFile(server, {
        name: "pkg",
        version: "1.0",
        filetype: "sdist",
        filename: "pkg-1.0.tar.gz",
        content: Buffer.from("a"),
      });
      await uploadFile(server, {
        name: "pkg",
        version: "1.0",
        filetype: "bdist_wheel",
        filename: "pkg-1.0-py3-none-any.whl",
        content: Buffer.from("b"),
        extra: { requires_python: ">=3.8" },
      });
      await uploadFile(server, {
        name: "other",
        version: "2.0",
        filetype: "sdist",
        filename: "other-2.0.tar.gz",
        content: Buffer.from("c"),
      });
    });

    it("root index in HTML lists every package", async () => {
      const r = await fetch(`${server.baseUrl}/pypi/${ORG}/simple/`, {
        headers: { authorization: AUTH, accept: "text/html" },
      });
      expect(r.status).toBe(200);
      const html = await r.text();
      expect(html).toContain(`<a href="./pkg/">pkg</a>`);
      expect(html).toContain(`<a href="./other/">other</a>`);
    });

    it("root index in JSON returns PEP 691 shape", async () => {
      const r = await fetch(`${server.baseUrl}/pypi/${ORG}/simple/`, {
        headers: {
          authorization: AUTH,
          accept: "application/vnd.pypi.simple.v1+json",
        },
      });
      expect(r.status).toBe(200);
      const body = (await r.json()) as { meta: { "api-version": string }; projects: { name: string }[] };
      expect(body.meta["api-version"]).toBe("1.1");
      expect(body.projects.map((p) => p.name).sort()).toEqual(["other", "pkg"]);
    });

    it("per-package HTML lists all files with sha256 anchors", async () => {
      const r = await fetch(`${server.baseUrl}/pypi/${ORG}/simple/pkg/`, {
        headers: { authorization: AUTH, accept: "text/html" },
      });
      expect(r.status).toBe(200);
      const html = await r.text();
      expect(html).toContain("pkg-1.0.tar.gz");
      expect(html).toContain("pkg-1.0-py3-none-any.whl");
      expect(html).toContain("#sha256=");
      expect(html).toContain(`data-requires-python="&gt;=3.8"`);
    });

    it("per-package JSON returns PEP 691 shape with versions field", async () => {
      const r = await fetch(`${server.baseUrl}/pypi/${ORG}/simple/pkg/`, {
        headers: {
          authorization: AUTH,
          accept: "application/vnd.pypi.simple.v1+json",
        },
      });
      expect(r.status).toBe(200);
      const body = (await r.json()) as {
        meta: { "api-version": string };
        name: string;
        files: Array<{ filename: string; hashes: { sha256: string } }>;
        versions: string[];
      };
      expect(body.meta["api-version"]).toBe("1.1");
      expect(body.name).toBe("pkg");
      expect(body.files).toHaveLength(2);
      expect(body.files[0].hashes.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(body.versions).toEqual(["1.0"]);
    });

    it("unknown package returns 404", async () => {
      const r = await fetch(`${server.baseUrl}/pypi/${ORG}/simple/missing/`, {
        headers: { authorization: AUTH },
      });
      expect(r.status).toBe(404);
      const env = (await r.json()) as PypiErrorEnvelope;
      expect(env.errors[0].code).toBe(PYPI_ERROR_CODES.PACKAGE_NOT_FOUND);
    });

    it("normalised package name lookup", async () => {
      // upload as `Foo_Bar`, look up as `foo-bar`
      await uploadFile(server, {
        name: "Foo_Bar",
        version: "1.0",
        filetype: "sdist",
        filename: "Foo_Bar-1.0.tar.gz",
        content: Buffer.from("x"),
      });
      const r = await fetch(`${server.baseUrl}/pypi/${ORG}/simple/foo-bar/`, {
        headers: { authorization: AUTH },
      });
      expect(r.status).toBe(200);
    });
  });

  describe("read — /files/<pkg>/<filename>", () => {
    it("serves the binary bytes + ETag", async () => {
      const bytes = Buffer.from("file-bytes-for-pull");
      await uploadFile(server, {
        name: "pkg",
        version: "1.0",
        filetype: "sdist",
        filename: "pkg-1.0.tar.gz",
        content: bytes,
      });
      const r = await fetch(
        `${server.baseUrl}/pypi/${ORG}/files/pkg/pkg-1.0.tar.gz`,
        { headers: { authorization: AUTH } },
      );
      expect(r.status).toBe(200);
      const echoed = Buffer.from(await r.arrayBuffer());
      expect(echoed.equals(bytes)).toBe(true);
      expect(r.headers.get("etag")).toMatch(/^"sha256:[a-f0-9]{64}"$/);
    });

    it("404 when file is unknown", async () => {
      const r = await fetch(
        `${server.baseUrl}/pypi/${ORG}/files/pkg/missing-1.0.tar.gz`,
        { headers: { authorization: AUTH } },
      );
      expect(r.status).toBe(404);
    });
  });

  describe("virtual upstream pull-through", () => {
    function makeStub(
      handler: (url: string) => { status: number; headers?: Record<string, string>; body: Buffer },
    ): UpstreamFetch {
      return async (url) => {
        const r = handler(url);
        return { status: r.status, headers: r.headers ?? {}, body: r.body };
      };
    }

    it("on /simple/<pkg>/ miss, fetches upstream PEP 691 + caches", async () => {
      const upstreamSha = crypto
        .createHash("sha256")
        .update(Buffer.from("upstream-wheel-bytes"))
        .digest("hex");
      const fetcher = makeStub((url) => {
        if (url.endsWith("/requests/")) {
          return {
            status: 200,
            headers: { "content-type": "application/vnd.pypi.simple.v1+json" },
            body: Buffer.from(
              JSON.stringify({
                meta: { "api-version": "1.0" },
                name: "requests",
                files: [
                  {
                    filename: "requests-2.28.1-py3-none-any.whl",
                    url: "https://files.pythonhosted.org/.../requests-2.28.1-py3-none-any.whl",
                    hashes: { sha256: upstreamSha },
                    "requires-python": ">=3.7",
                  },
                ],
              }),
            ),
          };
        }
        return { status: 404, body: Buffer.from("") };
      });
      await server.close();
      server = await createServer({ storage, virtualUpstreamFetch: fetcher });
      storage.index.addVirtualUpstream({
        org: ORG,
        kind: "pypi",
        upstreamUrl: "https://pypi.org/simple",
        config: {},
      });

      const r = await fetch(`${server.baseUrl}/pypi/${ORG}/simple/requests/`, {
        headers: {
          authorization: AUTH,
          accept: "application/vnd.pypi.simple.v1+json",
        },
      });
      expect(r.status).toBe(200);
      const body = (await r.json()) as {
        files: Array<{ filename: string; hashes: { sha256: string } }>;
      };
      expect(body.files).toHaveLength(1);
      expect(body.files[0].filename).toBe("requests-2.28.1-py3-none-any.whl");
      expect(body.files[0].hashes.sha256).toBe(upstreamSha);

      // Cached as a manifest row + audit row written.
      const m = await storage.getManifest(
        "pypi/acme/requests",
        "requests-2.28.1-py3-none-any.whl",
      );
      expect(m).not.toBeNull();
      const audits = storage.index.listAuditEntries({ action: "proxy_cache" });
      expect(audits.length).toBeGreaterThanOrEqual(1);
    });

    it("on /files/ miss, fetches the binary upstream + verifies sha256", async () => {
      const bytes = Buffer.from("real-wheel-bytes-from-upstream");
      const sha = crypto.createHash("sha256").update(bytes).digest("hex");
      const fetcher = makeStub((url) => {
        if (url.endsWith("/requests/")) {
          return {
            status: 200,
            headers: { "content-type": "application/vnd.pypi.simple.v1+json" },
            body: Buffer.from(
              JSON.stringify({
                meta: { "api-version": "1.0" },
                name: "requests",
                files: [
                  {
                    filename: "requests-1.0-py3-none-any.whl",
                    url: "https://files.pythonhosted.org/.../requests-1.0-py3-none-any.whl",
                    hashes: { sha256: sha },
                  },
                ],
              }),
            ),
          };
        }
        if (url.endsWith("/requests-1.0-py3-none-any.whl")) {
          return {
            status: 200,
            headers: { "content-type": "application/octet-stream" },
            body: bytes,
          };
        }
        return { status: 404, body: Buffer.from("") };
      });
      await server.close();
      server = await createServer({ storage, virtualUpstreamFetch: fetcher });
      storage.index.addVirtualUpstream({
        org: ORG,
        kind: "pypi",
        upstreamUrl: "https://pypi.org/simple",
        config: {},
      });

      // Warm the index first (proxy package metadata).
      await fetch(`${server.baseUrl}/pypi/${ORG}/simple/requests/`, {
        headers: { authorization: AUTH },
      });
      // Now fetch the file.
      const r = await fetch(
        `${server.baseUrl}/pypi/${ORG}/files/requests/requests-1.0-py3-none-any.whl`,
        { headers: { authorization: AUTH } },
      );
      expect(r.status).toBe(200);
      const echoed = Buffer.from(await r.arrayBuffer());
      expect(echoed.equals(bytes)).toBe(true);
    });

    it("upstream digest mismatch on file fetch is logged + 404 to client", async () => {
      const claimedSha = "a".repeat(64);
      const actualBytes = Buffer.from("different-bytes");
      const fetcher = makeStub((url) => {
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
                    hashes: { sha256: claimedSha },
                  },
                ],
              }),
            ),
          };
        }
        if (url.endsWith("/pkg-1.0.tar.gz")) {
          return {
            status: 200,
            headers: { "content-type": "application/octet-stream" },
            body: actualBytes,
          };
        }
        return { status: 404, body: Buffer.from("") };
      });
      await server.close();
      server = await createServer({ storage, virtualUpstreamFetch: fetcher });
      storage.index.addVirtualUpstream({
        org: ORG,
        kind: "pypi",
        upstreamUrl: "https://pypi.org/simple",
        config: {},
      });

      await fetch(`${server.baseUrl}/pypi/${ORG}/simple/pkg/`, {
        headers: { authorization: AUTH },
      });
      const r = await fetch(
        `${server.baseUrl}/pypi/${ORG}/files/pkg/pkg-1.0.tar.gz`,
        { headers: { authorization: AUTH } },
      );
      expect(r.status).toBe(404);
      const audits = storage.index.listAuditEntries({ action: "proxy_cache" });
      const mismatch = audits.find(
        (a) => (a.detail as { phase?: string })?.phase === "file_digest_mismatch",
      );
      expect(mismatch).toBeDefined();
    });

    it("HTML upstream response is also parsed", async () => {
      const sha = crypto
        .createHash("sha256")
        .update(Buffer.from("html-wheel"))
        .digest("hex");
      const fetcher = makeStub((url) => {
        if (url.endsWith("/django/")) {
          return {
            status: 200,
            headers: { "content-type": "text/html" },
            body: Buffer.from(
              `<a href="https://e/django-1.0.tar.gz#sha256=${sha}" data-requires-python="&gt;=3.8">django-1.0.tar.gz</a>`,
            ),
          };
        }
        return { status: 404, body: Buffer.from("") };
      });
      await server.close();
      server = await createServer({ storage, virtualUpstreamFetch: fetcher });
      storage.index.addVirtualUpstream({
        org: ORG,
        kind: "pypi",
        upstreamUrl: "https://pypi.org/simple",
        config: {},
      });
      const r = await fetch(`${server.baseUrl}/pypi/${ORG}/simple/django/`, {
        headers: { authorization: AUTH, accept: "application/vnd.pypi.simple.v1+json" },
      });
      const body = (await r.json()) as { files: Array<{ filename: string }> };
      expect(body.files.map((f) => f.filename)).toContain("django-1.0.tar.gz");
    });

    it("no upstream configured → 404", async () => {
      const r = await fetch(
        `${server.baseUrl}/pypi/${ORG}/simple/never-cached/`,
        { headers: { authorization: AUTH } },
      );
      expect(r.status).toBe(404);
    });
  });
});
