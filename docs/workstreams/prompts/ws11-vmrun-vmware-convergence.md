# WS11 starting prompt — vmrun ↔ VMware backend convergence (v0.5+)

Paste the block below into a fresh Claude Code session that has shell + write access to `C:\Users\ucale\source\repos\signalman`. WS11 runs directly on `main` with a feature branch (`feat/v0.5-vmware-convergence`), not a separate worktree.

**WS11 is a deliberate refactor.** The two parallel backends (`vmware.ts` legacy, `vmrun.ts` parallel-track) are operator-acknowledged tech debt — see `host/src/hypervisors/vmrun.ts` §"Locked design" header comment. Resist scope creep: the goal is *one* backend that subsumes both, not new features.

---

You are working on Signalman, an agent-first DevOps platform with an
open-core split: `signalman` (Apache-2.0 OSS) + `signalman-cloud`
(proprietary commercial). Host is TypeScript (`host/`); guest agent
is Rust (`guest/`). Main carries v0.4.0 through 2026-05-15: full
backend matrix — Hyper-V, libvirt, Tart, plus two VMware paths
(`vmware`, `vmrun`).

**Your branch:** `feat/v0.5-vmware-convergence` off `main`. Cut it
from the repo root. All git ops from that root. **Do NOT push to
origin** until the operator approves the first milestone.

## What WS11 is

Two backends today both target VMware Workstation / Fusion:

- **`host/src/hypervisors/vmware.ts`** — older, operationally
  exercised. Drives `vmrun` for local hosts and `govc` for vSphere.
  Has a `useGovc` toggle. Credentials passed as argv (S-14 documented).
  Selected via `hypervisor.backend = "vmware"`.
- **`host/src/hypervisors/vmrun.ts`** — newer, fresh implementation
  with injectable exec, stable `VmrunBackendError` codes, no govc
  surface, modern testing idioms (matches `libvirt.ts` shape).
  Selected via `hypervisor.backend = "vmrun"`.

Both are listed in `host/src/hypervisors/selector.ts` and operators
choose between them by config key. This was a deliberate parallel
track introduced in v0.4.0-4 chunk 3 (see `vmrun.ts` header comment
§"Locked design"), with an explicit operator commitment: *"The two
converge on a single backend in a future release once both have been
exercised in real scenarios."* That release is v0.5; WS11 does the
convergence.

### What "convergence" means concretely

1. **One backend module** that subsumes both. Name TBD in
   Milestone 0 (`vmware.ts` keeping legacy compatibility, or a
   fresh `vmware-fusion.ts` with backwards-compat shim).
2. **One `hypervisor.backend` value**. The other value remains an
   accepted alias that emits a deprecation log on resolution.
3. **vmrun.ts's modern testing idioms win** — injectable exec,
   stable error codes, structured options. The govc fallback path
   from vmware.ts is preserved verbatim *behind* the same modern
   shape.
4. **Credential argv hygiene** — the cross-cutting S-14 risk
   (guest creds visible in `ps`) is mitigated consistently across
   all guest verbs. Use vmrun's encrypted credential store
   (`-vp <path>`) where available, fall back to argv with the
   existing process-listing warning where not.
5. **No behavior changes for the operator** — same selector keys
   accepted (one as alias), same `signalman.yaml` shape, same
   `signalman vm *` CLI verbs, same `signalman_vm_*` MCP tools.
   The conformance test suite catches any drift.

## Orientation reading (in order, before any code)

