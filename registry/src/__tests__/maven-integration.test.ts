// WS13 M2 — HTTP integration for the Maven facade.
//
// Boots a real server with LocalFsRegistryStorage. Covers:
//   - PUT/GET release artifacts (jar, pom)
//   - PUT .asc signatures accept-and-store-verbatim
//   - PUT .sha1 / .sha256 checksums (parse + verify)
//   - GET on-demand checksum endpoint
//   - GET maven-metadata.xml composed from rows
//   - GET maven-metadata.xml.<algo> computed checksum
//   - Snapshot policy: default reject (422); accept lane
//   - Idempotency: same bytes 200, different bytes on release 409
//   - Virtual upstream pull-through against a stubbed Maven Central

import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type ServerHandle } from "../http/server.js";
import { LocalFsRegistryStorage } from "../storage/registry-storage.js";
import {
  MAVEN_ERROR_CODES,
  type MavenErrorEnvelope,
} from "../maven/index.js";
import type { UpstreamFetch } from "../cargo/index.js";

const AUTH = "Bearer sk_TEST_0123456789ABCDEF";
const ORG = "acme";

async function put(
  server: ServerHandle,
  path: string,
  body: Buffer,
  contentType = "application/java-archive",
): Promise<Response> {
  return fetch(`${server.baseUrl}${path}`, {
    method: "PUT",
    headers: { authorization: AUTH, "content-type": contentType },
    body,
  });
}

async function get(
  server: ServerHandle,
  path: string,
  accept = "*/*",
): Promise<Response> {
  return fetch(`${server.baseUrl}${path}`, {
    headers: { authorization: AUTH, accept },
  });
}

function sha256Hex(b: Buffer): string {
  return crypto.createHash("sha256").update(b).digest("hex");
}

function sha1Hex(b: Buffer): string {
  return crypto.createHash("sha1").update(b).digest("hex");
}

function makeStub(impl: (url: string) => { status: number; body: Buffer; headers?: Record<string, string> }): UpstreamFetch {
  return async (url) => {
    const out = impl(url);
    return { status: out.status, body: out.body, headers: out.headers ?? {} };
  };
}

