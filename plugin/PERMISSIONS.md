# Signalman permission preset (advisory)

This document defines the recommended Claude Code permissions preset
for the signalman MCP server. **Apply it by copy-pasting the JSON
block below into your `settings.json`** (see `TESTING.md` §"Manual
verification path B" for which settings file to use).

## Why a separate document, not the manifest

The Claude Code plugin manifest does not carry a `permissions` block.
Plugin-scoped `settings.json` only accepts the `agent` and
`subagentStatusLine` keys per the plugin reference fetched 2026-05-17.
So the preset ships as documentation users opt into, not as a hard
plugin enforcement.

The recommended preset reflects the WS7 detail design
(`docs/design/v0.5-claude-plugin.md` §Stories §Story 4), which traces
to the original `plugin/ROADMAP.md` permission tiers.

## The preset (copy into settings.json)

The `mcp__signalman__<tool>` pattern matches MCP tool calls against
the signalman MCP server registered in `.claude-plugin/plugin.json`.

```json
{
  "permissions": {
    "allow": [
      "mcp__signalman__signalman_list",
      "mcp__signalman__signalman_describe",
      "mcp__signalman__signalman_status",
      "mcp__signalman__signalman_release_list",
      "mcp__signalman__signalman_release_show",
      "mcp__signalman__signalman_target_list",
      "mcp__signalman__signalman_runner_list",
      "mcp__signalman__signalman_product_list",
      "mcp__signalman__signalman_promotion_list",
      "mcp__signalman__signalman_promotion_approvals",
      "mcp__signalman__signalman_schedule_list",
      "mcp__signalman__signalman_webhook_list",
      "mcp__signalman__signalman_api_key_list",
      "mcp__signalman__signalman_signing_keys_list",
      "mcp__signalman__signalman_cloud_list",
      "mcp__signalman__signalman_cloud_status",
      "mcp__signalman__signalman_cloud_backends",
      "mcp__signalman__signalman_budget_get",
      "mcp__signalman__signalman_budget_usage",
      "mcp__signalman__signalman_creds_get",
      "mcp__signalman__signalman_audit_query",
      "mcp__signalman__signalman_health_check",
      "mcp__signalman__signalman_health_history",
      "mcp__signalman__signalman_key_fingerprint",
      "mcp__signalman__signalman_reaper_status",
      "mcp__signalman__signalman_signing_verify",
      "mcp__signalman__signalman_release_verify"
    ],
    "ask": [
      "mcp__signalman__signalman_plan",
      "mcp__signalman__signalman_run",
      "mcp__signalman__signalman_release_build",
      "mcp__signalman__signalman_release_build_remote",
      "mcp__signalman__signalman_release_deploy",
      "mcp__signalman__signalman_release_rollback",
      "mcp__signalman__signalman_promotion_add",
      "mcp__signalman__signalman_promotion_approve",
      "mcp__signalman__signalman_promotion_reject",
      "mcp__signalman__signalman_promotion_tick",
      "mcp__signalman__signalman_target_add",
      "mcp__signalman__signalman_target_edit",
      "mcp__signalman__signalman_product_add",
      "mcp__signalman__signalman_runner_deploy",
      "mcp__signalman__signalman_runner_build_config",
      "mcp__signalman__signalman_runner_persist_config",
      "mcp__signalman__signalman_creds_set",
      "mcp__signalman__signalman_cloud_provision",
      "mcp__signalman__signalman_stack_apply",
      "mcp__signalman__signalman_stack_plan_cost",
      "mcp__signalman__signalman_budget_set",
      "mcp__signalman__signalman_webhook_add",
      "mcp__signalman__signalman_webhook_test",
      "mcp__signalman__signalman_schedule_add",
      "mcp__signalman__signalman_schedule_enable",
      "mcp__signalman__signalman_schedule_disable",
      "mcp__signalman__signalman_schedule_run_once",
      "mcp__signalman__signalman_api_key_create",
      "mcp__signalman__signalman_reaper_run_once",
      "mcp__signalman__signalman_audit_append",
      "mcp__signalman__signalman_record",
      "mcp__signalman__signalman_record_finalize"
    ],
    "deny": [
      "mcp__signalman__signalman_key_generate",
      "mcp__signalman__signalman_signing_keys_rotate",
      "mcp__signalman__signalman_signing_keys_revoke",
      "mcp__signalman__signalman_signing_keys_add",
      "mcp__signalman__signalman_creds_remove",
      "mcp__signalman__signalman_api_key_revoke",
      "mcp__signalman__signalman_promotion_remove",
      "mcp__signalman__signalman_product_remove",
      "mcp__signalman__signalman_target_remove",
      "mcp__signalman__signalman_webhook_remove",
      "mcp__signalman__signalman_schedule_remove",
      "mcp__signalman__signalman_runner_deregister",
      "mcp__signalman__signalman_cloud_terminate",
      "mcp__signalman__signalman_stack_destroy"
    ]
  }
}
```

## Category rationale

### allow — read-only, idempotent, safe-to-auto

Everything in `allow` is either a pure read (no state mutation) or a
verification step (`signalman_signing_verify`, `signalman_release_verify`,
`signalman_health_check`) that runs against existing artefacts without
producing new ones. Tools like `signalman_audit_query` and
`signalman_health_history` are explicitly forensic / investigation
verbs called out in the design doc.

`signalman_creds_get` lands in `allow` despite touching credentials —
it is a getter, not a setter, and is needed for Claude to surface
cloud-configuration state in `/signalman-status`. Sensitive values
themselves are returned redacted by the host (see
`host/src/verbs/cloud.ts` `redactCloudCredentialFields`).

### ask — state-changing but recoverable

Everything in `ask` mutates state but can be undone with another verb
(e.g. `signalman_release_deploy` is recoverable via
`signalman_release_rollback`; `signalman_promotion_approve` is
recoverable via `signalman_promotion_reject`). Builds, deploys,
config edits, and credential **sets** sit here. The operator's
attention is requested per-invocation.

### deny — destructive, irreversible, or root-of-trust

Three categories live in `deny`:

1. **Cryptographic root-of-trust ops.** Key generation, rotation, and
   revocation (`signalman_key_generate`,
   `signalman_signing_keys_rotate`, `signalman_signing_keys_revoke`,
   `signalman_signing_keys_add`). These should run from an operator's
   own shell with explicit intent — never from a conversational
   interface that could be prompt-injected.
2. **Tombstoning / deregistration verbs.** `*_remove`, `*_deregister`,
   `signalman_creds_remove`. Soft-deletes are recoverable with effort
   but the convention is for the operator to do them.
3. **Resource teardown verbs.** `signalman_cloud_terminate`,
   `signalman_stack_destroy`. These delete infrastructure and incur
   no-easy-undo costs.

The user can override any `deny` entry by editing their own
`settings.json` — the preset is a default, not a managed policy. For
managed-deny enforcement (organisations), see Claude Code's
`allowManagedPermissionRulesOnly` setting.

## Drift detection

The manifest-validation test (`plugin/__tests__/manifest-validation.test.ts`)
parses this file at test time and asserts every `allow`/`ask`/`deny`
entry references a real MCP tool name registered in
`host/src/server.ts`. A host-side tool rename without a matching
preset update will fail the test before it reaches users.

## Future work (v0.2.0)

- PreToolUse hook that adds rich preview before `signalman_release_rollback`
  ("rollback affects N active deployments on target_xyz; last green
  deploy was rel_abc 2h ago — proceed?"). Per the v0.2.0 ROADMAP.
- A `claude plugin install signalman --apply-permissions` flag once
  the Claude Code CLI grows it (not currently in spec).
