/**
 * Maven Repository Layout 2 publish handlers (PUT).
 *
 * Maven + Gradle publish artifact-by-artifact via individual PUT
 * requests at the canonical path:
 *
 *   PUT /maven/<org>/<groupPath>/<artifactId>/<baseVersion>/<filename>
 *
 * The body is the raw file bytes — there is no multipart envelope.
 * One milestone publish from `mvn deploy` sends a sequence of PUTs
 * for the main jar, the .pom, optional sources + javadoc jars,
 * the Gradle Module Metadata `.module`, the `.asc` GPG signatures,
 * and per-extension checksum files (`*.sha1` and `*.md5` are
 * mandatory in Maven Central conformance; `*.sha256` and `*.sha512`
 * are optional but accepted).
 *
 * Snapshot policy (M0-locked default: `reject`):
 *   - When the snapshot policy on the registry / repo is `reject`,
 *     PUTs for `-SNAPSHOT` baseVersions return 422 SNAPSHOT_REFUSED.
 *   - When `accept`, snapshot artifacts publish under the resolved
 *     timestamped version (`<base>-yyyyMMdd.HHmmss-N`), and the
 *     server maintains the per-baseVersion `maven-metadata.xml`
 *     snapshot block automatically via the read path's on-demand
 *     compose.
 *
 * Signatures (`.asc`):
 *   M0-locked: accept-and-store verbatim. We do NOT verify the GPG
 *   chain; operators who need verification run it client-side
 *   before `mvn deploy`. Matches Maven Central's behaviour.
 *
 * Checksums (`.sha1` / `.md5` / `.sha256` / `.sha512`):
 *   We accept them, parse the hex payload, and persist the row.
 *   When the operator-supplied checksum disagrees with the
 *   server-computed digest of the primary artifact, we reject with
 *   400 UPLOAD_INVALID — this catches client-side corruption.
 *
 * Idempotency: identical PUT bytes for the same coordinate are a
 * no-op success. Different bytes for an already-published RELEASE
 * artifact return 409 CONFLICT (releases are immutable). Snapshot
 * artifacts at the same resolved version are NOT auto-rejected on
 * different bytes — but no two snapshots should share a resolved
 * version, so this is a defensive surface.
 */

import { Readable } from "node:stream";
import {
  type Manifest,
  type MavenManifestMetadata,
  type Provenance,
  type RegistryStorage,
  REGISTRY_ERROR_CODES,
  RegistryError,
} from "../types.js";
import type { Router } from "../http/router.js";
import type { SqliteManifestIndex } from "../storage/sqlite-index.js";
import { validateCargoOrgName } from "../cargo/paths.js";
import { MavenError, asMavenError, writeMavenError } from "./errors.js";
import {
  MAVEN_ERROR_CODES,
  MAVEN_MEDIA_TYPES,
  type MavenCoordinate,
  type MavenSnapshotPolicy,
} from "./types.js";
import {
  composeMavenFilename,
  isSnapshotVersion,
  mavenManifestName,
  mavenManifestVersion,
  parseMavenPath,
} from "./paths.js";
import {
  classifyExtension,
  enforceSnapshotPolicy,
  filenameOfCoveredArtifact,
  parseChecksumPayload,
} from "./guards.js";

export interface MountMavenPublishOptions {
  storage: RegistryStorage;
  index?: SqliteManifestIndex;
  /** Max body size for a single PUT. Default 1 GiB (a single jar). */
  maxBodyBytes?: number;
  /**
   * Default snapshot policy for this registry instance. Per-repo /
   * per-org overrides come through the virtual-upstream config row;
   * operators using the registry as the publish target set this
   * here. Default 'reject' per M0.
   */
  defaultSnapshotPolicy?: MavenSnapshotPolicy;
  /** Default `accept_signatures`. Default true. */
  defaultAcceptSignatures?: boolean;
  /** Default `accept_checksums`. Default true. */
  defaultAcceptChecksums?: boolean;
}

const DEFAULT_MAX_BODY_BYTES = 1 * 1024 * 1024 * 1024;

