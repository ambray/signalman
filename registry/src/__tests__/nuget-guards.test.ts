// WS13 M3 — NuGet zip + nuspec validation helpers.

import * as zlib from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  extractNuspecFromNupkg,
  NUGET_ERROR_CODES,
  NugetError,
  parseNuspec,
} from "../nuget/index.js";

function expectNugetError(fn: () => unknown, code: string): void {
  let caught: unknown;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(NugetError);
  expect((caught as NugetError).code).toBe(code);
}

/**
 * Build a single-entry zip. The entry name + payload bytes are
 * controlled per call; compression is STORE (method 0) unless
 * `deflate` is passed. The result is a valid PK zip stream.
 */
export function buildSingleEntryZip(
  name: string,
  payload: Buffer,
  options: { deflate?: boolean } = {},
): Buffer {
  const nameBuf = Buffer.from(name, "utf-8");
  const compressionMethod = options.deflate ? 8 : 0;
  const compressed = options.deflate ? zlib.deflateRawSync(payload) : payload;
  const crc = computeCrc32(payload);
  // Local file header
  const lfh = Buffer.alloc(30 + nameBuf.length);
  lfh.writeUInt32LE(0x04034b50, 0);
  lfh.writeUInt16LE(20, 4); // version needed
  lfh.writeUInt16LE(0, 6);  // flags
  lfh.writeUInt16LE(compressionMethod, 8);
  lfh.writeUInt16LE(0, 10); // mod time
  lfh.writeUInt16LE(0, 12); // mod date
  lfh.writeUInt32LE(crc, 14);
  lfh.writeUInt32LE(compressed.length, 18);
  lfh.writeUInt32LE(payload.length, 22);
  lfh.writeUInt16LE(nameBuf.length, 26);
  lfh.writeUInt16LE(0, 28);
  nameBuf.copy(lfh, 30);

  const localHeaderOffset = 0;
  const fileData = compressed;

  // Central directory header
  const cdh = Buffer.alloc(46 + nameBuf.length);
  cdh.writeUInt32LE(0x02014b50, 0);
  cdh.writeUInt16LE(20, 4); // version made by
  cdh.writeUInt16LE(20, 6); // version needed
  cdh.writeUInt16LE(0, 8);  // flags
  cdh.writeUInt16LE(compressionMethod, 10);
  cdh.writeUInt16LE(0, 12); // mod time
  cdh.writeUInt16LE(0, 14); // mod date
  cdh.writeUInt32LE(crc, 16);
  cdh.writeUInt32LE(compressed.length, 20);
  cdh.writeUInt32LE(payload.length, 24);
  cdh.writeUInt16LE(nameBuf.length, 28);
  cdh.writeUInt16LE(0, 30);
  cdh.writeUInt16LE(0, 32);
  cdh.writeUInt16LE(0, 34);
  cdh.writeUInt16LE(0, 36);
  cdh.writeUInt32LE(0, 38); // ext attrs
  cdh.writeUInt32LE(localHeaderOffset, 42);
  nameBuf.copy(cdh, 46);

  const cdhOffset = lfh.length + fileData.length;
  const cdhSize = cdh.length;

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(1, 8);  // total entries this disk
  eocd.writeUInt16LE(1, 10); // total entries
  eocd.writeUInt32LE(cdhSize, 12);
  eocd.writeUInt32LE(cdhOffset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([lfh, fileData, cdh, eocd]);
}

/** Compute CRC-32 (zip variant, IEEE polynomial). */
function computeCrc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ ((crc & 1) !== 0 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const MINIMAL_NUSPEC = `<?xml version="1.0" encoding="utf-8"?>
<package>
  <metadata>
    <id>Demo.Lib</id>
    <version>1.0.0</version>
    <authors>Acme</authors>
    <description>A demo library.</description>
  </metadata>
</package>`;

describe("extractNuspecFromNupkg", () => {
  it("extracts a nuspec from a STORE zip", () => {
    const zip = buildSingleEntryZip(
      "Demo.Lib.nuspec",
      Buffer.from(MINIMAL_NUSPEC, "utf-8"),
    );
    const out = extractNuspecFromNupkg(zip);
    expect(out.toString("utf-8")).toBe(MINIMAL_NUSPEC);
  });
  it("extracts a nuspec from a DEFLATE zip", () => {
    const zip = buildSingleEntryZip(
      "Demo.Lib.nuspec",
      Buffer.from(MINIMAL_NUSPEC, "utf-8"),
      { deflate: true },
    );
    const out = extractNuspecFromNupkg(zip);
    expect(out.toString("utf-8")).toBe(MINIMAL_NUSPEC);
  });
  it("rejects zip with no EOCD", () => {
    expectNugetError(
      () => extractNuspecFromNupkg(Buffer.from("not a zip")),
      NUGET_ERROR_CODES.NUPKG_INVALID,
    );
  });
  it("rejects zip with no root nuspec", () => {
    const zip = buildSingleEntryZip(
      "lib/Demo.Lib.dll",
      Buffer.from("fake dll bytes"),
    );
    expectNugetError(
      () => extractNuspecFromNupkg(zip),
      NUGET_ERROR_CODES.NUSPEC_INVALID,
    );
  });
  it("rejects zip with traversal in entry name", () => {
    // Build a zip with an evil name; the CDH writer in
    // buildSingleEntryZip allows arbitrary names.
    const zip = buildSingleEntryZip(
      "../etc/passwd",
      Buffer.from("evil"),
    );
    expectNugetError(
      () => extractNuspecFromNupkg(zip),
      NUGET_ERROR_CODES.NUPKG_INVALID,
    );
  });
  it("rejects zip with corrupted CDH signature", () => {
    const zip = buildSingleEntryZip(
      "Demo.nuspec",
      Buffer.from(MINIMAL_NUSPEC, "utf-8"),
    );
    // Find the CDH signature 0x02014b50 (PK\x01\x02) and corrupt it.
    let cdhOffset = -1;
    for (let i = 0; i < zip.length - 4; i++) {
      if (zip.readUInt32LE(i) === 0x02014b50) {
        cdhOffset = i;
        break;
      }
    }
    expect(cdhOffset).toBeGreaterThan(0);
    zip.writeUInt32LE(0xdeadbeef, cdhOffset);
    expectNugetError(
      () => extractNuspecFromNupkg(zip),
      NUGET_ERROR_CODES.NUPKG_INVALID,
    );
  });
  it("rejects zip with corrupted local-file header signature", () => {
    const zip = buildSingleEntryZip(
      "Demo.nuspec",
      Buffer.from(MINIMAL_NUSPEC, "utf-8"),
    );
    // First 4 bytes = LFH signature.
    zip.writeUInt32LE(0xdeadbeef, 0);
    expectNugetError(
      () => extractNuspecFromNupkg(zip),
      NUGET_ERROR_CODES.NUPKG_INVALID,
    );
  });
});

describe("parseNuspec", () => {
  it("parses minimal nuspec", () => {
    const meta = parseNuspec(Buffer.from(MINIMAL_NUSPEC, "utf-8"));
    expect(meta.id).toBe("Demo.Lib");
    expect(meta.version).toBe("1.0.0");
    expect(meta.authors).toBe("Acme");
    expect(meta.description).toBe("A demo library.");
  });
  it("parses dependency groups", () => {
    const xml = `<?xml version="1.0"?>
<package>
  <metadata>
    <id>Demo</id>
    <version>2.0.0</version>
    <dependencies>
      <group targetFramework="net6.0">
        <dependency id="Newtonsoft.Json" version="13.0.0" />
      </group>
      <group targetFramework="netstandard2.0">
        <dependency id="System.Text.Json" version="6.0.0" />
      </group>
    </dependencies>
  </metadata>
</package>`;
    const meta = parseNuspec(Buffer.from(xml, "utf-8"));
    expect(meta.dependencyGroups).toHaveLength(2);
    expect(meta.dependencyGroups?.[0].targetFramework).toBe("net6.0");
    expect(meta.dependencyGroups?.[0].dependencies).toEqual([
      { id: "Newtonsoft.Json", range: "13.0.0" },
    ]);
    expect(meta.targetFrameworks).toEqual(["net6.0", "netstandard2.0"]);
  });
  it("parses flat (no <group>) dependencies", () => {
    const xml = `<?xml version="1.0"?>
<package>
  <metadata>
    <id>Demo</id>
    <version>2.0.0</version>
    <dependencies>
      <dependency id="Newtonsoft.Json" version="13.0.0" />
    </dependencies>
  </metadata>
</package>`;
    const meta = parseNuspec(Buffer.from(xml, "utf-8"));
    expect(meta.dependencyGroups).toHaveLength(1);
    expect(meta.dependencyGroups?.[0].dependencies).toEqual([
      { id: "Newtonsoft.Json", range: "13.0.0" },
    ]);
  });
  it("parses tags + projectUrl + licenseExpression", () => {
    const xml = `<?xml version="1.0"?>
<package>
  <metadata>
    <id>Demo</id>
    <version>1.0.0</version>
    <tags>json serializer fast</tags>
    <projectUrl>https://example.com/demo</projectUrl>
    <license>MIT</license>
    <requireLicenseAcceptance>false</requireLicenseAcceptance>
  </metadata>
</package>`;
    const meta = parseNuspec(Buffer.from(xml, "utf-8"));
    expect(meta.tags).toEqual(["json", "serializer", "fast"]);
    expect(meta.projectUrl).toBe("https://example.com/demo");
    expect(meta.licenseExpression).toBe("MIT");
    expect(meta.requireLicenseAcceptance).toBe(false);
  });
  it("decodes XML entities", () => {
    const xml = `<?xml version="1.0"?>
<package>
  <metadata>
    <id>Demo</id>
    <version>1.0.0</version>
    <description>A &amp; B &lt; C</description>
  </metadata>
</package>`;
    const meta = parseNuspec(Buffer.from(xml, "utf-8"));
    expect(meta.description).toBe("A & B < C");
  });
  it("rejects DOCTYPE", () => {
    const xml = `<?xml version="1.0"?>
<!DOCTYPE package SYSTEM "evil">
<package><metadata><id>x</id><version>1.0.0</version></metadata></package>`;
    expectNugetError(
      () => parseNuspec(Buffer.from(xml, "utf-8")),
      NUGET_ERROR_CODES.NUSPEC_INVALID,
    );
  });
  it("rejects CDATA", () => {
    const xml = `<?xml version="1.0"?>
<package><metadata><![CDATA[anything]]></metadata></package>`;
    expectNugetError(
      () => parseNuspec(Buffer.from(xml, "utf-8")),
      NUGET_ERROR_CODES.NUSPEC_INVALID,
    );
  });
  it("rejects non-package root", () => {
    const xml = `<?xml version="1.0"?>
<notpackage><metadata><id>x</id><version>1.0.0</version></metadata></notpackage>`;
    expectNugetError(
      () => parseNuspec(Buffer.from(xml, "utf-8")),
      NUGET_ERROR_CODES.NUSPEC_INVALID,
    );
  });
  it("rejects missing id", () => {
    const xml = `<?xml version="1.0"?>
<package><metadata><version>1.0.0</version></metadata></package>`;
    expectNugetError(
      () => parseNuspec(Buffer.from(xml, "utf-8")),
      NUGET_ERROR_CODES.NUSPEC_INVALID,
    );
  });
  it("rejects missing version", () => {
    const xml = `<?xml version="1.0"?>
<package><metadata><id>Demo</id></metadata></package>`;
    expectNugetError(
      () => parseNuspec(Buffer.from(xml, "utf-8")),
      NUGET_ERROR_CODES.NUSPEC_INVALID,
    );
  });
  it("rejects oversize", () => {
    const big = Buffer.alloc(5 * 1024 * 1024, 0x20);
    expectNugetError(
      () => parseNuspec(big),
      NUGET_ERROR_CODES.NUSPEC_INVALID,
    );
  });
  it("rejects unclosed XML declaration", () => {
    const xml = `<?xml version="1.0"<package><metadata><id>x</id><version>1.0.0</version></metadata></package>`;
    expectNugetError(
      () => parseNuspec(Buffer.from(xml, "utf-8")),
      NUGET_ERROR_CODES.NUSPEC_INVALID,
    );
  });
  it("rejects unclosed comment", () => {
    const xml = `<package><!-- never closes <metadata><id>x</id><version>1.0.0</version></metadata></package>`;
    expectNugetError(
      () => parseNuspec(Buffer.from(xml, "utf-8")),
      NUGET_ERROR_CODES.NUSPEC_INVALID,
    );
  });
  it("rejects mismatched close tag", () => {
    const xml = `<?xml version="1.0"?>
<package><metadata><id>x</id></package></metadata>`;
    expectNugetError(
      () => parseNuspec(Buffer.from(xml, "utf-8")),
      NUGET_ERROR_CODES.NUSPEC_INVALID,
    );
  });
  it("rejects unclosed root element", () => {
    const xml = `<?xml version="1.0"?>
<package><metadata><id>x</id><version>1.0.0</version></metadata>`;
    expectNugetError(
      () => parseNuspec(Buffer.from(xml, "utf-8")),
      NUGET_ERROR_CODES.NUSPEC_INVALID,
    );
  });
  it("rejects multiple root elements", () => {
    const xml = `<?xml version="1.0"?>
<package><metadata><id>x</id><version>1.0.0</version></metadata></package><other/>`;
    expectNugetError(
      () => parseNuspec(Buffer.from(xml, "utf-8")),
      NUGET_ERROR_CODES.NUSPEC_INVALID,
    );
  });
  it("rejects empty document", () => {
    expectNugetError(
      () => parseNuspec(Buffer.from("", "utf-8")),
      NUGET_ERROR_CODES.NUSPEC_INVALID,
    );
  });
  it("rejects dependency without id attribute", () => {
    const xml = `<?xml version="1.0"?>
<package><metadata><id>x</id><version>1.0.0</version><dependencies><dependency version="1.0.0"/></dependencies></metadata></package>`;
    expectNugetError(
      () => parseNuspec(Buffer.from(xml, "utf-8")),
      NUGET_ERROR_CODES.NUSPEC_INVALID,
    );
  });
  it("accepts comments anywhere", () => {
    const xml = `<?xml version="1.0"?>
<package>
  <!-- main metadata block -->
  <metadata>
    <id>Demo</id>
    <version>1.0.0</version>
  </metadata>
</package>`;
    const meta = parseNuspec(Buffer.from(xml, "utf-8"));
    expect(meta.id).toBe("Demo");
  });
  it("accepts self-closing tags", () => {
    const xml = `<?xml version="1.0"?>
<package><metadata><id>x</id><version>1.0.0</version><other/></metadata></package>`;
    const meta = parseNuspec(Buffer.from(xml, "utf-8"));
    expect(meta.id).toBe("x");
  });
  it("rejects open tag with no closing >", () => {
    const xml = `<?xml version="1.0"?><package<metadata>`;
    expectNugetError(
      () => parseNuspec(Buffer.from(xml, "utf-8")),
      NUGET_ERROR_CODES.NUSPEC_INVALID,
    );
  });
  it("rejects processing instruction with no closing ?>", () => {
    const xml = `<?xml version="1.0"?>\n<?never-closes`;
    expectNugetError(
      () => parseNuspec(Buffer.from(xml, "utf-8")),
      NUGET_ERROR_CODES.NUSPEC_INVALID,
    );
  });
  it("rejects tag with invalid name", () => {
    const xml = `<?xml version="1.0"?>
<package>
  <metadata>
    <id>x</id>
    <version>1.0.0</version>
    <1bad-tag-name/>
  </metadata>
</package>`;
    expectNugetError(
      () => parseNuspec(Buffer.from(xml, "utf-8")),
      NUGET_ERROR_CODES.NUSPEC_INVALID,
    );
  });
  it("rejects close tag with no closing >", () => {
    const xml = `<?xml version="1.0"?>
<package><metadata><id>x</id><version>1.0.0</version></metadata</package>`;
    expectNugetError(
      () => parseNuspec(Buffer.from(xml, "utf-8")),
      NUGET_ERROR_CODES.NUSPEC_INVALID,
    );
  });
  it("ignores processing instructions after declaration", () => {
    const xml = `<?xml version="1.0"?>
<?xml-stylesheet href="style.xsl"?>
<package><metadata><id>x</id><version>1.0.0</version></metadata></package>`;
    const meta = parseNuspec(Buffer.from(xml, "utf-8"));
    expect(meta.id).toBe("x");
  });
});
