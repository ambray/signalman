/**
 * Public surface of the NuGet facade (WS13 M3, v0.6).
 */

export {
  NUGET_MEDIA_TYPES,
  NUGET_RESOURCE_TYPES,
  NUGET_ERROR_CODES,
  type NugetServiceResource,
  type NugetServiceIndex,
  type NugetFlatContainerVersionIndex,
  type NugetRegistrationIndex,
  type NugetRegistrationPage,
  type NugetRegistrationLeaf,
  type NugetCatalogEntry,
  type NugetDependencyGroup,
  type NugetDependency,
  type NuspecMetadata,
  type NugetErrorCode,
  type NugetErrorEnvelope,
} from "./types.js";

export type { ParsedNugetPath } from "./paths.js";

export {
  NugetError,
  nugetErrorStatus,
  toEnvelope,
  writeNugetError,
  asNugetError,
} from "./errors.js";

export {
  validateNugetPackageId,
  validateNugetVersion,
  normalisePackageId,
  normaliseVersion,
  flatContainerNupkgPath,
  flatContainerNuspecPath,
  flatContainerIndexPath,
  parseNugetPath,
  nugetManifestName,
  parseNugetManifestName,
  nugetManifestVersion,
} from "./paths.js";

export { extractNuspecFromNupkg, parseNuspec } from "./guards.js";

// Routing-layer exports — populated in chunk 2 (service-index +
// flat-container + registration) and chunk 3 (publish + virtual +
// mount). Each module re-exports through this barrel once it lands.
