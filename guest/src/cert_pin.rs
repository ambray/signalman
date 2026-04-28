//! Client-cert SHA-256 pinning (B2 / Sec F1 Critical mitigation).
//!
//! ## Why this exists
//!
//! v0.1.0's mTLS configuration authenticates the **channel**, not the
//! **caller**. Any cert chained to the configured `--tls-ca` is treated
//! as a valid Signalman host. In single-user dev that's fine, but in
//! any deployment where the CA bundle leaks (or a malicious operator
//! has minted their own host cert from the same CA), the attacker gets
//! full SYSTEM-RCE on every guest agent that trusts the CA.
//!
//! Per-user identity certs ship in v0.2.0+. Until then, **pinning the
//! exact client cert** turns "any cert from this CA" into "this exact
//! cert" — the same posture as TLS public-key pinning in mobile apps.
//! Rotation becomes "update the pinned hash"; compromise of the CA no
//! longer compromises every guest.
//!
//! ## How
//!
//! 1. Operator passes `--client-cert-sha256 <hex>` (or
//!    `SIGNALMAN_CLIENT_CERT_SHA256`) at guest agent startup. The flag
//!    accepts a comma-separated list to support cert rotation
//!    (configure both old + new hashes during the rollover window).
//! 2. The auth interceptor, AFTER the bearer-token check, looks at the
//!    leaf client cert presented during the mTLS handshake (exposed
//!    through `tonic::transport::server::TlsConnectInfo::peer_certs`).
//! 3. The cert's DER bytes are SHA-256'd; the resulting 32 bytes are
//!    compared (constant-time) against every pin in the configured set.
//!    First match wins; no match = `Status::unauthenticated`.
//!
//! ## Layering
//!
//! Pin verification happens IN ADDITION to:
//!   - mTLS chain validation (`--tls-ca` configures the trust anchor),
//!   - bearer-token authentication (`--token`).
//!
//! All three must pass for a request to reach the handler. Removing
//! any layer is an explicit operator action; the defaults compose.
//!
//! ## What we DON'T do (yet)
//!
//! - **Subject Public Key Info (SPKI) pinning.** SPKI pinning is
//!   marginally more flexible (survives cert re-issue with the same
//!   keypair) but requires extracting the SPKI bytes out of the X.509
//!   structure, which means pulling in an X.509 parser. For v0.1.0 we
//!   pin the full cert; if rotation pain materializes in practice, we
//!   add SPKI as a second pin format in v0.2.0.
//! - **Pin-rotation tooling.** Operators copy/paste hashes today.
//!   v0.2.0 plans an MSI-installer hook that prompts for the new pin
//!   on cert rotation.

use anyhow::{anyhow, bail, Context, Result};
use sha2::{Digest, Sha256};

/// A parsed cert-pin set. Empty when no pinning is configured.
///
/// Stored as `[u8; 32]` (the raw hash bytes) rather than the hex string
/// so the per-request comparison doesn't have to re-decode hex on every
/// RPC.
#[derive(Debug, Clone, Default)]
pub struct PinSet {
    pins: Vec<[u8; 32]>,
}

impl PinSet {
    /// Parse a comma-separated hex string into a [`PinSet`].
    ///
    /// Each entry must be exactly 64 hex characters (case-insensitive,
    /// optional `sha256:` prefix accepted). Whitespace around entries is
    /// trimmed. Empty entries (e.g. trailing comma) are skipped.
    ///
    /// Errors:
    /// - any entry that isn't 64 hex characters after prefix-strip,
    /// - any entry containing non-hex bytes.
    pub fn parse(input: &str) -> Result<Self> {
        let mut pins: Vec<[u8; 32]> = Vec::new();
        for raw in input.split(',') {
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                continue;
            }
            // Tolerate `sha256:<hex>` form for symmetry with how
            // operators see hashes printed by tools like `openssl
            // x509 -fingerprint -sha256` and HPKP-style configs.
            let stripped = trimmed
                .strip_prefix("sha256:")
                .or_else(|| trimmed.strip_prefix("SHA256:"))
                .unwrap_or(trimmed);
            if stripped.len() != 64 {
                bail!(
                    "client-cert-sha256 entry '{}' must be 64 hex chars (got {})",
                    trimmed,
                    stripped.len(),
                );
            }
            let bytes = hex::decode(stripped).with_context(|| {
                format!("client-cert-sha256 entry '{}' is not valid hex", trimmed)
            })?;
            let arr: [u8; 32] = bytes
                .try_into()
                .map_err(|_| anyhow!("internal: hex::decode produced wrong length"))?;
            pins.push(arr);
        }
        Ok(Self { pins })
    }

    /// True when no pins are configured (pinning disabled).
    pub fn is_empty(&self) -> bool {
        self.pins.is_empty()
    }

    /// Number of pins in the set.
    pub fn len(&self) -> usize {
        self.pins.len()
    }

    /// Returns true if the SHA-256 of `cert_der` matches any configured
    /// pin. Comparison is constant-time per-pin (defends against the
    /// same timing side channel the bearer-token check addresses).
    pub fn verify(&self, cert_der: &[u8]) -> bool {
        if self.pins.is_empty() {
            // The caller is expected to gate on `is_empty()` before
            // calling `verify`, but we defensively return false here:
            // an empty pin set should NEVER mean "match anything", that
            // would be a configuration trap.
            return false;
        }
        let actual = Sha256::digest(cert_der);
        let actual_arr: [u8; 32] = actual.into();
        self.pins
            .iter()
            .any(|pin| constant_time_eq32(pin, &actual_arr))
    }
}

