---
name: signalman-mint-api-key
description: Mint, list, or revoke a Signalman bearer-token API key. Trigger when the user says "mint an api key", "create a token for the runner", "give CI an api key", "list active api keys", "revoke key <id>", "rotate the runner credential", or any "bearer token" / "api key" intent against the control plane.
allowed-tools: mcp__signalman__signalman_api_key_create, mcp__signalman__signalman_api_key_list, mcp__signalman__signalman_api_key_revoke
---

# Manage Signalman API keys

Three MCP tools cover bearer-token lifecycle for the active org:

- `signalman_api_key_create` — mints a fresh `sk_…_…` token. The
  secret half is returned ONCE — never recoverable later.
- `signalman_api_key_list` — returns active (non-revoked) keys with
  metadata only (id, name, prefix, expiry). The secret is never
  returned.
- `signalman_api_key_revoke` — soft-deletes by id. The key
  immediately stops authenticating; audit-log entries referencing
  it remain.

## What you need from the user

For `signalman_api_key_create`:

- **`name`** — friendly identifier (e.g., `builder-1`, `ci-pipeline`,
  `october-rotation`). Used by `list` and shown in audit entries.
- (Optional) **`expires_at`** — ISO-8601 expiry. Omit for
  non-expiring keys. Recommend setting this for keys handed to
  short-lived consumers (CI runners that rotate, etc.).

For `signalman_api_key_list` — nothing required.

For `signalman_api_key_revoke`:

- **`id`** — the key ULID (from `signalman_api_key_list`). The
  prefix (`sk_…`) alone is not enough; the full id is required.

## How to invoke

```jsonc
// signalman_api_key_create
{
  "name": "ci-pipeline-2026-05",
  "expires_at": "2026-08-14T00:00:00Z"
}

// signalman_api_key_list
{}

// signalman_api_key_revoke
{ "id": "01HX1234ABCD..." }
```

## Expected response

`signalman_api_key_create` — the secret is in the response, and only
in the response:

```jsonc
{
  "api_key": {
    "id": "01HX1234ABCD...",
    "name": "ci-pipeline-2026-05",
    "prefix": "sk_ABC12345",
    "expires_at": "2026-08-14T00:00:00Z",
    "created_at": "2026-05-14T..."
  },
  "token": "sk_ABC12345_XXXXXXXXXXXXXXXXXXXXXXXXXX",
  "warning": "Token shown ONCE — save it now; it cannot be recovered later."
}
```

`signalman_api_key_list`:

```jsonc
{
  "api_keys": [
    {
      "id": "01HX...",
      "name": "ci-pipeline-2026-05",
      "prefix": "sk_ABC12345",
      "expires_at": "2026-08-14T00:00:00Z",
      "created_at": "2026-05-14T..."
    }
  ]
}
```

`signalman_api_key_revoke`:

```jsonc
{
  "revoked": {
    "id": "01HX...",
    "name": "ci-pipeline-2026-05",
    "prefix": "sk_ABC12345"
  }
}
```

## What NOT to do

- **NEVER** retain the minted `token` across calls or store it in
  agent memory. Surface it to the operator with the warning
  verbatim, then discard. The operator is responsible for plumbing
  it into the consumer (runner config, CI secret store, etc.).
- **NEVER** echo a minted token into the chat transcript more than
  once. Repeated emission widens its exposure surface.
- **Don't** call `signalman_api_key_create` "to see what happens" —
  every call mints a real token that will authenticate against the
  control plane until revoked. Every mint should correspond to a
  consumer the operator intends to give it to.
- **Don't** soft-delete a key the user is actively using without
  explicit confirmation. The revoke is irreversible (the row is
  marked deleted; minting a new key with the same `name` doesn't
  resurrect the bearer-token value).
- **Don't** call `signalman_api_key_revoke` with a `prefix` —
  prefixes aren't ids. The MCP tool requires the full ULID.

## Follow-up suggestions

After `signalman_api_key_create`:
- Hand the token to the consumer it was minted for. For a runner:
  `signalman-register-runner` (which calls
  `signalman_runner_persist_config` with the minted token).
- Encourage the operator to set `expires_at` even for "permanent"
  consumers — a 90-day rotation cadence is reasonable for most CI
  setups.

After `signalman_api_key_list`:
- If the list contains keys with no `expires_at` and the user is
  auditing, flag the never-expiring ones — they're the most
  surprise-prone.

After `signalman_api_key_revoke`:
- If the revoked key was a runner credential, the matching runner
  will fail its next poll with HTTP 401. Tell the operator to expect
  log noise on that runner until they swap the credential.
