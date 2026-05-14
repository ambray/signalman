/**
 * Per-org cloud credentials at rest (v0.3.0-5 sub-task 6, design §13.7).
 *
 * AES-256-GCM with a 32-byte key supplied via the
 * `SIGNALMAN_CRED_KEY` environment variable (base64-encoded).
 * Each row carries a per-record random 12-byte IV; the auth
 * tag is appended to the ciphertext so the on-disk blob is
 * `iv || ciphertext || auth_tag` base64-encoded.
 *
 * # Locked design
 *
 * - **Fail loud on missing key.** If `SIGNALMAN_CRED_KEY` is
 *   absent or malformed, every credential operation throws.
 *   Silently falling back to plaintext storage would be a
 *   security trap; the operator must opt in by setting the
 *   key (or run without per-org credentials and use the SDK
 *   default chain).
 * - **Per-record random IV.** AES-GCM nonce reuse is
 *   catastrophic; rolling fresh randomness per encrypt is the
 *   safe default. Per-record IVs are also why we store the IV
 *   *with* the ciphertext (no separate IV column) — the
 *   ciphertext layout is `iv (12B) || ciphertext || auth_tag (16B)`
 *   base64-encoded.
 * - **No secret material in error messages.** Decryption
 *   failures throw with the message
 *   `"failed to decrypt cloud credential"` — the underlying
 *   crypto error (which might leak about plaintext length etc)
 *   stays internal.
 * - **Redaction hint computed at encrypt time, not on read.**
 *   The hint surface (`signalman cloud creds get`) should be
 *   safe to log; computing it at encrypt time means a read path
 *   that's "just want the hint" never decrypts the secret.
 * - **`SIGNALMAN_CRED_KEY` is operator-managed.** Rotating the
 *   key requires re-encrypting every row; out of scope for
 *   v0.3.0-5. v0.3.x followup adds a key-rotation command that
 *   reads with the old key, writes with the new.
 */

import * as crypto from "node:crypto";
import { CloudBackendError } from "./types.js";
import type {
  CloudCredentialsRepo,
  CloudUsageRepo,
} from "../control-plane/storage/driver.js";

// ── Constants ─────────────────────────────────────────────────────

export const SIGNALMAN_CRED_KEY_ENV = "SIGNALMAN_CRED_KEY";

/** AES-256 key length in bytes. */
const AES_KEY_LEN = 32;

/** AES-GCM IV length (96 bits per NIST SP 800-38D recommendation). */
const AES_GCM_IV_LEN = 12;

/** AES-GCM auth tag length (128 bits, the default). */
const AES_GCM_TAG_LEN = 16;

/** Stable string identifying this encryption scheme. */
export const ENCRYPTION_METHOD_AES_GCM_ENV = "aes-gcm-env";

// ── Plaintext shapes ──────────────────────────────────────────────

/**
 * AWS credential plaintext. `session_token` is optional —
 * present only for temporary credentials (e.g. AssumeRole).
 */
export interface AwsCredentialPlaintext {
  access_key_id: string;
  secret_access_key: string;
  session_token?: string;
}

/**
 * Azure service-principal credential plaintext.
 */
export interface AzureCredentialPlaintext {
  tenant_id: string;
  client_id: string;
  client_secret: string;
}

export type CredentialPlaintext = AwsCredentialPlaintext | AzureCredentialPlaintext;

// ── Encryption ────────────────────────────────────────────────────

/**
 * Load the 32-byte encryption key from {@link SIGNALMAN_CRED_KEY_ENV}.
 * Throws `CloudBackendError("invalid_config", ...)` if absent or
 * malformed. Cached on first successful resolution so the
 * environment variable can be unset later without breaking
 * subsequent calls.
 */
let cachedKey: Buffer | null = null;
export function loadEncryptionKey(): Buffer {
  if (cachedKey) return cachedKey;
  const raw = process.env[SIGNALMAN_CRED_KEY_ENV];
  if (!raw) {
    throw new CloudBackendError(
      "invalid_config",
      `cloud credentials require ${SIGNALMAN_CRED_KEY_ENV} env var ` +
        `(base64-encoded 32-byte key). Set it before invoking ` +
        `credential operations, or rely on the SDK default ` +
        `credential chain (env vars, IMDS, etc).`,
    );
  }
  const decoded = Buffer.from(raw, "base64");
  if (decoded.length !== AES_KEY_LEN) {
    throw new CloudBackendError(
      "invalid_config",
      `${SIGNALMAN_CRED_KEY_ENV} must decode to exactly ${AES_KEY_LEN} bytes; ` +
        `got ${decoded.length} bytes after base64 decode.`,
    );
  }
  cachedKey = decoded;
  return decoded;
}

/** Reset the cached key. Tests only. */
export function resetEncryptionKeyForTests(): void {
  cachedKey = null;
}

/**
 * Encrypt a plaintext credential. Returns the base64 blob
 * suitable for storing in `cloud_org_credential.ciphertext_b64`.
 */
