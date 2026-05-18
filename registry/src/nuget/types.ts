/**
 * NuGet v3 wire-format types.
 *
 * NuGet v3 is a service-index-driven protocol: clients fetch
 * `GET /v3/index.json` once to discover endpoints for the
 * resources they need (package base address / flat container,
 * registration, search, publish). Each resource is identified by
 * an `@type` URI (or list of `@type` URIs) and has a `@id` URL.
 *
 * v2 OData legacy is **out of scope** at v0.6 per the WS13 M0 gate
 * (locked 2026-05-17 — modern `dotnet` prefers v3; legacy nuget.exe
 * can be upgraded; v2 may land in v0.7 if operators ask).
 *
 * Reference:
 *   https://learn.microsoft.com/en-us/nuget/api/overview
 *   https://learn.microsoft.com/en-us/nuget/api/service-index
 *   https://learn.microsoft.com/en-us/nuget/api/package-base-address-resource
 *   https://learn.microsoft.com/en-us/nuget/api/registration-base-url-resource
 *   https://learn.microsoft.com/en-us/nuget/api/package-publish-resource
 */

// ── Media types ────────────────────────────────────────────────────

export const NUGET_MEDIA_TYPES = {
  /** Service index + registration + search responses. */
  JSON: "application/json",
  /** Nupkg payload — a zip with .nuspec inside. */
  NUPKG: "application/octet-stream",
  /** Bare nuspec served from flat-container. */
  NUSPEC: "application/xml",
  /** Multipart push body. */
  MULTIPART_FORM: "multipart/form-data",
} as const;

// ── Service-index types ────────────────────────────────────────────

/**
 * Stable resource `@type` identifiers we advertise on
 * `GET /v3/index.json`. Each resource carries one or more `@type`
 * strings; we include the versioned shapes the `dotnet` client
 * looks for. We do not advertise the v2 (OData) types — out of scope.
 *
 * Reference: NuGet v3 protocol §service-index resource types.
 */
export const NUGET_RESOURCE_TYPES = {
  /** PackageBaseAddress (flat-container) — primary modern download endpoint. */
  PACKAGE_BASE_ADDRESS: "PackageBaseAddress/3.0.0",
  /** RegistrationsBaseUrl — semver1 registration page set. */
  REGISTRATION_BASE_URL: "RegistrationsBaseUrl",
  REGISTRATION_BASE_URL_SEMVER1: "RegistrationsBaseUrl/3.0.0-beta",
  REGISTRATION_BASE_URL_VERSIONED: "RegistrationsBaseUrl/3.0.0-rc",
  REGISTRATION_BASE_URL_SEMVER2: "RegistrationsBaseUrl/Versioned",
  /** PackagePublish — push endpoint (`dotnet nuget push`). */
  PACKAGE_PUBLISH: "PackagePublish/2.0.0",
  /** SearchQueryService — autocomplete/search; we ship a stub. */
  SEARCH_QUERY_SERVICE: "SearchQueryService",
  SEARCH_QUERY_SERVICE_3_0_0_BETA: "SearchQueryService/3.0.0-beta",
  SEARCH_QUERY_SERVICE_3_0_0_RC: "SearchQueryService/3.0.0-rc",
} as const;

/** One resource entry in the service index JSON. */
export interface NugetServiceResource {
  "@id": string;
  "@type": string;
  comment?: string;
}

/** Top-level `/v3/index.json` shape. */
export interface NugetServiceIndex {
  version: "3.0.0";
  resources: NugetServiceResource[];
}

// ── Flat-container (package base address) ──────────────────────────

/** `GET /v3/flat2/<id>/index.json` — version listing. */
export interface NugetFlatContainerVersionIndex {
  versions: string[];
}

// ── Registration ──────────────────────────────────────────────────

/**
 * `GET /v3/registration5-semver1/<id>/index.json` — registration page.
 *
 * NuGet's registration shape is layered: an `index.json` contains
 * one or more `items` (registration pages), each carrying per-version
 * `items` (leaves) with metadata. We emit a single inline page in the
 * common case (small package sets) for simplicity; the protocol
 * permits multiple pages but `dotnet` accepts an inline single page.
 */
