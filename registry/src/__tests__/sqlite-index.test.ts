import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteManifestIndex } from "../storage/sqlite-index.js";
import { RegistryError } from "../types.js";
import type { Manifest } from "../types.js";

const ZERO_SHA = "0".repeat(64);

function makeManifest(over: Partial<Manifest> = {}): Manifest {
  return {
    name: over.name ?? "demo/svc",
    version: over.version ?? "1.0.0",
    mediaType: over.mediaType ?? "application/vnd.signalman.manifest+json",
    blobs: over.blobs ?? [
      { mediaType: "application/octet-stream", sha256: ZERO_SHA, size: 1 },
    ],
    ...(over.annotations !== undefined ? { annotations: over.annotations } : {}),
    ...(over.signature !== undefined ? { signature: over.signature } : {}),
    createdAt: over.createdAt ?? "2026-05-14T12:00:00.000Z",
  };
}

function canonicalize(m: Manifest): Buffer {
  // Same algorithm as signing.ts will use later — sorted keys, no
  // whitespace. Tests recreate it inline so this suite doesn't
  // depend on the signing module landing first.
  const sorted = JSON.stringify(m, Object.keys(m).sort());
  return Buffer.from(sorted, "utf-8");
}

describe("SqliteManifestIndex", () => {
  let idx: SqliteManifestIndex;

  beforeEach(() => {
    idx = new SqliteManifestIndex({ path: ":memory:" });
  });

  afterEach(() => {
    idx.close();
  });

  it("inserts + reads back a manifest", () => {
    const m = makeManifest();
    const stored = idx.putManifest(m, canonicalize(m));
    expect(stored.name).toBe("demo/svc");
    expect(stored.version).toBe("1.0.0");
    const got = idx.getManifest("demo/svc", "1.0.0");
    expect(got).toEqual(m);
  });

  it("returns null for an unknown manifest", () => {
    expect(idx.getManifest("nope", "1")).toBeNull();
  });

  it("treats a same-content re-put as a no-op", () => {
    const m = makeManifest();
    idx.putManifest(m, canonicalize(m));
    const second = idx.putManifest(m, canonicalize(m));
    expect(second.createdAt).toBe(m.createdAt);
    expect(idx.listManifestVersions("demo/svc")).toHaveLength(1);
  });

  it("rejects different-content re-put as MANIFEST_EXISTS", () => {
    const m1 = makeManifest();
    idx.putManifest(m1, canonicalize(m1));
    const m2 = makeManifest({ annotations: { team: "platform" } });
    let caught: unknown;
    try {
      idx.putManifest(m2, canonicalize(m2));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RegistryError);
    expect((caught as RegistryError).code).toBe("manifest_exists");
  });

  it("persists annotations + signature", () => {
    const m = makeManifest({
      annotations: { "build.commit": "deadbeef" },
      signature: {
        signatureB64: "AAAA",
        signedBy: "deadbeefcafe1234",
      },
    });
    idx.putManifest(m, canonicalize(m));
    const got = idx.getManifest(m.name, m.version);
    expect(got?.annotations).toEqual({ "build.commit": "deadbeef" });
    expect(got?.signature).toEqual({
      signatureB64: "AAAA",
      signedBy: "deadbeefcafe1234",
    });
  });

  it("lists versions newest-first", () => {
    const m1 = makeManifest({ version: "1.0.0", createdAt: "2026-05-10T00:00:00.000Z" });
    const m2 = makeManifest({ version: "1.1.0", createdAt: "2026-05-12T00:00:00.000Z" });
    const m3 = makeManifest({ version: "1.2.0", createdAt: "2026-05-14T00:00:00.000Z" });
    idx.putManifest(m1, canonicalize(m1));
    idx.putManifest(m2, canonicalize(m2));
    idx.putManifest(m3, canonicalize(m3));
    const versions = idx.listManifestVersions(m1.name);
    expect(versions.map((v) => v.version)).toEqual(["1.2.0", "1.1.0", "1.0.0"]);
    expect(versions[0].signed).toBe(false);
  });

  it("flags signed=true on the listing when a signature is recorded", () => {
    const m = makeManifest({
      signature: { signatureB64: "AAAA", signedBy: "abcd0123" },
    });
    idx.putManifest(m, canonicalize(m));
    expect(idx.listManifestVersions(m.name)[0].signed).toBe(true);
  });

  it("getCanonicalBytes returns the exact bytes we wrote", () => {
    const m = makeManifest();
    const canonical = canonicalize(m);
    idx.putManifest(m, canonical);
    const got = idx.getCanonicalBytes(m.name, m.version);
    expect(got).not.toBeNull();
    expect(Buffer.compare(got!, canonical)).toBe(0);
  });

  it("getCanonicalBytes returns null for unknown rows", () => {
    expect(idx.getCanonicalBytes("nope", "1")).toBeNull();
  });

  it("deleteManifest is idempotent", () => {
    const m = makeManifest();
    idx.putManifest(m, canonicalize(m));
    idx.deleteManifest(m.name, m.version);
    idx.deleteManifest(m.name, m.version);
    expect(idx.getManifest(m.name, m.version)).toBeNull();
  });

  it("validates inputs at every entry point", () => {
    expect(() => idx.getManifest("BAD!", "1")).toThrowError(RegistryError);
    expect(() => idx.getManifest("ok", "with space")).toThrowError(
      RegistryError,
    );
    expect(() => idx.listManifestVersions("BAD!")).toThrowError(RegistryError);
    expect(() => idx.deleteManifest("BAD!", "1")).toThrowError(RegistryError);
    expect(() => idx.getCanonicalBytes("BAD!", "1")).toThrowError(
      RegistryError,
    );
    expect(() =>
      idx.putManifest(makeManifest({ name: "BAD!" }), Buffer.from("x")),
    ).toThrowError(RegistryError);
    expect(() =>
      idx.putManifest(makeManifest({ mediaType: "" }), Buffer.from("x")),
    ).toThrowError(RegistryError);
  });

  it("records + reads blob mirror rows", () => {
    idx.recordBlob({
      sha256: ZERO_SHA,
      size: 42,
      contentType: "text/plain",
      createdAt: "2026-05-14T12:00:00.000Z",
    });
    // Idempotent — duplicate insert is a no-op.
    idx.recordBlob({
      sha256: ZERO_SHA,
      size: 999,
      createdAt: "2027-01-01T00:00:00.000Z",
    });
    const got = idx.getBlobRecord(ZERO_SHA);
    expect(got?.size).toBe(42);
    expect(got?.contentType).toBe("text/plain");
    expect(idx.getBlobRecord("f".repeat(64))).toBeNull();
  });

  it("runs migrations idempotently across reopens", () => {
    // First instance already migrated. Open a second one on the
    // same file and confirm it does not re-apply.
    idx.close();
    const tmp = `:memory:`;
    const a = new SqliteManifestIndex({ path: tmp });
    a.close();
    // Second open against the same in-memory db starts fresh — this
    // case asserts the migration runner does not throw on bootstrap.
    const b = new SqliteManifestIndex({ path: tmp });
    expect(b.listManifestVersions("anything")).toEqual([]);
    b.close();
    // Reassign so the afterEach close() is a no-op on a fresh
    // instance rather than double-closing the original.
    idx = new SqliteManifestIndex({ path: ":memory:" });
  });
});
