/**
 * Public surface of the OCI Distribution Spec facade (WS10, v0.5).
 *
 * Phased delivery within v0.5:
 *   - M1 (this file lands the public surface): types, error
 *     envelope, repository-name + reference parsers, strict-
 *     validating guards, migration 0004.
 *   - M2: blob protocol — `/v2/<name>/blobs/*` with chunked upload
 *     state machine and 24-hour persisted UUID reaper.
 *   - M3: manifest protocol — `/v2/<name>/manifests/*` + tag table.
 *   - M4: `_catalog` + `tags/list` + bearer-challenge auth flow.
 *   - M5: virtual upstream pull-through against Docker Hub + GHCR +
 *     ECR with operator-keypair re-signing.
 *   - M6: cosign-style signing (the `<digest>.sig` tag convention).
 *   - M7: distribution-spec conformance suite + README + 4-lens audit.
 */

export {
  OCI_MEDIA_TYPES,
  DOCKER_MEDIA_TYPES,
  SINGLE_MANIFEST_MEDIA_TYPES,
  INDEX_MEDIA_TYPES,
  OCI_ERROR_CODES,
  type OciDescriptor,
  type OciPlatform,
  type OciManifest,
  type OciIndex,
  type OciConfig,
  type CosignSimpleSigningPayload,
  type OciErrorCode,
  type OciErrorEnvelope,
} from "./types.js";

export {
  OciError,
  ociErrorStatus,
  toEnvelope,
  envelope,
  maxStatus,
} from "./errors.js";

export {
  validateOciRepositoryName,
  validateOciTag,
  validateOciDigest,
  parseOciReference,
  ociManifestName,
  parseOciManifestName,
  type OciReference,
} from "./paths.js";

export {
  parseDescriptor,
  parseOciManifest,
  parseOciIndex,
  parseManifestOrIndex,
} from "./guards.js";

export {
  mountOciBlobRoutes,
  type MountOciBlobOptions,
} from "./blobs.js";

export {
  mountOciManifestRoutes,
  type MountOciManifestOptions,
} from "./manifests.js";

export {
  TagStore,
  type TagRow,
  type TagStoreOptions,
} from "./tag-store.js";

export {
  mountOciAuthRoutes,
  type MountOciAuthOptions,
} from "./auth.js";

export {
  mountOciCatalogRoutes,
  type MountOciCatalogOptions,
} from "./catalog.js";

export {
  mintJwt,
  verifyJwt,
  looksLikeJwt,
  publicKeyPemFromPrivate,
  JwtError,
  type JwtClaims,
  type MintJwtOptions,
  type MintedJwt,
  type VerifyJwtOptions,
  type VerifiedJwt,
} from "./jwt.js";

export {
  proxyOciManifest,
  proxyOciBlob,
  type VirtualOciOptions,
  type ProxiedManifest,
  type ProxiedBlob,
} from "./virtual.js";

export {
  createUpstreamAuthAdapter,
  dockerHubAuthAdapter,
  ghcrAuthAdapter,
  ecrAuthAdapter,
  type UpstreamAuthAdapter,
  type UpstreamAuthorizationScope,
  type UpstreamAuthHeader,
  type UpstreamFlavor,
  type DockerHubAdapterOptions,
  type GhcrAdapterOptions,
  type EcrAdapterOptions,
  type AdapterFactoryOptions,
} from "./upstream-auth.js";

export { signSigV4Request, type SignSigV4Options, type SignedRequest } from "./sigv4.js";

export {
  mountOciRoutes,
  type MountOciOptions,
  type MountedOciHandles,
} from "./mount.js";

export {
  UploadStore,
  DEFAULT_UPLOAD_TTL_SECONDS,
  type PendingUploadChunk,
  type PendingUploadRow,
  type UploadStoreOptions,
} from "./upload-store.js";

export {
  UploadFsStore,
  validateUploadId,
  type UploadFsStoreOptions,
} from "./upload-fs.js";

export {
  startReaper,
  type ReaperHandle,
  type ReaperOptions,
} from "./reaper.js";

export {
  parseContentRange,
  contentRangeLength,
  writeOciError,
  writeUploadAccepted,
  writeBlobCreated,
  setDockerContentDigest,
  asOciError,
  type ContentRange,
} from "./http.js";
