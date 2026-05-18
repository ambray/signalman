/**
 * v0.5 Win11 M2 — Pure-TypeScript ISO9660 + Joliet seed-ISO writer.
 *
 * Writes a small read-only ISO9660 volume containing one or more
 * named files at the root. Used by the bootstrap-win11 pipeline to
 * synthesise a CIDATA seed ISO carrying `Autounattend.xml` for the
 * Windows Setup first-boot unattended pass.
 *
 * Why pure-TS (no shell-out to mkisofs/genisoimage/oscdimg):
 *   - The host CLI runs on macOS / Linux / Windows; mkisofs is not
 *     reliably installed on any of those.
 *   - The Windows ADK's oscdimg is a 5MB install with admin-rights
 *     friction. We don't want that on the bootstrap critical path.
 *   - The ISO9660 spec is small and well-documented; ~600 lines
 *     of TS covers it for the "small read-only volume with a
 *     handful of files" shape we need.
 *
 * Format choices:
 *   - ISO9660 Level 1 (8.3 short names, ASCII uppercase) — the
 *     fallback for legacy readers.
 *   - Joliet extension (UTF-16BE long filenames, mixed case) —
 *     Windows reads this; the `Autounattend.xml` filename has
 *     mixed case so Joliet is mandatory.
 *   - One File Section per file (small files, no extent chaining).
 *   - Single Path Table copy at PVD start (we don't write the
 *     little-endian / big-endian / supplementary path tables
 *     separately; we write both required path table copies
 *     pointing to the same data — readers tolerate this).
 *
 * Layout (one 2048-byte sector per row except File Data):
 *   sector 0..15   System Area (zeroed)
 *   sector 16      Primary Volume Descriptor (ISO9660 PVD)
 *   sector 17      Supplementary Volume Descriptor (Joliet SVD)
 *   sector 18      Volume Descriptor Set Terminator
 *   sector 19      Type-L Path Table (ISO9660)
 *   sector 20      Type-M Path Table (ISO9660, big-endian)
 *   sector 21      Type-L Path Table (Joliet)
 *   sector 22      Type-M Path Table (Joliet)
 *   sector 23      ISO9660 root directory record
 *   sector 24      Joliet root directory record
 *   sector 25..    File data (each file padded to 2048-byte sector)
 *
 * Determinism: every byte is a function of the input. We don't
 * embed timestamps from `Date.now()` — instead we use a fixed
 * "Modification Date" (`opts.modificationDate` or the zero
 * timestamp `0000-00-00 00:00:00`) so the byte output round-trips
 * across runs.
 */

import * as fs from "node:fs";
import * as path from "node:path";

// ── Public API ────────────────────────────────────────────────────

export interface WriteSeedIsoOptions {
  /** Volume label. Defaults to "CIDATA". 1..32 ASCII uppercase. */
  label?: string;
  /**
   * Modification date. Used for the ISO9660 file & directory
   * records. Defaults to the zero date (`0000-00-00 00:00:00`)
   * so output is deterministic.
   */
  modificationDate?: Date;
}

/**
 * Write an ISO9660 + Joliet volume to `outPath` containing the
 * given files at the root.
 *
 * `files` maps filename -> contents. Filenames must be 1..255
 * UTF-16-safe characters; the writer rejects pathological inputs
 * (empty key, slash, NUL).
 *
 * The volume label defaults to `CIDATA` (matches the cloud-init
 * convention Windows sysprep looks for on removable media).
 */
export async function writeSeedIso(
  outPath: string,
  files: Record<string, Buffer>,
  opts?: WriteSeedIsoOptions,
): Promise<void> {
  const bytes = composeSeedIso(files, opts);
  await fs.promises.mkdir(path.dirname(outPath), { recursive: true });
  await fs.promises.writeFile(outPath, bytes);
}

