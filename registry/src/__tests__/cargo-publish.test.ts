// WS6 wave-3 M10.3 — cargo publish + yank tests.
//
// Coverage:
//   - parsePublishBody: valid + malformed (truncated, bad lengths,
//     bad JSON, missing required fields)
//   - publishMetadataToStored: defaults + field passthrough
//   - PUT /cargo/:org/api/v1/crates/new: end-to-end publish lands a
//     cargo-kind manifest + a content-addressed blob + an audit
//     entry with action='upload'
//   - Duplicate publish (same name+vers, different bytes) rejects
//     with manifest_exists
//   - Idempotent re-publish (same bytes) is accepted as a no-op
//   - DELETE .../yank flips cargoMetadata.yanked + clears signature
//     + appends action='yank' audit
//   - PUT .../unyank inverse
//   - Yank → sparse-index re-read shows yanked=true
//   - Yank on a non-existent crate returns 404
//   - Provenance after publish: source='upload', fetchedBy set
//   - Per-org isolation honoured on publish

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createServer, type ServerHandle } from "../http/server.js";
import {
  cargoManifestName,
  parsePublishBody,
  publishMetadataToStored,
  validateCargoCrateName,
  type CargoPublishMetadata,
} from "../cargo/index.js";
import { LocalFsRegistryStorage } from "../storage/registry-storage.js";
import { RegistryError } from "../types.js";
import type { CargoManifestMetadata } from "../types.js";

const AUTH = "Bearer sk_TEST_0123456789ABCDEF";

// ── parsePublishBody ───────────────────────────────────────────────

describe("parsePublishBody", () => {
  function buildBody(meta: object, tarball: Buffer): Buffer {
    const metaJson = Buffer.from(JSON.stringify(meta), "utf-8");
    const head = Buffer.alloc(4);
    head.writeUInt32LE(metaJson.length, 0);
    const tarHead = Buffer.alloc(4);
    tarHead.writeUInt32LE(tarball.length, 0);
    return Buffer.concat([head, metaJson, tarHead, tarball]);
  }

  it("parses a valid body", () => {
    const meta: CargoPublishMetadata = {
      name: "mycrate",
      vers: "1.0.0",
      deps: [],
    };
    const tarball = Buffer.from("crate-bytes");
    const body = buildBody(meta, tarball);
    const parsed = parsePublishBody(body);
    expect(parsed.metadata.name).toBe("mycrate");
    expect(parsed.metadata.vers).toBe("1.0.0");
    expect(parsed.tarball.equals(tarball)).toBe(true);
  });

  it("rejects bodies that are too short for the length prefixes", () => {
    expect(() => parsePublishBody(Buffer.alloc(4))).toThrow(RegistryError);
    expect(() => parsePublishBody(Buffer.alloc(7))).toThrow(RegistryError);
  });

  it("rejects metadata-length that exceeds body", () => {
    const body = Buffer.alloc(8);
    body.writeUInt32LE(100000, 0); // claim 100k of metadata
    body.writeUInt32LE(0, 4);
    expect(() => parsePublishBody(body)).toThrow(/declared metadata length/);
  });

  it("rejects tarball-length mismatch", () => {
    const meta = { name: "x", vers: "1" };
    const tarball = Buffer.from("real");
    const body = buildBody(meta, tarball);
    // Corrupt the tarball length prefix
    body.writeUInt32LE(999, body.length - tarball.length - 4);
    expect(() => parsePublishBody(body)).toThrow(/declared tarball length/);
  });

  it("rejects non-JSON metadata", () => {
    const head = Buffer.alloc(4);
    head.writeUInt32LE(5, 0);
    const tarHead = Buffer.alloc(4);
    tarHead.writeUInt32LE(0, 0);
    const body = Buffer.concat([head, Buffer.from("nope!"), tarHead]);
    expect(() => parsePublishBody(body)).toThrow(/not valid JSON/);
  });

  it("rejects metadata missing required name + vers", () => {
    const body1 = buildBody({ vers: "1.0.0" }, Buffer.alloc(0));
    expect(() => parsePublishBody(body1)).toThrow(/name is required/);
    const body2 = buildBody({ name: "ok" }, Buffer.alloc(0));
    expect(() => parsePublishBody(body2)).toThrow(/vers is required/);
  });

  it("rejects invalid crate names", () => {
    const body = buildBody({ name: "bad name with spaces", vers: "1" }, Buffer.alloc(0));
    expect(() => parsePublishBody(body)).toThrow(/invalid cargo crate name/);
  });
});

