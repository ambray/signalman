/**
 * LocalDiskProvider — the v0.5.0 default for in-process signing.
 *
 * v0.5.0 layout under `~/.signalman/keys/`:
 *   - signing.{pub,key}                — legacy v0.4.x layout; alias "default" resolves here.
 *                                        Classical-only (Ed25519 in v0.4.x).
 *   - <alias>-ed25519.{pub,key}        — new classical sub-key (Milestone 1b+ hybrid).
 *   - <alias>-mldsa65.{pub,key}        — new PQ sub-key (Milestone 1b+ hybrid).
 *   - <alias>.{pub,key}                — new single-algorithm key (operator opts out of hybrid).
 *   - archive/<unix-ms>/…              — rotated-out keys.
 *
 * **Milestone 1a scope:** classical Ed25519 + ECDSA P-256 only.
 * ml-dsa-65 surfaces AlgorithmNotImplementedError. Hybrid key handling
 * (pair_id linkage, two-entry SignEnvelope emission) lands in
 * Milestone 1b alongside `liboqs-node`.
 *
 * Byte-parity invariant: for an Ed25519 key+payload pair, the
 * signature bytes this provider emits MUST equal the bytes
 * `crypto.sign(null, payload, privateKey)` emitted from the v0.4.x
 * `host/src/control-plane/build/signing.ts` for the same inputs.
 * Ed25519 is deterministic (no random nonce in the signing op itself,
 * only the request-level nonce we carry for replay protection) so
 * this is a stable invariant. The byte-parity regression test in
 * `signing.byte-parity.test.ts` locks it.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

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

/** Algorithms the v0.5.0 LocalDiskProvider can actually run. ml-dsa-65
 *  is declared in the type union but throws at sign/verify time until
 *  Milestone 1b. */
const SUPPORTED_ALGORITHMS_M1A: readonly SigAlgorithm[] = [
  "ed25519",
  "ecdsa-p256-sha256",
];

export interface LocalDiskProviderOptions {
  /** Default `~/.signalman/keys`. Override for tests. */
  readonly keysDir?: string;
  /** Policy floor; defaults to DEFAULT_SIGNING_POLICY. */
  readonly policy?: SigningPolicyDefaults;
}

/**
 * Internal handle for a key resolved on disk. The `algorithm` field is
 * derived from Node's `keyObject.asymmetricKeyType` (Ed25519 / EC) on
 * private-key load.
 */
interface ResolvedKey {
  readonly keyId: KeyId;
  readonly algorithm: SigAlgorithm;
  readonly privateKey: crypto.KeyObject;
  readonly publicKey: crypto.KeyObject;
  readonly fingerprint: string;
}

/**
 * Inline-PEM mode: used by the legacy v0.4.x build/signing.ts and
 * registry/signing.ts shims, which receive the private key as a PEM
 * string and don't touch the filesystem. Internally the inline key
 * resolves to a stable keyId `"inline:<sha256-of-spki-der>"` so the
 * audit trail records SOMETHING (Milestone 2 wires the real audit row).
 */
function inlineKeyIdFor(publicKeyDer: Buffer): KeyId {
  const sha = crypto.createHash("sha256").update(publicKeyDer).digest("hex");
  return `inline:${sha}`;
}

function fingerprintFromDer(publicKeyDer: Buffer): string {
  return crypto.createHash("sha256").update(publicKeyDer).digest("hex").slice(0, 16);
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
    // 0-9 || a-f || A-F
    const ok =
      (c >= 0x30 && c <= 0x39) ||
      (c >= 0x61 && c <= 0x66) ||
      (c >= 0x41 && c <= 0x46);
    if (!ok) return false;
  }
  return true;
}

/**
 * Resolve a `keyId` to a `(privKeyPath, pubKeyPath)` pair under
 * `keysDir`. Two shapes accepted:
 *
 *   - `"default"` → `<keysDir>/signing.{pub,key}` (v0.4.x layout).
 *   - any other alias (no `/`) → `<keysDir>/<alias>.{pub,key}`.
 *   - absolute path → treated as the private-key path; public-key
 *     path is the same with `.key` → `.pub` (or `.pub` appended if
 *     no `.key` suffix).
 *
 * Inline mode (`"inline:…"`) does NOT touch the filesystem and is
 * resolved by the inline-PEM constructor, not this helper.
 */
