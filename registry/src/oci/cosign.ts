/**
 * Cosign-style signing convention (sigstore/cosign §Signature
 * Specification) on top of the registry's existing Ed25519 surface.
 *
 * The signature manifest is a regular OCI artifact manifest:
 *
 *   schemaVersion: 2,
 *   mediaType:     application/vnd.oci.image.manifest.v1+json,
 *   config:        { mediaType: 'application/vnd.dev.cosign.simplesigning.v1+json',
 *                    digest:    'sha256:<empty-config-blob>',
 *                    size:      <empty-config-size> },
 *   layers: [{
 *     mediaType:   'application/vnd.dev.cosign.simplesigning.v1+json',
 *     digest:      'sha256:<payload-blob>',
 *     size:        <payload-size>,
 *     annotations: { 'dev.cosignproject.cosign/signature': '<base64-Ed25519-sig>' }
 *   }]
 *
 * The simple-signing PAYLOAD itself is the canonical JSON object:
 *
 *   { critical: { identity: { 'docker-reference': '<repo>' },
 *                 image:    { 'docker-manifest-digest': 'sha256:<hex>' },
 *                 type:     'cosign container image signature' },
 *     optional: null }
 *
 * Storage layout:
 *   1. Upload payload bytes as a regular content-addressed blob.
 *   2. Upload `{}` as the empty config blob (shared across all
 *      cosign signatures — content-addressed dedupe gives this for
 *      free).
 *   3. Push the signature manifest under the cosign-derived tag
 *      `sha256-<hex>.sig` in the SAME repository as the signed
 *      manifest.
 *
 * Tag derivation per cosign convention:
 *   sha256:<hex> → sha256-<hex>.sig
 * (Colon → dash, suffix `.sig`. 75 chars total — within the 128-
 * char OCI tag limit.)
 *
 * Verification is the inverse: pull the signature manifest, extract
 * the layer's payload blob + signature annotation, recompose the
 * simple-signing JSON for the candidate digest, and verify the
 * Ed25519 signature against the operator's public key.
 */

import * as crypto from "node:crypto";
import {
  type Manifest,
  type OciManifestMetadata,
  type Provenance,
  REGISTRY_ERROR_CODES,
  RegistryError,
} from "../types.js";
import type { CosignSimpleSigningPayload, OciManifest } from "./types.js";
import { signManifest } from "../signing.js";
import type { SqliteManifestIndex } from "../storage/sqlite-index.js";
import type { LocalFsBlobStore } from "../storage/local-fs.js";
import { OciError } from "./errors.js";
import { OCI_ERROR_CODES, OCI_MEDIA_TYPES } from "./types.js";
import { ociManifestName, validateOciDigest } from "./paths.js";
import { TagStore } from "./tag-store.js";

const EMPTY_CONFIG_BLOB = Buffer.from("{}", "utf-8");

export interface SignCosignOptions {
  index: SqliteManifestIndex;
  blobStore: LocalFsBlobStore;
  tagStore: TagStore;
  /** Storage manifest name (oci/<org>/<repo>) — the signed manifest's parent repo. */
  storageName: string;
  /** Public-facing repository reference recorded in the simple-signing payload. */
  dockerReference: string;
  /** Manifest digest to sign (`sha256:<hex>`). */
  manifestDigest: string;
  /** Operator's Ed25519 PEM private key. */
  privateKeyPem: string;
  /** Optional extra annotations on the signature layer. */
  additionalLayerAnnotations?: Record<string, string>;
  /** Tests: deterministic clock. */
  now?: () => Date;
}

