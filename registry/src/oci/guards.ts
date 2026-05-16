/**
 * Strict-validating parsers for OCI manifest + index + descriptor
 * bodies. Manifests come from untrusted HTTP clients; every field is
 * validated before persistence per the WS10 conventions
 * ("Treat the OCI manifest JSON as hostile until proven otherwise").
 *
 * Each function takes `unknown` (the parsed JSON body) and returns
 * the strongly-typed value on success, or throws `OciError` with a
 * spec-compliant code on failure. The HTTP layer wraps the throw in
 * an `OciErrorEnvelope` response.
 *
 * The `mediaType` field on the manifest is validated against the
 * registry's accepted-media-type allowlists in `./types.ts` so that
 * an attacker can't smuggle an unknown manifest variant. Future
 * media-type expansion is one allowlist-set update away.
 */

import { OciError } from "./errors.js";
import {
  INDEX_MEDIA_TYPES,
  OCI_ERROR_CODES,
  OCI_MEDIA_TYPES,
  SINGLE_MANIFEST_MEDIA_TYPES,
  type OciDescriptor,
  type OciIndex,
  type OciManifest,
  type OciPlatform,
} from "./types.js";

const SHA256_DIGEST = /^sha256:[a-f0-9]{64}$/;

/**
 * Parse + validate a JSON descriptor (`{ mediaType, digest, size, ...}`).
 *
 * `context` is prepended to error messages so callers can pin which
 * descriptor failed (e.g. `"layers[2]"`, `"config"`).
 */
export function parseDescriptor(
  value: unknown,
  context: string,
): OciDescriptor {
  if (!isObject(value)) {
    throw new OciError(
      OCI_ERROR_CODES.MANIFEST_INVALID,
      `${context} must be an object`,
    );
  }
  const mediaType = value.mediaType;
  if (typeof mediaType !== "string" || mediaType.length === 0) {
    throw new OciError(
      OCI_ERROR_CODES.MANIFEST_INVALID,
      `${context}.mediaType must be a non-empty string`,
    );
  }
  const digest = value.digest;
  if (typeof digest !== "string" || !SHA256_DIGEST.test(digest)) {
    throw new OciError(
      OCI_ERROR_CODES.DIGEST_INVALID,
      `${context}.digest must be 'sha256:<64-hex-lowercase>'`,
    );
  }
  const size = value.size;
  if (
    typeof size !== "number" ||
    !Number.isInteger(size) ||
    size < 0 ||
    !Number.isSafeInteger(size)
  ) {
    throw new OciError(
      OCI_ERROR_CODES.SIZE_INVALID,
      `${context}.size must be a non-negative integer`,
    );
  }
  const out: OciDescriptor = { mediaType, digest, size };
  if (value.annotations !== undefined) {
    out.annotations = parseAnnotations(value.annotations, `${context}.annotations`);
  }
  if (value.urls !== undefined) {
    if (!Array.isArray(value.urls)) {
      throw new OciError(
        OCI_ERROR_CODES.MANIFEST_INVALID,
        `${context}.urls must be an array when present`,
      );
    }
    for (let i = 0; i < value.urls.length; i++) {
      if (typeof value.urls[i] !== "string") {
        throw new OciError(
          OCI_ERROR_CODES.MANIFEST_INVALID,
          `${context}.urls[${i}] must be a string`,
        );
      }
    }
    out.urls = value.urls as string[];
  }
  if (value.platform !== undefined) {
    out.platform = parsePlatform(value.platform, `${context}.platform`);
  }
  if (value.artifactType !== undefined) {
    if (typeof value.artifactType !== "string") {
      throw new OciError(
        OCI_ERROR_CODES.MANIFEST_INVALID,
        `${context}.artifactType must be a string`,
      );
    }
    out.artifactType = value.artifactType;
  }
  return out;
}

/**
 * Parse + validate an OCI image manifest body (single platform).
 * Accepts both OCI v1 and Docker v2.2 manifest media types per the
 * allowlist in `./types.ts`.
 */
