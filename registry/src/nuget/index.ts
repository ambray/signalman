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

export {
  composeServiceIndex,
  mountNugetServiceIndexRoute,
  type MountNugetServiceIndexOptions,
} from "./service-index.js";

export {
  mountNugetFlatContainerRoutes,
  type MountNugetFlatContainerOptions,
} from "./flat-container.js";

export {
  composeRegistrationIndex,
  composeRegistrationLeaf,
  mountNugetRegistrationRoutes,
  type MountNugetRegistrationOptions,
} from "./registration.js";

export {
  mountNugetPublishRoutes,
  type MountNugetPublishOptions,
} from "./publish.js";

export {
  proxyNugetNupkg,
  proxyNugetVersionIndex,
  type VirtualNugetOptions,
} from "./virtual.js";

export {
  mountNugetRoutes,
  type MountNugetOptions,
} from "./mount.js";
