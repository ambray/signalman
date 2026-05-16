/**
 * LocalDiskProvider — the v0.5.0 default for in-process signing.
 *
 * v0.5.0 layout under `~/.signalman/keys/`:
 *   - signing.{pub,key}                — legacy v0.4.x layout; alias "default" resolves here.
 *                                        Classical-only Ed25519 (preserves operator muscle memory).
 *   - <alias>-ed25519.{pub,key}        — classical half of a hybrid key (PEM PKCS#8 / SPKI).
 *   - <alias>-mldsa65.{pub,key}        — ML-DSA-65 half of a hybrid key (raw FIPS 204 bytes
 *                                        prefixed with 4-byte 'MLDA' magic; no PEM).
 *   - <alias>.{pub,key}                — single-algorithm key (classical or ML-DSA-65;
 *                                        algorithm detected from file content).
 *   - archive/<unix-ms>/…              — rotated-out keys.
 *
 * **Milestone 1b scope:** classical Ed25519 + ECDSA P-256 + ML-DSA-65,
 * including hybrid Ed25519+ML-DSA-65 keys (`<alias>-ed25519.*` +
 * `<alias>-mldsa65.*` files sharing an alias). Hybrid sign() emits a
 * `signatures: [classical, pq]` envelope; verify() honors the three
 * verifier modes (transition / strict / classical-only).
 *
 * **ML-DSA-65 file format:**
 *   - 4-byte magic header `MLDA` (0x4D 0x4C 0x44 0x41 ASCII).
 *   - Followed by FIPS 204 raw bytes:
 *     - Public key: 1952 bytes (total file: 1956 bytes).
 *     - Secret key: 4032 bytes (total file: 4036 bytes).
 *   PEM ASN.1 wrappers for ML-DSA aren't yet standardized across
 *   libraries as of 2026-05-16, so raw bytes + magic header is the
 *   pragmatic choice. The magic prevents accidental misinterpretation
 *   if a tool tries to PEM-parse the file.
 *
 * **Byte-parity invariant** (Milestone 1a, preserved):
 *   For an Ed25519 key+payload pair, the classical signature bytes
 *   this provider emits MUST equal `crypto.sign(null, payload, key)`'s
 *   bytes from the v0.4.x `registry/src/signing.ts` signing path. The
 *   registry mirror is used by the registry virtual-upstream re-signing
 *   path and the legacy `signManifest` / `verifyManifest` shim;
 *   Ed25519 is deterministic so this is a stable invariant. ML-DSA-65
 *   is NOT deterministic (FIPS 204 default), so PQ signatures vary
 *   call-to-call; byte-parity applies only to the classical half.
 *
 * **Library choice (Milestone 1b):**
 *   ML-DSA-65 sign/verify uses `@noble/post-quantum/ml-dsa.js`
 *   (Paul Miller's audited Noble crypto suite). Pure JS — no native
 *   build deps — chosen because `liboqs-node` ships no prebuilt
 *   Windows binaries and requires a C toolchain on every operator
 *   host. The performance gap (rough ~5–10x slower than native) is
 *   irrelevant for the signing workloads Signalman runs (a handful
 *   of releases per day).
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { ml_dsa65 } from "@noble/post-quantum/ml-dsa.js";

import {
  AlgorithmNotImplementedError,
  DEFAULT_SIGNING_POLICY,
  type ActorRef,
  type KeyId,
  type PublicKeyRef,
  type SigAlgorithm,
  type SigEntry,
  type SignEnvelope,
  type SignRequest,
  SigningError,
  type SigningPolicyDefaults,
  type SigningProvider,
  type SyncSigningProvider,
  type VerifyMode,
  type VerifyResult,
} from "../types.js";

const PROVIDER_ID = "local-disk";

/** Default alias maps to v0.4.x layout for backwards compatibility. */
const DEFAULT_ALIAS = "default";

/** Algorithms the LocalDiskProvider supports as of Milestone 1b. */
const SUPPORTED_ALGORITHMS: readonly SigAlgorithm[] = [
  "ed25519",
  "ecdsa-p256-sha256",
  "ml-dsa-65",
];

/** Magic header on ML-DSA-65 key files (4 ASCII bytes). */
const MLDSA_MAGIC = Buffer.from("MLDA", "ascii");

/** Expected raw byte lengths after the magic header (FIPS 204 ML-DSA-65). */
const MLDSA65_PUBLIC_KEY_BYTES = 1952;
const MLDSA65_SECRET_KEY_BYTES = 4032;

export interface LocalDiskProviderOptions {
  /** Default `~/.signalman/keys`. Override for tests. */
  readonly keysDir?: string;
  /** Policy floor; defaults to DEFAULT_SIGNING_POLICY. */
  readonly policy?: SigningPolicyDefaults;
}

