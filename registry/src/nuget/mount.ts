/**
 * Aggregate NuGet route mount. `buildApp` calls `mountNugetRoutes`
 * once; this composes the service-index + flat-container +
 * registration + publish blocks plus the optional virtual-upstream
 * proxy hooks.
 */

import type { Router } from "../http/router.js";
import type { SqliteManifestIndex } from "../storage/sqlite-index.js";
import type { RegistryStorage } from "../types.js";
import type { UpstreamFetch } from "../cargo/index.js";
import { mountNugetServiceIndexRoute } from "./service-index.js";
import { mountNugetFlatContainerRoutes } from "./flat-container.js";
import { mountNugetRegistrationRoutes } from "./registration.js";
import { mountNugetPublishRoutes } from "./publish.js";
import { proxyNugetNupkg, proxyNugetVersionIndex } from "./virtual.js";

export interface MountNugetOptions {
  storage: RegistryStorage;
  index: SqliteManifestIndex;
  maxBodyBytes?: number;
  publicBaseUrl?: string;
  /** Injectable upstream fetcher for tests. */
  virtualUpstreamFetch?: UpstreamFetch;
  /** Operator Ed25519 PEM used to re-sign cached rows. */
  virtualResignPrivateKeyPem?: string;
}

export function mountNugetRoutes(router: Router, opts: MountNugetOptions): void {
  const virtualOpts = {
    storage: opts.storage,
    index: opts.index,
    ...(opts.virtualUpstreamFetch ? { fetch: opts.virtualUpstreamFetch } : {}),
    ...(opts.virtualResignPrivateKeyPem
      ? { signingPrivateKeyPem: opts.virtualResignPrivateKeyPem }
      : {}),
  };

  mountNugetServiceIndexRoute(router, {
    ...(opts.publicBaseUrl ? { publicBaseUrl: opts.publicBaseUrl } : {}),
  });

  mountNugetFlatContainerRoutes(router, {
    storage: opts.storage,
    proxyNupkg: (org, id, version) =>
      proxyNugetNupkg(virtualOpts, org, id, version),
    proxyVersionIndex: (org, id) =>
      proxyNugetVersionIndex(virtualOpts, org, id),
  });

  mountNugetRegistrationRoutes(router, {
    storage: opts.storage,
    proxyRegistration: (org, id) =>
      proxyNugetVersionIndex(virtualOpts, org, id),
    ...(opts.publicBaseUrl ? { publicBaseUrl: opts.publicBaseUrl } : {}),
  });

  mountNugetPublishRoutes(router, {
    storage: opts.storage,
    index: opts.index,
    ...(opts.maxBodyBytes !== undefined
      ? { maxBodyBytes: opts.maxBodyBytes }
      : {}),
  });
}