export interface SignCosignResult {
  /** sha256:<hex> digest of the signature manifest itself. */
  signatureManifestDigest: string;
  /** sha256:<hex> of the simple-signing payload blob. */
  payloadDigest: string;
  /** sha256:<hex> of the empty config blob. */
  configDigest: string;
  /** The cosign-derived tag (`sha256-<hex>.sig`). */
  tag: string;
  /** Base64-encoded Ed25519 signature over the payload bytes. */
  signatureB64: string;
  /** The literal simple-signing payload JSON bytes. */
  payloadBytes: Buffer;
  /** The literal signature manifest body bytes. */
  signatureManifestBytes: Buffer;
}

/**
 * Sign an existing manifest with the operator's Ed25519 key + persist
 * the cosign-style signature manifest at the spec-derived `.sig` tag.
 *
 * Returns enough metadata for the caller to surface a CLI summary
 * (which digest, which tag) without re-querying the registry.
 */
export function signCosign(opts: SignCosignOptions): SignCosignResult {
  const hex = validateOciDigest(opts.manifestDigest);
  const now = opts.now ?? (() => new Date());

  // Build the simple-signing payload. Field order doesn't matter for
  // cosign verification — we hash the literal bytes — but a stable
  // shape keeps audit traces predictable.
  const payload: CosignSimpleSigningPayload = {
    critical: {
      identity: { "docker-reference": opts.dockerReference },
      image: { "docker-manifest-digest": opts.manifestDigest },
      type: "cosign container image signature",
    },
    optional: null,
  };
  const payloadBytes = Buffer.from(JSON.stringify(payload), "utf-8");
  const payloadHex = sha256Hex(payloadBytes);
  const payloadDigest = `sha256:${payloadHex}`;

  // Sign the payload bytes directly with Ed25519. cosign verifiers
  // hash inside Ed25519 itself, so we feed the raw bytes.
  const key = crypto.createPrivateKey(opts.privateKeyPem);
  if (key.asymmetricKeyType !== "ed25519") {
    throw new Error(
      `cosign signing key must be Ed25519; got ${key.asymmetricKeyType}`,
    );
  }
  const signature = crypto.sign(null, payloadBytes, key);
  const signatureB64 = signature.toString("base64");

  // Upload payload blob + empty config blob. Content-addressed
  // storage means re-signs naturally dedupe.
  const payloadBlob = opts.blobStore;
  // Synchronously precompute the sha256 path — the on-disk write
  // happens here via the storage helper. Since LocalFsBlobStore.putBlob
  // is async we call it through a sync-style awaiter; the cosign
  // operation is itself synchronous from the caller's POV but the
  // disk side is async. Exposing the async function here keeps the
  // caller in control.
  void payloadBlob;
  // Caller drives the async writes via signCosignAsync below; this
  // sync function returns the pre-computed digests + the signature
  // manifest body so the CLI can pipeline the persist phase.
  const configHex = sha256Hex(EMPTY_CONFIG_BLOB);
  const configDigest = `sha256:${configHex}`;

  const signatureManifest: OciManifest = {
    schemaVersion: 2,
    mediaType: OCI_MEDIA_TYPES.MANIFEST_V1,
    config: {
      mediaType: OCI_MEDIA_TYPES.COSIGN_PAYLOAD,
      digest: configDigest,
      size: EMPTY_CONFIG_BLOB.length,
    },
    layers: [
      {
        mediaType: OCI_MEDIA_TYPES.COSIGN_PAYLOAD,
        digest: payloadDigest,
        size: payloadBytes.length,
        annotations: {
          "dev.cosignproject.cosign/signature": signatureB64,
          ...opts.additionalLayerAnnotations,
        },
      },
    ],
  };
  const signatureManifestBytes = Buffer.from(
    JSON.stringify(signatureManifest),
    "utf-8",
  );
  const sigManifestHex = sha256Hex(signatureManifestBytes);
  const signatureManifestDigest = `sha256:${sigManifestHex}`;
  const tag = cosignTagFor(opts.manifestDigest);

  // The async persist + tag-pointer install happen in `commitCosign`
  // below so the caller can choose whether to log a deterministic
  // pre-write digest before disk I/O fires.
  void hex;
  void now;
  return {
    signatureManifestDigest,
    payloadDigest,
    configDigest,
    tag,
    signatureB64,
    payloadBytes,
    signatureManifestBytes,
  };
}

