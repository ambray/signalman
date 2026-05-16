# WS12 starting prompt — OSS release-readiness (v0.5+)

Paste the block below into a fresh Claude Code session that has shell + write access to `C:\Users\ucale\source\repos\signalman`. WS12 runs directly on `main` with a feature branch (`feat/v0.5-oss-release-readiness`), not a separate worktree.

**WS12 is mostly small fixes + operator gestures.** Resist scope creep: the bundle exists *because* each item is too small to justify its own workstream. Don't expand the scope or get pulled into adjacent cleanups.

---

You are working on Signalman, an agent-first DevOps platform with an
open-core split: `signalman` (Apache-2.0 OSS) + `signalman-cloud`
(proprietary commercial). Host is TypeScript (`host/`); guest agent
is Rust (`guest/`). Main carries v0.4.0 through 2026-05-15: feature
surface complete; repo is structurally ready for public visibility
after the 2026-05-15 history-rewrite cleanup.

**Your branch:** `feat/v0.5-oss-release-readiness` off `main`. Cut
it from the repo root. All git ops from that root. **Do NOT push to
origin** until each milestone is operator-approved.

## What WS12 is

`docs/STATUS.md` §Public-release status lists five "Open" items
left after the history-rewrite landed. WS12 closes all of them as a
single coherent OSS-release-readiness pass:

1. **`signalman --version` verb** — referenced in `SECURITY.md` /
   `CONTRIBUTING.md` / the bug-report template, but `host/src/cli.ts`
   currently treats it as an unknown verb. Operators following the
   bug-report template hit "unknown verb: --version" and have to
   guess.
2. **`CODE_OF_CONDUCT.md`** — intentionally deferred at v0.2.0;
   GitHub's community-profile checklist flags it as missing. The
   operator picks a variant (Contributor Covenant most likely);
   we land the file.
3. **Consolidated v0.3.0 / v0.4.0 release-engineering tag** —
   `main` carries v0.3.x + v0.4.x work, version pins still say
   `0.2.1`. A coordinated bump + tag pass is queued.
4. **GitHub repo secrets for the release pipeline** — operator
   action (uploading `WINDOWS_CERT_BASE64`, `WINDOWS_CERT_PASSWORD`,
   `NPM_TOKEN`, `CARGO_REGISTRY_TOKEN` via `gh secret set`). WS12
   writes the operator runbook; the operator executes.
5. **Visibility flip** — operator action (`gh repo edit ... --visibility public`).
   WS12 writes the pre-flip checklist; the operator executes.

WS12 also closes one quiet long-standing item that belongs in this
bundle:

6. **CI coverage gate enforcement** — `host/vitest.config.ts` has
   the 80/70/80/80 thresholds, but the `ci.yaml` workflow doesn't
   run `npm run coverage`, so a regression below threshold lands
   silently. WS12 wires coverage into the CI lane.

## Orientation reading (in order, before any code)

1. **`docs/STATUS.md` §Public-release status** — read the Open
   list. Confirm with the operator that the five items still match
   their understanding (the doc is current as of 2026-05-15).
2. **`host/src/cli.ts`** — the verb dispatch around line 4596. The
   `--version` flag handler goes alongside `--help`.
3. **`host/package.json`** — current version is `0.2.1`. The
   release workflow validates manifest matches tag.
4. **`docs/STATUS.md` §Versions table** — the seven version-pinned
   files that must move in lockstep for a coordinated bump.
5. **`.github/workflows/release.yaml`** — the workflow that
   validates pinned versions match the pushed tag.
6. **`.github/workflows/ci.yaml`** — current CI lane (build + test;
   no coverage).
7. **`CONTRIBUTING.md`, `SECURITY.md`, `.github/ISSUE_TEMPLATE/`** —
   surfaces that reference `signalman --version` today.
8. `CLAUDE.md` at repo root — Loom protocol + selvedge guardrails.

## Open product questions — resolve in the first hour

Use `AskUserQuestion`. These are all small but mostly operator
preference.

