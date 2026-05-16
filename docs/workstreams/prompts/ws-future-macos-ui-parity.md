# [DEFERRED] macOS UI automation parity — awaiting Mac dev-host

**Status:** scoped 2026-05-16; deferred from the WS9–WS12 cohort because the operator does not currently have an Apple Silicon dev-host. The original WS10 slot was reassigned to the OCI distribution-spec workstream (`ws10-registry-oci.md`). This file is preserved verbatim so the work can be picked up unchanged whenever Mac hardware is available — at that point, renumber to the next free WS slot (likely WS13+) and update `ROADMAP.md` + `docs/workstreams/README.md`.

The branch name `feat/v0.5-macos-ui-parity` and the file/path references below remain accurate. The "WS10" labels in this file are stale; mentally substitute the slot number assigned at pickup time.

---

Paste the block below into a fresh Claude Code session that has shell + write access to `C:\Users\ucale\source\repos\signalman`. Runs directly on `main` with a feature branch (`feat/v0.5-macos-ui-parity`), not a separate worktree — the parallel-worktree pattern was retired after Wave-B + Wave-3 merged (see the 2026-05-15 cleanup notes).

**Mac dev-host strongly preferred.** Lands AppleScript + AX driver code that can only be exercised end-to-end on Apple Silicon hardware. If you only have access to a Windows or Linux dev host, the design doc and the Rust-side unit tests can still ship from there, but Milestones 3-5 require a Mac dev-host hand-off.

---

You are working on Signalman, an agent-first DevOps platform with an
open-core split: `signalman` (Apache-2.0 OSS) + `signalman-cloud`
(proprietary commercial). Host is TypeScript (`host/`); guest agent
is Rust (`guest/`); the privileged Windows daemon is Rust
(`service/`). Main carries v0.4.0 through 2026-05-15: cross-platform
guest agent (Windows / Linux / macOS), Tart backend, libvirt
backend, vmrun parallel backend, registry virtual-upstream
mirroring.

**Your branch:** `feat/v0.5-macos-ui-parity` off `main`. Cut it from
the repo root. All git ops from that root. **Do NOT push to origin**
until the operator approves the first milestone.

## What WS10 is

The Windows guest agent has a feature-rich UI-automation sidecar in
[`guest/src/ui_sidecar.rs`](../../../guest/src/ui_sidecar.rs) (3.5kloc).
It exposes:

- A `UiAutomationEngine` enum (PowerShell process, PowerShell helper,
  native UIA backend) with runtime selection
- A `UiAutomationBackend` trait covering `findElement`, `click`,
  `setValue`, `getProperty`, `getChildren`, `sendKeys`, focus, etc.
- A UIA-selector grammar (`[name='Save']`, `[automationId='btn1']`,
  `[class='Button']`) consumed by `host/src/tools/vm-ui.ts` MCP tools
- Event subscription with a 500 ms native fallback poll

On macOS, the guest agent's `Platform::Macos` impl (`guest/src/platform/macos.rs`)
covers file ops, command execution, network probes, and health, but
the UI-automation surface returns `Status::unimplemented`. WS4
explicitly deferred UI automation to a follow-up — that follow-up
is WS10.

The goal is **parity at the MCP surface**: a scenario that runs
`signalman_vm_ui_*` tools against a Windows VM should run unchanged
(modulo selector syntax) against a macOS VM. The implementation path
recommended in `docs/mac-virtualization.md` §Recommendation is a
two-driver pair:

1. **`AppleScriptDriver`** — System Events scripting for app-level
   actions (focus, menu invocation, keystrokes). Lower fidelity but
   no entitlement gate.
2. **`AXUIElementDriver`** — Accessibility API direct element
   manipulation. Higher fidelity (element tree, property reads,
   precise click coordinates) but requires the Accessibility TCC
   grant.

The two drivers cooperate: AX is preferred when available; the
sidecar falls back to AppleScript when AX is not trusted or the
element tree doesn't expose the target.

## Orientation reading (in order, before any code)

1. **`docs/mac-virtualization.md`** — read all of it. §Guest Agent
   Permissions and §Recommendation are the controlling text.
2. **`guest/src/ui_sidecar.rs`** — the Windows reference shape. Read:
   - The `UiAutomationEngine` enum + dispatch
   - The `UiAutomationBackend` trait (you implement two macOS impls
     of this trait, or a sibling trait if the contracts diverge)
   - The selector-grammar parser
   - The event-subscription path
