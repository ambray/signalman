/**
 * v0.5 Win11 M2 — Pure-TS ISO9660 + Joliet seed ISO writer tests
 * (Story 2).
 *
 * Covers:
 *  - composeSeedIso: byte-level inspection of the PVD (sector 16),
 *    SVD (sector 17), Volume Descriptor Set Terminator (sector 18),
 *    Path Table Type-L/M at sectors 19..22, root directory records
 *    (`.` / `..` / file entries) at sectors 23 + 24, file data
 *    placement.
 *  - writeSeedIso: writes a real file on disk, contents match
 *    composeSeedIso's output, parent directory auto-created.
 *  - readSeedIsoFile: round-trip — read back exactly what we wrote.
 *  - multi-file write: deterministic across input key ordering.
 *  - label override: custom label appears in PVD volume identifier
 *    + Joliet SVD UCS-2 form.
 *  - validation: empty files map, non-Buffer values, NUL/slash in
 *    filenames, over-long filenames, ISO9660 short-name collision,
 *    invalid label.
 *  - encoding helpers: 8.3 transliteration, UCS-2 BE, ISO 17-byte
 *    date format, dir-record 7-byte date format.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  composeSeedIso,
  writeSeedIso,
  readSeedIsoFile,
  __internals,
} from "../provisioning/seed-iso.js";

const { SECTOR_SIZE } = __internals;

// ── composeSeedIso ────────────────────────────────────────────────

describe("composeSeedIso — volume descriptors", () => {
  it("emits a PVD at sector 16", () => {
    const iso = composeSeedIso({
      "Autounattend.xml": Buffer.from("<unattend/>"),
    });
    const pvdOff = 16 * SECTOR_SIZE;
    expect(iso.readUInt8(pvdOff)).toBe(1); // type = PVD
    expect(iso.subarray(pvdOff + 1, pvdOff + 6).toString("ascii")).toBe("CD001");
    expect(iso.readUInt8(pvdOff + 6)).toBe(1); // version
  });

  it("emits the default CIDATA volume label in the PVD", () => {
    const iso = composeSeedIso({ "F.TXT": Buffer.from("x") });
    const pvdOff = 16 * SECTOR_SIZE;
    const label = iso.subarray(pvdOff + 40, pvdOff + 40 + 6).toString("ascii");
    expect(label).toBe("CIDATA");
  });

  it("honours a custom volume label", () => {
    const iso = composeSeedIso({ "F.TXT": Buffer.from("x") }, { label: "demo" });
    const pvdOff = 16 * SECTOR_SIZE;
    const label = iso.subarray(pvdOff + 40, pvdOff + 40 + 4).toString("ascii");
    expect(label).toBe("DEMO"); // upcased
  });

  it("emits volume space size = total sector count", () => {
    const iso = composeSeedIso({ "F.TXT": Buffer.from("x") });
    const pvdOff = 16 * SECTOR_SIZE;
    const spaceLe = iso.readUInt32LE(pvdOff + 80);
    const spaceBe = iso.readUInt32BE(pvdOff + 84);
    expect(spaceLe).toBe(spaceBe);
    expect(spaceLe).toBeGreaterThanOrEqual(26); // 25 sectors of structure + ≥1 file sector
    expect(spaceLe * SECTOR_SIZE).toBe(iso.length);
  });

  it("emits logical block size = 2048", () => {
    const iso = composeSeedIso({ "F.TXT": Buffer.from("x") });
    const pvdOff = 16 * SECTOR_SIZE;
    expect(iso.readUInt16LE(pvdOff + 128)).toBe(SECTOR_SIZE);
    expect(iso.readUInt16BE(pvdOff + 130)).toBe(SECTOR_SIZE);
  });

  it("emits an SVD (Joliet) at sector 17 with the '%/E' escape sequence", () => {
    const iso = composeSeedIso({ "F.TXT": Buffer.from("x") });
    const svdOff = 17 * SECTOR_SIZE;
    expect(iso.readUInt8(svdOff)).toBe(2); // type = SVD
    expect(iso.subarray(svdOff + 1, svdOff + 6).toString("ascii")).toBe("CD001");
    expect(iso.subarray(svdOff + 88, svdOff + 91).toString("ascii")).toBe("%/E");
  });

  it("emits the volume label in UCS-2 BE in the SVD", () => {
    const iso = composeSeedIso({ "F.TXT": Buffer.from("x") });
    const svdOff = 17 * SECTOR_SIZE;
    // "CIDATA" in UCS-2 BE = 00 43 00 49 00 44 00 41 00 54 00 41
    const expected = Buffer.from([0, 0x43, 0, 0x49, 0, 0x44, 0, 0x41, 0, 0x54, 0, 0x41]);
    expect(iso.subarray(svdOff + 40, svdOff + 40 + expected.length).equals(expected)).toBe(
      true,
    );
  });

  it("emits a Volume Descriptor Set Terminator at sector 18", () => {
    const iso = composeSeedIso({ "F.TXT": Buffer.from("x") });
    const termOff = 18 * SECTOR_SIZE;
    expect(iso.readUInt8(termOff)).toBe(255);
    expect(iso.subarray(termOff + 1, termOff + 6).toString("ascii")).toBe("CD001");
    expect(iso.readUInt8(termOff + 6)).toBe(1);
  });

  it("zeroes the system area (sectors 0..15)", () => {
    const iso = composeSeedIso({ "F.TXT": Buffer.from("x") });
    for (let i = 0; i < 16 * SECTOR_SIZE; i++) {
      expect(iso[i]).toBe(0);
    }
  });
});

describe("composeSeedIso — path tables", () => {
  it("emits a Type-L path table for ISO9660 at sector 19", () => {
    const iso = composeSeedIso({ "F.TXT": Buffer.from("x") });
    const off = 19 * SECTOR_SIZE;
    expect(iso.readUInt8(off + 0)).toBe(1); // root identifier length
    expect(iso.readUInt8(off + 1)).toBe(0); // EAR length
    expect(iso.readUInt32LE(off + 2)).toBe(23); // ISO root sector
    expect(iso.readUInt16LE(off + 6)).toBe(1); // parent dir #
    expect(iso.readUInt8(off + 8)).toBe(0); // root identifier
  });

  it("emits a Type-M path table for ISO9660 at sector 20", () => {
    const iso = composeSeedIso({ "F.TXT": Buffer.from("x") });
    const off = 20 * SECTOR_SIZE;
    expect(iso.readUInt32BE(off + 2)).toBe(23); // BE encoding of root sector
  });

  it("emits a Type-L path table for Joliet at sector 21", () => {
    const iso = composeSeedIso({ "F.TXT": Buffer.from("x") });
    const off = 21 * SECTOR_SIZE;
    expect(iso.readUInt32LE(off + 2)).toBe(24); // Joliet root sector
  });

  it("emits a Type-M path table for Joliet at sector 22", () => {
    const iso = composeSeedIso({ "F.TXT": Buffer.from("x") });
    const off = 22 * SECTOR_SIZE;
    expect(iso.readUInt32BE(off + 2)).toBe(24);
  });
});

describe("composeSeedIso — root directory records", () => {
  it("emits . and .. records at sector 23 (ISO9660)", () => {
    const iso = composeSeedIso({ "F.TXT": Buffer.from("x") });
    const off = 23 * SECTOR_SIZE;
    // First record is "."
    const rec1Len = iso.readUInt8(off);
    expect(rec1Len).toBeGreaterThan(0);
    expect(iso.readUInt8(off + 32)).toBe(1); // name length = 1
    expect(iso.readUInt8(off + 33)).toBe(0); // "." = 0x00
    // Second record is ".."
    const off2 = off + rec1Len;
    expect(iso.readUInt8(off2 + 32)).toBe(1);
    expect(iso.readUInt8(off2 + 33)).toBe(1); // ".." = 0x01
  });

  it("emits the file's directory entry at sector 23", () => {
    const iso = composeSeedIso({ "F.TXT": Buffer.from("hello") });
    const off = 23 * SECTOR_SIZE;
    // Walk past . and .. records.
    const len1 = iso.readUInt8(off);
    const len2 = iso.readUInt8(off + len1);
    const fileRecOff = off + len1 + len2;
    const fileRecLen = iso.readUInt8(fileRecOff);
    expect(fileRecLen).toBeGreaterThan(0);
    const fileLba = iso.readUInt32LE(fileRecOff + 2);
    const fileSize = iso.readUInt32LE(fileRecOff + 10);
    const nameLen = iso.readUInt8(fileRecOff + 32);
    const name = iso.toString(
      "ascii",
      fileRecOff + 33,
      fileRecOff + 33 + nameLen,
    );
    expect(name).toBe("F.TXT;1");
    expect(fileSize).toBe(5);
    // Data is at fileLba * sector size.
    expect(iso.subarray(fileLba * SECTOR_SIZE, fileLba * SECTOR_SIZE + 5).toString("utf8")).toBe(
      "hello",
    );
  });

  it("emits the file's directory entry at sector 24 (Joliet, UCS-2 BE)", () => {
    const iso = composeSeedIso({ "Autounattend.xml": Buffer.from("<x/>") });
    const off = 24 * SECTOR_SIZE;
    const len1 = iso.readUInt8(off);
    const len2 = iso.readUInt8(off + len1);
    const fileRecOff = off + len1 + len2;
    const nameLen = iso.readUInt8(fileRecOff + 32);
    expect(nameLen).toBe(16 * 2); // "Autounattend.xml" = 16 chars * 2 bytes
    // First two bytes of the name should be 0x00 0x41 ('A' in UCS-2 BE)
    expect(iso.readUInt8(fileRecOff + 33)).toBe(0);
    expect(iso.readUInt8(fileRecOff + 34)).toBe(0x41); // 'A'
  });
});

describe("writeSeedIso (filesystem)", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "seed-iso-test-"));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes a real file with the same bytes as composeSeedIso", async () => {
    const out = path.join(tmpDir, "seed.iso");
    const files = { "Autounattend.xml": Buffer.from("<unattend/>") };
    await writeSeedIso(out, files);
    const expected = composeSeedIso(files);
    const actual = fs.readFileSync(out);
    expect(actual.equals(expected)).toBe(true);
  });

  it("creates parent directory automatically", async () => {
    const out = path.join(tmpDir, "nested", "deep", "seed.iso");
    await writeSeedIso(out, { "F.TXT": Buffer.from("x") });
    expect(fs.existsSync(out)).toBe(true);
  });
});

describe("readSeedIsoFile (round-trip)", () => {
  it("reads back exactly what we wrote", () => {
    const payload = Buffer.from("<?xml version='1.0'?><unattend/>");
    const iso = composeSeedIso({ "Autounattend.xml": payload });
    const round = readSeedIsoFile(iso, "Autounattend.xml");
    expect(round).not.toBeNull();
    expect(round!.equals(payload)).toBe(true);
  });

  it("returns null for an unknown filename", () => {
    const iso = composeSeedIso({ "Autounattend.xml": Buffer.from("x") });
    expect(readSeedIsoFile(iso, "missing.txt")).toBeNull();
  });

  it("returns null on a non-ISO buffer", () => {
    const buf = Buffer.alloc(20 * SECTOR_SIZE); // no PVD
    expect(readSeedIsoFile(buf, "x")).toBeNull();
  });

  it("returns null when directory walk runs off the end", () => {
    // Compose a valid ISO and then zero BOTH the Joliet (24) and
    // ISO9660 (23) root directories so neither lookup succeeds.
    const iso = Buffer.from(composeSeedIso({ "F.TXT": Buffer.from("x") }));
    iso.fill(0, 23 * SECTOR_SIZE, 25 * SECTOR_SIZE);
    expect(readSeedIsoFile(iso, "F.TXT")).toBeNull();
  });

  it("falls back to ISO9660 8.3 lookup when Joliet is corrupt", () => {
    // Trash the Joliet root only; ISO9660 sector 23 still has the file.
    const iso = Buffer.from(composeSeedIso({ "F.TXT": Buffer.from("hi") }));
    iso.fill(0, 24 * SECTOR_SIZE, 25 * SECTOR_SIZE);
    const found = readSeedIsoFile(iso, "F.TXT");
    expect(found).not.toBeNull();
    expect(found!.toString()).toBe("hi");
  });
});

describe("composeSeedIso — determinism", () => {
  it("same input -> same bytes", () => {
    const files = {
      "Autounattend.xml": Buffer.from("<x/>"),
      "Meta-data": Buffer.from("instance-id: i\n"),
    };
    const a = composeSeedIso(files);
    const b = composeSeedIso(files);
    expect(a.equals(b)).toBe(true);
  });

  it("input key order does NOT affect output bytes", () => {
    const f1 = { a: Buffer.from("a"), b: Buffer.from("b") };
    const f2 = { b: Buffer.from("b"), a: Buffer.from("a") };
    const a = composeSeedIso(f1);
    const b = composeSeedIso(f2);
    expect(a.equals(b)).toBe(true);
  });

  it("output bytes change when input contents change", () => {
    const a = composeSeedIso({ "F.TXT": Buffer.from("alpha") });
    const b = composeSeedIso({ "F.TXT": Buffer.from("beta") });
    expect(a.equals(b)).toBe(false);
  });

  it("a non-null modificationDate produces stable non-zero PVD timestamps", () => {
    const d = new Date(Date.UTC(2026, 4, 17, 12, 34, 56));
    const iso = composeSeedIso({ "F.TXT": Buffer.from("x") }, { modificationDate: d });
    const pvdOff = 16 * SECTOR_SIZE;
    const created = iso.subarray(pvdOff + 813, pvdOff + 813 + 16).toString("ascii");
    expect(created).toBe("2026051712345600");
  });
});

describe("composeSeedIso — multi-file", () => {
  it("places each file at a distinct sector", () => {
    const files = {
      "ALPHA.TXT": Buffer.from("a".repeat(100)),
      "BETA.TXT": Buffer.from("b".repeat(3000)), // 2 sectors
      "GAMMA.TXT": Buffer.from("g".repeat(50)),
    };
    const iso = composeSeedIso(files);
    expect(readSeedIsoFile(iso, "ALPHA.TXT")!.toString()).toBe("a".repeat(100));
    expect(readSeedIsoFile(iso, "BETA.TXT")!.toString()).toBe("b".repeat(3000));
    expect(readSeedIsoFile(iso, "GAMMA.TXT")!.toString()).toBe("g".repeat(50));
  });

  it("handles a file at exactly one full sector (no pad)", () => {
    const data = Buffer.alloc(SECTOR_SIZE, 0x55);
    const iso = composeSeedIso({ "FULL.BIN": data });
    expect(readSeedIsoFile(iso, "FULL.BIN")!.equals(data)).toBe(true);
  });

  it("handles a tiny one-byte file (padded to one sector)", () => {
    const iso = composeSeedIso({ "T.BIN": Buffer.from([42]) });
    const data = readSeedIsoFile(iso, "T.BIN");
    expect(data!.length).toBe(1);
    expect(data![0]).toBe(42);
  });
});

describe("composeSeedIso — validation", () => {
  it("rejects empty file map", () => {
    expect(() => composeSeedIso({})).toThrow(/at least one file/);
  });

  it("rejects too many files", () => {
    const files: Record<string, Buffer> = {};
    for (let i = 0; i < 2000; i++) files[`F${i}.TXT`] = Buffer.from("x");
    expect(() => composeSeedIso(files)).toThrow(/too many files/);
  });

  it("rejects non-Buffer values", () => {
    expect(() =>
      composeSeedIso({
        "F.TXT": "not a buffer" as unknown as Buffer,
      }),
    ).toThrow(TypeError);
  });

  it("rejects null files arg", () => {
    expect(() => composeSeedIso(null as unknown as Record<string, Buffer>)).toThrow(
      TypeError,
    );
  });

  it("rejects empty filename", () => {
    expect(() =>
      composeSeedIso({ "": Buffer.from("x") }),
    ).toThrow(/non-empty string/);
  });

  it("rejects filename containing slash, backslash, or NUL", () => {
    expect(() =>
      composeSeedIso({ "foo/bar": Buffer.from("x") }),
    ).toThrow(/path separator/);
    expect(() =>
      composeSeedIso({ "foo\\bar": Buffer.from("x") }),
    ).toThrow(/path separator/);
    expect(() =>
      composeSeedIso({ "foo\0bar": Buffer.from("x") }),
    ).toThrow(/path separator/);
  });

  it("rejects filenames over 64 chars", () => {
    expect(() =>
      composeSeedIso({ ["x".repeat(65)]: Buffer.from("x") }),
    ).toThrow(/exceeds 64 characters/);
  });

  it("rejects label outside [A-Z0-9_]", () => {
    expect(() =>
      composeSeedIso({ "F.TXT": Buffer.from("x") }, { label: "with space" }),
    ).toThrow(/invalid label/);
    expect(() =>
      composeSeedIso({ "F.TXT": Buffer.from("x") }, { label: "" }),
    ).toThrow(/invalid label/);
  });

  it("rejects ISO9660 short-name collisions", () => {
    expect(() =>
      composeSeedIso({
        "long-name-1.xml": Buffer.from("a"),
        "long-name-2.xml": Buffer.from("b"),
      }),
    ).toThrow(/collision/);
  });
});

// ── Internal helpers ──────────────────────────────────────────────

describe("__internals.toIsoShortName", () => {
  it("uppercases and pads to NAME.EXT;1", () => {
    expect(__internals.toIsoShortName("Autounattend.xml")).toBe("AUTOUNAT.XML;1");
  });

  it("replaces non-allowed chars with _", () => {
    expect(__internals.toIsoShortName("hello-world.txt")).toBe("HELLO_WO.TXT;1");
  });

  it("truncates base + ext to 8 and 3 chars", () => {
    expect(__internals.toIsoShortName("aaaabbbbcccc.dddeee")).toBe("AAAABBBB.DDD;1");
  });

  it("handles names with no extension", () => {
    expect(__internals.toIsoShortName("README")).toBe("README;1");
  });

  it("handles names with a leading dot", () => {
    // Leading dot -> empty base; transliterator substitutes FILE.
    expect(__internals.toIsoShortName(".hidden")).toBe("FILE.HID;1");
  });
});

describe("__internals.ucs2Be", () => {
  it("encodes ASCII chars as 16-bit big-endian", () => {
    const b = __internals.ucs2Be("AB");
    expect(b.length).toBe(4);
    expect(b[0]).toBe(0);
    expect(b[1]).toBe(0x41);
    expect(b[2]).toBe(0);
    expect(b[3]).toBe(0x42);
  });

  it("encodes empty string as empty buffer", () => {
    expect(__internals.ucs2Be("").length).toBe(0);
  });
});

describe("__internals.writeIsoDateTime17 / writeDirDateTime7", () => {
  it("writes all-zero on null date (17-byte form is ASCII '0' chars)", () => {
    const buf = Buffer.alloc(20);
    __internals.writeIsoDateTime17(buf, 0, null);
    expect(buf.subarray(0, 16).toString("ascii")).toBe("0000000000000000");
    expect(buf.readUInt8(16)).toBe(0);
  });

  it("writes the UTC components in the expected positions (17-byte form)", () => {
    const buf = Buffer.alloc(17);
    const d = new Date(Date.UTC(2026, 4, 17, 12, 34, 56));
    __internals.writeIsoDateTime17(buf, 0, d);
    expect(buf.subarray(0, 16).toString("ascii")).toBe("2026051712345600");
    expect(buf.readUInt8(16)).toBe(0);
  });

  it("writes all-zero on null date (7-byte form)", () => {
    const buf = Buffer.alloc(7);
    __internals.writeDirDateTime7(buf, 0, null);
    for (let i = 0; i < 7; i++) expect(buf[i]).toBe(0);
  });

  it("writes year-1900 and 1-based month in the 7-byte form", () => {
    const buf = Buffer.alloc(7);
    const d = new Date(Date.UTC(2026, 4, 17, 12, 34, 56));
    __internals.writeDirDateTime7(buf, 0, d);
    expect(buf[0]).toBe(2026 - 1900); // year offset
    expect(buf[1]).toBe(5); // May (1-based)
    expect(buf[2]).toBe(17);
    expect(buf[3]).toBe(12);
    expect(buf[4]).toBe(34);
    expect(buf[5]).toBe(56);
    expect(buf.readInt8(6)).toBe(0); // GMT offset
  });
});
