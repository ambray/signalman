// WS10 M3 — end-to-end OCI manifest protocol tests.
//
// Covers: PUT by tag + by digest, GET/HEAD round-trip with
// Docker-Content-Digest, tag rotation, multi-arch image index +
// child-manifest validation, missing-blob rejection, malformed JSON
// rejection, manifest-DELETE on/off via the operator-config flag,
// audit-log shape on every state change.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createServer, type ServerHandle } from "../http/server.js";
import { LocalFsRegistryStorage } from "../storage/registry-storage.js";
import {
  DOCKER_MEDIA_TYPES,
  OCI_ERROR_CODES,
  OCI_MEDIA_TYPES,
  type OciErrorEnvelope,
} from "../oci/index.js";

const AUTH = "Bearer sk_TEST_0123456789ABCDEF";
const ORG = "acme";
const REPO_PATH = `${ORG}/team/svc`;

interface FetchOpts {
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: Buffer | string;
}

async function call(server: ServerHandle, opts: FetchOpts): Promise<Response> {
  const headers: Record<string, string> = { authorization: AUTH, ...opts.headers };
  const init: RequestInit = { method: opts.method, headers };
  if (opts.body !== undefined) {
    init.body =
      typeof opts.body === "string" ? opts.body : new Uint8Array(opts.body);
  }
  return globalThis.fetch(`${server.baseUrl}${opts.path}`, init);
}

async function pushBlob(
  server: ServerHandle,
  bytes: Buffer,
): Promise<{ digest: string; hex: string }> {
  const hex = crypto.createHash("sha256").update(bytes).digest("hex");
  const digest = `sha256:${hex}`;
  const init = await call(server, {
    method: "POST",
    path: `/v2/${REPO_PATH}/blobs/uploads/`,
  });
  const location = init.headers.get("location")!;
  await call(server, {
    method: "PATCH",
    path: location,
    headers: { "content-range": `0-${bytes.length - 1}` },
    body: bytes,
  });
  const r = await call(server, {
    method: "PUT",
    path: `${location}?digest=${digest}`,
  });
  if (r.status !== 201) {
    throw new Error(`pushBlob finalize: ${r.status}`);
  }
  return { digest, hex };
}

function makeSingleManifest(opts: {
  configDigest: string;
  configSize: number;
  layerDigest: string;
  layerSize: number;
  mediaType?: string;
}): Buffer {
  const body = {
    schemaVersion: 2,
    mediaType: opts.mediaType ?? OCI_MEDIA_TYPES.MANIFEST_V1,
    config: {
      mediaType: OCI_MEDIA_TYPES.CONFIG_V1,
      digest: opts.configDigest,
      size: opts.configSize,
    },
    layers: [
      {
        mediaType: OCI_MEDIA_TYPES.LAYER_TAR_GZIP,
        digest: opts.layerDigest,
        size: opts.layerSize,
      },
    ],
  };
  return Buffer.from(JSON.stringify(body), "utf-8");
}

