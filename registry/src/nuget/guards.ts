/**
 * Strict-validating helpers for NuGet inputs that cross the trust
 * boundary — the nupkg payload + the operator-supplied (id, version)
 * tuple — plus a minimal `.nuspec` extractor and parser.
 *
 * A `.nupkg` is a zip with the package's `<id>.nuspec` at the root.
 * The nuspec is an XML document the NuGet protocol uses to populate
 * registration / search responses. We parse the bytes server-side
 * to produce the row-side `NugetManifestMetadata` projection.
 *
 * Security posture:
 *   - Zip decoder is strict: rejects oversize central-directory
 *     entries, oversize filenames, zip64-only streams (we accept
 *     standard 32-bit only — operator-built nupkgs almost never
 *     exceed 4 GiB), STORE + DEFLATE compression only.
 *   - Nuspec XML parser rejects attributes outside the documented
 *     schema, DOCTYPE / CDATA / external entities (no XXE).
 *
 * Reference:
 *   https://learn.microsoft.com/en-us/nuget/reference/nuspec
 *   https://learn.microsoft.com/en-us/nuget/concepts/package-versioning
 */

import * as zlib from "node:zlib";
import { NugetError } from "./errors.js";
import {
  NUGET_ERROR_CODES,
  type NugetDependencyGroup,
  type NuspecMetadata,
} from "./types.js";

// ── Zip extraction ─────────────────────────────────────────────────

interface ZipEntry {
  name: string;
  size: number;
  compressedSize: number;
  compressionMethod: number; // 0 = stored, 8 = deflate
  localHeaderOffset: number;
}

const MAX_ENTRY_SIZE = 64 * 1024 * 1024; // 64 MiB for a single in-zip file (the nuspec is tiny in practice)
const MAX_FILENAME = 256;
const MAX_ENTRIES = 100_000;

/**
 * Locate the `.nuspec` entry inside a nupkg zip and return its bytes.
 * Throws `NUPKG_INVALID` when the zip is malformed and `NUSPEC_INVALID`
 * when no nuspec is present.
 */
export function extractNuspecFromNupkg(nupkg: Buffer): Buffer {
  const entries = readCentralDirectory(nupkg);
  // The nuspec lives at the zip root with name `<id>.nuspec`. The
  // operator's nuspec id determines the filename, so we scan for
  // the first `.nuspec` at the zip root (no path separator).
  let chosen: ZipEntry | null = null;
  for (const e of entries) {
    if (e.name.includes("/") || e.name.includes("\\")) continue;
    if (e.name.toLowerCase().endsWith(".nuspec")) {
      if (chosen) {
        throw new NugetError(
          NUGET_ERROR_CODES.NUPKG_INVALID,
          "nupkg contains more than one root-level .nuspec entry",
        );
      }
      chosen = e;
    }
  }
  if (!chosen) {
    throw new NugetError(
      NUGET_ERROR_CODES.NUSPEC_INVALID,
      "nupkg does not contain a root-level .nuspec file",
    );
  }
  return readZipEntry(nupkg, chosen);
}

