// WS6 wave-3 M10.2 — cargo sparse-index read path tests.
//
// Coverage:
//   - Path helpers (sparseIndexPathFor + inverse): every cargo-spec
//     depth (1 / 2 / 3 / 4+) round-trips correctly. Invalid names
//     rejected.
//   - config.json: returns the cargo-spec shape with dl + api URLs.
//   - Sparse-index entries: NDJSON shape, one line per version,
//     empty crate returns 404.
//   - Crate download: streams the .crate tarball; non-cargo manifest
//     rejected; missing crate returns 404.
//   - Per-org namespacing: same crate name under two orgs is two
//     independent crates.
//
// We exercise the handlers via the buildApp router (HTTP system
// test) so the rawResponse + body-stream plumbing is exercised
// end-to-end. The compile-time test is in path-helpers.test.ts
// scope below.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createServer, type ServerHandle } from "../http/server.js";
import {
  cargoManifestName,
  crateNameFromSparseIndexPath,
  sparseIndexPathFor,
  validateCargoCrateName,
  validateCargoOrgName,
} from "../cargo/index.js";
import { LocalFsRegistryStorage } from "../storage/registry-storage.js";
import type { CargoManifestMetadata, Manifest } from "../types.js";
import { RegistryError } from "../types.js";

// ── Path helpers ───────────────────────────────────────────────────

describe("cargo path helpers", () => {
  it("sparseIndexPathFor: 1-char name → 1/<name>", () => {
    expect(sparseIndexPathFor("a")).toBe("1/a");
  });
  it("sparseIndexPathFor: 2-char name → 2/<name>", () => {
    expect(sparseIndexPathFor("ab")).toBe("2/ab");
  });
  it("sparseIndexPathFor: 3-char name → 3/<first>/<name>", () => {
    expect(sparseIndexPathFor("abc")).toBe("3/a/abc");
  });
  it("sparseIndexPathFor: 5-char name → <first-2>/<3-4>/<name>", () => {
    expect(sparseIndexPathFor("serde")).toBe("se/rd/serde");
  });
  it("sparseIndexPathFor: 10-char name → <first-2>/<3-4>/<name>", () => {
    expect(sparseIndexPathFor("tokio-util")).toBe("to/ki/tokio-util");
  });
  it("sparseIndexPathFor: mixed-case lowercases the prefix dirs", () => {
    expect(sparseIndexPathFor("Serde")).toBe("se/rd/Serde");
  });
  it("sparseIndexPathFor: rejects invalid chars", () => {
    expect(() => sparseIndexPathFor("foo bar")).toThrow(RegistryError);
    expect(() => sparseIndexPathFor("../etc")).toThrow(RegistryError);
    expect(() => sparseIndexPathFor("")).toThrow(RegistryError);
  });
  it("crateNameFromSparseIndexPath: every depth round-trips", () => {
    for (const name of ["a", "ab", "abc", "serde", "tokio-util", "foo_bar"]) {
      const path = sparseIndexPathFor(name);
      expect(crateNameFromSparseIndexPath(path)).toBe(name);
    }
  });
  it("crateNameFromSparseIndexPath: malformed path returns null", () => {
    expect(crateNameFromSparseIndexPath("garbage")).toBeNull();
    expect(crateNameFromSparseIndexPath("1/")).toBeNull();
    expect(crateNameFromSparseIndexPath("1/abc")).toBeNull(); // wrong depth for 3-char
    // Mismatched prefix dirs vs actual name: each rejects.
    expect(crateNameFromSparseIndexPath("se/rd/wrong-prefix")).toBeNull(); // "wrong-prefix" prefix dirs are "wr/on"
    expect(crateNameFromSparseIndexPath("xx/yy/serde")).toBeNull();
  });
  it("validateCargoCrateName accepts alphanumeric + _ -", () => {
    expect(() => validateCargoCrateName("tokio-util")).not.toThrow();
    expect(() => validateCargoCrateName("foo_bar")).not.toThrow();
    expect(() => validateCargoCrateName("FooBar")).not.toThrow();
    expect(() => validateCargoCrateName("123")).not.toThrow();
  });
  it("validateCargoCrateName rejects bad shapes", () => {
    expect(() => validateCargoCrateName("")).toThrow();
    expect(() => validateCargoCrateName("foo bar")).toThrow();
    expect(() => validateCargoCrateName("foo/bar")).toThrow();
    expect(() => validateCargoCrateName("a".repeat(65))).toThrow();
  });
  it("validateCargoOrgName accepts hyphenated lowercase", () => {
    expect(() => validateCargoOrgName("acme")).not.toThrow();
    expect(() => validateCargoOrgName("my-org")).not.toThrow();
  });
  it("validateCargoOrgName rejects uppercase / start-with-hyphen / dots", () => {
    expect(() => validateCargoOrgName("Acme")).toThrow();
    expect(() => validateCargoOrgName("-acme")).toThrow();
    expect(() => validateCargoOrgName("acme.io")).toThrow();
  });
  it("cargoManifestName composes the storage-layer name", () => {
    expect(cargoManifestName("acme", "tokio-util")).toBe("cargo/acme/tokio-util");
    // Lowercases the crate (cargo's index uses lowercased lookup)
    expect(cargoManifestName("acme", "TokioUtil")).toBe("cargo/acme/tokioutil");
  });
});