/**
 * Compose an ISO9660 + Joliet image in-memory. Exposed separately
 * from {@link writeSeedIso} so tests can byte-inspect without
 * touching the disk.
 */
export function composeSeedIso(
  files: Record<string, Buffer>,
  opts?: WriteSeedIsoOptions,
): Buffer {
  const label = (opts?.label ?? "CIDATA").toUpperCase();
  if (!/^[A-Z0-9_]{1,32}$/.test(label)) {
    throw new Error(
      `writeSeedIso: invalid label '${opts?.label}'. ` +
        `Must be 1..32 chars matching [A-Z0-9_].`,
    );
  }

  const fileList = validateFiles(files);
  const modDate = opts?.modificationDate ?? null;

  // ── Sector layout planning ──
  const SECTOR_SIZE = 2048;
  // System Area (16 sectors).
  // 16: PVD
  // 17: SVD (Joliet)
  // 18: Terminator
  // 19: Path Table L (ISO9660)
  // 20: Path Table M (ISO9660)
  // 21: Path Table L (Joliet)
  // 22: Path Table M (Joliet)
  // 23: Root directory (ISO9660)
  // 24: Root directory (Joliet)
  const isoRootSector = 23;
  const jolietRootSector = 24;
  const firstFileSector = 25;

  // Each file occupies ceil(size/2048) sectors.
  const fileExtents: Array<{
    name: string;
    isoName: string;
    data: Buffer;
    lba: number;
    size: number;
  }> = [];
  let nextLba = firstFileSector;
  for (const f of fileList) {
    fileExtents.push({
      name: f.name,
      isoName: f.isoName,
      data: f.data,
      lba: nextLba,
      size: f.data.length,
    });
    nextLba += Math.ceil(f.data.length / SECTOR_SIZE) || 1;
  }
  const volumeSectors = nextLba;

  // ── Allocate the output buffer ──
  const out = Buffer.alloc(volumeSectors * SECTOR_SIZE);
  // System area (0..15) is zero — Buffer.alloc gives us that.

  // ── PVD (sector 16) ──
  writePvd(out, 16, {
    label,
    volumeSectors,
    pathTableSize: pathTableSize(label, /*joliet*/ false),
    pathTableLLba: 19,
    pathTableMLba: 20,
    rootDirRecord: rootDirRecord({
      lba: isoRootSector,
      size: SECTOR_SIZE,
      modDate,
    }),
    modDate,
  });

  // ── SVD / Joliet (sector 17) ──
  writeSvd(out, 17, {
    label,
    volumeSectors,
    pathTableSize: pathTableSize(label, /*joliet*/ true),
    pathTableLLba: 21,
    pathTableMLba: 22,
    rootDirRecord: rootDirRecord({
      lba: jolietRootSector,
      size: SECTOR_SIZE,
      modDate,
    }),
    modDate,
  });

  // ── Volume Descriptor Set Terminator (sector 18) ──
  writeTerminator(out, 18);

  // ── Path Tables (sectors 19..22) ──
  // ISO9660 root-only path table — one record pointing at sector 23.
  writePathTableIso(out, 19, /*be*/ false, isoRootSector);
  writePathTableIso(out, 20, /*be*/ true, isoRootSector);
  // Joliet root-only path table — one record pointing at sector 24.
  writePathTableJoliet(out, 21, /*be*/ false, jolietRootSector);
  writePathTableJoliet(out, 22, /*be*/ true, jolietRootSector);

  // ── ISO9660 root directory (sector 23) ──
  writeRootDirIso(out, isoRootSector, fileExtents, modDate);
  // ── Joliet root directory (sector 24) ──
  writeRootDirJoliet(out, jolietRootSector, fileExtents, modDate);

  // ── File data (sector 25..) ──
  for (const fe of fileExtents) {
    fe.data.copy(out, fe.lba * SECTOR_SIZE, 0, fe.size);
  }

  return out;
}

// ── Internal helpers ──────────────────────────────────────────────