export interface NugetRegistrationIndex {
  "@id": string;
  "@type": string[];
  count: number;
  items: NugetRegistrationPage[];
}

export interface NugetRegistrationPage {
  "@id": string;
  "@type": string;
  count: number;
  lower: string;
  upper: string;
  items: NugetRegistrationLeaf[];
  parent?: string;
}

export interface NugetRegistrationLeaf {
  "@id": string;
  "@type": "Package";
  /** Catalog entry: the per-version metadata projection. */
  catalogEntry: NugetCatalogEntry;
  /** URL of the nupkg blob. */
  packageContent: string;
  /** Page URL the leaf belongs to. */
  registration?: string;
}

/** Per-version metadata projection embedded in a registration leaf. */
export interface NugetCatalogEntry {
  "@id": string;
  "@type": "PackageDetails";
  id: string;
  version: string;
  authors?: string;
  description?: string;
  iconUrl?: string;
  licenseUrl?: string;
  licenseExpression?: string;
  projectUrl?: string;
  tags?: string[];
  title?: string;
  summary?: string;
  packageContent: string;
  /** ISO-8601 UTC timestamp. */
  published?: string;
  listed?: boolean;
  /** Per-framework dependency groups. */
  dependencyGroups?: NugetDependencyGroup[];
  /** Aggregate target-frameworks list (for fast filter). */
  targetFrameworks?: string[];
  /** Optional SemVer 2 prerelease marker. */
  requireLicenseAcceptance?: boolean;
  /** Original packed nupkg sha512 in base64; required by SemVer 2 clients. */
  packageHash?: string;
  packageHashAlgorithm?: "SHA512";
  packageSize?: number;
}

export interface NugetDependencyGroup {
  "@type"?: "PackageDependencyGroup";
  targetFramework?: string;
  dependencies?: NugetDependency[];
}

export interface NugetDependency {
  "@type"?: "PackageDependency";
  id: string;
  range?: string;
  registration?: string;
}

// ── Nuspec parsing ─────────────────────────────────────────────────

/**
 * Subset of `.nuspec` metadata fields we project into
 * `NugetManifestMetadata`. Other fields (frameworkAssemblies,
 * references, contentFiles) are preserved in the operator-uploaded
 * nupkg bytes verbatim; we only extract what registration + search
 * need.
 */
export interface NuspecMetadata {
  id: string;
  version: string;
  authors?: string;
  owners?: string;
  description?: string;
  summary?: string;
  title?: string;
  tags?: string[];
  projectUrl?: string;
  licenseUrl?: string;
  licenseExpression?: string;
  iconUrl?: string;
  requireLicenseAcceptance?: boolean;
  dependencyGroups?: NugetDependencyGroup[];
  targetFrameworks?: string[];
}

// ── Error envelope ─────────────────────────────────────────────────

/**
 * NuGet v3 doesn't standardise a JSON error envelope — clients read
 * the HTTP status code and the message body as plain text. We emit
 * a small JSON envelope on 4XX for operator tooling, mirroring the
 * Maven + PyPI facades. `dotnet` only reads the status code.
 */
export interface NugetErrorEnvelope {
  errors: Array<{
    code: NugetErrorCode;
    message: string;
    detail?: unknown;
  }>;
}

export const NUGET_ERROR_CODES = {
  PACKAGE_ID_INVALID: "PACKAGE_ID_INVALID",
  VERSION_INVALID: "VERSION_INVALID",
  PACKAGE_NOT_FOUND: "PACKAGE_NOT_FOUND",
  VERSION_NOT_FOUND: "VERSION_NOT_FOUND",
  CONFLICT: "CONFLICT",
  UPLOAD_INVALID: "UPLOAD_INVALID",
  NUPKG_INVALID: "NUPKG_INVALID",
  NUSPEC_INVALID: "NUSPEC_INVALID",
  UNAUTHORIZED: "UNAUTHORIZED",
  RESOURCE_NOT_FOUND: "RESOURCE_NOT_FOUND",
} as const;

export type NugetErrorCode =
  (typeof NUGET_ERROR_CODES)[keyof typeof NUGET_ERROR_CODES];
