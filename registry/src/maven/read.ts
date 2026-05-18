/**
 * Maven Repository Layout 2 read handlers.
 *
 * Routes (mounted under `/maven/<org>/` by `mount.ts`):
 *
 *   GET /maven/<org>/<groupPath>/<artifactId>/maven-metadata.xml
 *   GET /maven/<org>/<groupPath>/<artifactId>/maven-metadata.xml.<checksum>
 *   GET /maven/<org>/<groupPath>/<artifactId>/<baseVersion>/maven-metadata.xml
 *   GET /maven/<org>/<groupPath>/<artifactId>/<baseVersion>/<filename>
 *
 * Storage layout:
 *   manifest.name    = 'maven/<org>/<groupId>/<artifactId>'
 *   manifest.version = '<baseVersion>/<filename>'
 *   manifest.kind    = 'maven'
 *   maven_metadata_json carries the per-row projection from
 *   `MavenManifestMetadata`.
 *
 * `maven-metadata.xml` is computed on-demand from the manifest
 * rows — we do NOT store it as a separate blob (operators can ship
 * arbitrary maven-metadata via the publish path; that overrides the
 * computed form). Per-file checksums are computed on-demand from the
 * blob bytes when no operator-supplied checksum row exists.
 */

import * as crypto from "node:crypto";
import type {
  ListedManifest,
  Manifest,
  MavenManifestMetadata,
  RegistryStorage,
} from "../types.js";
import type { Router } from "../http/router.js";
import { validateCargoOrgName } from "../cargo/paths.js";
import { MavenError, asMavenError, writeMavenError } from "./errors.js";
import { MAVEN_ERROR_CODES, MAVEN_MEDIA_TYPES } from "./types.js";
import {
  composeMavenFilename,
  isSnapshotVersion,
  mavenManifestName,
  mavenManifestVersion,
  parseGroupPath,
  parseMavenPath,
} from "./paths.js";
import {
  classifyExtension,
  filenameOfCoveredArtifact,
  splitMultiExtension,
} from "./guards.js";
import {
  composeArtifactMetadata,
  composeSnapshotMetadata,
  deriveArtifactMetadata,
} from "./maven-metadata.js";

export interface MountMavenReadOptions {
  storage: RegistryStorage;
  /**
   * Optional proxy hook for virtual upstream pull-through. When set
   * and the local lookup returns no rows, the read handler calls
   * this hook; on success the proxy populates storage and the read
   * re-runs.
   */
  proxyArtifact?: (
    org: string,
    groupId: string,
    artifactId: string,
    baseVersion: string | null,
    filename: string,
  ) => Promise<boolean>;
  /** Same hook for the `maven-metadata.xml` path. */
  proxyMetadata?: (
    org: string,
    groupId: string,
    artifactId: string,
    baseVersion: string | null,
  ) => Promise<boolean>;
}

export function mountMavenReadRoutes(
  router: Router,
  opts: MountMavenReadOptions,
): void {
  const storage = opts.storage;

  // Single catch-all route for the full Maven path surface. Maven
  // paths are deeply nested (groupPath has variable depth), and the
  // existing router's static `/foo/:org/...` patterns can't express
  // "consume everything under :org" cleanly. We mount one greedy
  // route and dispatch internally based on the path suffix.
  router.get(
    "/maven/:org/*rest",
    async (ctx) => {
      const res = ctx.res!;
      try {
        validateCargoOrgName(ctx.params.org);
        const rest = ctx.params.rest;
        await dispatchGet(rest, ctx.params.org, storage, opts, res);
      } catch (err) {
        writeMavenError(res, asMavenError(err));
      }
    },
    { rawResponse: true },
  );
}

async function dispatchGet(
  rest: string,
  org: string,
  storage: RegistryStorage,
  opts: MountMavenReadOptions,
  res: import("node:http").ServerResponse,
): Promise<void> {
  // Three shapes to recognise, in priority order:
  //   1. `<groupPath>/<artifactId>/maven-metadata.xml[.<checksum>]`
  //   2. `<groupPath>/<artifactId>/<baseVersion>/maven-metadata.xml[.<checksum>]`
  //   3. `<groupPath>/<artifactId>/<baseVersion>/<filename>`

  if (rest.endsWith("/maven-metadata.xml")) {
    await serveMetadata(rest, org, storage, opts, res, null);
    return;
  }
  const metaChecksum = matchMetadataChecksumSuffix(rest);
  if (metaChecksum) {
    await serveMetadata(metaChecksum.rest, org, storage, opts, res, metaChecksum.suffix);
    return;
  }
  // Otherwise: parse as artifact path.
  await serveArtifact(rest, org, storage, opts, res);
}

const METADATA_CHECKSUM_SUFFIXES = ["sha1", "md5", "sha256", "sha512"] as const;

