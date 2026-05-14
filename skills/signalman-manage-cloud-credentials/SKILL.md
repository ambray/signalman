---
name: signalman-manage-cloud-credentials
description: Set, view, or remove per-org cloud credentials stored encrypted at rest. Trigger when the user says "store AWS credentials for org X", "rotate the Azure service principal", "show me what credentials are configured", "remove the creds for the test org". The plaintext is encrypted with AES-256-GCM via `SIGNALMAN_CRED_KEY`; reads return ONLY a redacted hint (`AKIA****EXAMPLE`), never the secret. Provision automatically uses per-org credentials when `org_id` is passed.
allowed-tools: mcp__signalman__signalman_creds_set, mcp__signalman__signalman_creds_get, mcp__signalman__signalman_creds_remove, Bash
---

# Manage per-org cloud credentials at rest

This skill drives v0.3.0-5 sub-task 6 commit 2 + sub-task 8 commit 2.
Per-org credentials get encrypted with AES-256-GCM and stored in the
control plane DB; the AWS / Azure backend constructor uses them
automatically when provision is called with `org_id`.

## Prerequisites — the operator must set up the encryption key

Before any `set`, `get`, or `remove`, **`SIGNALMAN_CRED_KEY` must be
set in the environment**. It's a base64-encoded 32-byte AES-256-GCM
key. Generate one with:

```bash
openssl rand 32 | base64
# or
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Then export it before invoking any signalman cloud creds command:

```bash
export SIGNALMAN_CRED_KEY="<the base64 string>"
```

If `SIGNALMAN_CRED_KEY` is missing or malformed, every credential
operation **fails loudly** with `invalid_config` — no silent fallback
to plaintext storage.

**The operator owns the key.** Losing it means losing access to all
stored credentials. Store it in a secrets manager (1Password, AWS
Secrets Manager, etc) at the same trust level as the credentials
themselves.

## What you need from the user

For `set`:
- **`org_id`** — owning org
- **`backend`** — `aws` or `azure`
- **AWS plaintext**: `access_key_id` + `secret_access_key` (+ optional
  `session_token` for temporary credentials)
- **Azure plaintext**: `tenant_id` + `client_id` + `client_secret`

For `get` / `remove`:
- `org_id` + `backend`

## How to invoke

**Set AWS credentials (MCP)**:

```jsonc
{
  "org_id": "acme",
  "backend": "aws",
  "aws": {
    "access_key_id": "AKIAIOSFODNN7EXAMPLE",
    "secret_access_key": "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"
  }
}
```

**Set AWS credentials (CLI)**:

```bash
signalman cloud creds set --org acme --backend aws \
  --access-key-id AKIAIOSFODNN7EXAMPLE \
  --secret-access-key wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY \
  [--session-token TEMP_TOKEN] \
  [--format json]
```

**Set Azure service principal**:

```bash
signalman cloud creds set --org acme --backend azure \
  --tenant-id 11111111-2222-3333-4444-555555555555 \
  --client-id aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee \
  --client-secret super-secret-value
```

**Get redacted metadata**:

```jsonc
// signalman_creds_get { "org_id": "acme", "backend": "aws" }
```

```bash
signalman cloud creds get --org acme --backend aws
```

**Remove**:

```bash
signalman cloud creds remove --org acme --backend aws
```

## Expected response

`set` (MCP + CLI both):

```jsonc
{ "ok": true, "value": { "redactedHint": "AKIA****MPLE" } }
```

The plaintext is **never** echoed back. Only the redaction hint is
returned for operator confirmation.

`get` returns:

```jsonc
{
  "ok": true,
  "value": {
    "id": "...",
    "orgId": "acme",
    "backend": "aws",
    "redactedHint": "AKIA****MPLE",
    "encryptionMethod": "aes-gcm-env",
    "createdAt": "...",
    "updatedAt": "..."
  }
}
```

Or `null` when no credential is configured — provision falls back
to the AWS / Azure SDK default credential chain (env vars, IMDS,
shared config file, etc).

## How auto-injection works on provision

When `signalman_cloud_provision` is called with `org_id` set AND a
credential row exists for (`org_id`, `provider`):

1. The MCP handler decrypts the stored ciphertext with `SIGNALMAN_CRED_KEY`
2. Constructs a fresh `AwsBackend` / `AzureBackend` with those
   credentials as the SDK auth (NOT cached in the registry)
3. Calls `provisionInstance` with the operator-supplied config

When `org_id` is absent (or `"default"`), or no credential row exists:

- Falls back to the registry's default backend — env-var credentials
  + SDK default chain. **Back-compat preserved**.

If a credential row exists but decryption fails (key mismatch,
corrupt ciphertext): **propagates `invalid_config` error**, does
NOT fall back silently to default chain (that would be a
privilege-escalation surprise).

## Error codes

| `code` | Meaning | Operator fix |
|---|---|---|
| `invalid_config` | Missing/malformed `SIGNALMAN_CRED_KEY` env var, OR stored row uses unsupported `encryption_method`, OR decryption failed | Set the env var; if "failed to decrypt" rerun with the original key |

## What NOT to do

- **Never** paste plaintext credentials into chat logs / commit
  messages / Slack screenshots. The redacted hint is for confirming
  identity; the secret stays encrypted at rest
- **Never** disable the `SIGNALMAN_CRED_KEY` check to "make it work
  in dev". Use a dev-only key (`openssl rand`) instead — never
  plaintext storage
- **Never** rotate the encryption key without re-encrypting all
  stored rows (a v0.3.x followup adds `signalman cloud creds
  rotate-key`; until then, plan ahead: delete + re-set under the
  new key, OR keep the old key archived for read access)
- **Never** assume `get` returns the secret. The MCP / CLI surface
  is intentionally redacted. To USE the credential, drive
  provision with `org_id`; the loader handles decryption
  internally

## Follow-up suggestions

- After `set`, run `signalman_cloud_provision { org_id: "acme", ... }`
  to confirm the credentials work end-to-end
- For multiple AWS profiles per org (e.g. dev / staging / prod), a
  per-target override is a v0.3.x followup. Today's model is one
  credential per (org, backend); operators that need profile-style
  overrides use `AWS_PROFILE` env var per-runtime
- For Azure, the credential identifies the *caller* (service
  principal); the resource scope (subscription / resource group /
  region) still comes from env vars (`AZURE_SUBSCRIPTION_ID` etc).
  Per-org scoping rows are a v0.3.x followup