3. **`host/src/tools/vm-ui.ts`** — the MCP surface. The selector
   strings flow through here; whatever shape you keep must round-trip
   from MCP → guest gRPC → driver.
4. **`guest/src/platform/macos.rs`** — current macOS platform impl.
   Your new modules live alongside, gated behind `#[cfg(target_os
   = "macos")]`.
5. **`scripts/macos/install-guest-agent.sh`** — current installer.
   You'll extend it (or add a sibling `install-ui-agent.sh`) to put
   the UI driver into the **LaunchAgent**-in-user-session slot, NOT
   the existing LaunchDaemon slot.
6. **`docs/bootstrap.md` §6** — current Mac host bootstrap.
7. `CLAUDE.md` at repo root — Loom protocol + selvedge guardrails.

## Open product questions — resolve in the first hour

Surface these to the operator before writing any code. Use
`AskUserQuestion` to batch them. If an answer is non-default,
update `docs/design/macos-ui-automation.md` (which Milestone 0
creates) to match.

1. **Driver selection policy.** Default: prefer AX, fall back to
   AppleScript. Alternative: explicit per-call driver selection via
   a new selector prefix (`[ax:name='Save']` vs `[as:name='Save']`).
2. **TCC grant flow.** First-run prompt only, or also document an
   MDM PPPC profile shape for fleet deployments?
3. **Screen Recording grant.** Required at all (for screenshot-based
   element-not-found diagnostics), or skip until a scenario actually
   needs it?
4. **Selector grammar.** Reuse the Windows UIA grammar verbatim, or
   add macOS-specific selectors like `[role='AXButton']`
   `[subrole='AXCloseButton']`?
5. **Event subscription.** Is the macOS sidecar required to support
   the same event-subscribe API as Windows in v0.5.0, or can it
   ship polling-only and add events in v0.6?
6. **UI worker process model.** A single LaunchAgent that runs all
   UI ops, or one helper per logged-in user (matters for multi-user
   Mac CI hosts)?
7. **Test infrastructure.** Where do macOS UI tests run? CI lane
   on a self-hosted Apple Silicon runner, gated lane like the
   existing cloud-integration tests, or "operator-led manual only"
   for v0.5.0?
8. **Selector coordinate fallback.** When the AX tree doesn't
   expose a target, fall back to coordinate-based AppleScript
   (`tell application "System Events" to click at {x, y}`)? If yes,
   how are coordinates discovered — operator-supplied, or
   pixel-grep via Screen Recording?

## Milestone 0 (DESIGN GATE — ship before any driver code)

Produce `docs/design/macos-ui-automation.md`. Operator reviews this
before any production code lands. Mirror the structure of
`docs/design/per-user-identity-certs.md`:

- **Status** — `design proposal`, dated.
- **Context** — Windows UIA reference, macOS gap, parity goal.
- **Locked design** — driver selection, selector grammar, TCC flow,
  worker process model, event-subscription model. Once approved,
  not re-litigated.
- **Open product questions** — the 8 above.
- **Test taxonomy** — unit / integration / system layers.
- **Definition of Done** — explicit.

**Commit:** `docs(v0.5-macos-ui-parity): design doc + open questions`

**Operator gate.** Post the design doc to the operator with a
`## Decisions required` section. Wait for explicit answers. Lock
them into §Locked design. Then proceed.

## Milestones — v0.5.0 ship (after design gate clears)

### Milestone 1: Selector parser + driver trait (compiles on all platforms)

- New module `guest/src/ui_macos/` (or `guest/src/platform/macos/ui/`
  depending on directory convention chosen in design).
- Selector parser that accepts both the Windows UIA grammar and any
  macOS-specific selectors agreed in Q4. Returns a typed
  `MacosSelector` enum.
- `MacosUiBackend` trait — same shape as `UiAutomationBackend` where
  possible; document any contract divergence.
- Skeleton impls of `AppleScriptDriver` and `AXUIElementDriver` that
  return `Status::unimplemented` for all methods.