function matchMetadataChecksumSuffix(rest: string): { rest: string; suffix: string } | null {
  for (const suffix of METADATA_CHECKSUM_SUFFIXES) {
    const needle = `/maven-metadata.xml.${suffix}`;
    if (rest.endsWith(needle)) {
      return {
        rest: rest.slice(0, rest.length - `.${suffix}`.length),
        suffix,
      };
    }
  }
  return null;
}

async function serveMetadata(
  rest: string,
  org: string,
  storage: RegistryStorage,
  opts: MountMavenReadOptions,
  res: import("node:http").ServerResponse,
  checksumSuffix: string | null,
): Promise<void> {
  // Strip `/maven-metadata.xml`.
  const head = rest.slice(0, rest.length - "/maven-metadata.xml".length);
  const segments = head.split("/");
  if (segments.length < 2) {
    throw new MavenError(
      MAVEN_ERROR_CODES.METADATA_NOT_FOUND,
      `maven-metadata.xml path '${rest}' is too short`,
    );
  }
  const last = segments[segments.length - 1];
  // Detect snapshot-level metadata: the trailing segment is a
  // version-shaped string (`-SNAPSHOT` ending OR pure release) AND
  // appears under an existing artifactId+groupPath. We approximate
  // by trying snapshot-level first when the last segment matches a
  // version-pattern (digit-led with at least one separator) AND
  // ends with `-SNAPSHOT`.
  let baseVersion: string | null = null;
  let groupId: string;
  let artifactId: string;
  if (last.endsWith("-SNAPSHOT") && segments.length >= 3) {
    baseVersion = last;
    artifactId = segments[segments.length - 2];
    groupId = parseGroupPath(segments.slice(0, segments.length - 2).join("/"));
  } else {
    artifactId = last;
    groupId = parseGroupPath(segments.slice(0, segments.length - 1).join("/"));
  }
  // Try to compose the requested XML from storage.
  const storageName = mavenManifestName(org, groupId, artifactId);
  let xml: string | null = null;

  if (baseVersion) {
    xml = await composeSnapshotMetadataForBaseVersion(storage, storageName, groupId, artifactId, baseVersion);
  } else {
    xml = await composeArtifactMetadataForName(storage, storageName, groupId, artifactId);
  }

  // Cache miss → proxy fallback when wired.
  if (!xml && opts.proxyMetadata) {
    const ok = await opts.proxyMetadata(org, groupId, artifactId, baseVersion);
    if (ok) {
      xml = baseVersion
        ? await composeSnapshotMetadataForBaseVersion(storage, storageName, groupId, artifactId, baseVersion)
        : await composeArtifactMetadataForName(storage, storageName, groupId, artifactId);
    }
  }

  if (!xml) {
    throw new MavenError(
      MAVEN_ERROR_CODES.METADATA_NOT_FOUND,
      `no maven-metadata for ${groupId}:${artifactId}${baseVersion ? `:${baseVersion}` : ""}`,
    );
  }

  if (checksumSuffix) {
    const algorithm = checksumSuffix === "md5" ? "md5" : checksumSuffix; // sha1/sha256/sha512/md5
    const digest = crypto.createHash(algorithm).update(xml, "utf-8").digest("hex");
    writePlainTextChecksum(res, digest);
    return;
  }

  res.statusCode = 200;
  res.setHeader("content-type", `${MAVEN_MEDIA_TYPES.XML}; charset=utf-8`);
  res.setHeader("content-length", Buffer.byteLength(xml, "utf-8").toString());
  res.end(xml);
}

async function composeArtifactMetadataForName(
  storage: RegistryStorage,
  storageName: string,
  groupId: string,
  artifactId: string,
): Promise<string | null> {
  const rows = await storage.listManifestVersions(storageName);
  if (rows.length === 0) return null;
  // Pull unique baseVersions from the row keys (`<baseVersion>/<filename>`).
  const baseVersions = new Set<string>();
  let lastUpdated = "";
  for (const r of rows) {
    const slash = r.version.indexOf("/");
    if (slash <= 0) continue;
    baseVersions.add(r.version.slice(0, slash));
    if (r.createdAt > lastUpdated) lastUpdated = r.createdAt;
  }
  if (baseVersions.size === 0) return null;
  // Convert ISO-8601 lastUpdated into Maven's yyyyMMddHHmmss form
  // — Maven Central uses that compact form.
  const lastUpdatedMaven = isoToMavenTimestamp(lastUpdated);
  const md = deriveArtifactMetadata(
    groupId,
    artifactId,
    Array.from(baseVersions),
    lastUpdatedMaven,
  );
  return composeArtifactMetadata(md);
}

