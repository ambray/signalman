# mTLS for the Signalman Guest Agent

This document describes the TLS / mTLS posture of the Signalman guest
agent, how to enable it on the agent (Rust) and the host MCP server
(TypeScript), and how it composes with the bearer-token authentication
that has been in place since v0.0.x.

## Status

- v0.1.0: opt-in mTLS for the guest agent. Bearer token remains the
  default; mTLS layers on top.
- v0.2.0+: ECDSA P-256 standardized; cert-renewal CLI; secret primitive
  for distributing client identities.
- v0.3.0+: host control-plane service certs (TCP mTLS listener for
  remote MCP / HTTP control-plane traffic) with in-place rotation via
  `signalman-service rotate-certs`. Per-org cloud credentials encrypted
  at rest with AES-256-GCM (see [Per-org credential storage](#per-org-credential-storage)).
- v0.4.0+: webhook outbound HMAC-SHA256 signing for `generic` subscribers
  (orthogonal to TLS — covers payload integrity even when the receiver
  terminates TLS at a load balancer).

## Trust model

There are three runtime modes for the guest agent's listener.

| Mode               | `--tls-cert` | `--tls-key` | `--tls-ca` | Wire | Client auth |
| ------------------ | ------------ | ----------- | ---------- | ---- | ----------- |
| Plaintext          | (none)       | (none)      | (none)     | bearer-token | bearer-token |
| Server-auth-only   | required     | required    | (omit)     | TLS  | bearer-token |
| Mutual TLS         | required     | required    | required   | TLS  | client cert + bearer-token |

Partial flag combinations (any one of cert/key without the other, or
`--tls-ca` without identity) are rejected at startup so the operator
sees the failure immediately rather than during the TLS handshake.

When TLS is enabled, the bearer-token interceptor still runs unless
`--allow-insecure` is set. This is intentional defense in depth: a stolen
client certificate must still be paired with the bearer token, and a
leaked bearer token must still be presented over a connection that
terminates inside the agent's TLS configuration.

### When to use which mode

- **Plaintext + bearer**: ephemeral local-development testing on
  loopback. The agent emits a startup warning recommending TLS.
- **Server-auth-only**: useful when the host operator manages client
  identity at the application layer (e.g., a stable bearer token rotated
  out-of-band) but still wants the wire encrypted. Easy upgrade from the
  legacy plaintext mode without provisioning client certs.
- **Mutual TLS**: the production posture. The agent terminates only
  connections that present a certificate signed by the supplied CA,
  cutting off entire classes of unauthenticated probing.

## Quick setup

### 1. Generate dev certificates

A helper script lives at `scripts/generate-dev-certs.sh` (and a
PowerShell twin at `scripts/generate-dev-certs.ps1`). It defaults to
ECDSA P-256 (preferred for v0.2.0+) with an `--rsa` fallback, and emits
six files into `./certs/dev/`:

```
ca.pem      ca.key       Self-signed dev CA
server.pem  server.key   Server identity (use on the guest)
client.pem  client.key   Client identity (use on the host)
```

Default SubjectAltNames cover `localhost`, `127.0.0.1`, `::1`, and the
static `172.30.0.10` Hyper-V test target documented in the roadmap.
Add more with `--san <DNS-or-IP>` (repeatable):

```bash
./scripts/generate-dev-certs.sh --san vm.test.lan --san 10.0.0.5
```

These certs are NOT for production. The CA private key is written
plaintext beside the certificate so contributors can extend the test
matrix without ceremony — anyone with read access to `certs/dev/` can
mint trusted client certificates.

### 2. Run the guest agent with mTLS

```powershell
signalman-guest `
  --bind 0.0.0.0:50051 `
  --token "$env:SIGNALMAN_AUTH_TOKEN" `
  --tls-cert C:\signalman\certs\server.pem `
  --tls-key  C:\signalman\certs\server.key `
  --tls-ca   C:\signalman\certs\ca.pem
```

All four `--tls-*` flags also accept environment variables
(`SIGNALMAN_TLS_CERT`, `SIGNALMAN_TLS_KEY`, `SIGNALMAN_TLS_CA`); these
are convenient when wrapping the agent in a Windows service.

To run server-auth-only (encrypt the wire but don't validate client
certs), omit `--tls-ca`.

### 3. Configure the host

The host reads TLS material from `signalman.yaml` under
`guestAgent.tls`. All three paths are optional. When `caPath` is set
without a client identity, the host runs server-auth-only TLS; supply
`certPath` and `keyPath` together for mTLS.

```yaml
guestAgent:
  defaultPort: 50051
  tls:
    enabled: true
    caPath: ./certs/dev/ca.pem
    certPath: ./certs/dev/client.pem
    keyPath: ./certs/dev/client.key
```

Equivalent environment overrides: `SIGNALMAN_GUEST_TLS=true`,
`SIGNALMAN_GUEST_CA`, `SIGNALMAN_GUEST_CERT`, `SIGNALMAN_GUEST_KEY`.

The `GuestAgentClient` constructor also honours an `https://` scheme on
the endpoint URL: passing `"https://172.30.0.10:50051"` forces TLS even
when no `caPath` is configured. This is the recommended convention for
ad-hoc scenarios that target an externally-managed CA.

## Migration

Existing bearer-token-only deployments require no changes:

- The guest agent treats all three `--tls-*` flags as optional and
  continues to start in plaintext mode when none are supplied.
- `signalman.yaml` retains backwards-compatible defaults — the `tls`
  block is opt-in.
- The host's `GuestAgentClient` falls back to insecure credentials when
  no TLS material is supplied and the endpoint URL has no `https://`
  scheme.

When you are ready to enable TLS, the recommended migration path is:

1. Generate certs (`scripts/generate-dev-certs.sh`).
2. Distribute `server.pem`/`server.key`/`ca.pem` to each VM (e.g., via
   `vm_copy_file` in your scenario setup) and start the agent with
   `--tls-cert` + `--tls-key`. Leave `--tls-ca` unset for one rollout
   cycle so existing host clients keep working in server-auth-only mode.
3. Once every host has a client cert, add `--tls-ca` on the agents and
   `certPath`/`keyPath` in `signalman.yaml` on the hosts to switch to
   full mTLS.
4. Delete the bearer token from `signalman.yaml` only if you have
   audited the entire fleet and decided that the client-cert layer is
   sufficient on its own — the recommended posture is to keep both.

For the host control-plane service cert bundle, rotate in place with
`signalman-service rotate-certs --cert-dir <dir>` (or omit `--cert-dir`
for `%ProgramData%\Signalman\certs`). The command preserves the prior
complete bundle under `.rotation-backups/<unix-ms>/`; restart the service
afterward so the TCP mTLS listener reloads the new files.

## Troubleshooting

- `Invalid TLS configuration: --tls-cert and --tls-key must be specified together`
  — supplied one of `--tls-cert` / `--tls-key` without the other.
- `Invalid TLS configuration: --tls-ca requires --tls-cert and --tls-key`
  — supplied a CA file but no server identity. The agent has nothing to
  present, so it refuses to start.
- Client connection hangs at handshake — the most common cause is the
  client trusting a different CA than the one the server used to sign
  its identity. Re-run `openssl verify -CAfile ca.pem server.pem` to
  confirm the chain.
- `RST_STREAM with code UNAVAILABLE` from the host — the agent rejected
  the TLS handshake (typically due to a missing client cert). Check the
  agent logs; rejected handshakes are logged at INFO.

## Host control-plane service certs

The host control plane terminates TCP MCP / HTTP traffic on its own
TLS listener — separate from the guest-agent surface above. The default
bundle path is `%ProgramData%\Signalman\certs` on Windows and
`/etc/signalman/certs` on Linux/macOS, holding:

```
ca.pem   ca.key       Self-signed CA pinned by the host's bearer-token cert-pin registry
server.pem server.key Service identity presented to remote MCP / HTTP clients
client.pem client.key Client identity the host uses to dial guest agents (re-used from §1 above)
```

The bundle layout is intentionally identical to the dev-cert script's
output so operators can promote a vetted dev bundle to production by
copying the files into place.

### Rotation

```powershell
# Rotate in-place (writes new files alongside; backs up prior bundle).
signalman-service rotate-certs

# Rotate at an explicit cert directory.
signalman-service rotate-certs --cert-dir 'C:\Signalman\certs'
```

The command preserves the prior complete bundle under
`.rotation-backups/<unix-ms>/`. Restart the service afterward so the
TCP listener reloads the new files; the existing process keeps serving
the old bundle until restart, so rotation is zero-downtime when paired
with a graceful service restart.

A rotation audit row (`service.cert_rotated`) is appended to the
control-plane audit log on success so operators can prove rotation
happened — see [supply-chain.md](supply-chain.md#immutable-audit-log).

## Per-org credential storage

Cloud target kinds (`cloud_vm_*`, `cloud_stack_*`) need credentials —
AWS access keys, Azure service principals, GCP service-account JSON,
etc. — that the host has to be able to decrypt on demand to provision
infrastructure. Storing them plaintext on disk would defeat the
audit-log story.

Signalman encrypts credentials at rest with AES-256-GCM:

- **Key source.** The data-encryption key comes from the
  `SIGNALMAN_CRED_KEY` env var on the host. It must be 32 bytes
  base64-encoded. The host refuses to set or read credentials when
  the var is missing or malformed.
- **Per-row nonce.** Each row uses a fresh 12-byte random IV; the
  16-byte GCM auth tag is appended to the ciphertext. Stored layout
  in `cloud_org_credential.ciphertext_b64`:
  `base64(<iv 12B> || <ciphertext> || <auth_tag 16B>)`.
- **Plaintext shape.** A JSON document specific to the backend kind,
  e.g. `{"access_key_id": "...", "secret_access_key": "..."}` for AWS.
  The shape is documented in `0041_cloud_credentials.sql`.
- **Redacted hint.** Every row also stores a non-secret
  `redacted_hint` like `"AKIA****EXAMPLE"` that surfaces via CLI / MCP
  `cloud-creds get` so operators can confirm they have the right key
  without ever seeing the secret again.
- **Decryption locality.** Decryption only happens at the call site
  via `loadCredentialForOrg(orgId, backend)` — typically inside a
  cloud-provider client wrapper that immediately uses the credential
  to sign a request. Plaintext is never logged, never written to
  disk, and never crosses an MCP boundary.

### Setting credentials

```bash
# AWS — env-var key, then upsert via CLI.
export SIGNALMAN_CRED_KEY="$(openssl rand -base64 32)"

signalman cloud-creds set \
  --org-id 01HEXAMPLE... \
  --backend aws \
  --json '{"access_key_id":"AKIA...","secret_access_key":"..."}'

# Verify the redacted hint.
signalman cloud-creds get --org-id 01HEXAMPLE... --backend aws
# → backend: aws
# → redacted_hint: AKIA****EXAMPLE
# → encryption_method: aes-gcm-env
```

Both the set + remove operations append rows to the audit log
(`cloud_creds.set`, `cloud_creds.removed`) so the trail of "who
configured what credential when" is preserved even after the row
is overwritten by rotation.

### Key rotation roadmap

v0.3.0 ships env-var-key encryption only (`encryption_method =
'aes-gcm-env'`). KMS-derived keys (`aws-kms`, `azure-key-vault`,
`age-encrypted-file`) land in v0.3.x with the same table layout —
only `encryption_method` gains new values and `loadCredentialForOrg`
dispatches on it. See `docs/design/meta-build-system.md §13.7` for
the design.

## Registry TLS

`@signalman/registry` (the standalone OSS sibling) terminates its
HTTP surface in plaintext by default for local-development ease.
For production it should be fronted by a reverse proxy (nginx,
Caddy, Envoy) that terminates TLS, with the registry bound to
localhost or a private network only. The bearer-token + HMAC
signature on uploads remains the integrity layer regardless of
where TLS terminates. Native TLS termination inside the registry
process is on the roadmap once the cargo + npm protocol facades
stabilize.
