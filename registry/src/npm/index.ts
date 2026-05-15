/**
 * Public surface of the npm facade (v0.1.1).
 *
 * Lets `npm install` + `npm publish` work against a Signalman
 * registry. Per-org namespacing under `/npm/<org>/`. Virtual
 * pull-through against npmjs.com (or any npm-compatible mirror).
 *
 * Phased delivery within v0.1.1:
 *   - paths.ts: name validation + storage-key composition
 *   - read.ts: packument + tarball download (+ virtual fallback)
 *   - publish.ts: PUT /<package> publish (+ audit log)
 *   - virtual.ts: pull-through cache with re-signing
 *
 * Future v0.1.x:
 *   - Mutable dist-tags (`latest`, `staging`) via PUT /<package>/-rev/...
 *   - Unpublish via DELETE (npm typically disables this server-side
 *     for security; we follow the same conservative default)
 *   - npm audit endpoint (POST /-/v1/security/audits) — feeds v0.1.3
 *     OSV-integration milestone
 */

export {
  validateNpmPackageName,
  validateNpmOrgName,
  npmManifestName,
  packageFromManifestName,
} from "./paths.js";

export {
  mountNpmReadRoutes,
  packumentVersionEntry,
  type MountNpmReadOptions,
} from "./read.js";

export {
  mountNpmPublishRoutes,
  parseNpmPublishBody,
  publishVersionToStored,
  type MountNpmPublishOptions,
} from "./publish.js";

export {
  proxyNpmPackument,
  proxyNpmTarball,
  type VirtualNpmOptions,
} from "./virtual.js";