describe("Maven HTTP integration", () => {
  let root: string;
  let storage: LocalFsRegistryStorage;
  let server: ServerHandle;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "maven-int-"));
    storage = LocalFsRegistryStorage.fromRoot(root);
    server = await createServer({ storage });
  });

  afterEach(async () => {
    await server.close();
    storage.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  describe("primary artifact PUT/GET", () => {
    it("round-trips a release jar", async () => {
      const jarBytes = Buffer.from("fake-jar-bytes\nclasses inside");
      const url = `/maven/${ORG}/com/example/demo-lib/1.2.3/demo-lib-1.2.3.jar`;
      const putResp = await put(server, url, jarBytes);
      expect(putResp.status).toBe(201);

      const getResp = await get(server, url);
      expect(getResp.status).toBe(200);
      expect(getResp.headers.get("content-type")).toMatch(/java-archive/);
      const echoed = Buffer.from(await getResp.arrayBuffer());
      expect(echoed.equals(jarBytes)).toBe(true);
      expect(getResp.headers.get("etag")).toBe(`"sha256:${sha256Hex(jarBytes)}"`);
    });

    it("PUT/GET pom + jar + classifier sources jar coexist", async () => {
      const jar = Buffer.from("jar-bytes");
      const pom = Buffer.from("<project/>");
      const sources = Buffer.from("sources-jar-bytes");
      const base = `/maven/${ORG}/com/example/demo-lib/1.0.0`;
      expect((await put(server, `${base}/demo-lib-1.0.0.jar`, jar)).status).toBe(201);
      expect(
        (await put(server, `${base}/demo-lib-1.0.0.pom`, pom, "application/xml"))
          .status,
      ).toBe(201);
      expect(
        (await put(server, `${base}/demo-lib-1.0.0-sources.jar`, sources)).status,
      ).toBe(201);

      const jarResp = await get(server, `${base}/demo-lib-1.0.0.jar`);
      expect(jarResp.status).toBe(200);
      const sourcesResp = await get(server, `${base}/demo-lib-1.0.0-sources.jar`);
      const sourcesBack = Buffer.from(await sourcesResp.arrayBuffer());
      expect(sourcesBack.equals(sources)).toBe(true);
    });

    it("404 on unknown artifact", async () => {
      const r = await get(server, `/maven/${ORG}/com/example/demo-lib/1.2.3/demo-lib-1.2.3.jar`);
      expect(r.status).toBe(404);
      const env = (await r.json()) as MavenErrorEnvelope;
      expect(env.errors[0].code).toBe(MAVEN_ERROR_CODES.ARTIFACT_NOT_FOUND);
    });

    it("idempotent re-PUT of identical bytes returns 200", async () => {
      const url = `/maven/${ORG}/com/example/demo/1.0.0/demo-1.0.0.jar`;
      const bytes = Buffer.from("idempotent-bytes");
      expect((await put(server, url, bytes)).status).toBe(201);
      expect((await put(server, url, bytes)).status).toBe(200);
    });

    it("PUT of different bytes on release returns 409", async () => {
      const url = `/maven/${ORG}/com/example/demo/2.0.0/demo-2.0.0.jar`;
      expect((await put(server, url, Buffer.from("v1"))).status).toBe(201);
      const r = await put(server, url, Buffer.from("v2"));
      expect(r.status).toBe(409);
      const env = (await r.json()) as MavenErrorEnvelope;
      expect(env.errors[0].code).toBe(MAVEN_ERROR_CODES.CONFLICT);
    });
  });

  describe("signature + checksum", () => {
    it("PUTs .asc signature stored verbatim", async () => {
      const jar = Buffer.from("payload");
      const sig = Buffer.from("-----BEGIN PGP SIGNATURE-----\n...fake...\n-----END PGP SIGNATURE-----\n");
      const base = `/maven/${ORG}/com/example/sig-demo/1.0.0`;
      expect((await put(server, `${base}/sig-demo-1.0.0.jar`, jar)).status).toBe(201);
      const ascResp = await put(
        server,
        `${base}/sig-demo-1.0.0.jar.asc`,
        sig,
        "text/plain",
      );
      expect(ascResp.status).toBe(201);
      const back = await get(server, `${base}/sig-demo-1.0.0.jar.asc`);
      expect(back.status).toBe(200);
      const echoed = Buffer.from(await back.arrayBuffer());
      expect(echoed.equals(sig)).toBe(true);
    });

    it("PUTs .sha1 checksum + reads it back", async () => {
      const jar = Buffer.from("sha1-test-payload");
      const base = `/maven/${ORG}/com/example/sha1-demo/1.0.0`;
      expect((await put(server, `${base}/sha1-demo-1.0.0.jar`, jar)).status).toBe(201);
      const sha1 = sha1Hex(jar);
      const sha1Resp = await put(
        server,
        `${base}/sha1-demo-1.0.0.jar.sha1`,
        Buffer.from(sha1, "utf-8"),
        "text/plain",
      );
      expect(sha1Resp.status).toBe(201);
      const back = await get(server, `${base}/sha1-demo-1.0.0.jar.sha1`);
      expect(back.status).toBe(200);
      const text = await back.text();
      expect(text.trim()).toBe(sha1);
    });

    it("rejects sha256 PUT that doesn't match the server digest", async () => {
      const jar = Buffer.from("mismatch-payload");
      const base = `/maven/${ORG}/com/example/mm-demo/1.0.0`;
      expect((await put(server, `${base}/mm-demo-1.0.0.jar`, jar)).status).toBe(201);
      // Operator-supplied sha256 that doesn't match server's.
      const bogus = "0".repeat(64);
      const r = await put(
        server,
        `${base}/mm-demo-1.0.0.jar.sha256`,
        Buffer.from(bogus, "utf-8"),
        "text/plain",
      );
      expect(r.status).toBe(400);
      const env = (await r.json()) as MavenErrorEnvelope;
      expect(env.errors[0].code).toBe(MAVEN_ERROR_CODES.UPLOAD_INVALID);
    });

    it("on-demand checksum: GET .sha1 with no row computes from blob", async () => {
      const jar = Buffer.from("compute-on-demand-payload");
      const base = `/maven/${ORG}/com/example/od-demo/1.0.0`;
      expect((await put(server, `${base}/od-demo-1.0.0.jar`, jar)).status).toBe(201);
      const r = await get(server, `${base}/od-demo-1.0.0.jar.sha1`);
      expect(r.status).toBe(200);
      const text = await r.text();
      expect(text).toBe(sha1Hex(jar));
    });

    it("on-demand sha256 reuses stored blob digest", async () => {
      const jar = Buffer.from("od-sha256-payload");
      const base = `/maven/${ORG}/com/example/od-demo/1.0.0`;
      expect((await put(server, `${base}/od-demo-1.0.0.jar`, jar)).status).toBe(201);
      const r = await get(server, `${base}/od-demo-1.0.0.jar.sha256`);
      expect(r.status).toBe(200);
      const text = await r.text();
      expect(text).toBe(sha256Hex(jar));
    });
  });

  describe("snapshot policy", () => {
    it("default policy rejects snapshot PUT with 422", async () => {
      const url = `/maven/${ORG}/com/example/snap/1.0-SNAPSHOT/snap-1.0-20260517.120000-1.jar`;
      const r = await put(server, url, Buffer.from("snap-bytes"));
      expect(r.status).toBe(422);
      const env = (await r.json()) as MavenErrorEnvelope;
      expect(env.errors[0].code).toBe(MAVEN_ERROR_CODES.SNAPSHOT_REFUSED);
    });
  });

  describe("maven-metadata.xml on-demand", () => {
    beforeEach(async () => {
      // Stage three release versions.
      for (const v of ["1.0.0", "1.1.0", "1.2.0"]) {
        const url = `/maven/${ORG}/com/example/m-demo/${v}/m-demo-${v}.jar`;
        await put(server, url, Buffer.from(`m-demo-${v}-bytes`));
      }
    });
    it("composes artifact metadata XML", async () => {
      const r = await get(
        server,
        `/maven/${ORG}/com/example/m-demo/maven-metadata.xml`,
      );
      expect(r.status).toBe(200);
      expect(r.headers.get("content-type")).toMatch(/xml/);
      const xml = await r.text();
      expect(xml).toContain("<groupId>com.example</groupId>");
      expect(xml).toContain("<artifactId>m-demo</artifactId>");
      expect(xml).toContain("<version>1.0.0</version>");
      expect(xml).toContain("<version>1.1.0</version>");
      expect(xml).toContain("<version>1.2.0</version>");
      expect(xml).toContain("<release>1.2.0</release>");
      expect(xml).toContain("<latest>1.2.0</latest>");
    });
    it("computes maven-metadata.xml.sha1 from composed XML", async () => {
      const xmlResp = await get(
        server,
        `/maven/${ORG}/com/example/m-demo/maven-metadata.xml`,
      );
      const xml = await xmlResp.text();
      const expected = sha1Hex(Buffer.from(xml, "utf-8"));
      const r = await get(
        server,
        `/maven/${ORG}/com/example/m-demo/maven-metadata.xml.sha1`,
      );
      expect(r.status).toBe(200);
      expect(await r.text()).toBe(expected);
    });
    it("404 when no rows", async () => {
      const r = await get(
        server,
        `/maven/${ORG}/com/example/nothing-here/maven-metadata.xml`,
      );
      expect(r.status).toBe(404);
    });
  });

  describe("metadata writes refused", () => {
    it("rejects PUT to maven-metadata.xml", async () => {
      const url = `/maven/${ORG}/com/example/m-demo/maven-metadata.xml`;
      const r = await put(server, url, Buffer.from("<metadata/>"), "application/xml");
      expect(r.status).toBe(400);
      const env = (await r.json()) as MavenErrorEnvelope;
      expect(env.errors[0].code).toBe(MAVEN_ERROR_CODES.UPLOAD_INVALID);
    });
  });

  describe("virtual upstream pull-through", () => {
    it("on GET miss, fetches upstream jar + caches", async () => {
      const upstreamJar = Buffer.from("upstream-jar-bytes");
      const fetcher = makeStub((url) => {
        if (url.endsWith("/com/upstream/lib/2.0.0/lib-2.0.0.jar")) {
          return {
            status: 200,
            headers: { "content-type": "application/java-archive" },
            body: upstreamJar,
          };
        }
        return { status: 404, body: Buffer.from("") };
      });
      await server.close();
      server = await createServer({ storage, virtualUpstreamFetch: fetcher });
      storage.index.addVirtualUpstream({
        org: ORG,
        kind: "maven",
        upstreamUrl: "https://repo.maven.apache.org/maven2",
        config: {},
      });

      const r = await get(
        server,
        `/maven/${ORG}/com/upstream/lib/2.0.0/lib-2.0.0.jar`,
      );
      expect(r.status).toBe(200);
      const back = Buffer.from(await r.arrayBuffer());
      expect(back.equals(upstreamJar)).toBe(true);

      // Cached: subsequent GET works even without the fetcher.
      const cachedManifest = await storage.getManifest(
        "maven/acme/com.upstream/lib",
        "lib-2.0.0.jar",
      );
      expect(cachedManifest).not.toBeNull();
      const audits = storage.index.listAuditEntries({ action: "proxy_cache" });
      expect(audits.length).toBeGreaterThanOrEqual(1);
    });

    it("upstream 404 → registry 404", async () => {
      const fetcher = makeStub(() => ({ status: 404, body: Buffer.from("") }));
      await server.close();
      server = await createServer({ storage, virtualUpstreamFetch: fetcher });
      storage.index.addVirtualUpstream({
        org: ORG,
        kind: "maven",
        upstreamUrl: "https://repo.maven.apache.org/maven2",
        config: {},
      });
      const r = await get(
        server,
        `/maven/${ORG}/com/missing/lib/1.0.0/lib-1.0.0.jar`,
      );
      expect(r.status).toBe(404);
    });

    it("no upstream configured → 404", async () => {
      const r = await get(
        server,
        `/maven/${ORG}/com/nonexistent/lib/1.0.0/lib-1.0.0.jar`,
      );
      expect(r.status).toBe(404);
    });

    it("snapshot pull-through gated by upstream snapshot_policy", async () => {
      // No upstream allows snapshots → 404 even when fetcher would
      // happily serve.
      const fetcher = makeStub((url) => ({
        status: 200,
        body: Buffer.from("upstream-snap"),
        headers: {},
      }));
      await server.close();
      server = await createServer({ storage, virtualUpstreamFetch: fetcher });
      storage.index.addVirtualUpstream({
        org: ORG,
        kind: "maven",
        upstreamUrl: "https://repo.example.com",
        config: {},
      });
      const r = await get(
        server,
        `/maven/${ORG}/com/snaps/lib/1.0-SNAPSHOT/lib-1.0-20260517.120000-1.jar`,
      );
      expect(r.status).toBe(404);
    });

    it("snapshot pull-through with snapshot_policy: accept", async () => {
      const snapJar = Buffer.from("snap-upstream-bytes");
      const fetcher = makeStub((url) => {
        if (url.endsWith("/com/snaps/lib/1.0-SNAPSHOT/lib-1.0-20260517.120000-1.jar")) {
          return { status: 200, body: snapJar, headers: {} };
        }
        return { status: 404, body: Buffer.from("") };
      });
      await server.close();
      server = await createServer({ storage, virtualUpstreamFetch: fetcher });
      storage.index.addVirtualUpstream({
        org: ORG,
        kind: "maven",
        upstreamUrl: "https://repo.example.com",
        config: { snapshot_policy: "accept" },
      });
      const r = await get(
        server,
        `/maven/${ORG}/com/snaps/lib/1.0-SNAPSHOT/lib-1.0-20260517.120000-1.jar`,
      );
      expect(r.status).toBe(200);
      const back = Buffer.from(await r.arrayBuffer());
      expect(back.equals(snapJar)).toBe(true);
    });
  });
});
