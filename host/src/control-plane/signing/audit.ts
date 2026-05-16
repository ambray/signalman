/**
 * WS9 audit-log integration — canonical action codes + helpers.
 *
 * Every signing operation writes audit-log rows. The action-code
 * strings here are the canonical set; cross-referenced in
 * `docs/supply-chain.md` §Audit-log canonical action codes. Adding
 * a new code is additive (never rename — operators query history
 * by string match).
 *
 * Detail-blob conventions (each row's `detail` JSON):
 *   signing.requested  — { provider, keyId, algorithm, nonce, requestedAt, purpose, payloadSha256 }
 *   signing.completed  — { provider, keyId, signedBy, signedAt, nonce, payloadSha256, algorithms[] }
 *   signing.failed     — { provider, keyId, nonce, errorCode, errorMessage }
 *   signing.key_added  — { provider, keyId, algorithm, fingerprint, pairId?, hybridAlias?, label? }
 *   signing.key_revoked— { provider, fingerprint, reason }
 *   signing.key_rotated— { provider, oldFingerprint, newFingerprint }
 *
 * `entityType` is `signing_key`; `entityId` is the key fingerprint
 * (or `nonce:<value>` for failed-with-no-key-context rows).
 */

import type { AuditLogRepo } from "../storage/driver.js";

import type {
  ActorRef,
  SigEntry,
  SignEnvelope,
  SignRequest,
} from "./types.js";

export const SIGNING_ACTION_CODES = {
  REQUESTED: "signing.requested",
  COMPLETED: "signing.completed",
  FAILED: "signing.failed",
  KEY_ADDED: "signing.key_added",
  KEY_REVOKED: "signing.key_revoked",
  KEY_ROTATED: "signing.key_rotated",
} as const;

export type SigningActionCode =
  (typeof SIGNING_ACTION_CODES)[keyof typeof SIGNING_ACTION_CODES];

/**
 * Format an actor reference into the audit row's `actor` column.
 * Convention: `<kind>:<cn>` so consumers grep'ing by actor see the
 * identity kind alongside the CN.
 */
export function actorString(actor: ActorRef): string {
  return `${actor.kind}:${actor.cn}`;
}

/**
 * Write a `signing.requested` audit row. Called by the provider
 * BEFORE the cryptographic sign op. Replay-rejection failures
 * surface via `signing.failed` (separate writeFailedRow call); the
 * happy path completes with writeCompletedRow afterwards.
 */
export async function writeRequestedRow(
  auditLog: AuditLogRepo,
  args: {
    actor: ActorRef;
    orgId: string;
    request: SignRequest;
    provider: string;
    fingerprint: string;
    payloadSha256: string;
  },
): Promise<void> {
  await auditLog.append({
    orgId: args.orgId,
    actor: actorString(args.actor),
    action: SIGNING_ACTION_CODES.REQUESTED,
    entityType: "signing_key",
    entityId: args.fingerprint,
    detail: {
      provider: args.provider,
      keyId: args.request.keyId,
      nonce: args.request.nonce,
      requestedAt: args.request.requestedAt,
      purpose: args.request.purpose,
      payloadSha256: args.payloadSha256,
    },
  });
}

/**
 * Write a `signing.completed` row after a successful sign(). For
 * hybrid keys this records BOTH sub-key fingerprints in the detail
 * `algorithms` array; entityId is the classical fingerprint (or the
 * only fingerprint for single-algorithm keys) so per-key audit
 * queries find the row.
 */
export async function writeCompletedRow(
  auditLog: AuditLogRepo,
  args: {
    actor: ActorRef;
    orgId: string;
    request: SignRequest;
    envelope: SignEnvelope;
    provider: string;
  },
): Promise<void> {
  const entityId = pickPrimaryFingerprint(args.envelope.signatures);
  await auditLog.append({
    orgId: args.orgId,
    actor: actorString(args.actor),
    action: SIGNING_ACTION_CODES.COMPLETED,
    entityType: "signing_key",
    entityId,
    detail: {
      provider: args.provider,
      keyId: args.request.keyId,
      nonce: args.envelope.nonce,
      payloadSha256: args.envelope.payloadSha256,
      algorithms: args.envelope.signatures.map((s) => ({
        algorithm: s.algorithm,
        signedBy: s.signedBy,
        signedAt: s.signedAt,
      })),
    },
  });
}

/**
 * Write a `signing.failed` row when sign() rejects a request
 * (replay, clock skew, missing actor, etc.). For replay-rejection
 * we record the nonce that was reused so operators correlate the
 * failure with the original `signing.requested` row.
 */
export async function writeFailedRow(
  auditLog: AuditLogRepo,
  args: {
    actor: ActorRef;
    orgId: string;
    request: SignRequest;
    provider: string;
    fingerprint?: string;
    errorCode: string;
    errorMessage: string;
  },
): Promise<void> {
  await auditLog.append({
    orgId: args.orgId,
    actor: actorString(args.actor),
    action: SIGNING_ACTION_CODES.FAILED,
    entityType: "signing_key",
    entityId: args.fingerprint ?? `nonce:${args.request.nonce}`,
    detail: {
      provider: args.provider,
      keyId: args.request.keyId,
      nonce: args.request.nonce,
      errorCode: args.errorCode,
      errorMessage: args.errorMessage,
    },
  });
}

/**
 * Pick the fingerprint that goes into the audit row's `entityId`.
 * For hybrid envelopes we prefer the classical fingerprint (Ed25519
 * half) because v0.4.x-era operator tooling already knows that
 * identifier from the release row's `signed_by` column; PQ
 * fingerprints are recorded in the detail blob too.
 */
function pickPrimaryFingerprint(entries: readonly SigEntry[]): string {
  const classical = entries.find((e) => e.algorithm !== "ml-dsa-65");
  return (classical ?? entries[0]!).signedBy;
}