function resolveKeyPaths(
  keyId: KeyId,
  keysDir: string,
): { privKeyPath: string; pubKeyPath: string } {
  if (keyId.startsWith("inline:")) {
    throw new SigningError(
      "internal-error",
      "resolveKeyPaths called with an inline keyId; use the inline constructor instead",
    );
  }
  if (path.isAbsolute(keyId)) {
    const privKeyPath = keyId;
    const pubKeyPath = privKeyPath.endsWith(".key")
      ? `${privKeyPath.slice(0, -4)}.pub`
      : `${privKeyPath}.pub`;
    return { privKeyPath, pubKeyPath };
  }
  if (keyId === DEFAULT_ALIAS) {
    return {
      privKeyPath: path.join(keysDir, "signing.key"),
      pubKeyPath: path.join(keysDir, "signing.pub"),
    };
  }
  // Alias form: forbid path separators (keep within keysDir).
  if (keyId.includes(path.sep) || keyId.includes("/") || keyId.includes("..")) {
    throw new SigningError(
      "key-not-found",
      `keyId "${keyId}" contains path separators; only simple aliases or absolute paths are allowed`,
    );
  }
  return {
    privKeyPath: path.join(keysDir, `${keyId}.key`),
    pubKeyPath: path.join(keysDir, `${keyId}.pub`),
  };
}

/**
 * Map Node's `asymmetricKeyType` to the SigAlgorithm union. Throws
 * for unsupported key types (RSA, X25519, etc.) — keeping the
 * supported algorithm surface explicit prevents accidental algorithm
 * downgrades.
 */
function detectAlgorithm(keyObject: crypto.KeyObject): SigAlgorithm {
  const kind = keyObject.asymmetricKeyType;
  if (kind === "ed25519") return "ed25519";
  if (kind === "ec") {
    // Could be P-256, P-384, P-521, secp256k1. Only P-256 ships in 1a.
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
    `key type ${kind ?? "unknown"} is not in the supported algorithm set (ed25519, ecdsa-p256-sha256)`,
  );
}

function readPemFromDisk(keyPath: string): string {
  try {
    return fs.readFileSync(keyPath, "utf-8");
  } catch (err) {
    const message = (err as NodeJS.ErrnoException).code === "ENOENT"
      ? `key file not found at ${keyPath}`
      : `failed to read key file at ${keyPath}: ${(err as Error).message}`;
    throw new SigningError("key-not-found", message);
  }
}

function loadPrivateKey(privKeyPath: string): crypto.KeyObject {
  const pem = readPemFromDisk(privKeyPath);
  try {
    return crypto.createPrivateKey(pem);
  } catch (err) {
    throw new SigningError(
      "io-error",
      `failed to parse private key at ${privKeyPath}: ${(err as Error).message}`,
    );
  }
}

function loadPublicKey(pubKeyPath: string): crypto.KeyObject {
  const pem = readPemFromDisk(pubKeyPath);
  try {
    return crypto.createPublicKey(pem);
  } catch (err) {
    throw new SigningError(
      "io-error",
      `failed to parse public key at ${pubKeyPath}: ${(err as Error).message}`,
    );
  }
}

function publicKeyDer(pubKey: crypto.KeyObject): Buffer {
  return pubKey.export({ type: "spki", format: "der" }) as Buffer;
}

/**
 * Validate request-level invariants that every provider must enforce
 * regardless of backend (network, disk, HSM).
 */