/**
 * One cryptographic sub-key (one algorithm, one key pair). A
 * hybrid key resolves to TWO ResolvedSubKey entries; a
 * single-algorithm key resolves to ONE. signSync iterates the
 * subKeys array and emits one SigEntry per entry.
 *
 * The `privateKey` / `publicKey` discriminator on algorithm:
 *   - ed25519, ecdsa-p256-sha256 → `crypto.KeyObject` (OpenSSL-managed)
 *   - ml-dsa-65                  → `Uint8Array` (raw FIPS 204 bytes)
 *
 * Stored as `unknown` and narrowed at the sign/verify dispatch site
 * to keep the union from leaking through every helper signature.
 */
interface ResolvedSubKey {
  readonly algorithm: SigAlgorithm;
  readonly privateKey: crypto.KeyObject | Uint8Array;
  readonly publicKey: crypto.KeyObject | Uint8Array;
  readonly fingerprint: string;
}

/**
 * The resolution result for a sign() call. Hybrid keys have
 * `subKeys.length === 2`; single-algorithm keys have
 * `subKeys.length === 1`. Ordered classical-first when both are
 * present, so `signatures[0]` of the resulting envelope is always
 * the classical entry for downstream consumers that only care about
 * one.
 */
interface ResolvedKey {
  readonly keyId: KeyId;
  /** Operator-facing alias when known (the part of the filename
   *  before "-ed25519" / "-mldsa65" / "."), null for inline keys. */
  readonly alias: string | null;
  readonly subKeys: readonly ResolvedSubKey[];
}

function inlineKeyIdFor(publicKeyBytes: Buffer | Uint8Array): KeyId {
  const sha = crypto.createHash("sha256").update(publicKeyBytes).digest("hex");
  return `inline:${sha}`;
}

function fingerprintFromBytes(publicKeyBytes: Buffer | Uint8Array): string {
  return crypto
    .createHash("sha256")
    .update(publicKeyBytes)
    .digest("hex")
    .slice(0, 16);
}

function expandHomeDir(p: string): string {
  if (p.startsWith("~/")) {
    return path.join(os.homedir(), p.slice(2));
  }
  if (p === "~") {
    return os.homedir();
  }
  return p;
}

function isHex(s: string, expectedLengthChars: number): boolean {
  if (s.length !== expectedLengthChars) {
    return false;
  }
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    const ok =
      (c >= 0x30 && c <= 0x39) ||
      (c >= 0x61 && c <= 0x66) ||
      (c >= 0x41 && c <= 0x46);
    if (!ok) return false;
  }
  return true;
}

// ──────────────────────────────────────────────────────────────
//  Key file I/O — classical (PEM) + ML-DSA-65 (raw + magic)
// ──────────────────────────────────────────────────────────────

function readBytesFromDisk(keyPath: string): Buffer {
  try {
    return fs.readFileSync(keyPath);
  } catch (err) {
    const message =
      (err as NodeJS.ErrnoException).code === "ENOENT"
        ? `key file not found at ${keyPath}`
        : `failed to read key file at ${keyPath}: ${(err as Error).message}`;
    throw new SigningError("key-not-found", message);
  }
}

function isMldsa65File(bytes: Buffer): boolean {
  return (
    bytes.length >= MLDSA_MAGIC.length &&
    bytes.subarray(0, MLDSA_MAGIC.length).equals(MLDSA_MAGIC)
  );
}

function readMldsa65Public(keyPath: string): Uint8Array {
  const bytes = readBytesFromDisk(keyPath);
  if (!isMldsa65File(bytes)) {
    throw new SigningError(
      "io-error",
      `expected ML-DSA-65 magic header (MLDA) at ${keyPath}; got ${bytes.subarray(0, 4).toString("hex")}`,
    );
  }
  const raw = bytes.subarray(MLDSA_MAGIC.length);
  if (raw.length !== MLDSA65_PUBLIC_KEY_BYTES) {
    throw new SigningError(
      "io-error",
      `ML-DSA-65 public key at ${keyPath} is ${raw.length} bytes; expected ${MLDSA65_PUBLIC_KEY_BYTES}`,
    );
  }
  return new Uint8Array(raw);
}

function readMldsa65Secret(keyPath: string): Uint8Array {
  const bytes = readBytesFromDisk(keyPath);
  if (!isMldsa65File(bytes)) {
    throw new SigningError(
      "io-error",
      `expected ML-DSA-65 magic header (MLDA) at ${keyPath}; got ${bytes.subarray(0, 4).toString("hex")}`,
    );
  }
  const raw = bytes.subarray(MLDSA_MAGIC.length);
  if (raw.length !== MLDSA65_SECRET_KEY_BYTES) {
    throw new SigningError(
      "io-error",
      `ML-DSA-65 secret key at ${keyPath} is ${raw.length} bytes; expected ${MLDSA65_SECRET_KEY_BYTES}`,
    );
  }
  return new Uint8Array(raw);
}

function writeMldsa65File(keyPath: string, rawKey: Uint8Array): void {
  const buf = Buffer.concat([MLDSA_MAGIC, Buffer.from(rawKey)]);
  fs.writeFileSync(keyPath, buf, { mode: 0o600 });
}

