/**
 * Cargo sparse-index read handlers (WS6 wave-3 M10.2).
 *
 * Three routes mount under `/cargo/<org>/`:
 *
 *   GET  /cargo/<org>/index/config.json
 *     Returns the sparse-index config: where to download crates
 *     (`dl` URL) and where the API lives (`api` URL). Cargo reads
 *     this once per index and caches it locally.
 *
 *   GET  /cargo/<org>/index/<sparse-index-path-suffix>
 *     Returns NDJSON — one JSON line per crate version. Order is
 *     not significant; cargo sorts client-side. Empty response =
 *     crate not found (404 from the route layer).
 *
 *   GET  /cargo/<org>/api/v1/crates/<name>/<version>/download
 *     Streams the .crate tarball bytes. Content-Type:
 *     application/x-tar (cargo accepts any binary octet-stream).
 *
 * Manifest storage shape (M10.1):
 *   Each crate version is a Manifest with:
 *     name: `cargo/<org>/<crate>` (lowercased)
 *     version: the crate version string
 *     kind: 'cargo'
 *     cargoMetadata: { name, vers, deps, cksum, features, yanked, ... }
 *     blobs: [{ mediaType, sha256, size, name: 'crate.tar' }]
 *
 * The sparse-index handler iterates `listManifestVersions` and pulls
 * each manifest's `cargoMetadata` — that's already the cargo
 * sparse-index JSON shape verbatim, so we re-serialize 1:1.
 *
 * Raw-response handlers (NDJSON + tarball download) use the
 * `rawResponse: true` route option to write directly to `ctx.res`,
 * matching the existing blob-GET pattern in `http/app.ts`.
 */

import { Readable } from "node:stream";
import {
  REGISTRY_ERROR_CODES,
  RegistryError,
  type CargoManifestMetadata,
  type RegistryStorage,
} from "../types.js";
import type { Router } from "../http/router.js";
import {
  cargoManifestName,
  crateNameFromSparseIndexPath,
  validateCargoCrateName,
  validateCargoOrgName,
} from "./paths.js";

export interface MountCargoReadOptions {
  storage: RegistryStorage;
  /**
   * Public base URL of this registry, used to build the `dl` + `api`
   * URLs in config.json. Defaults to `""` (relative URLs); production
   * callers set this to e.g. `https://registry.signalman.io`.
   */
  publicBaseUrl?: string;
}

/**
 * Mount the cargo read-path routes on the given router. Idempotent;
 * call once at app boot.
 */