function validateRequest(req: SignRequest, policy: SigningPolicyDefaults, now: number): void {
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

/**
 * Run the actual cryptographic sign() call. Node's `crypto.sign`:
 *   - Ed25519: pass `null` as the algorithm; sign signs the message bytes directly.
 *   - ECDSA P-256: pass `"sha256"` as the algorithm; sign hashes-then-signs.
 *
 * Both produce the bytes the v0.4.x signing.ts already produced for
 * the corresponding algorithm — byte-parity for the Ed25519 case is
 * the load-bearing invariant for the WS9 abstraction.
 */
function runSign(
  algorithm: SigAlgorithm,
  privateKey: crypto.KeyObject,
  payload: Uint8Array,
): Buffer {
  if (algorithm === "ed25519") {
    return crypto.sign(null, payload, privateKey);
  }
  if (algorithm === "ecdsa-p256-sha256") {
    return crypto.sign("sha256", payload, privateKey);
  }
  throw new AlgorithmNotImplementedError(algorithm);
}

function runVerify(
  algorithm: SigAlgorithm,
  publicKey: crypto.KeyObject,
  payload: Uint8Array,
  signatureBytes: Buffer,
): boolean {
  if (algorithm === "ed25519") {
    return crypto.verify(null, payload, publicKey, signatureBytes);
  }
  if (algorithm === "ecdsa-p256-sha256") {
    return crypto.verify("sha256", payload, publicKey, signatureBytes);
  }
  throw new AlgorithmNotImplementedError(algorithm);
}

function rfc3339UtcNow(): string {
  return new Date().toISOString();
}

/**
 * The provider. Implements both async (`SigningProvider`) and sync
 * (`SyncSigningProvider`) interfaces — Node's crypto APIs are
 * synchronous, so the async surface just wraps them in
 * `Promise.resolve(...)`.
 */
export class LocalDiskProvider implements SigningProvider, SyncSigningProvider {
  readonly id = PROVIDER_ID;
  readonly supportedAlgorithms = SUPPORTED_ALGORITHMS_M1A;

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
   * Inline-PEM constructor for legacy in-process callers. The
   * v0.4.x build/signing.ts shim instantiates this with the operator-
   * supplied private-key PEM; no filesystem access.
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
    const algorithm = detectAlgorithm(privateKey);
    const der = publicKeyDer(publicKey);
    const fingerprint = fingerprintFromDer(der);
    const keyId = inlineKeyIdFor(der);
    provider.inlineKey = {
      keyId,
      algorithm,
      privateKey,
      publicKey,
      fingerprint,
    };
    return provider;
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
    key: PublicKeyRef,
    mode: VerifyMode = "strict",
  ): Promise<VerifyResult> {
    return this.verifySync(env, payload, key, mode);
  }

  async fingerprint(keyId: KeyId): Promise<string> {
    if (
      this.inlineKey &&
      (keyId === this.inlineKey.keyId || keyId === "inline")
    ) {
      return this.inlineKey.fingerprint;
    }
    const { pubKeyPath } = resolveKeyPaths(keyId, this.keysDir);
    const pub = loadPublicKey(pubKeyPath);
    return fingerprintFromDer(publicKeyDer(pub));
  }

  async listKeys(): Promise<readonly PublicKeyRef[]> {
    if (this.inlineKey) {
      return [this.publicKeyRefForInline(this.inlineKey)];
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
        const pub = loadPublicKey(pubPath);
        const algorithm = detectAlgorithm(pub);
        const der = publicKeyDer(pub);
        const alias =
          ent.name === "signing.pub" ? DEFAULT_ALIAS : ent.name.slice(0, -4);
        refs.push({
          keyId: alias,
          provider: this.id,
          algorithm,
          publicKeyB64: der.toString("base64"),
          fingerprint: fingerprintFromDer(der),
        });
      } catch {
        // Skip files that aren't usable signing keys (encrypted, RSA,
        // wrong curve, etc). listKeys is best-effort enumeration; the
        // CLI surface lists what's usable and the operator can use
        // signing keys add to register otherwise-unparseable keys.
        continue;
      }
    }
    return refs;
  }

  // ──────────────────────────────────────────────────────────────
  //  Sync interface — the actual implementation.
  // ──────────────────────────────────────────────────────────────

  signSync(req: SignRequest): SignEnvelope {
    const now = Date.now();
    validateRequest(req, this.policy, now);
    const resolved = this.resolveForSign(req.keyId);
    if (!SUPPORTED_ALGORITHMS_M1A.includes(resolved.algorithm)) {
      throw new AlgorithmNotImplementedError(resolved.algorithm);
    }
    const sigBytes = runSign(resolved.algorithm, resolved.privateKey, req.payload);
    const entry: SigEntry = {
      signatureB64: sigBytes.toString("base64"),
      signedBy: resolved.fingerprint,
      algorithm: resolved.algorithm,
      signedAt: rfc3339UtcNow(),
    };
    const payloadSha256 = crypto
      .createHash("sha256")
      .update(req.payload)
      .digest("hex");
    return {
      signatures: [entry],
      nonce: req.nonce,
      payloadSha256,
    };
  }

  verifySync(
    env: SignEnvelope,
    payload: Uint8Array,
    key: PublicKeyRef,
    mode: VerifyMode = "strict",
  ): VerifyResult {
    if (env.signatures.length === 0) {
      return {
        ok: false,
        reasonCode: "bad-signature",
        reason: "SignEnvelope.signatures is empty",
      };
    }
    // Payload-hash fast-fail before any cryptographic work.
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
    // For Milestone 1a we only handle the single-entry case; the
    // verifier mode parameter is honored at the interface level but
    // strict/transition/classical-only collapse to the same behavior
    // until hybrid lands in Milestone 1b.
    const matchingEntries = this.selectEntriesForMode(env.signatures, mode);
    if (matchingEntries.length === 0) {
      return {
        ok: false,
        reasonCode: "bad-signature",
        reason: `no signatures matched verifier mode "${mode}"`,
      };
    }
    for (const entry of matchingEntries) {
      // Algorithm-support gate: surface algorithm-not-implemented BEFORE
      // attempting key/DER parsing. FIPS 204 ml-dsa-65 public-key bytes
      // aren't valid SPKI DER, so a vanilla `crypto.createPublicKey(...)`
      // would fail with a generic OpenSSL error and obscure the real
      // problem (algorithm not yet shipped) from the operator.
      if (!SUPPORTED_ALGORITHMS_M1A.includes(entry.algorithm)) {
        const err = new AlgorithmNotImplementedError(entry.algorithm);
        return {
          ok: false,
          reasonCode: "algorithm-not-implemented",
          reason: err.message,
        };
      }
      if (entry.algorithm !== key.algorithm) {
        // In strict mode this is fatal; in transition mode we skip
        // and let some other entry match. Milestone 1a always has at
        // most one matching entry so the distinction is academic.
        if (mode === "strict") {
          return {
            ok: false,
            reasonCode: "unknown-algorithm",
            reason: `entry algorithm ${entry.algorithm} != supplied public key algorithm ${key.algorithm}`,
          };
        }
        continue;
      }
      if (entry.signedBy !== key.fingerprint) {
        if (mode === "strict") {
          return {
            ok: false,
            reasonCode: "fingerprint-mismatch",
            reason: `signedBy fingerprint ${entry.signedBy} != supplied public key fingerprint ${key.fingerprint}`,
          };
        }
        continue;
      }
      let sigBytes: Buffer;
      try {
        sigBytes = Buffer.from(entry.signatureB64, "base64");
      } catch {
        return {
          ok: false,
          reasonCode: "bad-signature",
          reason: "signatureB64 is not valid base64",
        };
      }
      const publicKey = crypto.createPublicKey({
        key: Buffer.from(key.publicKeyB64, "base64"),
        format: "der",
        type: "spki",
      });
      let ok: boolean;
      try {
        ok = runVerify(entry.algorithm, publicKey, payload, sigBytes);
      } catch (err) {
        if (err instanceof AlgorithmNotImplementedError) {
          return { ok: false, reasonCode: "algorithm-not-implemented", reason: err.message };
        }
        throw err;
      }
      if (ok) {
        // Transition mode: one matching entry is enough.
        if (mode === "transition" || mode === "classical-only") {
          return { ok: true };
        }
        // Strict mode: every entry must verify. Keep going.
      } else {
        return {
          ok: false,
          reasonCode: "bad-signature",
          reason: "signature is cryptographically invalid (payload tampered or wrong key)",
        };
      }
    }
    return { ok: true };
  }

  // ──────────────────────────────────────────────────────────────
  //  Helpers
  // ──────────────────────────────────────────────────────────────

  private selectEntriesForMode(
    entries: readonly SigEntry[],
    mode: VerifyMode,
  ): readonly SigEntry[] {
    if (mode === "classical-only") {
      return entries.filter((e) => e.algorithm !== "ml-dsa-65");
    }
    return entries;
  }

  private resolveForSign(keyId: KeyId): ResolvedKey {
    if (this.inlineKey && keyId === this.inlineKey.keyId) {
      return this.inlineKey;
    }
    if (this.inlineKey && keyId === "inline") {
      // Convenience: legacy callers don't know the sha-derived
      // "inline:<sha>" form; they pass "inline" and we route to the
      // single inline key the provider was constructed with.
      return this.inlineKey;
    }
    const { privKeyPath, pubKeyPath } = resolveKeyPaths(keyId, this.keysDir);
    const privateKey = loadPrivateKey(privKeyPath);
    const publicKey = loadPublicKey(pubKeyPath);
    const algorithm = detectAlgorithm(privateKey);
    const fingerprint = fingerprintFromDer(publicKeyDer(publicKey));
    return { keyId, algorithm, privateKey, publicKey, fingerprint };
  }

  private publicKeyRefForInline(k: ResolvedKey): PublicKeyRef {
    return {
      keyId: k.keyId,
      provider: this.id,
      algorithm: k.algorithm,
      publicKeyB64: publicKeyDer(k.publicKey).toString("base64"),
      fingerprint: k.fingerprint,
    };
  }
}

/**
 * Convenience: derive a PublicKeyRef from a PEM string without going
 * through the provider. Used by the legacy verify path and by tests.
 */
export function publicKeyRefFromPem(
  publicKeyPem: string,
  provider = PROVIDER_ID,
): PublicKeyRef {
  const pub = crypto.createPublicKey(publicKeyPem);
  const algorithm = detectAlgorithm(pub);
  const der = publicKeyDer(pub);
  return {
    keyId: `inline:${crypto.createHash("sha256").update(der).digest("hex")}`,
    provider,
    algorithm,
    publicKeyB64: der.toString("base64"),
    fingerprint: fingerprintFromDer(der),
  };
}

/**
 * Convenience: derive a fresh 16-byte nonce as 32 lowercase hex chars.
 * Legacy in-process callers use this to construct a SignRequest with a
 * fresh nonce per-call.
 */
export function freshNonce(): string {
  return crypto.randomBytes(DEFAULT_SIGNING_POLICY.nonceLengthBytes).toString("hex");
}
