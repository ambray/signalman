/**
 * Npm publish handler (v0.1.1).
 *
 * `PUT /npm/<org>/<package>` — npm's "publish" endpoint. Body is
 * JSON with this shape (an aggregate "packument-on-publish"):
 *
 *   {
 *     "name": "<package>",
 *     "versions": {
 *       "<version>": {
 *         "name", "version", "dependencies", ...
 *       }
 *     },
 *     "_attachments": {
 *       "<package>-<version>.tgz": {
 *         "content_type": "application/octet-stream",
 *         "data": "<base64-encoded-tarball>",
 *         "length": <bytes>
 *       }
 *     }
 *   }
 *
 * Flow:
 *   1. Parse body JSON; pluck the single version from `versions`
 *      and the single attachment from `_attachments`.
 *   2. base64-decode attachment.data → tarball bytes.
 *   3. sha256 the tarball → store as content-addressed blob.
 *   4. Map version metadata into NpmManifestMetadata.
 *   5. Build a manifest with kind='npm', store.
 *   6. Append `action: 'upload'` audit-log entry.
 *
 * Single-version publish: the npm CLI sends one version at a time,
 * even though the packument is aggregate. The publish handler
 * refuses if `versions` has > 1 key (concrete multi-version
 * publish is rare; if needed, operator-side scripts loop).
 *
 * Reuse semantics: re-publishing the same name+version with
 * different bytes is rejected with `manifest_exists`. Matches
 * npm's "publish-once" semantic.
 */

import * as crypto from "node:crypto";
import {
  REGISTRY_ERROR_CODES,
  RegistryError,
  type Manifest,
  type NpmManifestMetadata,
  type Provenance,
  type RegistryStorage,
} from "../types.js";
import type { Router } from "../http/router.js";
import type { SqliteManifestIndex } from "../storage/sqlite-index.js";
import {
  npmManifestName,
  validateNpmOrgName,
  validateNpmPackageName,
} from "./paths.js";

export interface MountNpmPublishOptions {
  storage: RegistryStorage;
  index?: SqliteManifestIndex;
  /** Max binary body size for publish. Default 50 MiB (larger than cargo's 10 MiB; npm packages tend to be bigger). */
  maxPublishBytes?: number;
}

const DEFAULT_MAX_PUBLISH_BYTES = 50 * 1024 * 1024;

interface NpmPublishVersion {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  engines?: Record<string, string>;
  description?: string;
  keywords?: string[];
  homepage?: string;
  license?: string;
  main?: string;
  bin?: string | Record<string, string>;
  dist?: {
    tarball?: string;
    shasum?: string;
    integrity?: string;
  };
}

interface NpmPublishBody {
  name: string;
  versions: Record<string, NpmPublishVersion>;
  _attachments: Record<
    string,
    {
      content_type?: string;
      data: string;
      length?: number;
    }
  >;
  "dist-tags"?: Record<string, string>;
}

/**
 * Parse + validate a publish body. Exposed for unit tests.
 */
export function parseNpmPublishBody(body: Buffer): {
  version: NpmPublishVersion;
  tarball: Buffer;
  attachmentName: string;
} {
  let parsed: NpmPublishBody;
  try {
    parsed = JSON.parse(body.toString("utf-8")) as NpmPublishBody;
  } catch (err) {
    throw new RegistryError(
      REGISTRY_ERROR_CODES.BAD_MANIFEST,
      `npm publish body: not valid JSON: ${(err as Error).message}`,
    );
  }
  if (!parsed.name || typeof parsed.name !== "string") {
    throw new RegistryError(
      REGISTRY_ERROR_CODES.BAD_MANIFEST,
      "npm publish body: top-level `name` required",
    );
  }
  if (!parsed.versions || typeof parsed.versions !== "object") {
    throw new RegistryError(
      REGISTRY_ERROR_CODES.BAD_MANIFEST,
      "npm publish body: `versions` required",
    );
  }
  const versionKeys = Object.keys(parsed.versions);
  if (versionKeys.length !== 1) {
    throw new RegistryError(
      REGISTRY_ERROR_CODES.BAD_MANIFEST,
      `npm publish body: exactly one version expected; got ${versionKeys.length}`,
    );
  }
  const version = parsed.versions[versionKeys[0]];
  if (!version.version || version.version !== versionKeys[0]) {
    throw new RegistryError(
      REGISTRY_ERROR_CODES.BAD_MANIFEST,
      `npm publish body: version key '${versionKeys[0]}' must match versions[].version`,
    );
  }
  if (version.name !== parsed.name) {
    throw new RegistryError(
      REGISTRY_ERROR_CODES.BAD_MANIFEST,
      `npm publish body: versions[].name '${version.name}' must match top-level name '${parsed.name}'`,
    );
  }
  if (!parsed._attachments || typeof parsed._attachments !== "object") {
    throw new RegistryError(
      REGISTRY_ERROR_CODES.BAD_MANIFEST,
      "npm publish body: `_attachments` required",
    );
  }
  const attachmentNames = Object.keys(parsed._attachments);
  if (attachmentNames.length !== 1) {
    throw new RegistryError(
      REGISTRY_ERROR_CODES.BAD_MANIFEST,
      `npm publish body: exactly one _attachments entry expected; got ${attachmentNames.length}`,
    );
  }
  const attachmentName = attachmentNames[0];
  const attachment = parsed._attachments[attachmentName];
  if (!attachment.data || typeof attachment.data !== "string") {
    throw new RegistryError(
      REGISTRY_ERROR_CODES.BAD_MANIFEST,
      `npm publish body: _attachments[${attachmentName}].data required (base64)`,
    );
  }
  let tarball: Buffer;
  try {
    tarball = Buffer.from(attachment.data, "base64");
  } catch (err) {
    throw new RegistryError(
      REGISTRY_ERROR_CODES.BAD_MANIFEST,
      `npm publish body: _attachments[${attachmentName}].data is not valid base64`,
    );
  }
  if (attachment.length !== undefined && attachment.length !== tarball.length) {
    throw new RegistryError(
      REGISTRY_ERROR_CODES.BAD_MANIFEST,
      `npm publish body: attachment length ${attachment.length} mismatches decoded ${tarball.length} bytes`,
    );
  }
  return { version, tarball, attachmentName };
}

