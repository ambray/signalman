// WS10 M5 — end-to-end virtual pull-through against a stubbed
// Docker Hub upstream.
//
// Covers: cache-miss → upstream fetch → content-addressed store →
// audit row → cached on subsequent request. Plus the negative paths
// (404 upstream, digest mismatch, no virtual upstream configured,
// allow/deny pattern, manifest re-sign attempt + audit).

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createServer, type ServerHandle } from "../http/server.js";
import { LocalFsRegistryStorage } from "../storage/registry-storage.js";
import { generateKeypair } from "../signing.js";
import {
  OCI_MEDIA_TYPES,
  type UpstreamFetchResult,
} from "../oci/index.js";
import type { UpstreamFetch } from "../cargo/index.js";

const AUTH = "Bearer sk_TEST_0123456789ABCDEF";

interface StubInvocation {
  url: string;
  method?: string;
  headers?: Record<string, string>;
}

function makeStub(
  responder: (url: string, headers?: Record<string, string>) => UpstreamFetchResult,
): { fetch: UpstreamFetch; invocations: StubInvocation[] } {
  const invocations: StubInvocation[] = [];
  const fetch: UpstreamFetch = async (url, init) => {
    invocations.push({
      url,
      ...(init?.method ? { method: init.method } : {}),
      ...(init?.headers ? { headers: init.headers } : {}),
    });
    return responder(url, init?.headers);
  };
  return { fetch, invocations };
}

