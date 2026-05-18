/**
 * Public surface of the HuggingFace facade (WS13 M4, v0.6).
 *
 * Exports the path / type / guard / error primitives; the read,
 * publish, LFS Batch, virtual-upstream, and mount layers add their
 * own re-exports in subsequent stories.
 */

export {
  HF_MEDIA_TYPES,
  HF_REPO_TYPES,
  HF_DEFAULT_REVISION,
  HF_DEFAULT_LFS_THRESHOLD,
  HF_DEFAULT_MAX_BLOB_BYTES,
  HF_ERROR_CODES,
  type HfRepoType,
  type HfRevisionRow,
  type HfRevisionFile,
  type LfsBatchRequest,
  type LfsBatchResponse,
  type LfsBatchObject,
  type LfsPointer,
  type HfTreeEntry,
  type HfErrorCode,
  type HfErrorEnvelope,
} from "./types.js";

export {
  HfError,
  hfErrorStatus,
  toEnvelope,
  writeHfError,
  asHfError,
  redactBearerToken,
  redactDetail,
} from "./errors.js";

export {
  validateHfOrgName,
  validateHfRepoName,
  validateHfRepoType,
  validateHfRevision,
  validateHfPath,
  validateHexSha256,
  parseLfsOid,
  hfManifestName,
  parseHfManifestName,
  hfManifestVersion,
  parseHfManifestVersion,
  composeHfResolvePath,
  parseHfResolvePath,
  composeHfBlobPath,
  parseHfBlobPath,
} from "./paths.js";

export {
  parseLfsPointer,
  composeLfsPointer,
  detectLfsPointer,
  enforceMaxBlobBytes,
  classifyLfsByThreshold,
  parseRangeHeader,
  type ByteRange,
} from "./guards.js";

export {
  serveHfBlob,
  type ServeHfBlobOptions,
} from "./blobs.js";

export {
  resolveHfFile,
  effectiveRevision,
  type ResolveHfFileOptions,
} from "./resolve.js";

export {
  handleLfsBatch,
  type LfsBatchHandlerOptions,
} from "./lfs.js";

export {
  publishHfTarball,
  type HfPublishInput,
  type HfPublishResult,
} from "./publish.js";

export {
  parseUstarTar,
  type TarEntry,
} from "./tar.js";