/**
 * Translate parsed publish version → stored NpmManifestMetadata.
 * Stripped of the upstream `dist.tarball` URL (we rewrite this on
 * read so it points at our registry).
 */
export function publishVersionToStored(
  v: NpmPublishVersion,
  shasum: string,
  integrity: string,
): NpmManifestMetadata {
  return {
    name: v.name,
    version: v.version,
    integrity,
    shasum,
    ...(v.dependencies ? { dependencies: v.dependencies } : {}),
    ...(v.devDependencies ? { devDependencies: v.devDependencies } : {}),
    ...(v.peerDependencies ? { peerDependencies: v.peerDependencies } : {}),
    ...(v.optionalDependencies ? { optionalDependencies: v.optionalDependencies } : {}),
    ...(v.engines ? { engines: v.engines } : {}),
    ...(v.description !== undefined ? { description: v.description } : {}),
    ...(v.keywords ? { keywords: v.keywords } : {}),
    ...(v.homepage !== undefined ? { homepage: v.homepage } : {}),
    ...(v.license !== undefined ? { license: v.license } : {}),
    ...(v.main !== undefined ? { main: v.main } : {}),
    ...(v.bin !== undefined ? { bin: v.bin } : {}),
  };
}

export function mountNpmPublishRoutes(
  router: Router,
  opts: MountNpmPublishOptions,
): void {
  const storage = opts.storage;
  const index = opts.index;
  const maxPublishBytes = opts.maxPublishBytes ?? DEFAULT_MAX_PUBLISH_BYTES;

  router.put(
    "/npm/:org/:package",
    async (ctx) => {
      validateNpmOrgName(ctx.params.org);
      validateNpmPackageName(ctx.params.package);
      if (!ctx.bodyStream) {
        throw new RegistryError(
          REGISTRY_ERROR_CODES.BAD_MANIFEST,
          "npm publish requires a request body",
        );
      }
      const body = await readBodyStream(ctx.bodyStream, maxPublishBytes);
      const { version, tarball } = parseNpmPublishBody(body);

      // Verify the package name matches the URL
      if (version.name !== ctx.params.package) {
        throw new RegistryError(
          REGISTRY_ERROR_CODES.BAD_MANIFEST,
          `npm publish: body name '${version.name}' does not match URL path '${ctx.params.package}'`,
        );
      }

      // Compute integrity hashes
      const shasum = crypto.createHash("sha1").update(tarball).digest("hex");
      const sha512 = crypto.createHash("sha512").update(tarball).digest("base64");
      const integrity = `sha512-${sha512}`;
      const sha256 = crypto.createHash("sha256").update(tarball).digest("hex");

      // Store blob
      const blobMeta = await storage.putBlob({
        body: tarball,
        contentType: "application/octet-stream",
      });
      if (blobMeta.sha256 !== sha256) {
        throw new RegistryError(
          REGISTRY_ERROR_CODES.BAD_MANIFEST,
          `npm publish: blob driver returned sha256 ${blobMeta.sha256} != computed ${sha256}`,
        );
      }

      const npmMetadata = publishVersionToStored(version, shasum, integrity);
      const manifestName = npmManifestName(ctx.params.org, ctx.params.package);

      const manifest: Manifest = {
        name: manifestName,
        version: version.version,
        mediaType: "application/vnd.signalman.npm-package.v1+json",
        kind: "npm",
        blobs: [
          {
            mediaType: "application/octet-stream",
            sha256,
            size: tarball.length,
            name: `${ctx.params.package}-${version.version}.tgz`,
          },
        ],
        npmMetadata,
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
          throw new RegistryError(
            REGISTRY_ERROR_CODES.MANIFEST_EXISTS,
            `npm package ${ctx.params.package}@${version.version} already published with different content`,
          );
        }
        throw err;
      }

      if (index) {
        index.appendAuditEntry({
          action: "upload",
          entityType: "manifest",
          entityId: `${manifestName}@${version.version}`,
          actor: ctx.auth.tokenPrefix ?? "anonymous",
          detail: {
            kind: "npm",
            tarball_bytes: tarball.length,
            sha256,
            integrity,
            org: ctx.params.org,
          },
        });
      }

      return { status: 201, body: { ok: true, id: `${ctx.params.package}@${version.version}` } };
    },
    { streamBody: true, maxBodyBytes: maxPublishBytes },
  );
}

async function readBodyStream(
  stream: import("node:stream").Readable,
  max: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let received = 0;
  for await (const chunk of stream) {
    const buf = chunk as Buffer;
    received += buf.length;
    if (received > max) {
      throw new RegistryError(
        REGISTRY_ERROR_CODES.BAD_MANIFEST,
        `npm publish body too large: ${received} > ${max} bytes`,
      );
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}
