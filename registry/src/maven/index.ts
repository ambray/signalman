/**
 * Public surface of the Maven facade (WS13 M2, v0.6).
 */

export {
  MAVEN_MEDIA_TYPES,
  MAVEN_PRIMARY_EXTENSIONS,
  MAVEN_CHECKSUM_EXTENSIONS,
  MAVEN_SIGNATURE_EXTENSIONS,
  MAVEN_ERROR_CODES,
  type MavenPrimaryExtension,
  type MavenChecksumExtension,
  type MavenSignatureExtension,
  type MavenCoordinate,
  type MavenSnapshotResolution,
  type MavenSnapshotPolicy,
  type MavenArtifactMetadata,
  type MavenSnapshotMetadata,
  type MavenErrorCode,
  type MavenErrorEnvelope,
} from "./types.js";

export {
  MavenError,
  mavenErrorStatus,
  toEnvelope,
  writeMavenError,
  asMavenError,
} from "./errors.js";

export {
  validateMavenGroupId,
  validateMavenArtifactId,
  validateMavenVersion,
  validateMavenClassifier,
  isSnapshotVersion,
  parseResolvedSnapshot,
  snapshotBaseVersion,
  groupPath,
  parseGroupPath,
  composeMavenFilename,
  composeMavenPath,
  parseMavenPath,
  mavenManifestName,
  parseMavenManifestName,
  mavenManifestVersion,
} from "./paths.js";

export {
  enforceSnapshotPolicy,
  classifyExtension,
  splitMultiExtension,
  filenameOfCoveredArtifact,
  parseChecksumPayload,
  type ExtensionRole,
} from "./guards.js";

export {
  parseArtifactMetadata,
  parseSnapshotMetadata,
  composeArtifactMetadata,
  composeSnapshotMetadata,
  deriveArtifactMetadata,
} from "./maven-metadata.js";

export {
  mountMavenReadRoutes,
  type MountMavenReadOptions,
} from "./read.js";

export {
  mountMavenPublishRoutes,
  type MountMavenPublishOptions,
} from "./publish.js";

export {
  proxyMavenArtifact,
  type VirtualMavenOptions,
} from "./virtual.js";

export {
  mountMavenRoutes,
  type MountMavenOptions,
} from "./mount.js";