function loadClassicalPrivateKey(privKeyPath: string): crypto.KeyObject {
  const pem = readBytesFromDisk(privKeyPath).toString("utf-8");
  try {
    return crypto.createPrivateKey(pem);
  } catch (err) {
    throw new SigningError(
      "io-error",
      `failed to parse private key at ${privKeyPath}: ${(err as Error).message}`,
    );
  }
}

function loadClassicalPublicKey(pubKeyPath: string): crypto.KeyObject {
  const pem = readBytesFromDisk(pubKeyPath).toString("utf-8");
  try {
    return crypto.createPublicKey(pem);
  } catch (err) {
    throw new SigningError(
      "io-error",
      `failed to parse public key at ${pubKeyPath}: ${(err as Error).message}`,
    );
  }
}

function classicalPublicKeyDer(pubKey: crypto.KeyObject): Buffer {
  return pubKey.export({ type: "spki", format: "der" }) as Buffer;
}

/**
 * Map Node's `asymmetricKeyType` to the SigAlgorithm union for
 * classical (PEM-parsed) keys. ML-DSA-65 keys aren't crypto.KeyObject
 * instances — they're detected by the MLDA magic header at load
 * time, so this helper isn't called for them.
 */
function detectClassicalAlgorithm(keyObject: crypto.KeyObject): SigAlgorithm {
  const kind = keyObject.asymmetricKeyType;
  if (kind === "ed25519") return "ed25519";
  if (kind === "ec") {
    const details = keyObject.asymmetricKeyDetails;
    if (details?.namedCurve === "prime256v1" || details?.namedCurve === "P-256") {
      return "ecdsa-p256-sha256";
    }
    throw new SigningError(
      "unknown-algorithm",
      `EC key uses curve ${details?.namedCurve ?? "unknown"}; only prime256v1 (P-256) is supported in v0.5.0`,
    );
  }
  throw new SigningError(
    "unknown-algorithm",
    `key type ${kind ?? "unknown"} is not in the supported classical algorithm set (ed25519, ecdsa-p256-sha256)`,
  );
}

// ──────────────────────────────────────────────────────────────
//  Sign / verify dispatch
// ──────────────────────────────────────────────────────────────

function runSign(
  algorithm: SigAlgorithm,
  privateKey: crypto.KeyObject | Uint8Array,
  payload: Uint8Array,
): Uint8Array {
  if (algorithm === "ed25519") {
    return crypto.sign(null, payload, privateKey as crypto.KeyObject);
  }
  if (algorithm === "ecdsa-p256-sha256") {
    return crypto.sign("sha256", payload, privateKey as crypto.KeyObject);
  }
  if (algorithm === "ml-dsa-65") {
    return ml_dsa65.sign(payload, privateKey as Uint8Array);
  }
  throw new AlgorithmNotImplementedError(algorithm);
}

function runVerify(
  algorithm: SigAlgorithm,
  publicKey: crypto.KeyObject | Uint8Array,
  payload: Uint8Array,
  signatureBytes: Uint8Array,
): boolean {
  if (algorithm === "ed25519") {
    return crypto.verify(
      null,
      payload,
      publicKey as crypto.KeyObject,
      signatureBytes,
    );
  }
  if (algorithm === "ecdsa-p256-sha256") {
    return crypto.verify(
      "sha256",
      payload,
      publicKey as crypto.KeyObject,
      signatureBytes,
    );
  }
  if (algorithm === "ml-dsa-65") {
    return ml_dsa65.verify(
      signatureBytes,
      payload,
      publicKey as Uint8Array,
    );
  }
  throw new AlgorithmNotImplementedError(algorithm);
}

function rfc3339UtcNow(): string {
  return new Date().toISOString();
}

// ──────────────────────────────────────────────────────────────
//  Request validation (cross-cutting)
// ──────────────────────────────────────────────────────────────

function validateRequest(
  req: SignRequest,
  policy: SigningPolicyDefaults,
  now: number,
): void {
  if (!req.payload || req.payload.length === 0) {
    throw new SigningError("payload-empty", "SignRequest.payload must be a non-empty Uint8Array");
  }
  if (!req.purpose || req.purpose.trim().length === 0) {
    throw new SigningError("purpose-empty", "SignRequest.purpose must be a non-empty string");
  }
  if (!req.actor || !req.actor.cn || !req.actor.orgId) {
    throw new SigningError(
      "actor-missing",
      "SignRequest.actor must be populated with cn + orgId (Milestone 1a legacy callers may synthesize)",
    );
  }
  if (!isHex(req.nonce, policy.nonceLengthBytes * 2)) {
    throw new SigningError(
      "nonce-malformed",
      `SignRequest.nonce must be ${policy.nonceLengthBytes * 2} lowercase-hex chars; got "${req.nonce}"`,
    );
  }
  const requestedAtMs = Date.parse(req.requestedAt);
  if (Number.isNaN(requestedAtMs)) {
    throw new SigningError(
      "clock-skew",
      `SignRequest.requestedAt is not a valid RFC 3339 timestamp: "${req.requestedAt}"`,
    );
  }
  const skewMs = Math.abs(now - requestedAtMs);
  if (skewMs > policy.clockSkewToleranceMs) {
    throw new SigningError(
      "clock-skew",
      `SignRequest.requestedAt skew is ${skewMs}ms; policy allows up to ${policy.clockSkewToleranceMs}ms`,
    );
  }
}

