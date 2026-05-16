// WS10 M3 — tag store SQL helpers.
//
// Covers tag insertion, idempotent re-put, rotation detection,
// listing pagination, cascade delete by digest, and the spec-
// ordered ASCII tag-list emission.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteManifestIndex } from "../storage/sqlite-index.js";
import { TagStore } from "../oci/index.js";

const REPO = "oci/acme/svc";
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);
const FIXED_NOW = new Date("2026-05-16T00:00:00.000Z");

describe("TagStore", () => {
  let idx: SqliteManifestIndex;
  let tags: TagStore;

  beforeEach(() => {
    idx = new SqliteManifestIndex({ path: ":memory:" });
    tags = new TagStore({ index: idx, now: () => FIXED_NOW });
  });

  afterEach(() => {
    idx.close();
  });

  it("put() inserts a fresh row + reports non-rotation", () => {
    const result = tags.put(REPO, "v1.0", SHA_A);
    expect(result).toEqual({ rotated: false });
    const got = tags.get(REPO, "v1.0");
    expect(got).toEqual({
      repository: REPO,
      tag: "v1.0",
      manifestSha256: SHA_A,
      updatedAt: FIXED_NOW.toISOString(),
    });
  });

  it("put() with same digest is idempotent (rotated=false)", () => {
    tags.put(REPO, "v1.0", SHA_A);
    const result = tags.put(REPO, "v1.0", SHA_A);
    expect(result).toEqual({ rotated: false });
  });

  it("put() with new digest rotates (rotated=true + previousSha256)", () => {
    tags.put(REPO, "latest", SHA_A);
    const result = tags.put(REPO, "latest", SHA_B);
    expect(result.rotated).toBe(true);
    expect(result.previousSha256).toBe(SHA_A);
    const got = tags.get(REPO, "latest");
    expect(got?.manifestSha256).toBe(SHA_B);
  });

  it("get() returns null for unknown tag", () => {
    expect(tags.get(REPO, "missing")).toBeNull();
  });

  it("list() emits tags in ASCII order", () => {
    tags.put(REPO, "v2", SHA_A);
    tags.put(REPO, "v1", SHA_B);
    tags.put(REPO, "latest", SHA_C);
    const rows = tags.list(REPO);
    expect(rows.map((r) => r.tag)).toEqual(["latest", "v1", "v2"]);
  });

  it("list() honours after-cursor + limit (paginated by tag)", () => {
    for (const t of ["a", "b", "c", "d", "e"]) tags.put(REPO, t, SHA_A);
    const page1 = tags.list(REPO, { limit: 2 });
    expect(page1.map((r) => r.tag)).toEqual(["a", "b"]);
    const page2 = tags.list(REPO, { after: page1[page1.length - 1].tag, limit: 2 });
    expect(page2.map((r) => r.tag)).toEqual(["c", "d"]);
    const page3 = tags.list(REPO, { after: page2[page2.length - 1].tag, limit: 2 });
    expect(page3.map((r) => r.tag)).toEqual(["e"]);
  });

  it("list() default limit (no opts) returns everything", () => {
    for (const t of ["a", "b", "c"]) tags.put(REPO, t, SHA_A);
    expect(tags.list(REPO).map((r) => r.tag)).toEqual(["a", "b", "c"]);
  });

  it("list() scopes to the repository (no cross-repo bleed)", () => {
    tags.put(REPO, "v1", SHA_A);
    tags.put("oci/acme/other", "v1", SHA_B);
    expect(tags.list(REPO).map((r) => r.tag)).toEqual(["v1"]);
    expect(tags.list("oci/acme/other").map((r) => r.manifestSha256)).toEqual([
      SHA_B,
    ]);
  });

  it("delete() removes a tag pointer and reports it", () => {
    tags.put(REPO, "v1.0", SHA_A);
    expect(tags.delete(REPO, "v1.0")).toBe(true);
    expect(tags.get(REPO, "v1.0")).toBeNull();
  });

  it("delete() is idempotent (reports false on missing tag)", () => {
    expect(tags.delete(REPO, "missing")).toBe(false);
  });

  it("deleteByDigest() drops every tag pointing at the digest", () => {
    tags.put(REPO, "v1.0", SHA_A);
    tags.put(REPO, "stable", SHA_A);
    tags.put(REPO, "v1.1", SHA_B);
    const removed = tags.deleteByDigest(REPO, SHA_A);
    expect(removed.sort()).toEqual(["stable", "v1.0"]);
    expect(tags.list(REPO).map((r) => r.tag)).toEqual(["v1.1"]);
  });

  it("deleteByDigest() returns empty when no tag points at the digest", () => {
    tags.put(REPO, "v1.0", SHA_A);
    expect(tags.deleteByDigest(REPO, SHA_B)).toEqual([]);
  });

  it("updatedAt is refreshed on rotation", () => {
    const later = new Date("2026-05-17T00:00:00.000Z");
    let clock = FIXED_NOW;
    const advancing = new TagStore({ index: idx, now: () => clock });
    advancing.put(REPO, "latest", SHA_A);
    clock = later;
    advancing.put(REPO, "latest", SHA_B);
    expect(advancing.get(REPO, "latest")?.updatedAt).toBe(later.toISOString());
  });
});