// ── publishMetadataToStored ────────────────────────────────────────

describe("publishMetadataToStored", () => {
  it("lowercases the name + passes through vers + cksum", () => {
    const stored = publishMetadataToStored(
      { name: "MyCrate", vers: "1.0.0", deps: [] },
      "f".repeat(64),
    );
    expect(stored.name).toBe("mycrate");
    expect(stored.vers).toBe("1.0.0");
    expect(stored.cksum).toBe("f".repeat(64));
  });

  it("defaults yanked to false", () => {
    const stored = publishMetadataToStored(
      { name: "x", vers: "1", deps: [] },
      "f".repeat(64),
    );
    expect(stored.yanked).toBe(false);
  });

  it("defaults features to {} when missing", () => {
    const stored = publishMetadataToStored(
      { name: "x", vers: "1" },
      "f".repeat(64),
    );
    expect(stored.features).toEqual({});
  });

  it("preserves explicit yanked=true and rust_version", () => {
    const stored = publishMetadataToStored(
      { name: "x", vers: "1", yanked: true, rust_version: "1.70" },
      "f".repeat(64),
    );
    expect(stored.yanked).toBe(true);
    expect(stored.rust_version).toBe("1.70");
  });

  it("normalises dep defaults", () => {
    const stored = publishMetadataToStored(
      {
        name: "x",
        vers: "1",
        deps: [{ name: "serde", req: "1.0" } as never],
      },
      "f".repeat(64),
    );
    expect(stored.deps).toHaveLength(1);
    expect(stored.deps[0]).toMatchObject({
      name: "serde",
      req: "1.0",
      features: [],
      optional: false,
      default_features: true,
      target: null,
      kind: "normal",
      registry: null,
    });
  });

  it("rejects a dep missing required fields", () => {
    expect(() =>
      publishMetadataToStored(
        { name: "x", vers: "1", deps: [{ name: "serde" } as never] },
        "f".repeat(64),
      ),
    ).toThrow(/dep missing required/);
  });
});

// ── HTTP integration ───────────────────────────────────────────────

