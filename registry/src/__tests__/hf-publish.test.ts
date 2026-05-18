// WS13 M4 Story 4 — publish + tar parser.

import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalFsRegistryStorage } from "../storage/registry-storage.js";
import {
  HF_DEFAULT_LFS_THRESHOLD,
  HF_ERROR_CODES,
  HfError,
  hfManifestName,
  hfManifestVersion,
  parseUstarTar,
  publishHfTarball,
} from "../hf/index.js";

/** Synthesise a USTAR tar archive. */
function buildTar(
  entries: Array<{
    path: string;
    bytes: Buffer;
    typeflag?: string;
    mode?: number;
    /** Override the size field to simulate corruption. */
    declaredSize?: number;
  }>,
): Buffer {
  const out: Buffer[] = [];
  for (const e of entries) {
    const header = makeHeader(
      e.path,
      e.declaredSize ?? e.bytes.length,
      e.typeflag ?? "0",
      e.mode ?? 0o644,
    );
    out.push(header);
    out.push(e.bytes);
    const pad = (512 - (e.bytes.length % 512)) % 512;
    if (pad > 0) out.push(Buffer.alloc(pad));
  }
  // Two zero blocks (end-of-archive marker).
  out.push(Buffer.alloc(512));
  out.push(Buffer.alloc(512));
  return Buffer.concat(out);
}

function makeHeader(name: string, size: number, typeflag: string, mode: number): Buffer {
  const header = Buffer.alloc(512);
  const nameBuf = Buffer.from(name, "utf-8");
  if (nameBuf.length > 100) throw new Error("name too long for USTAR header in this test helper");
  nameBuf.copy(header, 0);
  writeOctal(header, 100, 8, mode);
  writeOctal(header, 108, 8, 0); // uid
  writeOctal(header, 116, 8, 0); // gid
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, 0); // mtime
  // checksum field initially spaces (8 ASCII spaces).
  for (let i = 148; i < 156; i++) header[i] = 0x20;
  header[156] = typeflag.charCodeAt(0);
  // USTAR magic + version
  Buffer.from("ustar\0").copy(header, 257);
  Buffer.from("00").copy(header, 263);
  // recompute checksum
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += header[i];
  writeOctal(header, 148, 7, sum);
  header[155] = 0; // null-terminate per USTAR
  return header;
}

function writeOctal(buf: Buffer, off: number, len: number, value: number): void {
  const s = value.toString(8).padStart(len - 1, "0");
  Buffer.from(s, "utf-8").copy(buf, off);
  buf[off + len - 1] = 0;
}

function sha256Hex(b: Buffer): string {
  return crypto.createHash("sha256").update(b).digest("hex");
}

function bodyOf(buf: Buffer): Readable {
  return Readable.from([buf]);
}

