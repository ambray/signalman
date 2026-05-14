import * as crypto from "node:crypto";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type ServerHandle } from "../http/server.js";
import { LocalFsRegistryStorage } from "../storage/registry-storage.js";
import { generateKeypair, signManifest } from "../signing.js";
import type { Manifest } from "../types.js";

const VALID_TOKEN = "sk_AAAAAAAA_BBBBBBBBBBBBBBBB";
const AUTH_HEADER = `Bearer ${VALID_TOKEN}`;

describe("HTTP API", () => {
  let root: string;
  let storage: LocalFsRegistryStorage;
  let server: ServerHandle;
  let base: string;

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), "registry-http-"));
    storage = LocalFsRegistryStorage.fromRoot(root);
    server = await createServer({ storage });
    base = server.baseUrl;
  });

  afterEach(async () => {
    await server.close();
    storage.close();
    await fsp.rm(root, { recursive: true, force: true });
  });

  it("GET /v1/healthz is public + 200", async () => {
    const r = await fetch(`${base}/v1/healthz`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, version: "0.0.1" });
  });

  it("GET /v1/manifests/x without auth is 401", async () => {
    const r = await fetch(`${base}/v1/manifests/foo`);
    expect(r.status).toBe(401);
  });

  it("rejects malformed bearer tokens with 401", async () => {
    const r = await fetch(`${base}/v1/manifests/foo`, {
      headers: { authorization: "Bearer not-a-real-token" },
    });
    expect(r.status).toBe(401);
  });

  it("returns 400 on a non-hex sha in the URL", async () => {
    const r = await fetch(`${base}/v1/blobs/notasha`, {
      method: "PUT",
      headers: { authorization: AUTH_HEADER, "content-type": "application/octet-stream" },
      body: "x",
    });
    expect(r.status).toBe(400);
  });

  it("round-trips a blob via PUT + GET", async () => {
    const body = Buffer.from("hello-http");
    const sha = crypto.createHash("sha256").update(body).digest("hex");
    const put = await fetch(`${base}/v1/blobs/${sha}`, {
      method: "PUT",
      headers: { authorization: AUTH_HEADER, "content-type": "application/octet-stream" },
      body,
    });
    expect(put.status).toBe(201);
    const json = (await put.json()) as { blob: { sha256: string; size: number } };
    expect(json.blob.sha256).toBe(sha);
    expect(json.blob.size).toBe(body.length);

    const get = await fetch(`${base}/v1/blobs/${sha}`, {
      headers: { authorization: AUTH_HEADER },
    });
    expect(get.status).toBe(200);
    expect(get.headers.get("etag")).toBe(`"sha256:${sha}"`);
    const bytes = Buffer.from(await get.arrayBuffer());
    expect(bytes.equals(body)).toBe(true);
  });

  it("rejects a sha-mismatch on PUT", async () => {
    const body = Buffer.from("mismatch");
    const wrongSha = "0".repeat(64);
    const put = await fetch(`${base}/v1/blobs/${wrongSha}`, {
      method: "PUT",
      headers: { authorization: AUTH_HEADER, "content-type": "application/octet-stream" },
      body,
    });
    expect(put.status).toBe(400);
  });

  it("returns 404 on GET of a missing blob", async () => {
    const sha = "f".repeat(64);
    const r = await fetch(`${base}/v1/blobs/${sha}`, {
      headers: { authorization: AUTH_HEADER },
    });
    expect(r.status).toBe(404);
  });

  it("rejects manifest push referencing an unknown blob", async () => {
    const manifestBody = {
      mediaType: "application/vnd.signalman.manifest+json",
      blobs: [{ mediaType: "application/octet-stream", sha256: "a".repeat(64), size: 1 }],
    };
    const r = await fetch(`${base}/v1/manifests/demo/1.0.0`, {
      method: "PUT",
      headers: { authorization: AUTH_HEADER, "content-type": "application/json" },
      body: JSON.stringify(manifestBody),
    });
    expect(r.status).toBe(404);
  });

  it("round-trips a manifest + lists versions", async () => {
    // Upload a blob first.
    const blobBody = Buffer.from("blob1");
    const blobSha = crypto.createHash("sha256").update(blobBody).digest("hex");
    await fetch(`${base}/v1/blobs/${blobSha}`, {
      method: "PUT",
      headers: { authorization: AUTH_HEADER, "content-type": "application/octet-stream" },
      body: blobBody,
    });
    // Push two versions of a manifest referencing it.
    for (const version of ["1.0.0", "1.0.1"]) {
      const r = await fetch(`${base}/v1/manifests/${encodeURIComponent("demo/svc")}/${version}`, {
        method: "PUT",
        headers: { authorization: AUTH_HEADER, "content-type": "application/json" },
        body: JSON.stringify({
          mediaType: "application/vnd.signalman.manifest+json",
          blobs: [{ mediaType: "application/octet-stream", sha256: blobSha, size: blobBody.length }],
          annotations: { team: "platform" },
        }),
      });
      expect(r.status).toBe(201);
    }

    // List versions.
    const list = await fetch(
      `${base}/v1/manifests/${encodeURIComponent("demo/svc")}`,
      {
        headers: { authorization: AUTH_HEADER },
      },
    );
    expect(list.status).toBe(200);
    const { versions } = (await list.json()) as {
      versions: Array<{ version: string; signed: boolean }>;
    };
    expect(versions.map((v) => v.version).sort()).toEqual(["1.0.0", "1.0.1"]);
    expect(versions.every((v) => v.signed === false)).toBe(true);

    // Pull one.
    const pull = await fetch(
      `${base}/v1/manifests/${encodeURIComponent("demo/svc")}/1.0.0`,
      {
        headers: { authorization: AUTH_HEADER },
      },
    );
    expect(pull.status).toBe(200);
    const pullBody = (await pull.json()) as {
      manifest: Manifest;
      canonical_bytes_b64?: string;
    };
    expect(pullBody.manifest.annotations).toEqual({ team: "platform" });
    expect(pullBody.canonical_bytes_b64).toBeTypeOf("string");
  });

  it("rejects body name/version mismatches with 400", async () => {
    const r = await fetch(`${base}/v1/manifests/expected/1.0.0`, {
      method: "PUT",
      headers: { authorization: AUTH_HEADER, "content-type": "application/json" },
      body: JSON.stringify({
        name: "different",
        version: "9.9.9",
        mediaType: "application/json",
        blobs: [],
      }),
    });
    expect(r.status).toBe(400);
  });

  it("returns 404 on pull of an unknown manifest", async () => {
    const r = await fetch(`${base}/v1/manifests/nope/1.0.0`, {
      headers: { authorization: AUTH_HEADER },
    });
    expect(r.status).toBe(404);
  });

  it("DELETE manifest succeeds with admin scope (default for valid token)", async () => {
    const m = "del-test";
    await fetch(`${base}/v1/manifests/${m}/1.0.0`, {
      method: "PUT",
      headers: { authorization: AUTH_HEADER, "content-type": "application/json" },
      body: JSON.stringify({
        mediaType: "application/json",
        blobs: [],
      }),
    });
    const del = await fetch(`${base}/v1/manifests/${m}/1.0.0`, {
      method: "DELETE",
      headers: { authorization: AUTH_HEADER },
    });
    expect(del.status).toBe(204);
    const after = await fetch(`${base}/v1/manifests/${m}/1.0.0`, {
      headers: { authorization: AUTH_HEADER },
    });
    expect(after.status).toBe(404);
  });

  it("rejects manifest names with traversal sequences", async () => {
    // URL-encoded `../bar` as a single name segment should hit the
    // validator (`..` is forbidden) rather than write through.
    const traversal = encodeURIComponent("../bar");
    const r = await fetch(`${base}/v1/manifests/${traversal}/1.0.0`, {
      method: "PUT",
      headers: { authorization: AUTH_HEADER, "content-type": "application/json" },
      body: JSON.stringify({ mediaType: "application/json", blobs: [] }),
    });
    expect(r.status).toBe(400);
  });

  it("rejects manifest versions with whitespace", async () => {
    const r = await fetch(`${base}/v1/manifests/foo/${encodeURIComponent("1 0")}`, {
      method: "PUT",
      headers: { authorization: AUTH_HEADER, "content-type": "application/json" },
      body: JSON.stringify({ mediaType: "application/json", blobs: [] }),
    });
    expect(r.status).toBe(400);
  });

  it("returns 404 for unrouted paths", async () => {
    const r = await fetch(`${base}/nope/route`, {
      headers: { authorization: AUTH_HEADER },
    });
    expect(r.status).toBe(404);
  });

  it("denies DELETE when the configured authenticator strips the admin scope", async () => {
    // Boot a second server with a custom validator that returns
    // scopes = [] — modeling a future RBAC stance where read-only
    // tokens cannot delete.
    await server.close();
    server = await createServer({
      storage,
      auth: {
        acceptAnyValidShape: false,
        validateToken: async () => ({ tokenPrefix: "sk_test", scopes: [] }),
      },
    });
    base = server.baseUrl;
    const del = await fetch(`${base}/v1/manifests/x/1.0.0`, {
      method: "DELETE",
      headers: { authorization: AUTH_HEADER },
    });
    expect(del.status).toBe(403);
  });

  it("loopback bypass is opt-in", async () => {
    await server.close();
    server = await createServer({
      storage,
      auth: { allowLoopbackBypass: true },
    });
    base = server.baseUrl;
    const r = await fetch(`${base}/v1/manifests/foo`);
    expect(r.status).toBe(200);
  });

  it("system test: serve → push signed manifest → pull → verify", async () => {
    const keypair = generateKeypair();
    const body = Buffer.from("system-blob");
    const sha = crypto.createHash("sha256").update(body).digest("hex");
    await fetch(`${base}/v1/blobs/${sha}`, {
      method: "PUT",
      headers: { authorization: AUTH_HEADER, "content-type": "application/octet-stream" },
      body,
    });
    const draftManifest: Manifest = {
      name: "sys/svc",
      version: "0.1.0",
      mediaType: "application/vnd.signalman.manifest+json",
      blobs: [{ mediaType: "application/octet-stream", sha256: sha, size: body.length }],
      createdAt: "2026-05-14T12:00:00.000Z",
    };
    const sig = signManifest(draftManifest, keypair.privateKeyPem);
    const signedManifest = {
      ...draftManifest,
      signature: { signatureB64: sig.signatureB64, signedBy: sig.signedBy },
    };
    const push = await fetch(`${base}/v1/manifests/${encodeURIComponent("sys/svc")}/0.1.0`, {
      method: "PUT",
      headers: { authorization: AUTH_HEADER, "content-type": "application/json" },
      body: JSON.stringify(signedManifest),
    });
    expect(push.status).toBe(201);
    const pull = await fetch(`${base}/v1/manifests/${encodeURIComponent("sys/svc")}/0.1.0`, {
      headers: { authorization: AUTH_HEADER },
    });
    const pullBody = (await pull.json()) as {
      manifest: Manifest;
      canonical_bytes_b64?: string;
    };
    expect(pullBody.manifest.signature?.signedBy).toBe(sig.signedBy);
    // Pull-side verify: feed canonical bytes the server stored into
    // the verifier alongside the operator-supplied public key.
    const { verifyManifest } = await import("../signing.js");
    expect(
      verifyManifest(
        Buffer.from(pullBody.canonical_bytes_b64!, "base64"),
        pullBody.manifest.signature!,
        keypair.publicKeyPem,
      ),
    ).toBe(true);
  });
});