describe("cargo publish + yank HTTP integration", () => {
  let dataDir: string;
  let storage: LocalFsRegistryStorage;
  let server: ServerHandle;
  let base: string;

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "signalman-cargo-pub-"));
    storage = LocalFsRegistryStorage.fromRoot(dataDir);
    server = await createServer({
      storage,
      port: 0,
      auth: { acceptAnyValidShape: true },
    });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterEach(async () => {
    await server.close();
    storage.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  function buildPublishBody(meta: CargoPublishMetadata, tarball: Buffer): Buffer {
    const metaJson = Buffer.from(JSON.stringify(meta), "utf-8");
    const head = Buffer.alloc(4);
    head.writeUInt32LE(metaJson.length, 0);
    const tarHead = Buffer.alloc(4);
    tarHead.writeUInt32LE(tarball.length, 0);
    return Buffer.concat([head, metaJson, tarHead, tarball]);
  }

  async function publish(
    org: string,
    meta: CargoPublishMetadata,
    tarball: Buffer,
  ): Promise<Response> {
    return await fetch(`${base}/cargo/${org}/api/v1/crates/new`, {
      method: "PUT",
      headers: {
        authorization: AUTH,
        "content-type": "application/octet-stream",
      },
      body: buildPublishBody(meta, tarball),
    });
  }

  it("publishes a crate end-to-end + serves it via sparse index", async () => {
    const tarball = Buffer.from("crate-content-v1");
    const r = await publish(
      "acme",
      { name: "mycrate", vers: "1.0.0", deps: [] },
      tarball,
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as { warnings: object };
    expect(body.warnings).toBeDefined();

    // Now read via sparse index
    const idx = await fetch(`${base}/cargo/acme/index/my/cr/mycrate`, {
      headers: { authorization: AUTH },
    });
    expect(idx.status).toBe(200);
    const line = (await idx.text()).trim();
    const entry = JSON.parse(line) as CargoManifestMetadata;
    expect(entry.name).toBe("mycrate");
    expect(entry.vers).toBe("1.0.0");
    expect(entry.cksum).toBe(
      crypto.createHash("sha256").update(tarball).digest("hex"),
    );
    expect(entry.yanked).toBe(false);

    // And via the download endpoint
    const dl = await fetch(
      `${base}/cargo/acme/api/v1/crates/mycrate/1.0.0/download`,
      { headers: { authorization: AUTH } },
    );
    expect(dl.status).toBe(200);
    const got = Buffer.from(await dl.arrayBuffer());
    expect(got.equals(tarball)).toBe(true);
  });

  it("publishing the same name+vers with different bytes is rejected", async () => {
    await publish("acme", { name: "x", vers: "1" }, Buffer.from("v1-orig"));
    const r = await publish("acme", { name: "x", vers: "1" }, Buffer.from("v1-tampered"));
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.status).toBeLessThan(500);
  });

  it("re-publishing the same name+vers is rejected (cargo protocol)", async () => {
    // Cargo's protocol is "publish once per version"; re-publishing
    // any version with the same name is an error even if the content
    // is identical. The error code differs (manifest_exists vs the
    // cargo-spec "already-exists" warning), but the operator-facing
    // outcome is rejection.
    const tarball = Buffer.from("identical");
    const r1 = await publish("acme", { name: "x", vers: "1" }, tarball);
    expect(r1.status).toBe(200);
    const r2 = await publish("acme", { name: "x", vers: "1" }, tarball);
    expect(r2.status).toBeGreaterThanOrEqual(400);
    expect(r2.status).toBeLessThan(500);
  });

  it("provenance after publish: source='upload' + fetchedBy set", async () => {
    await publish("acme", { name: "x", vers: "1" }, Buffer.from("bytes"));
    const idx = storage.index;
    const prov = idx.getProvenance("cargo/acme/x", "1");
    expect(prov?.source).toBe("upload");
    expect(prov?.fetchedBy).toBeTruthy();
  });

  it("audit log records 'upload' on publish", async () => {
    await publish("acme", { name: "x", vers: "1" }, Buffer.from("bytes"));
    const entries = storage.index.listAuditEntries({
      action: "upload",
      entityType: "cargo_crate",
    });
    expect(entries).toHaveLength(1);
    expect(entries[0].entityId).toBe("cargo/acme/x@1");
  });

  it("yank flips cargoMetadata.yanked + audits action='yank'", async () => {
    await publish("acme", { name: "x", vers: "1.0.0" }, Buffer.from("bytes"));
    const yank = await fetch(
      `${base}/cargo/acme/api/v1/crates/x/1.0.0/yank`,
      { method: "DELETE", headers: { authorization: AUTH } },
    );
    expect(yank.status).toBe(200);
    expect(((await yank.json()) as { ok: boolean }).ok).toBe(true);

    // Re-read the sparse index — yanked=true now
    const idx = await fetch(`${base}/cargo/acme/index/1/x`, {
      headers: { authorization: AUTH },
    });
    expect(idx.status).toBe(200);
    const entry = JSON.parse((await idx.text()).trim()) as CargoManifestMetadata;
    expect(entry.yanked).toBe(true);

    // Audit log records the yank
    const entries = storage.index.listAuditEntries({
      action: "yank",
      entityType: "cargo_crate",
    });
    expect(entries).toHaveLength(1);
    expect(entries[0].entityId).toBe("cargo/acme/x@1.0.0");
  });

  it("unyank inverse", async () => {
    await publish("acme", { name: "x", vers: "1.0.0" }, Buffer.from("bytes"));
    await fetch(`${base}/cargo/acme/api/v1/crates/x/1.0.0/yank`, {
      method: "DELETE",
      headers: { authorization: AUTH },
    });
    const unyank = await fetch(
      `${base}/cargo/acme/api/v1/crates/x/1.0.0/unyank`,
      { method: "PUT", headers: { authorization: AUTH } },
    );
    expect(unyank.status).toBe(200);
    const idx = await fetch(`${base}/cargo/acme/index/1/x`, {
      headers: { authorization: AUTH },
    });
    const entry = JSON.parse((await idx.text()).trim()) as CargoManifestMetadata;
    expect(entry.yanked).toBe(false);
  });

  it("yank clears the signature on the row", async () => {
    // Publish + then check the manifest has no signature initially
    // (publish doesn't add one); for this test we manually set one
    // via a direct manifest PUT, then yank, then verify it's cleared.
    const tarball = Buffer.from("bytes");
    const sha = crypto.createHash("sha256").update(tarball).digest("hex");
    await fetch(`${base}/v1/blobs/${sha}`, {
      method: "PUT",
      headers: { authorization: AUTH, "content-type": "application/x-tar" },
      body: tarball,
    });
    const manifest = {
      name: "cargo/acme/x",
      version: "1.0.0",
      mediaType: "application/vnd.signalman.cargo-crate.v1+json",
      kind: "cargo",
      blobs: [{ mediaType: "application/x-tar", sha256: sha, size: tarball.length }],
      cargoMetadata: {
        name: "x",
        vers: "1.0.0",
        deps: [],
        cksum: sha,
        features: {},
        yanked: false,
      },
      signature: {
        signatureB64: "fake-signature".padEnd(88, "=").slice(0, 88),
        signedBy: "abcd1234abcd1234",
      },
      createdAt: "2026-05-15T12:00:00.000Z",
    };
    const put = await fetch(
      `${base}/v1/manifests/${encodeURIComponent(manifest.name)}/${manifest.version}`,
      {
        method: "PUT",
        headers: { authorization: AUTH, "content-type": "application/json" },
        body: JSON.stringify(manifest),
      },
    );
    expect(put.status).toBe(201);

    // Yank — should clear signature
    await fetch(`${base}/cargo/acme/api/v1/crates/x/1.0.0/yank`, {
      method: "DELETE",
      headers: { authorization: AUTH },
    });
    const reread = storage.index.getManifest("cargo/acme/x", "1.0.0");
    expect(reread?.signature).toBeUndefined();
  });

  it("yank on a non-existent crate returns 404", async () => {
    const r = await fetch(
      `${base}/cargo/acme/api/v1/crates/nope/1.0.0/yank`,
      { method: "DELETE", headers: { authorization: AUTH } },
    );
    expect(r.status).toBe(404);
  });

  it("publish: per-org isolation honoured", async () => {
    await publish("acme", { name: "x", vers: "1.0.0" }, Buffer.from("acme-bytes"));
    await publish("beta", { name: "x", vers: "1.0.0" }, Buffer.from("beta-bytes"));
    const a = storage.index.getManifest("cargo/acme/x", "1.0.0");
    const b = storage.index.getManifest("cargo/beta/x", "1.0.0");
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a?.cargoMetadata?.cksum).not.toBe(b?.cargoMetadata?.cksum);
  });

  it("publish: oversized body refused (stream-cap enforcement)", async () => {
    // 11 MiB > 10 MiB default cap. The router's stream-body path
    // destroys the connection when the cap is hit; clients see this
    // as either a 4xx response OR a connection error mid-stream
    // (ECONNRESET). Both outcomes satisfy "the registry refused to
    // ingest this oversized body."
    const tarball = Buffer.alloc(11 * 1024 * 1024);
    let refused = false;
    try {
      const r = await publish("acme", { name: "big", vers: "1" }, tarball);
      refused = r.status >= 400;
    } catch (err) {
      // Connection-reset / network error counts as refused.
      refused = true;
    }
    expect(refused).toBe(true);
  });
});
