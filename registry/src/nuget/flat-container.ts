/**
 * NuGet v3 flat-container ("package base address") endpoints.
 *
 * Routes (mounted under `/nuget/<org>/` by `mount.ts`):
 *
 *   GET /v3/flat2/<id>/index.json
 *     → { "versions": [<lower-version>, ...] }
 *
 *   GET /v3/flat2/<id>/<version>/<id>.<version>.nupkg
 *     → raw nupkg bytes (application/octet-stream)
 *
 *   GET /v3/flat2/<id>/<version>/<id>.nuspec
 *     → extracted nuspec XML (application/xml)
 *
 * The dotnet client fetches the version-index first (to resolve the
 * client's version-range spec to an exact version), then the nupkg.
 * Some clients also fetch the bare .nuspec directly; we extract it
 * from the stored nupkg on each request (cheap — nuspecs are small).
 *
 * Storage layout (per chunk 1):
 *   manifest.name    = 'nuget/<org>/<lower-id>'
 *   manifest.version = '<lower-version>'
 *   manifest.kind    = 'nuget'
 *   nuget_metadata_json carries the per-row NugetManifestMetadata.
 */

import type { Router } from "../http/router.js";
import type { RegistryStorage } from "../types.js";
import { validateCargoOrgName } from "../cargo/paths.js";
import { NugetError, asNugetError, writeNugetError } from "./errors.js";
import {
  NUGET_ERROR_CODES,
  NUGET_MEDIA_TYPES,
  type NugetFlatContainerVersionIndex,
} from "./types.js";
import {
  normalisePackageId,
  normaliseVersion,
  nugetManifestName,
  nugetManifestVersion,
  validateNugetPackageId,
  validateNugetVersion,
} from "./paths.js";
import { extractNuspecFromNupkg } from "./guards.js";

export interface MountNugetFlatContainerOptions {
  storage: RegistryStorage;
  /**
   * Optional pull-through hook called on a flat-container miss
   * (either the version index or a per-version blob). Returns true
   * when the cache was populated; the read handler then re-queries
   * storage to serve the cached row.
   */
  proxyNupkg?: (
    org: string,
    id: string,
    version: string,
  ) => Promise<boolean>;
  proxyVersionIndex?: (org: string, id: string) => Promise<boolean>;
}