1. **Both backends end to end.** Read all of `host/src/hypervisors/vmware.ts`
   and all of `host/src/hypervisors/vmrun.ts`. Pay attention to:
   - Method-by-method behavior coverage (vmware.ts has govc paths
     vmrun.ts doesn't; vmrun.ts has structured errors vmware.ts
     doesn't).
   - The S-14 credential note in vmware.ts §JSDoc.
   - The vmrun.ts header comment §"Locked design" — the operator
     decisions baked into v0.4.0-4 are inputs to your convergence
     design.
2. **`host/src/hypervisors/selector.ts`** — backend wiring. Your
   convergence keeps the same selector contract.
3. **`host/src/hypervisors/interface.ts`** — the contract both
   backends implement. Read for any interface concerns the merge
   surfaces.
4. **Tests for both backends:**
   - `host/src/__tests__/vmware.test.ts`
   - `host/src/__tests__/vmrun-backend.test.ts`
   - `host/src/__tests__/vmrun-argv.test.ts`
5. **`docs/mac-virtualization.md` §Option C: VMware Fusion** —
   names the user-facing positioning. Convergence does not promote
   VMware Fusion to a primary Mac path (Tart stays primary); it
   just unifies the implementation.
6. **`docs/STATUS.md`** — current backend matrix.
7. `CLAUDE.md` at repo root — Loom protocol + selvedge guardrails.

## Open product questions — resolve in the first hour

Use `AskUserQuestion`. Update `docs/design/vmware-backend-convergence.md`
to lock the answers.

1. **Module name.** Keep `vmware.ts` (legacy import paths unchanged,
   minimal churn) or rename to `vmware-fusion.ts` (clearer purpose,
   but every importer churns)?
2. **Backend key.** Single key `vmware`; `vmrun` becomes an alias
   with deprecation log. *Or* single key `vmware-fusion` with both
   `vmware` and `vmrun` as aliases? Default recommendation: keep
   `vmware` as canonical; alias `vmrun`.
3. **govc surface scope.** Preserve govc as a sub-path inside the
   converged backend (the same module dispatches based on
   `useGovc`)? Or extract govc to a sibling backend
   (`vmware-vsphere.ts`) since vmrun ≠ govc operationally? Default
   recommendation: preserve as sub-path for v0.5; extract in v0.6
   if the operational complexity justifies.
4. **Credential argv hygiene.** Default-on encrypted credential
   store (`-vp <path>`) when vmrun version supports it, fall back
   to argv with a logged warning? Or argv-only (current behavior)
   with operator opt-in for `-vp`?
5. **Error taxonomy.** Adopt vmrun.ts's `VmrunBackendError` codes
   verbatim, or expand it (e.g. add govc-specific codes like
   `vsphere_auth_failed`, `datastore_full`)?
6. **Migration story.** Operators with
   `hypervisor.backend = "vmrun"` in their `signalman.yaml`: log a
   deprecation warning and continue, or fail the load with a
   clear migration message? Default: warn + continue for v0.5;
   plan removal in v0.7.
7. **Public type exports.** vmware.ts and vmrun.ts each export
   different public types (`VmrunBackendError`, etc.). The
   converged module exports the superset; do we keep the
   old-named exports as aliases for one release, or break them?
8. **Deprecation timeline.** When does the `vmrun` selector alias
   disappear? Default: deprecated in v0.5, removed in v0.7.

## Milestone 0 (DESIGN GATE — ship before any merge code)

Produce `docs/design/vmware-backend-convergence.md`. Operator
reviews before any merge code lands. Mirror the structure of
`docs/design/per-user-identity-certs.md`:

- **Status** — `design proposal`, dated.
- **Context** — the parallel-track history (v0.4.0-4 commit), the
  two backends today, what the operator explicitly committed in the
  vmrun.ts §"Locked design" comment.
- **Locked design** — module name (Q1), canonical selector key (Q2),
  govc disposition (Q3), credential argv policy (Q4), error
  taxonomy (Q5), migration story (Q6), public exports (Q7),
  deprecation timeline (Q8). Once approved, not re-litigated.
- **Conformance matrix** — every method on `HypervisorBackend` ×
  (vmware.ts behavior, vmrun.ts behavior, converged target). Use
  this to drive Milestone 2's parity test.
- **Test taxonomy** — unit / integration / system / parity.
- **Definition of Done.**

**Commit:** `docs(v0.5-vmware-convergence): design doc + open questions`

**Operator gate.** Post the doc with `## Decisions required`. Wait
for explicit answers. Lock them into §Locked design. Then proceed.

## Milestones — v0.5.0 ship

### Milestone 1: Parity test suite (BEFORE the merge)

This is the heart of the work. Without it, the merge will silently
break behavior.

- New test file `host/src/__tests__/vmware-parity.test.ts`. For each
  method on `HypervisorBackend`:
  - Generate a representative input.
  - Run it against vmware.ts and against vmrun.ts (both with
    injected execs returning canned outputs).
  - Assert: same argv composition where the wrapped CLI is the same
    (`vmrun start ...` etc.), same VMHandle / VMStatus shape on the
    way out, same error class + code on canned failure inputs.
- Where behaviors *legitimately* differ (vmware.ts has govc paths,
  vmrun.ts has stable error codes), the parity test documents the
  divergence in a `## Documented divergences` markdown block at the
  top of the file. Each divergence has a §"Resolution" note from the
  design doc.
- The parity suite must be **green against the unmerged two
  backends** as the baseline. After the merge, it stays green against
  the single converged backend.

**Commit:** `test(v0.5-vmware-convergence): parity suite for vmware vs vmrun`

### Milestone 2: Converged backend module

- New / renamed module per Q1: either edit `vmware.ts` in place or
  rename to `vmware-fusion.ts` (per design-doc decision).
- Adopt vmrun.ts's structured shape: injectable exec, stable error
  codes (per Q5 outcome), structured options. Lift the govc
  fallback from vmware.ts into a private sub-module / sub-method
  (per Q3 outcome).
- Credential argv hygiene per Q4 outcome.
- The Milestone-1 parity suite passes against the converged module.
- The old module-specific tests still pass (no regressions in
  vmware.test.ts or vmrun-backend.test.ts behavior expectations).

**Commit:** `feat(v0.5-vmware-convergence): merge vmware + vmrun into single backend`

### Milestone 3: Selector + config-load deprecation handling

- `host/src/hypervisors/selector.ts` registers only the converged
  backend; the alias key (per Q2) routes to the same instance with
  a deprecation log on resolution.
- `host/src/config.ts` (or wherever the config loader lives) accepts
  the alias and logs the deprecation warning, per Q6 outcome.
- Tests: argv path through selector for both `hypervisor.backend =
  "vmware"` and `"vmrun"`; deprecation-log assertion (capture stderr
  or log-spy).

**Commit:** `feat(v0.5-vmware-convergence): selector alias + deprecation log`

### Milestone 4: Cleanup + audit closure

- Delete the legacy module (vmware.ts or vmrun.ts depending on Q1).
- Move / consolidate tests: parity suite stays; the legacy test
  files get folded into one (`host/src/__tests__/vmware-backend.test.ts`).
- Update `docs/mac-virtualization.md` §Option C: VMware Fusion to
  reflect the converged surface (one backend, not two).
- Update `docs/STATUS.md` backend matrix.
- Update `docs/design/vmware-backend-convergence.md` — flip §Status
  to "shipped in v0.5.0"; record operator-approved deviations.
- 4-lens audit in `.workstream-status.md`. **Security lens** must
  cover: credential argv hygiene before and after, any new attack
  surface from the merge (recommend none — refactor, not new code).

**Commit:** `docs(v0.5-vmware-convergence): delete legacy + mac-virtualization + design closure`

## Test taxonomy

| Layer | Examples |
|---|---|
| **Unit** | Argv composition for every `vmrun *` invocation; argv composition for govc paths; error-code mapping; credential redaction in logs |
| **Parity (Milestone 1 — new layer)** | Method-by-method behavior equivalence between vmware.ts, vmrun.ts, and the converged module |
| **Integration** | Backend through `signalman vm *` CLI; selector deprecation log |
| **System (gated)** | Real vmrun against a real VM on a Windows or Mac dev-host with VMware Workstation/Fusion installed. Lane: `SIGNALMAN_VMWARE_TESTS=1` |
| **Smoke** | Backend exports unchanged for consumers; tsc clean |

Coverage gate: ≥80% lines / ≥70% branches across the converged
backend. The parity suite is part of the unit lane.

## Reserved blocks

- No new migrations.
- **Error-code namespace**: the converged `VmwareBackendError` (or
  whatever Q5 names it) supersedes `VmrunBackendError`. If Q7
  decides to keep the old names as aliases, the alias names are
  reserved.
- **No new MCP tool names** — the existing tools are backend-agnostic.

## Definition of Done

1. `cd host && npm test` — full suite green
2. `cd host && npx tsc --noEmit` — zero errors
3. `cd host && npm run coverage` — coverage holds per gate
4. **Parity suite** — green against the converged backend
5. **No-op for the operator** — a config that worked before WS11
   (with `hypervisor.backend = "vmware"` or `"vmrun"`) still works
   after, with at most a deprecation log line on the alias
6. **System lane (gated, optional)** — on a real VMware host,
   `signalman vm provision` → `vm start` → `vm exec` → `vm stop`
   all succeed. Record in `.workstream-status.md` if executed
7. **4-lens audit completed**, Security lens specifically PASS
8. Commits ready (Co-Authored-By: Claude Opus 4.7 (1M context)
   `<noreply@anthropic.com>`) but **NOT pushed**

## Commit pattern

- Milestone 0: design doc — 1 commit (gate)
- Milestone 1: parity suite — 1 commit
- Milestone 2: converged backend — 1 commit
- Milestone 3: selector alias + deprecation — 1 commit
- Milestone 4: cleanup + docs — 1 commit
- Subject format: `feat(v0.5-vmware-convergence): <what>`,
  `test(v0.5-vmware-convergence): <what>`, or
  `docs(v0.5-vmware-convergence): <what>`
- No internal-product names in commit messages.

## Status report (when complete)

`.workstream-status.md` with sections:

- `## Commits` (5 expected)
- `## Open questions resolved`
- `## Tests added` per layer
- `## Coverage` deltas
- `## Parity divergences resolved` — list of every divergence
  identified in Milestone 1 and how the converged backend resolves
  each one
- `## 4-lens audit` — Security lens PASS or concern
- `## Manual end-to-end test log` — if the system lane was exercised
- `## Deferred to v0.6+` (with rationale)
- `## Operator review needed`

Then return a ≤300 word summary.

## Conventions

- TypeScript strict; no `any` without justifying comment.
- No emojis in source or docs.
- The S-14 credential-on-argv warning **must remain** in JSDoc on
  the converged backend; never silently drop a documented risk
  during a refactor.
- Don't push to origin without operator approval.
- **Scope discipline.** WS11 is a refactor with a parity guarantee.
  It is NOT the place to add new VMware features (no VM creation,
  no new snapshot semantics, no vSphere extras). Surface those as
  v0.6+ items.

## Parallel work to be aware of

- **WS7 (Claude Code plugin)** — no overlap.
- **WS8 (identity certs)** — no overlap.
- **WS9 (signing service)** — no overlap.
- **WS10 (macOS UI parity)** — adjacent. WS10 touches
  `guest/src/ui_macos/`; WS11 touches `host/src/hypervisors/`. No
  file overlap. Both ship in the v0.5 cohort.
- **WS12 (OSS-release-readiness)** — no overlap.

WS11 touches: `host/src/hypervisors/vmware.ts` (refactor or delete),
`host/src/hypervisors/vmrun.ts` (delete or absorb),
`host/src/hypervisors/selector.ts` (alias wiring),
`host/src/config.ts` (deprecation log),
`host/src/__tests__/vmware-*.test.ts` + `vmrun-*.test.ts`
(consolidate), `host/src/__tests__/vmware-parity.test.ts` (new),
`docs/mac-virtualization.md`, `docs/STATUS.md`,
`docs/design/vmware-backend-convergence.md` (new).

If you find yourself touching anything outside that list, stop and
surface to the operator.

Start by reading both backend modules end to end, write the design
doc, post the 8 open questions, then begin Milestone 1 (parity
suite — before the merge).