1. **`--version` output format.** Plain `"signalman 0.4.0"`, or a
   richer multi-line shape (component versions for host / guest /
   service / registry / loom plugin)?
2. **CODE_OF_CONDUCT variant.** Contributor Covenant 2.1 (default
   recommendation), Citizen Code of Conduct, or a Signalman-custom
   variant?
3. **CODE_OF_CONDUCT enforcement contact.** What email or contact
   address goes in the enforcement section? `conduct@signalman.dev`?
   `aaron@relict.io`? Both?
4. **Version bump scope.** Bump to a single coordinated `v0.4.0`,
   or stage as `v0.3.0` (closes the v0.3.0-1..6 work) then `v0.4.0`
   (closes the v0.4.0-1..4 work) in two separate tags? Default
   recommendation: single `v0.4.0` because `main` already carries
   both scopes; staging adds churn without value.
5. **Registry tag.** Does `@signalman/registry` v0.1.1 get a
   separate tag in this pass, or stay at its existing v0.1.1?
   Default: stay; registry is independently versioned.
6. **CI coverage gate stringency.** Match `vitest.config.ts`
   exactly (lines: 80, functions: 80, branches: 70, statements: 80)?
   Or relax in CI by 5% to leave headroom for transient noise?
   Default: match exactly; if noise becomes a problem we raise the
   thresholds, we don't relax CI.
7. **Visibility flip timing.** Run the flip on the same operator
   session as the version-bump tag, or stagger (tag first, observe
   for a few days, then flip)? Default: stagger; gives time for a
   broken release-pipeline run to be caught privately.
