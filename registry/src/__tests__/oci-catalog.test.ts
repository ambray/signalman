// WS10 M4 — /v2/_catalog + /v2/<name>/tags/list pagination tests.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createServer, type ServerHandle } from "../http/server.js";
import { LocalFsRegistryStorage } from "../storage/registry-storage.js";
import { OCI_ERROR_CODES, OCI_MEDIA_TYPES, type OciErrorEnvelope } from "../oci/index.js";

const AUTH = "Bearer sk_TEST_0123456789ABCDEF";

async function pushBlob(
  server: ServerHandle,
  repoPath: string,
  bytes: Buffer,
): Promise<string> {
  const hex = crypto.createHash("sha256").update(bytes).digest("hex");
  const digest = `sha256:${hex}`;
  const init = await fetch(`${server.baseUrl}/v2/${repoPath}/blobs/uploads/`, {
    method: "POST",
    headers: { authorization: AUTH },
  });
  const location = init.headers.get("location")!;
  await fetch(`${server.baseUrl}${location}`, {
    method: "PATCH",
    headers: {
      authorization: AUTH,
      "content-range": `0-${bytes.length - 1}`,
    },
    body: new Uint8Array(bytes),
  });
  await fetch(`${server.baseUrl}${location}?digest=${digest}`, {
    method: "PUT",
    headers: { authorization: AUTH },
  });
  return digest;
}

async function pushManifest(
  server: ServerHandle,
  repoPath: string,
  tag: string,
): Promise<string> {
  // Push a config + layer first, then the manifest.
  const config = Buffer.from(JSON.stringify({ os: "linux", architecture: "amd64", _: tag }));
  const layer = Buffer.from(`layer-bytes-for-${repoPath}-${tag}`);
  const cfg = await pushBlob(server, repoPath, config);
  const lyr = await pushBlob(server, repoPath, layer);
  const body = Buffer.from(
    JSON.stringify({
      schemaVersion: 2,
      mediaType: OCI_MEDIA_TYPES.MANIFEST_V1,
      config: {
        mediaType: OCI_MEDIA_TYPES.CONFIG_V1,
        digest: cfg,
        size: config.length,
      },
      layers: [
        {
          mediaType: OCI_MEDIA_TYPES.LAYER_TAR_GZIP,
          digest: lyr,
          size: layer.length,
        },
      ],
    }),
    "utf-8",
  );
  const r = await fetch(
    `${server.baseUrl}/v2/${repoPath}/manifests/${tag}`,
    {
      method: "PUT",
      headers: {
        authorization: AUTH,
        "content-type": OCI_MEDIA_TYPES.MANIFEST_V1,
      },
      body: new Uint8Array(body),
    },
  );
  if (r.status !== 201) {
    throw new Error(`pushManifest ${repoPath}:${tag} → ${r.status}`);
  }
  return `sha256:${crypto.createHash("sha256").update(body).digest("hex")}`;
}

