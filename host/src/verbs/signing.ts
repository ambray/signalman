/**
 * `signalman signing` verb implementations — WS9 Milestone 3.
 *
 * Mirrors the layering of `verbs/control-plane.ts`: pure async
 * functions taking a ControlPlane + typed input, returning typed
 * result. The CLI dispatcher (`cmdSigning` in `cli.ts`) and the MCP
 * tool handlers in `server.ts` both call into the same functions.
 *
 * Verbs:
 *   - runSigningProvidersList: enumerate providers visible to the
 *     control plane + their per-provider key counts.
 *   - runSigningKeysList: read the signing_provider_key catalog.
 *   - runSigningKeysAdd: register a new key. For local-disk hybrid,
 *     generates Ed25519 + ML-DSA-65 via LocalDiskProvider.generateHybridKey
 *     and inserts two paired catalog rows sharing a pair_id. For
 *     single-algorithm or cloud-KMS keys, generates / registers per
 *     the provider and inserts one row.
 *   - runSigningKeysRevoke: mark a key revoked (audit row written;
 *     past signatures still verify).
 *   - runSigningKeysRotate: generate a fresh key under the same alias,
 *     record the rotation linkage, audit-log it.
 *   - runSigningVerify: look up the key(s) by fingerprint(s) in the
 *     catalog, materialize PublicKeyRef(s), verify the supplied
 *     envelope. Supports hybrid envelopes (multi-fingerprint lookup).
 *   - runSigningNonceSweep: delete nonce rows older than the cutoff.
 *
 * Every mutating verb writes an audit-log row (signing.key_added /
 * signing.key_revoked / signing.key_rotated).
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { newId } from "../control-plane/ids.js";
import type { ControlPlane } from "../control-plane/index.js";
import {
  AwsKmsProvider,
  type KmsClientLike,
  LocalDiskProvider,
  SIGNING_ACTION_CODES,
  SigningError,
  type SigAlgorithm,
  type SignEnvelope,
  type VerifyMode,
} from "../control-plane/signing/index.js";
import type {
  AuditLogRepo,
  SigningProviderKey,
} from "../control-plane/storage/driver.js";
import {
  loadCredentialForOrg,
  type AwsCredentialPlaintext,
} from "../cloud/credentials.js";

// ── Provider list ───────────────────────────────────────────────────

export interface ProvidersListEntry {
  provider: string;
  keyCount: number;
  /** Whether this provider is wired into the running control plane
   *  (i.e. callable for sign/verify). v0.5.0 always has local-disk
   *  available; v0.6+ adds aws-kms / azure-kv / gcp-kms when
   *  AwsKmsProvider et al. land. */
  configured: boolean;
}

export async function runSigningProvidersList(
  cp: ControlPlane,
  orgId: string,
): Promise<ProvidersListEntry[]> {
  const allKeys = await cp.signingProviderKeys.list(orgId, {
    includeRevoked: true,
  });
  const countsByProvider = new Map<string, number>();
  for (const k of allKeys) {
    countsByProvider.set(k.provider, (countsByProvider.get(k.provider) ?? 0) + 1);
  }
  const knownProviders = new Set<string>([
    "local-disk",
    // M4: "aws-kms" added when AwsKmsProvider ships.
  ]);
  for (const p of countsByProvider.keys()) knownProviders.add(p);
  return [...knownProviders].sort().map((provider) => ({
    provider,
    keyCount: countsByProvider.get(provider) ?? 0,
    configured: provider === "local-disk",
  }));
}

// ── Keys: list ──────────────────────────────────────────────────────

export interface KeysListInput {
  provider?: string;
  includeRevoked?: boolean;
}

export async function runSigningKeysList(
  cp: ControlPlane,
  orgId: string,
  input: KeysListInput = {},
): Promise<readonly SigningProviderKey[]> {
  return cp.signingProviderKeys.list(orgId, input);
}

// ── Keys: add ───────────────────────────────────────────────────────