// ── HTTP integration ───────────────────────────────────────────────

describe("cargo sparse-index HTTP integration", () => {
  let dataDir: string;
  let storage: LocalFsRegistryStorage;
  let server: ServerHandle;
  let base: string;
  // Use a fixed bearer token; the server accepts any shape-valid
  // token in dev mode.
  // sk_<4-16 Crockford-b32 prefix>_<16-64 Crockford-b32 secret>
  const AUTH = "Bearer sk_TEST_0123456789ABCDEF";

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "signalman-cargo-read-"));
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

  async function publishCargoManifest(
    org: string,
    crate: string,
    version: string,
    tarball: Buffer,
    extra: Partial<CargoManifestMetadata> = {},
  ): Promise<void> {
    // Upload the blob first
    const sha = require("node:crypto")
      .createHash("sha256")
      .update(tarball)
      .digest("hex");
    await fetch(`${base}/v1/blobs/${sha}`, {
      method: "PUT",
      headers: { authorization: AUTH, "content-type": "application/x-tar" },
      body: tarball,
    });
    const manifest: Manifest = {
      name: cargoManifestName(org, crate),
      version,
      mediaType: "application/vnd.signalman.cargo-crate.v1+json",
      kind: "cargo",
      blobs: [{ mediaType: "application/x-tar", sha256: sha, size: tarball.length, name: `${crate}-${version}.crate` }],
      cargoMetadata: {
        name: crate.toLowerCase(),
        vers: version,
        deps: [],
        cksum: sha,
        features: {},
        yanked: false,
        ...extra,
      },
      createdAt: "2026-05-15T12:00:00.000Z",
    };
    const r = await fetch(
      `${base}/v1/manifests/${encodeURIComponent(manifest.name)}/${encodeURIComponent(version)}`,
      {
        method: "PUT",
        headers: { authorization: AUTH, "content-type": "application/json" },
        body: JSON.stringify(manifest),
      },
    );
    if (r.status !== 201) {
      const t = await r.text();
      throw new Error(`publish failed: ${r.status} ${t}`);
    }
  }

  it("GET /cargo/:org/index/config.json returns the cargo-spec shape", async () => {
    const r = await fetch(`${base}/cargo/acme/index/config.json`, {
      headers: { authorization: AUTH },
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { dl: string; api: string };
    expect(body.dl).toBe(
      "/cargo/acme/api/v1/crates/{crate}/{version}/download",
    );
    expect(body.api).toBe("/cargo/acme");
  });

  it("returns 404 for unknown crate", async () => {
    const r = await fetch(`${base}/cargo/acme/index/se/rd/serde`, {
      headers: { authorization: AUTH },
    });
    expect(r.status).toBe(404);
  });

  it("returns 404 for malformed sparse-index path", async () => {
    const r = await fetch(`${base}/cargo/acme/index/xx/yy/serde`, {
      headers: { authorization: AUTH },
    });
    expect(r.status).toBe(404);
  });

  it("publish + read: returns NDJSON with one line per version", async () => {
    await publishCargoManifest("acme", "mycrate", "1.0.0", Buffer.from("v1.0"));
    await publishCargoManifest("acme", "mycrate", "1.1.0", Buffer.from("v1.1"));
    const r = await fetch(`${base}/cargo/acme/index/my/cr/mycrate`, {
      headers: { authorization: AUTH },
    });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toMatch(/json/);
    const text = await r.text();
    const lines = text.trim().split("\n");
    expect(lines).toHaveLength(2);
    const entries = lines.map((l) => JSON.parse(l) as CargoManifestMetadata);
    expect(entries.map((e) => e.vers).sort()).toEqual(["1.0.0", "1.1.0"]);
    expect(entries[0].cksum).toMatch(/^[0-9a-f]{64}$/);
    expect(entries[0].yanked).toBe(false);
  });

  it("download endpoint serves the .crate tarball bytes", async () => {
    const body = Buffer.from("crate-tarball-bytes");
    await publishCargoManifest("acme", "mycrate", "1.0.0", body);
    const r = await fetch(
      `${base}/cargo/acme/api/v1/crates/mycrate/1.0.0/download`,
      { headers: { authorization: AUTH } },
    );
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("application/x-tar");
    expect(r.headers.get("content-disposition")).toContain("mycrate-1.0.0.crate");
    const got = Buffer.from(await r.arrayBuffer());
    expect(got.equals(body)).toBe(true);
  });

  it("download endpoint returns 404 for unknown version", async () => {
    await publishCargoManifest("acme", "mycrate", "1.0.0", Buffer.from("x"));
    const r = await fetch(
      `${base}/cargo/acme/api/v1/crates/mycrate/2.0.0/download`,
      { headers: { authorization: AUTH } },
    );
    expect(r.status).toBe(404);
  });

  it("download refuses a generic manifest (kind != cargo)", async () => {
    // Upload a blob + a generic manifest under the cargo namespace —
    // this would be a misuse (operator writes directly to
    // /v1/manifests with the cargo/* name but without kind: 'cargo').
    const body = Buffer.from("not-a-crate");
    const sha = require("node:crypto")
      .createHash("sha256")
      .update(body)
      .digest("hex");
    await fetch(`${base}/v1/blobs/${sha}`, {
      method: "PUT",
      headers: { authorization: AUTH, "content-type": "application/octet-stream" },
      body,
    });
    const m = {
      name: "cargo/acme/mycrate",
      version: "1.0.0",
      mediaType: "application/octet-stream",
      // No kind field — defaults to generic on the read side
      blobs: [{ mediaType: "application/octet-stream", sha256: sha, size: body.length }],
      createdAt: "2026-05-15T12:00:00.000Z",
    };
    await fetch(
      `${base}/v1/manifests/${encodeURIComponent(m.name)}/${m.version}`,
      {
        method: "PUT",
        headers: { authorization: AUTH, "content-type": "application/json" },
        body: JSON.stringify(m),
      },
    );
    const r = await fetch(
      `${base}/cargo/acme/api/v1/crates/mycrate/1.0.0/download`,
      { headers: { authorization: AUTH } },
    );
    expect(r.status).toBe(404);
    const err = (await r.json()) as { error: { code: string } };
    expect(err.error.code).toBe("bad_manifest");
  });

  it("per-org namespacing: same crate name under two orgs is independent", async () => {
    await publishCargoManifest("acme", "mycrate", "1.0.0", Buffer.from("acme-v1"));
    await publishCargoManifest("beta", "mycrate", "2.0.0", Buffer.from("beta-v2"));

    const acme = await fetch(`${base}/cargo/acme/index/my/cr/mycrate`, {
      headers: { authorization: AUTH },
    });
    expect(acme.status).toBe(200);
    const acmeLines = (await acme.text()).trim().split("\n");
    expect(acmeLines).toHaveLength(1);
    expect((JSON.parse(acmeLines[0]) as CargoManifestMetadata).vers).toBe("1.0.0");

    const beta = await fetch(`${base}/cargo/beta/index/my/cr/mycrate`, {
      headers: { authorization: AUTH },
    });
    expect(beta.status).toBe(200);
    const betaLines = (await beta.text()).trim().split("\n");
    expect(betaLines).toHaveLength(1);
    expect((JSON.parse(betaLines[0]) as CargoManifestMetadata).vers).toBe("2.0.0");
  });

  it("rejects malformed org name", async () => {
    const r = await fetch(`${base}/cargo/Bad-ORG/index/config.json`, {
      headers: { authorization: AUTH },
    });
    // Uppercase orgs fail validation. The handler returns a 4xx;
    // exact code depends on how validateCargoOrgName surfaces.
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.status).toBeLessThan(500);
  });

  it("yanked sparse-index entries are surfaced verbatim (yanked=true)", async () => {
    await publishCargoManifest("acme", "yanked", "1.0.0", Buffer.from("v1"), {
      yanked: true,
    });
    const r = await fetch(`${base}/cargo/acme/index/ya/nk/yanked`, {
      headers: { authorization: AUTH },
    });
    expect(r.status).toBe(200);
    const line = (await r.text()).trim();
    const entry = JSON.parse(line) as CargoManifestMetadata;
    expect(entry.yanked).toBe(true);
  });
});