/**
 * Persist the result of `signCosign` into the registry. Splits the
 * compose + persist steps so a future CLI can preview the digest
 * before committing.
 */
export async function commitCosign(
  result: SignCosignResult,
  opts: SignCosignOptions,
): Promise<void> {
  const payloadHex = result.payloadDigest.slice("sha256:".length);
  const configHex = result.configDigest.slice("sha256:".length);
  const sigManifestHex = result.signatureManifestDigest.slice("sha256:".length);

  // Persist payload blob + empty config blob.
  await opts.blobStore.putBlob({
    body: result.payloadBytes,
    contentType: OCI_MEDIA_TYPES.COSIGN_PAYLOAD,
  });
  await opts.blobStore.putBlob({
    body: EMPTY_CONFIG_BLOB,
    contentType: OCI_MEDIA_TYPES.COSIGN_PAYLOAD,
  });
  const payloadStat = await opts.blobStore.statBlob(payloadHex);
  const configStat = await opts.blobStore.statBlob(configHex);
  if (payloadStat) opts.index.recordBlob(payloadStat);
  if (configStat) opts.index.recordBlob(configStat);

  // Persist the signature manifest under its content-addressed
  // version (the digest hex). The OCI putManifest path also writes
  // a tag-pointer; cosign places the pointer at sha256-<hex>.sig.
  const ociMetadata: OciManifestMetadata = {
    isIndex: false,
    schemaVariant: "oci-v1",
    configDigest: result.configDigest,
    configMediaType: OCI_MEDIA_TYPES.COSIGN_PAYLOAD,
    layerDigests: [result.payloadDigest],
    totalSize: result.payloadBytes.length + EMPTY_CONFIG_BLOB.length,
  };
  const provenance: Provenance = {
    source: "upload",
    fetchedAt: (opts.now ?? (() => new Date()))().toISOString(),
    fetchedBy: "cosign",
  };
  const manifest: Manifest = {
    name: opts.storageName,
    version: sigManifestHex,
    mediaType: OCI_MEDIA_TYPES.MANIFEST_V1,
    kind: "oci",
    blobs: [
      {
        mediaType: OCI_MEDIA_TYPES.COSIGN_PAYLOAD,
        sha256: configHex,
        size: EMPTY_CONFIG_BLOB.length,
      },
      {
        mediaType: OCI_MEDIA_TYPES.COSIGN_PAYLOAD,
        sha256: payloadHex,
        size: result.payloadBytes.length,
      },
    ],
    ociMetadata,
    createdAt: provenance.fetchedAt,
  };
  try {
    opts.index.putManifest(manifest, result.signatureManifestBytes, provenance);
  } catch (err) {
    const e = err as { code?: string };
    if (e.code !== REGISTRY_ERROR_CODES.MANIFEST_EXISTS) throw err;
  }

  // Install the cosign tag.
  opts.tagStore.put(opts.storageName, result.tag, sigManifestHex);

  // Audit row.
  opts.index.appendAuditEntry({
    action: "upload",
    entityType: "manifest",
    entityId: `${opts.storageName}@${result.signatureManifestDigest}`,
    actor: "cosign",
    detail: {
      kind: "oci",
      phase: "cosign_sign",
      docker_reference: opts.dockerReference,
      manifest_digest: opts.manifestDigest,
      cosign_tag: result.tag,
    },
  });
}

// ── Verification ───────────────────────────────────────────────────