describe("OCI manifest protocol (HTTP integration)", () => {
  let root: string;
  let storage: LocalFsRegistryStorage;
  let server: ServerHandle;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "oci-manifests-"));
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

  // ── Happy path: push by tag, pull by tag + by digest ────────────
  it("PUT by tag → GET by tag + GET by digest round-trips byte-identically", async () => {
    const config = Buffer.from(JSON.stringify({ architecture: "amd64", os: "linux" }));
    const layer = Buffer.from("layer-bytes");
    const cfg = await pushBlob(server, config);
    const lyr = await pushBlob(server, layer);
    const manifest = makeSingleManifest({
      configDigest: cfg.digest,
      configSize: config.length,
      layerDigest: lyr.digest,
      layerSize: layer.length,
    });
    const expectedDigest = `sha256:${crypto.createHash("sha256").update(manifest).digest("hex")}`;

    const put = await call(server, {
      method: "PUT",
      path: `/v2/${REPO_PATH}/manifests/v1.0`,
      headers: { "content-type": OCI_MEDIA_TYPES.MANIFEST_V1 },
      body: manifest,
    });
    expect(put.status).toBe(201);
    expect(put.headers.get("docker-content-digest")).toBe(expectedDigest);
    expect(put.headers.get("location")).toBe(
      `/v2/${REPO_PATH}/manifests/${expectedDigest}`,
    );

    // GET by tag
    const byTag = await call(server, {
      method: "GET",
      path: `/v2/${REPO_PATH}/manifests/v1.0`,
    });
    expect(byTag.status).toBe(200);
    expect(byTag.headers.get("docker-content-digest")).toBe(expectedDigest);
    expect(byTag.headers.get("content-type")).toBe(OCI_MEDIA_TYPES.MANIFEST_V1);
    expect(Buffer.from(await byTag.arrayBuffer()).equals(manifest)).toBe(true);

    // GET by digest
    const byDigest = await call(server, {
      method: "GET",
      path: `/v2/${REPO_PATH}/manifests/${expectedDigest}`,
    });
    expect(byDigest.status).toBe(200);
    expect(Buffer.from(await byDigest.arrayBuffer()).equals(manifest)).toBe(true);

    // HEAD by digest
    const head = await call(server, {
      method: "HEAD",
      path: `/v2/${REPO_PATH}/manifests/${expectedDigest}`,
    });
    expect(head.status).toBe(200);
    expect(head.headers.get("docker-content-digest")).toBe(expectedDigest);
    expect(head.headers.get("content-length")).toBe(String(manifest.length));
  });

  // ── PUT by digest ───────────────────────────────────────────────
  it("PUT by digest accepts a matching reference + rejects a mismatched one", async () => {
    const config = Buffer.from(JSON.stringify({ architecture: "amd64", os: "linux" }));
    const layer = Buffer.from("layer-bytes-by-digest");
    const cfg = await pushBlob(server, config);
    const lyr = await pushBlob(server, layer);
    const manifest = makeSingleManifest({
      configDigest: cfg.digest,
      configSize: config.length,
      layerDigest: lyr.digest,
      layerSize: layer.length,
    });
    const digest = `sha256:${crypto.createHash("sha256").update(manifest).digest("hex")}`;
    const wrong = `sha256:${"0".repeat(64)}`;

    const ok = await call(server, {
      method: "PUT",
      path: `/v2/${REPO_PATH}/manifests/${digest}`,
      headers: { "content-type": OCI_MEDIA_TYPES.MANIFEST_V1 },
      body: manifest,
    });
    expect(ok.status).toBe(201);

    const bad = await call(server, {
      method: "PUT",
      path: `/v2/${REPO_PATH}/manifests/${wrong}`,
      headers: { "content-type": OCI_MEDIA_TYPES.MANIFEST_V1 },
      body: manifest,
    });
    expect(bad.status).toBe(400);
    const env = (await bad.json()) as OciErrorEnvelope;
    expect(env.errors[0].code).toBe(OCI_ERROR_CODES.DIGEST_INVALID);
  });

  // ── Missing config blob ─────────────────────────────────────────
  it("rejects manifest whose config blob is unknown with MANIFEST_BLOB_UNKNOWN", async () => {
    const layer = Buffer.from("layer-bytes");
    const lyr = await pushBlob(server, layer);
    const manifest = makeSingleManifest({
      configDigest: `sha256:${"f".repeat(64)}`, // never uploaded
      configSize: 99,
      layerDigest: lyr.digest,
      layerSize: layer.length,
    });
    const r = await call(server, {
      method: "PUT",
      path: `/v2/${REPO_PATH}/manifests/missing-cfg`,
      headers: { "content-type": OCI_MEDIA_TYPES.MANIFEST_V1 },
      body: manifest,
    });
    expect(r.status).toBe(400);
    const env = (await r.json()) as OciErrorEnvelope;
    expect(env.errors[0].code).toBe(OCI_ERROR_CODES.MANIFEST_BLOB_UNKNOWN);
  });

  // ── Missing layer blob ──────────────────────────────────────────
  it("rejects manifest whose layer blob is unknown with MANIFEST_BLOB_UNKNOWN", async () => {
    const config = Buffer.from(JSON.stringify({ os: "linux" }));
    const cfg = await pushBlob(server, config);
    const manifest = makeSingleManifest({
      configDigest: cfg.digest,
      configSize: config.length,
      layerDigest: `sha256:${"e".repeat(64)}`, // never uploaded
      layerSize: 7,
    });
    const r = await call(server, {
      method: "PUT",
      path: `/v2/${REPO_PATH}/manifests/missing-layer`,
      headers: { "content-type": OCI_MEDIA_TYPES.MANIFEST_V1 },
      body: manifest,
    });
    expect(r.status).toBe(400);
    const env = (await r.json()) as OciErrorEnvelope;
    expect(env.errors[0].code).toBe(OCI_ERROR_CODES.MANIFEST_BLOB_UNKNOWN);
  });

  // ── Foreign (urls-bearing) layer is accepted without blob existence ──
  it("accepts a foreign (urls) layer without local blob presence", async () => {
    const config = Buffer.from(JSON.stringify({ os: "linux" }));
    const cfg = await pushBlob(server, config);
    const foreignDigest = `sha256:${"3".repeat(64)}`;
    const body = Buffer.from(
      JSON.stringify({
        schemaVersion: 2,
        mediaType: OCI_MEDIA_TYPES.MANIFEST_V1,
        config: {
          mediaType: OCI_MEDIA_TYPES.CONFIG_V1,
          digest: cfg.digest,
          size: config.length,
        },
        layers: [
          {
            mediaType: OCI_MEDIA_TYPES.LAYER_TAR_GZIP,
            digest: foreignDigest,
            size: 500,
            urls: ["https://example.com/blobs/foreign"],
          },
        ],
      }),
      "utf-8",
    );
    const r = await call(server, {
      method: "PUT",
      path: `/v2/${REPO_PATH}/manifests/foreign-layer`,
      headers: { "content-type": OCI_MEDIA_TYPES.MANIFEST_V1 },
      body,
    });
    expect(r.status).toBe(201);
  });

  // ── Tag rotation: same tag → new digest replaces ────────────────
  it("PUT by same tag with different bytes rotates the tag pointer", async () => {
    const config = Buffer.from(JSON.stringify({ os: "linux" }));
    const cfg = await pushBlob(server, config);
    const l1 = await pushBlob(server, Buffer.from("v1-layer"));
    const l2 = await pushBlob(server, Buffer.from("v2-layer"));

    const m1 = makeSingleManifest({
      configDigest: cfg.digest,
      configSize: config.length,
      layerDigest: l1.digest,
      layerSize: 8,
    });
    const m2 = makeSingleManifest({
      configDigest: cfg.digest,
      configSize: config.length,
      layerDigest: l2.digest,
      layerSize: 8,
    });
    const d1 = `sha256:${crypto.createHash("sha256").update(m1).digest("hex")}`;
    const d2 = `sha256:${crypto.createHash("sha256").update(m2).digest("hex")}`;
    expect(d1).not.toBe(d2);

    await call(server, {
      method: "PUT",
      path: `/v2/${REPO_PATH}/manifests/latest`,
      headers: { "content-type": OCI_MEDIA_TYPES.MANIFEST_V1 },
      body: m1,
    });
    await call(server, {
      method: "PUT",
      path: `/v2/${REPO_PATH}/manifests/latest`,
      headers: { "content-type": OCI_MEDIA_TYPES.MANIFEST_V1 },
      body: m2,
    });

    const get = await call(server, {
      method: "GET",
      path: `/v2/${REPO_PATH}/manifests/latest`,
    });
    expect(get.headers.get("docker-content-digest")).toBe(d2);

    // Both manifests still pullable by their digests (rotation is
    // tag-only; the underlying manifest rows aren't dropped).
    const old = await call(server, {
      method: "HEAD",
      path: `/v2/${REPO_PATH}/manifests/${d1}`,
    });
    expect(old.status).toBe(200);
  });

  // ── Image-index push with child-manifest validation ─────────────
  it("PUT image index after children → GET by tag returns the index body", async () => {
    // Push two child manifests (one amd64, one arm64).
    const config = Buffer.from(JSON.stringify({ os: "linux" }));
    const cfg = await pushBlob(server, config);
    const l1 = await pushBlob(server, Buffer.from("amd64-layer"));
    const l2 = await pushBlob(server, Buffer.from("arm64-layer"));
    const childA = makeSingleManifest({
      configDigest: cfg.digest,
      configSize: config.length,
      layerDigest: l1.digest,
      layerSize: 11,
    });
    const childB = makeSingleManifest({
      configDigest: cfg.digest,
      configSize: config.length,
      layerDigest: l2.digest,
      layerSize: 11,
    });
    const dA = `sha256:${crypto.createHash("sha256").update(childA).digest("hex")}`;
    const dB = `sha256:${crypto.createHash("sha256").update(childB).digest("hex")}`;

    for (const [body, digest] of [
      [childA, dA],
      [childB, dB],
    ] as const) {
      const r = await call(server, {
        method: "PUT",
        path: `/v2/${REPO_PATH}/manifests/${digest}`,
        headers: { "content-type": OCI_MEDIA_TYPES.MANIFEST_V1 },
        body,
      });
      expect(r.status).toBe(201);
    }

    const indexBody = Buffer.from(
      JSON.stringify({
        schemaVersion: 2,
        mediaType: OCI_MEDIA_TYPES.INDEX_V1,
        manifests: [
          {
            mediaType: OCI_MEDIA_TYPES.MANIFEST_V1,
            digest: dA,
            size: childA.length,
            platform: { architecture: "amd64", os: "linux" },
          },
          {
            mediaType: OCI_MEDIA_TYPES.MANIFEST_V1,
            digest: dB,
            size: childB.length,
            platform: { architecture: "arm64", os: "linux" },
          },
        ],
      }),
      "utf-8",
    );
    const dIdx = `sha256:${crypto.createHash("sha256").update(indexBody).digest("hex")}`;
    const r = await call(server, {
      method: "PUT",
      path: `/v2/${REPO_PATH}/manifests/multi`,
      headers: { "content-type": OCI_MEDIA_TYPES.INDEX_V1 },
      body: indexBody,
    });
    expect(r.status).toBe(201);
    expect(r.headers.get("docker-content-digest")).toBe(dIdx);

    const got = await call(server, {
      method: "GET",
      path: `/v2/${REPO_PATH}/manifests/multi`,
    });
    expect(got.headers.get("content-type")).toBe(OCI_MEDIA_TYPES.INDEX_V1);
    const echoed = Buffer.from(await got.arrayBuffer());
    expect(echoed.equals(indexBody)).toBe(true);
  });

  // ── Image index with missing child manifest ────────────────────
  it("rejects an image-index whose child manifest is unknown", async () => {
    const body = Buffer.from(
      JSON.stringify({
        schemaVersion: 2,
        mediaType: OCI_MEDIA_TYPES.INDEX_V1,
        manifests: [
          {
            mediaType: OCI_MEDIA_TYPES.MANIFEST_V1,
            digest: `sha256:${"f".repeat(64)}`,
            size: 99,
            platform: { architecture: "amd64", os: "linux" },
          },
        ],
      }),
      "utf-8",
    );
    const r = await call(server, {
      method: "PUT",
      path: `/v2/${REPO_PATH}/manifests/orphan-index`,
      headers: { "content-type": OCI_MEDIA_TYPES.INDEX_V1 },
      body,
    });
    expect(r.status).toBe(400);
    const env = (await r.json()) as OciErrorEnvelope;
    expect(env.errors[0].code).toBe(OCI_ERROR_CODES.MANIFEST_BLOB_UNKNOWN);
  });

  // ── Content-Type / body mediaType mismatch ──────────────────────
  it("rejects when Content-Type does not match body.mediaType", async () => {
    const config = Buffer.from(JSON.stringify({ os: "linux" }));
    const cfg = await pushBlob(server, config);
    const layer = await pushBlob(server, Buffer.from("ct-mismatch"));
    const body = makeSingleManifest({
      configDigest: cfg.digest,
      configSize: config.length,
      layerDigest: layer.digest,
      layerSize: 11,
      mediaType: OCI_MEDIA_TYPES.MANIFEST_V1,
    });
    const r = await call(server, {
      method: "PUT",
      path: `/v2/${REPO_PATH}/manifests/mismatch`,
      // Lie about the Content-Type — Docker v2.2 wrapper around an OCI body.
      headers: { "content-type": DOCKER_MEDIA_TYPES.MANIFEST_V2_2 },
      body,
    });
    expect(r.status).toBe(400);
    const env = (await r.json()) as OciErrorEnvelope;
    expect(env.errors[0].code).toBe(OCI_ERROR_CODES.MANIFEST_INVALID);
  });

  // ── Unknown Content-Type ────────────────────────────────────────
  it("rejects unknown Content-Type with MANIFEST_INVALID", async () => {
    const r = await call(server, {
      method: "PUT",
      path: `/v2/${REPO_PATH}/manifests/bad-ct`,
      headers: { "content-type": "application/x-unknown" },
      body: Buffer.from("{}"),
    });
    expect(r.status).toBe(400);
    const env = (await r.json()) as OciErrorEnvelope;
    expect(env.errors[0].code).toBe(OCI_ERROR_CODES.MANIFEST_INVALID);
  });

  // ── Missing Content-Type ────────────────────────────────────────
  it("rejects missing Content-Type with MANIFEST_INVALID", async () => {
    const r = await call(server, {
      method: "PUT",
      path: `/v2/${REPO_PATH}/manifests/no-ct`,
      body: Buffer.from("{}"),
    });
    expect(r.status).toBe(400);
  });

  // ── Malformed JSON ──────────────────────────────────────────────
  it("rejects non-JSON body with MANIFEST_INVALID", async () => {
    const r = await call(server, {
      method: "PUT",
      path: `/v2/${REPO_PATH}/manifests/bad-json`,
      headers: { "content-type": OCI_MEDIA_TYPES.MANIFEST_V1 },
      body: Buffer.from("not json{"),
    });
    expect(r.status).toBe(400);
    const env = (await r.json()) as OciErrorEnvelope;
    expect(env.errors[0].code).toBe(OCI_ERROR_CODES.MANIFEST_INVALID);
  });

  // ── PUT with no body ────────────────────────────────────────────
  it("rejects PUT with no body", async () => {
    const r = await call(server, {
      method: "PUT",
      path: `/v2/${REPO_PATH}/manifests/empty`,
      headers: { "content-type": OCI_MEDIA_TYPES.MANIFEST_V1 },
    });
    expect(r.status).toBe(400);
  });

  // ── GET unknown manifest ────────────────────────────────────────
  it("GET on unknown digest returns 404 MANIFEST_UNKNOWN", async () => {
    const r = await call(server, {
      method: "GET",
      path: `/v2/${REPO_PATH}/manifests/sha256:${"a".repeat(64)}`,
    });
    expect(r.status).toBe(404);
    const env = (await r.json()) as OciErrorEnvelope;
    expect(env.errors[0].code).toBe(OCI_ERROR_CODES.MANIFEST_UNKNOWN);
  });

  it("GET on unknown tag returns 404 MANIFEST_UNKNOWN", async () => {
    const r = await call(server, {
      method: "GET",
      path: `/v2/${REPO_PATH}/manifests/no-such-tag`,
    });
    expect(r.status).toBe(404);
    const env = (await r.json()) as OciErrorEnvelope;
    expect(env.errors[0].code).toBe(OCI_ERROR_CODES.MANIFEST_UNKNOWN);
  });

  // ── Accept-header negotiation ───────────────────────────────────
  it("Accept '*/*' or matching mediaType serves the stored representation", async () => {
    const config = Buffer.from(JSON.stringify({ os: "linux" }));
    const cfg = await pushBlob(server, config);
    const layer = await pushBlob(server, Buffer.from("accept-layer"));
    const manifest = makeSingleManifest({
      configDigest: cfg.digest,
      configSize: config.length,
      layerDigest: layer.digest,
      layerSize: 12,
    });
    await call(server, {
      method: "PUT",
      path: `/v2/${REPO_PATH}/manifests/accept`,
      headers: { "content-type": OCI_MEDIA_TYPES.MANIFEST_V1 },
      body: manifest,
    });
    const both = await Promise.all([
      call(server, {
        method: "GET",
        path: `/v2/${REPO_PATH}/manifests/accept`,
        headers: { accept: "*/*" },
      }),
      call(server, {
        method: "GET",
        path: `/v2/${REPO_PATH}/manifests/accept`,
        headers: { accept: OCI_MEDIA_TYPES.MANIFEST_V1 },
      }),
    ]);
    for (const r of both) expect(r.status).toBe(200);
  });

  it("Accept that excludes the stored mediaType returns 404 MANIFEST_UNKNOWN", async () => {
    const config = Buffer.from(JSON.stringify({ os: "linux" }));
    const cfg = await pushBlob(server, config);
    const layer = await pushBlob(server, Buffer.from("excluded-accept"));
    const manifest = makeSingleManifest({
      configDigest: cfg.digest,
      configSize: config.length,
      layerDigest: layer.digest,
      layerSize: 15,
    });
    await call(server, {
      method: "PUT",
      path: `/v2/${REPO_PATH}/manifests/exclude-accept`,
      headers: { "content-type": OCI_MEDIA_TYPES.MANIFEST_V1 },
      body: manifest,
    });
    const r = await call(server, {
      method: "GET",
      path: `/v2/${REPO_PATH}/manifests/exclude-accept`,
      headers: { accept: DOCKER_MEDIA_TYPES.MANIFEST_V2_2 },
    });
    expect(r.status).toBe(404);
  });

  // ── DELETE by tag ───────────────────────────────────────────────
  it("DELETE by tag drops the pointer; manifest still pullable by digest", async () => {
    const config = Buffer.from(JSON.stringify({ os: "linux" }));
    const cfg = await pushBlob(server, config);
    const layer = await pushBlob(server, Buffer.from("delete-tag-layer"));
    const manifest = makeSingleManifest({
      configDigest: cfg.digest,
      configSize: config.length,
      layerDigest: layer.digest,
      layerSize: 16,
    });
    const digest = `sha256:${crypto.createHash("sha256").update(manifest).digest("hex")}`;
    await call(server, {
      method: "PUT",
      path: `/v2/${REPO_PATH}/manifests/v1`,
      headers: { "content-type": OCI_MEDIA_TYPES.MANIFEST_V1 },
      body: manifest,
    });
    const del = await call(server, {
      method: "DELETE",
      path: `/v2/${REPO_PATH}/manifests/v1`,
    });
    expect(del.status).toBe(202);

    // Tag is gone
    const byTag = await call(server, {
      method: "GET",
      path: `/v2/${REPO_PATH}/manifests/v1`,
    });
    expect(byTag.status).toBe(404);

    // Digest still works (manifest row untouched)
    const byDigest = await call(server, {
      method: "GET",
      path: `/v2/${REPO_PATH}/manifests/${digest}`,
    });
    expect(byDigest.status).toBe(200);
  });

  // ── DELETE by digest ────────────────────────────────────────────
  it("DELETE by digest drops the manifest + cascades tag pointers", async () => {
    const config = Buffer.from(JSON.stringify({ os: "linux" }));
    const cfg = await pushBlob(server, config);
    const layer = await pushBlob(server, Buffer.from("delete-digest-layer"));
    const manifest = makeSingleManifest({
      configDigest: cfg.digest,
      configSize: config.length,
      layerDigest: layer.digest,
      layerSize: 19,
    });
    const digest = `sha256:${crypto.createHash("sha256").update(manifest).digest("hex")}`;
    await call(server, {
      method: "PUT",
      path: `/v2/${REPO_PATH}/manifests/v1`,
      headers: { "content-type": OCI_MEDIA_TYPES.MANIFEST_V1 },
      body: manifest,
    });
    await call(server, {
      method: "PUT",
      path: `/v2/${REPO_PATH}/manifests/stable`,
      headers: { "content-type": OCI_MEDIA_TYPES.MANIFEST_V1 },
      body: manifest,
    });

    const del = await call(server, {
      method: "DELETE",
      path: `/v2/${REPO_PATH}/manifests/${digest}`,
    });
    expect(del.status).toBe(202);

    // Both tags + the digest are now 404
    for (const ref of ["v1", "stable", digest]) {
      const r = await call(server, {
        method: "GET",
        path: `/v2/${REPO_PATH}/manifests/${ref}`,
      });
      expect(r.status).toBe(404);
    }
  });

  // ── DELETE on unknown tag/digest ────────────────────────────────
  it("DELETE on unknown tag returns 404 MANIFEST_UNKNOWN", async () => {
    const r = await call(server, {
      method: "DELETE",
      path: `/v2/${REPO_PATH}/manifests/never-existed`,
    });
    expect(r.status).toBe(404);
  });

  it("DELETE on unknown digest returns 404 MANIFEST_UNKNOWN", async () => {
    const r = await call(server, {
      method: "DELETE",
      path: `/v2/${REPO_PATH}/manifests/sha256:${"c".repeat(64)}`,
    });
    expect(r.status).toBe(404);
  });

  // ── allowDelete=false flag ──────────────────────────────────────
  it("DELETE returns 405 UNSUPPORTED when ociAllowManifestDelete=false", async () => {
    // Restart server with the flag flipped.
    await server.close();
    server = await createServer({
      storage,
      ociReaperIntervalMs: 60 * 60 * 1000,
      ociAllowManifestDelete: false,
    });
    const config = Buffer.from(JSON.stringify({ os: "linux" }));
    const cfg = await pushBlob(server, config);
    const layer = await pushBlob(server, Buffer.from("immutable-layer"));
    const manifest = makeSingleManifest({
      configDigest: cfg.digest,
      configSize: config.length,
      layerDigest: layer.digest,
      layerSize: 15,
    });
    await call(server, {
      method: "PUT",
      path: `/v2/${REPO_PATH}/manifests/v1`,
      headers: { "content-type": OCI_MEDIA_TYPES.MANIFEST_V1 },
      body: manifest,
    });
    const del = await call(server, {
      method: "DELETE",
      path: `/v2/${REPO_PATH}/manifests/v1`,
    });
    expect(del.status).toBe(405);
    const env = (await del.json()) as OciErrorEnvelope;
    expect(env.errors[0].code).toBe(OCI_ERROR_CODES.UNSUPPORTED);
  });

  // ── Audit-log emission ──────────────────────────────────────────
  it("PUT writes action='upload' + action='manifest_create' on tag push", async () => {
    const config = Buffer.from(JSON.stringify({ os: "linux" }));
    const cfg = await pushBlob(server, config);
    const layer = await pushBlob(server, Buffer.from("audit-layer"));
    const manifest = makeSingleManifest({
      configDigest: cfg.digest,
      configSize: config.length,
      layerDigest: layer.digest,
      layerSize: 11,
    });
    const digest = `sha256:${crypto.createHash("sha256").update(manifest).digest("hex")}`;
    await call(server, {
      method: "PUT",
      path: `/v2/${REPO_PATH}/manifests/v1`,
      headers: { "content-type": OCI_MEDIA_TYPES.MANIFEST_V1 },
      body: manifest,
    });

    const entityId = `oci/${REPO_PATH}@${digest}`;
    const uploads = storage.index.listAuditEntries({
      action: "upload",
      entityType: "manifest",
      entityId,
    });
    expect(uploads.length).toBeGreaterThanOrEqual(1);

    const rotations = storage.index.listAuditEntries({
      action: "manifest_create",
      entityType: "manifest",
      entityId,
    });
    expect(rotations.length).toBe(1);
    expect(rotations[0].detail).toMatchObject({
      kind: "oci",
      tag: "v1",
      rotated: false,
    });
  });

  it("PUT by digest does NOT write a manifest_create audit row", async () => {
    const config = Buffer.from(JSON.stringify({ os: "linux" }));
    const cfg = await pushBlob(server, config);
    const layer = await pushBlob(server, Buffer.from("no-rotate-audit"));
    const manifest = makeSingleManifest({
      configDigest: cfg.digest,
      configSize: config.length,
      layerDigest: layer.digest,
      layerSize: 15,
    });
    const digest = `sha256:${crypto.createHash("sha256").update(manifest).digest("hex")}`;
    await call(server, {
      method: "PUT",
      path: `/v2/${REPO_PATH}/manifests/${digest}`,
      headers: { "content-type": OCI_MEDIA_TYPES.MANIFEST_V1 },
      body: manifest,
    });
    const rotations = storage.index.listAuditEntries({
      action: "manifest_create",
    });
    expect(rotations).toEqual([]);
  });

  // ── Idempotent re-PUT by digest (same bytes) ────────────────────
  it("re-PUT of the same digest is idempotent (still 201)", async () => {
    const config = Buffer.from(JSON.stringify({ os: "linux" }));
    const cfg = await pushBlob(server, config);
    const layer = await pushBlob(server, Buffer.from("idem-layer"));
    const manifest = makeSingleManifest({
      configDigest: cfg.digest,
      configSize: config.length,
      layerDigest: layer.digest,
      layerSize: 10,
    });
    const digest = `sha256:${crypto.createHash("sha256").update(manifest).digest("hex")}`;
    const a = await call(server, {
      method: "PUT",
      path: `/v2/${REPO_PATH}/manifests/${digest}`,
      headers: { "content-type": OCI_MEDIA_TYPES.MANIFEST_V1 },
      body: manifest,
    });
    expect(a.status).toBe(201);
    const b = await call(server, {
      method: "PUT",
      path: `/v2/${REPO_PATH}/manifests/${digest}`,
      headers: { "content-type": OCI_MEDIA_TYPES.MANIFEST_V1 },
      body: manifest,
    });
    expect(b.status).toBe(201);
  });

  // ── Bad reference shape ─────────────────────────────────────────
  it("rejects PUT with a malformed reference", async () => {
    const r = await call(server, {
      method: "PUT",
      path: `/v2/${REPO_PATH}/manifests/-bad`,
      headers: { "content-type": OCI_MEDIA_TYPES.MANIFEST_V1 },
      body: Buffer.from("{}"),
    });
    expect(r.status).toBe(400);
    const env = (await r.json()) as OciErrorEnvelope;
    expect(env.errors[0].code).toBe(OCI_ERROR_CODES.MANIFEST_INVALID);
  });

  // ── Single-segment name (no org/repo split) ─────────────────────
  it("rejects PUT under a single-segment name with NAME_INVALID", async () => {
    const r = await call(server, {
      method: "PUT",
      path: `/v2/justorg/manifests/v1`,
      headers: { "content-type": OCI_MEDIA_TYPES.MANIFEST_V1 },
      body: Buffer.from("{}"),
    });
    expect(r.status).toBe(400);
    const env = (await r.json()) as OciErrorEnvelope;
    expect(env.errors[0].code).toBe(OCI_ERROR_CODES.NAME_INVALID);
  });
});