/// Constant-time `[u8; 32]` equality. Identical pattern to the
/// `constant_time_eq` in `main.rs`, specialized for fixed-length 32-byte
/// hashes (no length-mismatch branch — both sides are SHA-256 output).
fn constant_time_eq32(a: &[u8; 32], b: &[u8; 32]) -> bool {
    let mut diff: u8 = 0;
    for i in 0..32 {
        diff |= a[i] ^ b[i];
    }
    diff == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    /// SHA-256 of "hello" — easy to verify externally with
    /// `echo -n hello | sha256sum`.
    const HELLO_SHA256: &str = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
    /// SHA-256 of "world".
    const WORLD_SHA256: &str = "486ea46224d1bb4fb680f34f7c9ad96a8f24ec88be73ea8e5a6c65260e9cb8a7";

    #[test]
    fn parse_single_pin() {
        let set = PinSet::parse(HELLO_SHA256).unwrap();
        assert_eq!(set.len(), 1);
        assert!(!set.is_empty());
    }

    #[test]
    fn parse_multi_pin_comma_separated() {
        let input = format!("{HELLO_SHA256}, {WORLD_SHA256}");
        let set = PinSet::parse(&input).unwrap();
        assert_eq!(set.len(), 2);
    }

    #[test]
    fn parse_accepts_sha256_prefix() {
        let set = PinSet::parse(&format!("sha256:{HELLO_SHA256}")).unwrap();
        assert_eq!(set.len(), 1);
    }

    #[test]
    fn parse_accepts_uppercase_hex() {
        let upper = HELLO_SHA256.to_uppercase();
        let set = PinSet::parse(&upper).unwrap();
        assert_eq!(set.len(), 1);
    }

    #[test]
    fn parse_skips_empty_entries() {
        let input = format!(",{HELLO_SHA256},,");
        let set = PinSet::parse(&input).unwrap();
        assert_eq!(set.len(), 1);
    }

    #[test]
    fn parse_rejects_short_hash() {
        let err = PinSet::parse("deadbeef").unwrap_err();
        assert!(
            err.to_string().contains("64 hex chars"),
            "unexpected error: {err}"
        );
    }

    #[test]
    fn parse_rejects_non_hex() {
        let bad = "z".repeat(64);
        assert!(PinSet::parse(&bad).is_err());
    }

    #[test]
    fn empty_input_yields_empty_pinset() {
        let set = PinSet::parse("").unwrap();
        assert!(set.is_empty());
        let set = PinSet::parse(",, ,").unwrap();
        assert!(set.is_empty());
    }

    #[test]
    fn verify_matches_when_hash_present() {
        let set = PinSet::parse(HELLO_SHA256).unwrap();
        assert!(set.verify(b"hello"));
    }

    #[test]
    fn verify_rejects_when_hash_absent() {
        let set = PinSet::parse(HELLO_SHA256).unwrap();
        assert!(!set.verify(b"world"));
        assert!(!set.verify(b"hello world"));
        assert!(!set.verify(b""));
    }

    #[test]
    fn verify_matches_any_pin_in_set() {
        // Rotation case: both old + new pins configured during rollover.
        let set = PinSet::parse(&format!("{HELLO_SHA256},{WORLD_SHA256}")).unwrap();
        assert!(set.verify(b"hello"));
        assert!(set.verify(b"world"));
        assert!(!set.verify(b"!!!"));
    }

    #[test]
    fn empty_pinset_never_verifies() {
        // Defensive: an unconfigured PinSet must not silently pass any
        // cert. The interceptor's contract is to gate on `is_empty()`
        // before calling `verify`, but if a future refactor forgets,
        // the verify method itself returns false rather than true.
        let set = PinSet::default();
        assert!(set.is_empty());
        assert!(!set.verify(b"anything"));
        assert!(!set.verify(&[0u8; 32]));
    }

    #[test]
    fn constant_time_eq32_matches_native() {
        let a = [1u8; 32];
        let b = [1u8; 32];
        let mut c = [1u8; 32];
        c[0] = 2;
        assert!(constant_time_eq32(&a, &b));
        assert!(!constant_time_eq32(&a, &c));
    }
}