export function parseOciManifest(value: unknown): OciManifest {
  if (!isObject(value)) {
    throw new OciError(
      OCI_ERROR_CODES.MANIFEST_INVALID,
      `manifest must be a JSON object`,
    );
  }
  if (value.schemaVersion !== 2) {
    throw new OciError(
      OCI_ERROR_CODES.MANIFEST_INVALID,
      `manifest.schemaVersion must be 2`,
    );
  }
  const mediaType = value.mediaType;
  if (typeof mediaType !== "string" || !SINGLE_MANIFEST_MEDIA_TYPES.has(mediaType)) {
    throw new OciError(
      OCI_ERROR_CODES.MANIFEST_INVALID,
      `manifest.mediaType '${String(mediaType)}' is not a recognised single-platform manifest type`,
    );
  }
  if (!isObject(value.config)) {
    throw new OciError(
      OCI_ERROR_CODES.MANIFEST_INVALID,
      `manifest.config is required`,
    );
  }
  const config = parseDescriptor(value.config, "config");
  if (!Array.isArray(value.layers)) {
    throw new OciError(
      OCI_ERROR_CODES.MANIFEST_INVALID,
      `manifest.layers must be an array`,
    );
  }
  const layers: OciDescriptor[] = [];
  for (let i = 0; i < value.layers.length; i++) {
    layers.push(parseDescriptor(value.layers[i], `layers[${i}]`));
  }
  const out: OciManifest = {
    schemaVersion: 2,
    mediaType,
    config,
    layers,
  };
  if (value.annotations !== undefined) {
    out.annotations = parseAnnotations(value.annotations, "annotations");
  }
  if (value.subject !== undefined) {
    out.subject = parseDescriptor(value.subject, "subject");
  }
  if (value.artifactType !== undefined) {
    if (typeof value.artifactType !== "string") {
      throw new OciError(
        OCI_ERROR_CODES.MANIFEST_INVALID,
        `manifest.artifactType must be a string`,
      );
    }
    out.artifactType = value.artifactType;
  }
  return out;
}

/**
 * Parse + validate an OCI image index body (multi-platform). Accepts
 * both OCI v1 index and Docker v2.2 manifest-list types. Every child
 * descriptor is itself parsed; descriptors in an index typically
 * carry `platform`, but the spec does not strictly require it for
 * artifact manifests, so `platform` is optional here.
 */
export function parseOciIndex(value: unknown): OciIndex {
  if (!isObject(value)) {
    throw new OciError(
      OCI_ERROR_CODES.MANIFEST_INVALID,
      `index must be a JSON object`,
    );
  }
  if (value.schemaVersion !== 2) {
    throw new OciError(
      OCI_ERROR_CODES.MANIFEST_INVALID,
      `index.schemaVersion must be 2`,
    );
  }
  const mediaType = value.mediaType;
  if (typeof mediaType !== "string" || !INDEX_MEDIA_TYPES.has(mediaType)) {
    throw new OciError(
      OCI_ERROR_CODES.MANIFEST_INVALID,
      `index.mediaType '${String(mediaType)}' is not a recognised index/manifest-list type`,
    );
  }
  if (!Array.isArray(value.manifests)) {
    throw new OciError(
      OCI_ERROR_CODES.MANIFEST_INVALID,
      `index.manifests must be an array`,
    );
  }
  const manifests: OciDescriptor[] = [];
  for (let i = 0; i < value.manifests.length; i++) {
    manifests.push(parseDescriptor(value.manifests[i], `manifests[${i}]`));
  }
  const out: OciIndex = {
    schemaVersion: 2,
    mediaType,
    manifests,
  };
  if (value.annotations !== undefined) {
    out.annotations = parseAnnotations(value.annotations, "annotations");
  }
  if (value.subject !== undefined) {
    out.subject = parseDescriptor(value.subject, "subject");
  }
  if (value.artifactType !== undefined) {
    if (typeof value.artifactType !== "string") {
      throw new OciError(
        OCI_ERROR_CODES.MANIFEST_INVALID,
        `index.artifactType must be a string`,
      );
    }
    out.artifactType = value.artifactType;
  }
  return out;
}

/**
 * Discriminating parser — accepts either a single-platform manifest
 * or an image index based on the `mediaType` field. Useful for the
 * PUT manifest handler that doesn't know in advance which kind the
 * client is pushing.
 */