// ──────────────────────────────────────────────────────────────
//  Provider class
// ──────────────────────────────────────────────────────────────

/** Result returned by generateHybridKey(). */
export interface GenerateHybridKeyResult {
  readonly alias: string;
  readonly classicalPubPath: string;
  readonly classicalKeyPath: string;
  readonly pqPubPath: string;
  readonly pqKeyPath: string;
  readonly classicalFingerprint: string;
  readonly pqFingerprint: string;
}

export class LocalDiskProvider implements SigningProvider, SyncSigningProvider {
  readonly id = PROVIDER_ID;
  readonly supportedAlgorithms = SUPPORTED_ALGORITHMS;

  private readonly keysDir: string;
  private readonly policy: SigningPolicyDefaults;
  /** Inline mode (constructed via fromInlinePem) stashes the key here
   *  and short-circuits the filesystem resolve. Non-readonly because
   *  the static factory assigns it after constructor runs; external
   *  code can't reach this field (private). */
  private inlineKey: ResolvedKey | null;

  constructor(opts: LocalDiskProviderOptions = {}) {
    this.keysDir = opts.keysDir
      ? expandHomeDir(opts.keysDir)
      : path.join(os.homedir(), ".signalman", "keys");
    this.policy = opts.policy ?? DEFAULT_SIGNING_POLICY;
    this.inlineKey = null;
  }

  /**
   * Inline-PEM constructor for legacy in-process callers. The registry
   * mirror's v0.4.x registry/signing.ts shim (the registry virtual-
   * upstream re-signing path and the legacy `signManifest` call site)
   * instantiates this with the operator-supplied private-key PEM; no
   * filesystem access. Classical-only — there's no inline form for
   * ML-DSA-65 keys (no widely-adopted PEM ASN.1 for them yet).
   */
  static fromInlinePem(
    privateKeyPem: string,
    publicKeyPem?: string,
    opts: LocalDiskProviderOptions = {},
  ): LocalDiskProvider {
    const provider = new LocalDiskProvider(opts);
    let privateKey: crypto.KeyObject;
    try {
      privateKey = crypto.createPrivateKey(privateKeyPem);
    } catch (err) {
      throw new SigningError(
        "io-error",
        `inline private-key PEM did not parse: ${(err as Error).message}`,
      );
    }
    const publicKey = publicKeyPem
      ? crypto.createPublicKey(publicKeyPem)
      : crypto.createPublicKey(privateKey);
    const algorithm = detectClassicalAlgorithm(privateKey);
    const der = classicalPublicKeyDer(publicKey);
    const fingerprint = fingerprintFromBytes(der);
    const keyId = inlineKeyIdFor(der);
    provider.inlineKey = {
      keyId,
      alias: null,
      subKeys: [
        {
          algorithm,
          privateKey,
          publicKey,
          fingerprint,
        },
      ],
    };
    return provider;
  }

  /**
   * Generate a fresh hybrid key (Ed25519 + ML-DSA-65) under the given
   * alias and write both halves to `keysDir`. Used by tests in
   * Milestone 1b; the Milestone 2 `signalman signing keys add` CLI
   * verb uses this internally.
   *
   * Files written (mode 0600 for private halves):
   *   <keysDir>/<alias>-ed25519.key      (PEM PKCS#8)
   *   <keysDir>/<alias>-ed25519.pub      (PEM SPKI)
   *   <keysDir>/<alias>-mldsa65.key      (MLDA + 4032 raw bytes)
   *   <keysDir>/<alias>-mldsa65.pub      (MLDA + 1952 raw bytes)
   */
  generateHybridKey(alias: string): GenerateHybridKeyResult {
    if (alias.length === 0 || alias.includes(path.sep) || alias.includes("/") || alias.includes("..")) {
      throw new SigningError(
        "internal-error",
        `alias "${alias}" must be non-empty and contain no path separators`,
      );
    }
    fs.mkdirSync(this.keysDir, { recursive: true });

    // Classical half — Ed25519 PEM pair.
    const { publicKey: edPubPem, privateKey: edPrivPem } = crypto.generateKeyPairSync(
      "ed25519",
      {
        publicKeyEncoding: { type: "spki", format: "pem" },
        privateKeyEncoding: { type: "pkcs8", format: "pem" },
      },
    );
    const classicalKeyPath = path.join(this.keysDir, `${alias}-ed25519.key`);
    const classicalPubPath = path.join(this.keysDir, `${alias}-ed25519.pub`);
    fs.writeFileSync(classicalKeyPath, edPrivPem as string, { mode: 0o600 });
    fs.writeFileSync(classicalPubPath, edPubPem as string);
    const edPubKey = crypto.createPublicKey(edPubPem as string);
    const classicalFingerprint = fingerprintFromBytes(classicalPublicKeyDer(edPubKey));

    // PQ half — ML-DSA-65 raw bytes with MLDA magic prefix.
    const pqKeyPair = ml_dsa65.keygen();
    const pqKeyPath = path.join(this.keysDir, `${alias}-mldsa65.key`);
    const pqPubPath = path.join(this.keysDir, `${alias}-mldsa65.pub`);
    writeMldsa65File(pqKeyPath, pqKeyPair.secretKey);
    writeMldsa65File(pqPubPath, pqKeyPair.publicKey);
    const pqFingerprint = fingerprintFromBytes(pqKeyPair.publicKey);

    return {
      alias,
      classicalPubPath,
      classicalKeyPath,
      pqPubPath,
      pqKeyPath,
      classicalFingerprint,
      pqFingerprint,
    };
  }

