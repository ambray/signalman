---
name: signalman-verify-release
description: Verify a release's Ed25519 manifest signature against a public key. Confirms both the fingerprint match (the public key signs releases with this `signed_by` value) and the cryptographic signature over the canonical manifest. Trigger when the user says "verify release <id>", "check the signature on <release>", "is <release> trustworthy", "confirm this build was signed by <key>", or any "is this what I think it is" intent against a release.
allowed-tools: mcp__signalman__signalman_release_verify
---

# Verify a release's Ed25519 signature

`signalman_release_verify` is the trust-verification MCP tool added in
milestone 2. It fetches the stored manifest + signature + `signed_by`
fingerprint for a release, then confirms:

1. The first 16 hex chars of sha256(DER pubkey) equal the release's
   stored `signed_by`. (Fingerprint match.)
2. Ed25519 verify of the stored signature against the reconstructed
   canonical manifest succeeds. (Cryptographic match.)
3. The reconstructed manifest hash equals the stored `manifest_sha256`.
   (Catalog-integrity match — guards against post-build tampering with
   artifact rows.)

All three must hold. Any failure → `verified: false` with a reason.

## What you need from the user

- **`release_id`** — release ULID. From `signalman_release_list` or the
  earlier `signalman_release_show` / `signalman_release_build` result.
- **A public key**, supplied as exactly one of:
  - **`public_key_path`** — filesystem path on the host running the
    Signalman host process. Use this in local/self-hosted mode where
    the keys are on the same machine as the agent.
  - **`public_key_pem`** — the literal PEM text inline. Use this in
    hosted mode where the agent runs on a different machine than the
    keys, or when supplying a key the user pasted into chat.

Passing **both** or **neither** is rejected at the input boundary —
the MCP wrapper enforces mutual exclusion.

If the user doesn't have a public key:
- They may want to generate one (use the `signalman-key-management`
  skill — both keys are minted; the public half verifies any release
  signed with the matching private half).
- They may want to fetch one from the release-signer's published
  location (project repo, signed URL, etc.). Don't accept a key the
  user just downloaded without confirming the channel was trustworthy.

## How to invoke

```jsonc
// signalman_release_verify — host-local key path
{
  "release_id": "01HX1234ABCD...",
  "public_key_path": "/home/operator/.signalman/keys/signing.pub"
}

// signalman_release_verify — inline PEM (hosted / pasted)
{
  "release_id": "01HX1234ABCD...",
  "public_key_pem": "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA...\n-----END PUBLIC KEY-----\n"
}
```

## Expected response

Success:

```jsonc
{
  "verified": true,
  "release": {
    "id": "01HX1234ABCD...",
    "tag": "v1.4.2",
    "product": "myapp",
    "manifest_sha256": "0a1b2c...",
    "signed_by": "abc123def456..."
  }
}
```

Failure:

```jsonc
{
  "verified": false,
  "release": {
    "id": "01HX1234ABCD...",
    "tag": "v1.4.2",
    "product": "myapp",
    "manifest_sha256": "0a1b2c...",
    "signed_by": "abc123def456..."
  },
  "reason": "key fingerprint mismatch: expected abc123…, got 7d8e9f…"
}
```

`reason` describes which gate failed:

| Reason class | What it means | What to tell the user |
|---|---|---|
| `key fingerprint mismatch` | The public key you passed doesn't sign releases with this `signed_by`. | Either wrong key for this release, or this release was signed by someone else. Compare `signed_by` against the expected signer. |
| `manifest reconstruction mismatch` | The artifacts table doesn't reconstruct the stored manifest hash. **Investigate — the catalog may have been tampered with after signing.** Do NOT deploy. | Surface the comparison verbatim; the operator owns the next step. |
| `signature verification failed` | Fingerprint matched but the bytes don't verify. Indicates manifest tampering between signing and now, OR a private key compromise. | Same as above — surface, do not deploy. |
| `release is unsigned` | The release row has no `signature_b64` / `signed_by`. The build was not signed. | Tell the user this release pre-dates signing or was built without `--sign`. Re-sign if the operator owns the original build. |

## Errors you may see

| Error class | What happened | What to tell the user |
|---|---|---|
| input validation | Both `public_key_path` and `public_key_pem` were sent, or neither. | The MCP tool rejects both / neither at the input boundary. Resend with exactly one. |
| `release not found` | Bad `release_id`. | Surface `signalman_release_list` so the user can pick the right id. |
| `ENOENT` (file read) | `public_key_path` points at a non-existent file (host-side). | Operator typo on the path; surface verbatim. |

## What NOT to do

- **Never** treat a `verified: false` response as "probably fine."
  This is the signing-trust check; failure is a hard signal.
- **Never** advise the user to "skip verification and deploy" — there
  is no override flag and that's intentional. If the operator wants
  to bypass, that's their decision to own outside of this skill.
- **Don't** synthesize the public key yourself (e.g., extracting it
  from somewhere). The user needs to supply a key they trust.
- **Don't** copy `public_key_pem` content into chat logs / persistent
  storage unnecessarily; public keys aren't secret but echoing them
  bloats the transcript.
- **Don't** confuse `release_verify` (signature trust) with
  `health_check` (probe-runtime trust). They check orthogonal
  properties.

## Follow-up suggestions

- Verified successfully → `signalman-deploy-to-test` /
  `signalman-deploy-to-demo` / `signalman-deploy-to-cloud-vm`
  (milestone 4).
- Fingerprint mismatch → run `signalman_release_show <id>` to see the
  actual `signed_by`; reconcile with the expected signer.
- Manifest reconstruction mismatch → **stop and investigate**. Surface
  the `build_log_blob_uri` from `signalman_release_show` so the
  operator can audit the build. Do not deploy until resolved.
- Want to verify in CI? The MCP tool returns a structured
  `verified: boolean` — wire that into a CI gate. CLI parity:
  `signalman release verify <id> --public-key <path>` (exit 0 on
  trust, exit 1 on failure).