describe("parseUstarTar", () => {
  it("walks regular files", async () => {
    const tar = buildTar([
      { path: "config.json", bytes: Buffer.from('{"hidden":12}') },
      { path: "weights.bin", bytes: Buffer.alloc(1024, 0x42) },
    ]);
    const got: Array<{ path: string; size: number; sha: string }> = [];
    await parseUstarTar(bodyOf(tar), async (entry) => {
      const chunks: Buffer[] = [];
      for await (const c of entry.payload) chunks.push(c as Buffer);
      const body = Buffer.concat(chunks);
      got.push({ path: entry.name, size: entry.size, sha: sha256Hex(body) });
    });
    expect(got.map((e) => e.path)).toEqual(["config.json", "weights.bin"]);
    expect(got[1].size).toBe(1024);
  });

  it("skips directory entries", async () => {
    const tar = buildTar([
      { path: "dir/", bytes: Buffer.alloc(0), typeflag: "5" },
      { path: "dir/file.txt", bytes: Buffer.from("hi") },
    ]);
    const names: string[] = [];
    await parseUstarTar(bodyOf(tar), async (e) => {
      names.push(e.name);
      for await (const _ of e.payload) void _;
    });
    expect(names).toEqual(["dir/file.txt"]);
  });

  it("rejects symlinks", async () => {
    const tar = buildTar([{ path: "link", bytes: Buffer.alloc(0), typeflag: "2" }]);
    let caught: unknown;
    try {
      await parseUstarTar(bodyOf(tar), async () => {});
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(HfError);
    expect((caught as HfError).code).toBe(HF_ERROR_CODES.UPLOAD_INVALID);
    expect((caught as HfError).message).toMatch(/symlink/);
  });

  it("rejects hardlinks", async () => {
    const tar = buildTar([{ path: "hl", bytes: Buffer.alloc(0), typeflag: "1" }]);
    let caught: unknown;
    try {
      await parseUstarTar(bodyOf(tar), async () => {});
    } catch (err) {
      caught = err;
    }
    expect((caught as HfError).code).toBe(HF_ERROR_CODES.UPLOAD_INVALID);
  });

  it("rejects device files / FIFOs", async () => {
    for (const flag of ["3", "4", "6"]) {
      const tar = buildTar([{ path: "x", bytes: Buffer.alloc(0), typeflag: flag }]);
      let caught: unknown;
      try {
        await parseUstarTar(bodyOf(tar), async () => {});
      } catch (err) {
        caught = err;
      }
      expect((caught as HfError).code).toBe(HF_ERROR_CODES.UPLOAD_INVALID);
    }
  });

  it("rejects GNU long-name / PAX headers", async () => {
    for (const flag of ["L", "K", "x", "g"]) {
      const tar = buildTar([{ path: "x", bytes: Buffer.alloc(0), typeflag: flag }]);
      let caught: unknown;
      try {
        await parseUstarTar(bodyOf(tar), async () => {});
      } catch (err) {
        caught = err;
      }
      expect((caught as HfError).code).toBe(HF_ERROR_CODES.UPLOAD_INVALID);
    }
  });

  it("rejects unknown typeflag", async () => {
    const tar = buildTar([{ path: "x", bytes: Buffer.alloc(0), typeflag: "Z" }]);
    let caught: unknown;
    try {
      await parseUstarTar(bodyOf(tar), async () => {});
    } catch (err) {
      caught = err;
    }
    expect((caught as HfError).code).toBe(HF_ERROR_CODES.UPLOAD_INVALID);
  });

  it("rejects a corrupt checksum", async () => {
    const tar = buildTar([{ path: "x", bytes: Buffer.from("hi") }]);
    // Flip a byte in the header.
    tar[10] = (tar[10] + 1) & 0xff;
    let caught: unknown;
    try {
      await parseUstarTar(bodyOf(tar), async () => {});
    } catch (err) {
      caught = err;
    }
    expect((caught as HfError).code).toBe(HF_ERROR_CODES.UPLOAD_INVALID);
    expect((caught as HfError).message).toMatch(/checksum/);
  });

  it("handles small chunked input (1-byte at a time)", async () => {
    const tar = buildTar([{ path: "config.json", bytes: Buffer.from("hello world!") }]);
    const chunked = Array.from({ length: tar.length }, (_, i) => tar.subarray(i, i + 1));
    const src = Readable.from(chunked);
    const seen: string[] = [];
    await parseUstarTar(src, async (e) => {
      const chunks: Buffer[] = [];
      for await (const c of e.payload) chunks.push(c as Buffer);
      seen.push(Buffer.concat(chunks).toString());
    });
    expect(seen).toEqual(["hello world!"]);
  });

  it("parses an empty archive (zero blocks only)", async () => {
    const empty = Buffer.concat([Buffer.alloc(512), Buffer.alloc(512)]);
    const seen: string[] = [];
    await parseUstarTar(bodyOf(empty), async (e) => {
      seen.push(e.name);
    });
    expect(seen).toEqual([]);
  });

  it("returns cleanly on premature EOF before any block", async () => {
    const empty = Buffer.alloc(0);
    await parseUstarTar(bodyOf(empty), async () => {});
  });

  it("tolerates EOF after one zero block (lenient end-of-archive)", async () => {
    const tar = buildTar([{ path: "x.txt", bytes: Buffer.from("ok") }]);
    // Truncate the second zero block.
    const oneZero = tar.subarray(0, tar.length - 512);
    const seen: string[] = [];
    await parseUstarTar(bodyOf(oneZero), async (e) => {
      for await (const _ of e.payload) void _;
      seen.push(e.name);
    });
    expect(seen).toEqual(["x.txt"]);
  });

  it("handles a header missing the padding-to-next-block boundary", async () => {
    const tar = buildTar([{ path: "x.txt", bytes: Buffer.from("12") }]);
    // Cut off the trailing zero blocks AND part of the padding.
    const truncated = tar.subarray(0, 512 + 2); // header + 2 bytes; no padding
    let caught: unknown;
    try {
      await parseUstarTar(bodyOf(truncated), async (e) => {
        for await (const _ of e.payload) void _;
      });
    } catch (err) {
      caught = err;
    }
    expect((caught as HfError).code).toBe(HF_ERROR_CODES.UPLOAD_INVALID);
    expect((caught as HfError).message).toMatch(/padding/);
  });

  it("rejects oversize tar numeric field (GNU base-256 over MAX_SAFE_INTEGER)", async () => {
    const block = Buffer.alloc(512);
    // Plant a sized GNU base-256 field: high bit set, then 11 bytes of 0xff.
    block[124] = 0x80;
    for (let i = 125; i < 136; i++) block[i] = 0xff;
    // Fill with valid name + type so we get to parse the size.
    Buffer.from("name").copy(block, 0);
    // Mode + uid + gid: octal '0' padded
    Buffer.from("0000000\0").copy(block, 100);
    Buffer.from("0000000\0").copy(block, 108);
    Buffer.from("0000000\0").copy(block, 116);
    Buffer.from("0000000\0").copy(block, 136);
    block[156] = "0".charCodeAt(0);
    Buffer.from("ustar\0").copy(block, 257);
    Buffer.from("00").copy(block, 263);
    // Init checksum field to spaces
    for (let i = 148; i < 156; i++) block[i] = 0x20;
    // Compute correct checksum
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += block[i];
    const s = sum.toString(8).padStart(6, "0");
    Buffer.from(s, "utf-8").copy(block, 148);
    block[148 + 6] = 0;
    block[148 + 7] = 0x20;
    const tar = Buffer.concat([block, Buffer.alloc(1024)]);
    let caught: unknown;
    try {
      await parseUstarTar(bodyOf(tar), async () => {});
    } catch (err) {
      caught = err;
    }
    expect((caught as HfError).code).toBe(HF_ERROR_CODES.UPLOAD_INVALID);
  });

  it("rejects a non-octal size field", async () => {
    const block = Buffer.alloc(512);
    Buffer.from("name").copy(block, 0);
    Buffer.from("0000000\0").copy(block, 100);
    Buffer.from("0000000\0").copy(block, 108);
    Buffer.from("0000000\0").copy(block, 116);
    // size field contains invalid characters (8 + 9 are not octal digits).
    Buffer.from("89XXXX\0").copy(block, 124);
    Buffer.from("0000000\0").copy(block, 136);
    block[156] = "0".charCodeAt(0);
    Buffer.from("ustar\0").copy(block, 257);
    Buffer.from("00").copy(block, 263);
    for (let i = 148; i < 156; i++) block[i] = 0x20;
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += block[i];
    const cs = sum.toString(8).padStart(6, "0");
    Buffer.from(cs, "utf-8").copy(block, 148);
    block[148 + 6] = 0;
    block[148 + 7] = 0x20;
    const tar = Buffer.concat([block, Buffer.alloc(1024)]);
    let caught: unknown;
    try {
      await parseUstarTar(bodyOf(tar), async () => {});
    } catch (err) {
      caught = err;
    }
    expect((caught as HfError).code).toBe(HF_ERROR_CODES.UPLOAD_INVALID);
  });

  it("rejects truncated entry payload", async () => {
    const tar = buildTar([{ path: "x", bytes: Buffer.alloc(1024, 0x42) }]);
    // Truncate before the payload is complete (cut to half the body).
    const truncated = tar.subarray(0, 512 + 500);
    let caught: unknown;
    try {
      await parseUstarTar(bodyOf(truncated), async (e) => {
        // drain whatever arrives
        for await (const _ of e.payload) void _;
      });
    } catch (err) {
      caught = err;
    }
    expect((caught as HfError).code).toBe(HF_ERROR_CODES.UPLOAD_INVALID);
    expect((caught as HfError).message).toMatch(/truncated/);
  });
});

describe("publishHfTarball", () => {
  let root: string;
  let storage: LocalFsRegistryStorage;
  const ORG = "acme";
  const REPO = "demo-model";

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "hf-publish-"));
    storage = LocalFsRegistryStorage.fromRoot(root);
  });

  afterEach(async () => {
    storage.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("publishes a flat tarball + writes per-file manifest rows + revision row", async () => {
    const configBytes = Buffer.from('{"hidden":768}');
    const weightsBytes = Buffer.alloc(HF_DEFAULT_LFS_THRESHOLD + 1024, 0x42);
    const tar = buildTar([
      { path: "config.json", bytes: configBytes },
      { path: "weights.bin", bytes: weightsBytes },
    ]);
    const result = await publishHfTarball({
      storage,
      index: storage.index,
      org: ORG,
      repo: REPO,
      repoType: "model",
      revision: "v1",
      body: bodyOf(tar),
      actor: "test-actor",
    });
    expect(result.file_count).toBe(2);
    expect(result.total_bytes).toBe(configBytes.length + weightsBytes.length);

    // Per-file manifest rows.
    const cfgRow = await storage.getManifest(
      hfManifestName(ORG, REPO, "model"),
      hfManifestVersion("v1", "config.json"),
    );
    expect(cfgRow?.hfMetadata?.lfs).toBe(false);
    expect(cfgRow?.hfMetadata?.sha256).toBe(sha256Hex(configBytes));

    const wRow = await storage.getManifest(
      hfManifestName(ORG, REPO, "model"),
      hfManifestVersion("v1", "weights.bin"),
    );
    expect(wRow?.hfMetadata?.lfs).toBe(true);
    expect(wRow?.hfMetadata?.lfsOid).toBe(`sha256:${sha256Hex(weightsBytes)}`);

    // Revision row.
    const rev = storage.index.getHfRevision(ORG, REPO, "model", "v1");
    expect(rev?.files.length).toBe(2);
    expect(rev?.files.map((f) => f.path).sort()).toEqual(["config.json", "weights.bin"]);

    // 'main' sentinel was updated to point at v1.
    const main = storage.index.getHfRevision(ORG, REPO, "model", "main");
    expect(main?.files.length).toBe(2);
    expect(main?.rootTreeDigest).toBe(rev?.rootTreeDigest);

    // Audit-log entry written.
    const audit = storage.index.listAuditEntries({
      action: "upload",
      entityType: "manifest",
    });
    expect(audit.length).toBeGreaterThan(0);
    expect(audit[0].detail?.kind).toBe("hf");
    expect(audit[0].detail?.revision).toBe("v1");
  });

  it("publishing 'main' directly does not double-update the sentinel", async () => {
    const tar = buildTar([{ path: "config.json", bytes: Buffer.from("x") }]);
    await publishHfTarball({
      storage,
      index: storage.index,
      org: ORG,
      repo: REPO,
      repoType: "model",
      revision: "main",
      body: bodyOf(tar),
    });
    const main = storage.index.getHfRevision(ORG, REPO, "model", "main");
    expect(main?.files.length).toBe(1);
  });

  it("rejects an empty tar (zero regular files)", async () => {
    const tar = buildTar([{ path: "emptydir/", bytes: Buffer.alloc(0), typeflag: "5" }]);
    let caught: unknown;
    try {
      await publishHfTarball({
        storage,
        index: storage.index,
        org: ORG,
        repo: REPO,
        repoType: "model",
        revision: "v1",
        body: bodyOf(tar),
      });
    } catch (err) {
      caught = err;
    }
    expect((caught as HfError).code).toBe(HF_ERROR_CODES.UPLOAD_INVALID);
  });

  it("rejects a tarball with a symlink entry", async () => {
    const tar = buildTar([
      { path: "config.json", bytes: Buffer.from("x") },
      { path: "link", bytes: Buffer.alloc(0), typeflag: "2" },
    ]);
    let caught: unknown;
    try {
      await publishHfTarball({
        storage,
        index: storage.index,
        org: ORG,
        repo: REPO,
        repoType: "model",
        revision: "v1",
        body: bodyOf(tar),
      });
    } catch (err) {
      caught = err;
    }
    expect((caught as HfError).code).toBe(HF_ERROR_CODES.UPLOAD_INVALID);
  });

  it("rejects path traversal in entries", async () => {
    const tar = buildTar([{ path: "../escape.txt", bytes: Buffer.from("x") }]);
    let caught: unknown;
    try {
      await publishHfTarball({
        storage,
        index: storage.index,
        org: ORG,
        repo: REPO,
        repoType: "model",
        revision: "v1",
        body: bodyOf(tar),
      });
    } catch (err) {
      caught = err;
    }
    expect((caught as HfError).code).toBe(HF_ERROR_CODES.PATH_INVALID);
  });

  it("rejects oversize blob", async () => {
    const tar = buildTar([{ path: "big.bin", bytes: Buffer.alloc(2048, 0x42) }]);
    let caught: unknown;
    try {
      await publishHfTarball({
        storage,
        index: storage.index,
        org: ORG,
        repo: REPO,
        repoType: "model",
        revision: "v1",
        body: bodyOf(tar),
        maxBlobBytes: 1024,
      });
    } catch (err) {
      caught = err;
    }
    expect((caught as HfError).code).toBe(HF_ERROR_CODES.TOO_LARGE);
  });

  it("rejects duplicate path entries", async () => {
    const tar = buildTar([
      { path: "a.txt", bytes: Buffer.from("first") },
      { path: "a.txt", bytes: Buffer.from("second") },
    ]);
    let caught: unknown;
    try {
      await publishHfTarball({
        storage,
        index: storage.index,
        org: ORG,
        repo: REPO,
        repoType: "model",
        revision: "v1",
        body: bodyOf(tar),
      });
    } catch (err) {
      caught = err;
    }
    expect((caught as HfError).code).toBe(HF_ERROR_CODES.UPLOAD_INVALID);
    expect((caught as HfError).message).toMatch(/duplicate/);
  });

  it("409 CONFLICT when republishing a revision with different files", async () => {
    const tarA = buildTar([{ path: "a.txt", bytes: Buffer.from("aaa") }]);
    const tarB = buildTar([{ path: "b.txt", bytes: Buffer.from("bbb") }]);
    await publishHfTarball({
      storage,
      index: storage.index,
      org: ORG,
      repo: REPO,
      repoType: "model",
      revision: "v1",
      body: bodyOf(tarA),
    });
    let caught: unknown;
    try {
      await publishHfTarball({
        storage,
        index: storage.index,
        org: ORG,
        repo: REPO,
        repoType: "model",
        revision: "v1",
        body: bodyOf(tarB),
      });
    } catch (err) {
      caught = err;
    }
    expect((caught as HfError).code).toBe(HF_ERROR_CODES.REVISION_EXISTS);
  });

  it("idempotent: same bytes for the same revision succeeds as no-op", async () => {
    const tar = buildTar([{ path: "a.txt", bytes: Buffer.from("payload") }]);
    const first = await publishHfTarball({
      storage,
      index: storage.index,
      org: ORG,
      repo: REPO,
      repoType: "model",
      revision: "v1",
      body: bodyOf(tar),
    });
    const second = await publishHfTarball({
      storage,
      index: storage.index,
      org: ORG,
      repo: REPO,
      repoType: "model",
      revision: "v1",
      body: bodyOf(tar),
    });
    expect(first.file_count).toBe(1);
    expect(second.file_count).toBe(1);
    expect(second.idempotent).toBe(true);
  });

  it("classifies files via lfsThreshold override", async () => {
    const tar = buildTar([
      { path: "a.txt", bytes: Buffer.from("aaaaaa") },
      { path: "b.txt", bytes: Buffer.from("b".repeat(100)) },
    ]);
    await publishHfTarball({
      storage,
      index: storage.index,
      org: ORG,
      repo: REPO,
      repoType: "model",
      revision: "v1",
      body: bodyOf(tar),
      lfsThreshold: 10,
    });
    const rev = storage.index.getHfRevision(ORG, REPO, "model", "v1");
    const a = rev!.files.find((f) => f.path === "a.txt")!;
    const b = rev!.files.find((f) => f.path === "b.txt")!;
    expect(a.lfs).toBe(false);
    expect(b.lfs).toBe(true);
  });

  it("uses upstreamConfig caps + threshold when present", async () => {
    const tar = buildTar([{ path: "small.txt", bytes: Buffer.from("ok") }]);
    const result = await publishHfTarball({
      storage,
      index: storage.index,
      org: ORG,
      repo: REPO,
      repoType: "model",
      revision: "vcfg",
      body: bodyOf(tar),
      upstreamConfig: {
        hf_max_blob_bytes: 1024 * 1024,
        hf_lfs_threshold_bytes: 1,
      },
    });
    expect(result.file_count).toBe(1);
    const rev = storage.index.getHfRevision(ORG, REPO, "model", "vcfg");
    expect(rev?.files[0].lfs).toBe(true); // size > 1 byte threshold
  });

  it("rejects when the storage layer's recorded blob bytes differ from tar header size", async () => {
    // Simulate a storage that records a different size than the tar
    // header declares. We achieve this by intercepting putBlob.
    const realPutBlob = storage.putBlob.bind(storage);
    const wrappedStorage = Object.create(storage) as typeof storage;
    let calls = 0;
    wrappedStorage.putBlob = async (input) => {
      const out = await realPutBlob(input);
      calls += 1;
      if (calls === 1) {
        // Lie about the size on the first call.
        return { ...out, size: out.size + 1 };
      }
      return out;
    };
    const tar = buildTar([{ path: "a.txt", bytes: Buffer.from("hello") }]);
    let caught: unknown;
    try {
      await publishHfTarball({
        storage: wrappedStorage,
        index: storage.index,
        org: ORG,
        repo: REPO,
        repoType: "model",
        revision: "v1",
        body: bodyOf(tar),
      });
    } catch (err) {
      caught = err;
    }
    expect((caught as HfError).code).toBe(HF_ERROR_CODES.UPLOAD_INVALID);
  });
});
