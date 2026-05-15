/**
 * Npm read handlers (v0.1.1).
 *
 * Two routes under `/npm/<org>/`:
 *
 *   GET /npm/<org>/<package>
 *     The "packument" — JSON aggregate of every published version
 *     of <package> for this org. Shape:
 *       {
 *         "name": "<package>",
 *         "dist-tags": { "latest": "<version>" },
 *         "versions": {
 *           "<version>": { name, version, dependencies, dist: { tarball, integrity, shasum } },
 *           ...
 *         }
 *       }
 *
 *   GET /npm/<org>/<package>/-/<filename>
 *     The .tgz tarball download. <filename> conventionally
 *     `<basename>-<version>.tgz` where <basename> drops the @scope/
 *     prefix on scoped packages. We accept any filename matching
 *     `<lower-pkg-suffix>-<version>.tgz` shape.
 *
 * Scoped packages are URL-encoded by the client (`%2F` for `/`).
 * The router decodeURIComponents the path segment, so `:package`
 * sees `@signalman/host`.
 *
 * Tarball URL rewriting: each version's `dist.tarball` field is
 * rewritten to point at THIS registry (not the upstream's URL the
 * operator may have proxied from). Without this rewrite, an npm
 * client would dial the upstream directly + bypass our cache /
 * forensic trail.
 */

import { Readable } from "node:stream";
import {
  REGISTRY_ERROR_CODES,
  RegistryError,
  type Manifest,
  type NpmManifestMetadata,
  type RegistryStorage,
} from "../types.js";
import type { Router } from "../http/router.js";
import {
  npmManifestName,
  validateNpmOrgName,
  validateNpmPackageName,
} from "./paths.js";

export interface MountNpmReadOptions {
  storage: RegistryStorage;
  /**
   * Public base URL — used to rewrite `dist.tarball` URLs in the
   * packument so clients dial this registry, not the upstream.
   * Defaults to `""` (relative URLs).
   */
  publicBaseUrl?: string;
  /**
   * v0.1.1: optional virtual-registry proxy callbacks. On local
   * miss, fall through to upstream (npmjs.com pull-through).
   */
  proxyPackument?: (org: string, packageName: string) => Promise<string | null>;
  proxyTarball?: (
    org: string,
    packageName: string,
    version: string,
  ) => Promise<{ sha256: string; bytes: Buffer } | null>;
}