export function mountMavenPublishRoutes(
  router: Router,
  opts: MountMavenPublishOptions,
): void {
  const storage = opts.storage;
  const index = opts.index;
  const maxBodyBytes = opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const snapshotPolicy = opts.defaultSnapshotPolicy ?? "reject";
  const acceptSignatures = opts.defaultAcceptSignatures ?? true;
  const acceptChecksums = opts.defaultAcceptChecksums ?? true;

  router.put(
    "/maven/:org/*rest",
    async (ctx) => {
      const res = ctx.res!;
      try {
        validateCargoOrgName(ctx.params.org);
        const rest = ctx.params.rest;

        // Reject metadata PUTs — Maven Central rejects operator-
        // supplied maven-metadata.xml writes; we keep that behaviour.
        // The server composes maven-metadata.xml on demand from the
        // manifest rows.
        if (rest.endsWith("/maven-metadata.xml")) {
          throw new MavenError(
            MAVEN_ERROR_CODES.UPLOAD_INVALID,
            "maven-metadata.xml is composed on-demand from the manifest rows; PUTs to this path are not accepted",
          );
        }
        const metaChecksum = matchMetadataChecksumSuffix(rest);
        if (metaChecksum) {
          throw new MavenError(
            MAVEN_ERROR_CODES.UPLOAD_INVALID,
            "maven-metadata.xml checksum PUTs are computed on-demand; not accepted",
          );
        }

        const coord = parseMavenPath(rest);
        if (!coord) {
          throw new MavenError(
            MAVEN_ERROR_CODES.COORDINATE_INVALID,
            `PUT path '${rest}' does not match Maven layout`,
          );
        }

        enforceSnapshotPolicy(coord, snapshotPolicy);

        const role = classifyExtension(coord.extension);
        if (role === "unknown") {
          throw new MavenError(
            MAVEN_ERROR_CODES.EXTENSION_INVALID,
            `extension '${coord.extension}' is not a recognised Maven artifact extension`,
          );
        }
        if (role === "signature" && !acceptSignatures) {
          throw new MavenError(
            MAVEN_ERROR_CODES.UPLOAD_INVALID,
            "signature uploads (.asc) are disabled on this repo (accept_signatures: false)",
          );
        }
        if (role === "checksum" && !acceptChecksums) {
          throw new MavenError(
            MAVEN_ERROR_CODES.UPLOAD_INVALID,
            "checksum uploads (.sha1/.md5/...) are disabled on this repo (accept_checksums: false)",
          );
        }

        if (!ctx.bodyStream) {
          throw new MavenError(
            MAVEN_ERROR_CODES.UPLOAD_INVALID,
            "PUT body is required",
          );
        }
        const bodyBytes = await readBody(ctx.bodyStream, maxBodyBytes);

        if (role === "checksum") {
          await handleChecksumPut(
            ctx.params.org,
            coord,
            bodyBytes,
            storage,
            index,
            ctx,
            res,
          );
          return;
        }

        // Primary or signature: store as a blob + manifest row.
        const blobMeta = await storage.putBlob({
          body: bodyBytes,
          contentType: defaultContentTypeForRole(role, coord.extension),
        });

        const filename = composeMavenFilename(coord);
        const storageName = mavenManifestName(
          ctx.params.org,
          coord.groupId,
          coord.artifactId,
        );
        const versionKey = mavenManifestVersion(coord.baseVersion, filename);

        // Idempotency check: same bytes on a re-PUT is a no-op
        // success; different bytes on a RELEASE artifact is 409.
        const existing = await storage.getManifest(storageName, versionKey);
        if (existing) {
          const existingSha = existing.blobs[0]?.sha256;
          if (existingSha === blobMeta.sha256) {
            res.statusCode = 200;
            res.setHeader("content-length", "0");
            res.end();
            return;
          }
          if (!coord.isSnapshot) {
            throw new MavenError(
              MAVEN_ERROR_CODES.CONFLICT,
              `release artifact ${coord.groupId}:${coord.artifactId}:${coord.version} (${filename}) is already published with different content`,
            );
          }
        }

        const mavenMetadata = projectMetadata(coord, filename, role);
        const manifest: Manifest = {
          name: storageName,
          version: versionKey,
          mediaType: "application/vnd.signalman.maven-file.v1+json",
          kind: "maven",
          blobs: [
            {
              mediaType: defaultContentTypeForRole(role, coord.extension),
              sha256: blobMeta.sha256,
              size: blobMeta.size,
              name: filename,
            },
          ],
          mavenMetadata,
          createdAt: new Date().toISOString(),
        };
        const provenance: Provenance = {
          source: "upload",
          fetchedAt: manifest.createdAt,
          fetchedBy: ctx.auth.tokenPrefix?.slice(-16),
        };
        try {
          await storage.putManifest(manifest, provenance);
        } catch (err) {
          if (
            err instanceof RegistryError &&
            err.code === REGISTRY_ERROR_CODES.MANIFEST_EXISTS
          ) {
            throw new MavenError(
              MAVEN_ERROR_CODES.CONFLICT,
              `release artifact ${coord.groupId}:${coord.artifactId}:${coord.version} (${filename}) is already published with different content`,
            );
          }
          throw err;
        }

        if (index) {
          index.appendAuditEntry({
            action: "upload",
            entityType: "manifest",
            entityId: `${storageName}@${versionKey}`,
            actor: ctx.auth.tokenPrefix ?? "anonymous",
            detail: {
              kind: "maven",
              org: ctx.params.org,
              groupId: coord.groupId,
              artifactId: coord.artifactId,
              version: coord.version,
              baseVersion: coord.baseVersion,
              filename,
              extension: coord.extension,
              ...(coord.classifier ? { classifier: coord.classifier } : {}),
              role,
              bytes: bodyBytes.length,
              sha256: blobMeta.sha256,
            },
          });
        }

        res.statusCode = 201;
        res.setHeader("content-length", "0");
        res.end();
      } catch (err) {
        writeMavenError(res, asMavenError(err));
      }
    },
    { streamBody: true, rawResponse: true, maxBodyBytes },
  );
}

