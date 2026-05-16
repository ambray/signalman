/**
 * Aggregate OCI mount point. `buildApp` calls `mountOciRoutes(router, ...)`
 * once; this module composes the per-milestone route blocks:
 *
 *   M2 — blobs (`./blobs.ts`)
 *   M3 — manifests (lands later)
 *   M4 — catalog + tags + bearer challenge (lands later)
 *   M5 — virtual upstream (lands later)
 *   M6 — cosign sign/verify (lands later)
 *
 * Keeping them behind one mount call lets `buildApp` stay agnostic
 * to which OCI subsystems are active. The reaper handle is returned
 * so the caller can stop it on shutdown.
 */

import type { Router } from "../http/router.js";
import type { SqliteManifestIndex } from "../storage/sqlite-index.js";
import type { LocalFsBlobStore } from "../storage/local-fs.js";
import type { RegistryStorage } from "../types.js";
import { mountOciAuthRoutes } from "./auth.js";
import { mountOciBlobRoutes } from "./blobs.js";
import { mountOciCatalogRoutes } from "./catalog.js";
import { mountOciManifestRoutes } from "./manifests.js";
import { startReaper, type ReaperHandle } from "./reaper.js";
import { TagStore } from "./tag-store.js";
import { UploadFsStore } from "./upload-fs.js";
import { UploadStore } from "./upload-store.js";

export interface MountOciOptions {
  storage: RegistryStorage;
  index: SqliteManifestIndex;
  /** Required for upload finalize; future S3 driver supplies its own. */
  blobStore: LocalFsBlobStore;
  /** Externally-resolvable URL of this registry (Location headers). */
  publicBaseUrl?: string;
  /**
   * Tuning knobs. Production deployments take the defaults; tests
   * accelerate the reaper cadence + supply a fixed clock.
   */
  reaperIntervalMs?: number;
  uploadTtlSeconds?: number;
  now?: () => Date;
  maxChunkBytes?: number;
  /** Per-manifest body cap. Default 4 MiB (spec minimum). */
  maxManifestBytes?: number;
  /** Operator-locked Q6: default-on; flip to disable manifest DELETE. */
  allowManifestDelete?: boolean;
  /**
   * M4: Ed25519 PEM private key for JWT minting via /oci/token. The
   * matching public key is derived if `tokenPublicKeyPem` is absent.
   * When both are absent the registry runs without the bearer-
   * challenge flow (sk_<prefix>_<secret> bearers still work on /v2/*).
   */
  tokenSigningPrivateKeyPem?: string;
  /** Override the derived JWT verification key. */
  tokenPublicKeyPem?: string;
  /** JWT lifetime, seconds. Default 3600. */
  tokenTtlSeconds?: number;
  /** Default page size for /v2/_catalog + /v2/<name>/tags/list. */
  catalogDefaultPageSize?: number;
  /** Hard cap for the same routes. */
  catalogMaxPageSize?: number;
}

export interface MountedOciHandles {
  /** Stop background tasks (the upload reaper). Idempotent. */
  stop(): void;
  /** Trigger one immediate reaper sweep. Exposed for tests. */
  reaperSweep(): Promise<number>;
  uploadStore: UploadStore;
  uploadFs: UploadFsStore;
  reaper: ReaperHandle;
  tagStore: TagStore;
}

export function mountOciRoutes(
  router: Router,
  opts: MountOciOptions,
): MountedOciHandles {
  const uploadStore = new UploadStore({
    index: opts.index,
    ...(opts.now ? { now: opts.now } : {}),
    ...(opts.uploadTtlSeconds !== undefined
      ? { ttlSeconds: opts.uploadTtlSeconds }
      : {}),
  });
  const uploadFs = new UploadFsStore({ root: opts.blobStore.root });
  const tagStore = new TagStore({
    index: opts.index,
    ...(opts.now ? { now: opts.now } : {}),
  });

  mountOciBlobRoutes(router, {
    storage: opts.storage,
    index: opts.index,
    blobStore: opts.blobStore,
    uploadStore,
    uploadFs,
    ...(opts.publicBaseUrl ? { publicBaseUrl: opts.publicBaseUrl } : {}),
    ...(opts.maxChunkBytes !== undefined
      ? { maxChunkBytes: opts.maxChunkBytes }
      : {}),
    ...(opts.now ? { now: opts.now } : {}),
  });

  mountOciManifestRoutes(router, {
    storage: opts.storage,
    index: opts.index,
    tagStore,
    ...(opts.publicBaseUrl ? { publicBaseUrl: opts.publicBaseUrl } : {}),
    ...(opts.maxManifestBytes !== undefined
      ? { maxManifestBytes: opts.maxManifestBytes }
      : {}),
    ...(opts.allowManifestDelete !== undefined
      ? { allowDelete: opts.allowManifestDelete }
      : {}),
    ...(opts.now ? { now: opts.now } : {}),
  });

  mountOciCatalogRoutes(router, {
    index: opts.index,
    tagStore,
    ...(opts.publicBaseUrl ? { publicBaseUrl: opts.publicBaseUrl } : {}),
    ...(opts.catalogDefaultPageSize !== undefined
      ? { defaultPageSize: opts.catalogDefaultPageSize }
      : {}),
    ...(opts.catalogMaxPageSize !== undefined
      ? { maxPageSize: opts.catalogMaxPageSize }
      : {}),
  });

  mountOciAuthRoutes(router, {
    ...(opts.tokenSigningPrivateKeyPem
      ? { privateKeyPem: opts.tokenSigningPrivateKeyPem }
      : {}),
    ...(opts.tokenPublicKeyPem ? { publicKeyPem: opts.tokenPublicKeyPem } : {}),
    ...(opts.publicBaseUrl ? { publicBaseUrl: opts.publicBaseUrl } : {}),
    ...(opts.tokenTtlSeconds !== undefined
      ? { ttlSeconds: opts.tokenTtlSeconds }
      : {}),
    ...(opts.now ? { now: opts.now } : {}),
  });

  const reaper = startReaper({
    uploadStore,
    uploadFs,
    index: opts.index,
    ...(opts.reaperIntervalMs !== undefined
      ? { intervalMs: opts.reaperIntervalMs }
      : {}),
    ...(opts.now ? { now: opts.now } : {}),
  });

  return {
    stop(): void {
      reaper.stop();
    },
    reaperSweep: () => reaper.sweep(),
    uploadStore,
    uploadFs,
    reaper,
    tagStore,
  };
}
