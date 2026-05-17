/**
 * Public surface of the PyPI facade (WS13 M1, v0.6).
 */

export {
  PYPI_MEDIA_TYPES,
  PYPI_API_VERSION,
  PYPI_ERROR_CODES,
  TWINE_REQUIRED_FIELDS,
  type TwineFileType,
  type TwineUpload,
  type PypiErrorCode,
  type PypiErrorEnvelope,
  type PypiSimpleFile,
  type PypiSimpleProjectListResponse,
  type PypiSimpleProjectResponse,
} from "./types.js";

export {
  PypiError,
  pypiErrorStatus,
  toEnvelope,
  writePypiError,
  asPypiError,
} from "./errors.js";

export {
  normalisePypiName,
  validatePypiVersion,
  parseWheelFilename,
  parseSdistFilename,
  classifyFiletype,
  pypiManifestName,
  parsePypiManifestName,
  pypiFilePath,
  type WheelFilename,
  type SdistFilename,
} from "./paths.js";

export {
  extractBoundary,
  parseMultipart,
  type MultipartField,
  type ParsedMultipart,
} from "./multipart.js";

export {
  parseUploadBody,
  singleField,
  repeatedField,
} from "./guards.js";

export {
  negotiateSimpleFormat,
  renderPackageHtml,
  renderRootHtml,
  writeSimpleHtml,
  writeSimpleJson,
} from "./http.js";

export {
  mountPypiReadRoutes,
  type MountPypiReadOptions,
  type PypiFileSummary,
} from "./read.js";

export {
  mountPypiPublishRoutes,
  type MountPypiPublishOptions,
} from "./publish.js";

export {
  proxyPypiPackage,
  proxyPypiFile,
  type VirtualPypiOptions,
} from "./virtual.js";

export {
  mountPypiRoutes,
  type MountPypiOptions,
} from "./mount.js";
