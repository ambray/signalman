/**
 * `maven-metadata.xml` parser + composer.
 *
 * Two flavours, both single-rooted `<metadata>` documents with the
 * Maven Repository Metadata schema:
 *
 *   - **Artifact-level**: at `<groupPath>/<artifactId>/maven-metadata.xml`.
 *     Carries `<versioning>{<latest>, <release>, <versions>{<version>...},
 *     <lastUpdated>}</versioning>`.
 *   - **Snapshot version-level**: at
 *     `<groupPath>/<artifactId>/<baseVersion>/maven-metadata.xml`.
 *     Carries `<versioning><snapshot>{<timestamp>, <buildNumber>}</snapshot>
 *     <lastUpdated><snapshotVersions>{<snapshotVersion>{<classifier>?,
 *     <extension>, <value>, <updated>?}}</snapshotVersions></versioning>`.
 *
 * Reference:
 *   https://maven.apache.org/ref/3.9.6/maven-repository-metadata/repository-metadata.html
 *
 * We hand-roll a minimal XML parser + composer here rather than pull
 * a dependency. The metadata schema is structurally simple — no
 * attributes (the Maven Central serializer omits them), no
 * namespaces, no CDATA in practice, no DTD. The parser is strict
 * about the element shape and rejects anything outside the
 * documented schema.
 */

import { MavenError } from "./errors.js";
import {
  MAVEN_ERROR_CODES,
  type MavenArtifactMetadata,
  type MavenSnapshotMetadata,
} from "./types.js";

// ── Mini-XML parser ────────────────────────────────────────────────

interface XmlNode {
  tag: string;
  children: XmlNode[];
  text: string;
}

/**
 * Parse a Maven metadata XML document into a tree. Throws on
 * mismatched tags, unknown structural features (CDATA, processing
 * instructions other than the XML declaration), or document depth
 * over 64 (defensive).
 */