  // ──────────────────────────────────────────────────────────────
  //  Key resolution — disk → ResolvedKey
  // ──────────────────────────────────────────────────────────────

  private resolveForSign(keyId: KeyId): ResolvedKey {
    if (this.inlineKey && (keyId === this.inlineKey.keyId || keyId === "inline")) {
      return this.inlineKey;
    }
    if (path.isAbsolute(keyId)) {
      // Absolute path → treat as single-algorithm classical PEM key.
      return this.resolveAbsoluteClassical(keyId);
    }
    // Alias form: hybrid detection or single-algorithm fallback.
    if (keyId.includes(path.sep) || keyId.includes("/") || keyId.includes("..")) {
      throw new SigningError(
        "key-not-found",
        `keyId "${keyId}" contains path separators; only simple aliases or absolute paths are allowed`,
      );
    }
    const alias = keyId === DEFAULT_ALIAS ? "signing" : keyId;
    return this.resolveByAlias(keyId, alias);
  }

  private resolveAbsoluteClassical(absKeyPath: string): ResolvedKey {
    const pubKeyPath = absKeyPath.endsWith(".key")
      ? `${absKeyPath.slice(0, -4)}.pub`
      : `${absKeyPath}.pub`;
    const privateKey = loadClassicalPrivateKey(absKeyPath);
    const publicKey = loadClassicalPublicKey(pubKeyPath);
    const algorithm = detectClassicalAlgorithm(privateKey);
    const fingerprint = fingerprintFromBytes(classicalPublicKeyDer(publicKey));
    return {
      keyId: absKeyPath,
      alias: null,
      subKeys: [{ algorithm, privateKey, publicKey, fingerprint }],
    };
  }

  /**
   * Alias resolution. Lookup priority:
   *   1. Hybrid pair: `<alias>-ed25519.{pub,key}` + `<alias>-mldsa65.{pub,key}`
   *   2. Single-algorithm classical: `<alias>.{pub,key}` (PEM, Ed25519 or P-256)
   *   3. Single-algorithm ML-DSA-65: `<alias>.{pub,key}` (MLDA magic)
   *      — only checked if step 2 surfaces "not a PEM" failure.
   *
   * The legacy default alias resolves "signing" as its on-disk base
   * (v0.4.x layout: `signing.{pub,key}`).
   */
  private resolveByAlias(keyId: KeyId, aliasBase: string): ResolvedKey {
    const classicalKeyPath = path.join(this.keysDir, `${aliasBase}-ed25519.key`);
    const classicalPubPath = path.join(this.keysDir, `${aliasBase}-ed25519.pub`);
    const pqKeyPath = path.join(this.keysDir, `${aliasBase}-mldsa65.key`);
    const pqPubPath = path.join(this.keysDir, `${aliasBase}-mldsa65.pub`);

    const hybridClassicalPresent =
      fs.existsSync(classicalKeyPath) && fs.existsSync(classicalPubPath);
    const hybridPqPresent =
      fs.existsSync(pqKeyPath) && fs.existsSync(pqPubPath);

    if (hybridClassicalPresent && hybridPqPresent) {
      const edPriv = loadClassicalPrivateKey(classicalKeyPath);
      const edPub = loadClassicalPublicKey(classicalPubPath);
      const edAlgorithm = detectClassicalAlgorithm(edPriv);
      if (edAlgorithm !== "ed25519") {
        throw new SigningError(
          "hybrid-pair-incomplete",
          `hybrid classical half at ${classicalKeyPath} is ${edAlgorithm}, not ed25519`,
        );
      }
      const edFingerprint = fingerprintFromBytes(classicalPublicKeyDer(edPub));
      const pqPriv = readMldsa65Secret(pqKeyPath);
      const pqPub = readMldsa65Public(pqPubPath);
      const pqFingerprint = fingerprintFromBytes(pqPub);
      return {
        keyId,
        alias: aliasBase,
        subKeys: [
          {
            algorithm: "ed25519",
            privateKey: edPriv,
            publicKey: edPub,
            fingerprint: edFingerprint,
          },
          {
            algorithm: "ml-dsa-65",
            privateKey: pqPriv,
            publicKey: pqPub,
            fingerprint: pqFingerprint,
          },
        ],
      };
    }

    // Partial hybrid → fail loudly (operator-misconfigured key).
    if (hybridClassicalPresent !== hybridPqPresent) {
      throw new SigningError(
        "hybrid-pair-incomplete",
        `hybrid alias "${aliasBase}" is missing one half: classical=${hybridClassicalPresent}, pq=${hybridPqPresent}`,
      );
    }

    // Single-algorithm: <aliasBase>.{pub,key}. Probe for ml-dsa-65 magic first
    // (cheap: one read), otherwise treat as classical PEM.
    const flatKeyPath = path.join(this.keysDir, `${aliasBase}.key`);
    const flatPubPath = path.join(this.keysDir, `${aliasBase}.pub`);
    if (!fs.existsSync(flatKeyPath) || !fs.existsSync(flatPubPath)) {
      throw new SigningError(
        "key-not-found",
        `no key files found for alias "${aliasBase}" under ${this.keysDir} (looked for hybrid pair and flat ${aliasBase}.{pub,key})`,
      );
    }
    const headBytes = readBytesFromDisk(flatKeyPath);
    if (isMldsa65File(headBytes)) {
      // PQ-only single-algorithm key.
      const pqPriv = readMldsa65Secret(flatKeyPath);
      const pqPub = readMldsa65Public(flatPubPath);
      const pqFingerprint = fingerprintFromBytes(pqPub);
      return {
        keyId,
        alias: aliasBase,
        subKeys: [
          {
            algorithm: "ml-dsa-65",
            privateKey: pqPriv,
            publicKey: pqPub,
            fingerprint: pqFingerprint,
          },
        ],
      };
    }
    // Classical single-algorithm.
    const privateKey = loadClassicalPrivateKey(flatKeyPath);
    const publicKey = loadClassicalPublicKey(flatPubPath);
    const algorithm = detectClassicalAlgorithm(privateKey);
    const fingerprint = fingerprintFromBytes(classicalPublicKeyDer(publicKey));
    return {
      keyId,
      alias: aliasBase,
      subKeys: [{ algorithm, privateKey, publicKey, fingerprint }],
    };
  }