export function encryptCredential(plaintext: CredentialPlaintext): string {
  const key = loadEncryptionKey();
  const iv = crypto.randomBytes(AES_GCM_IV_LEN);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const plaintextJson = JSON.stringify(plaintext);
  const encrypted = Buffer.concat([
    cipher.update(plaintextJson, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  if (tag.length !== AES_GCM_TAG_LEN) {
    // Defensive: Node's GCM always returns 16-byte tags, but
    // if a future runtime change alters that the layout breaks.
    throw new Error(`unexpected GCM tag length: ${tag.length}`);
  }
  return Buffer.concat([iv, encrypted, tag]).toString("base64");
}

/**
 * Decrypt a previously-encrypted credential blob.
 * @throws `CloudBackendError("invalid_config", ...)` if the
 *         ciphertext is malformed (wrong length, bad tag).
 */
export function decryptCredential(ciphertextB64: string): CredentialPlaintext {
  const key = loadEncryptionKey();
  const buf = Buffer.from(ciphertextB64, "base64");
  if (buf.length < AES_GCM_IV_LEN + AES_GCM_TAG_LEN) {
    throw new CloudBackendError(
      "invalid_config",
      `failed to decrypt cloud credential: ciphertext too short`,
    );
  }
  const iv = buf.subarray(0, AES_GCM_IV_LEN);
  const tag = buf.subarray(buf.length - AES_GCM_TAG_LEN);
  const ciphertext = buf.subarray(AES_GCM_IV_LEN, buf.length - AES_GCM_TAG_LEN);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  let plaintextJson: string;
  try {
    plaintextJson = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    // Any decryption error → opaque. Don't leak the actual
    // crypto failure (might disclose length / tag-mismatch info
    // that an attacker could probe with).
    throw new CloudBackendError(
      "invalid_config",
      "failed to decrypt cloud credential (key mismatch or corrupt data)",
    );
  }
  try {
    return JSON.parse(plaintextJson) as CredentialPlaintext;
  } catch {
    throw new CloudBackendError(
      "invalid_config",
      "decrypted credential is not valid JSON",
    );
  }
}

// ── Redaction ─────────────────────────────────────────────────────

/**
 * Build a redaction-safe hint string from plaintext credentials.
 * For AWS: `AKIA****EXAMPLE` (first 4 + last 4 chars of access key).
 * For Azure: `client_id={uuid-prefix}...{uuid-suffix}`.
 *
 * The hint is stored alongside the ciphertext and surfaced via
 * `signalman cloud creds get` so operators can confirm "yes, the
 * right key is wired" without exposing the secret.
 */
export function redactionHint(
  backend: "aws" | "azure",
  plaintext: CredentialPlaintext,
): string {
  if (backend === "aws") {
    const ak = (plaintext as AwsCredentialPlaintext).access_key_id;
    if (!ak || ak.length < 8) return "AKIA****";
    return `${ak.slice(0, 4)}****${ak.slice(-4)}`;
  }
  if (backend === "azure") {
    const cid = (plaintext as AzureCredentialPlaintext).client_id;
    if (!cid || cid.length < 12) return "****";
    return `client_id=${cid.slice(0, 8)}…${cid.slice(-4)}`;
  }
  return "****";
}

// ── Repo-level helpers ────────────────────────────────────────────

/**
 * Convenience: upsert a credential via the repo, encrypting on
 * the way in. Returns the resulting redaction hint (callers
 * surface this; the plaintext stays out of any return value).
 */
export async function setCredential(
  repo: CloudCredentialsRepo,
  orgId: string,
  backend: "aws" | "azure",
  plaintext: CredentialPlaintext,
): Promise<{ redactedHint: string }> {
  const ciphertextB64 = encryptCredential(plaintext);
  const hint = redactionHint(backend, plaintext);
  await repo.upsert({
    orgId,
    backend,
    ciphertextB64,
    encryptionMethod: ENCRYPTION_METHOD_AES_GCM_ENV,
    redactedHint: hint,
  });
  return { redactedHint: hint };
}

/**
 * Load + decrypt the credential for an org+backend. Returns
 * null when no row exists (caller falls back to SDK default
 * chain). Throws on decryption failure (key mismatch, corrupt
 * ciphertext) — caller should surface this to the operator;
 * silently falling through to default-chain might be an
 * unexpected privilege change.
 */
export async function loadCredentialForOrg(
  repo: CloudCredentialsRepo,
  orgId: string,
  backend: "aws" | "azure",
): Promise<CredentialPlaintext | null> {
  const row = await repo.get(orgId, backend);
  if (!row) return null;
  if (row.encryptionMethod !== ENCRYPTION_METHOD_AES_GCM_ENV) {
    throw new CloudBackendError(
      "invalid_config",
      `cloud credential row ${row.id} uses unsupported encryption_method ` +
        `'${row.encryptionMethod}' — only '${ENCRYPTION_METHOD_AES_GCM_ENV}' ` +
        `is supported in v0.3.0-5`,
    );
  }
  return decryptCredential(row.ciphertextB64);
}

// avoid the unused-import warning when only CloudUsageRepo is
// imported above (kept for type symmetry across the cloud module).
export type _CloudUsageRepoTypeAlias = CloudUsageRepo;