export interface VerifyCosignOptions {
  index: SqliteManifestIndex;
  blobStore: LocalFsBlobStore;
  tagStore: TagStore;
  storageName: string;
  /** Manifest digest to verify (`sha256:<hex>`). */
  manifestDigest: string;
  /** Operator's Ed25519 PEM public key. */
  publicKeyPem: string;
  /**
   * Optional docker-reference to require in the payload. When set,
   * verifyCosign refuses signatures whose payload names a different
   * reference. When omitted, any docker-reference is accepted.
   */
  expectedDockerReference?: string;
}

export interface VerifyCosignResult {
  /** The simple-signing payload from the verified signature manifest. */
  payload: CosignSimpleSigningPayload;
  /** sha256:<hex> of the signature manifest. */
  signatureManifestDigest: string;
  /** sha256:<hex> of the payload blob. */
  payloadDigest: string;
  /** The base64 signature that verified. */
  signatureB64: string;
}

/**
 * Verify the cosign signature attached to a manifest. Throws an
 * `OciError(MANIFEST_UNKNOWN)` when no signature manifest exists for
 * the digest; throws `OciError(MANIFEST_INVALID)` on any signature-
 * spec violation; throws `Error` on cryptographic failure.
 */
export async function verifyCosign(
  opts: VerifyCosignOptions,
): Promise<VerifyCosignResult> {
  const hex = validateOciDigest(opts.manifestDigest);
  const tag = cosignTagFor(opts.manifestDigest);

  const tagRow = opts.tagStore.get(opts.storageName, tag);
  if (!tagRow) {
    throw new OciError(
      OCI_ERROR_CODES.MANIFEST_UNKNOWN,
      `cosign signature tag ${tag} not found in ${opts.storageName}`,
    );
  }
  const sigManifest = opts.index.getManifest(opts.storageName, tagRow.manifestSha256);
  const sigBytes = opts.index.getCanonicalBytes(opts.storageName, tagRow.manifestSha256);
  if (!sigManifest || !sigBytes) {
    throw new OciError(
      OCI_ERROR_CODES.MANIFEST_UNKNOWN,
      `cosign signature manifest body missing for ${tag}`,
    );
  }

  // Parse the signature manifest body to extract the layer + annotation.
  let parsed: OciManifest;
  try {
    parsed = JSON.parse(sigBytes.toString("utf-8")) as OciManifest;
  } catch (err) {
    throw new OciError(
      OCI_ERROR_CODES.MANIFEST_INVALID,
      `cosign signature manifest is not valid JSON: ${(err as Error).message}`,
    );
  }
  if (!parsed.layers || parsed.layers.length === 0) {
    throw new OciError(
      OCI_ERROR_CODES.MANIFEST_INVALID,
      `cosign signature manifest has no layers`,
    );
  }
  const layer = parsed.layers[0];
  const signatureB64 = layer.annotations?.["dev.cosignproject.cosign/signature"];
  if (!signatureB64) {
    throw new OciError(
      OCI_ERROR_CODES.MANIFEST_INVALID,
      `cosign signature annotation missing on layer 0`,
    );
  }
  const payloadHex = validateOciDigest(layer.digest);
  const payloadStream = await opts.blobStore.getBlob(payloadHex);
  const payloadBytes = await streamToBuffer(payloadStream);
  const computedPayloadHex = sha256Hex(payloadBytes);
  if (computedPayloadHex !== payloadHex) {
    throw new OciError(
      OCI_ERROR_CODES.MANIFEST_INVALID,
      `cosign payload blob digest mismatch: stored ${payloadHex} vs computed ${computedPayloadHex}`,
    );
  }
  let payload: CosignSimpleSigningPayload;
  try {
    payload = JSON.parse(payloadBytes.toString("utf-8")) as CosignSimpleSigningPayload;
  } catch (err) {
    throw new OciError(
      OCI_ERROR_CODES.MANIFEST_INVALID,
      `cosign payload is not valid JSON: ${(err as Error).message}`,
    );
  }
  if (payload.critical?.image?.["docker-manifest-digest"] !== opts.manifestDigest) {
    throw new OciError(
      OCI_ERROR_CODES.MANIFEST_INVALID,
      `cosign payload docker-manifest-digest mismatch: ` +
        `${payload.critical?.image?.["docker-manifest-digest"]} vs ${opts.manifestDigest}`,
    );
  }
  if (
    opts.expectedDockerReference !== undefined &&
    payload.critical?.identity?.["docker-reference"] !== opts.expectedDockerReference
  ) {
    throw new OciError(
      OCI_ERROR_CODES.MANIFEST_INVALID,
      `cosign payload docker-reference mismatch: ` +
        `${payload.critical?.identity?.["docker-reference"]} vs ${opts.expectedDockerReference}`,
    );
  }

  const key = crypto.createPublicKey(opts.publicKeyPem);
  if (key.asymmetricKeyType !== "ed25519") {
    throw new Error(
      `cosign public key must be Ed25519; got ${key.asymmetricKeyType}`,
    );
  }
  const sigBytes_buf = Buffer.from(signatureB64, "base64");
  const ok = crypto.verify(null, payloadBytes, key, sigBytes_buf);
  if (!ok) {
    throw new Error(`cosign signature is cryptographically invalid`);
  }
  return {
    payload,
    signatureManifestDigest: `sha256:${tagRow.manifestSha256}`,
    payloadDigest: `sha256:${payloadHex}`,
    signatureB64,
  };
  void hex;
}