  // ──────────────────────────────────────────────────────────────
  //  Async interface — wraps sync for now.
  // ──────────────────────────────────────────────────────────────

  async sign(req: SignRequest): Promise<SignEnvelope> {
    return this.signSync(req);
  }

  async verify(
    env: SignEnvelope,
    payload: Uint8Array,
    keys: readonly PublicKeyRef[],
    mode: VerifyMode = "strict",
  ): Promise<VerifyResult> {
    return this.verifySync(env, payload, keys, mode);
  }

  async fingerprint(keyId: KeyId): Promise<string> {
    if (
      this.inlineKey &&
      (keyId === this.inlineKey.keyId || keyId === "inline")
    ) {
      // Inline keys are classical-only (no inline ML-DSA-65 form), so
      // there's always exactly one sub-key whose fingerprint we return.
      return this.inlineKey.subKeys[0]!.fingerprint;
    }
    // For disk-resolved aliases, "the fingerprint" is ambiguous on
    // hybrid keys (two sub-keys, two fingerprints). Return the
    // classical-half fingerprint by convention; operators querying
    // PQ-half-specific fingerprints use listKeys() instead.
    const resolved = this.resolveForSign(keyId);
    const classical = resolved.subKeys.find((sk) => sk.algorithm !== "ml-dsa-65");
    return (classical ?? resolved.subKeys[0]!).fingerprint;
  }

