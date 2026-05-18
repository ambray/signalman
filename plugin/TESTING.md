# Plugin testing notes (operator-facing)

This file documents the manual + automated verification steps that
back the v0.1.0 MVP. Some steps require a real Claude Code install on
the operator's machine; the agent that built the plugin could not
exercise those steps from inside its own shell environment.

## Automated: manifest-validation test

Run from the plugin directory:

```bash
cd plugin && npx vitest run
```

Expected: all assertions pass. Failure modes the test catches:

- Manifest missing, unparseable, or missing required fields.
- MCP server invocation pointing at a path the host build doesn't
  produce.
- Declared skill paths (or default `skills/` entries) that don't
  resolve to a real `SKILL.md`.
- Slash-command markdown file declared in the manifest but missing on
  disk.
- Permission preset entries that don't match a real MCP tool name
  registered by `host/src/server.ts` (cross-checked at test time
  against the live tool registry).

## Manual verification path A — `claude --plugin-dir`

Pre-requisite: host MCP server is built.

```bash
# from repo root
cd host && npm install && npm run build
cd ..
# verify the build artefact exists
test -f host/dist/server.js && echo OK
```

Load the plugin into a fresh Claude Code session:

```bash
claude --plugin-dir ./plugin
```

Inside the session, verify:

1. `/plugin` lists `signalman` as enabled.
2. The MCP server `signalman` connects (look for it under `/mcp` or
   the equivalent status surface).
3. `/signalman-status` is discoverable as a slash command.
4. Invoking `/signalman-status` against a freshly-bootstrapped
   signalman returns a coherent ~10-line answer in < 5 seconds (the
   acceptance criterion from `docs/design/v0.5-claude-plugin.md`
   Story 3).
5. The six skills are auto-discovered from `plugin/skills/`:
   - `signalman-build-from-tag`
   - `signalman-deploy-to-test`
   - `signalman-rollback`
   - `signalman-promote-release`
   - `signalman-query-audit-log`
   - `signalman-register-target`

## Manual verification path B — permission preset

The signalman permission preset is **advisory documentation**, not
plugin-enforced. (Claude Code's plugin manifest does not support an
embedded `permissions` block; plugin-scoped `settings.json` only
accepts `agent` and `subagentStatusLine` keys per the plugin
reference.)

To apply the preset:

1. Open `plugin/PERMISSIONS.md`.
2. Copy the `permissions` block into one of:
   - `~/.claude/settings.json` (user-wide; applies to every project)
   - `.claude/settings.json` in your project (team-shared via VCS)
   - `.claude/settings.local.json` (project-local, gitignored)
3. Restart Claude Code, or run `/permissions reload` if available.

Verify behaviour:

1. Try a read-only verb (e.g. ask Claude to call `signalman_list`).
   Expected: runs without a prompt.
2. Try a state-changing verb (e.g. `signalman_release_deploy`).
   Expected: Claude Code prompts for permission.
3. Try a destructive key/cert verb (e.g. `signalman_key_generate`).
   Expected: Claude Code refuses with a deny-rule explanation.

## Manual verification path C — marketplace install

Not yet exercisable: marketplace listing TBD. When ready, the steps
will be:

```bash
claude plugin install signalman@<marketplace-id>
```

## Known limitations (spec drift from design doc)

### Skill location: repo-root vs plugin/

The detail design (`docs/design/v0.5-claude-plugin.md` Q3 lock) calls
for keeping skills at repo-root `skills/` with the plugin manifest
referencing them. Per the Claude Code plugins reference (fetched
2026-05-17 from <https://code.claude.com/docs/en/plugins-reference>):

> Installed plugins cannot reference files outside their directory.
> Paths that traverse outside the plugin root (such as
> `../shared-utils`) will not work after installation because those
> external files are not copied to the cache.

And specifically for symlinks:

> For plugins installed with `--plugin-dir` or from a local path,
> only symlinks that resolve within the plugin's own directory are
> preserved. All others are skipped.

The MVP ships `plugin/skills/<name>` as symlinks targeting
`../../skills/<name>`. This works for the **`--plugin-dir`
local-dev install** (the immediate target audience: OSS contributors
running Claude Code in the repo) because the symlinks resolve at
runtime against the live filesystem.

It does **NOT** work for marketplace install, because the cache copy
step strips outside-the-plugin symlinks. Mitigations available before
the marketplace publish:

1. **Build-step copy.** A `plugin/build.sh` (or similar) walks the six
   skills + replaces the symlinks with real copies before publishing.
   The repo-root `skills/` tree remains canonical for in-repo Claude
   Code sessions.
2. **Re-home the skills.** Move the six MVP skills from
   `skills/<name>/` into `plugin/skills/<name>/`. Breaks Q3 lock;
   requires re-litigation.

Either path is acceptable; the operator decides at marketplace-publish
time. The MVP is operator-deliverable today for the local-dev install
path, which is the v0.1.0 acceptance scope.

### Permission preset is documentation, not enforcement

Plugin manifests don't carry a `permissions` block. The preset in
`PERMISSIONS.md` is a copy-paste reference for users' `settings.json`.
The manifest-validation test asserts every preset entry matches a real
MCP tool name (cross-checked against `host/src/server.ts`), so a
host-side tool rename is caught immediately.

## What the agent could *not* verify in its own shell

- `claude --plugin-dir ./plugin` runtime behaviour (the agent runs in
  a sandboxed environment without an interactive Claude Code session).
- `/signalman-status` end-to-end latency against a freshly-bootstrapped
  signalman.
- MCP server stdio connection (requires Claude Code spawning the host
  process).
- Permission-prompt UX.

The operator should walk through Path A above before merging the WS7
branch to main.
