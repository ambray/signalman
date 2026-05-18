# signalman — Claude Code plugin (v0.1.0 MVP)

A Claude Code plugin that turns the signalman release-lifecycle control
plane into a conversational operator surface. Wraps the host MCP server
and ships six day-2 SRE skills plus the `/signalman-status` slash
command.

This is the **OSS plugin** — Apache-2.0, standalone, no cloud features
required. A proprietary `signalman-cloud` sibling is on the roadmap for
v1.0.0 (see `ROADMAP.md`).

## What's inside

| Component | What it does |
| --- | --- |
| MCP server `signalman` | Spawns `node ${CLAUDE_PROJECT_DIR}/host/dist/server.js` (the host's stdio MCP server). Exposes ~73 tools: `signalman_list`, `signalman_release_build`, `signalman_release_deploy`, etc. |
| Slash command `/signalman-status` | Day-2 SRE one-shot: synthesises recent releases, pending promotions, failing probes, stale runners, optional cloud budget into a ~10-line answer. |
| Skills (6) | `signalman-build-from-tag`, `signalman-deploy-to-test`, `signalman-rollback`, `signalman-promote-release`, `signalman-query-audit-log`, `signalman-register-target` |
| Permission preset (advisory) | See `PERMISSIONS.md` — copy into your `settings.json` to auto-allow read-only verbs, prompt for state-changing ones, deny key/cert ops. |

## Install

### Prerequisites

- A signalman host build at `<project>/host/dist/server.js`. Run
  `npm install && npm run build` in `host/` before enabling the plugin.
  The plugin's MCP server invocation expects this path.
- Claude Code 2.1+.

### Path A — local-dev install (`--plugin-dir`)

From the signalman repo root:

```bash
claude --plugin-dir ./plugin
```

This loads the plugin for the current Claude Code session only. The
skill index is auto-discovered from `plugin/skills/` (symlinks back to
the repo-root `skills/` tree). Use this path for OSS contributors and
for evaluating the plugin before marketplace install.

### Path B — git-URL self-host install

```bash
claude plugin install git+https://github.com/ambray/signalman.git#path:plugin
```

(See `TESTING.md` for the exact verification steps once a build is
available.)

### Path C — Anthropic plugin marketplace

The manifest is marketplace-ready (icon, screenshots, version pinning
will land before v0.1.0 publish). Listing TBD.

## Uninstall

```bash
claude plugin uninstall signalman
```

To preserve the persistent data directory, add `--keep-data`.

## Version compatibility

| Plugin version | Host version |
| --- | --- |
| 0.1.x | 0.5.x (current main) |

The host's MCP server tool surface is stable across patch releases.
Major-version bumps in the host may require a plugin version bump if
tool names change.

## Locked product decisions (operator-authorised 2026-05-17)

These decisions are pinned for the v0.1.0 MVP. Re-litigation requires a
new operator authorisation, not a contributor PR.

1. **Distribution channel: both marketplace and git-URL self-host.**
   Manifest is marketplace-ready; this README documents the
   `git+https://...#path:plugin` self-host path so OSS users can
   install without going through the marketplace.
2. **Audience priority: day-2 SRE flavoring.** The `/signalman-status`
   slash command leads with what's-broken/pending/stale, not
   what's-set-up/next-step. A future `/signalman-bootstrap-status`
   in v0.2.0 will serve the evaluator audience.
3. **Skill location: repo-root `skills/`.** The plugin's `skills/`
   directory contains symlinks back to the repo-root tree. OSS
   contributors running Claude Code directly in the repo continue to
   get the skills loaded automatically. (Spec note: per the Claude
   Code plugin reference, marketplace-installed plugins only preserve
   symlinks that resolve *within the plugin's own directory*. The
   symlink-to-repo-root pattern works for the local-dev install path
   but a marketplace publish will require either copying the skills
   into `plugin/skills/` at build time or accepting them as ignored.
   See `TESTING.md` §"Known limitations".)
4. **Telemetry: out of scope for v0.1.0.** No post-tool-use feeds.
   v1.0.0 (open-core split) may introduce opt-in telemetry for the
   cloud sibling; this OSS plugin is silent forever.
5. **Subagent vs slash command for incident-responder: slash command
   in v0.1.0, subagent in v0.2.0.** `/signalman-status` ships now;
   the incident-responder subagent (richer multi-step reasoning) is
   deferred.

## What's deferred

See `ROADMAP.md` §"v0.2.0" for the next-cycle scope:

- All 44 skills indexed (we ship 6 in v0.1.0).
- `signalman-incident-responder` subagent.
- `/signalman-investigate` and `/signalman-cleanup-stale` slash commands.
- Destructive-command hooks with rich preview.
- Cloud-aware skill loading.

## Testing

See `TESTING.md` for the manual verification steps the agent walked
through during MVP construction, plus operator-facing manual-test
checklists for the install paths above.

## Architecture pointers

- Host MCP server: `host/src/server.ts` (registers ~73 tools).
- Tool names: `signalman_*` (e.g. `signalman_list`, `signalman_release_deploy`).
- Repo-root skills: `skills/` (44 skills total; the plugin packages 6).
- Strategic roadmap: `ROADMAP.md` (in this directory).
- Detail design for v0.1.0: `docs/design/v0.5-claude-plugin.md` (repo
  root).
- Operational prompt (advisory; superseded by detail design):
  `docs/workstreams/prompts/ws7-claude-plugin.md`.
- Loom Rust plugin (distinct, **not** this plugin):
  `plugins/signalman-loom-plugin/`.

## License

Apache-2.0. See `LICENSE`.
