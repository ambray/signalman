-- migration 0090_signing_provider_key.sql (WS9 v0.5.0)
--
-- Catalog of provider-managed signing keys. The control plane reads
-- this to dispatch sign requests to the right provider and to
-- enumerate keys for the `signalman signing keys list` CLI surface.
-- Rows are written by `signalman signing keys add` (Milestone 3+) or
-- inserted at provider construction for LocalDiskProvider keys that
-- the operator registers explicitly.
--
-- Hybrid keys (Ed25519 + ML-DSA-65) are stored as TWO rows sharing a
-- `pair_id` and `hybrid_alias`, each with its own `algorithm` +
-- `pair_role`. Single-algorithm keys leave both pair fields NULL.
--
-- The actual key material lives at the provider:
--   - LocalDiskProvider: filesystem (~/.signalman/keys/<alias>-*.{pub,key})
--   - AwsKmsProvider:    AWS KMS (key_id is an ARN)
--   - …
-- This table is the LOCAL catalog; it does NOT store private keys.

CREATE TABLE signing_provider_key (
  id              TEXT PRIMARY KEY,
  org_id          TEXT NOT NULL REFERENCES org (id),
  provider        TEXT NOT NULL,                            -- "local-disk" | "aws-kms" | ...
  key_id          TEXT NOT NULL,                            -- provider-opaque (alias for local-disk; ARN for kms)
  algorithm       TEXT NOT NULL CHECK (algorithm IN ('ed25519', 'ecdsa-p256-sha256', 'ml-dsa-65')),
  fingerprint     TEXT NOT NULL,                            -- sha256(publicKeyBytes), first 16 hex
  public_key_b64  TEXT NOT NULL,                            -- base64-encoded public key bytes (cached for verify)
  pair_id         TEXT,                                     -- non-NULL for hybrid sub-keys; two rows share pair_id
  pair_role       TEXT CHECK (pair_role IN ('classical', 'post-quantum')),
  hybrid_alias    TEXT,                                     -- operator-facing alias when pair_id is set
  label           TEXT,                                     -- operator-supplied human label
  added_by        TEXT NOT NULL,                            -- actor that called `keys add`
  added_at        TEXT NOT NULL,
  revoked_at      TEXT,
  revoked_by      TEXT,
  revoke_reason   TEXT,
  rotated_to      TEXT,                                     -- self-FK to the new row when rotated
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  deleted_at      TEXT
);

CREATE UNIQUE INDEX signing_provider_key_fingerprint_unique
  ON signing_provider_key (org_id, fingerprint)
  WHERE deleted_at IS NULL;

CREATE INDEX signing_provider_key_provider_idx
  ON signing_provider_key (org_id, provider)
  WHERE deleted_at IS NULL AND revoked_at IS NULL;

CREATE INDEX signing_provider_key_pair_idx
  ON signing_provider_key (org_id, pair_id)
  WHERE deleted_at IS NULL AND pair_id IS NOT NULL;

CREATE INDEX signing_provider_key_alias_idx
  ON signing_provider_key (org_id, key_id)
  WHERE deleted_at IS NULL;