const SECTOR_SIZE = 2048;

interface FileEntry {
  /** Original (mixed-case, may exceed 8.3) filename for Joliet. */
  name: string;
  /** ISO9660 Level-1 8.3 uppercase filename. */
  isoName: string;
  /** File contents. */
  data: Buffer;
}

function validateFiles(files: Record<string, Buffer>): FileEntry[] {
  if (typeof files !== "object" || files === null) {
    throw new TypeError("composeSeedIso: files must be a Record<string, Buffer>");
  }
  const names = Object.keys(files);
  if (names.length === 0) {
    throw new Error("composeSeedIso: at least one file is required");
  }
  if (names.length > 1024) {
    throw new Error(
      `composeSeedIso: too many files (${names.length}); seed ISO ` +
        `caps at 1024 files (the realistic ceiling for cloud-init-style payloads)`,
    );
  }
  const out: FileEntry[] = [];
  const seenIsoNames = new Set<string>();
  for (const name of names) {
    if (typeof name !== "string" || name.length === 0) {
      throw new Error("composeSeedIso: filename must be a non-empty string");
    }
    if (name.includes("/") || name.includes("\\") || name.includes("\0")) {
      throw new Error(
        `composeSeedIso: filename '${name}' contains a path separator or NUL`,
      );
    }
    if (name.length > 64) {
      throw new Error(
        `composeSeedIso: filename '${name}' exceeds 64 characters ` +
          `(Joliet allows 64 UCS-2 chars per directory record)`,
      );
    }
    const data = files[name];
    if (!Buffer.isBuffer(data)) {
      throw new TypeError(
        `composeSeedIso: file '${name}' must be a Buffer (got ${typeof data})`,
      );
    }
    const isoName = toIsoShortName(name);
    if (seenIsoNames.has(isoName)) {
      throw new Error(
        `composeSeedIso: ISO9660 short-name collision: multiple files ` +
          `map to '${isoName}' (input names included '${name}')`,
      );
    }
    seenIsoNames.add(isoName);
    out.push({ name, isoName, data });
  }
  // Sort so output is deterministic across object key orderings.
  out.sort((a, b) => (a.isoName < b.isoName ? -1 : a.isoName > b.isoName ? 1 : 0));
  return out;
}

/**
 * Map a long filename to an ISO9660 Level-1 8.3 uppercase short
 * name. Format: NAME.EXT;1 (the ;1 is the file version).
 */
function toIsoShortName(name: string): string {
  const lastDot = name.lastIndexOf(".");
  let base = lastDot >= 0 ? name.slice(0, lastDot) : name;
  let ext = lastDot >= 0 ? name.slice(lastDot + 1) : "";
  base = base
    .toUpperCase()
    .replace(/[^A-Z0-9_]/g, "_")
    .slice(0, 8);
  ext = ext
    .toUpperCase()
    .replace(/[^A-Z0-9_]/g, "_")
    .slice(0, 3);
  if (base.length === 0) base = "FILE";
  return ext.length > 0 ? `${base}.${ext};1` : `${base};1`;
}

// ── Volume Descriptors ────────────────────────────────────────────

interface VdInputs {
  label: string;
  volumeSectors: number;
  pathTableSize: number;
  pathTableLLba: number;
  pathTableMLba: number;
  rootDirRecord: Buffer;
  modDate: Date | null;
}

