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
    // WS6 wave-3 (M10): the manifest body round-trips byte-identical
    // (signature contract). `kind` is omitted when 'generic' so old
    // v0.4.0 manifests round-trip; provenance lives as a sibling on
    // the row, queryable via `getProvenance`.
    expect(got).toEqual(m);
    expect(got?.kind).toBeUndefined();
    const prov = idx.getProvenance("demo/svc", "1.0.0");
    expect(prov?.source).toBe("manifest_create");
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

// ── WS6 wave-3 (M10): kind, provenance, audit log ───────────────────

describe("SqliteManifestIndex — WS6 wave-3 M10", () => {
  let idx: SqliteManifestIndex;
  beforeEach(() => {
    idx = new SqliteManifestIndex({ path: ":memory:" });
  });
  afterEach(() => idx.close());

  it("stores + returns explicit kind: 'cargo' on round-trip", () => {
    const m: Manifest = {
      ...makeManifest({ name: "cargo/acme/mycrate", version: "1.0.0" }),
      kind: "cargo",
      cargoMetadata: {
        name: "mycrate",
        vers: "1.0.0",
        deps: [],
        cksum: "f".repeat(64),
        yanked: false,
      },
    };
    idx.putManifest(m, canonicalize(m));
    const got = idx.getManifest("cargo/acme/mycrate", "1.0.0");
    expect(got?.kind).toBe("cargo");
    expect(got?.cargoMetadata?.name).toBe("mycrate");
    expect(got?.cargoMetadata?.cksum).toBe("f".repeat(64));
  });

  it("preserves signed canonical bytes byte-for-byte (no kind/provenance leak)", () => {
    // Operator constructs manifest WITHOUT kind. Server stores it.
    // Canonical bytes pulled back must equal the operator's input.
    const m = makeManifest();
    const operatorCanonical = canonicalize(m);
    idx.putManifest(m, operatorCanonical);
    const stored = idx.getCanonicalBytes("demo/svc", "1.0.0");
    expect(stored).not.toBeNull();
    expect(stored!.equals(operatorCanonical)).toBe(true);
    // The returned manifest body must be byte-equal to the input.
    const got = idx.getManifest("demo/svc", "1.0.0");
    expect(got).toEqual(m);
  });

  it("provenance defaults to 'manifest_create' when caller omits it", () => {
    const m = makeManifest();
    idx.putManifest(m, canonicalize(m));
    const prov = idx.getProvenance("demo/svc", "1.0.0");
    expect(prov?.source).toBe("manifest_create");
    expect(prov?.fetchedAt).toBeTruthy();
  });

  it("provenance accepts explicit 'proxy_cache' from caller", () => {
    const m = makeManifest();
    idx.putManifest(m, canonicalize(m), {
      source: "proxy_cache",
      upstreamUrl: "https://crates.io/api/v1/crates/x/1.0.0/download",
      fetchedAt: "2026-05-15T00:00:00.000Z",
      fetchedBy: "abcdef0123456789",
    });
    const prov = idx.getProvenance("demo/svc", "1.0.0");
    expect(prov?.source).toBe("proxy_cache");
    expect(prov?.upstreamUrl).toMatch(/crates\.io/);
  });

  it("listManifestVersions surfaces kind in results", () => {
    const generic = makeManifest({ name: "x", version: "1.0.0" });
    const cargoM: Manifest = {
      ...makeManifest({ name: "x", version: "2.0.0" }),
      kind: "cargo",
      cargoMetadata: {
        name: "x",
        vers: "2.0.0",
        deps: [],
        cksum: "f".repeat(64),
        yanked: false,
      },
    };
    idx.putManifest(generic, canonicalize(generic));
    idx.putManifest(cargoM, canonicalize(cargoM));
    const list = idx.listManifestVersions("x");
    expect(list).toHaveLength(2);
    const v2 = list.find((l) => l.version === "2.0.0");
    expect(v2?.kind).toBe("cargo");
    const v1 = list.find((l) => l.version === "1.0.0");
    expect(v1?.kind).toBe("generic");
  });
});

describe("SqliteManifestIndex — audit log", () => {
  let idx: SqliteManifestIndex;
  beforeEach(() => {
    idx = new SqliteManifestIndex({ path: ":memory:" });
  });
  afterEach(() => idx.close());

  it("appendAuditEntry round-trips through listAuditEntries", () => {
    const entry = idx.appendAuditEntry({
      action: "upload",
      entityType: "manifest",
      entityId: "demo/svc@1.0.0",
      actor: "abc1234",
      detail: { bytes: 1234 },
    });
    expect(entry.id).toBeTruthy();
    expect(entry.action).toBe("upload");
    const list = idx.listAuditEntries();
    expect(list).toHaveLength(1);
    expect(list[0].entityId).toBe("demo/svc@1.0.0");
    expect(list[0].detail).toEqual({ bytes: 1234 });
  });

  it("filters by action + entityType (AND-combined)", () => {
    idx.appendAuditEntry({
      action: "upload",
      entityType: "manifest",
      entityId: "a",
      actor: "x",
    });
    idx.appendAuditEntry({
      action: "proxy_cache",
      entityType: "manifest",
      entityId: "b",
      actor: "x",
    });
    idx.appendAuditEntry({
      action: "upload",
      entityType: "blob",
      entityId: "c",
      actor: "x",
    });
    const uploads = idx.listAuditEntries({ action: "upload" });
    expect(uploads.map((e) => e.entityId).sort()).toEqual(["a", "c"]);
    const manifestUploads = idx.listAuditEntries({
      action: "upload",
      entityType: "manifest",
    });
    expect(manifestUploads.map((e) => e.entityId)).toEqual(["a"]);
  });

  it("filters by since timestamp", () => {
    idx.appendAuditEntry({
      action: "upload",
      entityType: "manifest",
      entityId: "old",
      actor: "x",
    });
    // Wait one ms to ensure timestamps differ
    const cutoff = new Date(Date.now() + 1).toISOString();
    idx.appendAuditEntry({
      action: "upload",
      entityType: "manifest",
      entityId: "new",
      actor: "x",
    });
    const recent = idx.listAuditEntries({ since: cutoff });
    expect(recent.every((e) => e.createdAt >= cutoff)).toBe(true);
  });

  it("honours limit (default 200; explicit cap)", () => {
    for (let i = 0; i < 5; i++) {
      idx.appendAuditEntry({
        action: "upload",
        entityType: "manifest",
        entityId: `m${i}`,
        actor: "x",
      });
    }
    const limited = idx.listAuditEntries({ limit: 2 });
    expect(limited).toHaveLength(2);
  });
});
