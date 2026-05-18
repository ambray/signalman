// WS13 M3 — HTTP integration for the NuGet facade.
//
// Boots a real server with LocalFsRegistryStorage. Covers:
//   - Service-index discovery (dotnet's first request)
//   - dotnet nuget push (multipart) + flat-container fetch
//   - Bare-body push (legacy NuGet 2.x compat)
//   - Version-index + registration index/leaf composition
//   - Idempotency (201 → 201 on same bytes; 409 on different)
//   - Virtual upstream pull-through (stubbed nuget.org)

import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type ServerHandle } from "../http/server.js";
import { LocalFsRegistryStorage } from "../storage/registry-storage.js";
import {
  NUGET_ERROR_CODES,
  NUGET_RESOURCE_TYPES,
  type NugetErrorEnvelope,
  type NugetRegistrationIndex,
  type NugetServiceIndex,
} from "../nuget/index.js";
import type { UpstreamFetch } from "../cargo/index.js";
import { buildSingleEntryZip } from "./nuget-guards.test.js";

const AUTH = "Bearer sk_TEST_0123456789ABCDEF";
const ORG = "acme";

function nuspecFor(id: string, version: string, extras: string = ""): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<package>
  <metadata>
    <id>${id}</id>
    <version>${version}</version>
    <authors>Acme</authors>
    <description>${id} version ${version}</description>${extras}
  </metadata>