function writePvd(out: Buffer, sector: number, v: VdInputs): void {
  const off = sector * SECTOR_SIZE;
  // Type code (1 = PVD)
  out.writeUInt8(1, off + 0);
  out.write("CD001", off + 1, 5, "ascii");
  // Version
  out.writeUInt8(1, off + 6);
  // Unused 1 (off+7)
  // System Identifier (32 bytes ASCII, space-padded)
  writeFixedAscii(out, off + 8, 32, "");
  // Volume Identifier (32 bytes ASCII)
  writeFixedAscii(out, off + 40, 32, v.label);
  // Unused (8 bytes off+72)
  // Volume Space Size (BE+LE 32-bit)
  writeBoth32(out, off + 80, v.volumeSectors);
  // Unused (32 bytes off+88)
  // Volume Set Size (BE+LE 16-bit) = 1
  writeBoth16(out, off + 120, 1);
  // Volume Sequence Number (BE+LE 16-bit) = 1
  writeBoth16(out, off + 124, 1);
  // Logical Block Size = 2048 (BE+LE 16-bit)
  writeBoth16(out, off + 128, SECTOR_SIZE);
  // Path Table Size (BE+LE 32-bit)
  writeBoth32(out, off + 132, v.pathTableSize);
  // Location of Type-L Path Table (LE 32)
  out.writeUInt32LE(v.pathTableLLba, off + 140);
  // Location of optional Type-L Path Table (LE 32) = 0
  out.writeUInt32LE(0, off + 144);
  // Location of Type-M Path Table (BE 32)
  out.writeUInt32BE(v.pathTableMLba, off + 148);
  // Location of optional Type-M Path Table (BE 32) = 0
  out.writeUInt32BE(0, off + 152);
  // Directory Entry for the Root Directory (34 bytes)
  v.rootDirRecord.copy(out, off + 156, 0, 34);
  // Volume Set Identifier (128 bytes ASCII)
  writeFixedAscii(out, off + 190, 128, "");
  // Publisher Identifier (128 bytes)
  writeFixedAscii(out, off + 318, 128, "");
  // Data Preparer (128 bytes)
  writeFixedAscii(out, off + 446, 128, "signalman seed-iso writer");
  // Application Identifier (128 bytes)
  writeFixedAscii(out, off + 574, 128, "signalman bootstrap-win11");
  // Copyright File Identifier (37 bytes)
  writeFixedAscii(out, off + 702, 37, "");
  // Abstract File Identifier (37 bytes)
  writeFixedAscii(out, off + 739, 37, "");
  // Bibliographic File Identifier (37 bytes)
  writeFixedAscii(out, off + 776, 37, "");
  // Volume Creation Date (17 bytes)
  writeIsoDateTime17(out, off + 813, v.modDate);
  // Volume Modification Date (17 bytes)
  writeIsoDateTime17(out, off + 830, v.modDate);
  // Volume Expiration Date (17 bytes)
  writeIsoDateTime17(out, off + 847, null);
  // Volume Effective Date (17 bytes)
  writeIsoDateTime17(out, off + 864, null);
  // File Structure Version
  out.writeUInt8(1, off + 881);
  // Reserved (off+882) = 0
  // Application Use (512 bytes off+883) = 0
  // Reserved (653 bytes off+1395..) = 0
}