describe("OCI catalog + tags-list pagination", () => {
  let root: string;
  let storage: LocalFsRegistryStorage;
  let server: ServerHandle;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "oci-catalog-"));
    storage = LocalFsRegistryStorage.fromRoot(root);
    server = await createServer({
      storage,
      ociReaperIntervalMs: 60 * 60 * 1000,
    });
  });

  afterEach(async () => {
    await server.close();
    storage.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  // ── _catalog basics ─────────────────────────────────────────────
  it("returns an empty catalog when no repositories exist", async () => {
    const r = await fetch(`${server.baseUrl}/v2/_catalog`, {
      headers: { authorization: AUTH },
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { repositories: string[] };
    expect(body.repositories).toEqual([]);
    expect(r.headers.get("link")).toBeNull();
  });

  it("emits a paginated list ASCII-ordered + a Link header when more follow", async () => {
    await pushManifest(server, "acme/alpha", "v1");
    await pushManifest(server, "acme/bravo", "v1");
    await pushManifest(server, "acme/charlie", "v1");
    const r = await fetch(`${server.baseUrl}/v2/_catalog?n=2`, {
      headers: { authorization: AUTH },
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { repositories: string[] };
    expect(body.repositories).toEqual(["acme/alpha", "acme/bravo"]);
    const link = r.headers.get("link");
    // baseUrl is empty in tests, so the Link is "</v2/_catalog?n=2&last=acme%2Fbravo>; rel=next".
    expect(link).toMatch(/<.*\/v2\/_catalog\?n=2&last=acme%2Fbravo>; rel="next"/);
  });

  it("honours ?last cursor (exclusive)", async () => {
    await pushManifest(server, "acme/alpha", "v1");
    await pushManifest(server, "acme/bravo", "v1");
    await pushManifest(server, "acme/charlie", "v1");
    const r = await fetch(
      `${server.baseUrl}/v2/_catalog?n=10&last=${encodeURIComponent("acme/alpha")}`,
      { headers: { authorization: AUTH } },
    );
    const body = (await r.json()) as { repositories: string[] };
    expect(body.repositories).toEqual(["acme/bravo", "acme/charlie"]);
    expect(r.headers.get("link")).toBeNull();
  });

  it("omits the Link header on the final page", async () => {
    await pushManifest(server, "acme/alpha", "v1");
    await pushManifest(server, "acme/bravo", "v1");
    const r = await fetch(`${server.baseUrl}/v2/_catalog?n=10`, {
      headers: { authorization: AUTH },
    });
    expect(r.headers.get("link")).toBeNull();
  });

  it("n=0 returns an empty list and MUST NOT emit a Link header", async () => {
    await pushManifest(server, "acme/alpha", "v1");
    const r = await fetch(`${server.baseUrl}/v2/_catalog?n=0`, {
      headers: { authorization: AUTH },
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { repositories: string[] };
    expect(body.repositories).toEqual([]);
    expect(r.headers.get("link")).toBeNull();
  });

  it("rejects negative n with MANIFEST_INVALID", async () => {
    const r = await fetch(`${server.baseUrl}/v2/_catalog?n=-1`, {
      headers: { authorization: AUTH },
    });
    expect(r.status).toBe(400);
    const env = (await r.json()) as OciErrorEnvelope;
    expect(env.errors[0].code).toBe(OCI_ERROR_CODES.MANIFEST_INVALID);
  });

  it("rejects non-integer n with MANIFEST_INVALID", async () => {
    const r = await fetch(`${server.baseUrl}/v2/_catalog?n=lots`, {
      headers: { authorization: AUTH },
    });
    expect(r.status).toBe(400);
  });

  it("caps n at the configured max page size", async () => {
    await server.close();
    server = await createServer({
      storage,
      ociReaperIntervalMs: 60 * 60 * 1000,
      ociCatalogMaxPageSize: 2,
    });
    await pushManifest(server, "acme/alpha", "v1");
    await pushManifest(server, "acme/bravo", "v1");
    await pushManifest(server, "acme/charlie", "v1");
    const r = await fetch(`${server.baseUrl}/v2/_catalog?n=100`, {
      headers: { authorization: AUTH },
    });
    const body = (await r.json()) as { repositories: string[] };
    expect(body.repositories).toHaveLength(2);
    expect(r.headers.get("link")).toMatch(/rel="next"/);
  });

  // ── tags/list basics ────────────────────────────────────────────
  it("returns an empty tag list for a repo with no tags (but with a digest-pushed manifest)", async () => {
    // Push by digest only — no tag pointer should result.
    const config = Buffer.from(JSON.stringify({ os: "linux" }));
    const layer = Buffer.from("layer-bytes");
    const cfg = await pushBlob(server, "acme/digest-only", config);
    const lyr = await pushBlob(server, "acme/digest-only", layer);
    const body = Buffer.from(
      JSON.stringify({
        schemaVersion: 2,
        mediaType: OCI_MEDIA_TYPES.MANIFEST_V1,
        config: {
          mediaType: OCI_MEDIA_TYPES.CONFIG_V1,
          digest: cfg,
          size: config.length,
        },
        layers: [
          {
            mediaType: OCI_MEDIA_TYPES.LAYER_TAR_GZIP,
            digest: lyr,
            size: layer.length,
          },
        ],
      }),
      "utf-8",
    );
    const digest = `sha256:${crypto.createHash("sha256").update(body).digest("hex")}`;
    await fetch(
      `${server.baseUrl}/v2/acme/digest-only/manifests/${digest}`,
      {
        method: "PUT",
        headers: {
          authorization: AUTH,
          "content-type": OCI_MEDIA_TYPES.MANIFEST_V1,
        },
        body: new Uint8Array(body),
      },
    );
    const r = await fetch(
      `${server.baseUrl}/v2/acme/digest-only/tags/list`,
      { headers: { authorization: AUTH } },
    );
    expect(r.status).toBe(200);
    const got = (await r.json()) as { name: string; tags: string[] };
    expect(got.tags).toEqual([]);
    expect(got.name).toBe("acme/digest-only");
  });

  it("returns tags ASCII-ordered + Link header when paginating", async () => {
    await pushManifest(server, "acme/svc", "v1");
    await pushManifest(server, "acme/svc", "v2");
    await pushManifest(server, "acme/svc", "v3");
    const r = await fetch(
      `${server.baseUrl}/v2/acme/svc/tags/list?n=2`,
      { headers: { authorization: AUTH } },
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as { tags: string[] };
    expect(body.tags).toEqual(["v1", "v2"]);
    const link = r.headers.get("link");
    expect(link).toMatch(/<.*\/v2\/acme\/svc\/tags\/list\?n=2&last=v2>; rel="next"/);
  });

  it("honours ?last cursor for tag listing", async () => {
    await pushManifest(server, "acme/svc", "v1");
    await pushManifest(server, "acme/svc", "v2");
    await pushManifest(server, "acme/svc", "v3");
    const r = await fetch(
      `${server.baseUrl}/v2/acme/svc/tags/list?n=10&last=v1`,
      { headers: { authorization: AUTH } },
    );
    const body = (await r.json()) as { tags: string[] };
    expect(body.tags).toEqual(["v2", "v3"]);
  });

  it("scopes tag listing to the requested repository", async () => {
    await pushManifest(server, "acme/svc-a", "shared");
    await pushManifest(server, "acme/svc-b", "shared");
    const r = await fetch(`${server.baseUrl}/v2/acme/svc-a/tags/list`, {
      headers: { authorization: AUTH },
    });
    const body = (await r.json()) as { tags: string[]; name: string };
    expect(body.tags).toEqual(["shared"]);
    expect(body.name).toBe("acme/svc-a");
  });

  it("tags/list n=0 returns empty + no Link header", async () => {
    await pushManifest(server, "acme/svc", "v1");
    const r = await fetch(
      `${server.baseUrl}/v2/acme/svc/tags/list?n=0`,
      { headers: { authorization: AUTH } },
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as { tags: string[] };
    expect(body.tags).toEqual([]);
    expect(r.headers.get("link")).toBeNull();
  });

  it("tags/list rejects a malformed last cursor", async () => {
    await pushManifest(server, "acme/svc", "v1");
    const r = await fetch(
      `${server.baseUrl}/v2/acme/svc/tags/list?last=-bad-cursor`,
      { headers: { authorization: AUTH } },
    );
    expect(r.status).toBe(400);
  });

  it("tags/list rejects invalid repository name", async () => {
    const r = await fetch(`${server.baseUrl}/v2/Acme/SVC/tags/list`, {
      headers: { authorization: AUTH },
    });
    expect(r.status).toBe(400);
    const env = (await r.json()) as OciErrorEnvelope;
    expect(env.errors[0].code).toBe(OCI_ERROR_CODES.NAME_INVALID);
  });
});
