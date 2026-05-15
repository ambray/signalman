---
name: selvedge-secret-remediation
description: Drive a Selvedge secrets finding through a rotation. Verify the finding is real, identify
---

# Secret remediation

When `selvedge.scan_secrets` surfaces a finding, or `selvedge.list_findings` returns a finding
with `scanner = "secrets"`, drive it through rotation. A committed secret is not a triage
problem — it is an incident. Do not dismiss without evidence that the match is not a real
credential.

## Eight-step remediation loop

Run every step in order. Stop and ask the user before every destructive or externally visible
action (revocation, force-push, history rewrite).

### 1. Verify the secret is real

Read the `context.code_region`, the match confidence, and the Tier evidence on the finding
message. The validator has already applied four tiers:

| signal | what it tells you |
|---|---|
| `t1/credential-parameter` / `t1/credential-assignment` | The string is wired into a credential-using API — almost certainly real. |
| `t1/authorization-header` | The string is the value side of an `Authorization: Bearer …` header — real. |
| `t2/credential-file` | The match is in `.env`, `docker-compose.yml`, a Kubernetes secret manifest, etc. — real. |
| `t3/present-in-history` | The secret has existed in prior commits. Real, and exposure has been long-lived. |
| `t3/rotated` | The secret is in git history but not the working tree — a previous rotation, now a cleanup job. |
| `[needs user confirmation]` | Confidence is in `[0.60, 0.85)` — ambiguous. Ask one targeted question. |

If none of the upward tiers fired and the downward heuristics all fired (test path, placeholder
variable, placeholder value), the finding is probably a false positive — proceed to step 8 and
dismiss with a reason.

### 2. Identify consumers

Before rotation, find every place that reads the secret:

- Grep the literal across the whole repo.
- Grep the variable name (from `variable_name` when present) — many secrets flow through an env
  var first and a literal only in dev.
- When the Pro plugin is available, call `selvedge.reachable(...)` on the finding's anchor to
  walk the call graph from the secret's declaration.

Record the consumers as a bullet list — you'll hand the user the rotation plan in step 3.

### 3. Draft the rotation plan

Write a plan that covers:

1. **Issue a replacement secret** at the upstream provider (AWS IAM, Stripe dashboard, GitHub
   settings, etc.).
2. **Update every consumer** to read the new secret. Prefer env var or secret-manager
   indirection over another literal.
3. **Deploy** the consumers.
4. **Revoke** the old secret at the upstream provider.
5. **Purge** the old secret from git history.
6. **Verify** no remaining references.

Show the plan to the user and get explicit confirmation before proceeding.

### 4. Guide upstream revocation

Each provider has its own rotation surface. Common ones:

- **AWS IAM access key**: `aws iam create-access-key` → update consumers → `aws iam
  delete-access-key --access-key-id <old>`. Never run delete until step 6.
- **Stripe secret key**: create a new restricted key in the dashboard; swap; revoke the old one.
- **GitHub PAT / fine-grained token**: create a new one; revoke the old in Settings →
  Developer settings → Personal access tokens.
- **Generic OAuth client secret**: regenerate at the provider; the window between regenerate
  and consumers being updated is the outage window — schedule accordingly.

You DO NOT execute destructive revocation commands without explicit user confirmation.

### 5. Rotate in the codebase

Apply the fix:

1. Remove the literal from source. Replace with an env-var read or a secret-manager call.
2. Update the env file / secrets manager entry with the new value.
3. Run the test suite.

If the user's secret-management strategy is unclear, ASK. Do not invent a new scheme.

### 6. Purge from git history

Only after the new secret is deployed:

- Recommend `git filter-repo` (or `git filter-branch` as a fallback).
- Explain that history-rewriting requires force-push and coordinates with every collaborator.
- Refuse to execute a force-push without explicit user confirmation.
- If history purge is not practical (public repo with many forks), note that revocation at the
  provider is the primary defense; history is a secondary concern.

### 7. Verify no remaining references

Re-run:

```json
{
  "tool": "selvedge.scan_secrets",
  "arguments": { "include_history": true }
}
```

Assert the rule id no longer fires on the same anchor. If it still fires on a new anchor,
that's an incomplete purge — go back to step 5.

### 8. Record the outcome via selvedge.triage

Every finding ends with an explicit triage state:

- `fixed` — the secret has been rotated and purged. `reason` should name the upstream
  revocation action taken.
- `dismissed` — the match was a false positive. `reason` should cite the evidence (e.g., "test
  fixture value; matches our dummy key pattern; not a live credential").
- `needs-review` — you could not determine whether it's live. `reason` should describe what you
  checked.

Do NOT leave a finding in `open`. A lingering open secret finding is indistinguishable from a
fresh one on the next scan.

## Tool-call shape

```json
{
  "tool": "selvedge.triage",
  "arguments": {
    "finding_id": "01J9XKZW...",
    "state": "fixed",
    "reason": "Rotated AWS access key AKIA... (revoked via aws iam delete-access-key); new key in env/AWS_ACCESS_KEY_ID; git history purged via git filter-repo.",
    "actor": { "kind": "agent", "id": "claude-code" }
  }
}
```

## Invariants

- Never delete the old secret before the new one is deployed. That is the outage vector.
- Never force-push without explicit user consent — it rewrites every collaborator's history.
- Never skip step 1 (verification). Triaging a finding as `fixed` on a false positive muddles
  the audit trail.
- The reason field on `triage` is the rotation's audit trail. Keep it specific: which key, what
  action, which tool was used.
- Treat any finding with `t1/` or `t3/present-in-history` tier evidence as live until proven
  otherwise. The burden of proof is on "this isn't real".

## Companion tools

- `selvedge.scan_secrets` with `include_history: true` — run at the end of remediation to
  confirm cleanup.
- `selvedge.list_findings` filtered to `scanner=secrets` — browse the outstanding secrets
  backlog.
- `selvedge.triage` — record the decision. Required step; nothing closes the loop without it.