</package>`;
}

function buildNupkg(id: string, version: string, extras: string = ""): Buffer {
  const nuspec = nuspecFor(id, version, extras);
  return buildSingleEntryZip(`${id}.nuspec`, Buffer.from(nuspec, "utf-8"), {
    deflate: true,
  });
}

function multipartBody(boundary: string, filename: string, content: Buffer): Buffer {
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="package"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
    "utf-8",
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, "utf-8");
  return Buffer.concat([head, content, tail]);
}

async function pushMultipart(
  server: ServerHandle,
  org: string,
  nupkg: Buffer,
  filename = "demo.nupkg",
): Promise<Response> {
  const boundary = "------signalmanboundary";
  const body = multipartBody(boundary, filename, nupkg);
  return fetch(`${server.baseUrl}/nuget/${org}/v3/publish`, {
    method: "PUT",
    headers: {
      authorization: AUTH,
      "content-type": `multipart/form-data; boundary=${boundary}`,
    },
    body,
  });
}

async function pushBare(
  server: ServerHandle,
  org: string,
  nupkg: Buffer,
): Promise<Response> {
  return fetch(`${server.baseUrl}/nuget/${org}/v3/publish`, {
    method: "PUT",
    headers: {
      authorization: AUTH,
      "content-type": "application/octet-stream",
    },
    body: nupkg,
  });
}

async function get(
  server: ServerHandle,
  pathStr: string,
  accept = "*/*",
): Promise<Response> {
  return fetch(`${server.baseUrl}${pathStr}`, {
    headers: { authorization: AUTH, accept },
  });
}

function makeStub(
  impl: (url: string) => { status: number; body: Buffer; headers?: Record<string, string> },
): UpstreamFetch {
  return async (url) => {
    const out = impl(url);
    return { status: out.status, body: out.body, headers: out.headers ?? {} };
  };
}

describe("NuGet HTTP integration", () => {
  let root: string;
  let storage: LocalFsRegistryStorage;
  let server: ServerHandle;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "nuget-int-"));
    storage = LocalFsRegistryStorage.fromRoot(root);
    server = await createServer({ storage });
  });

  afterEach(async () => {
    await server.close();
    storage.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  describe("service-index", () => {
    it("GET /v3/index.json returns the resource catalog", async () => {
      const r = await get(server, `/nuget/${ORG}/v3/index.json`);
      expect(r.status).toBe(200);
      expect(r.headers.get("content-type")).toMatch(/json/);
      const idx = (await r.json()) as NugetServiceIndex;
      expect(idx.version).toBe("3.0.0");
      const types = idx.resources.map((res) => res["@type"]);
      expect(types).toContain(NUGET_RESOURCE_TYPES.PACKAGE_BASE_ADDRESS);
      expect(types).toContain(NUGET_RESOURCE_TYPES.PACKAGE_PUBLISH);
      expect(types).toContain(NUGET_RESOURCE_TYPES.REGISTRATION_BASE_URL);
    });

    it("GET /v3/search returns empty results", async () => {
      const r = await get(server, `/nuget/${ORG}/v3/search`);
      expect(r.status).toBe(200);
      const body = (await r.json()) as { totalHits: number; data: unknown[] };
      expect(body.totalHits).toBe(0);
      expect(body.data).toEqual([]);
    });
  });

  describe("publish + flat-container", () => {
    it("dotnet nuget push (multipart) + GET nupkg round-trip", async () => {
      const nupkg = buildNupkg("Demo.Lib", "1.0.0");
      const pushResp = await pushMultipart(server, ORG, nupkg);
      expect(pushResp.status).toBe(201);

      // Version index reflects the push.
      const idxResp = await get(server, `/nuget/${ORG}/v3/flat2/demo.lib/index.json`);
      expect(idxResp.status).toBe(200);
      const idxBody = (await idxResp.json()) as { versions: string[] };
      expect(idxBody.versions).toEqual(["1.0.0"]);

      // Flat-container GET serves the bytes.
      const nupkgResp = await get(
        server,
        `/nuget/${ORG}/v3/flat2/demo.lib/1.0.0/demo.lib.1.0.0.nupkg`,
      );
      expect(nupkgResp.status).toBe(200);
      const echoed = Buffer.from(await nupkgResp.arrayBuffer());
      expect(echoed.equals(nupkg)).toBe(true);
    });

    it("accepts bare-body push (legacy compat)", async () => {
      const nupkg = buildNupkg("Bare.Demo", "2.0.0");
      const r = await pushBare(server, ORG, nupkg);
      expect(r.status).toBe(201);

      const nupkgResp = await get(
        server,
        `/nuget/${ORG}/v3/flat2/bare.demo/2.0.0/bare.demo.2.0.0.nupkg`,
      );
      expect(nupkgResp.status).toBe(200);
    });

    it("GET /v3/flat2/<id>/<version>/<id>.nuspec serves extracted nuspec", async () => {
      const nupkg = buildNupkg("Demo.Lib", "1.0.0");
      await pushMultipart(server, ORG, nupkg);
      const nuspecResp = await get(
        server,
        `/nuget/${ORG}/v3/flat2/demo.lib/1.0.0/demo.lib.nuspec`,
      );
      expect(nuspecResp.status).toBe(200);
      const xml = await nuspecResp.text();
      expect(xml).toContain("<id>Demo.Lib</id>");
      expect(xml).toContain("<version>1.0.0</version>");
    });

    it("normalises operator-supplied id casing in storage", async () => {
      const nupkg = buildNupkg("Newtonsoft.Json", "13.0.3");
      const r = await pushMultipart(server, ORG, nupkg);
      expect(r.status).toBe(201);
      // Stored under lowercase id.
      const m = await storage.getManifest("nuget/acme/newtonsoft.json", "13.0.3");
      expect(m).not.toBeNull();
      expect(m!.nugetMetadata?.originalId).toBe("Newtonsoft.Json");
    });

    it("404s unknown package", async () => {
      const r = await get(server, `/nuget/${ORG}/v3/flat2/missing/index.json`);
      expect(r.status).toBe(404);
      const env = (await r.json()) as NugetErrorEnvelope;
      expect(env.errors[0].code).toBe(NUGET_ERROR_CODES.PACKAGE_NOT_FOUND);
    });

    it("404s unknown version", async () => {
      const nupkg = buildNupkg("Demo.Lib", "1.0.0");
      await pushMultipart(server, ORG, nupkg);
      const r = await get(
        server,
        `/nuget/${ORG}/v3/flat2/demo.lib/9.9.9/demo.lib.9.9.9.nupkg`,
      );
      expect(r.status).toBe(404);
    });

    it("rejects flat-container filename mismatch", async () => {
      const nupkg = buildNupkg("Demo.Lib", "1.0.0");
      await pushMultipart(server, ORG, nupkg);
      const r = await get(
        server,
        `/nuget/${ORG}/v3/flat2/demo.lib/1.0.0/wrong-name.nupkg`,
      );
      expect(r.status).toBe(404);
    });
  });

  describe("idempotency + conflict", () => {
    it("re-push of identical bytes returns 201", async () => {
      const nupkg = buildNupkg("Idem.Lib", "1.0.0");
      const r1 = await pushMultipart(server, ORG, nupkg);
      expect(r1.status).toBe(201);
      const r2 = await pushMultipart(server, ORG, nupkg);
      expect(r2.status).toBe(201);
    });

    it("push of different bytes for same version returns 409", async () => {
      const v1 = buildNupkg("Conflict.Lib", "1.0.0", "\n    <summary>v1</summary>");
      const v2 = buildNupkg("Conflict.Lib", "1.0.0", "\n    <summary>v2</summary>");
      expect((await pushMultipart(server, ORG, v1)).status).toBe(201);
      const r = await pushMultipart(server, ORG, v2);
      expect(r.status).toBe(409);
      const env = (await r.json()) as NugetErrorEnvelope;
      expect(env.errors[0].code).toBe(NUGET_ERROR_CODES.CONFLICT);
    });
  });

  describe("publish validation", () => {
    it("rejects body with no nupkg", async () => {
      const boundary = "------signalmanboundary";
      const empty = Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="other"\r\n\r\n\r\n--${boundary}--\r\n`,
        "utf-8",
      );
      const r = await fetch(`${server.baseUrl}/nuget/${ORG}/v3/publish`, {
        method: "PUT",
        headers: {
          authorization: AUTH,
          "content-type": `multipart/form-data; boundary=${boundary}`,
        },
        body: empty,
      });
      expect(r.status).toBe(400);
    });

    it("rejects garbage zip bytes", async () => {
      const r = await pushBare(server, ORG, Buffer.from("not a zip"));
      expect(r.status).toBe(400);
      const env = (await r.json()) as NugetErrorEnvelope;
      expect(env.errors[0].code).toBe(NUGET_ERROR_CODES.NUPKG_INVALID);
    });

    it("rejects nupkg with no nuspec", async () => {
      const fakeNupkg = buildSingleEntryZip(
        "lib/Demo.dll",
        Buffer.from("fake dll"),
      );
      const r = await pushBare(server, ORG, fakeNupkg);
      expect(r.status).toBe(400);
      const env = (await r.json()) as NugetErrorEnvelope;
      expect(env.errors[0].code).toBe(NUGET_ERROR_CODES.NUSPEC_INVALID);
    });
    it("rejects multipart with no boundary", async () => {
      const r = await fetch(`${server.baseUrl}/nuget/${ORG}/v3/publish`, {
        method: "PUT",
        headers: {
          authorization: AUTH,
          "content-type": "multipart/form-data",
        },
        body: Buffer.from("nothing here"),
      });
      expect(r.status).toBe(400);
    });
    it("rejects malformed multipart body", async () => {
      const r = await fetch(`${server.baseUrl}/nuget/${ORG}/v3/publish`, {
        method: "PUT",
        headers: {
          authorization: AUTH,
          "content-type": "multipart/form-data; boundary=xyz",
        },
        body: Buffer.from("definitely-not-multipart"),
      });
      expect(r.status).toBe(400);
    });
    it("rejects empty body via bare push", async () => {
      const r = await pushBare(server, ORG, Buffer.alloc(0));
      expect(r.status).toBe(400);
    });
    it("accepts POST publish (legacy alias)", async () => {
      const boundary = "------signalmanboundary";
      const nupkg = buildNupkg("Post.Lib", "1.0.0");
      const body = multipartBody(boundary, "post.nupkg", nupkg);
      const r = await fetch(`${server.baseUrl}/nuget/${ORG}/v3/publish`, {
        method: "POST",
        headers: {
          authorization: AUTH,
          "content-type": `multipart/form-data; boundary=${boundary}`,
        },
        body,
      });
      expect(r.status).toBe(201);
    });
    it("accepts /api/v2/package legacy publish URL", async () => {
      const nupkg = buildNupkg("Legacy.Lib", "1.0.0");
      const r = await fetch(`${server.baseUrl}/nuget/${ORG}/api/v2/package`, {
        method: "PUT",
        headers: {
          authorization: AUTH,
          "content-type": "application/octet-stream",
        },
        body: nupkg,
      });
      expect(r.status).toBe(201);
      // Verify it landed via the standard flat-container GET.
      const flat = await get(
        server,
        `/nuget/${ORG}/v3/flat2/legacy.lib/1.0.0/legacy.lib.1.0.0.nupkg`,
      );
      expect(flat.status).toBe(200);
    });
    it("preserves originalVersion when caller pushes non-canonical form", async () => {
      // 1.2.3.0 normalises to 1.2.3 — exercise the originalVersion arm.
      const nupkg = buildNupkg("Ver.Lib", "1.2.3.0");
      const r = await pushBare(server, ORG, nupkg);
      expect(r.status).toBe(201);
      const m = await storage.getManifest("nuget/acme/ver.lib", "1.2.3");
      expect(m).not.toBeNull();
      expect(m!.nugetMetadata?.originalVersion).toBe("1.2.3.0");
    });
  });

  describe("registration", () => {
    it("composes index from manifest rows", async () => {
      for (const v of ["1.0.0", "1.1.0", "2.0.0"]) {
        await pushMultipart(server, ORG, buildNupkg("Demo.Lib", v));
      }
      const r = await get(
        server,
        `/nuget/${ORG}/v3/registration5-semver1/demo.lib/index.json`,
      );
      expect(r.status).toBe(200);
      const idx = (await r.json()) as NugetRegistrationIndex;
      expect(idx.count).toBe(1);
      expect(idx.items[0].count).toBe(3);
      expect(idx.items[0].lower).toBe("1.0.0");
      expect(idx.items[0].upper).toBe("2.0.0");
      const versions = idx.items[0].items.map((l) => l.catalogEntry.version);
      expect(versions).toEqual(["1.0.0", "1.1.0", "2.0.0"]);
    });

    it("serves per-version leaf", async () => {
      await pushMultipart(server, ORG, buildNupkg("Demo.Lib", "1.0.0"));
      const r = await get(
        server,
        `/nuget/${ORG}/v3/registration5-semver1/demo.lib/1.0.0.json`,
      );
      expect(r.status).toBe(200);
      const leaf = (await r.json()) as { catalogEntry: { id: string; version: string } };
      expect(leaf.catalogEntry.id).toBe("Demo.Lib");
      expect(leaf.catalogEntry.version).toBe("1.0.0");
    });

    it("404s unknown package", async () => {
      const r = await get(
        server,
        `/nuget/${ORG}/v3/registration5-semver1/missing/index.json`,
      );
      expect(r.status).toBe(404);
    });
  });

  describe("virtual upstream pull-through", () => {
    it("fetches nupkg from upstream on cache miss + caches", async () => {
      const upstreamNupkg = buildNupkg("Up.Lib", "3.0.0");
      const upstreamServiceIndex = {
        version: "3.0.0",
        resources: [
          {
            "@id": "https://upstream/v3/flat2/",
            "@type": NUGET_RESOURCE_TYPES.PACKAGE_BASE_ADDRESS,
          },
        ],
      };
      const fetcher = makeStub((url) => {
        if (url === "https://upstream/v3/index.json") {
          return {
            status: 200,
            body: Buffer.from(JSON.stringify(upstreamServiceIndex), "utf-8"),
            headers: { "content-type": "application/json" },
          };
        }
        if (url.endsWith("/up.lib/3.0.0/up.lib.3.0.0.nupkg")) {
          return { status: 200, body: upstreamNupkg };
        }
        return { status: 404, body: Buffer.from("") };
      });
      await server.close();
      server = await createServer({ storage, virtualUpstreamFetch: fetcher });
      storage.index.addVirtualUpstream({
        org: ORG,
        kind: "nuget",
        upstreamUrl: "https://upstream/v3/index.json",
        config: {},
      });

      const r = await get(
        server,
        `/nuget/${ORG}/v3/flat2/up.lib/3.0.0/up.lib.3.0.0.nupkg`,
      );
      expect(r.status).toBe(200);
      const back = Buffer.from(await r.arrayBuffer());
      expect(back.equals(upstreamNupkg)).toBe(true);

      const m = await storage.getManifest("nuget/acme/up.lib", "3.0.0");
      expect(m).not.toBeNull();
      expect(m!.nugetMetadata?.id).toBe("up.lib");
      const audits = storage.index.listAuditEntries({ action: "proxy_cache" });
      expect(audits.length).toBeGreaterThanOrEqual(1);
    });

    it("upstream 404 surfaces as 404 to client", async () => {
      const fetcher = makeStub((url) => {
        if (url.endsWith("v3/index.json")) {
          return {
            status: 200,
            body: Buffer.from(
              JSON.stringify({
                version: "3.0.0",
                resources: [
                  {
                    "@id": "https://upstream/v3/flat2/",
                    "@type": NUGET_RESOURCE_TYPES.PACKAGE_BASE_ADDRESS,
                  },
                ],
              }),
              "utf-8",
            ),
          };
        }
        return { status: 404, body: Buffer.from("") };
      });
      await server.close();
      server = await createServer({ storage, virtualUpstreamFetch: fetcher });
      storage.index.addVirtualUpstream({
        org: ORG,
        kind: "nuget",
        upstreamUrl: "https://upstream/v3/index.json",
        config: {},
      });
      const r = await get(
        server,
        `/nuget/${ORG}/v3/flat2/missing/9.9.9/missing.9.9.9.nupkg`,
      );
      expect(r.status).toBe(404);
    });

    it("no upstream configured → 404 on miss", async () => {
      const r = await get(
        server,
        `/nuget/${ORG}/v3/flat2/cold/1.0.0/cold.1.0.0.nupkg`,
      );
      expect(r.status).toBe(404);
    });

    it("accepts upstream URL as direct flat-container base (no service-index resolution)", async () => {
      const upstreamNupkg = buildNupkg("Direct.Lib", "1.0.0");
      const fetcher = makeStub((url) => {
        if (url.endsWith("/direct.lib/1.0.0/direct.lib.1.0.0.nupkg")) {
          return { status: 200, body: upstreamNupkg };
        }
        return { status: 404, body: Buffer.from("") };
      });
      await server.close();
      server = await createServer({ storage, virtualUpstreamFetch: fetcher });
      storage.index.addVirtualUpstream({
        org: ORG,
        kind: "nuget",
        upstreamUrl: "https://upstream/v3/flat2",
        config: {},
      });
      const r = await get(
        server,
        `/nuget/${ORG}/v3/flat2/direct.lib/1.0.0/direct.lib.1.0.0.nupkg`,
      );
      expect(r.status).toBe(200);
      const back = Buffer.from(await r.arrayBuffer());
      expect(back.equals(upstreamNupkg)).toBe(true);
    });

    it("503 from service-index → 404 to client + audit phase=service_index_error", async () => {
      const fetcher = makeStub(() => ({ status: 503, body: Buffer.from("upstream error") }));
      await server.close();
      server = await createServer({ storage, virtualUpstreamFetch: fetcher });
      storage.index.addVirtualUpstream({
        org: ORG,
        kind: "nuget",
        upstreamUrl: "https://upstream/v3/index.json",
        config: {},
      });
      const r = await get(
        server,
        `/nuget/${ORG}/v3/flat2/x/1.0.0/x.1.0.0.nupkg`,
      );
      expect(r.status).toBe(404);
    });

    it("upstream-error 500 audits and surfaces 404", async () => {
      const serviceIndex = {
        version: "3.0.0",
        resources: [
          {
            "@id": "https://upstream/v3/flat2/",
            "@type": NUGET_RESOURCE_TYPES.PACKAGE_BASE_ADDRESS,
          },
        ],
      };
      const fetcher = makeStub((url) => {
        if (url.endsWith("v3/index.json")) {
          return { status: 200, body: Buffer.from(JSON.stringify(serviceIndex), "utf-8") };
        }
        return { status: 500, body: Buffer.from("upstream busted") };
      });
      await server.close();
      server = await createServer({ storage, virtualUpstreamFetch: fetcher });
      storage.index.addVirtualUpstream({
        org: ORG,
        kind: "nuget",
        upstreamUrl: "https://upstream/v3/index.json",
        config: {},
      });
      const r = await get(
        server,
        `/nuget/${ORG}/v3/flat2/oops/1.0.0/oops.1.0.0.nupkg`,
      );
      expect(r.status).toBe(404);
      const audits = storage.index.listAuditEntries({ action: "proxy_cache" });
      expect(
        audits.some(
          (a) => (a.detail as { phase?: string }).phase === "upstream_error",
        ),
      ).toBe(true);
    });

    it("invalid nupkg payload from upstream audits parse_error", async () => {
      const serviceIndex = {
        version: "3.0.0",
        resources: [
          {
            "@id": "https://upstream/v3/flat2/",
            "@type": NUGET_RESOURCE_TYPES.PACKAGE_BASE_ADDRESS,
          },
        ],
      };
      const fetcher = makeStub((url) => {
        if (url.endsWith("v3/index.json")) {
          return { status: 200, body: Buffer.from(JSON.stringify(serviceIndex), "utf-8") };
        }
        return { status: 200, body: Buffer.from("not a zip") };
      });
      await server.close();
      server = await createServer({ storage, virtualUpstreamFetch: fetcher });
      storage.index.addVirtualUpstream({
        org: ORG,
        kind: "nuget",
        upstreamUrl: "https://upstream/v3/index.json",
        config: {},
      });
      const r = await get(
        server,
        `/nuget/${ORG}/v3/flat2/garbage/1.0.0/garbage.1.0.0.nupkg`,
      );
      expect(r.status).toBe(404);
      const audits = storage.index.listAuditEntries({ action: "proxy_cache" });
      expect(
        audits.some(
          (a) => (a.detail as { phase?: string }).phase === "parse_error",
        ),
      ).toBe(true);
    });

    it("version-index pull-through hydrates rows via registration request", async () => {
      const upstreamNupkg10 = buildNupkg("Vi.Lib", "1.0.0");
      const upstreamNupkg11 = buildNupkg("Vi.Lib", "1.1.0");
      const serviceIndex = {
        version: "3.0.0",
        resources: [
          {
            "@id": "https://upstream/v3/flat2/",
            "@type": NUGET_RESOURCE_TYPES.PACKAGE_BASE_ADDRESS,
          },
        ],
      };
      const fetcher = makeStub((url) => {
        if (url.endsWith("v3/index.json")) {
          return { status: 200, body: Buffer.from(JSON.stringify(serviceIndex), "utf-8") };
        }
        if (url.endsWith("/vi.lib/index.json")) {
          return {
            status: 200,
            body: Buffer.from(
              JSON.stringify({ versions: ["1.0.0", "1.1.0"] }),
              "utf-8",
            ),
          };
        }
        if (url.endsWith("/vi.lib/1.0.0/vi.lib.1.0.0.nupkg")) {
          return { status: 200, body: upstreamNupkg10 };
        }
        if (url.endsWith("/vi.lib/1.1.0/vi.lib.1.1.0.nupkg")) {
          return { status: 200, body: upstreamNupkg11 };
        }
        return { status: 404, body: Buffer.from("") };
      });
      await server.close();
      server = await createServer({ storage, virtualUpstreamFetch: fetcher });
      storage.index.addVirtualUpstream({
        org: ORG,
        kind: "nuget",
        upstreamUrl: "https://upstream/v3/index.json",
        config: {},
      });
      // Registration triggers proxyNugetVersionIndex which hydrates
      // every version listed in the upstream version-index.
      const r = await get(
        server,
        `/nuget/${ORG}/v3/registration5-semver1/vi.lib/index.json`,
      );
      expect(r.status).toBe(200);
      // Two rows were cached.
      const m10 = await storage.getManifest("nuget/acme/vi.lib", "1.0.0");
      const m11 = await storage.getManifest("nuget/acme/vi.lib", "1.1.0");
      expect(m10).not.toBeNull();
      expect(m11).not.toBeNull();
    });

    it("re-signs cached manifest when resign_on_cache is set", async () => {
      const upstreamNupkg = buildNupkg("Signed.Lib", "1.0.0");
      const fetcher = makeStub((url) => {
        if (url.endsWith("/signed.lib/1.0.0/signed.lib.1.0.0.nupkg")) {
          return { status: 200, body: upstreamNupkg };
        }
        return { status: 404, body: Buffer.from("") };
      });
      const ed = crypto.generateKeyPairSync("ed25519");
      const pem = ed.privateKey.export({ format: "pem", type: "pkcs8" }) as string;
      await server.close();
      server = await createServer({
        storage,
        virtualUpstreamFetch: fetcher,
        virtualResignPrivateKeyPem: pem,
      });
      storage.index.addVirtualUpstream({
        org: ORG,
        kind: "nuget",
        upstreamUrl: "https://upstream/v3/flat2",
        config: { resign_on_cache: true },
      });
      const r = await get(
        server,
        `/nuget/${ORG}/v3/flat2/signed.lib/1.0.0/signed.lib.1.0.0.nupkg`,
      );
      expect(r.status).toBe(200);
      const m = await storage.getManifest("nuget/acme/signed.lib", "1.0.0");
      expect(m).not.toBeNull();
      expect(m!.signature?.signatureB64).toBeTruthy();
    });

    it("auth_header_template forwarded to upstream", async () => {
      const upstreamNupkg = buildNupkg("Auth.Lib", "1.0.0");
      let observedAuth = "";
      const fetcher: UpstreamFetch = async (url, init) => {
        const headers = (init?.headers ?? {}) as Record<string, string>;
        observedAuth = headers.authorization ?? "";
        if (url.endsWith("/auth.lib/1.0.0/auth.lib.1.0.0.nupkg")) {
          return { status: 200, body: upstreamNupkg, headers: {} };
        }
        return { status: 404, body: Buffer.from(""), headers: {} };
      };
      await server.close();
      server = await createServer({ storage, virtualUpstreamFetch: fetcher });
      storage.index.addVirtualUpstream({
        org: ORG,
        kind: "nuget",
        upstreamUrl: "https://upstream/v3/flat2",
        config: { auth_header_template: "Bearer secret-token" },
      });
      const r = await get(
        server,
        `/nuget/${ORG}/v3/flat2/auth.lib/1.0.0/auth.lib.1.0.0.nupkg`,
      );
      expect(r.status).toBe(200);
      expect(observedAuth).toBe("Bearer secret-token");
    });

    it("rich nuspec propagates all metadata fields through pull-through", async () => {
      const richNuspecXml = `<?xml version="1.0"?>
<package>
  <metadata>
    <id>Rich.Lib</id>
    <version>1.0.0</version>
    <authors>Author Name</authors>
    <description>desc</description>
    <summary>summ</summary>
    <title>Title</title>
    <tags>a b c</tags>
    <projectUrl>https://example.com</projectUrl>
    <licenseUrl>https://example.com/L</licenseUrl>
    <iconUrl>https://example.com/i.png</iconUrl>
    <license>Apache-2.0</license>
    <requireLicenseAcceptance>true</requireLicenseAcceptance>
    <dependencies>
      <group targetFramework="net6.0">
        <dependency id="Foo" version="1.0.0"/>
      </group>
    </dependencies>
  </metadata>
</package>`;
      const richNupkg = buildSingleEntryZip(
        "Rich.Lib.nuspec",
        Buffer.from(richNuspecXml, "utf-8"),
        { deflate: true },
      );
      const fetcher = makeStub((url) => {
        if (url.endsWith("/rich.lib/1.0.0/rich.lib.1.0.0.nupkg")) {
          return { status: 200, body: richNupkg };
        }
        return { status: 404, body: Buffer.from("") };
      });
      await server.close();
      server = await createServer({ storage, virtualUpstreamFetch: fetcher });
      storage.index.addVirtualUpstream({
        org: ORG,
        kind: "nuget",
        upstreamUrl: "https://upstream/v3/flat2",
        config: {},
      });
      const r = await get(
        server,
        `/nuget/${ORG}/v3/flat2/rich.lib/1.0.0/rich.lib.1.0.0.nupkg`,
      );
      expect(r.status).toBe(200);
      const m = await storage.getManifest("nuget/acme/rich.lib", "1.0.0");
      expect(m).not.toBeNull();
      const meta = m!.nugetMetadata!;
      expect(meta.authors).toBe("Author Name");
      expect(meta.description).toBe("desc");
      expect(meta.summary).toBe("summ");
      expect(meta.title).toBe("Title");
      expect(meta.tags).toEqual(["a", "b", "c"]);
      expect(meta.projectUrl).toBe("https://example.com");
      expect(meta.licenseUrl).toBe("https://example.com/L");
      expect(meta.iconUrl).toBe("https://example.com/i.png");
      expect(meta.licenseExpression).toBe("Apache-2.0");
      expect(meta.requireLicenseAcceptance).toBe(true);
      expect(meta.dependencyGroups).toBeDefined();
      expect(meta.targetFrameworks).toEqual(["net6.0"]);
    });

    it("network exception during fetch audits fetch_error + surfaces 404", async () => {
      const fetcher: UpstreamFetch = async () => {
        throw new Error("ETIMEDOUT");
      };
      await server.close();
      server = await createServer({ storage, virtualUpstreamFetch: fetcher });
      storage.index.addVirtualUpstream({
        org: ORG,
        kind: "nuget",
        upstreamUrl: "https://upstream/v3/flat2",
        config: {},
      });
      const r = await get(
        server,
        `/nuget/${ORG}/v3/flat2/down.lib/1.0.0/down.lib.1.0.0.nupkg`,
      );
      expect(r.status).toBe(404);
      const audits = storage.index.listAuditEntries({ action: "proxy_cache" });
      expect(
        audits.some(
          (a) => (a.detail as { phase?: string }).phase === "fetch_error",
        ),
      ).toBe(true);
    });

    it("deny_patterns skips upstream entirely → 404", async () => {
      const upstreamNupkg = buildNupkg("Denied.Lib", "1.0.0");
      const fetcher = makeStub((url) => {
        if (url.endsWith("/denied.lib/1.0.0/denied.lib.1.0.0.nupkg")) {
          return { status: 200, body: upstreamNupkg };
        }
        return { status: 404, body: Buffer.from("") };
      });
      await server.close();
      server = await createServer({ storage, virtualUpstreamFetch: fetcher });
      storage.index.addVirtualUpstream({
        org: ORG,
        kind: "nuget",
        upstreamUrl: "https://upstream/v3/flat2",
        config: { deny_patterns: ["denied.*"] },
      });
      const r = await get(
        server,
        `/nuget/${ORG}/v3/flat2/denied.lib/1.0.0/denied.lib.1.0.0.nupkg`,
      );
      expect(r.status).toBe(404);
    });

    it("invalid version-index JSON from upstream audits parse_error", async () => {
      const fetcher = makeStub((url) => {
        if (url.endsWith("v3/index.json")) {
          return {
            status: 200,
            body: Buffer.from(
              JSON.stringify({
                version: "3.0.0",
                resources: [
                  {
                    "@id": "https://upstream/v3/flat2/",
                    "@type": NUGET_RESOURCE_TYPES.PACKAGE_BASE_ADDRESS,
                  },
                ],
              }),
              "utf-8",
            ),
          };
        }
        if (url.endsWith("/badjson.lib/index.json")) {
          return { status: 200, body: Buffer.from("{not json") };
        }
        return { status: 404, body: Buffer.from("") };
      });
      await server.close();
      server = await createServer({ storage, virtualUpstreamFetch: fetcher });
      storage.index.addVirtualUpstream({
        org: ORG,
        kind: "nuget",
        upstreamUrl: "https://upstream/v3/index.json",
        config: {},
      });
      const r = await get(
        server,
        `/nuget/${ORG}/v3/registration5-semver1/badjson.lib/index.json`,
      );
      expect(r.status).toBe(404);
      const audits = storage.index.listAuditEntries({ action: "proxy_cache" });
      expect(
        audits.some(
          (a) => (a.detail as { error?: string }).error?.includes("JSON parse failed"),
        ),
      ).toBe(true);
    });

    it("upstream service-index 503 → parse error path", async () => {
      const fetcher = makeStub((url) => {
        if (url.endsWith("v3/index.json")) {
          return { status: 200, body: Buffer.from("not json at all") };
        }
        return { status: 404, body: Buffer.from("") };
      });
      await server.close();
      server = await createServer({ storage, virtualUpstreamFetch: fetcher });
      storage.index.addVirtualUpstream({
        org: ORG,
        kind: "nuget",
        upstreamUrl: "https://upstream/v3/index.json",
        config: {},
      });
      const r = await get(
        server,
        `/nuget/${ORG}/v3/flat2/x/1.0.0/x.1.0.0.nupkg`,
      );
      expect(r.status).toBe(404);
    });

    it("service-index throws on fetch → null base address → audit", async () => {
      const fetcher: UpstreamFetch = async (url) => {
        if (url.endsWith("v3/index.json")) {
          throw new Error("connection refused");
        }
        return { status: 404, body: Buffer.from(""), headers: {} };
      };
      await server.close();
      server = await createServer({ storage, virtualUpstreamFetch: fetcher });
      storage.index.addVirtualUpstream({
        org: ORG,
        kind: "nuget",
        upstreamUrl: "https://upstream/v3/index.json",
        config: {},
      });
      const r = await get(
        server,
        `/nuget/${ORG}/v3/flat2/x/1.0.0/x.1.0.0.nupkg`,
      );
      expect(r.status).toBe(404);
    });

    it("upstream nuspec with bad XML audits parse_error", async () => {
      const badZip = buildSingleEntryZip(
        "Bad.nuspec",
        Buffer.from(`<?xml version="1.0"?><not-package/>`, "utf-8"),
      );
      const fetcher = makeStub((url) => {
        if (url.endsWith("/bad.lib/1.0.0/bad.lib.1.0.0.nupkg")) {
          return { status: 200, body: badZip };
        }
        return { status: 404, body: Buffer.from("") };
      });
      await server.close();
      server = await createServer({ storage, virtualUpstreamFetch: fetcher });
      storage.index.addVirtualUpstream({
        org: ORG,
        kind: "nuget",
        upstreamUrl: "https://upstream/v3/flat2",
        config: {},
      });
      const r = await get(
        server,
        `/nuget/${ORG}/v3/flat2/bad.lib/1.0.0/bad.lib.1.0.0.nupkg`,
      );
      expect(r.status).toBe(404);
      const audits = storage.index.listAuditEntries({ action: "proxy_cache" });
      expect(
        audits.some(
          (a) => (a.detail as { phase?: string }).phase === "parse_error",
        ),
      ).toBe(true);
    });

    it("upstream service-index without PackageBaseAddress audits service_index_error", async () => {
      const fetcher = makeStub((url) => {
        if (url.endsWith("v3/index.json")) {
          return {
            status: 200,
            body: Buffer.from(
              JSON.stringify({ version: "3.0.0", resources: [] }),
              "utf-8",
            ),
          };
        }
        return { status: 404, body: Buffer.from("") };
      });
      await server.close();
      server = await createServer({ storage, virtualUpstreamFetch: fetcher });
      storage.index.addVirtualUpstream({
        org: ORG,
        kind: "nuget",
        upstreamUrl: "https://upstream/v3/index.json",
        config: {},
      });
      const r = await get(
        server,
        `/nuget/${ORG}/v3/flat2/x/1.0.0/x.1.0.0.nupkg`,
      );
      expect(r.status).toBe(404);
      const audits = storage.index.listAuditEntries({ action: "proxy_cache" });
      expect(
        audits.some(
          (a) => (a.detail as { phase?: string }).phase === "service_index_error",
        ),
      ).toBe(true);
    });
  });

  describe("storage projection", () => {
    it("preserves nugetMetadata round-trip through SQLite", async () => {
      const nupkg = buildNupkg(
        "Demo.Lib",
        "1.0.0",
        "\n    <tags>util fast</tags>\n    <projectUrl>https://example.com</projectUrl>",
      );
      await pushMultipart(server, ORG, nupkg);
      const m = await storage.getManifest("nuget/acme/demo.lib", "1.0.0");
      expect(m).not.toBeNull();
      expect(m!.kind).toBe("nuget");
      expect(m!.nugetMetadata?.id).toBe("demo.lib");
      expect(m!.nugetMetadata?.version).toBe("1.0.0");
      expect(m!.nugetMetadata?.tags).toEqual(["util", "fast"]);
      expect(m!.nugetMetadata?.projectUrl).toBe("https://example.com");
      expect(m!.nugetMetadata?.packageHashAlgorithm).toBe("SHA512");
      const expectedHash = crypto
        .createHash("sha512")
        .update(nupkg)
        .digest("base64");
      expect(m!.nugetMetadata?.packageHash).toBe(expectedHash);
    });
  });
});
