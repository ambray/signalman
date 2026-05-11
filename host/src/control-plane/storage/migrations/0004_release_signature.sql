-- Add the cryptographic-signature column on the release row.
-- See docs/design/meta-build-system.md §12 (v0.3 phasing) + the new
-- control-plane/build/signing.ts module.
--
-- Layout:
--   * `signature_b64` is base64-encoded Ed25519 signature bytes (88
--     base64 chars for the 64-byte raw sig). Stored as TEXT in both
--     SQLite and Postgres; the row mappers and verifier base64-decode
--     it before passing to crypto.verify.
--   * The existing `signed_by` column holds the public-key
--     fingerprint that produced the signature — the first 16 hex
--     chars of sha256(DER-encoded public key). Operators verifying a
--     release pair (signature_b64, signed_by) against a known public
--     key to confirm both the integrity and the signer identity.
--
-- Nullable for compatibility with releases built before this
-- migration; the build executor only writes a signature when the
-- operator passes `--sign --key <path>`.

ALTER TABLE release ADD COLUMN signature_b64 TEXT;