async function composeSnapshotMetadataForBaseVersion(
  storage: RegistryStorage,
  storageName: string,
  groupId: string,
  artifactId: string,
  baseVersion: string,
): Promise<string | null> {
  if (!isSnapshotVersion(baseVersion)) {
    // Non-snapshot version-level metadata is rarely served; Maven
    // Central serves it as a tombstone with empty versioning. We
    // return null and let the caller 404.
    return null;
  }
  const rows = await storage.listManifestVersions(storageName);
  // Filter to rows under this baseVersion.
  const versionPrefix = `${baseVersion}/`;
  const inScope = rows.filter((r) => r.version.startsWith(versionPrefix));
  if (inScope.length === 0) return null;
  // Walk the metadata to find the highest resolved snapshot
  // (timestamp + buildNumber) and the per-extension snapshotVersions
  // list. We need the maven_metadata_json projection — load each row.
  let bestTimestamp = "";
  let bestBuildNumber = 0;
  let lastUpdated = "";
  const snapshotVersions: Map<string, {
    classifier?: string;
    extension: string;
    value: string;
    updated?: string;
  }> = new Map();
  for (const r of inScope) {
    const manifest = await storage.getManifest(r.name, r.version);
    if (!manifest || !manifest.mavenMetadata) continue;
    const m = manifest.mavenMetadata;
    if (r.createdAt > lastUpdated) lastUpdated = r.createdAt;
    if (m.snapshot) {
      if (
        m.snapshot.timestamp > bestTimestamp ||
        (m.snapshot.timestamp === bestTimestamp &&
          m.snapshot.buildNumber > bestBuildNumber)
      ) {
        bestTimestamp = m.snapshot.timestamp;
        bestBuildNumber = m.snapshot.buildNumber;
      }
    }
    // snapshotVersions: distinct entries per (classifier, extension).
    // We exclude checksum + signature rows from the list (Maven
    // doesn't emit those in <snapshotVersion>).
    const role = classifyExtension(m.extension);
    if (role !== "primary") continue;
    const key = `${m.classifier ?? ""}|${m.extension}`;
    const updated = isoToMavenTimestamp(r.createdAt);
    snapshotVersions.set(key, {
      ...(m.classifier ? { classifier: m.classifier } : {}),
      extension: m.extension,
      value: m.version,
      updated,
    });
  }
  if (bestTimestamp.length === 0) {
    // No resolved-snapshot row; serve plain skeleton metadata so
    // Maven doesn't 404 on a known baseVersion that only has
    // non-resolved snapshots staged.
    const md = {
      groupId,
      artifactId,
      version: baseVersion,
      versioning: {
        snapshot: { timestamp: "", buildNumber: 0 },
        ...(lastUpdated ? { lastUpdated: isoToMavenTimestamp(lastUpdated) } : {}),
      },
    };
    return composeSnapshotMetadata(md);
  }
  return composeSnapshotMetadata({
    groupId,
    artifactId,
    version: baseVersion,
    versioning: {
      snapshot: { timestamp: bestTimestamp, buildNumber: bestBuildNumber },
      lastUpdated: isoToMavenTimestamp(lastUpdated),
      snapshotVersions: Array.from(snapshotVersions.values()),
    },
  });
}

async function serveArtifact(
  rest: string,
  org: string,
  storage: RegistryStorage,
  opts: MountMavenReadOptions,
  res: import("node:http").ServerResponse,
): Promise<void> {
  // Parse the path; throws on coordinate-validation failures.
  const coord = parseMavenPath(rest);
  if (!coord) {
    throw new MavenError(
      MAVEN_ERROR_CODES.COORDINATE_INVALID,
      `path '${rest}' does not match Maven layout`,
    );
  }
  const storageName = mavenManifestName(org, coord.groupId, coord.artifactId);
  const filename = composeMavenFilename(coord);
  let manifest = await storage.getManifest(
    storageName,
    mavenManifestVersion(coord.baseVersion, filename),
  );

  // Cache miss → proxy fallback.
  if (!manifest && opts.proxyArtifact) {
    const ok = await opts.proxyArtifact(
      org,
      coord.groupId,
      coord.artifactId,
      coord.baseVersion,
      filename,
    );
    if (ok) {
      manifest = await storage.getManifest(
        storageName,
        mavenManifestVersion(coord.baseVersion, filename),
      );
    }
  }

  // Checksum + signature fallback: when the row doesn't exist but a
  // matching primary artifact row does, we can compute the checksum
  // on-demand. Signatures (`.asc`) we never compute — those must be
  // operator-supplied.
  const role = classifyExtension(coord.extension);
  if (!manifest && role === "checksum") {
    await serveComputedChecksum(storage, storageName, coord.baseVersion, filename, res);
    return;
  }

  if (!manifest) {
    throw new MavenError(
      MAVEN_ERROR_CODES.ARTIFACT_NOT_FOUND,
      `artifact ${filename} not found under ${coord.groupId}:${coord.artifactId}:${coord.baseVersion}`,
    );
  }

  if (manifest.blobs.length === 0) {
    throw new MavenError(
      MAVEN_ERROR_CODES.ARTIFACT_NOT_FOUND,
      `artifact ${filename} has no blob`,
    );
  }
  const blobRef = manifest.blobs[0];
  const stat = await storage.statBlob(blobRef.sha256);
  if (!stat) {
    throw new MavenError(
      MAVEN_ERROR_CODES.ARTIFACT_NOT_FOUND,
      `blob sha256:${blobRef.sha256} for ${filename} is missing on disk`,
    );
  }
  res.statusCode = 200;
  res.setHeader(
    "content-type",
    manifest.mavenMetadata?.contentType ?? contentTypeForExtension(coord.extension),
  );
  res.setHeader("content-length", String(stat.size));
  res.setHeader("etag", `"sha256:${blobRef.sha256}"`);
  const stream = await storage.getBlob(blobRef.sha256);
  stream.pipe(res);
  await new Promise<void>((resolve, reject) => {
    stream.on("end", resolve);
    stream.on("error", reject);
    res.on("error", reject);
  });
}