function writeSvd(out: Buffer, sector: number, v: VdInputs): void {
  const off = sector * SECTOR_SIZE;
  // Type code (2 = SVD)
  out.writeUInt8(2, off + 0);
  out.write("CD001", off + 1, 5, "ascii");
  // Version
  out.writeUInt8(1, off + 6);
  // Volume Flags = 0 (all chars in escape sequences are registered)
  out.writeUInt8(0, off + 7);
  // System Identifier (32 bytes UCS-2 BE)
  writeFixedUcs2Be(out, off + 8, 32, "");
  // Volume Identifier (32 bytes UCS-2 BE)
  writeFixedUcs2Be(out, off + 40, 32, v.label);
  // Unused (8 bytes off+72)
  // Volume Space Size (BE+LE 32-bit)
  writeBoth32(out, off + 80, v.volumeSectors);
  // Escape Sequences (32 bytes) — UCS-2 Level 3 = "%/E"
  out.write("%/E", off + 88, 3, "ascii");
  // Volume Set Size
  writeBoth16(out, off + 120, 1);
  // Volume Sequence Number
  writeBoth16(out, off + 124, 1);
  // Logical Block Size
  writeBoth16(out, off + 128, SECTOR_SIZE);
  // Path Table Size
  writeBoth32(out, off + 132, v.pathTableSize);
  // Location of Type-L Path Table (LE 32)
  out.writeUInt32LE(v.pathTableLLba, off + 140);
  // Location of optional Type-L Path Table (LE 32) = 0
  out.writeUInt32LE(0, off + 144);
  // Location of Type-M Path Table (BE 32)
  out.writeUInt32BE(v.pathTableMLba, off + 148);
  // Location of optional Type-M Path Table (BE 32) = 0
  out.writeUInt32BE(0, off + 152);
  // Root directory record
  v.rootDirRecord.copy(out, off + 156, 0, 34);
  // Volume Set Identifier (128 bytes UCS-2)
  writeFixedUcs2Be(out, off + 190, 128, "");
  // Publisher Identifier
  writeFixedUcs2Be(out, off + 318, 128, "");
  // Data Preparer
  writeFixedUcs2Be(out, off + 446, 128, "signalman seed-iso writer");
  // Application Identifier
  writeFixedUcs2Be(out, off + 574, 128, "signalman bootstrap-win11");
  // Copyright/Abstract/Bibliographic File Identifiers (37 bytes UCS-2)
  writeFixedUcs2Be(out, off + 702, 37, "");
  writeFixedUcs2Be(out, off + 739, 37, "");
  writeFixedUcs2Be(out, off + 776, 37, "");
  // Volume Creation / Modification / Expiration / Effective Date (17 bytes ASCII)
  writeIsoDateTime17(out, off + 813, v.modDate);
  writeIsoDateTime17(out, off + 830, v.modDate);
  writeIsoDateTime17(out, off + 847, null);
  writeIsoDateTime17(out, off + 864, null);
  // File Structure Version
  out.writeUInt8(1, off + 881);
}

function writeTerminator(out: Buffer, sector: number): void {
  const off = sector * SECTOR_SIZE;
  // Type code (255 = terminator)
  out.writeUInt8(255, off + 0);
  out.write("CD001", off + 1, 5, "ascii");
  out.writeUInt8(1, off + 6);
}

// ── Directory records ─────────────────────────────────────────────

/**
 * Build a single ISO9660 root directory record (34 bytes). This is
 * embedded in the PVD/SVD (the "Directory Entry for the Root
 * Directory" field), pointing at the sector that holds the
 * actual root-directory content.
 */
function rootDirRecord(args: {
  lba: number;
  size: number;
  modDate: Date | null;
}): Buffer {
  return makeDirRecord({
    name: Buffer.from([0]), // root identifier = single 0 byte
    lba: args.lba,
    size: args.size,
    flags: 0x02, // directory
    modDate: args.modDate,
  });
}

function writeRootDirIso(
  out: Buffer,
  sector: number,
  files: Array<{ name: string; isoName: string; data: Buffer; lba: number; size: number }>,
  modDate: Date | null,
): void {
  const off = sector * SECTOR_SIZE;
  let cursor = 0;
  // "." entry (self)
  cursor += writeDirRecordTo(out, off + cursor, {
    name: Buffer.from([0]),
    lba: sector,
    size: SECTOR_SIZE,
    flags: 0x02,
    modDate,
  });
  // ".." entry (parent — same as root for root)
  cursor += writeDirRecordTo(out, off + cursor, {
    name: Buffer.from([1]),
    lba: sector,
    size: SECTOR_SIZE,
    flags: 0x02,
    modDate,
  });
  for (const f of files) {
    cursor += writeDirRecordTo(out, off + cursor, {
      name: Buffer.from(f.isoName, "ascii"),
      lba: f.lba,
      size: f.size,
      flags: 0x00,
      modDate,
    });
  }
}