export function mountCargoReadRoutes(
  router: Router,
  opts: MountCargoReadOptions,
): void {
  const storage = opts.storage;
  const baseUrl = opts.publicBaseUrl ?? "";

  // ── Sparse-index config ────────────────────────────────────────
  //
  // Cargo reads /cargo/<org>/index/config.json once + caches it.
  // The `dl` URL uses `{crate}` + `{version}` placeholders so the
  // download endpoint shape stays explicit (vs. cargo's
  // "append /<crate>/<version>/download" fallback).

  router.get("/cargo/:org/index/config.json", async (ctx) => {
    validateCargoOrgName(ctx.params.org);
    return {
      dl: `${baseUrl}/cargo/${ctx.params.org}/api/v1/crates/{crate}/{version}/download`,
      api: `${baseUrl}/cargo/${ctx.params.org}`,
      "auth-required": true,
    };
  });

  // ── Sparse-index entries ───────────────────────────────────────
  //
  // The tail-glob `*rest` matches the variable-depth sparse-index
  // path under /index/. The handler decodes the crate name from
  // the path shape, fetches all versions, and emits NDJSON.

  router.get(
    "/cargo/:org/index/*rest",
    async (ctx) => {
      if (!ctx.res) {
        throw new Error("internal: rawResponse cargo-index handler missing res");
      }
      try {
        validateCargoOrgName(ctx.params.org);
      } catch (err) {
        return write404(ctx.res, "bad_name", (err as Error).message);
      }
      const name = crateNameFromSparseIndexPath(ctx.params.rest);
      if (!name) {
        return write404(ctx.res, "not_found", "cargo sparse-index entry not found");
      }
      const manifestName = cargoManifestName(ctx.params.org, name);
      const versions = await storage.listManifestVersions(manifestName);
      if (versions.length === 0) {
        return write404(
          ctx.res,
          "not_found",
          `cargo crate not found: ${ctx.params.org}/${name}`,
        );
      }
      const lines: string[] = [];
      for (const v of versions) {
        const m = await storage.getManifest(v.name, v.version);
        if (!m) continue;
        if (m.kind !== "cargo" || !m.cargoMetadata) continue;
        lines.push(JSON.stringify(serializeIndexEntry(m.cargoMetadata)));
      }
      if (lines.length === 0) {
        return write404(
          ctx.res,
          "not_found",
          `cargo crate has no cargo-kind versions: ${name}`,
        );
      }
      ctx.res.statusCode = 200;
      ctx.res.setHeader("content-type", "application/json; charset=utf-8");
      ctx.res.end(lines.join("\n") + "\n");
    },
    { rawResponse: true },
  );

  // ── Crate download ─────────────────────────────────────────────

  router.get(
    "/cargo/:org/api/v1/crates/:name/:version/download",
    async (ctx) => {
      if (!ctx.res) {
        throw new Error("internal: rawResponse cargo-download handler missing res");
      }
      try {
        validateCargoOrgName(ctx.params.org);
        validateCargoCrateName(ctx.params.name);
      } catch (err) {
        return write404(ctx.res, "bad_name", (err as Error).message);
      }
      if (ctx.params.version.length === 0 || /[\s/]/.test(ctx.params.version)) {
        return write404(
          ctx.res,
          "bad_version",
          `invalid cargo crate version: ${ctx.params.version}`,
        );
      }
      const manifestName = cargoManifestName(ctx.params.org, ctx.params.name);
      const manifest = await storage.getManifest(manifestName, ctx.params.version);
      if (!manifest) {
        return write404(
          ctx.res,
          "not_found",
          `cargo crate ${ctx.params.org}/${ctx.params.name}@${ctx.params.version} not found`,
        );
      }
      if (manifest.kind !== "cargo") {
        return write404(
          ctx.res,
          "bad_manifest",
          `manifest ${manifest.name}@${manifest.version} is not a cargo crate (kind=${manifest.kind ?? "generic"})`,
        );
      }
      const blobRef = manifest.blobs[0];
      if (!blobRef) {
        return write404(
          ctx.res,
          "bad_manifest",
          `cargo manifest ${manifest.name}@${manifest.version} pins no blobs`,
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
          return write404(
            ctx.res,
            "blob_not_found",
            `crate tarball blob not found: ${blobRef.sha256}`,
          );
        }
        throw err;
      }
      ctx.res.statusCode = 200;
      ctx.res.setHeader("content-type", "application/x-tar");
      ctx.res.setHeader(
        "content-disposition",
        `attachment; filename="${ctx.params.name}-${ctx.params.version}.crate"`,
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
 * Serialize a stored {@link CargoManifestMetadata} into the exact
 * shape cargo expects in a sparse-index NDJSON line. Field names
 * already match the cargo spec (see types.ts); this function just
 * reorders / drops undefined optionals for compact output.
 */
export function serializeIndexEntry(meta: CargoManifestMetadata): Record<string, unknown> {
  const entry: Record<string, unknown> = {
    name: meta.name,
    vers: meta.vers,
    deps: meta.deps,
    cksum: meta.cksum,
    features: meta.features ?? {},
    yanked: meta.yanked,
  };
  if (meta.rust_version !== undefined) {
    entry.rust_version = meta.rust_version;
  }
  if (meta.links !== undefined) {
    entry.links = meta.links;
  }
  return entry;
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
