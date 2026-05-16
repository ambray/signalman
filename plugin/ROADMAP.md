# Signalman Claude Code plugin — roadmap

**Status:** scoping (2026-05-15). No code shipped yet.
**Owner:** WS7 (`docs/workstreams/prompts/ws7-claude-plugin.md`).
**Tracks in parallel with:** the next-10 epics work (signing-service, OSS-hygiene trio, mac UI automation, etc.). This roadmap is independent of those.

## Vision

A Claude Code plugin that turns the existing 44-skill, 27-CLI-verb,
MCP-exposed signalman surface into a **conversational operator experience**
— with first-class differentiation between local / self-hosted / hosted-cloud
deployments and a clean open-core boundary.

The plugin is the front door for three audiences:

| Audience | Value prop | Discovery channel |
|---|---|---|
| **Bootstrap / evaluator** — dev kicking the tires locally | Zero-to-running-scenario in 5 minutes with Claude doing the typing | Plugin marketplace + README badge |
| **Operator / SRE** — self-hosted signalman in production | Day-2 ops (deploys, promotions, rollbacks, investigations) as conversation | Word of mouth, internal champions |
| **Hosted customer** — paying for signalman-cloud | Same conversation surface, plus org-switching / RBAC-aware writes / cloud-only views | Bundled into onboarding |

All three want the same MCP server. They diverge on *which skills, slash
commands, and subagents* are useful. That divergence is the design tool —
not a feature-flag matrix.

## What a Claude Code plugin packages

Six surfaces, ordered by leverage (high → low):

1. **MCP server registration** — direct verb access. Highest leverage.
   We already have this in `signalman-loom-plugin` (Rust) and the host
   MCP server. The plugin just makes them install in one click.
2. **Skills** — markdown playbooks Claude loads on demand. We already
   have **44**: most of the product value is already authored.
3. **Slash commands** — one-shot operator flows (`/signalman-status`).
   Big "wow" moments per invocation. **None exist yet.**
4. **Subagents** — specialized roles (release reviewer, incident
   responder). **None exist yet.**
5. **Hooks** — guardrails (confirm destructive verbs, auto-log signed
   releases). **None exist yet.**
6. **Settings / permissions preset** — auto-allow read verbs; prompt
   for state-changing ones; deny key/cert operations. **None exist yet.**

The work is largely **(3) + (4) + (5) + (6) plus a plugin manifest that
binds (1) + (2)** — not greenfield.

## Open-core boundary — the load-bearing PM call

**Ship two plugins, not one.**

- **`signalman`** — Apache-2.0, in the OSS repo at `plugin/`. Bundles
  local + self-hosted skills + the host MCP server. Distributed via
  the Claude plugin marketplace alongside the README. Complete and
  polished standalone — OSS users never feel second-class.
- **`signalman-cloud`** — proprietary, in the cloud repo. Peers-with
  `signalman`, adds hosted skills (org switching, RBAC-aware writes,
  audit export, cloud-only views, SSO bootstrap). Same `/signalman-status`
  slash command, just more rows.

Why this matters more than it sounds:

- Single-plugin-with-feature-flags backfires in three ways I've watched
  COSS products hit: (a) makes OSS install feel like a demo with disabled
  buttons, (b) bleeds proprietary contract surface into the OSS repo's
  review burden, (c) muddies the plugin marketplace listing.
- Two plugins keeps each repo's license + review hygiene clean and
  gives the hosted product its own marketing surface to grow.

## v0.1.0 — MVP (target: ~2 weeks)

Hard cut. Resist the urge to ship everything. Goal: **independently
useful for OSS users**, no cloud features required.

### Scope