function writeRootDirJoliet(
  out: Buffer,
  sector: number,
  files: Array<{ name: string; isoName: string; data: Buffer; lba: number; size: number }>,
  modDate: Date | null,
): void {
  const off = sector * SECTOR_SIZE;
  let cursor = 0;
  cursor += writeDirRecordTo(out, off + cursor, {
    name: Buffer.from([0]),
    lba: sector,
    size: SECTOR_SIZE,
    flags: 0x02,
    modDate,
  });
  cursor += writeDirRecordTo(out, off + cursor, {
    name: Buffer.from([1]),
    lba: sector,
    size: SECTOR_SIZE,
    flags: 0x02,
    modDate,
  });
  for (const f of files) {
    cursor += writeDirRecordTo(out, off + cursor, {
      name: ucs2Be(f.name),
      lba: f.lba,
      size: f.size,
      flags: 0x00,
      modDate,
    });
  }
}

interface DirRecordArgs {
  name: Buffer;
  lba: number;
  size: number;
  flags: number;
  modDate: Date | null;
}

function writeDirRecordTo(out: Buffer, offset: number, args: DirRecordArgs): number {
  const rec = makeDirRecord(args);
  rec.copy(out, offset);
  return rec.length;
}

function makeDirRecord(args: DirRecordArgs): Buffer {
  const nameLen = args.name.length;
  let recLen = 33 + nameLen;
  // Pad to even total length.
  if (recLen % 2 === 1) recLen += 1;
  const buf = Buffer.alloc(recLen);
  buf.writeUInt8(recLen, 0);
  buf.writeUInt8(0, 1); // Extended Attribute Record length
  buf.writeUInt32LE(args.lba, 2);
  buf.writeUInt32BE(args.lba, 6);
  buf.writeUInt32LE(args.size, 10);
  buf.writeUInt32BE(args.size, 14);
  writeDirDateTime7(buf, 18, args.modDate);
  buf.writeUInt8(args.flags, 25);
  buf.writeUInt8(0, 26); // File Unit Size (interleave)
  buf.writeUInt8(0, 27); // Interleave Gap Size
  buf.writeUInt16LE(1, 28);
  buf.writeUInt16BE(1, 30); // Volume Sequence Number
  buf.writeUInt8(nameLen, 32);
  args.name.copy(buf, 33);
  // Tail padding is zero (Buffer.alloc).
  return buf;
}

// ── Path Tables ───────────────────────────────────────────────────

/**
 * Compute path-table size for a single-directory volume.
 *
 * Path-table record:
 *   1 byte   Directory Identifier Length (= 1 for root)
 *   1 byte   Extended Attribute Record Length
 *   4 bytes  Location of Extent
 *   2 bytes  Parent Directory Number
 *   1 byte   Identifier (0x00 = root)
 *   (no padding because total = 9 is odd, padded by 1 = 10)
 *
 * Joliet uses UCS-2 (2 bytes per char) but root is still the single
 * 0x00 byte (1 char), so identifier-length = 1 in both encodings.
 */
function pathTableSize(_label: string, _joliet: boolean): number {
  // 8 fixed + 1 byte identifier + 1 byte pad = 10 bytes for root entry.
  return 10;
}

function writePathTableIso(
  out: Buffer,
  sector: number,
  be: boolean,
  rootLba: number,
): void {
  const off = sector * SECTOR_SIZE;
  out.writeUInt8(1, off + 0); // identifier length
  out.writeUInt8(0, off + 1); // EAR length
  if (be) out.writeUInt32BE(rootLba, off + 2);
  else out.writeUInt32LE(rootLba, off + 2);
  if (be) out.writeUInt16BE(1, off + 6);
  else out.writeUInt16LE(1, off + 6); // parent dir #
  out.writeUInt8(0, off + 8); // root identifier
  out.writeUInt8(0, off + 9); // padding
}