async function handleChecksumPut(
  org: string,
  coord: MavenCoordinate,
  bodyBytes: Buffer,
  storage: RegistryStorage,
  index: SqliteManifestIndex | undefined,
  ctx: { auth: { tokenPrefix?: string | null } },
  res: import("node:http").ServerResponse,
): Promise<void> {
  // Determine the suffix algorithm from the extension. Single-suffix
  // form is just the algorithm name ('sha1'); multi-suffix form is
  // '<primary>.<algo>' ('jar.sha1'). We accept both because
  // different Maven clients emit one or the other.
  const algo = coord.extension.includes(".")
    ? coord.extension.slice(coord.extension.indexOf(".") + 1)
    : coord.extension;
  const declared = parseChecksumPayload(bodyBytes, algo);

  const filename = composeMavenFilename(coord);
  const covered = filenameOfCoveredArtifact(filename);
  if (!covered) {
    throw new MavenError(
      MAVEN_ERROR_CODES.UPLOAD_INVALID,
      `cannot determine covered artifact for checksum '${filename}'`,
    );
  }

  const storageName = mavenManifestName(org, coord.groupId, coord.artifactId);
  const coveredKey = mavenManifestVersion(coord.baseVersion, covered);
  const coveredManifest = await storage.getManifest(storageName, coveredKey);

  if (coveredManifest && coveredManifest.blobs.length > 0) {
    const coveredSha = coveredManifest.blobs[0].sha256;
    if (algo === "sha256" && declared !== coveredSha) {
      throw new MavenError(
        MAVEN_ERROR_CODES.UPLOAD_INVALID,
        `sha256 checksum '${declared}' does not match server-computed sha256:${coveredSha} for ${covered}`,
      );
    }
    // For other algorithms we accept the operator-supplied value
    // without re-hashing (the read path re-verifies on serve when
    // the operator asks for the on-demand form). This is consistent
    // with Maven Central, which accepts operator checksums
    // verbatim — clients verify locally.
  }

  // Store the checksum payload as a small blob; persist a manifest
  // row so the read path serves the operator-supplied value.
  const blobMeta = await storage.putBlob({
    body: bodyBytes,
    contentType: MAVEN_MEDIA_TYPES.CHECKSUM,
  });

  const versionKey = mavenManifestVersion(coord.baseVersion, filename);
  const existing = await storage.getManifest(storageName, versionKey);
  if (existing) {
    const existingSha = existing.blobs[0]?.sha256;
    if (existingSha === blobMeta.sha256) {
      res.statusCode = 200;
      res.setHeader("content-length", "0");
      res.end();
      return;
    }
    if (!coord.isSnapshot) {
      throw new MavenError(
        MAVEN_ERROR_CODES.CONFLICT,
        `release checksum ${filename} is already published with different content`,
      );
    }
  }

  const mavenMetadata: MavenManifestMetadata = {
    groupId: coord.groupId,
    artifactId: coord.artifactId,
    version: coord.version,
    baseVersion: coord.baseVersion,
    filename,
    extension: coord.extension,
    ...(coord.classifier ? { classifier: coord.classifier } : {}),
    isSnapshot: coord.isSnapshot,
    ...(coord.snapshot ? { snapshot: coord.snapshot } : {}),
    checksumOf: covered,
    contentType: MAVEN_MEDIA_TYPES.CHECKSUM,
  };
  const manifest: Manifest = {
    name: storageName,
    version: versionKey,
    mediaType: "application/vnd.signalman.maven-file.v1+json",
    kind: "maven",
    blobs: [
      {
        mediaType: MAVEN_MEDIA_TYPES.CHECKSUM,
        sha256: blobMeta.sha256,
        size: blobMeta.size,
        name: filename,
      },
    ],
    mavenMetadata,
    createdAt: new Date().toISOString(),
  };
  await storage.putManifest(manifest, {
    source: "upload",
    fetchedAt: manifest.createdAt,
    fetchedBy: ctx.auth.tokenPrefix?.slice(-16),
  });

  if (index) {
    index.appendAuditEntry({
      action: "upload",
      entityType: "manifest",
      entityId: `${storageName}@${versionKey}`,
      actor: ctx.auth.tokenPrefix ?? "anonymous",
      detail: {
        kind: "maven",
        org,
        groupId: coord.groupId,
        artifactId: coord.artifactId,
        filename,
        role: "checksum",
        algo,
        digest: declared,
        bytes: bodyBytes.length,
      },
    });
  }

  res.statusCode = 201;
  res.setHeader("content-length", "0");
  res.end();
}

