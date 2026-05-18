/**
 * NuGet v3 registration endpoint.
 *
 * Routes (mounted under `/nuget/<org>/` by `mount.ts`):
 *
 *   GET /v3/registration5-semver1/<id>/index.json
 *     → registration index: page list with embedded leaves
 *   GET /v3/registration5-semver1/<id>/<version>.json
 *     → registration leaf (per-version metadata)
 *
 * The registration document layered shape is:
 *   index → items[] (pages) → items[] (leaves with catalogEntry)
 *
 * For small package sets (the typical operator use case) we emit a
 * single inline page that carries every version's leaf. The protocol
 * permits multiple pages with separate page URLs; modern dotnet
 * clients accept the inline single-page form.
 *
 * The leaf's `catalogEntry` is the operator-projected per-version
 * metadata (description, authors, dependency groups, target
 * frameworks, packageHash, packageSize). Clients use this to drive
 * dependency resolution before fetching the nupkg.
 *
 * Storage layout: same per-row layout as flat-container — one
 * manifest row per (id, version) with `nugetMetadata` carrying the
 * nuspec projection.
 *
 * Reference:
 *   https://learn.microsoft.com/en-us/nuget/api/registration-base-url-resource
 */

import type { Router } from "../http/router.js";
import type {
  Manifest,
  NugetManifestMetadata,
  RegistryStorage,
} from "../types.js";
import { validateCargoOrgName } from "../cargo/paths.js";
import { NugetError, asNugetError, writeNugetError } from "./errors.js";
import {
  NUGET_ERROR_CODES,
  NUGET_MEDIA_TYPES,
  type NugetCatalogEntry,
  type NugetRegistrationIndex,
  type NugetRegistrationLeaf,
  type NugetRegistrationPage,
} from "./types.js";
import {
  normalisePackageId,
  normaliseVersion,
  nugetManifestName,
  validateNugetPackageId,
  validateNugetVersion,
} from "./paths.js";

export interface MountNugetRegistrationOptions {
  storage: RegistryStorage;
  /**
   * Optional pull-through hook called on a registration-index miss.
   * Mirrors `flat-container.ts` — when set and the local lookup
   * returns no rows, the read handler calls this hook; on success
   * the read re-queries storage.
   */
  proxyRegistration?: (org: string, id: string) => Promise<boolean>;
  /**
   * Public base URL of this registry. Resource `@id` URLs in the
   * registration response use this; default `""` (relative URLs).
   */
  publicBaseUrl?: string;
}

export function mountNugetRegistrationRoutes(
  router: Router,
  opts: MountNugetRegistrationOptions,
): void {
  const storage = opts.storage;
  const publicBaseUrl = opts.publicBaseUrl ?? "";
  for (const prefix of [
    "registration5-semver1",
    "registration5-semver2",
  ] as const) {
    router.get(
      `/nuget/:org/v3/${prefix}/:id/index.json`,
      async (ctx) => {
        const res = ctx.res!;
        try {
          validateCargoOrgName(ctx.params.org);
          validateNugetPackageId(ctx.params.id);
          const org = ctx.params.org;
          const id = normalisePackageId(ctx.params.id);
          let manifests = await loadAllVersions(storage, org, id);
          if (manifests.length === 0 && opts.proxyRegistration) {
            const ok = await opts.proxyRegistration(org, id);
            if (ok) manifests = await loadAllVersions(storage, org, id);
          }
          if (manifests.length === 0) {
            throw new NugetError(
              NUGET_ERROR_CODES.PACKAGE_NOT_FOUND,
              `no versions for package '${id}' under org '${org}'`,
            );
          }
          const idx = composeRegistrationIndex(
            org,
            id,
            manifests,
            publicBaseUrl,
            prefix,
          );
          writeJson(res, idx);
        } catch (err) {
          writeNugetError(res, asNugetError(err));
        }
      },
      { rawResponse: true },
    );

    router.get(
      `/nuget/:org/v3/${prefix}/:id/:versionFile`,
      async (ctx) => {
        const res = ctx.res!;
        try {
          validateCargoOrgName(ctx.params.org);
          validateNugetPackageId(ctx.params.id);
          const versionFile = ctx.params.versionFile;
          if (!versionFile.endsWith(".json")) {
            throw new NugetError(
              NUGET_ERROR_CODES.RESOURCE_NOT_FOUND,
              `registration leaf must end in .json (got '${versionFile}')`,
            );
          }
          const rawVersion = versionFile.slice(0, -".json".length);
          validateNugetVersion(rawVersion);
          const org = ctx.params.org;
          const id = normalisePackageId(ctx.params.id);
          const version = normaliseVersion(rawVersion);
          const manifest = await storage.getManifest(
            nugetManifestName(org, id),
            version,
          );
          if (!manifest || !manifest.nugetMetadata) {
            throw new NugetError(
              NUGET_ERROR_CODES.VERSION_NOT_FOUND,
              `version ${version} of '${id}' not found`,
            );
          }
          const leaf = composeRegistrationLeaf(
            org,
            id,
            manifest,
            publicBaseUrl,
            prefix,
          );
          writeJson(res, leaf);
        } catch (err) {
          writeNugetError(res, asNugetError(err));
        }
      },
      { rawResponse: true },
    );
  }
}