export function parseManifestOrIndex(
  value: unknown,
): { kind: "manifest"; value: OciManifest } | { kind: "index"; value: OciIndex } {
  if (!isObject(value)) {
    throw new OciError(
      OCI_ERROR_CODES.MANIFEST_INVALID,
      `manifest must be a JSON object`,
    );
  }
  const mediaType = value.mediaType;
  if (typeof mediaType !== "string") {
    throw new OciError(
      OCI_ERROR_CODES.MANIFEST_INVALID,
      `manifest.mediaType must be a string`,
    );
  }
  if (INDEX_MEDIA_TYPES.has(mediaType)) {
    return { kind: "index", value: parseOciIndex(value) };
  }
  if (SINGLE_MANIFEST_MEDIA_TYPES.has(mediaType)) {
    return { kind: "manifest", value: parseOciManifest(value) };
  }
  throw new OciError(
    OCI_ERROR_CODES.MANIFEST_INVALID,
    `manifest.mediaType '${mediaType}' is not recognised by this registry`,
  );
}

function parsePlatform(value: unknown, context: string): OciPlatform {
  if (!isObject(value)) {
    throw new OciError(
      OCI_ERROR_CODES.MANIFEST_INVALID,
      `${context} must be an object`,
    );
  }
  const architecture = value.architecture;
  if (typeof architecture !== "string" || architecture.length === 0) {
    throw new OciError(
      OCI_ERROR_CODES.MANIFEST_INVALID,
      `${context}.architecture must be a non-empty string`,
    );
  }
  const os = value.os;
  if (typeof os !== "string" || os.length === 0) {
    throw new OciError(
      OCI_ERROR_CODES.MANIFEST_INVALID,
      `${context}.os must be a non-empty string`,
    );
  }
  const out: OciPlatform = { architecture, os };
  if (value["os.version"] !== undefined) {
    if (typeof value["os.version"] !== "string") {
      throw new OciError(
        OCI_ERROR_CODES.MANIFEST_INVALID,
        `${context}['os.version'] must be a string`,
      );
    }
    out["os.version"] = value["os.version"];
  }
  if (value["os.features"] !== undefined) {
    if (!Array.isArray(value["os.features"])) {
      throw new OciError(
        OCI_ERROR_CODES.MANIFEST_INVALID,
        `${context}['os.features'] must be an array`,
      );
    }
    for (let i = 0; i < value["os.features"].length; i++) {
      if (typeof value["os.features"][i] !== "string") {
        throw new OciError(
          OCI_ERROR_CODES.MANIFEST_INVALID,
          `${context}['os.features'][${i}] must be a string`,
        );
      }
    }
    out["os.features"] = value["os.features"] as string[];
  }
  if (value.variant !== undefined) {
    if (typeof value.variant !== "string") {
      throw new OciError(
        OCI_ERROR_CODES.MANIFEST_INVALID,
        `${context}.variant must be a string`,
      );
    }
    out.variant = value.variant;
  }
  if (value.features !== undefined) {
    if (!Array.isArray(value.features)) {
      throw new OciError(
        OCI_ERROR_CODES.MANIFEST_INVALID,
        `${context}.features must be an array`,
      );
    }
    for (let i = 0; i < value.features.length; i++) {
      if (typeof value.features[i] !== "string") {
        throw new OciError(
          OCI_ERROR_CODES.MANIFEST_INVALID,
          `${context}.features[${i}] must be a string`,
        );
      }
    }
    out.features = value.features as string[];
  }
  return out;
}

function parseAnnotations(value: unknown, context: string): Record<string, string> {
  if (!isObject(value)) {
    throw new OciError(
      OCI_ERROR_CODES.MANIFEST_INVALID,
      `${context} must be an object`,
    );
  }
  const out: Record<string, string> = {};
  for (const key of Object.keys(value)) {
    const v = (value as Record<string, unknown>)[key];
    if (typeof v !== "string") {
      throw new OciError(
        OCI_ERROR_CODES.MANIFEST_INVALID,
        `${context}[${JSON.stringify(key)}] must be a string`,
      );
    }
    out[key] = v;
  }
  return out;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Re-export the media-type constants so callers can import everything
 * OCI-shaped from a single barrel without crossing into ./types.ts
 * directly. This keeps the public surface of the guards module wide
 * enough for consumers like the M3 manifest handler.
 */
export { OCI_MEDIA_TYPES };
