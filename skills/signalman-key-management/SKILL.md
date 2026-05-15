---
name: signalman-key-management
description: Generate a fresh Ed25519 signing keypair for Signalman release signing, or compute the fingerprint of an existing public key. Trigger when the user says "generate signing keys", "mint a release signing key", "what's the fingerprint of this key", "make me a new Ed25519 keypair", "key gen", or "check this key's fingerprint".
allowed-tools: mcp__signalman__signalman_key_generate, mcp__signalman__signalman_key_fingerprint
---

# Manage Signalman signing keys

Two MCP tools cover Ed25519 release-signing key operations:

- `signalman_key_generate` mints a fresh keypair. By default writes
  to `~/.signalman/keys/signing.{pub,key}` (private mode 0600); set
  `write_to_disk: false` for hosted-mode flows where the agent
  shouldn't write to the server's filesystem.
- `signalman_key_fingerprint` returns the 16-char fingerprint of any
  Ed25519 public key, accepting either an on-disk path or inline PEM.
  The fingerprint matches the `signed_by` field on releases signed
  with the matching private key.

## What you need from the user

For `signalman_key_generate`:

- (Optional) `name` — filename stem (default `signing`). The pair
  lands at `<out_dir>/<name>.pub` + `<out_dir>/<name>.key`. Use a
  distinct stem if the operator wants more than one signing key
  (e.g., `name: 'release-2026'`).
- (Optional) `out_dir` — directory to write into (default
  `~/.signalman/keys`). Ignored when `write_to_disk: false`.
- (Optional) `force` — overwrite existing files at the target paths.
  Default `false`; the call refuses to clobber otherwise.
- (Optional) `write_to_disk` — default `true`. Set `false` to have
  the response carry the PEMs inline; nothing is written. Use this
  in hosted mode or when the operator wants to escrow the keys
  themselves.

For `signalman_key_fingerprint`:

- Exactly one of:
  - `public_key_path` — filesystem path to a PEM on the host.
  - `public_key_pem` — literal PEM text inline.

Passing both or neither is rejected at the input boundary.

## How to invoke

```jsonc
// signalman_key_generate — typical local
{
  "name": "signing",
  "out_dir": "/home/operator/.signalman/keys",
  "force": false
}

// signalman_key_generate — hosted mode (no disk write)
{
  "write_to_disk": false
}

// signalman_key_fingerprint — path
{ "public_key_path": "/home/operator/.signalman/keys/signing.pub" }

// signalman_key_fingerprint — inline
{ "public_key_pem": "-----BEGIN PUBLIC KEY-----\n…\n-----END PUBLIC KEY-----\n" }
```

## Expected response

`signalman_key_generate` (disk write):

```jsonc
{
  "fingerprint": "abc123def4567890",
  "public_key_path": "/home/operator/.signalman/keys/signing.pub",
  "private_key_path": "/home/operator/.signalman/keys/signing.key",
  "written": true
}
```

`signalman_key_generate` (no disk write):

```jsonc
{
  "fingerprint": "abc123def4567890",
  "public_key_pem": "-----BEGIN PUBLIC KEY-----\n…\n-----END PUBLIC KEY-----\n",
  "private_key_pem": "-----BEGIN PRIVATE KEY-----\n…\n-----END PRIVATE KEY-----\n",
  "written": false
}
```

`signalman_key_fingerprint`:

```jsonc
{ "fingerprint": "abc123def4567890" }
```

## What NOT to do

- **Never** call `signalman_key_generate` with `force: true` without
  confirming what's at the existing path. Overwriting a signing key
  the operator has used to sign past releases means those releases
  can no longer be verified by anyone who only has the previous
  public key. Surface the conflict; let the operator decide.
- **Never** print the private key PEM to chat unnecessarily. When
  `write_to_disk: true`, the response does NOT include the PEM body
  — only the paths. When `write_to_disk: false`, surface the
  *fingerprint* and tell the operator the PEMs are in the response;
  don't paraphrase or re-emit the PEM contents into prose.
- **Don't** assume the default `~/.signalman/keys/` is where the
  operator wants the keys. In multi-key setups, ask for an explicit
  `name` (and possibly `out_dir`) so the operator's storage layout
  stays coherent.
- **Don't** treat a fingerprint as a public-key-equivalent. The
  fingerprint is a 16-char excerpt of sha256(DER pubkey); it
  identifies a key, but verifying a signature needs the full public
  key. Use `signalman-verify-release` for verification.

## Follow-up suggestions

After `signalman_key_generate`:
- Tell the operator to back up the private key path verbatim. Loss
  of the private key means no more releases signed by this key.
- Suggest `signalman_release_build --sign --key <private-key-path>`
  for the next build (CLI), or build via MCP and confirm signing is
  on (MCP `signalman_release_build` signs by default when a key is
  configured).

After `signalman_key_fingerprint`:
- If the user is comparing against a release's `signed_by`, point at
  `signalman_release_show <id>` to read the stored value and confirm
  they match before trusting the release.
