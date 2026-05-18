/**
 * Aggregate Maven route mount. `buildApp` calls `mountMavenRoutes`
 * once; this composes the read + publish blocks plus the optional
 * virtual-upstream proxy hook.
 */

import type { Router } from "../http/router.js";
import type { SqliteManifestIndex } from "../storage/sqlite-index.js";
import type { RegistryStorage } from "../types.js";
import type { UpstreamFetch } from "../cargo/index.js";
import { mountMavenReadRoutes } from "./read.js";
import { mountMavenPublishRoutes } from "./publish.js";
import { proxyMavenArtifact, proxyMavenMetadata } from "./virtual.js";
import type { MavenSnapshotPolicy } from "./types.js";

export interface MountMavenOptions {
  storage: RegistryStorage;
  index: SqliteManifestIndex;
  maxBodyBytes?: number;
  /** WS13 M2: injectable upstream fetcher for tests. */
  virtualUpstreamFetch?: UpstreamFetch;
  /** Operator Ed25519 PEM used to re-sign cached rows. */
  virtualResignPrivateKeyPem?: string;
  /** Default snapshot policy. M0-locked default: 'reject'. */
  defaultSnapshotPolicy?: MavenSnapshotPolicy;
}

export function mountMavenRoutes(router: Router, opts: MountMavenOptions): void {
  const virtualOpts = {
    storage: opts.storage,
    index: opts.index,
    ...(opts.virtualUpstreamFetch ? { fetch: opts.virtualUpstreamFetch } : {}),
    ...(opts.virtualResignPrivateKeyPem
      ? { signingPrivateKeyPem: opts.virtualResignPrivateKeyPem }
      : {}),
  };

  // Publish routes MUST be mounted before read routes — both share
  // the same `/maven/:org/*rest` shape but with different methods
  // (PUT vs GET); the router dispatches by method, so order doesn't
  // matter for correctness, but mounting publish first matches the
  // PyPI pattern.
  mountMavenPublishRoutes(router, {
    storage: opts.storage,
    index: opts.index,
    ...(opts.maxBodyBytes !== undefined ? { maxBodyBytes: opts.maxBodyBytes } : {}),
    ...(opts.defaultSnapshotPolicy
      ? { defaultSnapshotPolicy: opts.defaultSnapshotPolicy }
      : {}),
  });

  mountMavenReadRoutes(router, {
    storage: opts.storage,
    proxyArtifact: (org, groupId, artifactId, baseVersion, filename) =>
      proxyMavenArtifact(virtualOpts, org, groupId, artifactId, baseVersion, filename),
    proxyMetadata: (org, groupId, artifactId, baseVersion) =>
      proxyMavenMetadata(virtualOpts, org, groupId, artifactId, baseVersion),
  });
}
