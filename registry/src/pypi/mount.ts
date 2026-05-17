/**
 * Aggregate PyPI route mount. `buildApp` calls `mountPypiRoutes` once;
 * this composes the read + publish blocks plus the optional virtual-
 * upstream proxy hooks (same shape as `oci/mount.ts`).
 */

import type { Router } from "../http/router.js";
import type { LocalFsBlobStore } from "../storage/local-fs.js";
import type { SqliteManifestIndex } from "../storage/sqlite-index.js";
import type { RegistryStorage } from "../types.js";
import { mountPypiReadRoutes } from "./read.js";
import { mountPypiPublishRoutes } from "./publish.js";
import { proxyPypiFile, proxyPypiPackage } from "./virtual.js";
import type { UpstreamFetch } from "../cargo/index.js";

export interface MountPypiOptions {
  storage: RegistryStorage;
  index: SqliteManifestIndex;
  /** Required for blob writes during proxy file-fetch. */
  blobStore?: LocalFsBlobStore;
  publicBaseUrl?: string;
  maxBodyBytes?: number;
  /** WS13 M1: injectable upstream fetcher for tests. */
  virtualUpstreamFetch?: UpstreamFetch;
  /** Operator Ed25519 PEM used to re-sign cached rows. */
  virtualResignPrivateKeyPem?: string;
}

export function mountPypiRoutes(router: Router, opts: MountPypiOptions): void {
  // Compose the virtual-upstream proxy hooks once. They no-op when
  // no virtual_upstream rows match at request time, so wiring them
  // unconditionally is safe.
  const virtualOpts = {
    storage: opts.storage,
    index: opts.index,
    ...(opts.virtualUpstreamFetch ? { fetch: opts.virtualUpstreamFetch } : {}),
    ...(opts.virtualResignPrivateKeyPem
      ? { signingPrivateKeyPem: opts.virtualResignPrivateKeyPem }
      : {}),
  };

  mountPypiReadRoutes(router, {
    storage: opts.storage,
    ...(opts.publicBaseUrl ? { publicBaseUrl: opts.publicBaseUrl } : {}),
    proxyPackage: (org, pkg) => proxyPypiPackage(virtualOpts, org, pkg),
    proxyFile: (org, pkg, filename) =>
      proxyPypiFile(virtualOpts, org, pkg, filename),
  });

  mountPypiPublishRoutes(router, {
    storage: opts.storage,
    index: opts.index,
    ...(opts.maxBodyBytes !== undefined ? { maxBodyBytes: opts.maxBodyBytes } : {}),
  });
}