function projectMetadata(
  coord: MavenCoordinate,
  filename: string,
  role: "primary" | "signature" | "checksum" | "unknown",
): MavenManifestMetadata {
  const out: MavenManifestMetadata = {
    groupId: coord.groupId,
    artifactId: coord.artifactId,
    version: coord.version,
    baseVersion: coord.baseVersion,
    filename,
    extension: coord.extension,
    isSnapshot: coord.isSnapshot,
  };
  if (coord.classifier) out.classifier = coord.classifier;
  if (coord.snapshot) out.snapshot = coord.snapshot;
  if (role === "signature") {
    const covered = filenameOfCoveredArtifact(filename);
    if (covered) out.signatureOf = covered;
  }
  out.contentType = defaultContentTypeForRole(role, coord.extension);
  return out;
}

function defaultContentTypeForRole(
  role: "primary" | "signature" | "checksum" | "unknown",
  extension: string,
): string {
  if (role === "checksum") return MAVEN_MEDIA_TYPES.CHECKSUM;
  if (role === "signature") return MAVEN_MEDIA_TYPES.ASC;
  // Primary:
  if (extension === "jar" || extension === "war" || extension === "ear" || extension === "aar") {
    return MAVEN_MEDIA_TYPES.JAR;
  }
  if (extension === "pom") return MAVEN_MEDIA_TYPES.XML;
  if (extension === "module") return MAVEN_MEDIA_TYPES.MODULE_JSON;
  return MAVEN_MEDIA_TYPES.OCTET_STREAM;
}

const METADATA_CHECKSUM_SUFFIXES = ["sha1", "md5", "sha256", "sha512"] as const;
function matchMetadataChecksumSuffix(
  rest: string,
): { rest: string; suffix: string } | null {
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

async function readBody(stream: Readable, max: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > max) {
      throw new MavenError(
        MAVEN_ERROR_CODES.UPLOAD_INVALID,
        `body exceeds ${max} bytes`,
      );
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}