async function loadAllVersions(
  storage: RegistryStorage,
  org: string,
  id: string,
): Promise<Manifest[]> {
  const name = nugetManifestName(org, id);
  const rows = await storage.listManifestVersions(name);
  const out: Manifest[] = [];
  for (const r of rows) {
    const m = await storage.getManifest(r.name, r.version);
    if (!m || !m.nugetMetadata) continue;
    out.push(m);
  }
  out.sort((a, b) => a.version.localeCompare(b.version));
  return out;
}

/**
 * Compose the registration index for a list of manifests sharing a
 * (org, id). Each manifest must carry `nugetMetadata`. The index is
 * a single inline page wrapping every version's leaf.
 */
export function composeRegistrationIndex(
  org: string,
  id: string,
  manifests: Manifest[],
  publicBaseUrl: string,
  prefix: string,
): NugetRegistrationIndex {
  const base = trimTrailingSlash(publicBaseUrl);
  const indexUrl = `${base}/nuget/${org}/v3/${prefix}/${id}/index.json`;
  const leaves: NugetRegistrationLeaf[] = manifests.map((m) =>
    composeRegistrationLeaf(org, id, m, publicBaseUrl, prefix),
  );
  if (leaves.length === 0) {
    throw new NugetError(
      NUGET_ERROR_CODES.PACKAGE_NOT_FOUND,
      `no manifest rows projected as registration leaves`,
    );
  }
  const lower = leaves[0].catalogEntry.version;
  const upper = leaves[leaves.length - 1].catalogEntry.version;
  const page: NugetRegistrationPage = {
    "@id": `${indexUrl}#page/${lower}/${upper}`,
    "@type": "catalog:CatalogPage",
    count: leaves.length,
    lower,
    upper,
    items: leaves,
    parent: indexUrl,
  };
  return {
    "@id": indexUrl,
    "@type": [
      "catalog:CatalogRoot",
      "PackageRegistration",
      "catalog:Permalink",
    ],
    count: 1,
    items: [page],
  };
}

export function composeRegistrationLeaf(
  org: string,
  id: string,
  manifest: Manifest,
  publicBaseUrl: string,
  prefix: string,
): NugetRegistrationLeaf {
  const meta = manifest.nugetMetadata;
  if (!meta) {
    throw new NugetError(
      NUGET_ERROR_CODES.NUSPEC_INVALID,
      `manifest ${manifest.name}@${manifest.version} missing nugetMetadata`,
    );
  }
  const base = trimTrailingSlash(publicBaseUrl);
  const regBase = `${base}/nuget/${org}/v3/${prefix}/${id}`;
  const leafUrl = `${regBase}/${meta.version}.json`;
  const flatBase = `${base}/nuget/${org}/v3/flat2/${id}/${meta.version}`;
  const packageContent = `${flatBase}/${id}.${meta.version}.nupkg`;
  const catalogEntry: NugetCatalogEntry = {
    "@id": `${leafUrl}#catalogEntry`,
    "@type": "PackageDetails",
    id: meta.originalId ?? meta.id,
    version: meta.version,
    packageContent,
    listed: meta.listed !== false,
    packageHash: meta.packageHash,
    packageHashAlgorithm: meta.packageHashAlgorithm,
    packageSize: meta.packageSize,
  };
  if (meta.authors) catalogEntry.authors = meta.authors;
  if (meta.description) catalogEntry.description = meta.description;
  if (meta.summary) catalogEntry.summary = meta.summary;
  if (meta.title) catalogEntry.title = meta.title;
  if (meta.tags) catalogEntry.tags = meta.tags;
  if (meta.projectUrl) catalogEntry.projectUrl = meta.projectUrl;
  if (meta.licenseUrl) catalogEntry.licenseUrl = meta.licenseUrl;
  if (meta.licenseExpression) catalogEntry.licenseExpression = meta.licenseExpression;
  if (meta.iconUrl) catalogEntry.iconUrl = meta.iconUrl;
  if (meta.requireLicenseAcceptance !== undefined) {
    catalogEntry.requireLicenseAcceptance = meta.requireLicenseAcceptance;
  }
  if (meta.dependencyGroups) {
    catalogEntry.dependencyGroups = meta.dependencyGroups.map((g) => ({
      "@type": "PackageDependencyGroup" as const,
      ...(g.targetFramework ? { targetFramework: g.targetFramework } : {}),
      ...(g.dependencies
        ? {
            dependencies: g.dependencies.map((d) => ({
              "@type": "PackageDependency" as const,
              id: d.id,
              ...(d.range ? { range: d.range } : {}),
            })),
          }
        : {}),
    }));
  }
  if (meta.targetFrameworks) catalogEntry.targetFrameworks = meta.targetFrameworks;
  if (meta.published) catalogEntry.published = meta.published;
  else catalogEntry.published = manifest.createdAt;
  return {
    "@id": leafUrl,
    "@type": "Package",
    catalogEntry,
    packageContent,
    registration: `${regBase}/index.json`,
  };
}

function writeJson(
  res: import("node:http").ServerResponse,
  body: unknown,
): void {
  const json = JSON.stringify(body);
  res.statusCode = 200;
  res.setHeader("content-type", `${NUGET_MEDIA_TYPES.JSON}; charset=utf-8`);
  res.setHeader("content-length", Buffer.byteLength(json).toString());
  res.end(json);
}

function trimTrailingSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}

// NugetManifestMetadata is referenced via Manifest.nugetMetadata in
// the composers above; the explicit import keeps the symbol visible
// to dev-time `Go to Definition` without needing a separate type-only
// re-export.
void NugetError;
void (null as unknown as NugetManifestMetadata | undefined);