export interface KeysAddInput {
  provider: string;
  /** Operator-facing alias. For local-disk, becomes the filesystem
   *  alias (`<alias>-ed25519.{pub,key}` + `<alias>-mldsa65.{pub,key}`
   *  for hybrid). For cloud-KMS, becomes the catalog row's keyId
   *  display alias (alongside the actual ARN). */
  alias: string;
  /** Algorithm choice. Defaults to "hybrid" (Ed25519 + ML-DSA-65)
   *  per Q2 resolution. For aws-kms in M4, only `ecdsa-p256-sha256`
   *  is supported; `hybrid` is rejected. */
  algorithm?: "hybrid" | SigAlgorithm;
  /** For cloud-KMS providers: the cloud-side key id (ARN / vault path).
   *  Local-disk ignores this (the local-disk alias IS the key id). */
  keyId?: string;
  /** AWS region for aws-kms (defaults to AWS_REGION env var → "us-east-1"). */
  awsRegion?: string;
  /** Test seam: a mocked KMS client for `aws-kms` registration tests. */
  awsKmsClient?: KmsClientLike;
  /** Human label for the catalog row. */
  label?: string;
  /** Local-disk override: where to write key files. Default is
   *  ~/.signalman/keys. */
  keysDir?: string;
  /** Actor for the audit row. */
  actor: string;
}

export interface KeysAddResult {
  added: readonly SigningProviderKey[];
  classicalPath?: string;
  pqPath?: string;
}

export async function runSigningKeysAdd(
  cp: ControlPlane,
  orgId: string,
  input: KeysAddInput,
): Promise<KeysAddResult> {
  validateAlias(input.alias);
  if (input.provider === "aws-kms") {
    return addAwsKmsKey(cp, orgId, input);
  }
  if (input.provider !== "local-disk") {
    throw new SigningError(
      "internal-error",
      `provider "${input.provider}" is not yet supported by signing keys add (v0.5.0 ships local-disk + aws-kms)`,
    );
  }
  const algorithm = input.algorithm ?? "hybrid";
  const keysDir = input.keysDir ?? path.join(os.homedir(), ".signalman", "keys");
  await fs.mkdir(keysDir, { recursive: true });

  if (algorithm === "hybrid") {
    return addHybridLocalDiskKey(cp, orgId, input, keysDir);
  }
  return addSingleAlgoLocalDiskKey(cp, orgId, input, keysDir, algorithm);
}

async function addAwsKmsKey(
  cp: ControlPlane,
  orgId: string,
  input: KeysAddInput,
): Promise<KeysAddResult> {
  if (!input.keyId) {
    throw new SigningError(
      "internal-error",
      "aws-kms registration requires --key-id <ARN>",
    );
  }
  // Hybrid via AWS KMS is operator-tagged (KMS ML-DSA or local-fallback);
  // not in M4 scope. Default-hybrid input must be downgraded explicitly.
  const algorithm = input.algorithm ?? "ecdsa-p256-sha256";
  if (algorithm === "hybrid") {
    throw new SigningError(
      "algorithm-not-implemented",
      "hybrid via aws-kms is deferred; pass --algorithm ecdsa-p256-sha256 to register a classical-only KMS key in M4",
    );
  }
  if (algorithm !== "ecdsa-p256-sha256") {
    throw new SigningError(
      "algorithm-not-implemented",
      `aws-kms in M4 supports ecdsa-p256-sha256 only; got ${algorithm}`,
    );
  }

  // Resolve credentials + build the provider.
  const provider = await buildAwsKmsProvider(cp, orgId, input);
  const cached = await provider.fetchPublicKey(input.keyId);

  // Persist into the catalog with the cached public-key bytes so
  // verify() never needs KMS access.
  const row = await cp.signingProviderKeys.insert({
    orgId,
    provider: "aws-kms",
    keyId: input.keyId,
    algorithm: "ecdsa-p256-sha256",
    fingerprint: cached.fingerprint,
    publicKeyB64: cached.publicKeyDer.toString("base64"),
    label: input.label ?? input.alias ?? null,
    addedBy: input.actor,
  });
  await writeKeyAddedRow(cp.auditLog, {
    orgId,
    actor: input.actor,
    fingerprint: cached.fingerprint,
    detail: {
      provider: "aws-kms",
      keyId: input.keyId,
      algorithm: "ecdsa-p256-sha256",
      fingerprint: cached.fingerprint,
      alias: input.alias,
      label: input.label ?? null,
    },
  });
  return { added: [row] };
}

