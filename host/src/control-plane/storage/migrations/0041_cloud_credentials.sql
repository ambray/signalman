-- Per-org cloud credentials, encrypted at rest.
-- See docs/design/meta-build-system.md §13.7 + sub-task 6 commit 2.
--
-- Encryption: AES-256-GCM with a 32-byte key from
-- SIGNALMAN_CRED_KEY env var. The IV is a per-row 12-byte random
-- nonce; the auth tag is the last 16 bytes of the ciphertext blob.
-- Layout: `ciphertext_b64` = base64(<iv>||<ciphertext>||<auth_tag>).
--
-- The plaintext is a JSON document specific to the backend kind:
--   * aws:   { access_key_id, secret_access_key, session_token? }
--   * azure: { tenant_id, client_id, client_secret }
--
-- v0.3.0-5 ships env-var-key encryption only. KMS-derived keys
-- (aws-kms, azure-key-vault, age-encrypted-file per design §13.7)
-- land in v0.3.x with the same table — only `encryption_method`
-- gains new values.
--
-- Why the migration block 0040-0049 is reserved for sub-task 5
-- (cost-guardrails) but this is in 0041: sub-task 6's per-org
-- credentials are conceptually part of the cloud-cost / cloud-
-- abstraction substrate that 0040 started. Keeping them in the
-- same block makes it easier for operators to track when cloud
-- features landed.

CREATE TABLE IF NOT EXISTS cloud_org_credential (
  id                TEXT PRIMARY KEY NOT NULL,
  org_id            TEXT NOT NULL,
  backend           TEXT NOT NULL,
  -- Base64-encoded AES-GCM blob: iv (12 bytes) || ciphertext || auth_tag (16 bytes).
  ciphertext_b64    TEXT NOT NULL,
  -- Stable identifier for the encryption method so a future
  -- KMS-rotation pass can decrypt + re-encrypt the right way.
  encryption_method TEXT NOT NULL DEFAULT 'aes-gcm-env',
  -- Operator-visible hint that does NOT leak the secret —
  -- e.g. "AKIAIOSFODNN7EXAMPLE" → "AKIA****EXAMPLE". The MCP /
  -- CLI `get` returns this verbatim; the full secret only ever
  -- decrypts at the call site via `loadCredentialForOrg`.
  redacted_hint     TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

-- One credential per (org, backend). Operators rotating
-- credentials use the upsert path; multi-cred per org is a
-- v0.3.x followup that needs a profile/name selector.
CREATE UNIQUE INDEX IF NOT EXISTS cloud_org_credential_unique
  ON cloud_org_credential (org_id, backend);
