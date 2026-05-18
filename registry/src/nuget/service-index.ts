/**
 * NuGet v3 service-index endpoint.
 *
 * Clients fetch `GET /nuget/<org>/v3/index.json` once per session
 * to discover the resource URLs they need. The response is a JSON
 * document with `version` + `resources` — each resource is identified
 * by an `@type` URI and carries an `@id` URL.
 *
 * We advertise:
 *   - PackageBaseAddress/3.0.0      flat-container (the dotnet client's
 *                                   primary download path)
 *   - RegistrationsBaseUrl (semver1) registration pages
 *   - PackagePublish/2.0.0          push endpoint (dotnet nuget push)
 *   - SearchQueryService            search stub (always returns empty)
 *
 * We do NOT advertise v2 (OData) resources — out of scope at v0.6
 * per the M0 gate.
 */

import type { ServerResponse } from "node:http";
import type { Router } from "../http/router.js";
import { validateCargoOrgName } from "../cargo/paths.js";
import { NugetError, asNugetError, writeNugetError } from "./errors.js";
import {
  NUGET_MEDIA_TYPES,
  NUGET_RESOURCE_TYPES,
  type NugetServiceIndex,
} from "./types.js";

export interface MountNugetServiceIndexOptions {
  /**
   * Public base URL of this registry, e.g. `https://signalman-reg`.
   * Resource `@id` URLs are absolute when set; relative-from-current-
   * request when empty (operators behind a reverse proxy that
   * rewrites host headers prefer the relative form). Default `""`.
   */
  publicBaseUrl?: string;
}

/**
 * Compose the service-index JSON for a given org. Pure function;
 * the route handler wraps this for HTTP delivery.
 */
export function composeServiceIndex(
  org: string,
  publicBaseUrl: string,
): NugetServiceIndex {
  const base = trimTrailingSlash(publicBaseUrl);
  const orgBase = `${base}/nuget/${org}`;
  const flatBase = `${orgBase}/v3/flat2/`;
  const regBase = `${orgBase}/v3/registration5-semver1/`;
  const regBaseSemver2 = `${orgBase}/v3/registration5-semver2/`;
  const publishUrl = `${orgBase}/v3/publish`;
  const searchUrl = `${orgBase}/v3/search`;
  return {
    version: "3.0.0",
    resources: [
      {
        "@id": flatBase,
        "@type": NUGET_RESOURCE_TYPES.PACKAGE_BASE_ADDRESS,
        comment: "Flat-container package base address (download endpoint)",
      },
      {
        "@id": regBase,
        "@type": NUGET_RESOURCE_TYPES.REGISTRATION_BASE_URL,
        comment: "Registration base URL (semver1)",
      },
      {
        "@id": regBase,
        "@type": NUGET_RESOURCE_TYPES.REGISTRATION_BASE_URL_SEMVER1,
        comment: "Registration base URL (semver1 / 3.0.0-beta)",
      },
      {
        "@id": regBaseSemver2,
        "@type": NUGET_RESOURCE_TYPES.REGISTRATION_BASE_URL_VERSIONED,
        comment: "Registration base URL (semver2 / 3.0.0-rc)",
      },
      {
        "@id": publishUrl,
        "@type": NUGET_RESOURCE_TYPES.PACKAGE_PUBLISH,
        comment: "Package push endpoint (dotnet nuget push)",
      },
      {
        "@id": searchUrl,
        "@type": NUGET_RESOURCE_TYPES.SEARCH_QUERY_SERVICE,
        comment: "Search query service (stub at v0.6)",
      },
      {
        "@id": searchUrl,
        "@type": NUGET_RESOURCE_TYPES.SEARCH_QUERY_SERVICE_3_0_0_BETA,
      },
      {
        "@id": searchUrl,
        "@type": NUGET_RESOURCE_TYPES.SEARCH_QUERY_SERVICE_3_0_0_RC,
      },
    ],
  };
}

export function mountNugetServiceIndexRoute(
  router: Router,
  opts: MountNugetServiceIndexOptions,
): void {
  const publicBaseUrl = opts.publicBaseUrl ?? "";
  router.get(
    "/nuget/:org/v3/index.json",
    (ctx) => {
      const res = ctx.res!;
      try {
        validateCargoOrgName(ctx.params.org);
        const idx = composeServiceIndex(ctx.params.org, publicBaseUrl);
        writeServiceIndex(res, idx);
      } catch (err) {
        writeNugetError(res, asNugetError(err));
      }
    },
    { rawResponse: true },
  );
  // Search stub — empty results, surface 200 so dotnet doesn't spam
  // the operator with errors when it auto-discovers the resource.
  router.get(
    "/nuget/:org/v3/search",
    (ctx) => {
      const res = ctx.res!;
      try {
        validateCargoOrgName(ctx.params.org);
        const body = JSON.stringify({ totalHits: 0, data: [] });
        res.statusCode = 200;
        res.setHeader("content-type", `${NUGET_MEDIA_TYPES.JSON}; charset=utf-8`);
        res.setHeader("content-length", Buffer.byteLength(body).toString());
        res.end(body);
      } catch (err) {
        writeNugetError(res, asNugetError(err));
      }
    },
    { rawResponse: true },
  );
}

function writeServiceIndex(res: ServerResponse, idx: NugetServiceIndex): void {
  const body = JSON.stringify(idx);
  res.statusCode = 200;
  res.setHeader("content-type", `${NUGET_MEDIA_TYPES.JSON}; charset=utf-8`);
  res.setHeader("content-length", Buffer.byteLength(body).toString());
  res.end(body);
}

function trimTrailingSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}

void NugetError;
