/**
 * Public entrypoint for `@signalman/registry`.
 *
 * Re-exports the types, storage drivers, signing helpers, HTTP
 * application factory, and server bootstrap so embedders can build
 * a registry process in their own host. The `signalman-registry`
 * BlobDriver in `@signalman/host` imports nothing from this
 * entrypoint; it only talks to the registry over HTTP.
 */

export type {
  Blob,
  BlobRef,
  CargoDependency,
  CargoManifestMetadata,
  Manifest,
  ManifestKind,
  ManifestSignature,
  ManifestWithProvenance,
  ListedManifest,
  NpmManifestMetadata,
  Provenance,
  RegistryStorage,
  RegistryErrorCode,
} from "./types.js";
export {
  RegistryError,
  REGISTRY_ERROR_CODES,
  parseBlobRef,
  formatBlobRef,
  validateManifestName,
  validateManifestVersion,
  validateSha256,
} from "./types.js";

export {
  generateKeypair,
  fingerprintPublicKey,
  canonicalManifestBytes,
  signManifest,
  verifyManifest,
  verifyManifestInline,
  SignatureVerificationError,
} from "./signing.js";
export type { Keypair, SignedManifest } from "./signing.js";

export { LocalFsBlobStore } from "./storage/local-fs.js";
export type { LocalFsBlobStoreOptions } from "./storage/local-fs.js";
export { SqliteManifestIndex } from "./storage/sqlite-index.js";
export type {
  AuditAction,
  AuditEntityType,
  RegistryAuditEntry,
  SqliteManifestIndexOptions,
  VirtualUpstream,
  VirtualUpstreamConfig,
  VirtualUpstreamKind,
} from "./storage/sqlite-index.js";
export { LocalFsRegistryStorage } from "./storage/registry-storage.js";
export type { LocalFsRegistryStorageOptions } from "./storage/registry-storage.js";

export { buildApp } from "./http/app.js";
export type { AppOptions } from "./http/app.js";
export { createServer } from "./http/server.js";
export type { CreateServerOptions, ServerHandle } from "./http/server.js";
export { parseBearerToken, makeAuthenticator } from "./http/auth.js";
export type {
  AuthOptions,
  ParsedToken,
} from "./http/auth.js";
export { HttpError, mapError } from "./http/errors.js";
export type { HttpErrorBody } from "./http/errors.js";