async function buildAwsKmsProvider(
  cp: ControlPlane,
  orgId: string,
  input: KeysAddInput,
): Promise<AwsKmsProvider> {
  let credentials: AwsCredentialPlaintext | undefined;
  if (input.awsKmsClient) {
    // Test seam: a mocked client is supplied; credentials are
    // synthesized because the real client never runs.
    credentials = {
      access_key_id: "test-access-key",
      secret_access_key: "test-secret",
    };
  } else {
    const plaintext = await loadCredentialForOrg(
      cp.cloudCredentials,
      orgId,
      "aws",
    );
    if (!plaintext) {
      throw new SigningError(
        "internal-error",
        `aws-kms registration requires AWS credentials for org ${orgId}. Run \`signalman cloud creds set --provider aws --org-id ${orgId} ...\` first.`,
      );
    }
    // Discriminator: aws-shaped plaintext has access_key_id.
    if (!("access_key_id" in plaintext)) {
      throw new SigningError(
        "internal-error",
        `org ${orgId} has non-AWS credentials registered under backend=aws; cannot proceed`,
      );
    }
    credentials = plaintext as AwsCredentialPlaintext;
  }
  const region =
    input.awsRegion ?? process.env.AWS_REGION ?? "us-east-1";
  return new AwsKmsProvider({
    region,
    credentials,
    client: input.awsKmsClient,
  });
}

async function addHybridLocalDiskKey(
  cp: ControlPlane,
  orgId: string,
  input: KeysAddInput,
  keysDir: string,
): Promise<KeysAddResult> {
  const provider = new LocalDiskProvider({ keysDir });
  const gen = provider.generateHybridKey(input.alias);
  const pairId = newId();
  // Compute the public-key bytes for catalog storage.
  const classicalPubPem = await fs.readFile(gen.classicalPubPath, "utf-8");
  const classicalRef = publicKeyB64FromPem(classicalPubPem);
  const pqPubBytes = (await fs.readFile(gen.pqPubPath)).subarray(4); // strip MLDA magic
  const pqPubB64 = Buffer.from(pqPubBytes).toString("base64");

  const classicalRow = await cp.signingProviderKeys.insert({
    orgId,
    provider: "local-disk",
    keyId: input.alias,
    algorithm: "ed25519",
    fingerprint: gen.classicalFingerprint,
    publicKeyB64: classicalRef,
    pairId,
    pairRole: "classical",
    hybridAlias: input.alias,
    label: input.label ?? null,
    addedBy: input.actor,
  });
  const pqRow = await cp.signingProviderKeys.insert({
    orgId,
    provider: "local-disk",
    keyId: input.alias,
    algorithm: "ml-dsa-65",
    fingerprint: gen.pqFingerprint,
    publicKeyB64: pqPubB64,
    pairId,
    pairRole: "post-quantum",
    hybridAlias: input.alias,
    label: input.label ?? null,
    addedBy: input.actor,
  });

  await writeKeyAddedRow(cp.auditLog, {
    orgId,
    actor: input.actor,
    fingerprint: classicalRow.fingerprint,
    detail: {
      provider: "local-disk",
      keyId: input.alias,
      algorithm: "hybrid",
      fingerprint: classicalRow.fingerprint,
      pqFingerprint: pqRow.fingerprint,
      pairId,
      hybridAlias: input.alias,
      label: input.label ?? null,
    },
  });

  return {
    added: [classicalRow, pqRow],
    classicalPath: gen.classicalKeyPath,
    pqPath: gen.pqKeyPath,
  };
}

