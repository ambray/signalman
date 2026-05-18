// WS13 M2.1 — Maven metadata pull-through integration.
//
// Covers the proxyMetadata path that landed in 54fae26: on a
// cache miss for `maven-metadata.xml`, the registry fetches the
// upstream's metadata, parses it, stubs manifest rows, and serves
// composed-from-stubs metadata. Subsequent per-file GETs hydrate
// blobs lazily via the existing artifact pull-through.

import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type ServerHandle } from "../http/server.js";
import { LocalFsRegistryStorage } from "../storage/registry-storage.js";
import type { UpstreamFetch } from "../cargo/index.js";

const AUTH = "Bearer sk_TEST_0123456789ABCDEF";
const ORG = "acme";

function makeStub(
  impl: (url: string) => {
    status: number;
    body: Buffer;
    headers?: Record<string, string>;
  },
): UpstreamFetch {
  return async (url) => {
    const out = impl(url);
    return { status: out.status, body: out.body, headers: out.headers ?? {} };
  };
}

async function get(server: ServerHandle, p: string): Promise<Response> {
  return fetch(`${server.baseUrl}${p}`, {
    headers: { authorization: AUTH, accept: "*/*" },
  });
}

const upstreamMetadataXml = `<?xml version="1.0" encoding="UTF-8"?>
<metadata>
  <groupId>com.upstream</groupId>
  <artifactId>lib</artifactId>
  <versioning>
    <latest>2.0.0</latest>
    <release>2.0.0</release>
    <versions>
      <version>1.0.0</version>
      <version>1.5.0</version>
      <version>2.0.0</version>
    </versions>
    <lastUpdated>20260517123456</lastUpdated>
  </versioning>
</metadata>`;

const upstreamSnapshotXml = `<?xml version="1.0" encoding="UTF-8"?>
<metadata>
  <groupId>com.upstream</groupId>
  <artifactId>snap-lib</artifactId>
  <version>3.0.0-SNAPSHOT</version>
  <versioning>
    <snapshot>
      <timestamp>20260517.123456</timestamp>
      <buildNumber>7</buildNumber>
    </snapshot>
    <lastUpdated>20260517123456</lastUpdated>
    <snapshotVersions>
      <snapshotVersion>
        <extension>jar</extension>
        <value>3.0.0-20260517.123456-7</value>
      </snapshotVersion>
      <snapshotVersion>
        <classifier>sources</classifier>
        <extension>jar</extension>
        <value>3.0.0-20260517.123456-7</value>
      </snapshotVersion>
      <snapshotVersion>
        <extension>pom</extension>
        <value>3.0.0-20260517.123456-7</value>
      </snapshotVersion>
    </snapshotVersions>
  </versioning>
</metadata>`;

