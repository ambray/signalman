# Workstream quality gates — canonical definitions

Every workstream in `docs/workstreams/prompts/` references this doc as
the binding definition of two recurring requirements:

1. **Per-story coverage gate** — gates each story commit
2. **Per-milestone 4-lens audit** — gates milestone closure

When a workstream prompt says "≥80%/80% coverage gate per story" or
"4-lens audit at milestone close", *this* doc spells out exactly what
that means. If a fresh agent picks up a workstream and is unsure how
to satisfy these, this doc is the answer.

---

## Coverage gate (per story)

### What's measured

For **every story** in a workstream:

- **≥80% lines AND ≥80% branches** on every **new** TypeScript file
  created in that story.
- **≥80% lines AND ≥80% branches** on the **modified portion** of any
  existing file the story changes. (Files where the story's diff is
  ≥30 lines: enforce file-level aggregate ≥80%/80%. Smaller diffs:
  every new branch added in the diff must be exercised by a new
  test.)
- **Test files exempt** — coverage is measured on production code, not
  on test code.
- **Type-only files exempt** — files where the v8 reporter shows 0
  executable statements (pure type/interface declarations) are
  exempt with a one-line documentation note in the audit doc
  (`<file>: type-only; coverage exempt per v0.7-quality-gates §X`).
- **Standing exclusions inherited** — `vitest.config.ts` carries
  exclusions established in prior milestones (e.g. `src/hypervisors/*.ts`
  whose coverage is integration-tested rather than unit-tested per the
  M1 audit). The story does NOT add new exclusions without operator
  approval; if it does, the addition lands in a separate `chore:`
  commit with the rationale spelled out.

### How it's measured

```bash
cd host && npx vitest run --coverage <paths to new + modified files>
```

`vitest.config.ts` configures the v8 reporter. Coverage runs per-file;
the gate is satisfied if every per-file line + branch percentage meets
the threshold. The story commit message body **must** report:

```
Coverage on new files:
- src/path/to/file-a.ts: 95.4% lines / 87.5% branches
- src/path/to/file-b.ts: 100% / 100%

Coverage on modified files (delta only):
- src/existing/file.ts: 82% / 80% on the M4 added branches
```

### If a file fails the gate

Three legitimate paths:

1. **Write more tests** (default).
2. **Refactor** to separate testable logic from untestable surface
   (preferred when the untestable portion is an environment-specific
   side effect — e.g. spawning a real binary).
3. **Document an exclusion** in the audit doc with explicit rationale.
   Acceptable rationales:
   - Windows-only PowerShell branch unreachable on Linux CI (matches
     the existing `provisionVM` exclusion pattern from Win11 M1).
   - Production-binary spawn path that's intentionally untested in
     unit lane and integration-covered in a gated system-lane test
     (`SIGNALMAN_*_TESTS=1`).
   - Network-failing or filesystem-permission paths where the test
     environment can't reasonably reproduce the condition.
   Operator-surface exclusions (e.g. "we'll test it manually") are
   **not** acceptable.

### Validation gate

Before any story commits land, the agent must:

```bash
cd host && npx tsc --noEmit                    # no NEW errors vs branch baseline
cd host && npx vitest run <story test files>  # green
cd host && npx vitest run                      # full suite, no regressions vs baseline
cd host && npx vitest run --coverage <new/modified files>  # ≥80%/80% per file
```

The story commit body documents the four numbers above.

### Pre-existing failures

Workstreams inherit pre-existing failures from `main`. The agent must:

1. Establish the baseline at the start of the workstream (`npx vitest
   run` on the trunk; record pass/fail/skip counts).
2. After each story, verify the same baseline pass count + the same
   set of pre-existing failures + the story's net new tests pass.
3. **Do not "fix" pre-existing failures opportunistically**. If a
   pre-existing failure is in the workstream's path of change,
   surface to operator + open a separate fix.

---

## 4-lens audit (per milestone close)

### When it runs

At the close of every **milestone** within a workstream. A milestone
is a meaningful operator-visible unit of value (one or more stories
that together deliver an end-state). The workstream prompt names the
milestones explicitly.

For workstreams that ship as a single milestone (most), the audit
runs once at workstream close. For multi-milestone workstreams (e.g.
WS13 M1/M2/M3/M4 each got their own audit), the audit runs at each
milestone close.

### Where it lives

`.workstream-status-<workstream-name>.md` at the repo root (a separate
file per workstream, matching the existing v0.5/v0.6 convention). The
audit is one section of the status doc, alongside commits list, test
counts, deferred items, and operator-runbook content.

### The four lenses

Each lens is a paragraph or two. Each ends with one of:

- **PASS** — the lens has no concerns; the milestone is shippable
  from this perspective.
- **PASS with one concern** — the milestone is shippable but a
  specific item is flagged for operator awareness (e.g. a deferred
  follow-up, a known limitation, an upgrade path that's not yet
  built). The concern is named precisely.
- **FAIL** — the milestone has a blocking issue from this lens. The
  audit doc names the issue + the path to resolve it. Operator
  decides whether to fix-before-ship or accept-and-defer.

If a lens ends FAIL, the milestone does NOT close until either the
issue is fixed OR the operator explicitly accepts the deferral with a
recorded rationale in the audit doc.

#### Lens 1 — QA

Evaluate the milestone from the test-coverage + correctness angle:

- Total test count delta vs baseline.
- Per-file coverage table for every new + modified file (the same
  table format the story commits used; consolidated here).