export function mountNugetFlatContainerRoutes(
  router: Router,
  opts: MountNugetFlatContainerOptions,
): void {
  const storage = opts.storage;

  // ── Version index ────────────────────────────────────────────
  router.get(
    "/nuget/:org/v3/flat2/:id/index.json",
    async (ctx) => {
      const res = ctx.res!;
      try {
        validateCargoOrgName(ctx.params.org);
        validateNugetPackageId(ctx.params.id);
        const org = ctx.params.org;
        const id = normalisePackageId(ctx.params.id);

        let versions = await listVersions(storage, org, id);
        if (versions.length === 0 && opts.proxyVersionIndex) {
          const ok = await opts.proxyVersionIndex(org, id);
          if (ok) versions = await listVersions(storage, org, id);
        }
        if (versions.length === 0) {
          throw new NugetError(
            NUGET_ERROR_CODES.PACKAGE_NOT_FOUND,
            `no versions for package '${id}' under org '${org}'`,
          );
        }
        const body: NugetFlatContainerVersionIndex = { versions };
        const json = JSON.stringify(body);
        res.statusCode = 200;
        res.setHeader(
          "content-type",
          `${NUGET_MEDIA_TYPES.JSON}; charset=utf-8`,
        );
        res.setHeader("content-length", Buffer.byteLength(json).toString());
        res.end(json);
      } catch (err) {
        writeNugetError(res, asNugetError(err));
      }
    },
    { rawResponse: true },
  );

  // ── Nupkg + nuspec ───────────────────────────────────────────
  router.get(
    "/nuget/:org/v3/flat2/:id/:version/:filename",
    async (ctx) => {
      const res = ctx.res!;
      try {
        validateCargoOrgName(ctx.params.org);
        validateNugetPackageId(ctx.params.id);
        validateNugetVersion(ctx.params.version);
        const org = ctx.params.org;
        const id = normalisePackageId(ctx.params.id);
        const version = normaliseVersion(ctx.params.version);
        const filename = ctx.params.filename;
        const expectedNupkg = `${id}.${version}.nupkg`;
        const expectedNuspec = `${id}.nuspec`;
        if (filename !== expectedNupkg && filename !== expectedNuspec) {
          throw new NugetError(
            NUGET_ERROR_CODES.RESOURCE_NOT_FOUND,
            `flat-container filename '${filename}' does not match '${expectedNupkg}' or '${expectedNuspec}'`,
          );
        }

        let manifest = await storage.getManifest(
          nugetManifestName(org, id),
          nugetManifestVersion(version),
        );
        if (!manifest && opts.proxyNupkg) {
          const ok = await opts.proxyNupkg(org, id, version);
          if (ok) {
            manifest = await storage.getManifest(
              nugetManifestName(org, id),
              nugetManifestVersion(version),
            );
          }
        }
        if (!manifest) {
          throw new NugetError(
            NUGET_ERROR_CODES.VERSION_NOT_FOUND,
            `version ${version} of '${id}' not found under org '${org}'`,
          );
        }
        if (manifest.blobs.length === 0) {
          throw new NugetError(
            NUGET_ERROR_CODES.VERSION_NOT_FOUND,
            `${id}@${version} has no blob`,
          );
        }
        const blobRef = manifest.blobs[0];
        const stat = await storage.statBlob(blobRef.sha256);
        if (!stat) {
          throw new NugetError(
            NUGET_ERROR_CODES.VERSION_NOT_FOUND,
            `blob sha256:${blobRef.sha256} for ${id}@${version} missing on disk`,
          );
        }

        if (filename === expectedNupkg) {
          res.statusCode = 200;
          res.setHeader("content-type", NUGET_MEDIA_TYPES.NUPKG);
          res.setHeader("content-length", String(stat.size));
          res.setHeader("etag", `"sha256:${blobRef.sha256}"`);
          const stream = await storage.getBlob(blobRef.sha256);
          stream.pipe(res);
          await new Promise<void>((resolve, reject) => {
            stream.on("end", resolve);
            stream.on("error", reject);
            res.on("error", reject);
          });
          return;
        }

        // Nuspec: extract from the stored nupkg bytes on demand.
        const nupkgBytes = await readBlobBytes(storage, blobRef.sha256, stat.size);
        const nuspec = extractNuspecFromNupkg(nupkgBytes);
        res.statusCode = 200;
        res.setHeader(
          "content-type",
          `${NUGET_MEDIA_TYPES.NUSPEC}; charset=utf-8`,
        );
        res.setHeader("content-length", String(nuspec.length));
        res.end(nuspec);
      } catch (err) {
        writeNugetError(res, asNugetError(err));
      }
    },
    { rawResponse: true },
  );
}

async function listVersions(
  storage: RegistryStorage,
  org: string,
  id: string,
): Promise<string[]> {
  const name = nugetManifestName(org, id);
  const rows = await storage.listManifestVersions(name);
  // listManifestVersions returns rows newest-first; the NuGet
  // contract for the version-index orders ascending by semver. We
  // sort here lexicographically on the normalised version — adequate
  // for the common case (release versions in MAJOR.MINOR.PATCH form).
  // Operators with semver-2 pre-release versioning will get the
  // canonical lex order, which matches what nuget.org's flat-container
  // does (it stores versions in a sorted set keyed by lex order).
  const versions = rows.map((r) => r.version);
  versions.sort((a, b) => a.localeCompare(b));
  return versions;
}

async function readBlobBytes(
  storage: RegistryStorage,
  sha256: string,
  expectedSize: number,
): Promise<Buffer> {
  const stream = await storage.getBlob(sha256);
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += buf.length;
    if (total > expectedSize + 4096) {
      throw new NugetError(
        NUGET_ERROR_CODES.NUPKG_INVALID,
        `blob sha256:${sha256} exceeds declared size ${expectedSize}`,
      );
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}