- **Plugin manifest** (`plugin/plugin.json` or `plugin/manifest.json`,
  whichever Claude Code's marketplace spec settles on by ship date).
- **One MCP server entry** pointing at local signalman MCP
  (`signalman serve`).
- **6 skill registrations** from the existing `skills/` tree, picked for
  the day-1 + most-asked day-2 flows:
  - `signalman-build-from-tag` (day-1 happy path)
  - `signalman-deploy-to-test` + `signalman-rollback` (day-2 essentials)
  - `signalman-promote-release` (the showcase Wave-B feature)
  - `signalman-query-audit-log` (forensic / investigation)
  - `signalman-register-target` (covers vm / docker / k8s / cloud)
- **1 slash command:** `/signalman-status` — synthesizes recent releases,
  pending promotions, failing probes, stale runners into a 10-line answer.
  This is the demo.
- **Permission preset:**
  - **auto-allow:** `list`, `get`, `status`, `audit query`, `forensic`
  - **prompt:** `build`, `deploy`, `promote approve`, `rollback`,
    `cloud-creds set`
  - **deny:** `key generate`, `rotate-certs`, `cloud-creds remove`
    (operator does these manually)

### Out of scope for MVP

- Subagents (defer to v0.2.0)
- Destructive-command hooks (defer to v0.2.0)
- Cloud-aware skill loading (defer to v0.2.0)
- The `signalman-cloud` proprietary plugin (defer to v1.0.0)

### Definition of Done

1. `plugin/` directory with manifest, README, and skill index.
2. Manual install via `claude plugin install <path>` works on Windows + macOS + Linux.
3. `/signalman-status` returns a coherent answer against a freshly-bootstrapped signalman install with at least one product + one release.
4. Permission preset matches the spec above (verified by trying each verb category).
5. README documents install + uninstall + the 6 skills + the slash command.
6. 4-lens audit (QA / Architecture / Product / Security) per the standing workstream rules.

## v0.2.0 — full skill coverage + investigation power (target: ~1–2 months after MVP)

### Scope

- **All 44 existing skills** registered in the plugin index, organized by persona:
  - Day-1 setup (`bootstrap`, `register-product`, `register-target`, `mint-api-key`, ...)
  - Day-2 build + deploy (`build-from-tag`, `deploy-*`, `rollback*`, `verify-release`, ...)
  - Day-2 observability (`query-audit-log`, `health-check`, `health-history`, `inspect-release`, ...)
  - Configuration (`add-webhook`, `schedule-health`, `edit-target`, `register-runner`, ...)
  - Cloud (loaded when cloud creds are configured): `cloud-status`, `provision-cloud-vm`, `apply-cloud-stack`, `manage-cloud-budget`, ...
- **Subagent:** `signalman-incident-responder` — when a probe fails or a
  deploy regresses, walks the audit log → last successful deploy → diff →
  suggested rollback target. This is the "Claude earns its keep" moment.
- **Slash commands** (additions):
  - `/signalman-investigate <release|deployment|target>` — forensic API +
    audit narrative for one entity.
  - `/signalman-cleanup-stale` — finds stale runners, expired cloud VMs,
    soft-deleted-but-not-GC'd artifacts.
- **Destructive-command hooks** with rich preview:
  > "rollback affects 3 active deployments on target_xyz; last green
  > deploy was rel_abc 2h ago — proceed?"
- **Cloud-aware skill loading:** detect `cloud_org_credential` rows;
  auto-enable cloud skills only when configured. Reduces noise for OSS
  users who will never use cloud.

### Definition of Done

1. All 44 skills indexed with descriptions + trigger phrases verified against a real Claude session.
2. Incident-responder subagent passes a tabletop exercise (operator triggers a failing probe, agent produces a coherent rollback recommendation).
3. Three destructive hooks land: rollback, cloud-vm terminate, cloud-creds remove.
4. Cloud-skill auto-detection verified with both "no cloud configured" and "cloud configured" fixtures.
5. 4-lens audit.

## v1.0.0 — open-core split (target: post-v0.2.0)

### Scope

- Promote the OSS plugin from `plugin/` to its own subdirectory with full
  marketplace metadata (icon, screenshots, install URL, version pinning).
- **`signalman-cloud` plugin** in the cloud repo:
  - Hosted-only skills: org-switching, RBAC role grants, audit-log export
    to S3, SSO bootstrap, multi-org promotion approvals.
  - Hosted-only subagent: `signalman-cloud-onboarder` for first-day
    customer setup.
  - Cross-references the OSS plugin via "peer plugin" metadata.
- Plugin marketplace listing for both, with the OSS listing emphasizing
  Apache-2.0 + standalone use, and the cloud listing emphasizing the
  additive surface.
- Optional telemetry (opt-in) feeding signalman-cloud usage analytics.
  Strictly silent in the OSS plugin.

### Definition of Done

1. Both plugins installable via marketplace.
2. Installing both produces a unified experience (same slash commands, more rows in cloud-aware ones).
3. Installing only OSS produces a complete experience with no disabled buttons or "upgrade" prompts.
4. Telemetry shape documented + reviewed; opt-in is opt-in, not dark-patterned.
5. 4-lens audit on both plugins.

## Open product questions (carry forward)

These are open until WS7 starts. WS7's first milestone resolves them or
explicitly defers them with rationale:

1. **Distribution channel.** Anthropic plugin marketplace, self-hosted via
   `git+https://...`, or both? Affects polish bar + naming + license metadata.
2. **Audience priority for MVP.** Bootstrap evaluators or day-2 SREs?
   Both valid; picking one decides whether MVP leans toward
   `signalman-bootstrap` flavoring or `signalman-investigate-failure`
   flavoring of the slash command.
3. **Existing `skills/` directory** — keep skills in the repo root and
   have the plugin reference them (operators running Claude Code directly
   in the repo still get them) or move them into `plugin/skills/`
   (cleaner manifest, breaks existing repo-root usage)? Default
   recommendation: **keep at root, plugin references them**.
4. **Telemetry.** Do skill invocations feed signalman-cloud usage
   analytics (opt-in), or strictly silent? Affects what the plugin is
   allowed to do post-tool-use.
5. **Subagent vs. slash command for incident-responder.** Subagent feels
   right (narrow role, multi-step reasoning); slash command is faster to
   ship. Default recommendation: **slash command in v0.1.0, promote to
   subagent in v0.2.0 if usage justifies it**.

## Cross-references

- `docs/workstreams/prompts/ws7-claude-plugin.md` — the executable
  starting prompt for the MVP milestone.
- `skills/` — the 44 existing skills the plugin packages.
- `host/src/mcp/` — the MCP server the plugin registers.
- `plugins/signalman-loom-plugin/` — the Loom-plugin Rust crate
  (distinct from this Claude-plugin work; not to be confused).
- `signalman-cloud` repo — destination for the v1.0.0 proprietary
  sibling plugin.

## Non-goals

- This plugin is **not** a replacement for the CLI or the MCP server.
  Both remain first-class. The plugin is a conversational layer above
  them.
- This plugin does **not** add new product functionality. Every action
  it can take is already available via CLI / MCP. If WS7 finds itself
  wanting to add a new verb, that verb belongs in `host/` first; the
  plugin picks it up after it ships.
- This plugin does **not** ship its own auth or RBAC. Hosted
  authentication is signalman-cloud's job (per the WS3 contract doc).
