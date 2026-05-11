/**
 * Public surface of the build module.
 */

export {
  BuildYamlSchema,
  BuildYamlValidationError,
  UnknownBuildVariableError,
  substituteComponent,
  substituteVariables,
  validateBuildYaml,
} from "./yaml.js";
export type {
  BlobArtifact,
  BuildArtifact,
  BuildComponent,
  BuildVariables,
  BuildYaml,
  ImageRefArtifact,
} from "./yaml.js";

export {
  buildManifest,
  hashManifest,
} from "./manifest.js";
export type { ManifestEntry, ReleaseManifest } from "./manifest.js";

export {
  ComponentBuildError,
  MissingArtifactError,
  ReleaseAlreadyExistsError,
  runBuild,
} from "./executor.js";
export type { RunBuildOptions, RunBuildResult } from "./executor.js";