- Wiring: `Platform::Macos` exposes a `ui_backend()` accessor that
  returns the configured driver (default: composite "prefer AX,
  fall back to AppleScript").
- **All code gated behind `#[cfg(target_os = "macos")]`** — Linux /
  Windows builds must not pull AppleScript / AX deps.
- Tests (Rust): unit tests for the selector parser; trait-object
  dispatch via fakes; no real AppleScript / AX calls yet.

**Commit:** `feat(v0.5-macos-ui-parity): selector parser + driver trait skeleton`

### Milestone 2: AppleScriptDriver (unentitled path)

- Implement `findElement`, `click`, `sendKeys`, `focus` via
  `osascript` subprocess. The driver shells out to AppleScript
  snippets it generates from `MacosSelector`.
- Robust error mapping: AppleScript error codes → Signalman
  `UiAutomationError` codes. The Windows sidecar's error taxonomy
  is the reference.
- Subprocess hardening: per-call timeout, output capture, no shell
  injection (use `osascript -e` with argv, not a composed string).
- Tests:
  - **Unit:** error-code mapping, argv composition, timeout
    enforcement (Rust + a fake osascript binary).
  - **Integration (Mac dev-host only):** drive a real macOS app
    (TextEdit is the reference target) — open, type, save, close.
    Lane-gate behind `SIGNALMAN_MACOS_UI_TESTS=1`.

**Commit:** `feat(v0.5-macos-ui-parity): AppleScriptDriver via osascript`

### Milestone 3: AXUIElementDriver (entitled path)

- Implement the same operations via the Accessibility API. The
  Rust path uses `objc2` / `objc2-foundation` (or the operator's
  preferred crate stack — confirm in Milestone 0 design doc).
- Trust check on startup: `AXIsProcessTrustedWithOptions` with
  `kAXTrustedCheckOptionPrompt = false`. If untrusted, the driver
  logs a clear setup-needed error and the composite driver falls
  through to AppleScript.
- Element-tree walker with the `MacosSelector` predicate.
- Property reads (role, subrole, title, value, enabled).
- Per-call timeout via run-loop scheduling (AX is synchronous; the
  composite driver wraps it).
- Tests:
  - **Unit:** selector predicate evaluation against a fake AX tree.
  - **Integration (Mac dev-host only):** drive TextEdit via AX;
    compare with AppleScript outputs for behavioral parity.

**Commit:** `feat(v0.5-macos-ui-parity): AXUIElementDriver`

### Milestone 4: Sidecar wiring + MCP surface

- Wire `Platform::Macos::ui_backend()` into the gRPC handler that
  today returns `Status::unimplemented`. The composite driver is
  the default; `SIGNALMAN_MACOS_UI_DRIVER={ax,applescript,composite}`
  forces a specific driver for tests.
- No changes to `host/src/tools/vm-ui.ts` — the MCP surface is
  already platform-agnostic. The integration test that runs an MCP
  call end-to-end on macOS proves this.
- **Installer extension.** Add `scripts/macos/install-ui-agent.sh`
  (or extend the existing installer) to drop a LaunchAgent (NOT a
  LaunchDaemon) into the logged-in user session. The agent is
  separate from the file/command LaunchDaemon — the LaunchDaemon
  cannot do UI automation (it lives outside any user's Aqua session).
- Tests:
  - **System (Mac dev-host only):** end-to-end `signalman_vm_ui_*`
    MCP call → host gRPC → guest → AX/AppleScript → real action.

**Commit:** `feat(v0.5-macos-ui-parity): sidecar wiring + LaunchAgent installer`

### Milestone 5: Doc + audit closure

- Update `docs/mac-virtualization.md`:
  - §Recommendation v0.3.x-v0.4.x note flips to "shipped in v0.5.0";
    cross-link the design doc.
  - §Guest Agent Permissions §UI automation gains the operator
    setup walkthrough (TCC grants, MDM PPPC shape if Q2 lands there).
- Update `docs/bootstrap.md` §6 with the new installer step.
- Update `docs/design/macos-ui-automation.md` — flip §Status to
  "shipped in v0.5.0"; record any operator-approved deviations.
- 4-lens audit in `.workstream-status.md`. **Security lens** must
  cover: TCC permission scope, subprocess argv hygiene, LaunchAgent
  vs LaunchDaemon isolation, event-injection capability bounds.

**Commit:** `docs(v0.5-macos-ui-parity): mac-virtualization + bootstrap + design closure`

## Test taxonomy

| Layer | Where it runs | Examples |
|---|---|---|
| **Unit (Rust)** | Any host | Selector parser; AppleScript argv composition; AX selector predicate; error mapping |
| **Integration (Rust)** | Mac dev-host (`SIGNALMAN_MACOS_UI_TESTS=1`) | osascript invocation against TextEdit; AX walker against real Finder window |
| **System (TS + Rust)** | Mac dev-host | MCP `signalman_vm_ui_click` end-to-end against a Tart VM |
| **Smoke** | Any host | Cross-platform build still passes; non-macOS targets continue returning `Status::unimplemented` correctly |

Coverage gate: ≥80% lines / ≥70% branches across the new Rust code.
The Mac-gated integration / system tests are not part of the unit
coverage denominator (same pattern as the cloud-integration lane).

## Reserved blocks

- No new migrations (UI automation is stateless on the guest side).
- **Error-code namespace**: `MacosUiError` is reserved for WS10.
- **No new MCP tool names** — the existing `signalman_vm_ui_*`
  tools route to whichever platform the target VM runs.

## Definition of Done

1. `cargo build --target aarch64-apple-darwin --all-features` —
   clean (delegated to Mac dev-host CI lane if no Mac available).
2. `cargo test --workspace` — zero failures on non-Mac hosts (the
   Mac-gated tests are skipped via cfg).
3. `cd host && npm test && npx tsc --noEmit` — zero errors.
4. `SIGNALMAN_MACOS_UI_TESTS=1 cargo test --target aarch64-apple-darwin
   -p signalman-guest` — green on the Mac dev-host.
5. **Operator-led end-to-end test** on a Mac dev-host: provision a
   Tart VM with the v0.5 installer, grant TCC, run a multi-step UI
   scenario (open TextEdit, type, save, close). Record in
   `.workstream-status.md`.
6. **4-lens audit completed**, Security lens specifically PASS.
7. Commits ready (Co-Authored-By: Claude Opus 4.7 (1M context)
   `<noreply@anthropic.com>`) but **NOT pushed**.

## Commit pattern

- Milestone 0: design doc — 1 commit (gate)
- Milestone 1: selector + driver skeleton — 1 commit
- Milestone 2: AppleScript driver — 1 commit
- Milestone 3: AX driver — 1 commit
- Milestone 4: wiring + installer — 1 commit
- Milestone 5: docs — 1 commit
- Subject format: `feat(v0.5-macos-ui-parity): <what>` or
  `docs(v0.5-macos-ui-parity): <what>`
- No internal-product names in commit messages.

## Status report (when complete)

`.workstream-status.md` with sections:

- `## Commits` (6 expected)
- `## Open questions resolved`
- `## Tests added` per layer
- `## Coverage` deltas (non-Mac-gated)
- `## 4-lens audit` — Security lens PASS or concern
- `## Manual end-to-end test log` — Mac dev-host outcomes
- `## Deferred to v0.6+` (with rationale)
- `## Operator review needed`

Then return a ≤300 word summary.

## Conventions

- Rust: every `unsafe` block (likely needed for AX / objc2 bridging)
  gets an explicit safety comment naming the foreign contract.
- No emojis in source or docs.
- All macOS-specific code paths behind `#[cfg(target_os = "macos")]`.
- The LaunchDaemon (root, no UI) and LaunchAgent (user session, UI)
  are **separate** — do not unify them. Document the isolation.
- Don't push to origin without operator approval.

## Parallel work to be aware of

- **WS7 (Claude Code plugin)** — no overlap.
- **WS8 (identity certs)** — no overlap; WS10 inherits the v0.5
  mTLS shape from WS8 if WS8 merges first.
- **WS9 (signing service)** — no overlap.
- **WS11 (vmrun ↔ VMware convergence)** — adjacent. WS11 touches
  `host/src/hypervisors/{vmware,vmrun}.ts`; WS10 touches
  `guest/src/ui_macos/` + `scripts/macos/`. No file overlap.
- **WS12 (OSS-release-readiness)** — no overlap.

WS10 touches: `guest/src/ui_macos/` (new), `guest/src/platform/macos.rs`
(wire up), the gRPC handler that today returns
`Status::unimplemented` for UI ops, `scripts/macos/` (installer),
`docs/mac-virtualization.md`, `docs/bootstrap.md`,
`docs/design/macos-ui-automation.md` (new).

If you find yourself touching anything outside that list, stop and
surface to the operator.

Start by reading `docs/mac-virtualization.md` and `guest/src/ui_sidecar.rs`
end to end, write the design doc, post the 8 open questions, then
begin Milestone 1.