function parseXml(input: string): XmlNode {
  const trimmed = input.trim();
  // Strip the optional `<?xml ...?>` declaration.
  let cursor = 0;
  const skipWhitespace = (): void => {
    while (cursor < trimmed.length && /\s/.test(trimmed[cursor])) cursor++;
  };
  skipWhitespace();
  if (trimmed.startsWith("<?xml", cursor)) {
    const end = trimmed.indexOf("?>", cursor);
    if (end < 0) {
      throw new MavenError(
        MAVEN_ERROR_CODES.UPLOAD_INVALID,
        "XML declaration is not closed",
      );
    }
    cursor = end + 2;
  }
  skipWhitespace();
  const stack: XmlNode[] = [];
  let root: XmlNode | null = null;
  while (cursor < trimmed.length) {
    if (stack.length > 64) {
      throw new MavenError(
        MAVEN_ERROR_CODES.UPLOAD_INVALID,
        "XML depth exceeds 64",
      );
    }
    if (trimmed[cursor] !== "<") {
      // Character data accumulates onto the top-of-stack node.
      const tagOpen = trimmed.indexOf("<", cursor);
      const end = tagOpen < 0 ? trimmed.length : tagOpen;
      const chunk = trimmed.slice(cursor, end);
      if (stack.length > 0 && chunk.trim().length > 0) {
        stack[stack.length - 1].text += chunk;
      }
      cursor = end;
      continue;
    }
    // Look at the next char.
    if (trimmed[cursor + 1] === "!") {
      // <!-- comment --> — skip.
      if (trimmed.startsWith("<!--", cursor)) {
        const end = trimmed.indexOf("-->", cursor + 4);
        if (end < 0) {
          throw new MavenError(
            MAVEN_ERROR_CODES.UPLOAD_INVALID,
            "XML comment is not closed",
          );
        }
        cursor = end + 3;
        continue;
      }
      // CDATA or DOCTYPE — not expected in maven-metadata, reject.
      throw new MavenError(
        MAVEN_ERROR_CODES.UPLOAD_INVALID,
        "XML feature (CDATA / DOCTYPE) not supported in maven-metadata",
      );
    }
    if (trimmed[cursor + 1] === "?") {
      // Processing instruction beyond <?xml ...?>; skip silently.
      const end = trimmed.indexOf("?>", cursor + 2);
      if (end < 0) {
        throw new MavenError(
          MAVEN_ERROR_CODES.UPLOAD_INVALID,
          "XML processing instruction is not closed",
        );
      }
      cursor = end + 2;
      continue;
    }
    if (trimmed[cursor + 1] === "/") {
      // Close tag.
      const tagEnd = trimmed.indexOf(">", cursor);
      if (tagEnd < 0) {
        throw new MavenError(
          MAVEN_ERROR_CODES.UPLOAD_INVALID,
          "XML close tag is not closed",
        );
      }
      const tag = trimmed.slice(cursor + 2, tagEnd).trim();
      const top = stack.pop();
      if (!top || top.tag !== tag) {
        throw new MavenError(
          MAVEN_ERROR_CODES.UPLOAD_INVALID,
          `XML mismatched close tag '${tag}' (expected '${top?.tag ?? "<empty>"}')`,
        );
      }
      cursor = tagEnd + 1;
      continue;
    }
    // Open tag (possibly self-closing).
    const tagEnd = trimmed.indexOf(">", cursor);
    if (tagEnd < 0) {
      throw new MavenError(
        MAVEN_ERROR_CODES.UPLOAD_INVALID,
        "XML open tag is not closed",
      );
    }
    let tagBody = trimmed.slice(cursor + 1, tagEnd).trim();
    let selfClosing = false;
    if (tagBody.endsWith("/")) {
      selfClosing = true;
      tagBody = tagBody.slice(0, -1).trim();
    }
    // We don't accept attributes in maven-metadata; reject any
    // whitespace inside the open tag's body.
    if (/\s/.test(tagBody)) {
      throw new MavenError(
        MAVEN_ERROR_CODES.UPLOAD_INVALID,
        `XML attributes are not supported in maven-metadata (saw <${tagBody}>)`,
      );
    }
    const node: XmlNode = { tag: tagBody, children: [], text: "" };
    if (stack.length > 0) {
      stack[stack.length - 1].children.push(node);
    } else {
      if (root) {
        throw new MavenError(
          MAVEN_ERROR_CODES.UPLOAD_INVALID,
          "XML document has multiple root elements",
        );
      }
      root = node;
    }
    if (!selfClosing) stack.push(node);
    cursor = tagEnd + 1;
  }
  if (stack.length > 0) {
    throw new MavenError(
      MAVEN_ERROR_CODES.UPLOAD_INVALID,
      `XML element <${stack[stack.length - 1].tag}> not closed`,
    );
  }
  if (!root) {
    throw new MavenError(
      MAVEN_ERROR_CODES.UPLOAD_INVALID,
      "XML document has no root element",
    );
  }
  return root;
}

