---
name: selvedge-secret-remediation
description: Drive a Selvedge secrets finding through rotation. Verify → identify consumers → plan → revoke (with user confirmation) → rotate in code → purge history → verify → triage. Never force-push or revoke without explicit user consent.
allowed-tools: [selvedge.scan_secrets, selvedge.list_findings, selvedge.triage, Read, Grep, Glob, Edit, Bash]
---

# Secret remediation

A committed secret is an incident, not a triage problem. Do not dismiss without evidence the
match is not a live credential.

## Eight-step loop

1. **Verify.** Read the finding's message for Tier evidence tags. Strong real-secret signals:
   `t1/credential-parameter`, `t1/credential-assignment`, `t1/authorization-header`,
   `t2/credential-file`, `t3/present-in-history`. Signals pointing toward false positive: all
   three downward heuristics (`test-like path`, `placeholder variable name`, `placeholder value`)
   firing without any upward tier.
2. **Identify consumers.** `Grep` the literal and the variable name across the repo. With Pro,
   call `selvedge.reachable()` for a call-graph trace.
3. **Plan.** Write the plan: (a) issue replacement upstream, (b) update every consumer, (c)
   deploy, (d) revoke old, (e) purge from history, (f) verify. Show to user; wait for
   confirmation.
4. **Guide revocation.** Provider-specific. Common paths:
   - AWS IAM: `aws iam create-access-key` → swap consumers → `aws iam delete-access-key`.
   - Stripe: new restricted key in dashboard → swap → revoke old.
   - GitHub PAT: new token → swap → revoke old.
   Do NOT run destructive revocation commands without explicit user confirmation.
5. **Rotate in code.** Replace the literal with an env-var or secret-manager read. Update the
   env file / secrets manager. Run tests.
6. **Purge from history.** Recommend `git filter-repo`. Explain the force-push implication.
   Refuse to force-push without explicit consent.
7. **Verify.** `selvedge.scan_secrets` with `include_history: true`; assert the rule id no
   longer fires on the same anchor.
8. **Triage.** Record the outcome via `selvedge.triage` — `fixed` / `dismissed` /
   `needs-review`, never left `open`. The `reason` field is the audit trail: name the upstream
   action taken.

## Triage call

```json
{
  "tool": "selvedge.triage",
  "arguments": {
    "finding_id": "01J9XKZW...",
    "state": "fixed",
    "reason": "Rotated AWS access key AKIA… (aws iam delete-access-key); new key in env/AWS_ACCESS_KEY_ID; git history purged via git filter-repo.",
    "actor": { "kind": "agent", "id": "claude-code" }
  }
}
```

## Invariants

- Never delete the old secret before the new one is deployed.
- Never force-push without explicit user consent.
- Never skip verification (step 1) — "t1/" + "t3/present-in-history" mean live until proven otherwise.
- `needs user confirmation` flag in the finding message → ask one targeted question.
- Record the triage. An `open` secret finding looks identical to a new one on the next scan.

## Companion tools

- `selvedge.scan_secrets` with `include_history: true` — final verification after rotation.
- `selvedge.list_findings` filtered by `scanner=secrets` — backlog.
- `selvedge.triage` — required; no remediation closes without it.