async function serveComputedChecksum(
  storage: RegistryStorage,
  storageName: string,
  baseVersion: string,
  filename: string,
  res: import("node:http").ServerResponse,
): Promise<void> {
  const split = splitMultiExtension(filename.slice(filename.lastIndexOf(".") + 1));
  void split; // unused — kept for symmetry
  const covered = filenameOfCoveredArtifact(filename);
  const suffix = filename.slice(filename.lastIndexOf(".") + 1);
  if (!covered) {
    throw new MavenError(
      MAVEN_ERROR_CODES.ARTIFACT_NOT_FOUND,
      `cannot compute checksum: ${filename} is not a recognised checksum filename`,
    );
  }
  const targetManifest = await storage.getManifest(
    storageName,
    mavenManifestVersion(baseVersion, covered),
  );
  if (!targetManifest || targetManifest.blobs.length === 0) {
    throw new MavenError(
      MAVEN_ERROR_CODES.ARTIFACT_NOT_FOUND,
      `cannot compute checksum: covered artifact ${covered} not found`,
    );
  }
  const sha256 = targetManifest.blobs[0].sha256;
  // For sha256 we have the digest already; otherwise we need to
  // stream the blob and re-hash.
  let digestHex: string;
  if (suffix === "sha256") {
    digestHex = sha256;
  } else {
    const hash = crypto.createHash(suffix);
    const stream = await storage.getBlob(sha256);
    for await (const chunk of stream) {
      hash.update(chunk as Buffer);
    }
    digestHex = hash.digest("hex");
  }
  writePlainTextChecksum(res, digestHex);
}

function writePlainTextChecksum(
  res: import("node:http").ServerResponse,
  digestHex: string,
): void {
  res.statusCode = 200;
  res.setHeader("content-type", `${MAVEN_MEDIA_TYPES.CHECKSUM}; charset=utf-8`);
  res.setHeader("content-length", Buffer.byteLength(digestHex, "utf-8").toString());
  res.end(digestHex);
}

function contentTypeForExtension(extension: string): string {
  if (extension === "jar" || extension === "war" || extension === "ear" || extension === "aar") {
    return MAVEN_MEDIA_TYPES.JAR;
  }
  if (extension === "pom" || extension === "xml" || extension.endsWith(".xml")) {
    return MAVEN_MEDIA_TYPES.XML;
  }
  if (extension === "module") {
    return MAVEN_MEDIA_TYPES.MODULE_JSON;
  }
  if (extension.endsWith(".asc") || extension === "asc") {
    return MAVEN_MEDIA_TYPES.ASC;
  }
  if (
    extension === "sha1" ||
    extension === "md5" ||
    extension === "sha256" ||
    extension === "sha512" ||
    extension.endsWith(".sha1") ||
    extension.endsWith(".md5") ||
    extension.endsWith(".sha256") ||
    extension.endsWith(".sha512")
  ) {
    return MAVEN_MEDIA_TYPES.CHECKSUM;
  }
  return MAVEN_MEDIA_TYPES.OCTET_STREAM;
}

function isoToMavenTimestamp(iso: string): string {
  if (!iso) return "";
  // ISO-8601 like 2026-05-17T19:30:00.000Z → 20260517193000
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(iso);
  if (!m) return iso;
  return `${m[1]}${m[2]}${m[3]}${m[4]}${m[5]}${m[6]}`;
}

void deriveArtifactMetadata; // re-export symbol kept for tests
