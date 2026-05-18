/**
 * NuGet v3 package-publish endpoint.
 *
 * `dotnet nuget push` emits:
 *
 *   PUT /<publish-resource-url>
 *   Content-Type: multipart/form-data; boundary=<boundary>
 *   X-NuGet-ApiKey: <api-key>
 *   Body: a single multipart part with the .nupkg bytes.
 *
 * (The publish protocol historically uses PUT; some clients also
 * accept POST. We mount PUT to match the canonical NuGet Gallery
 * shape. Modern dotnet always uses PUT.)
 *
 * Flow:
 *   1. Read body (capped at maxBodyBytes; default 1 GiB).
 *   2. Parse multipart with the existing PyPI multipart reader
 *      (a single binary part, no metadata fields).
 *   3. Extract the nuspec from the nupkg bytes; validate via parseNuspec.
 *   4. Compute the SemVer-2 base64 SHA-512 of the nupkg bytes
 *      (NuGet's `packageHash`).
 *   5. Idempotent putBlob.
 *   6. Build a Manifest with kind='nuget', version=<lower-version>,
 *      blobs=[nupkg], nugetMetadata=<projected metadata>.
 *   7. putManifest. MANIFEST_EXISTS-different-content surfaces as 409.
 *   8. Audit-log action='upload', entity_type='manifest'.
 *
 * Auth: relies on the standard `Authorization: Bearer sk_...` shape.
 * The `X-NuGet-ApiKey` header is accepted in addition (dotnet sends
 * it by convention) — when present, it maps to the same authenticator
 * the rest of the routes use. The bootstrap server's `makeAuthenticator`
 * inspects the canonical Authorization header; an operator who wants
 * to drive publish with `dotnet nuget push --api-key sk_...` can use
 * the `--source-username __token__ --source-password sk_...` form.
 */

import * as crypto from "node:crypto";
import { Readable } from "node:stream";
import {
  type Manifest,
  type NugetManifestMetadata,
  type Provenance,
  type RegistryStorage,
  REGISTRY_ERROR_CODES,
  RegistryError,
} from "../types.js";
import type { Router } from "../http/router.js";
import type { SqliteManifestIndex } from "../storage/sqlite-index.js";
import { validateCargoOrgName } from "../cargo/paths.js";
import { extractBoundary, parseMultipart } from "../pypi/multipart.js";
import { NugetError, asNugetError, writeNugetError } from "./errors.js";
import { NUGET_ERROR_CODES, NUGET_MEDIA_TYPES } from "./types.js";
import {
  normalisePackageId,
  nugetManifestName,
  nugetManifestVersion,
  validateNugetPackageId,
  validateNugetVersion,
} from "./paths.js";
import { extractNuspecFromNupkg, parseNuspec } from "./guards.js";

export interface MountNugetPublishOptions {
  storage: RegistryStorage;
  index?: SqliteManifestIndex;
  /** Max body size for a single push. Default 1 GiB. */
  maxBodyBytes?: number;
}

const DEFAULT_MAX_BODY_BYTES = 1 * 1024 * 1024 * 1024;

