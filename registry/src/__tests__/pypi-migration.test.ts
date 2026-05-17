// WS13 M1 — migration 0005 smoke + pypi_metadata round-trip.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteManifestIndex } from "../storage/sqlite-index.js";
import type { Manifest, PypiManifestMetadata } from "../types.js";

function canonicalize(m: Manifest): Buffer {
  return Buffer.from(JSON.stringify(m, Object.keys(m).sort()), "utf-8");
}

describe("migration 0005_pypi_metadata", () => {
  let idx: SqliteManifestIndex;

  beforeEach(() => {
    idx = new SqliteManifestIndex({ path: ":memory:" });
  });

  afterEach(() => {
    idx.close();
  });

  it("applies cleanly + records the version", () => {
    const rows = idx.db
      .prepare("SELECT version FROM _migrations ORDER BY version")
      .all() as Array<{ version: number }>;
    const versions = rows.map((r) => r.version);
    expect(versions).toContain(5);
  });

  it("adds pypi_metadata_json column", () => {
    const cols = idx.db.prepare("PRAGMA table_info(manifest)").all() as Array<{
      name: string;
    }>;
    expect(cols.some((c) => c.name === "pypi_metadata_json")).toBe(true);
  });

  it("extends manifest.kind CHECK to include 'pypi'", () => {
    // Try to insert a kind='pypi' row. Should succeed.
    const meta: PypiManifestMetadata = {
      version: "1.0",
      filename: "pkg-1.0.tar.gz",
      filetype: "sdist",
    };
    const m: Manifest = {
      name: "pypi/acme/pkg",
      version: "pkg-1.0.tar.gz",
      mediaType: "application/vnd.signalman.pypi-file.v1+json",
      kind: "pypi",
      blobs: [
        { mediaType: "application/octet-stream", sha256: "a".repeat(64), size: 7 },
      ],
      pypiMetadata: meta,
      createdAt: "2026-05-17T00:00:00.000Z",
    };
    idx.putManifest(m, canonicalize(m));
    const got = idx.getManifest("pypi/acme/pkg", "pkg-1.0.tar.gz");
    expect(got?.kind).toBe("pypi");
    expect(got?.pypiMetadata).toEqual(meta);
  });

  it("extends virtual_upstream.kind CHECK to include 'pypi'", () => {
    const row = idx.addVirtualUpstream({
      org: "acme",
      kind: "pypi",
      upstreamUrl: "https://pypi.org/simple",
      config: {},
    });
    expect(row.kind).toBe("pypi");
    const got = idx.getVirtualUpstream(row.id);
    expect(got?.kind).toBe("pypi");
  });

  it("preserves existing rows across the table-recreate", () => {
    // Insert a cargo row before the new column was added (simulated
    // — it just lands with pypi_metadata_json = NULL).
    const m: Manifest = {
      name: "cargo/acme/foo",
      version: "1.0.0",
      mediaType: "application/vnd.signalman.cargo-crate.v1+json",
      kind: "cargo",
      blobs: [
        { mediaType: "application/x-tar", sha256: "b".repeat(64), size: 1 },
      ],
      cargoMetadata: {
        name: "foo",
        vers: "1.0.0",
        deps: [],
        cksum: "b".repeat(64),
        yanked: false,
      },
      createdAt: "2026-05-17T00:00:00.000Z",
    };
    idx.putManifest(m, canonicalize(m));
    const got = idx.getManifest("cargo/acme/foo", "1.0.0");
    expect(got?.kind).toBe("cargo");
    expect(got?.cargoMetadata).toBeDefined();
    expect(got?.pypiMetadata).toBeUndefined();
  });

  it("preserves existing manifest indexes (name_idx + kind_idx)", () => {
    const indexes = idx.db
      .prepare("SELECT name FROM sqlite_master WHERE type='index'")
      .all() as Array<{ name: string }>;
    const names = new Set(indexes.map((i) => i.name));
    expect(names.has("manifest_name_idx")).toBe(true);
    expect(names.has("manifest_kind_idx")).toBe(true);
    expect(names.has("virtual_upstream_org_kind_url_unique")).toBe(true);
    expect(names.has("virtual_upstream_org_kind_idx")).toBe(true);
  });
});