async function addSingleAlgoLocalDiskKey(
  cp: ControlPlane,
  orgId: string,
  input: KeysAddInput,
  keysDir: string,
  algorithm: SigAlgorithm,
): Promise<KeysAddResult> {
  if (algorithm === "ml-dsa-65") {
    // PQ-only single-algorithm keys land in M3+ — for now, gen via
    // generateHybridKey and discard the classical half. Functional,
    // not pretty; future iteration can split generateHybridKey into
    // generateClassical + generateMldsa65 if there's operator demand.
    throw new SigningError(
      "algorithm-not-implemented",
      "PQ-only (ml-dsa-65) single-algorithm key generation is not yet exposed by the CLI in M3; use --algorithm hybrid or run `signing keys add --provider local-disk --algorithm ed25519` for classical-only",
    );
  }
  if (algorithm !== "ed25519" && algorithm !== "ecdsa-p256-sha256") {
    throw new SigningError("unknown-algorithm", `unknown algorithm ${algorithm}`);
  }

  // Generate a single PEM keypair via node:crypto directly. The catalog
  // row + filesystem paths follow the v0.4.x layout (<alias>.{pub,key}).
  const crypto = await import("node:crypto");
  const kp =
    algorithm === "ed25519"
      ? crypto.generateKeyPairSync("ed25519", {
          publicKeyEncoding: { type: "spki", format: "pem" },
          privateKeyEncoding: { type: "pkcs8", format: "pem" },
        })
      : crypto.generateKeyPairSync("ec", {
          namedCurve: "prime256v1",
          publicKeyEncoding: { type: "spki", format: "pem" },
          privateKeyEncoding: { type: "pkcs8", format: "pem" },
        });
  const pubPath = path.join(keysDir, `${input.alias}.pub`);
  const privPath = path.join(keysDir, `${input.alias}.key`);
  await fs.writeFile(pubPath, kp.publicKey as string, "utf-8");
  await fs.writeFile(privPath, kp.privateKey as string, {
    encoding: "utf-8",
    mode: 0o600,
  });
  const pubKey = crypto.createPublicKey(kp.publicKey as string);
  const der = pubKey.export({ type: "spki", format: "der" }) as Buffer;
  const fingerprint = crypto
    .createHash("sha256")
    .update(der)
    .digest("hex")
    .slice(0, 16);

  const row = await cp.signingProviderKeys.insert({
    orgId,
    provider: "local-disk",
    keyId: input.alias,
    algorithm,
    fingerprint,
    publicKeyB64: der.toString("base64"),
    label: input.label ?? null,
    addedBy: input.actor,
  });

  await writeKeyAddedRow(cp.auditLog, {
    orgId,
    actor: input.actor,
    fingerprint,
    detail: {
      provider: "local-disk",
      keyId: input.alias,
      algorithm,
      fingerprint,
      label: input.label ?? null,
    },
  });

  return {
    added: [row],
    classicalPath: privPath,
  };
}

// ── Keys: revoke ────────────────────────────────────────────────────

export interface KeysRevokeInput {
  /** Fingerprint (16 hex) OR alias. Alias resolves to all rows under
   *  it (hybrid pair → both halves revoked). */
  identifier: string;
  reason: string;
  actor: string;
}

export async function runSigningKeysRevoke(
  cp: ControlPlane,
  orgId: string,
  input: KeysRevokeInput,
): Promise<readonly SigningProviderKey[]> {
  const targets = await resolveTargets(cp, orgId, input.identifier);
  if (targets.length === 0) {
    throw new SigningError(
      "key-not-found",
      `no key matched identifier "${input.identifier}" for org ${orgId}`,
    );
  }
  const revoked: SigningProviderKey[] = [];
  for (const target of targets) {
    await cp.signingProviderKeys.revoke({
      orgId,
      fingerprint: target.fingerprint,
      revokedBy: input.actor,
      reason: input.reason,
    });
    await cp.auditLog.append({
      orgId,
      actor: input.actor,
      action: SIGNING_ACTION_CODES.KEY_REVOKED,
      entityType: "signing_key",
      entityId: target.fingerprint,
      detail: {
        provider: target.provider,
        fingerprint: target.fingerprint,
        reason: input.reason,
      },
    });
    const updated = await cp.signingProviderKeys.getByFingerprint(
      orgId,
      target.fingerprint,
    );
    if (updated) revoked.push(updated);
  }
  return revoked;
}