describe("OCI virtual pull-through (stubbed Docker Hub)", () => {
  let root: string;
  let storage: LocalFsRegistryStorage;
  let server: ServerHandle;
  let signingKey: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "oci-virtual-"));
    storage = LocalFsRegistryStorage.fromRoot(root);
    signingKey = generateKeypair().privateKeyPem;
  });

  afterEach(async () => {
    await server?.close();
    storage.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("proxies a tag-based manifest GET on cache miss + caches it", async () => {
    // Compose a tiny single-platform manifest. The body is the literal
    // bytes the upstream serves.
    const configBytes = Buffer.from(
      JSON.stringify({ architecture: "amd64", os: "linux" }),
    );
    const layerBytes = Buffer.from("layer-bytes-from-upstream");
    const configDigest = `sha256:${crypto.createHash("sha256").update(configBytes).digest("hex")}`;
    const layerDigest = `sha256:${crypto.createHash("sha256").update(layerBytes).digest("hex")}`;
    const manifestBody = Buffer.from(
      JSON.stringify({
        schemaVersion: 2,
        mediaType: OCI_MEDIA_TYPES.MANIFEST_V1,
        config: {
          mediaType: OCI_MEDIA_TYPES.CONFIG_V1,
          digest: configDigest,
          size: configBytes.length,
        },
        layers: [
          {
            mediaType: OCI_MEDIA_TYPES.LAYER_TAR_GZIP,
            digest: layerDigest,
            size: layerBytes.length,
          },
        ],
      }),
      "utf-8",
    );
    const manifestDigestHex = crypto
      .createHash("sha256")
      .update(manifestBody)
      .digest("hex");

    const { fetch, invocations } = makeStub((url) => {
      // Token endpoint
      if (url.includes("auth.docker.io/token")) {
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: Buffer.from(JSON.stringify({ token: "test-token" })),
        };
      }
      if (url.endsWith("/v2/library/alpine/manifests/3.20")) {
        return {
          status: 200,
          headers: {
            "content-type": OCI_MEDIA_TYPES.MANIFEST_V1,
            "docker-content-digest": `sha256:${manifestDigestHex}`,
          },
          body: manifestBody,
        };
      }
      if (url.endsWith(`/v2/library/alpine/blobs/${configDigest}`)) {
        return {
          status: 200,
          headers: { "content-type": OCI_MEDIA_TYPES.CONFIG_V1 },
          body: configBytes,
        };
      }
      if (url.endsWith(`/v2/library/alpine/blobs/${layerDigest}`)) {
        return {
          status: 200,
          headers: { "content-type": OCI_MEDIA_TYPES.LAYER_TAR_GZIP },
          body: layerBytes,
        };
      }
      return { status: 404, headers: {}, body: Buffer.from("") };
    });

    server = await createServer({
      storage,
      ociReaperIntervalMs: 60 * 60 * 1000,
      virtualUpstreamFetch: fetch,
      virtualResignPrivateKeyPem: signingKey,
    });

    // Configure the virtual upstream row directly via the storage API.
    storage.index.addVirtualUpstream({
      org: "acme",
      kind: "oci",
      upstreamUrl: "https://registry-1.docker.io",
      config: {
        upstream_flavor: "dockerhub",
        upstream_repo_template: "library/{repo}",
        resign_on_cache: true,
      },
    });

    // Client requests a tag-based manifest. The registry has nothing
    // locally; the proxy should fire.
    const r = await fetch_(server, "GET", "/v2/acme/alpine/manifests/3.20");
    expect(r.status).toBe(200);
    expect(r.headers.get("docker-content-digest")).toBe(
      `sha256:${manifestDigestHex}`,
    );
    expect(r.headers.get("content-type")).toBe(OCI_MEDIA_TYPES.MANIFEST_V1);
    const body = Buffer.from(await r.arrayBuffer());
    expect(body.equals(manifestBody)).toBe(true);

    // The upstream was called for token + manifest. (Blobs are pulled
    // separately on demand by the client.)
    expect(invocations.some((i) => i.url.includes("auth.docker.io/token"))).toBe(
      true,
    );
    expect(
      invocations.some((i) =>
        i.url.endsWith("/v2/library/alpine/manifests/3.20"),
      ),
    ).toBe(true);

    // Audit row recorded.
    const audits = storage.index.listAuditEntries({
      action: "proxy_cache",
      entityType: "manifest",
    });
    expect(audits.length).toBeGreaterThanOrEqual(1);
    const entry = audits.find(
      (e) => e.entityId === `oci/acme/alpine@sha256:${manifestDigestHex}`,
    );
    expect(entry).toBeDefined();
    expect(entry?.detail).toMatchObject({
      kind: "oci",
      upstream_flavor: "dockerhub",
      upstream_repo: "library/alpine",
      ref_kind: "tag",
      ref_value: "3.20",
      resigned: true,
    });

    // A second GET for the same tag is served from cache (no upstream call).
    const invocationsBefore = invocations.length;
    const r2 = await fetch_(server, "GET", "/v2/acme/alpine/manifests/3.20");
    expect(r2.status).toBe(200);
    // Token endpoint + manifest endpoint should NOT be re-called.
    expect(invocations.length).toBe(invocationsBefore);
  });

  it("proxies a blob GET on cache miss", async () => {
    const layerBytes = Buffer.from("just-the-layer");
    const layerHex = crypto.createHash("sha256").update(layerBytes).digest("hex");

    const { fetch } = makeStub((url) => {
      if (url.includes("auth.docker.io/token")) {
        return {
          status: 200,
          headers: {},
          body: Buffer.from(JSON.stringify({ token: "t" })),
        };
      }
      if (url.endsWith(`/v2/library/alpine/blobs/sha256:${layerHex}`)) {
        return {
          status: 200,
          headers: { "content-type": OCI_MEDIA_TYPES.LAYER_TAR_GZIP },
          body: layerBytes,
        };
      }
      return { status: 404, headers: {}, body: Buffer.from("") };
    });

    server = await createServer({
      storage,
      ociReaperIntervalMs: 60 * 60 * 1000,
      virtualUpstreamFetch: fetch,
    });
    storage.index.addVirtualUpstream({
      org: "acme",
      kind: "oci",
      upstreamUrl: "https://registry-1.docker.io",
      config: {
        upstream_flavor: "dockerhub",
        upstream_repo_template: "library/{repo}",
      },
    });

    const r = await fetch_(
      server,
      "GET",
      `/v2/acme/alpine/blobs/sha256:${layerHex}`,
    );
    expect(r.status).toBe(200);
    const body = Buffer.from(await r.arrayBuffer());
    expect(body.equals(layerBytes)).toBe(true);
    expect(r.headers.get("docker-content-digest")).toBe(`sha256:${layerHex}`);

    const audits = storage.index.listAuditEntries({
      action: "proxy_cache",
      entityType: "blob",
    });
    expect(audits.length).toBeGreaterThanOrEqual(1);
  });

  it("falls back to 404 MANIFEST_UNKNOWN when no upstream is configured", async () => {
    server = await createServer({
      storage,
      ociReaperIntervalMs: 60 * 60 * 1000,
    });
    const r = await fetch_(server, "GET", "/v2/acme/alpine/manifests/3.20");
    expect(r.status).toBe(404);
  });

  it("falls back to 404 when upstream returns 404", async () => {
    const { fetch } = makeStub((url) => {
      if (url.includes("auth.docker.io/token")) {
        return {
          status: 200,
          headers: {},
          body: Buffer.from(JSON.stringify({ token: "t" })),
        };
      }
      return { status: 404, headers: {}, body: Buffer.from("") };
    });
    server = await createServer({
      storage,
      ociReaperIntervalMs: 60 * 60 * 1000,
      virtualUpstreamFetch: fetch,
    });
    storage.index.addVirtualUpstream({
      org: "acme",
      kind: "oci",
      upstreamUrl: "https://registry-1.docker.io",
      config: {
        upstream_flavor: "dockerhub",
        upstream_repo_template: "library/{repo}",
      },
    });
    const r = await fetch_(server, "GET", "/v2/acme/alpine/manifests/missing");
    expect(r.status).toBe(404);
  });

  it("refuses an upstream whose Docker-Content-Digest disagrees with the body", async () => {
    const body = Buffer.from(
      JSON.stringify({
        schemaVersion: 2,
        mediaType: OCI_MEDIA_TYPES.MANIFEST_V1,
      }),
    );
    const { fetch } = makeStub((url) => {
      if (url.includes("auth.docker.io/token")) {
        return {
          status: 200,
          headers: {},
          body: Buffer.from(JSON.stringify({ token: "t" })),
        };
      }
      return {
        status: 200,
        headers: {
          "content-type": OCI_MEDIA_TYPES.MANIFEST_V1,
          "docker-content-digest": `sha256:${"0".repeat(64)}`,
        },
        body,
      };
    });
    server = await createServer({
      storage,
      ociReaperIntervalMs: 60 * 60 * 1000,
      virtualUpstreamFetch: fetch,
    });
    storage.index.addVirtualUpstream({
      org: "acme",
      kind: "oci",
      upstreamUrl: "https://registry-1.docker.io",
      config: {
        upstream_flavor: "dockerhub",
        upstream_repo_template: "library/{repo}",
      },
    });
    const r = await fetch_(server, "GET", "/v2/acme/alpine/manifests/bad-dcd");
    expect(r.status).toBe(404);
    const audits = storage.index.listAuditEntries({ action: "proxy_cache" });
    const mismatch = audits.find(
      (a) => (a.detail as { phase?: string })?.phase === "digest_mismatch",
    );
    expect(mismatch).toBeDefined();
  });

  it("honours deny_patterns to block specific repos", async () => {
    const { fetch, invocations } = makeStub(() => ({
      status: 200,
      headers: {},
      body: Buffer.from(JSON.stringify({ token: "t" })),
    }));
    server = await createServer({
      storage,
      ociReaperIntervalMs: 60 * 60 * 1000,
      virtualUpstreamFetch: fetch,
    });
    storage.index.addVirtualUpstream({
      org: "acme",
      kind: "oci",
      upstreamUrl: "https://registry-1.docker.io",
      config: {
        upstream_flavor: "dockerhub",
        upstream_repo_template: "library/{repo}",
        deny_patterns: ["alpine"],
      },
    });
    const r = await fetch_(server, "GET", "/v2/acme/alpine/manifests/3.20");
    expect(r.status).toBe(404);
    // No upstream should have been hit (denied before fetch).
    expect(invocations.length).toBe(0);
  });

  it("logs an upstream auth failure + falls back to 404", async () => {
    const { fetch } = makeStub((url) => {
      if (url.includes("auth.docker.io/token")) {
        return { status: 500, headers: {}, body: Buffer.from("oops") };
      }
      return { status: 404, headers: {}, body: Buffer.from("") };
    });
    server = await createServer({
      storage,
      ociReaperIntervalMs: 60 * 60 * 1000,
      virtualUpstreamFetch: fetch,
    });
    storage.index.addVirtualUpstream({
      org: "acme",
      kind: "oci",
      upstreamUrl: "https://registry-1.docker.io",
      config: {
        upstream_flavor: "dockerhub",
        upstream_repo_template: "library/{repo}",
      },
    });
    const r = await fetch_(server, "GET", "/v2/acme/alpine/manifests/3.20");
    expect(r.status).toBe(404);
    const audits = storage.index.listAuditEntries({ action: "proxy_cache" });
    const authErr = audits.find(
      (a) => (a.detail as { phase?: string })?.phase === "auth_error",
    );
    expect(authErr).toBeDefined();
  });

  it("proxies through a GHCR upstream with a static PAT (auth_header_template)", async () => {
    let observedAuth: string | undefined;
    const manifestBody = Buffer.from(
      JSON.stringify({
        schemaVersion: 2,
        mediaType: OCI_MEDIA_TYPES.MANIFEST_V1,
        config: {
          mediaType: OCI_MEDIA_TYPES.CONFIG_V1,
          digest: `sha256:${"e".repeat(64)}`,
          size: 1,
        },
        layers: [],
      }),
    );
    const manifestHex = crypto
      .createHash("sha256")
      .update(manifestBody)
      .digest("hex");
    const { fetch } = makeStub((url, headers) => {
      // Local repo is "svc"; no upstream_repo_template, so 1:1 mapping
      // → upstream URL is https://ghcr.io/v2/svc/manifests/v1.
      if (url.endsWith("/v2/svc/manifests/v1")) {
        observedAuth = headers?.authorization;
        return {
          status: 200,
          headers: {
            "content-type": OCI_MEDIA_TYPES.MANIFEST_V1,
            "docker-content-digest": `sha256:${manifestHex}`,
          },
          body: manifestBody,
        };
      }
      return { status: 404, headers: {}, body: Buffer.from("") };
    });
    server = await createServer({
      storage,
      ociReaperIntervalMs: 60 * 60 * 1000,
      virtualUpstreamFetch: fetch,
    });
    storage.index.addVirtualUpstream({
      org: "acme",
      kind: "oci",
      upstreamUrl: "https://ghcr.io",
      config: {
        upstream_flavor: "ghcr",
        // No upstream_repo_template — verifies the 1:1 mapping path.
        auth_header_template: "Bearer ghp_TEST_PAT_VALUE",
      },
    });
    const r = await fetch_(server, "GET", "/v2/acme/svc/manifests/v1");
    expect(r.status).toBe(200);
    expect(observedAuth).toBe("Bearer ghp_TEST_PAT_VALUE");
  });

  it("projects child-manifest platform metadata when proxying an image index", async () => {
    const indexBody = Buffer.from(
      JSON.stringify({
        schemaVersion: 2,
        mediaType: OCI_MEDIA_TYPES.INDEX_V1,
        manifests: [
          {
            mediaType: OCI_MEDIA_TYPES.MANIFEST_V1,
            digest: `sha256:${"a".repeat(64)}`,
            size: 500,
            platform: { architecture: "amd64", os: "linux" },
          },
          {
            mediaType: OCI_MEDIA_TYPES.MANIFEST_V1,
            digest: `sha256:${"b".repeat(64)}`,
            size: 510,
            platform: { architecture: "arm64", os: "linux", variant: "v8" },
          },
        ],
      }),
    );
    const indexHex = crypto.createHash("sha256").update(indexBody).digest("hex");
    const { fetch } = makeStub((url) => {
      if (url.includes("auth.docker.io/token")) {
        return {
          status: 200,
          headers: {},
          body: Buffer.from(JSON.stringify({ token: "t" })),
        };
      }
      if (url.endsWith("/v2/library/multi/manifests/latest")) {
        return {
          status: 200,
          headers: {
            "content-type": OCI_MEDIA_TYPES.INDEX_V1,
            "docker-content-digest": `sha256:${indexHex}`,
          },
          body: indexBody,
        };
      }
      return { status: 404, headers: {}, body: Buffer.from("") };
    });
    server = await createServer({
      storage,
      ociReaperIntervalMs: 60 * 60 * 1000,
      virtualUpstreamFetch: fetch,
    });
    storage.index.addVirtualUpstream({
      org: "acme",
      kind: "oci",
      upstreamUrl: "https://registry-1.docker.io",
      config: {
        upstream_flavor: "dockerhub",
        upstream_repo_template: "library/{repo}",
      },
    });
    const r = await fetch_(server, "GET", "/v2/acme/multi/manifests/latest");
    expect(r.status).toBe(200);
    const stored = await storage.getManifest("oci/acme/multi", indexHex);
    expect(stored?.ociMetadata?.isIndex).toBe(true);
    expect(stored?.ociMetadata?.childManifests).toHaveLength(2);
    expect(stored?.ociMetadata?.childManifests?.[0].platform).toEqual({
      architecture: "amd64",
      os: "linux",
    });
    expect(stored?.ociMetadata?.childManifests?.[1].platform).toEqual({
      architecture: "arm64",
      os: "linux",
      variant: "v8",
    });
  });

  it("skips an upstream with an unrecognised flavor", async () => {
    const { fetch, invocations } = makeStub(() => ({
      status: 200,
      headers: {},
      body: Buffer.from(""),
    }));
    server = await createServer({
      storage,
      ociReaperIntervalMs: 60 * 60 * 1000,
      virtualUpstreamFetch: fetch,
    });
    storage.index.addVirtualUpstream({
      org: "acme",
      kind: "oci",
      upstreamUrl: "https://something",
      config: {
        // upstream_flavor missing — should be skipped, fall to 404.
      },
    });
    const r = await fetch_(server, "GET", "/v2/acme/x/manifests/v1");
    expect(r.status).toBe(404);
    // No upstream fetch should have happened (flavor unrecognised so
    // adapter resolution short-circuits before fetch).
    expect(invocations.length).toBe(0);
  });

  it("re-signs the cached manifest when resign_on_cache + key are set", async () => {
    const manifestBody = Buffer.from(
      JSON.stringify({
        schemaVersion: 2,
        mediaType: OCI_MEDIA_TYPES.INDEX_V1,
        manifests: [],
      }),
    );
    const manifestDigestHex = crypto
      .createHash("sha256")
      .update(manifestBody)
      .digest("hex");
    const { fetch } = makeStub((url) => {
      if (url.includes("auth.docker.io/token")) {
        return {
          status: 200,
          headers: {},
          body: Buffer.from(JSON.stringify({ token: "t" })),
        };
      }
      if (url.endsWith("/v2/library/alpine/manifests/index")) {
        return {
          status: 200,
          headers: {
            "content-type": OCI_MEDIA_TYPES.INDEX_V1,
            "docker-content-digest": `sha256:${manifestDigestHex}`,
          },
          body: manifestBody,
        };
      }
      return { status: 404, headers: {}, body: Buffer.from("") };
    });
    server = await createServer({
      storage,
      ociReaperIntervalMs: 60 * 60 * 1000,
      virtualUpstreamFetch: fetch,
      virtualResignPrivateKeyPem: signingKey,
    });
    storage.index.addVirtualUpstream({
      org: "acme",
      kind: "oci",
      upstreamUrl: "https://registry-1.docker.io",
      config: {
        upstream_flavor: "dockerhub",
        upstream_repo_template: "library/{repo}",
        resign_on_cache: true,
      },
    });
    const r = await fetch_(server, "GET", "/v2/acme/alpine/manifests/index");
    expect(r.status).toBe(200);
    const stored = await storage.getManifest(
      "oci/acme/alpine",
      manifestDigestHex,
    );
    expect(stored?.signature?.signatureB64).toBeDefined();
    expect(stored?.signature?.signedBy).toMatch(/^[a-f0-9]{16}$/);
  });
});

// ── Helper ─────────────────────────────────────────────────────────

async function fetch_(
  server: ServerHandle,
  method: string,
  pathname: string,
): Promise<Response> {
  return globalThis.fetch(`${server.baseUrl}${pathname}`, {
    method,
    headers: { authorization: AUTH },
  });
}