function findChild(node: XmlNode, tag: string): XmlNode | null {
  for (const c of node.children) {
    if (c.tag === tag) return c;
  }
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

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function encodeEntities(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// ── Artifact metadata parser ───────────────────────────────────────

export function parseArtifactMetadata(xml: string): MavenArtifactMetadata {
  const root = parseXml(xml);
  if (root.tag !== "metadata") {
    throw new MavenError(
      MAVEN_ERROR_CODES.UPLOAD_INVALID,
      `expected <metadata> root, got <${root.tag}>`,
    );
  }
  const groupId = textOf(findChild(root, "groupId"));
  const artifactId = textOf(findChild(root, "artifactId"));
  if (!groupId || !artifactId) {
    throw new MavenError(
      MAVEN_ERROR_CODES.UPLOAD_INVALID,
      "<metadata> missing <groupId> or <artifactId>",
    );
  }
  const versioning = findChild(root, "versioning");
  if (!versioning) {
    throw new MavenError(
      MAVEN_ERROR_CODES.UPLOAD_INVALID,
      "<metadata> missing <versioning>",
    );
  }
  const versionsNode = findChild(versioning, "versions");
  const versions: string[] = versionsNode
    ? findChildren(versionsNode, "version")
        .map((v) => decodeEntities(v.text.trim()))
        .filter((v) => v.length > 0)
    : [];
  const md: MavenArtifactMetadata = {
    groupId: decodeEntities(groupId),
    artifactId: decodeEntities(artifactId),
    versioning: {
      versions,
    },
  };
  const latest = textOf(findChild(versioning, "latest"));
  if (latest) md.versioning.latest = decodeEntities(latest);
  const release = textOf(findChild(versioning, "release"));
  if (release) md.versioning.release = decodeEntities(release);
  const lastUpdated = textOf(findChild(versioning, "lastUpdated"));
  if (lastUpdated) md.versioning.lastUpdated = decodeEntities(lastUpdated);
  return md;
}

// ── Snapshot metadata parser ───────────────────────────────────────

export function parseSnapshotMetadata(xml: string): MavenSnapshotMetadata {
  const root = parseXml(xml);
  if (root.tag !== "metadata") {
    throw new MavenError(
      MAVEN_ERROR_CODES.UPLOAD_INVALID,
      `expected <metadata> root, got <${root.tag}>`,
    );
  }
  const groupId = textOf(findChild(root, "groupId"));
  const artifactId = textOf(findChild(root, "artifactId"));
  const version = textOf(findChild(root, "version"));
  if (!groupId || !artifactId || !version) {
    throw new MavenError(
      MAVEN_ERROR_CODES.UPLOAD_INVALID,
      "<metadata> missing <groupId>, <artifactId>, or <version>",
    );
  }
  const versioning = findChild(root, "versioning");
  if (!versioning) {
    throw new MavenError(
      MAVEN_ERROR_CODES.UPLOAD_INVALID,
      "snapshot <metadata> missing <versioning>",
    );
  }
  const snapshot = findChild(versioning, "snapshot");
  if (!snapshot) {
    throw new MavenError(
      MAVEN_ERROR_CODES.UPLOAD_INVALID,
      "snapshot <versioning> missing <snapshot>",
    );
  }
  const timestamp = textOf(findChild(snapshot, "timestamp"));
  const buildNumberRaw = textOf(findChild(snapshot, "buildNumber"));
  if (!timestamp || !buildNumberRaw) {
    throw new MavenError(
      MAVEN_ERROR_CODES.UPLOAD_INVALID,
      "<snapshot> missing <timestamp> or <buildNumber>",
    );
  }
  const buildNumber = parseInt(buildNumberRaw, 10);
  if (Number.isNaN(buildNumber) || buildNumber < 0) {
    throw new MavenError(
      MAVEN_ERROR_CODES.UPLOAD_INVALID,
      `<buildNumber> '${buildNumberRaw}' is not a non-negative integer`,
    );
  }
  const md: MavenSnapshotMetadata = {
    groupId: decodeEntities(groupId),
    artifactId: decodeEntities(artifactId),
    version: decodeEntities(version),
    versioning: {
      snapshot: { timestamp: decodeEntities(timestamp), buildNumber },
    },
  };
  const lastUpdated = textOf(findChild(versioning, "lastUpdated"));
  if (lastUpdated) md.versioning.lastUpdated = decodeEntities(lastUpdated);
  const snapshotVersionsNode = findChild(versioning, "snapshotVersions");
  if (snapshotVersionsNode) {
    md.versioning.snapshotVersions = findChildren(
      snapshotVersionsNode,
      "snapshotVersion",
    ).map((sv) => {
      const extension = textOf(findChild(sv, "extension"));
      const value = textOf(findChild(sv, "value"));
      if (!extension || !value) {
        throw new MavenError(
          MAVEN_ERROR_CODES.UPLOAD_INVALID,
          "<snapshotVersion> missing <extension> or <value>",
        );
      }
      const out: NonNullable<
        MavenSnapshotMetadata["versioning"]["snapshotVersions"]
      >[number] = {
        extension: decodeEntities(extension),
        value: decodeEntities(value),
      };
      const classifier = textOf(findChild(sv, "classifier"));
      if (classifier) out.classifier = decodeEntities(classifier);
      const updated = textOf(findChild(sv, "updated"));
      if (updated) out.updated = decodeEntities(updated);
      return out;
    });
  }
  return md;
}

// ── Composers ──────────────────────────────────────────────────────

/**
 * Compose artifact-level metadata XML. Field ordering matches the
 * Maven Repository Metadata canonical serialization (latest before
 * release before versions before lastUpdated) so round-trip parse
 * → compose is byte-identical for the common case.
 */
export function composeArtifactMetadata(md: MavenArtifactMetadata): string {
  const v = md.versioning;
  const lines: string[] = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push("<metadata>");
  lines.push(`  <groupId>${encodeEntities(md.groupId)}</groupId>`);
  lines.push(`  <artifactId>${encodeEntities(md.artifactId)}</artifactId>`);
  lines.push("  <versioning>");
  if (v.latest !== undefined) {
    lines.push(`    <latest>${encodeEntities(v.latest)}</latest>`);
  }
  if (v.release !== undefined) {
    lines.push(`    <release>${encodeEntities(v.release)}</release>`);
  }
  lines.push("    <versions>");
  for (const version of v.versions) {
    lines.push(`      <version>${encodeEntities(version)}</version>`);
  }
  lines.push("    </versions>");
  if (v.lastUpdated !== undefined) {
    lines.push(`    <lastUpdated>${encodeEntities(v.lastUpdated)}</lastUpdated>`);
  }
  lines.push("  </versioning>");
  lines.push("</metadata>");
  return lines.join("\n") + "\n";
}

/**
 * Compose snapshot version-level metadata XML.
 */
export function composeSnapshotMetadata(md: MavenSnapshotMetadata): string {
  const v = md.versioning;
  const lines: string[] = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push("<metadata>");
  lines.push(`  <groupId>${encodeEntities(md.groupId)}</groupId>`);
  lines.push(`  <artifactId>${encodeEntities(md.artifactId)}</artifactId>`);
  lines.push(`  <version>${encodeEntities(md.version)}</version>`);
  lines.push("  <versioning>");
  lines.push("    <snapshot>");
  lines.push(`      <timestamp>${encodeEntities(v.snapshot.timestamp)}</timestamp>`);
  lines.push(`      <buildNumber>${v.snapshot.buildNumber}</buildNumber>`);
  lines.push("    </snapshot>");
  if (v.lastUpdated !== undefined) {
    lines.push(`    <lastUpdated>${encodeEntities(v.lastUpdated)}</lastUpdated>`);
  }
  if (v.snapshotVersions && v.snapshotVersions.length > 0) {
    lines.push("    <snapshotVersions>");
    for (const sv of v.snapshotVersions) {
      lines.push("      <snapshotVersion>");
      if (sv.classifier !== undefined) {
        lines.push(`        <classifier>${encodeEntities(sv.classifier)}</classifier>`);
      }
      lines.push(`        <extension>${encodeEntities(sv.extension)}</extension>`);
      lines.push(`        <value>${encodeEntities(sv.value)}</value>`);
      if (sv.updated !== undefined) {
        lines.push(`        <updated>${encodeEntities(sv.updated)}</updated>`);
      }
      lines.push("      </snapshotVersion>");
    }
    lines.push("    </snapshotVersions>");
  }
  lines.push("  </versioning>");
  lines.push("</metadata>");
  return lines.join("\n") + "\n";
}

/**
 * Build artifact-level metadata from a list of known versions.
 * Picks `latest` as the lexicographically-largest version (Maven's
 * default ordering is by upload sequence, but we don't track upload
 * sequence at the storage layer; lex order matches the canonical
 * `<versions>` ordering and is what Maven Central uses for its
 * static index files).
 *
 * `release` is the same logic but restricted to non-snapshot versions.
 */
export function deriveArtifactMetadata(
  groupId: string,
  artifactId: string,
  versions: string[],
  lastUpdatedUtc: string,
): MavenArtifactMetadata {
  const sorted = [...versions].sort((a, b) => a.localeCompare(b));
  const releaseVersions = sorted.filter((v) => !v.endsWith("-SNAPSHOT"));
  const md: MavenArtifactMetadata = {
    groupId,
    artifactId,
    versioning: {
      versions: sorted,
      lastUpdated: lastUpdatedUtc,
    },
  };
  if (sorted.length > 0) md.versioning.latest = sorted[sorted.length - 1];
  if (releaseVersions.length > 0) {
    md.versioning.release = releaseVersions[releaseVersions.length - 1];
  }
  return md;
}