// ── Keys: rotate ────────────────────────────────────────────────────

export interface KeysRotateInput {
  identifier: string;
  actor: string;
  keysDir?: string;
}

export interface KeysRotateResult {
  oldKeys: readonly SigningProviderKey[];
  newKeys: readonly SigningProviderKey[];
}

export async function runSigningKeysRotate(
  cp: ControlPlane,
  orgId: string,
  input: KeysRotateInput,
): Promise<KeysRotateResult> {
  const targets = await resolveTargets(cp, orgId, input.identifier);
  if (targets.length === 0) {
    throw new SigningError(
      "key-not-found",
      `no key matched identifier "${input.identifier}" for org ${orgId}`,
    );
  }
  // Only local-disk rotation is supported in M3. Cloud-KMS rotation
  // ships with AwsKmsProvider in M4.
  for (const t of targets) {
    if (t.provider !== "local-disk") {
      throw new SigningError(
        "internal-error",
        `rotation of "${t.provider}" keys is not yet implemented in M3 (AwsKmsProvider in M4)`,
      );
    }
  }

  // Resolve the operator-facing alias (the hybridAlias on hybrid keys,
  // or the keyId on single-algorithm keys). All targets in a hybrid
  // pair share the same alias by construction.
  const alias = targets[0]!.hybridAlias ?? targets[0]!.keyId;
  const isHybrid = targets.length === 2 && targets.every((t) => t.pairId);
  const keysDir = input.keysDir ?? path.join(os.homedir(), ".signalman", "keys");

  // Generate a fresh key + insert new catalog rows. Generate under a
  // temporary alias suffix to avoid clobbering the on-disk files in
  // place; M3 doesn't archive — that's an M5 hardening pass.
  const newAlias = `${alias}-rot-${Date.now()}`;
  const addResult = await runSigningKeysAdd(cp, orgId, {
    provider: "local-disk",
    alias: newAlias,
    algorithm: isHybrid ? "hybrid" : targets[0]!.algorithm,
    label: targets[0]!.label ?? undefined,
    keysDir,
    actor: input.actor,
  });

  // Record rotation linkage for each old row → corresponding new row.
  // For hybrid: classical→classical, pq→pq (matched by algorithm).
  for (const old of targets) {
    const replacement = addResult.added.find(
      (n) => n.algorithm === old.algorithm,
    );
    if (!replacement) continue;
    await cp.signingProviderKeys.recordRotation({
      orgId,
      oldFingerprint: old.fingerprint,
      newFingerprint: replacement.fingerprint,
    });
    await cp.auditLog.append({
      orgId,
      actor: input.actor,
      action: SIGNING_ACTION_CODES.KEY_ROTATED,
      entityType: "signing_key",
      entityId: old.fingerprint,
      detail: {
        provider: "local-disk",
        oldFingerprint: old.fingerprint,
        newFingerprint: replacement.fingerprint,
        algorithm: old.algorithm,
      },
    });
  }
  return { oldKeys: targets, newKeys: addResult.added };
}

// ── Verify ──────────────────────────────────────────────────────────

export interface VerifyInput {
  /** SignEnvelope to verify. */
  envelope: SignEnvelope;
  /** Payload bytes (canonical-form already applied by the caller). */
  payload: Uint8Array;
  /** Verifier mode; default "transition" (the operator-friendly choice
   *  during PQ migration). */
  mode?: VerifyMode;
}