function writePathTableJoliet(
  out: Buffer,
  sector: number,
  be: boolean,
  rootLba: number,
): void {
  // Same shape as ISO9660 path table; root identifier is a single
  // 0x00 byte regardless of encoding.
  writePathTableIso(out, sector, be, rootLba);
}

// ── Encoding helpers ──────────────────────────────────────────────

function writeFixedAscii(
  out: Buffer,
  offset: number,
  width: number,
  s: string,
): void {
  // Space-pad ASCII strings; truncate over-long inputs.
  const buf = Buffer.alloc(width, 0x20);
  buf.write(s, 0, Math.min(width, s.length), "ascii");
  buf.copy(out, offset);
}

function writeFixedUcs2Be(
  out: Buffer,
  offset: number,
  width: number,
  s: string,
): void {
  // Space-pad UCS-2 BE strings (each space = 0x0020). The width may
  // be odd (the PVD's 37-byte Copyright/Abstract/Bibliographic
  // fields fall in that bucket); we pad as many full 16-bit chars
  // as fit, then zero the trailing byte.
  const buf = Buffer.alloc(width);
  const pairs = Math.floor(width / 2);
  for (let i = 0; i < pairs; i++) {
    buf.writeUInt16BE(0x0020, i * 2);
  }
  const enc = ucs2Be(s);
  enc.copy(buf, 0, 0, Math.min(width, enc.length));
  buf.copy(out, offset);
}

function ucs2Be(s: string): Buffer {
  const buf = Buffer.alloc(s.length * 2);
  for (let i = 0; i < s.length; i++) {
    buf.writeUInt16BE(s.charCodeAt(i), i * 2);
  }
  return buf;
}

function writeBoth16(out: Buffer, offset: number, value: number): void {
  out.writeUInt16LE(value, offset);
  out.writeUInt16BE(value, offset + 2);
}

function writeBoth32(out: Buffer, offset: number, value: number): void {
  out.writeUInt32LE(value, offset);
  out.writeUInt32BE(value, offset + 4);
}

/**
 * Write the 17-byte "date and time" format used in volume
 * descriptors: YYYYMMDDHHMMSScc + 1 byte timezone offset (in 15-min
 * quarter hours from -48 to +52). null -> all-zero (means "not
 * specified" per the spec).
 */
function writeIsoDateTime17(out: Buffer, offset: number, d: Date | null): void {
  if (d === null) {
    // All zeros (16 ASCII '0' chars + 1 byte zero).
    out.fill("0".charCodeAt(0), offset, offset + 16);
    out.writeUInt8(0, offset + 16);
    return;
  }
  const year = d.getUTCFullYear().toString().padStart(4, "0");
  const month = (d.getUTCMonth() + 1).toString().padStart(2, "0");
  const day = d.getUTCDate().toString().padStart(2, "0");
  const hour = d.getUTCHours().toString().padStart(2, "0");
  const min = d.getUTCMinutes().toString().padStart(2, "0");
  const sec = d.getUTCSeconds().toString().padStart(2, "0");
  out.write(`${year}${month}${day}${hour}${min}${sec}00`, offset, 16, "ascii");
  out.writeUInt8(0, offset + 16); // GMT offset = 0
}

/**
 * Write the 7-byte "directory record date" format: year-1900, month,
 * day, hour, minute, second, GMT-offset (15-min quarter hours).
 */
function writeDirDateTime7(out: Buffer, offset: number, d: Date | null): void {
  if (d === null) {
    out.fill(0, offset, offset + 7);
    return;
  }
  out.writeUInt8(d.getUTCFullYear() - 1900, offset + 0);
  out.writeUInt8(d.getUTCMonth() + 1, offset + 1);
  out.writeUInt8(d.getUTCDate(), offset + 2);
  out.writeUInt8(d.getUTCHours(), offset + 3);
  out.writeUInt8(d.getUTCMinutes(), offset + 4);
  out.writeUInt8(d.getUTCSeconds(), offset + 5);
  out.writeInt8(0, offset + 6); // GMT offset = 0
}

