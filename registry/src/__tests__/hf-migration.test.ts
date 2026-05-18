// WS13 M4 — migration 0008 smoke + hf_metadata + hf_revision round-trips.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SqliteManifestIndex,
  type HfRevisionInsert,
} from "../storage/sqlite-index.js";
import type { HfManifestMetadata, Manifest } from "../types.js";

function canonicalize(m: Manifest): Buffer {
  return Buffer.from(JSON.stringify(m, Object.keys(m).sort()), "utf-8");
}

describe("migration 0008_hf_metadata", () => {
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
    expect(rows.map((r) => r.version)).toContain(8);
  });

  it("adds hf_metadata_json column to manifest", () => {
    const cols = idx.db.prepare("PRAGMA table_info(manifest)").all() as Array<{
      name: string;
    }>;
    expect(cols.some((c) => c.name === "hf_metadata_json")).toBe(true);
  });

  it("creates hf_revision table with the locked composite PK", () => {
    const cols = idx.db.prepare("PRAGMA table_info(hf_revision)").all() as Array<{
      name: string;
      pk: number;
    }>;
    expect(cols.map((c) => c.name)).toEqual(
      expect.arrayContaining([
        "org",
        "repo",
        "repo_type",
        "revision",
        "root_tree_digest",
        "parent_revision",
        "files_json",
        "provenance_json",
        "created_at",
      ]),
    );
    const pkCols = cols
      .filter((c) => c.pk > 0)
      .sort((a, b) => a.pk - b.pk)
      .map((c) => c.name);
    expect(pkCols).toEqual(["org", "repo", "repo_type", "revision"]);
  });

  it("extends manifest.kind CHECK to include 'hf'", () => {
    const meta: HfManifestMetadata = {
      org: "acme",
      repo: "demo-model",
      repoType: "model",
      revision: "v1",
      path: "config.json",
      lfs: false,
      sha256: "a".repeat(64),
      size: 7,
    };
    const m: Manifest = {
      name: "hf/acme/demo-model/model",
      version: "v1:config.json",
      mediaType: "application/vnd.signalman.hf-file.v1+json",
      kind: "hf",
      blobs: [
        { mediaType: "application/json", sha256: "a".repeat(64), size: 7 },
      ],
      hfMetadata: meta,
      createdAt: "2026-05-17T00:00:00.000Z",
    };
    idx.putManifest(m, canonicalize(m));
    const got = idx.getManifest(m.name, m.version);
    expect(got?.kind).toBe("hf");
    expect(got?.hfMetadata).toEqual(meta);
  });

  it("extends virtual_upstream.kind CHECK to include 'huggingface'", () => {
    const row = idx.addVirtualUpstream({
      org: "acme",
      kind: "huggingface",
      upstreamUrl: "https://huggingface.co",
      config: { hf_max_blob_bytes: 1024 },
    });
    expect(row.kind).toBe("huggingface");
    const got = idx.getVirtualUpstream(row.id);
    expect(got?.kind).toBe("huggingface");
    expect(got?.config.hf_max_blob_bytes).toBe(1024);
  });

  it("preserves manifest_name_idx + manifest_kind_idx after recreate", () => {
    const indexes = idx.db
      .prepare("SELECT name FROM sqlite_master WHERE type='index'")
      .all() as Array<{ name: string }>;
    const names = new Set(indexes.map((i) => i.name));
    expect(names.has("manifest_name_idx")).toBe(true);
    expect(names.has("manifest_kind_idx")).toBe(true);
    expect(names.has("virtual_upstream_org_kind_url_unique")).toBe(true);
    expect(names.has("hf_revision_created_idx")).toBe(true);
  });

  it("preserves existing rows (cargo/maven/nuget) across the table-recreate", () => {
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
    expect(got?.hfMetadata).toBeUndefined();
  });

  it("rejects kind values outside the new CHECK list", () => {
    expect(() => {
      idx.db
        .prepare(
          `INSERT INTO manifest (name, version, media_type, blobs_json, canonical_bytes, created_at, kind)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run("x", "y", "text/plain", "[]", Buffer.from(""), "2026", "bogus");
    }).toThrow();
  });
});

describe("hf_revision CRUD", () => {
  let idx: SqliteManifestIndex;

  beforeEach(() => {
    idx = new SqliteManifestIndex({ path: ":memory:" });
  });

  afterEach(() => {
    idx.close();
  });

  const REV: HfRevisionInsert = {
    org: "acme",
    repo: "demo-model",
    repoType: "model",
    revision: "v1",
    rootTreeDigest: "abc123",
    files: [
      { path: "config.json", sha256: "a".repeat(64), size: 7, lfs: false },
      { path: "weights.bin", sha256: "b".repeat(64), size: 200_000_000, lfs: true },
    ],
    createdAt: "2026-05-17T00:00:00.000Z",
  };

  it("inserts + reads a revision row", () => {
    const stored = idx.putHfRevision(REV);
    expect(stored.revision).toBe("v1");
    expect(stored.files.length).toBe(2);

    const got = idx.getHfRevision("acme", "demo-model", "model", "v1");
    expect(got?.rootTreeDigest).toBe("abc123");
    expect(got?.files[0].path).toBe("config.json");
    expect(got?.files[1].lfs).toBe(true);
  });

  it("returns null for unknown revisions", () => {
    expect(
      idx.getHfRevision("acme", "demo-model", "model", "v2"),
    ).toBeNull();
  });

  it("re-inserting identical content is idempotent", () => {
    idx.putHfRevision(REV);
    expect(() => idx.putHfRevision(REV)).not.toThrow();
  });

  it("re-inserting with different files raises MANIFEST_EXISTS", () => {
    idx.putHfRevision(REV);
    expect(() =>
      idx.putHfRevision({
        ...REV,
        files: [{ path: "other.bin", sha256: "c".repeat(64), size: 1, lfs: false }],
      }),
    ).toThrow(/already exists/);
  });

  it("lists revisions newest-first", () => {
    idx.putHfRevision({ ...REV, revision: "v1", createdAt: "2026-05-17T00:00:00.000Z" });
    idx.putHfRevision({
      ...REV,
      revision: "v2",
      createdAt: "2026-05-17T01:00:00.000Z",
    });
    const all = idx.listHfRevisions("acme", "demo-model", "model");
    expect(all.map((r) => r.revision)).toEqual(["v2", "v1"]);
  });

  it("updateHfRevision overwrites an existing 'main' sentinel row", () => {
    const mainInsert = { ...REV, revision: "main" };
    idx.putHfRevision(mainInsert);
    const updated = idx.updateHfRevision({
      ...mainInsert,
      rootTreeDigest: "xyz789",
      files: [{ path: "new.bin", sha256: "c".repeat(64), size: 1, lfs: false }],
      createdAt: "2026-05-17T02:00:00.000Z",
    });
    expect(updated.rootTreeDigest).toBe("xyz789");
    const got = idx.getHfRevision("acme", "demo-model", "model", "main");
    expect(got?.rootTreeDigest).toBe("xyz789");
    expect(got?.files.length).toBe(1);
  });

  it("updateHfRevision on an absent row inserts (falls through)", () => {
    idx.updateHfRevision({ ...REV, revision: "first" });
    const got = idx.getHfRevision("acme", "demo-model", "model", "first");
    expect(got).not.toBeNull();
  });

  it("rejects an unknown repo_type via the CHECK constraint", () => {
    expect(() => {
      idx.db
        .prepare(
          `INSERT INTO hf_revision
             (org, repo, repo_type, revision, root_tree_digest, files_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run("acme", "demo", "bogus", "v1", "x", "[]", "2026");
    }).toThrow();
  });

  it("composite PK rejects an exact-key INSERT collision", () => {
    idx.putHfRevision(REV);
    expect(() => {
      idx.db
        .prepare(
          `INSERT INTO hf_revision
             (org, repo, repo_type, revision, root_tree_digest, files_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run("acme", "demo-model", "model", "v1", "y", "[]", "2026");
    }).toThrow();
  });
});