describe("Maven metadata pull-through", () => {
  let root: string;
  let storage: LocalFsRegistryStorage;
  let server: ServerHandle;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "mvn-md-pt-"));
    storage = LocalFsRegistryStorage.fromRoot(root);
  });

  afterEach(async () => {
    await server?.close();
    storage.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("on cache miss, fetches upstream maven-metadata.xml + composes from stubs", async () => {
    const fetcher = makeStub((url) => {
      if (url.endsWith("/com/upstream/lib/maven-metadata.xml")) {
        return {
          status: 200,
          headers: { "content-type": "application/xml" },
          body: Buffer.from(upstreamMetadataXml),
        };
      }
      return { status: 404, body: Buffer.from("") };
    });
    server = await createServer({ storage, virtualUpstreamFetch: fetcher });
    storage.index.addVirtualUpstream({
      org: ORG,
      kind: "maven",
      upstreamUrl: "https://repo.maven.apache.org/maven2",
      config: {},
    });

    const r = await get(
      server,
      `/maven/${ORG}/com/upstream/lib/maven-metadata.xml`,
    );
    expect(r.status).toBe(200);
    const xml = await r.text();
    expect(xml).toContain("<groupId>com.upstream</groupId>");
    expect(xml).toContain("<artifactId>lib</artifactId>");
    expect(xml).toContain("<version>1.0.0</version>");
    expect(xml).toContain("<version>1.5.0</version>");
    expect(xml).toContain("<version>2.0.0</version>");
    expect(xml).toContain("<release>2.0.0</release>");

    // Stub rows persisted under the storage manifest name.
    const rows = await storage.listManifestVersions("maven/acme/com.upstream/lib");
    expect(rows.map((r) => r.version).sort()).toEqual(["1.0.0", "1.5.0", "2.0.0"]);

    // Audit row recorded.
    const audits = storage.index.listAuditEntries({ action: "proxy_cache" });
    const metadataAudit = audits.find(
      (a) => a.detail && (a.detail as { phase?: string }).phase === "artifact_metadata_cached",
    );
    expect(metadataAudit).toBeDefined();
  });

  it("subsequent per-file GET hydrates the blob lazily via proxyArtifact", async () => {
    const upstreamJar = Buffer.from("upstream-lib-2.0.0-jar-bytes");
    const fetcher = makeStub((url) => {
      if (url.endsWith("/com/upstream/lib/maven-metadata.xml")) {
        return {
          status: 200,
          headers: { "content-type": "application/xml" },
          body: Buffer.from(upstreamMetadataXml),
        };
      }
      if (url.endsWith("/com/upstream/lib/2.0.0/lib-2.0.0.jar")) {
        return {
          status: 200,
          headers: { "content-type": "application/java-archive" },
          body: upstreamJar,
        };
      }
      return { status: 404, body: Buffer.from("") };
    });
    server = await createServer({ storage, virtualUpstreamFetch: fetcher });
    storage.index.addVirtualUpstream({
      org: ORG,
      kind: "maven",
      upstreamUrl: "https://repo.maven.apache.org/maven2",
      config: {},
    });

    // Prime the metadata cache.
    const md = await get(
      server,
      `/maven/${ORG}/com/upstream/lib/maven-metadata.xml`,
    );
    expect(md.status).toBe(200);

    // Now fetch a specific file — stub row at key "2.0.0" exists,
    // but per-file lookup by filename returns null, so proxyArtifact
    // fires.
    const fileResp = await get(
      server,
      `/maven/${ORG}/com/upstream/lib/2.0.0/lib-2.0.0.jar`,
    );
    expect(fileResp.status).toBe(200);
    const back = Buffer.from(await fileResp.arrayBuffer());
    expect(back.equals(upstreamJar)).toBe(true);

    // Real artifact row persists alongside the stub.
    const m = await storage.getManifest(
      "maven/acme/com.upstream/lib",
      "lib-2.0.0.jar",
    );
    expect(m).not.toBeNull();
    expect(m?.blobs.length).toBe(1);
  });

  it("404 when no upstream covers the artifact", async () => {
    const fetcher = makeStub(() => ({ status: 404, body: Buffer.from("") }));
    server = await createServer({ storage, virtualUpstreamFetch: fetcher });
    storage.index.addVirtualUpstream({
      org: ORG,
      kind: "maven",
      upstreamUrl: "https://repo.maven.apache.org/maven2",
      config: {},
    });
    const r = await get(
      server,
      `/maven/${ORG}/com/upstream/missing/maven-metadata.xml`,
    );
    expect(r.status).toBe(404);
  });

  it("404 when no upstream is configured", async () => {
    server = await createServer({ storage });
    const r = await get(
      server,
      `/maven/${ORG}/com/upstream/lib/maven-metadata.xml`,
    );
    expect(r.status).toBe(404);
  });

  it("snapshot metadata pull-through gated by snapshot_policy", async () => {
    const fetcher = makeStub((url) => {
      if (url.endsWith("/com/upstream/snap-lib/3.0.0-SNAPSHOT/maven-metadata.xml")) {
        return {
          status: 200,
          headers: { "content-type": "application/xml" },
          body: Buffer.from(upstreamSnapshotXml),
        };
      }
      return { status: 404, body: Buffer.from("") };
    });
    server = await createServer({ storage, virtualUpstreamFetch: fetcher });
    storage.index.addVirtualUpstream({
      org: ORG,
      kind: "maven",
      upstreamUrl: "https://repo.example.com",
      config: {}, // snapshot_policy defaults to reject
    });
    const r = await get(
      server,
      `/maven/${ORG}/com/upstream/snap-lib/3.0.0-SNAPSHOT/maven-metadata.xml`,
    );
    expect(r.status).toBe(404);
  });

  it("snapshot metadata pull-through with snapshot_policy: accept", async () => {
    const fetcher = makeStub((url) => {
      if (url.endsWith("/com/upstream/snap-lib/3.0.0-SNAPSHOT/maven-metadata.xml")) {
        return {
          status: 200,
          headers: { "content-type": "application/xml" },
          body: Buffer.from(upstreamSnapshotXml),
        };
      }
      return { status: 404, body: Buffer.from("") };
    });
    server = await createServer({ storage, virtualUpstreamFetch: fetcher });
    storage.index.addVirtualUpstream({
      org: ORG,
      kind: "maven",
      upstreamUrl: "https://repo.example.com",
      config: { snapshot_policy: "accept" },
    });

    const r = await get(
      server,
      `/maven/${ORG}/com/upstream/snap-lib/3.0.0-SNAPSHOT/maven-metadata.xml`,
    );
    expect(r.status).toBe(200);
    const xml = await r.text();
    expect(xml).toContain("<version>3.0.0-SNAPSHOT</version>");
    expect(xml).toContain("<timestamp>20260517.123456</timestamp>");
    expect(xml).toContain("<buildNumber>7</buildNumber>");
    expect(xml).toContain("<snapshotVersions>");
    expect(xml).toContain("<extension>jar</extension>");
    expect(xml).toContain("<value>3.0.0-20260517.123456-7</value>");
    expect(xml).toContain("<classifier>sources</classifier>");
    expect(xml).toContain("<extension>pom</extension>");

    // Audit row recorded with the snapshot phase.
    const audits = storage.index.listAuditEntries({ action: "proxy_cache" });
    const snap = audits.find(
      (a) => a.detail && (a.detail as { phase?: string }).phase === "snapshot_metadata_cached",
    );
    expect(snap).toBeDefined();
  });

  it("upstream returns 500 → registry 404 (silently degrades)", async () => {
    const fetcher = makeStub(() => ({ status: 500, body: Buffer.from("oops") }));
    server = await createServer({ storage, virtualUpstreamFetch: fetcher });
    storage.index.addVirtualUpstream({
      org: ORG,
      kind: "maven",
      upstreamUrl: "https://repo.broken.example.com",
      config: {},
    });
    const r = await get(
      server,
      `/maven/${ORG}/com/upstream/lib/maven-metadata.xml`,
    );
    expect(r.status).toBe(404);
    // Audit logs upstream_error
    const audits = storage.index.listAuditEntries({ action: "proxy_cache" });
    const errAudit = audits.find(
      (a) =>
        a.detail &&
        (a.detail as { phase?: string }).phase === "metadata_upstream_error",
    );
    expect(errAudit).toBeDefined();
  });

  it("malformed upstream XML → registry 404 + audit", async () => {
    const fetcher = makeStub(() => ({
      status: 200,
      body: Buffer.from("<this is not metadata>"),
    }));
    server = await createServer({ storage, virtualUpstreamFetch: fetcher });
    storage.index.addVirtualUpstream({
      org: ORG,
      kind: "maven",
      upstreamUrl: "https://repo.example.com",
      config: {},
    });
    const r = await get(
      server,
      `/maven/${ORG}/com/upstream/lib/maven-metadata.xml`,
    );
    expect(r.status).toBe(404);
    const audits = storage.index.listAuditEntries({ action: "proxy_cache" });
    const parseAudit = audits.find(
      (a) =>
        a.detail &&
        (a.detail as { phase?: string }).phase === "metadata_parse_error",
    );
    expect(parseAudit).toBeDefined();
  });

  it("re-runs are idempotent (existing stub rows are kept)", async () => {
    const fetcher = makeStub((url) => {
      if (url.endsWith("/com/upstream/lib/maven-metadata.xml")) {
        return {
          status: 200,
          headers: { "content-type": "application/xml" },
          body: Buffer.from(upstreamMetadataXml),
        };
      }
      return { status: 404, body: Buffer.from("") };
    });
    server = await createServer({ storage, virtualUpstreamFetch: fetcher });
    storage.index.addVirtualUpstream({
      org: ORG,
      kind: "maven",
      upstreamUrl: "https://repo.maven.apache.org/maven2",
      config: {},
    });
    // First call seeds 3 stubs.
    expect((await get(server, `/maven/${ORG}/com/upstream/lib/maven-metadata.xml`)).status).toBe(200);
    const rows1 = await storage.listManifestVersions("maven/acme/com.upstream/lib");
    expect(rows1.length).toBe(3);
    // Second call: no duplicate rows.
    expect((await get(server, `/maven/${ORG}/com/upstream/lib/maven-metadata.xml`)).status).toBe(200);
    const rows2 = await storage.listManifestVersions("maven/acme/com.upstream/lib");
    expect(rows2.length).toBe(3);
  });
});
