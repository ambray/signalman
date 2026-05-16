// WS10 (v0.5 OCI facade) — migration 0004 smoke + round-trip tests.
//
// Verifies that:
//   1. The schema delta applies cleanly to a fresh database (the
//      migration runner picks up 0004 alongside 0001-0003).
//   2. The new `oci_metadata_json` column on `manifest` round-trips
//      an `OciManifestMetadata` blob through putManifest /
//      getManifest.
//   3. The new `oci_tag` and `pending_blob_uploads` tables exist
//      with the expected columns + indexes. M2 / M3 populate them;
//      M1 just creates the shape.
//   4. The router's `*name` wildcard supports the multi-segment
//      capture that OCI `<name>` requires. (Sanity check; if the
//      router didn't support it we'd patch in M1.)

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteManifestIndex } from "../storage/sqlite-index.js";
import { Router } from "../http/router.js";
import type { Manifest, OciManifestMetadata } from "../types.js";

const ZERO_SHA = "0".repeat(64);
const ONE_SHA = "1".repeat(64);

function canonicalize(m: Manifest): Buffer {
  return Buffer.from(
    JSON.stringify(m, Object.keys(m).sort()),
    "utf-8",
  );
}

describe("migration 0004_oci_metadata", () => {
  let idx: SqliteManifestIndex;

  beforeEach(() => {
    idx = new SqliteManifestIndex({ path: ":memory:" });
  });

  afterEach(() => {
    idx.close();
  });

  it("applies cleanly and records the version in _migrations", () => {
    const versions = idx.db
      .prepare("SELECT version FROM _migrations ORDER BY version")
      .all() as Array<{ version: number }>;
    const ids = versions.map((v) => v.version);
    expect(ids).toContain(1);
    expect(ids).toContain(2);
    expect(ids).toContain(3);
    expect(ids).toContain(4);
  });

  it("adds oci_metadata_json column on manifest", () => {
    const cols = idx.db.prepare("PRAGMA table_info(manifest)").all() as Array<{
      name: string;
    }>;
    expect(cols.some((c) => c.name === "oci_metadata_json")).toBe(true);
  });

  it("creates oci_tag with the expected columns + primary key", () => {
    const cols = idx.db.prepare("PRAGMA table_info(oci_tag)").all() as Array<{
      name: string;
      pk: number;
    }>;
    const byName = Object.fromEntries(cols.map((c) => [c.name, c]));
    expect(byName.repository).toBeDefined();
    expect(byName.tag).toBeDefined();
    expect(byName.manifest_sha256).toBeDefined();
    expect(byName.updated_at).toBeDefined();
    // Composite primary key on (repository, tag).
    expect(byName.repository.pk).toBe(1);
    expect(byName.tag.pk).toBe(2);
  });

  it("creates pending_blob_uploads with the expected columns", () => {
    const cols = idx.db
      .prepare("PRAGMA table_info(pending_blob_uploads)")
      .all() as Array<{ name: string; pk: number }>;
    const names = cols.map((c) => c.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "upload_id",
        "repository",
        "chunks_json",
        "bytes_received",
        "created_at",
        "expires_at",
        "actor",
      ]),
    );
    const uploadId = cols.find((c) => c.name === "upload_id");
    expect(uploadId?.pk).toBe(1);
  });

  it("creates the expected indexes on the new tables", () => {
    const indexes = idx.db
      .prepare(
        "SELECT name, tbl_name FROM sqlite_master WHERE type = 'index'",
      )
      .all() as Array<{ name: string; tbl_name: string }>;
    const byTable = new Set(indexes.map((i) => `${i.tbl_name}:${i.name}`));
    expect(byTable.has("oci_tag:oci_tag_repository_idx")).toBe(true);
    expect(byTable.has("oci_tag:oci_tag_digest_idx")).toBe(true);
    expect(
      byTable.has("pending_blob_uploads:pending_blob_uploads_expires_idx"),
    ).toBe(true);
    expect(
      byTable.has("pending_blob_uploads:pending_blob_uploads_repo_idx"),
    ).toBe(true);
  });

  it("round-trips ociMetadata on a single-platform manifest", () => {
    const ociMetadata: OciManifestMetadata = {
      isIndex: false,
      schemaVariant: "oci-v1",
      configDigest: `sha256:${ZERO_SHA}`,
      configMediaType: "application/vnd.oci.image.config.v1+json",
      layerDigests: [`sha256:${ONE_SHA}`],
      totalSize: 1234,
    };
    const m: Manifest = {
      name: "oci/acme/alpine",
      version: "v3.20",
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      kind: "oci",
      blobs: [
        { mediaType: "application/vnd.oci.image.config.v1+json", sha256: ZERO_SHA },
        {
          mediaType: "application/vnd.oci.image.layer.v1.tar+gzip",
          sha256: ONE_SHA,
        },
      ],
      ociMetadata,
      createdAt: "2026-05-16T00:00:00.000Z",
    };
    idx.putManifest(m, canonicalize(m));
    const got = idx.getManifest("oci/acme/alpine", "v3.20");
    expect(got?.kind).toBe("oci");
    expect(got?.ociMetadata).toEqual(ociMetadata);
  });

  it("round-trips ociMetadata on an image-index manifest", () => {
    const ociMetadata: OciManifestMetadata = {
      isIndex: true,
      schemaVariant: "oci-v1",
      childManifests: [
        {
          digest: `sha256:${ZERO_SHA}`,
          mediaType: "application/vnd.oci.image.manifest.v1+json",
          size: 500,
          platform: { architecture: "amd64", os: "linux" },
        },
      ],
    };
    const m: Manifest = {
      name: "oci/acme/multiarch",
      version: "v1.0",
      mediaType: "application/vnd.oci.image.index.v1+json",
      kind: "oci",
      blobs: [],
      ociMetadata,
      createdAt: "2026-05-16T00:00:00.000Z",
    };
    idx.putManifest(m, canonicalize(m));
    const got = idx.getManifest("oci/acme/multiarch", "v1.0");
    expect(got?.ociMetadata?.isIndex).toBe(true);
    expect(got?.ociMetadata?.childManifests).toHaveLength(1);
  });

  it("leaves ociMetadata undefined on non-OCI manifests", () => {
    const m: Manifest = {
      name: "demo/svc",
      version: "1.0.0",
      mediaType: "application/vnd.signalman.manifest+json",
      blobs: [{ mediaType: "application/octet-stream", sha256: ZERO_SHA }],
      createdAt: "2026-05-16T00:00:00.000Z",
    };
    idx.putManifest(m, canonicalize(m));
    const got = idx.getManifest("demo/svc", "1.0.0");
    expect(got?.ociMetadata).toBeUndefined();
  });
});

