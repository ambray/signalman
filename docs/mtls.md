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
