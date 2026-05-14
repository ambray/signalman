---
name: signalman-add-webhook
description: Register an outbound webhook subscription for Signalman events (release built, deployed, rolled back, health failed, promotion approved/rejected). Supports generic (signed JSON POST), Slack (incoming webhook), and email (mailto:) drivers. Trigger when the user says "notify me on X", "send a webhook when Y happens", "wire Signalman into Slack", "send release events to my server", or asks to test an existing webhook.
allowed-tools: Bash
---

# Register an outbound webhook

## What you need from the user

- **Driver kind** — `generic`, `slack`, or `email`.
- **URL** — generic / slack expects `https://...`; email expects `mailto:user@host` (or just a bare `user@host`).
- **Optional HMAC secret** — only meaningful for `kind=generic`. The dispatcher signs the body with HMAC-SHA256 and sends `X-Signalman-Signature: sha256=<hex>`.
- **Optional event-kinds filter** — comma-separated, e.g. `release-built,deployment-rolled-back`. Empty = all events (the dispatcher delivers everything until the operator narrows).

## How to invoke

```bash
signalman webhook add --kind <generic|slack|email> --url <URL> \
  [--secret <hmac-key>] \
  [--events release-built,health-failed] \
  [--description "purpose"] \
  --format json
```

List existing subscriptions:

```bash
signalman webhook list [--format json]
```

Soft-delete:

```bash
signalman webhook remove <ID>
```

Verify a subscription before relying on it (sends a synthetic `release-built` event):

```bash
signalman webhook test <ID>
```

## Expected behaviour

| Kind | Body | Signing | Notes |
|------|------|---------|-------|
| generic | `JSON.stringify(SignalmanEvent)` | `X-Signalman-Signature: sha256=<hex>` when `--secret` was supplied | 2xx = delivered. |
| slack | Slack Block-Kit payload | Slack auths via the URL itself; no HMAC. | Header / section / context blocks per event kind. |
| email | Pretty-printed JSON event in the message body | n/a | Requires `SIGNALMAN_SMTP_URL` env var; absent = silent skip. |

The dispatcher walks active subscriptions on every fired event (release-built, release-deployed, deployment-rolled-back, health-failed, promotion-approved/rejected). Delivery failures NEVER block the upstream pipeline — they log to stderr and append a `webhook.failed` audit row so the operator can investigate later.

## Exit codes

| Exit | Meaning | What to say |
|------|---------|--------------|
| 0 | Command succeeded (and for `webhook test`, the test event was delivered). | Surface the result JSON. |
| 4 | Validation error (bad URL), DB error, or test delivery failed. | Show the stderr error; do NOT auto-retry. |

## What NOT to do

- Don't paste the HMAC secret into chat — keep it in the operator's terminal. Echo only that the webhook was registered with `signed: yes`.
- Don't subscribe to events the user didn't ask for. If they say "Slack me on failed deploys", set `--events deployment-rolled-back,health-failed`.
- Don't add the same Slack URL twice — `signalman webhook list` first.
- Don't gate the user's "test the webhook" request behind a daemon. `webhook test` runs synchronously.

## Follow-up suggestions

- After `webhook add`: run `signalman webhook test <id>` to verify delivery.
- For HMAC verification on the receiver: compute `HMAC-SHA256(secret, raw_body)` and compare against the `sha256=` value in `X-Signalman-Signature`. Use a constant-time compare.
- Pair with Epic 3 schedules: a `webhook add --kind slack --events health-failed` plus a `signalman schedule add` gives the operator a hands-off "ping me when the canary degrades" loop.