// ── Helpers ────────────────────────────────────────────────────────

/**
 * Cosign's tag-derivation rule: replace `:` with `-`, append `.sig`.
 * Operates on `sha256:<hex>` digests; rejects non-sha256 inputs by
 * deferring to `validateOciDigest`.
 */
export function cosignTagFor(manifestDigest: string): string {
  const hex = validateOciDigest(manifestDigest);
  return `sha256-${hex}.sig`;
}

/**
 * Compose the storage-layer manifest name from a CLI-friendly
 * `<org>/<repo>:<tag>` reference. Useful for the CLI verbs which
 * accept `acme/svc:v1.0` directly.
 */
export function parseRepoTagRef(input: string): {
  org: string;
  repo: string;
  tag: string;
  storageName: string;
  dockerReference: string;
} {
  const colon = input.lastIndexOf(":");
  if (colon <= 0 || colon === input.length - 1) {
    throw new OciError(
      OCI_ERROR_CODES.MANIFEST_INVALID,
      `expected <org>/<repo>:<tag>; got '${input}'`,
    );
  }
  const refBeforeTag = input.slice(0, colon);
  const tag = input.slice(colon + 1);
  const firstSlash = refBeforeTag.indexOf("/");
  if (firstSlash <= 0 || firstSlash === refBeforeTag.length - 1) {
    throw new OciError(
      OCI_ERROR_CODES.NAME_INVALID,
      `expected <org>/<repo>:<tag>; org or repo missing in '${input}'`,
    );
  }
  const org = refBeforeTag.slice(0, firstSlash);
  const repo = refBeforeTag.slice(firstSlash + 1);
  return {
    org,
    repo,
    tag,
    storageName: ociManifestName(org, repo),
    dockerReference: `${org}/${repo}`,
  };
}

function sha256Hex(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

async function streamToBuffer(
  stream: import("node:stream").Readable,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(chunks);
}

/**
 * Convenience high-level entry: compose + commit in one call. The
 * CLI uses this; the split sign/commitCosign API is exposed for
 * future flows that want to preview the digest before disk I/O.
 */
export async function signAndCommitCosign(
  opts: SignCosignOptions,
): Promise<SignCosignResult> {
  const result = signCosign(opts);
  await commitCosign(result, opts);
  return result;
}

// `signManifest` + `RegistryError` are re-exported references the M5
// upstream-resign flow uses; surfaced here so the cosign module is
// the central authority for OCI-side signature concerns.
export { signManifest, RegistryError };