export function mountNugetPublishRoutes(
  router: Router,
  opts: MountNugetPublishOptions,
): void {
  const storage = opts.storage;
  const index = opts.index;
  const maxBodyBytes = opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;

  const handler = async (
    ctx: import("../http/router.js").RequestContext,
  ): Promise<void> => {
    const res = ctx.res!;
    try {
      validateCargoOrgName(ctx.params.org);
      if (!ctx.bodyStream) {
        throw new NugetError(
          NUGET_ERROR_CODES.UPLOAD_INVALID,
          "publish requires a request body",
        );
      }
      const bodyBytes = await readBody(ctx.bodyStream, maxBodyBytes);

      // Pull the nupkg bytes out of the body. dotnet sends multipart;
      // some legacy NuGet servers also accept a bare nupkg in the body.
      // We sniff the Content-Type:
      //   - multipart/form-data → parseMultipart, take the first part with
      //     a non-zero binary body, that's the nupkg.
      //   - application/octet-stream (or anything else) → treat the whole
      //     body as the nupkg.
      const contentType = headerString(ctx.headers["content-type"]) ?? "";
      let nupkgBytes: Buffer;
      if (contentType.toLowerCase().startsWith("multipart/form-data")) {
        const boundary = extractBoundary(contentType);
        if (!boundary) {
          throw new NugetError(
            NUGET_ERROR_CODES.UPLOAD_INVALID,
            `Content-Type declares multipart but lacks a boundary: '${contentType}'`,
          );
        }
        // The PyPI multipart parser throws PypiError on failure; convert
        // to NugetError for consistent envelopes.
        let parsed;
        try {
          parsed = parseMultipart(bodyBytes, boundary);
        } catch (err) {
          throw new NugetError(
            NUGET_ERROR_CODES.UPLOAD_INVALID,
            `multipart parse failed: ${(err as Error).message}`,
          );
        }
        const nupkgField = parsed.fields.find(
          (f) => f.body.length > 0 && (f.filename || f.name === "package"),
        );
        if (!nupkgField) {
          throw new NugetError(
            NUGET_ERROR_CODES.UPLOAD_INVALID,
            "multipart body has no nupkg part (expected one part with name='package' or a filename)",
          );
        }
        nupkgBytes = nupkgField.body;
      } else {
        nupkgBytes = bodyBytes;
      }

      if (nupkgBytes.length === 0) {
        throw new NugetError(
          NUGET_ERROR_CODES.UPLOAD_INVALID,
          "nupkg body is empty",
        );
      }
      // Extract + validate the nuspec; produces the nugetMetadata
      // projection (id, version, dependencies, target frameworks).
      const nuspecBytes = extractNuspecFromNupkg(nupkgBytes);
      const nuspec = parseNuspec(nuspecBytes);

      validateNugetPackageId(nuspec.id);
      validateNugetVersion(nuspec.version);

      const id = normalisePackageId(nuspec.id);
      const version = nugetManifestVersion(nuspec.version);
      const storageName = nugetManifestName(ctx.params.org, id);

      const packageHash = sha512Base64(nupkgBytes);

      const blobMeta = await storage.putBlob({
        body: nupkgBytes,
        contentType: NUGET_MEDIA_TYPES.NUPKG,
      });

      const nugetMetadata: NugetManifestMetadata = {
        id,
        version,
        ...(nuspec.id !== id ? { originalId: nuspec.id } : {}),
        ...(nuspec.version !== version
          ? { originalVersion: nuspec.version }
          : {}),
        ...(nuspec.authors ? { authors: nuspec.authors } : {}),
        ...(nuspec.description ? { description: nuspec.description } : {}),
        ...(nuspec.summary ? { summary: nuspec.summary } : {}),
        ...(nuspec.title ? { title: nuspec.title } : {}),
        ...(nuspec.tags ? { tags: nuspec.tags } : {}),
        ...(nuspec.projectUrl ? { projectUrl: nuspec.projectUrl } : {}),
        ...(nuspec.licenseUrl ? { licenseUrl: nuspec.licenseUrl } : {}),
        ...(nuspec.licenseExpression
          ? { licenseExpression: nuspec.licenseExpression }
          : {}),
        ...(nuspec.iconUrl ? { iconUrl: nuspec.iconUrl } : {}),
        ...(nuspec.requireLicenseAcceptance !== undefined
          ? { requireLicenseAcceptance: nuspec.requireLicenseAcceptance }
          : {}),
        ...(nuspec.dependencyGroups
          ? { dependencyGroups: nuspec.dependencyGroups }
          : {}),
        ...(nuspec.targetFrameworks
          ? { targetFrameworks: nuspec.targetFrameworks }
          : {}),
        packageHash,
        packageHashAlgorithm: "SHA512",
        packageSize: nupkgBytes.length,
        listed: true,
      };

      // Idempotency: if a row already exists at (storageName, version)
      // with identical bytes, treat as no-op success. Different bytes
      // surface as 409 — NuGet versions are immutable, matching
      // nuget.org's contract.
      const existing = await storage.getManifest(storageName, version);
      if (existing) {
        const existingSha = existing.blobs[0]?.sha256;
        if (existingSha === blobMeta.sha256) {
          res.statusCode = 201;
          res.setHeader("content-length", "0");
          res.end();
          return;
        }
        throw new NugetError(
          NUGET_ERROR_CODES.CONFLICT,
          `version ${version} of '${id}' is already published with different content`,
        );
      }

      const now = new Date().toISOString();
      nugetMetadata.published = now;
      const manifest: Manifest = {
        name: storageName,
        version,
        mediaType: "application/vnd.signalman.nuget-package.v1+json",
        kind: "nuget",
        blobs: [
          {
            mediaType: NUGET_MEDIA_TYPES.NUPKG,
            sha256: blobMeta.sha256,
            size: blobMeta.size,
            name: `${id}.${version}.nupkg`,
          },
        ],
        nugetMetadata,
        createdAt: now,
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
          throw new NugetError(
            NUGET_ERROR_CODES.CONFLICT,
            `version ${version} of '${id}' is already published with different content`,
          );
        }
        throw err;
      }

      if (index) {
        index.appendAuditEntry({
          action: "upload",
          entityType: "manifest",
          entityId: `${storageName}@${version}`,
          actor: ctx.auth.tokenPrefix ?? "anonymous",
          detail: {
            kind: "nuget",
            org: ctx.params.org,
            id,
            version,
            bytes: nupkgBytes.length,
            sha256: blobMeta.sha256,
            packageHash,
          },
        });
      }

      res.statusCode = 201;
      res.setHeader("content-length", "0");
      res.end();
    } catch (err) {
      writeNugetError(res, asNugetError(err));
    }
  };

  // NuGet Gallery accepts PUT; some clients (NuGet 2.x) used POST.
  // Wire both to the same handler.
  router.put("/nuget/:org/v3/publish", handler, {
    rawResponse: true,
    streamBody: true,
    maxBodyBytes,
  });
  router.post("/nuget/:org/v3/publish", handler, {
    rawResponse: true,
    streamBody: true,
    maxBodyBytes,
  });
  // Legacy v2 push URL — some clients hardcode this. We accept it as
  // an alias to the v3 endpoint (the body shape is the same multipart).
  router.put("/nuget/:org/api/v2/package", handler, {
    rawResponse: true,
    streamBody: true,
    maxBodyBytes,
  });
  router.post("/nuget/:org/api/v2/package", handler, {
    rawResponse: true,
    streamBody: true,
    maxBodyBytes,
  });
}

function sha512Base64(buf: Buffer): string {
  return crypto.createHash("sha512").update(buf).digest("base64");
}

function headerString(value: unknown): string | undefined {
  if (Array.isArray(value)) return value[0];
  if (typeof value === "string") return value;
  return undefined;
}

async function readBody(stream: Readable, max: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += buf.length;
    if (total > max) {
      throw new NugetError(
        NUGET_ERROR_CODES.UPLOAD_INVALID,
        `body exceeds ${max} bytes`,
      );
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}