describe("router *name wildcard (OCI multi-segment repository name)", () => {
  it("captures a slash-bearing repository name into a single param", async () => {
    const router = new Router();
    let captured: Record<string, string> | null = null;
    router.get(
      "/v2/*name/manifests/:reference",
      async (ctx) => {
        captured = { ...ctx.params };
        return { ok: true };
      },
    );
    // Synthesise a request through the router's listener.
    const req = mockReq("GET", "/v2/acme/team/svc/manifests/v1.0");
    const res = mockRes();
    await router.listener()(req, res);
    expect(captured).toEqual({ name: "acme/team/svc", reference: "v1.0" });
    expect(res._status).toBe(200);
  });

  it("anchors the pattern so trailing junk does not match", async () => {
    const router = new Router();
    router.get("/v2/*name/blobs/:digest", async () => ({ ok: true }));
    const req = mockReq("GET", "/v2/acme/svc/blobs/sha256:abc/extra");
    const res = mockRes();
    await router.listener()(req, res);
    expect(res._status).toBe(404);
  });

  it("does not match a path missing the literal segment after the wildcard", async () => {
    const router = new Router();
    router.get("/v2/*name/manifests/:reference", async () => ({ ok: true }));
    const req = mockReq("GET", "/v2/acme/svc/other/v1.0");
    const res = mockRes();
    await router.listener()(req, res);
    expect(res._status).toBe(404);
  });
});

// ── Mocking helpers (minimal node:http stand-ins). ────────────────

function mockReq(method: string, url: string) {
  // The router only reads .method, .url, .headers, .socket; we
  // satisfy that contract with a plain object + dummy on() that
  // emits an empty body. The body capping in capStreamBody is not
  // exercised for these routes (no streamBody opt-in).
  const handlers = new Map<string, (...args: unknown[]) => void>();
  return {
    method,
    url,
    headers: {} as Record<string, string>,
    socket: { remoteAddress: "127.0.0.1" },
    on(ev: string, cb: (...args: unknown[]) => void): void {
      handlers.set(ev, cb);
      if (ev === "end") setImmediate(() => cb());
    },
    destroy(): void {
      /* no-op */
    },
  } as unknown as import("node:http").IncomingMessage;
}

function mockRes() {
  const headers: Record<string, string> = {};
  return {
    _status: 0,
    _body: "",
    headersSent: false,
    statusCode: 0,
    setHeader(k: string, v: string): void {
      headers[k] = v;
    },
    getHeader(k: string): string | undefined {
      return headers[k];
    },
    end(body?: string): void {
      this.headersSent = true;
      this._status = this.statusCode;
      this._body = body ?? "";
    },
    on(): void {
      /* no-op for piped responses */
    },
  } as unknown as import("node:http").ServerResponse & {
    _status: number;
    _body: string;
  };
}