export function mountNpmReadRoutes(
  router: Router,
  opts: MountNpmReadOptions,
): void {
  const storage = opts.storage;
  const baseUrl = opts.publicBaseUrl ?? "";

  // ── Packument ──────────────────────────────────────────────────

  router.get(
    "/npm/:org/:package",
    async (ctx) => {
      if (!ctx.res) {
        throw new Error("internal: rawResponse npm-packument handler missing res");
      }
      try {
        validateNpmOrgName(ctx.params.org);
        validateNpmPackageName(ctx.params.package);
      } catch (err) {
        return write404(ctx.res, "bad_name", (err as Error).message);
      }
      const manifestName = npmManifestName(ctx.params.org, ctx.params.package);
      const versions = await storage.listManifestVersions(manifestName);

      // Pull each manifest in turn to harvest npmMetadata.
      const versionsMap: Record<string, Record<string, unknown>> = {};
      let latest: string | null = null;
      for (const v of versions) {
        const m = await storage.getManifest(v.name, v.version);
        if (!m) continue;
        if (m.kind !== "npm" || !m.npmMetadata) continue;
        versionsMap[v.version] = packumentVersionEntry(
          m,
          ctx.params.org,
          ctx.params.package,
          baseUrl,
        );
        // Heuristic latest: newest-by-created_at. Real dist-tags
        // come in a future milestone (mutable tags ROADMAP item).
        if (!latest) latest = v.version;
      }

      if (Object.keys(versionsMap).length === 0 && opts.proxyPackument) {
        const proxied = await opts.proxyPackument(
          ctx.params.org,
          ctx.params.package,
        );
        if (proxied !== null) {
          ctx.res.statusCode = 200;
          ctx.res.setHeader("content-type", "application/json; charset=utf-8");
          ctx.res.end(proxied);
          return;
        }
      }

      if (Object.keys(versionsMap).length === 0) {
        return write404(
          ctx.res,
          "not_found",
          `npm package not found: ${ctx.params.org}/${ctx.params.package}`,
        );
      }

      const packument = {
        name: ctx.params.package,
        "dist-tags": latest ? { latest } : {},
        versions: versionsMap,
      };
      ctx.res.statusCode = 200;
      ctx.res.setHeader("content-type", "application/json; charset=utf-8");
      ctx.res.end(JSON.stringify(packument));
    },
    { rawResponse: true },
  );

  // ── Tarball ────────────────────────────────────────────────────
  //
  // Path: /npm/<org>/<package>/-/<filename>.tgz
  // The filename embeds <basename>-<version>; we extract version
  // by stripping the package basename + .tgz suffix.
  //
  // For scoped packages (`@signalman/host`), npm convention puts
  // the basename (after `/`) into the filename, so the URL looks
  // like `/npm/<org>/@signalman%2Fhost/-/host-1.0.0.tgz`. We accept
  // both forms (full name + basename).

  router.get(
    "/npm/:org/:package/-/:filename",
    async (ctx) => {
      if (!ctx.res) {
        throw new Error("internal: rawResponse npm-tarball handler missing res");
      }
      try {
        validateNpmOrgName(ctx.params.org);
        validateNpmPackageName(ctx.params.package);
      } catch (err) {
        return write404(ctx.res, "bad_name", (err as Error).message);
      }
      const filename = ctx.params.filename;
      if (!filename.endsWith(".tgz")) {
        return write404(
          ctx.res,
          "bad_filename",
          `npm tarball filename must end in .tgz: ${filename}`,
        );
      }
      // Parse `<basename>-<version>.tgz`. The basename is the
      // package name without `@scope/` prefix for scoped packages.
      const basename = ctx.params.package.includes("/")
        ? ctx.params.package.split("/")[1]
        : ctx.params.package;
      const prefix = `${basename}-`;
      if (!filename.startsWith(prefix)) {
        return write404(
          ctx.res,
          "bad_filename",
          `npm tarball filename must match ${basename}-<version>.tgz: ${filename}`,
        );
      }
      const version = filename.slice(prefix.length, -".tgz".length);
      if (version.length === 0) {
        return write404(ctx.res, "bad_filename", `missing version in: ${filename}`);
      }

      const manifestName = npmManifestName(ctx.params.org, ctx.params.package);
      const manifest = await storage.getManifest(manifestName, version);
      if (!manifest) {
        if (opts.proxyTarball) {
          const proxied = await opts.proxyTarball(
            ctx.params.org,
            ctx.params.package,
            version,
          );
          if (proxied) {
            writeTarball(ctx.res, proxied.bytes, basename, version);
            return;
          }
        }
        return write404(
          ctx.res,
          "not_found",
          `npm package ${ctx.params.org}/${ctx.params.package}@${version} not found`,
        );
      }
      if (manifest.kind !== "npm") {
        return write404(
          ctx.res,
          "bad_manifest",
          `manifest is not an npm package (kind=${manifest.kind ?? "generic"})`,
        );
      }
      const blobRef = manifest.blobs[0];
      if (!blobRef) {
        return write404(
          ctx.res,
          "bad_manifest",
          `npm manifest pins no blobs`,
        );
      }
      let stream: Readable;
      try {
        stream = await storage.getBlob(blobRef.sha256);
      } catch (err) {
        if (
          err instanceof RegistryError &&
          err.code === REGISTRY_ERROR_CODES.BLOB_NOT_FOUND
        ) {
          if (opts.proxyTarball) {
            const proxied = await opts.proxyTarball(
              ctx.params.org,
              ctx.params.package,
              version,
            );
            // For npm, the upstream packument carries `integrity`
            // (SRI sha512) but NOT the tarball's sha256. Our
            // proxy-cache path uses a synthetic sha for the blob
            // ref (derived from integrity), which never matches
            // the actual bytes' sha256. So we trust the proxied
            // bytes when the manifest's integrity is the operator
            // -visible verification. The npm client validates
            // SRI client-side from the packument's dist.integrity.
            if (proxied) {
              writeTarball(ctx.res, proxied.bytes, basename, version);
              return;
            }
          }
          return write404(
            ctx.res,
            "blob_not_found",
            `npm tarball blob not found: ${blobRef.sha256}`,
          );
        }
        throw err;
      }
      ctx.res.statusCode = 200;
      ctx.res.setHeader("content-type", "application/octet-stream");
      ctx.res.setHeader(
        "content-disposition",
        `attachment; filename="${filename}"`,
      );
      if (blobRef.size !== undefined) {
        ctx.res.setHeader("content-length", String(blobRef.size));
      }
      stream.pipe(ctx.res);
      await new Promise<void>((resolve, reject) => {
        stream.on("end", resolve);
        stream.on("error", reject);
        ctx.res!.on("error", reject);
      });
    },
    { rawResponse: true },
  );
}

/**
 * Build a single packument version entry from a stored manifest.
 * The tarball URL is rewritten to point at THIS registry.
 */
export function packumentVersionEntry(
  manifest: Manifest,
  org: string,
  packageName: string,
  baseUrl: string,
): Record<string, unknown> {
  const meta = manifest.npmMetadata!;
  const basename = packageName.includes("/")
    ? packageName.split("/")[1]
    : packageName;
  const tarballUrl =
    `${baseUrl}/npm/${org}/${encodeURIComponent(packageName)}/-/${basename}-${manifest.version}.tgz`;
  const dist: Record<string, unknown> = { tarball: tarballUrl };
  if (meta.integrity) dist.integrity = meta.integrity;
  if (meta.shasum) dist.shasum = meta.shasum;
  const entry: Record<string, unknown> = {
    name: meta.name,
    version: meta.version,
    dist,
  };
  if (meta.dependencies) entry.dependencies = meta.dependencies;
  if (meta.devDependencies) entry.devDependencies = meta.devDependencies;
  if (meta.peerDependencies) entry.peerDependencies = meta.peerDependencies;
  if (meta.optionalDependencies) entry.optionalDependencies = meta.optionalDependencies;
  if (meta.engines) entry.engines = meta.engines;
  if (meta.description !== undefined) entry.description = meta.description;
  if (meta.keywords) entry.keywords = meta.keywords;
  if (meta.homepage !== undefined) entry.homepage = meta.homepage;
  if (meta.license !== undefined) entry.license = meta.license;
  if (meta.main !== undefined) entry.main = meta.main;
  if (meta.bin !== undefined) entry.bin = meta.bin;
  if (meta.deprecated !== undefined) entry.deprecated = meta.deprecated;
  return entry;
}

function writeTarball(
  res: import("node:http").ServerResponse,
  bytes: Buffer,
  basename: string,
  version: string,
): void {
  res.statusCode = 200;
  res.setHeader("content-type", "application/octet-stream");
  res.setHeader(
    "content-disposition",
    `attachment; filename="${basename}-${version}.tgz"`,
  );
  res.setHeader("content-length", String(bytes.length));
  res.end(bytes);
}

function write404(
  res: import("node:http").ServerResponse,
  code: string,
  message: string,
): void {
  res.statusCode = 404;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify({ error: { code, message } }));
}