// ── Reader helpers (exposed for tests) ────────────────────────────

/**
 * Extract a top-level file's contents from an ISO9660 image by
 * reading the Joliet (preferred) or ISO9660 root directory. Used
 * by `seed-iso.test.ts` to verify round-trip — not load-bearing in
 * production.
 *
 * Lookup strategy:
 *   1. Walk the Joliet (SVD) root directory; match the UCS-2 BE
 *      filename verbatim.
 *   2. Fall back to the ISO9660 root directory; match the 8.3
 *      short name (case-insensitive, with optional `;1` version
 *      suffix stripped).
 */
export function readSeedIsoFile(
  iso: Buffer,
  filename: string,
): Buffer | null {
  // Try Joliet first (SVD at sector 17).
  const svdOff = 17 * SECTOR_SIZE;
  if (iso.readUInt8(svdOff) === 2) {
    const jolietRootLba = iso.readUInt32LE(svdOff + 156 + 2);
    const found = findFileInJolietDir(iso, jolietRootLba, filename);
    if (found !== null) return found;
  }
  // Fall back to ISO9660 8.3 name.
  const pvdOff = 16 * SECTOR_SIZE;
  if (iso.readUInt8(pvdOff) !== 1) return null;
  const rootLba = iso.readUInt32LE(pvdOff + 156 + 2);
  return findFileInIsoDir(iso, rootLba, filename.toUpperCase());
}

function findFileInIsoDir(
  iso: Buffer,
  dirLba: number,
  filenameUpper: string,
): Buffer | null {
  const dirOff = dirLba * SECTOR_SIZE;
  let cursor = 0;
  while (cursor < SECTOR_SIZE) {
    const recLen = iso.readUInt8(dirOff + cursor);
    if (recLen === 0) break;
    const fileLba = iso.readUInt32LE(dirOff + cursor + 2);
    const fileSize = iso.readUInt32LE(dirOff + cursor + 10);
    const nameLen = iso.readUInt8(dirOff + cursor + 32);
    const name = iso.toString(
      "ascii",
      dirOff + cursor + 33,
      dirOff + cursor + 33 + nameLen,
    );
    // Strip ;1 version suffix.
    const stripped = name.replace(/;1$/, "");
    if (stripped === filenameUpper) {
      return iso.subarray(fileLba * SECTOR_SIZE, fileLba * SECTOR_SIZE + fileSize);
    }
    cursor += recLen;
  }
  return null;
}

function findFileInJolietDir(
  iso: Buffer,
  dirLba: number,
  filename: string,
): Buffer | null {
  const dirOff = dirLba * SECTOR_SIZE;
  let cursor = 0;
  while (cursor < SECTOR_SIZE) {
    const recLen = iso.readUInt8(dirOff + cursor);
    if (recLen === 0) break;
    const fileLba = iso.readUInt32LE(dirOff + cursor + 2);
    const fileSize = iso.readUInt32LE(dirOff + cursor + 10);
    const nameLen = iso.readUInt8(dirOff + cursor + 32);
    // Decode the UCS-2 BE name.
    let name = "";
    for (let i = 0; i < nameLen; i += 2) {
      const code = iso.readUInt16BE(dirOff + cursor + 33 + i);
      name += String.fromCharCode(code);
    }
    if (name === filename) {
      return iso.subarray(fileLba * SECTOR_SIZE, fileLba * SECTOR_SIZE + fileSize);
    }
    cursor += recLen;
  }
  return null;
}

// ── Test-only internals ───────────────────────────────────────────

/** @internal — exposed for unit tests. */
export const __internals = {
  toIsoShortName,
  ucs2Be,
  writeIsoDateTime17,
  writeDirDateTime7,
  SECTOR_SIZE,
};