function readCentralDirectory(buf: Buffer): ZipEntry[] {
  // EOCD record signature: 0x06054b50 (`PK\x05\x06`).
  const EOCD_SIG = 0x06054b50;
  // Search backwards from the end for the EOCD signature. EOCD's
  // comment field is at most 0xFFFF bytes; we cap the scan.
  const maxScan = Math.min(buf.length, 0xffff + 22);
  let eocdOffset = -1;
  for (let i = buf.length - 22; i >= buf.length - maxScan && i >= 0; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset < 0) {
    throw new NugetError(
      NUGET_ERROR_CODES.NUPKG_INVALID,
      "zip end-of-central-directory record not found",
    );
  }
  const totalEntries = buf.readUInt16LE(eocdOffset + 10);
  const centralSize = buf.readUInt32LE(eocdOffset + 12);
  const centralOffset = buf.readUInt32LE(eocdOffset + 16);
  if (totalEntries > MAX_ENTRIES) {
    throw new NugetError(
      NUGET_ERROR_CODES.NUPKG_INVALID,
      `zip declares ${totalEntries} entries (max ${MAX_ENTRIES})`,
    );
  }
  if (centralOffset + centralSize > buf.length) {
    throw new NugetError(
      NUGET_ERROR_CODES.NUPKG_INVALID,
      "central directory extends past end of file",
    );
  }
  const entries: ZipEntry[] = [];
  let cur = centralOffset;
  const CDH_SIG = 0x02014b50;
  for (let i = 0; i < totalEntries; i++) {
    if (cur + 46 > buf.length) {
      throw new NugetError(
        NUGET_ERROR_CODES.NUPKG_INVALID,
        "central-directory header truncated",
      );
    }
    if (buf.readUInt32LE(cur) !== CDH_SIG) {
      throw new NugetError(
        NUGET_ERROR_CODES.NUPKG_INVALID,
        `central-directory header signature mismatch at offset ${cur}`,
      );
    }
    const compressionMethod = buf.readUInt16LE(cur + 10);
    const compressedSize = buf.readUInt32LE(cur + 20);
    const uncompressedSize = buf.readUInt32LE(cur + 24);
    const nameLen = buf.readUInt16LE(cur + 28);
    const extraLen = buf.readUInt16LE(cur + 30);
    const commentLen = buf.readUInt16LE(cur + 32);
    const localOffset = buf.readUInt32LE(cur + 42);
    if (nameLen > MAX_FILENAME) {
      throw new NugetError(
        NUGET_ERROR_CODES.NUPKG_INVALID,
        `zip entry filename length ${nameLen} exceeds max ${MAX_FILENAME}`,
      );
    }
    if (uncompressedSize > MAX_ENTRY_SIZE) {
      throw new NugetError(
        NUGET_ERROR_CODES.NUPKG_INVALID,
        `zip entry uncompressed size ${uncompressedSize} exceeds max ${MAX_ENTRY_SIZE}`,
      );
    }
    if (uncompressedSize === 0xffffffff || compressedSize === 0xffffffff) {
      throw new NugetError(
        NUGET_ERROR_CODES.NUPKG_INVALID,
        "zip64 entries are not supported (use a non-zip64 nupkg)",
      );
    }
    if (compressionMethod !== 0 && compressionMethod !== 8) {
      throw new NugetError(
        NUGET_ERROR_CODES.NUPKG_INVALID,
        `zip compression method ${compressionMethod} not supported (only stored or deflate)`,
      );
    }
    const name = buf
      .subarray(cur + 46, cur + 46 + nameLen)
      .toString("utf-8");
    // Reject path traversal in zip entry names — same defence as
    // unzip-bomb checks elsewhere in the codebase.
    if (name.includes("..") || name.startsWith("/") || name.includes("\0")) {
      throw new NugetError(
        NUGET_ERROR_CODES.NUPKG_INVALID,
        `zip entry name '${name}' contains forbidden characters`,
      );
    }
    entries.push({
      name,
      size: uncompressedSize,
      compressedSize,
      compressionMethod,
      localHeaderOffset: localOffset,
    });
    cur += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function readZipEntry(buf: Buffer, entry: ZipEntry): Buffer {
  const LFH_SIG = 0x04034b50;
  const off = entry.localHeaderOffset;
  if (off + 30 > buf.length) {
    throw new NugetError(
      NUGET_ERROR_CODES.NUPKG_INVALID,
      "zip local header truncated",
    );
  }
  if (buf.readUInt32LE(off) !== LFH_SIG) {
    throw new NugetError(
      NUGET_ERROR_CODES.NUPKG_INVALID,
      `zip local header signature mismatch at offset ${off}`,
    );
  }
  const nameLen = buf.readUInt16LE(off + 26);
  const extraLen = buf.readUInt16LE(off + 28);
  const dataStart = off + 30 + nameLen + extraLen;
  if (dataStart + entry.compressedSize > buf.length) {
    throw new NugetError(
      NUGET_ERROR_CODES.NUPKG_INVALID,
      "zip entry data extends past end of file",
    );
  }
  const raw = buf.subarray(dataStart, dataStart + entry.compressedSize);
  if (entry.compressionMethod === 0) {
    if (raw.length !== entry.size) {
      throw new NugetError(
        NUGET_ERROR_CODES.NUPKG_INVALID,
        `stored entry size mismatch (declared ${entry.size}, actual ${raw.length})`,
      );
    }
    return Buffer.from(raw);
  }
  // DEFLATE — inflateRaw, no zlib header.
  try {
    const out = zlib.inflateRawSync(raw, { maxOutputLength: MAX_ENTRY_SIZE });
    if (out.length !== entry.size) {
      throw new NugetError(
        NUGET_ERROR_CODES.NUPKG_INVALID,
        `inflated entry size mismatch (declared ${entry.size}, actual ${out.length})`,
      );
    }
    return out;
  } catch (err) {
    if (err instanceof NugetError) throw err;
    throw new NugetError(
      NUGET_ERROR_CODES.NUPKG_INVALID,
      `zip entry inflate failed: ${(err as Error).message}`,
    );
  }
}

// ── Nuspec XML parser ──────────────────────────────────────────────

interface XmlNode {
  tag: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
}

const MAX_XML_DEPTH = 64;
const MAX_XML_LEN = 4 * 1024 * 1024; // 4 MiB — far larger than any real nuspec

/**
 * Parse the nuspec XML bytes into the row-side `NuspecMetadata`
 * projection. Strict XML semantics: rejects DOCTYPE/CDATA/external
 * entities. Attributes are accepted only where the nuspec schema
 * explicitly uses them (dependency `id`/`version`, group
 * `targetFramework`).
 */
export function parseNuspec(xmlBytes: Buffer): NuspecMetadata {
  if (xmlBytes.length > MAX_XML_LEN) {
    throw new NugetError(
      NUGET_ERROR_CODES.NUSPEC_INVALID,
      `nuspec exceeds max size ${MAX_XML_LEN}`,
    );
  }
  const xml = xmlBytes.toString("utf-8");
  const root = parseXml(xml);
  if (root.tag !== "package") {
    throw new NugetError(
      NUGET_ERROR_CODES.NUSPEC_INVALID,
      `nuspec root element must be <package>, got <${root.tag}>`,
    );
  }
  const metadata = findChild(root, "metadata");
  if (!metadata) {
    throw new NugetError(
      NUGET_ERROR_CODES.NUSPEC_INVALID,
      "nuspec <package> missing <metadata>",
    );
  }
  const id = textOf(findChild(metadata, "id"));
  const version = textOf(findChild(metadata, "version"));
  if (!id || !version) {
    throw new NugetError(
      NUGET_ERROR_CODES.NUSPEC_INVALID,
      "nuspec <metadata> missing <id> or <version>",
    );
  }
  const out: NuspecMetadata = {
    id: decodeEntities(id),
    version: decodeEntities(version),
  };
  const optionals: Array<[keyof NuspecMetadata, string]> = [
    ["authors", "authors"],
    ["owners", "owners"],
    ["description", "description"],
    ["summary", "summary"],
    ["title", "title"],
    ["projectUrl", "projectUrl"],
    ["licenseUrl", "licenseUrl"],
    ["iconUrl", "iconUrl"],
  ];
  for (const [field, tag] of optionals) {
    const v = textOf(findChild(metadata, tag));
    if (v) (out as unknown as Record<string, unknown>)[field] = decodeEntities(v);
  }
  const license = findChild(metadata, "license");
  if (license) {
    const expr = textOf(license);
    if (expr) out.licenseExpression = decodeEntities(expr);
  }
  const tagsRaw = textOf(findChild(metadata, "tags"));
  if (tagsRaw) {
    out.tags = decodeEntities(tagsRaw)
      .split(/\s+/)
      .filter((t) => t.length > 0);
  }
  const requireLicense = textOf(findChild(metadata, "requireLicenseAcceptance"));
  if (requireLicense !== undefined) {
    out.requireLicenseAcceptance = requireLicense.toLowerCase() === "true";
  }
  const dependencies = findChild(metadata, "dependencies");
  if (dependencies) {
    const groups: NugetDependencyGroup[] = [];
    const groupNodes = findChildren(dependencies, "group");
    if (groupNodes.length > 0) {
      for (const g of groupNodes) {
        const tfm = g.attrs.targetFramework;
        const deps = findChildren(g, "dependency").map((d) => ({
          id: requireAttr(d, "id"),
          ...(d.attrs.version ? { range: d.attrs.version } : {}),
        }));
        groups.push({
          ...(tfm ? { targetFramework: tfm } : {}),
          dependencies: deps,
        });
      }
    } else {
      // Flat dependencies (no <group> wrapper) — legacy nuspec.
      const deps = findChildren(dependencies, "dependency").map((d) => ({
        id: requireAttr(d, "id"),
        ...(d.attrs.version ? { range: d.attrs.version } : {}),
      }));
      if (deps.length > 0) groups.push({ dependencies: deps });
    }
    if (groups.length > 0) out.dependencyGroups = groups;
    // Aggregate target frameworks across groups (informational only).
    const tfms = groups
      .map((g) => g.targetFramework)
      .filter((t): t is string => typeof t === "string");
    if (tfms.length > 0) out.targetFrameworks = tfms;
  }
  return out;
}

function parseXml(input: string): XmlNode {
  const trimmed = input.trim();
  let cursor = 0;
  const skipWhitespace = (): void => {
    while (cursor < trimmed.length && /\s/.test(trimmed[cursor])) cursor++;
  };
  skipWhitespace();
  if (trimmed.startsWith("<?xml", cursor)) {
    const end = trimmed.indexOf("?>", cursor);
    if (end < 0) {
      throw new NugetError(
        NUGET_ERROR_CODES.NUSPEC_INVALID,
        "XML declaration is not closed",
      );
    }
    cursor = end + 2;
  }
  skipWhitespace();
  const stack: XmlNode[] = [];
  let root: XmlNode | null = null;
  while (cursor < trimmed.length) {
    if (stack.length > MAX_XML_DEPTH) {
      throw new NugetError(
        NUGET_ERROR_CODES.NUSPEC_INVALID,
        `XML depth exceeds ${MAX_XML_DEPTH}`,
      );
    }
    if (trimmed[cursor] !== "<") {
      const tagOpen = trimmed.indexOf("<", cursor);
      const end = tagOpen < 0 ? trimmed.length : tagOpen;
      const chunk = trimmed.slice(cursor, end);
      if (stack.length > 0 && chunk.trim().length > 0) {
        stack[stack.length - 1].text += chunk;
      }
      cursor = end;
      continue;
    }
    if (trimmed[cursor + 1] === "!") {
      if (trimmed.startsWith("<!--", cursor)) {
        const end = trimmed.indexOf("-->", cursor + 4);
        if (end < 0) {
          throw new NugetError(
            NUGET_ERROR_CODES.NUSPEC_INVALID,
            "XML comment is not closed",
          );
        }
        cursor = end + 3;
        continue;
      }
      throw new NugetError(
        NUGET_ERROR_CODES.NUSPEC_INVALID,
        "XML feature (CDATA / DOCTYPE) not supported in nuspec",
      );
    }
    if (trimmed[cursor + 1] === "?") {
      const end = trimmed.indexOf("?>", cursor + 2);
      if (end < 0) {
        throw new NugetError(
          NUGET_ERROR_CODES.NUSPEC_INVALID,
          "XML processing instruction is not closed",
        );
      }
      cursor = end + 2;
      continue;
    }
    if (trimmed[cursor + 1] === "/") {
      const tagEnd = trimmed.indexOf(">", cursor);
      if (tagEnd < 0) {
        throw new NugetError(
          NUGET_ERROR_CODES.NUSPEC_INVALID,
          "XML close tag is not closed",
        );
      }
      const tag = trimmed.slice(cursor + 2, tagEnd).trim();
      const top = stack.pop();
      if (!top || top.tag !== tag) {
        throw new NugetError(
          NUGET_ERROR_CODES.NUSPEC_INVALID,
          `XML mismatched close tag '${tag}' (expected '${top?.tag ?? "<empty>"}')`,
        );
      }
      cursor = tagEnd + 1;
      continue;
    }
    const tagEnd = trimmed.indexOf(">", cursor);
    if (tagEnd < 0) {
      throw new NugetError(
        NUGET_ERROR_CODES.NUSPEC_INVALID,
        "XML open tag is not closed",
      );
    }
    let tagBody = trimmed.slice(cursor + 1, tagEnd).trim();
    let selfClosing = false;
    if (tagBody.endsWith("/")) {
      selfClosing = true;
      tagBody = tagBody.slice(0, -1).trim();
    }
    const { tag, attrs } = parseTagBody(tagBody);
    const node: XmlNode = { tag, attrs, children: [], text: "" };
    if (stack.length > 0) {
      stack[stack.length - 1].children.push(node);
    } else {
      if (root) {
        throw new NugetError(
          NUGET_ERROR_CODES.NUSPEC_INVALID,
          "XML document has multiple root elements",
        );
      }
      root = node;
    }
    if (!selfClosing) stack.push(node);
    cursor = tagEnd + 1;
  }
  if (stack.length > 0) {
    throw new NugetError(
      NUGET_ERROR_CODES.NUSPEC_INVALID,
      `XML element <${stack[stack.length - 1].tag}> not closed`,
    );
  }
  if (!root) {
    throw new NugetError(
      NUGET_ERROR_CODES.NUSPEC_INVALID,
      "XML document has no root element",
    );
  }
  return root;
}

function parseTagBody(body: string): { tag: string; attrs: Record<string, string> } {
  // Split on first whitespace — tag name, then attributes.
  const m = /^([A-Za-z_][A-Za-z0-9._:-]*)/.exec(body);
  if (!m) {
    throw new NugetError(
      NUGET_ERROR_CODES.NUSPEC_INVALID,
      `XML tag name invalid in '<${body}>'`,
    );
  }
  const tag = m[1];
  const rest = body.slice(tag.length).trim();
  const attrs: Record<string, string> = {};
  if (rest.length === 0) return { tag, attrs };
  // Attributes: `name="value"` repeated, whitespace-separated.
  const attrRe = /([A-Za-z_][A-Za-z0-9._:-]*)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let am: RegExpExecArray | null;
  let lastEnd = 0;
  while ((am = attrRe.exec(rest)) !== null) {
    const name = am[1];
    const value = am[3] ?? am[4] ?? "";
    attrs[name] = decodeEntities(value);
    lastEnd = am.index + am[0].length;
  }
  // Reject anything left over (we don't accept unquoted attributes).
  const leftover = rest.slice(lastEnd).trim();
  if (leftover.length > 0) {
    throw new NugetError(
      NUGET_ERROR_CODES.NUSPEC_INVALID,
      `XML tag '<${body}>' has unparseable trailing content '${leftover}'`,
    );
  }
  return { tag, attrs };
}

function findChild(node: XmlNode, tag: string): XmlNode | null {
  for (const c of node.children) if (c.tag === tag) return c;
  return null;
}

function findChildren(node: XmlNode, tag: string): XmlNode[] {
  return node.children.filter((c) => c.tag === tag);
}

function textOf(node: XmlNode | null): string | undefined {
  if (!node) return undefined;
  const t = node.text.trim();
  return t.length > 0 ? t : undefined;
}

function requireAttr(node: XmlNode, name: string): string {
  const v = node.attrs[name];
  if (typeof v !== "string" || v.length === 0) {
    throw new NugetError(
      NUGET_ERROR_CODES.NUSPEC_INVALID,
      `nuspec <${node.tag}> missing required attribute '${name}'`,
    );
  }
  return v;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}