- Edge cases the milestone caught + tested for (e.g. "Win11 25H2
  CDFS rejects ISOs with zero modDate — covered by
  `seed-iso-moddate.test.ts:42`").
- Any new flaky tests introduced.
- Pre-existing failures unchanged (named explicitly).
- Real-VM / integration / system-lane verification if applicable
  (with captured logs referenced).

End with **PASS** / **PASS with one concern** (named) / **FAIL** (named).

#### Lens 2 — Architecture

Evaluate the milestone from the structural-design angle:

- Does the change cohere with existing patterns (interfaces, manager
  types, dispatch tables, layering)? Or does it introduce a parallel
  structure that should have been an extension?
- Are abstractions at the right level — neither over-engineered nor
  too coupled to implementation details that will need to change?
- Are layering inversions introduced? (E.g. did `provisioning/`
  start depending on `hypervisors/libvirt/` directly when it should
  go through the `HypervisorBackend` interface?)
- Will a future maintainer reading this code in 6 months understand
  the shape? Are non-obvious decisions documented inline?
- Does the milestone leave behind any "to be cleaned up later"
  shapes that should have been done now?

End with **PASS** / **PASS with one concern** (named) / **FAIL** (named).

#### Lens 3 — Product

Evaluate the milestone from the operator-experience angle:

- Does the operator-visible behavior match what the design doc
  promised?
- Are error messages actionable? (Bad: `error: failed`. Good:
  `error: signalman.build.yaml not found at <path>. Pass
  --build-yaml <path> or run from a directory with the file.`)
- Is the CLI surface coherent with the rest of signalman? Does
  `--help` produce useful output?
- Will a first-time operator succeed at the intended flow without
  reading source code?
- Are deferred items operator-visible? (E.g. a runbook section
  pointing at the next manual step the operator owns.)
- Are skills + MCP tools updated so future agent sessions know how
  to use this milestone's surface?

End with **PASS** / **PASS with one concern** (named) / **FAIL** (named).

#### Lens 4 — Security

Evaluate the milestone from the threat-model angle:

- What new attack surface or trust assumptions did the milestone
  introduce? (E.g. a new RPC endpoint, a new file-system path, a
  new external dependency.)
- Are inputs validated at every trust boundary? Path canonicalization,
  length caps, character allowlists, etc.
- Are secrets / tokens / capabilities scoped correctly? (E.g. CA
  bytes never logged; auth tokens redacted from audit entries.)
- Are audit logs sufficient for a future compromise investigation?
- Any path-traversal, TOCTOU, injection, or signature-bypass
  concerns?
- Does the milestone weaken any existing integrity property of the
  host (e.g. file permission relaxations, kernel module loads,
  setuid bits)? If so, is it strictly necessary and operator-visible?

End with **PASS** / **PASS with one concern** (named) / **FAIL** (named).

### Audit-doc format

A typical audit section reads like:

```markdown
## 4-lens audit (Story <N> close, 2026-MM-DD)

### QA lens — PASS

Test count delta: +66 vs baseline (3823 → 3889 + 13 skip + 2 unrelated
pre-existing fail). Coverage on new files: ... [table]. Edge cases
caught: ... Real-VM verification: install completed unattended in
~50 min on `win11-build-9b6`; setupact.log captured (path:
.signalman/state/vm-provision/win11-build-9b6-setupact.log).

### Architecture lens — PASS with one concern

The `BuildHostManager` interface coheres with the existing three
managers (Template/Provisioning/AgentInstall) introduced in v0.6. The
per-OS implementations follow the same factory-registry pattern.

**Concern:** the `runBuild` method signature accepts `target:
BuildTarget` as a union of literal strings; this works for the four
shipped targets but the extension path for adding new targets is
manual (every implementation needs the new case). v0.8 should consider
a registry-based approach if the target list grows beyond ~8.

### Product lens — PASS

`signalman vm provision <name> --template ... --template-kind installer
--build-bundle windows-msi` produces a signed signalman-agent.msi at
`~/Downloads/signalman-agent.msi` against a fresh host. Error
messages are actionable. Operator runbook references the meta-build
catalog for version selection.

### Security lens — PASS

No new external network surface (uses existing virtio-win.iso shipped
by operator; SHA-pinned at template registration). Inputs canonicalized
in `BuildHostManager`'s remote-path arguments; no path traversal. Audit
log captures every guest-side command execution via QGA. Signed-MSI
output flows through WS9 signing service. No host-integrity weakening
(no setuid, no kernel-module loads, no permission relaxations).
```

### Standard format applies

Every workstream's audit follows this same shape so that consolidating
audits across workstreams is mechanical. Deviations from the format
need operator approval.

---

## Cross-workstream conventions (recap)

Inherited from `PLAN.md` and re-stated for fresh-agent context:

- **No push to origin** without explicit operator authorization. Each
  push is a separate gesture, not implied by a successful audit.
- **No merge to main** without explicit operator authorization. Each
  merge is a separate gesture, not implied by a successful audit.
- **Branch per workstream** (`feat/v<ver>-<workstream>`). Sub-branches
  per story when running parallel agents (`feat/v<ver>-<workstream>-story-N`).
- **Loom CLI + selvedge are referenced in `CLAUDE.md` but may not be
  installed.** If absent, proceed for doc-only and code work; surface
  the gap once at start, then move on.
- **Per-invocation git identity:**
  `git -c user.name='Claude' -c user.email='claude@local' commit ...`.
- **Heredoc + Co-Authored-By** on every commit per `CLAUDE.md`'s
  commit-message convention.

---

## Cross-reference

- `docs/workstreams/PLAN.md` — master parallel plan (now historical;
  v0.3/v0.4 cohort).
- `docs/workstreams/README.md` — workstream-launching how-to.
- `docs/workstreams/prompts/*.md` — per-workstream paste-ready
  prompts.

When this doc and a prompt disagree on a gate definition, **this doc
wins** — the prompt should reference the canonical definition rather
than restating it inline.