export interface VerifyResultDetail {
  ok: boolean;
  reason?: string;
  reasonCode?: string;
  matchedKeys: readonly { algorithm: string; fingerprint: string }[];
  missingKeys: readonly { algorithm: string; fingerprint: string }[];
}

export async function runSigningVerify(
  cp: ControlPlane,
  orgId: string,
  input: VerifyInput,
): Promise<VerifyResultDetail> {
  const matchedKeys: { algorithm: string; fingerprint: string }[] = [];
  const missingKeys: { algorithm: string; fingerprint: string }[] = [];
  const keyRefs = [];
  for (const entry of input.envelope.signatures) {
    const row = await cp.signingProviderKeys.getByFingerprint(
      orgId,
      entry.signedBy,
    );
    if (!row) {
      missingKeys.push({ algorithm: entry.algorithm, fingerprint: entry.signedBy });
      continue;
    }
    matchedKeys.push({ algorithm: entry.algorithm, fingerprint: entry.signedBy });
    keyRefs.push({
      keyId: row.keyId,
      provider: row.provider,
      algorithm: row.algorithm,
      publicKeyB64: row.publicKeyB64,
      fingerprint: row.fingerprint,
    });
  }
  if (keyRefs.length === 0) {
    return {
      ok: false,
      reasonCode: "key-not-found",
      reason: "no public keys in the catalog matched the envelope's signedBy fingerprints",
      matchedKeys,
      missingKeys,
    };
  }
  const provider = new LocalDiskProvider();
  const verifyRes = await provider.verify(
    input.envelope,
    input.payload,
    keyRefs,
    input.mode ?? "transition",
  );
  return {
    ok: verifyRes.ok,
    reasonCode: verifyRes.reasonCode,
    reason: verifyRes.reason,
    matchedKeys,
    missingKeys,
  };
}

// ── Nonce sweep ─────────────────────────────────────────────────────

export interface NonceSweepInput {
  olderThanHours?: number;
}

export async function runSigningNonceSweep(
  cp: ControlPlane,
  input: NonceSweepInput = {},
): Promise<{ deletedRows: number; cutoff: string }> {
  const hours = input.olderThanHours ?? 24;
  if (hours <= 0) {
    throw new SigningError(
      "internal-error",
      `--older-than-hours must be > 0 (got ${hours})`,
    );
  }
  const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
  const deletedRows = await cp.signingNonces.sweepOlderThan(cutoff);
  return { deletedRows, cutoff };
}

// ── Helpers ─────────────────────────────────────────────────────────

function validateAlias(alias: string): void {
  if (
    alias.length === 0 ||
    alias.includes("/") ||
    alias.includes(path.sep) ||
    alias.includes("..")
  ) {
    throw new SigningError(
      "internal-error",
      `alias "${alias}" must be non-empty and contain no path separators`,
    );
  }
}

function publicKeyB64FromPem(pem: string): string {
  // Lazy-load to avoid pulling crypto into the type-only top-level
  // when consumers care about the run* types only.
  const crypto = require("node:crypto") as typeof import("node:crypto");
  const der = crypto
    .createPublicKey(pem)
    .export({ type: "spki", format: "der" }) as Buffer;
  return der.toString("base64");
}

async function resolveTargets(
  cp: ControlPlane,
  orgId: string,
  identifier: string,
): Promise<readonly SigningProviderKey[]> {
  if (/^[0-9a-fA-F]{16}$/.test(identifier)) {
    const row = await cp.signingProviderKeys.getByFingerprint(orgId, identifier);
    return row ? [row] : [];
  }
  return cp.signingProviderKeys.getByAlias(orgId, identifier);
}

async function writeKeyAddedRow(
  auditLog: AuditLogRepo,
  args: {
    orgId: string;
    actor: string;
    fingerprint: string;
    detail: Record<string, unknown>;
  },
): Promise<void> {
  await auditLog.append({
    orgId: args.orgId,
    actor: args.actor,
    action: SIGNING_ACTION_CODES.KEY_ADDED,
    entityType: "signing_key",
    entityId: args.fingerprint,
    detail: args.detail,
  });
}