  async listKeys(): Promise<readonly PublicKeyRef[]> {
    if (this.inlineKey) {
      return this.inlineKey.subKeys.map((sk) =>
        this.publicKeyRefForSubKey(this.inlineKey!.keyId, sk),
      );
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(this.keysDir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw new SigningError(
        "io-error",
        `failed to enumerate keys directory ${this.keysDir}: ${(err as Error).message}`,
      );
    }
    const refs: PublicKeyRef[] = [];
    for (const ent of entries) {
      if (!ent.isFile()) continue;
      if (!ent.name.endsWith(".pub")) continue;
      const pubPath = path.join(this.keysDir, ent.name);
      try {
        const bytes = readBytesFromDisk(pubPath);
        if (isMldsa65File(bytes)) {
          // ML-DSA-65 public key.
          const raw = bytes.subarray(MLDSA_MAGIC.length);
          if (raw.length !== MLDSA65_PUBLIC_KEY_BYTES) continue;
          const alias = aliasFromPubFilename(ent.name);
          refs.push({
            keyId: alias.logical,
            provider: this.id,
            algorithm: "ml-dsa-65",
            publicKeyB64: Buffer.from(raw).toString("base64"),
            fingerprint: fingerprintFromBytes(raw),
          });
          continue;
        }
        // Classical PEM.
        const pub = crypto.createPublicKey(bytes.toString("utf-8"));
        const algorithm = detectClassicalAlgorithm(pub);
        const der = classicalPublicKeyDer(pub);
        const alias = aliasFromPubFilename(ent.name);
        refs.push({
          keyId: alias.logical,
          provider: this.id,
          algorithm,
          publicKeyB64: der.toString("base64"),
          fingerprint: fingerprintFromBytes(der),
        });
      } catch {
        // Skip files that aren't usable signing keys (encrypted, RSA,
        // wrong curve, etc). listKeys is best-effort enumeration; the
        // CLI surface lists what's usable.
        continue;
      }
    }
    return refs;
  }

  // ──────────────────────────────────────────────────────────────
  //  Sync interface — the actual implementation
  // ──────────────────────────────────────────────────────────────

  signSync(req: SignRequest): SignEnvelope {
    const now = Date.now();
    validateRequest(req, this.policy, now);
    const resolved = this.resolveForSign(req.keyId);
    if (resolved.subKeys.length === 0) {
      throw new SigningError("internal-error", "ResolvedKey carries no sub-keys");
    }
    const signedAt = rfc3339UtcNow();
    const entries: SigEntry[] = resolved.subKeys.map((sk) => {
      if (!SUPPORTED_ALGORITHMS.includes(sk.algorithm)) {
        throw new AlgorithmNotImplementedError(sk.algorithm);
      }
      const sigBytes = runSign(sk.algorithm, sk.privateKey, req.payload);
      return {
        signatureB64: Buffer.from(sigBytes).toString("base64"),
        signedBy: sk.fingerprint,
        algorithm: sk.algorithm,
        signedAt,
      };
    });
    const payloadSha256 = crypto
      .createHash("sha256")
      .update(req.payload)
      .digest("hex");
    return {
      signatures: entries,
      nonce: req.nonce,
      payloadSha256,
    };
  }

  verifySync(
    env: SignEnvelope,
    payload: Uint8Array,
    keys: readonly PublicKeyRef[],
    mode: VerifyMode = "strict",
  ): VerifyResult {
    if (env.signatures.length === 0) {
      return {
        ok: false,
        reasonCode: "bad-signature",
        reason: "SignEnvelope.signatures is empty",
      };
    }
    if (keys.length === 0) {
      return {
        ok: false,
        reasonCode: "fingerprint-mismatch",
        reason: "verify() requires at least one PublicKeyRef",
      };
    }
    // Payload-hash fast-fail.
    const actualSha = crypto
      .createHash("sha256")
      .update(payload)
      .digest("hex");
    if (actualSha !== env.payloadSha256) {
      return {
        ok: false,
        reasonCode: "bad-signature",
        reason: `payloadSha256 mismatch — envelope claims ${env.payloadSha256}, computed ${actualSha}`,
      };
    }

    // Filter entries per mode.
    const consideredEntries =
      mode === "classical-only"
        ? env.signatures.filter((e) => e.algorithm !== "ml-dsa-65")
        : env.signatures;
    if (consideredEntries.length === 0) {
      return {
        ok: false,
        reasonCode: "bad-signature",
        reason: `no signatures matched verifier mode "${mode}" (envelope is PQ-only?)`,
      };
    }

    // Per-entry verification. In strict mode every considered entry
    // must verify; in transition mode at least one must; in
    // classical-only mode we already filtered down to classical
    // entries and require every one of them to verify (so a tampered
    // classical sig in classical-only mode still fails).
    let anyVerified = false;
    let firstFailureReason: { code: VerifyResult["reasonCode"]; reason: string } | null = null;
    for (const entry of consideredEntries) {
      if (!SUPPORTED_ALGORITHMS.includes(entry.algorithm)) {
        const err = new AlgorithmNotImplementedError(entry.algorithm);
        if (mode === "strict" || mode === "classical-only") {
          return { ok: false, reasonCode: "algorithm-not-implemented", reason: err.message };
        }
        firstFailureReason ??= { code: "algorithm-not-implemented", reason: err.message };
        continue;
      }
      const key = keys.find(
        (k) => k.algorithm === entry.algorithm && k.fingerprint === entry.signedBy,
      );
      if (!key) {
        const msg = `no PublicKeyRef matched entry (algorithm=${entry.algorithm}, signedBy=${entry.signedBy})`;
        if (mode === "strict" || mode === "classical-only") {
          return { ok: false, reasonCode: "fingerprint-mismatch", reason: msg };
        }
        firstFailureReason ??= { code: "fingerprint-mismatch", reason: msg };
        continue;
      }
      let sigBytes: Uint8Array;
      try {
        sigBytes = Buffer.from(entry.signatureB64, "base64");
      } catch {
        const msg = "signatureB64 is not valid base64";
        if (mode === "strict" || mode === "classical-only") {
          return { ok: false, reasonCode: "bad-signature", reason: msg };
        }
        firstFailureReason ??= { code: "bad-signature", reason: msg };
        continue;
      }
      const publicKey = this.materializePublicKey(key);
      let ok: boolean;
      try {
        ok = runVerify(entry.algorithm, publicKey, payload, sigBytes);
      } catch (err) {
        if (err instanceof AlgorithmNotImplementedError) {
          if (mode === "strict" || mode === "classical-only") {
            return { ok: false, reasonCode: "algorithm-not-implemented", reason: err.message };
          }
          firstFailureReason ??= { code: "algorithm-not-implemented", reason: err.message };
          continue;
        }
        throw err;
      }
      if (ok) {
        anyVerified = true;
      } else {
        const msg = `signature is cryptographically invalid for ${entry.algorithm} entry`;
        if (mode === "strict" || mode === "classical-only") {
          return { ok: false, reasonCode: "bad-signature", reason: msg };
        }
        firstFailureReason ??= { code: "bad-signature", reason: msg };
      }
    }

    if (mode === "transition") {
      return anyVerified
        ? { ok: true }
        : {
            ok: false,
            reasonCode: firstFailureReason?.code ?? "bad-signature",
            reason: firstFailureReason?.reason ?? "no entry verified in transition mode",
          };
    }
    // strict + classical-only: every considered entry must have verified.
    return { ok: true };
  }

  // ──────────────────────────────────────────────────────────────
  //  Helpers
  // ──────────────────────────────────────────────────────────────

  private materializePublicKey(
    key: PublicKeyRef,
  ): crypto.KeyObject | Uint8Array {
    if (key.algorithm === "ml-dsa-65") {
      return Buffer.from(key.publicKeyB64, "base64");
    }
    return crypto.createPublicKey({
      key: Buffer.from(key.publicKeyB64, "base64"),
      format: "der",
      type: "spki",
    });
  }

  private publicKeyRefForSubKey(keyId: KeyId, sk: ResolvedSubKey): PublicKeyRef {
    if (sk.algorithm === "ml-dsa-65") {
      const bytes = sk.publicKey as Uint8Array;
      return {
        keyId,
        provider: this.id,
        algorithm: sk.algorithm,
        publicKeyB64: Buffer.from(bytes).toString("base64"),
        fingerprint: sk.fingerprint,
      };
    }
    const der = classicalPublicKeyDer(sk.publicKey as crypto.KeyObject);
    return {
      keyId,
      provider: this.id,
      algorithm: sk.algorithm,
      publicKeyB64: der.toString("base64"),
      fingerprint: sk.fingerprint,
    };
  }
}

/**
 * Parse a `.pub` filename into its alias parts. Examples:
 *   "signing.pub"            → { logical: "default", algorithm: null }
 *   "release-prod.pub"       → { logical: "release-prod", algorithm: null }
 *   "release-prod-ed25519.pub" → { logical: "release-prod", algorithm: "ed25519" }
 *   "release-prod-mldsa65.pub" → { logical: "release-prod", algorithm: "ml-dsa-65" }
 *
 * The logical alias is the operator-facing name; the algorithm
 * component is the suffix identifying which half of a hybrid pair
 * the file holds.
 */
function aliasFromPubFilename(
  filename: string,
): { logical: string; algorithm: "ed25519" | "ml-dsa-65" | null } {
  const base = filename.slice(0, -4); // strip ".pub"
  if (base === "signing") return { logical: DEFAULT_ALIAS, algorithm: null };
  if (base.endsWith("-ed25519")) {
    return { logical: base.slice(0, -"-ed25519".length), algorithm: "ed25519" };
  }
  if (base.endsWith("-mldsa65")) {
    return { logical: base.slice(0, -"-mldsa65".length), algorithm: "ml-dsa-65" };
  }
  return { logical: base, algorithm: null };
}

/**
 * Convenience: derive a PublicKeyRef from a PEM string. Used by
 * legacy classical verify paths.
 */
export function publicKeyRefFromPem(
  publicKeyPem: string,
  provider = PROVIDER_ID,
): PublicKeyRef {
  const pub = crypto.createPublicKey(publicKeyPem);
  const algorithm = detectClassicalAlgorithm(pub);
  const der = classicalPublicKeyDer(pub);
  return {
    keyId: `inline:${crypto.createHash("sha256").update(der).digest("hex")}`,
    provider,
    algorithm,
    publicKeyB64: der.toString("base64"),
    fingerprint: fingerprintFromBytes(der),
  };
}

/**
 * Convenience: derive a PublicKeyRef from raw ML-DSA-65 public-key
 * bytes (1952 bytes, FIPS 204 format, NO magic header — that's a
 * file-format wrapper, not part of the key material).
 */
export function publicKeyRefFromMldsa65(
  publicKeyBytes: Uint8Array,
  provider = PROVIDER_ID,
): PublicKeyRef {
  if (publicKeyBytes.length !== MLDSA65_PUBLIC_KEY_BYTES) {
    throw new SigningError(
      "io-error",
      `ML-DSA-65 public key must be ${MLDSA65_PUBLIC_KEY_BYTES} bytes; got ${publicKeyBytes.length}`,
    );
  }
  return {
    keyId: `inline:${crypto.createHash("sha256").update(publicKeyBytes).digest("hex")}`,
    provider,
    algorithm: "ml-dsa-65",
    publicKeyB64: Buffer.from(publicKeyBytes).toString("base64"),
    fingerprint: fingerprintFromBytes(publicKeyBytes),
  };
}

/**
 * Convenience: derive a fresh 16-byte nonce as 32 lowercase hex chars.
 */
export function freshNonce(): string {
  return crypto.randomBytes(DEFAULT_SIGNING_POLICY.nonceLengthBytes).toString("hex");
}