8. **Bug-report template — `signalman --version` field.** Make it
   a required field (template won't submit empty) or keep it
   suggested? Default: required, since "what version" is the first
   triage question.

## Milestones — v0.5.0 ship

Each milestone is its own commit, and each ends with a green test
run.

### Milestone 1: `signalman --version` verb

- `host/src/cli.ts`: add a branch in `main()` for `argv[0] ===
  "--version"` (alongside `--help`). Print the format chosen in Q1.
- Source the version from `host/package.json` via a module load at
  startup (NOT a hardcoded constant — that's exactly the kind of
  drift that lands `0.2.1` in the wrong file). Use the same load
  path as the HTTP `/v1/healthz` `VERSION` const in
  `host/src/http/app.ts` for consistency.
- If Q1 lands on the multi-line shape, add component-version
  reads: host (`host/package.json`), guest + service + workspace
  (`Cargo.toml` workspace package version), registry
  (`registry/package.json`), loom plugin (`plugins/signalman-loom-plugin/Cargo.toml`).
  Be tolerant of the registry living outside the same npm
  workspace.
- Tests:
  - **Unit:** version-string composition for both empty argv and
    `--version`.
  - **Smoke:** the help text now mentions `--version` so operators
    discover it.
  - **Integration:** the bug-report template's instructions
    actually work (paste the literal command from the template,
    assert exit 0 + version string).

**Commit:** `feat(v0.5-oss-release-readiness): signalman --version verb`

### Milestone 2: `CODE_OF_CONDUCT.md`

- Land the file per Q2 outcome with the contact from Q3.
- Cross-reference: the file is mentioned in `CONTRIBUTING.md`
  (link to it there); GitHub's community profile picks it up
  automatically from the repo root.
- No tests needed for this milestone.

**Commit:** `docs(v0.5-oss-release-readiness): adopt Contributor Covenant code of conduct`

### Milestone 3: Coordinated version bump + tag prep

- Bump every entry in `docs/STATUS.md` §Versions table from `0.2.1`
  to the version chosen in Q4 (likely `0.4.0`):
  - `host/package.json`
  - `host/src/http/app.ts` `VERSION` const
  - `guest/Cargo.toml`
  - `Cargo.toml` workspace `version`
  - `service/Cargo.toml` (inherits — verify the workspace bump
    propagates)
  - `plugins/signalman-loom-plugin/Cargo.toml`
- Run `cargo build --workspace` and `cd host && npm install` (or
  `npm ci`) to regenerate lockfiles; commit the lockfile churn.
- Update CHANGELOG: add a `## v0.4.0 — 2026-05-XX` section that
  bundles v0.3.0-1..6 and v0.4.0-1..4 release notes from their
  existing entries.
- Update `docs/STATUS.md`:
  - §Current state — flip the "no tag has been cut" sentence.
  - §Public-release status §Open — mark items 3 (consolidated tag)
    as ready for execution.
- The actual `git tag` is operator action — don't run it. The
  operator does: `git tag -a v0.4.0 -m "v0.4.0"` + `git push origin
  v0.4.0` after this milestone merges.

**Commit:** `chore(v0.5-oss-release-readiness): bump version pins to v0.4.0 + changelog`

### Milestone 4: CI coverage gate

- `.github/workflows/ci.yaml`: add a `coverage` step that runs
  `cd host && npm run coverage -- --testTimeout=30000` after the
  existing test step.
- The step fails the workflow if coverage falls below
  `vitest.config.ts` thresholds (it does by default — vitest
  exits non-zero when thresholds are unmet).
- Cache the v8 coverage tool installation between runs (small win;
  matches existing cache patterns in the workflow).
- Add a comment in `ci.yaml` linking to `vitest.config.ts` so
  future contributors understand the thresholds are co-located.
- Tests: not directly testable in this PR; the proof is the next
  intentional below-threshold change failing CI. Manual verify by
  temporarily backing out coverage to confirm the gate trips.

**Commit:** `ci(v0.5-oss-release-readiness): enforce host coverage gate in CI`

### Milestone 5: Operator runbook (secrets + visibility flip)

- New doc `docs/runbooks/public-release.md`. Sections:
  - **Repo secrets** — exact `gh secret set` commands for each of
    the four secrets (`WINDOWS_CERT_BASE64`,
    `WINDOWS_CERT_PASSWORD`, `NPM_TOKEN`, `CARGO_REGISTRY_TOKEN`).
    Each command shows the source format the operator needs
    (e.g. base64-encoding the cert PFX) but does NOT include any
    actual secret material.
  - **Pre-flight checklist** — version pins consistent (Milestone
    3), CI green on `main`, no `.workstream-status.md` claims an
    operator-review need, registry-side smoke tests pass.
  - **Dry-run tag** — push a `v0.4.0-rc1` tag to exercise the
    release workflow with secrets in place but without going
    public. Verify artifacts upload, package publish succeeds.
  - **Visibility flip** — `gh repo edit ucale/signalman
    --visibility public --accept-visibility-change-consequences`.
    Document the GitHub-side cleanup checks (secrets stay; webhooks
    stay; collaborators stay).
  - **Post-flip smoke** — clone the public URL on a clean host,
    `cargo build --workspace`, `cd host && npm install && npm
    test`.
  - **Rollback** — `gh repo edit ucale/signalman --visibility
    private` if a problem surfaces in the first 24h.
- Update `docs/STATUS.md` §Public-release status §Open — mark
  items 1 (visibility flip) and 2 (repo secrets) as runbook-ready.

**Commit:** `docs(v0.5-oss-release-readiness): public-release runbook`

### Milestone 6: Bug-report template + community-profile sweep

- `.github/ISSUE_TEMPLATE/bug-report.md` (or the YAML form, if it's
  been converted) — make the `signalman --version` field required
  per Q8 outcome.
- Verify GitHub's community-profile checklist
  (`gh api repos/ucale/signalman/community/profile` returns 100%):
  - README ✓
  - LICENSE ✓
  - CONTRIBUTING ✓
  - CODE_OF_CONDUCT (added in M2)
  - Issue templates ✓
  - PR template ✓
  - SECURITY ✓
  - Any other field the API reports as missing — close it here or
    flag for operator review.
- 4-lens audit in `.workstream-status.md`. **Product lens** is the
  primary one for WS12; the others should be quick.

**Commit:** `docs(v0.5-oss-release-readiness): bug-report template polish + community-profile closure`

## Test taxonomy

Light by WS standards — WS12 is mostly docs + small CLI verb +
CI wiring.

| Layer | Examples |
|---|---|
| **Unit** | `--version` string composition; version-source loader |
| **Integration** | Bug-report template instruction works end-to-end |
| **Smoke** | Help text mentions `--version`; community-profile API returns 100% |
| **CI verification** | Coverage gate trips on intentional regression (manual verify) |

No new coverage gate set — WS12 enforces the existing one.

## Reserved blocks

- No new migrations.
- No new error codes.
- No new MCP tool names.

## Definition of Done

1. `cd host && npm test` — full suite green
2. `cd host && npx tsc --noEmit` — zero errors
3. `cd host && npm run coverage` — coverage holds per gate (proves
   M4 doesn't trip the very gate it's enforcing)
4. `cargo build --workspace && cargo test --workspace` — zero
   failures
5. `signalman --version` returns the expected format (manual run)
6. `gh api repos/ucale/signalman/community/profile` returns 100%
   (or the operator has explicitly accepted the remaining missing
   fields)
7. The public-release runbook reads end-to-end on a dry run — the
   operator walks through it without hitting an "I don't know what
   this means" moment
8. **4-lens audit completed** — Product lens specifically PASS
9. Commits ready (Co-Authored-By: Claude Opus 4.7 (1M context)
   `<noreply@anthropic.com>`) but **NOT pushed**

## Commit pattern

- M1: `--version` verb — 1 commit
- M2: CODE_OF_CONDUCT — 1 commit
- M3: version bump + changelog — 1 commit (includes lockfile churn)
- M4: CI coverage gate — 1 commit
- M5: public-release runbook — 1 commit
- M6: template + community-profile — 1 commit
- Subject format: `feat(v0.5-oss-release-readiness): <what>`,
  `docs(v0.5-oss-release-readiness): <what>`,
  `ci(v0.5-oss-release-readiness): <what>`, or
  `chore(v0.5-oss-release-readiness): <what>`
- No internal-product names in commit messages.

## Status report (when complete)

`.workstream-status.md` with sections:

- `## Commits` (6 expected)
- `## Open questions resolved`
- `## Tests added`
- `## Coverage` confirmation (held, not added)
- `## 4-lens audit` — Product lens PASS, others quick
- `## Operator action items` — explicit list of what the operator
  must do after WS12 merges (tag push, secret upload, visibility
  flip) in execution order
- `## Operator review needed`

Then return a ≤200 word summary.

## Conventions

- TypeScript strict; no `any` without justifying comment.
- No emojis in source, docs, or commit messages.
- **No actual secret material** in the runbook — only the shape
  + the `gh secret set` invocation that consumes the operator's
  out-of-band-held secret.
- Don't push to origin without operator approval.
- **Scope discipline.** WS12 is six small items by design. Don't
  expand it. If you notice an adjacent fix that's not on the list,
  open a v0.6+ ROADMAP entry instead of bundling it in.

## Parallel work to be aware of

- **WS7 (Claude Code plugin)** — no overlap.
- **WS8 (identity certs)** — no overlap.
- **WS9 (signing service)** — no overlap.
- **WS10 (macOS UI parity)** — no overlap.
- **WS11 (vmware convergence)** — no overlap.

WS12 touches: `host/src/cli.ts` (M1), `host/src/http/app.ts` (M3
VERSION bump only), `host/package.json` (M3), `guest/Cargo.toml`
(M3), `Cargo.toml` (M3 workspace bump), `service/Cargo.toml` (M3
verify), `plugins/signalman-loom-plugin/Cargo.toml` (M3),
`CODE_OF_CONDUCT.md` (M2, new), `CHANGELOG.md` (M3),
`docs/STATUS.md` (M3 + M5), `.github/workflows/ci.yaml` (M4),
`.github/ISSUE_TEMPLATE/` (M6), `docs/runbooks/public-release.md`
(M5, new).

If you find yourself touching anything outside that list, stop and
surface to the operator.

Start by confirming the §Open list in `docs/STATUS.md` still
reflects the operator's understanding, then post the 8 open
questions, then begin Milestone 1.
