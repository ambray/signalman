# Signalman — Status & Resume Context

> Last updated: 2026-05-12. Living document — update on every commit
> that changes scope, ships a feature, closes an audit finding, or
> introduces a new TODO bucket. See [Document maintenance](#document-maintenance)
> for the trigger rules.

## Public-release prep landed on main — 2026-05-12

The public-release prep work merged. `main` is at `a7cc8e8` and is
in sync with `origin/main`. Net effect: 15 commits from a clean
v0.1.x baseline (`2a2cdb0`) to a public-flip-ready state.

What landed (oldest first):

- `3d1d0c2` v0.2.0 — local in-process control plane (storage, schema,
  build executor, deploy/rollback, health probes)
- `d209a0a` v0.3.0a — HTTP control plane + Bearer-token auth (`signalman
  serve`, `host/src/http/`)
- `360b28f` v0.3.0a — job substrate + runner CLI (`host/src/runner/`,
  jobs table, atomic claim)
- `06af83a` v0.3.0b — remote `release.build` executor
- `e00503a` v0.3.0c — Postgres `StorageDriver` (`pg`, same migrations)
- `1549a9e` v0.3.0d — Ed25519 manifest signing + `release verify`
- `6979976` v0.3.0e — S3 `BlobDriver` + `resolveBySha`
- `618f353` security + docs: pre-public-release readiness pass — F1–F5
- `93c4bee` license: align manifests to Apache-2.0
- `4a58e4c` NOTICE file + LICENSE appendix copyright correction
- `38298a7` scrub: remove product-specific references for public release
- `300ec02` OSS-readiness hygiene + workflows fix (SECURITY.md,
  CONTRIBUTING.md, issue + PR templates, .gitignore, Node 20→22)
- `a6222e6` README accuracy + STATUS refresh + npm metadata + CHANGELOG
- `5f3b648` README: drop hosted-commercial scope references
- `a7cc8e8` open-core split — extract `hub/` + commercial scope to
  signalman-cloud

CODE_OF_CONDUCT.md is intentionally deferred (operator decision);
GitHub's community-profile checklist will show one missing item.

## Cross-repo: open-core split — 2026-05-12

Signalman is now open-core. Three product lines (see
[signalman-cloud/docs/design.md](../../signalman-cloud/docs/design.md) §D6):

| Product | Repo | License | Distribution |
| --- | --- | --- | --- |
| `signalman` | [github.com/ambray/signalman](https://github.com/ambray/signalman) | Apache-2.0 | npm + crates.io + MSI |
| `signalman-cloud` | [github.com/ambray/signalman-cloud](https://github.com/ambray/signalman-cloud) (not pushed yet) | Proprietary | Hosted SaaS |
| `signalman-enterprise` | Future build-flag on signalman-cloud; may extract later | Proprietary | On-prem installer |

What moved out of this repo (now in `signalman-cloud/`):

- `hub/` directory (was 122 LOC of TODO stubs; type definitions ported,
  stub methods dropped).
- The `v0.4.0 — hosted commercial` section of
  `docs/design/meta-build-system.md`.
- The "Hosted (v0.4+)" row of the three-deployment-shapes table.
- Forward-looking hub-related ROADMAP entries.

`signalman-cloud` carries its own design + roadmap including the six
2026-05-12 decisions on database topology, runner pool, API surface,
billing model, trial path, and on-prem enterprise. See its
`docs/design.md` and `ROADMAP.md`.

The OSS↔Cloud boundary is the npm public exports of `@signalman/host`.
Cloud is a one-way consumer of the OSS package; the OSS code has no
knowledge of Cloud. This contract is the central organising principle
of the split.

## Public-release status

Open items before flipping the OSS repo public:

1. **Git history rewrite to scrub Example from past commits** —
   parked at the operator's request. The working tree (and every
   commit from `38298a7` onward) is clean, but `git log -S "example"
   --all` still surfaces the original text in older commits,
   including the 14 moved scenarios.
2. **Version-pin bump strategy** — every manifest still reads
   `0.1.0`. Decide whether the meta-build work tags as v0.3.0
   (carries v0.2 + v0.3 in one bump) or whether v0.2.0 ships
   separately first.
3. **Visibility flip** — repo is still private on GitHub. Operator
   action, blocked on (1) and (2).
4. **Push `signalman-cloud` to its remote** — `signalman-cloud` has
   one commit locally; remote is configured at
   `github.com/ambray/signalman-cloud.git` but not pushed. Operator
   action when the GitHub-side repo is ready.

## TL;DR (one-paragraph)

`main` carries the v0.1.1 surface: the secure scenario runner from
v0.1.0 (six MCP verbs, Loom-fronted plugin, mTLS guest agent, signed-MSI
release pipeline) plus the P9 provisioning + bootstrap stack that closes
the onboarding gap (`signalman vm provision` / `vm fetch-template` /
`vm install-bundle` / `vm cleanup`, `signalman init`, software-bundle
schema, idempotency contract, `docs/bootstrap.md`) and the first
interactive user-session UI sidecar (`signalman-guest --ui-sidecar`) with
MCP tools for screenshots, UIA snapshot/find/wait, click, keyboard input,
and type, plus `vm_ui_open_url` / `vm_ui_navigate_url` browser primitives for
launching and navigating `http(s)` flows through the interactive desktop.
Browser navigation now discovers likely address/search targets from UIA
metadata, falls back to the current Edge address-bar selectors when a
discovered target goes stale, and reports the target/fallback metadata to
recordings and LLM-driven workflows. The native sidecar engine now covers
screenshot, find, click, type, key operations, wait timeouts, UIA
Value-pattern descriptors, and the first loopback-only CDP implementation
behind the reserved Browser* RPCs. It is covered
by the live `Win11_test` `live-ui-sidecar-smoke`, `live-ui-browser-smoke`,
and `live-browser-cdp-smoke.ps1` checks. Versions in every
manifest read `0.1.0` and need to bump to `0.1.1` together with a tag push to
ship — the release workflow validates the manifest version matches the tag
before publishing. The four GitHub repo secrets
(`WINDOWS_CERT_BASE64`, `WINDOWS_CERT_PASSWORD`, `NPM_TOKEN`,
`CARGO_REGISTRY_TOKEN`) are the only operator setup remaining; without
them the workflow still produces but does not publish artifacts.
Monday-morning operator action: run `pwsh scripts/release-dry-run.ps1`,
bump the four version pins, `git tag v0.1.1 && git push origin v0.1.1`.

## Versions

| Component | Path | Current version |
|---|---|---|
| Host (npm) | `host/package.json` | `0.1.0` |
| Guest (cargo) | `guest/Cargo.toml` | `0.1.0` |
| Workspace (cargo) | `Cargo.toml` (`workspace.package.version`) | `0.1.0` |
| Service (cargo) | `service/Cargo.toml` (`version.workspace = true`) | `0.1.0` (inherits workspace) |
| Loom plugin | `plugins/signalman-loom-plugin/Cargo.toml` | `0.1.0` |
| Proto contract — guest | `proto/guest.proto` | `signalman.guest` package, **v1 frozen** (P8 / commit `c9e8e30`) with `oneof platform_details` |
| Proto contract — service | `service/proto/signalman_service.proto` | `signalman.service.v1.ControlPlane` |

> The version skew between manifests-on-`main` (`0.1.0`) and the *intended*
> v0.1.1 release tag is the deliberate state — every P9 commit landed
> against the unbumped manifest. Bump all four pins (`host/package.json`,
> `guest/Cargo.toml`, root `Cargo.toml`, `plugins/signalman-loom-plugin/Cargo.toml`)
> in the same commit that creates the `v0.1.1` tag.

## Latest commits (top 10)

```
a350af8 Add UI observation roles and labels
f1b5cea Use UIA events for native waits
790790d Expand native UI key tokens
ff5df3e Expose UI action targets
6f733f7 Support array includes assertions
b9c63db Add UI descriptor action hints
1c2f56d Consolidate native UIA lookup helpers
faf7d6c Prefer native UI invoke clicks
f5261f4 Honor UI action timeouts
5ddcda5 Expand native UI key modifiers
```

## Audit closure (security findings)

Local update: `3354ded` closes B13, C3, C4, and F3, and also folds in the
service-first Hyper-V audit closure, event-driven service heartbeat,
guest-MSI release discovery, and bundle DAG dependency resolver.

The audit numbering uses two parallel namespaces: `Bn` is the ROADMAP
sub-bullet identifier; `Sec Fn` is the security-finding identifier from
the 2026-04-25 four-lens audit. Both refer to the same underlying gap.

| ID | Severity | What | Status | Closing commit |
|---|---|---|---|---|
| B1 / Sec F2 | Critical | Cert dir ACL hardening at install time (`%ProgramData%\Signalman\certs\`) | Closed | `ea6852c` (P4.b) |
| B2 / Sec F1 | Critical | Client-cert SHA-256 pinning on guest agent (closes "any cert from this CA grants SYSTEM") | Closed | `6608c06` (P4.c B2) |
| B3 / Sec F3 | High | `--allow-insecure` loopback enforcement (refuse non-loopback bind) | Closed | `ca804ae` (P4.a) |
| B4 / Sec F4 | High | `process_start` denylist + metachar parity with `run_command` | Closed | `ca804ae` (P4.a) |
| B5 / Sec F5 | High | Drop `cmd.exe /C` from `run_command` SYSTEM path; pass argv via `CreateProcessAsUserW` | Closed | `92a9030` (P4.c B5) |
| B6 / Sec F6 | High | Named-pipe `SECURITY_DESCRIPTOR` (SDDL) — pipe ACL hardening | Closed | `53fe483` (P4.c B6) |
| B7 / Sec F7 | Medium | Constant-time bearer-token compare | Closed | `ca804ae` (P4.a) |
| B8 / Sec F8 | Medium | Pin TLS min-version (TLS 1.3) explicitly | Closed | `b426756` (P4.c B8) |
| B9 / Sec F9 | Medium | `is_denied_command` case-insensitive + tripwire-not-boundary doc | Closed | `7a07a87` (P4.c B9) |
| B10 / Sec F10 | Medium | `file_ops.rs` path checks: case-insensitive, prefix-canonical | Closed | `119d117` (P4.c B10) |
| B11 / Sec F11 | Medium | Strip credentials from `AUDIT: run_command` logs | Closed | `119d117` (P4.c B11) |
| B12 / Sec F15 | Medium | Pin GitHub Actions by SHA, not tag | Closed | `b426756` (P6-A3-A6 + B12) |
| B13 / Sec F14 | Medium | Document `protoc-bin-vendored` supply-chain stance or replace | Closed | `3354ded` |
| C3 | High | Capability declaration enforcement (scenario `capabilities:` block actually gates execution) | Closed | `3354ded` |
| C4 | High | `${secret:NAME}` resolution from host-side keychain or env (parses today, doesn't resolve) | Closed | `3354ded` |
| F3 (P4.4) | Medium | Cert rotation lifecycle (initial gen lands; rotation does not) | Closed | `3354ded` |

The v0.1.x security carry-over is closed in `3354ded`.

## Test coverage map

Counts taken from source (`#[test]` / `#[tokio::test]` attributes for
Rust; `it(...)` and `test(...)` invocations for vitest). Vitest run-time
counts are higher than the source count because parameterized blocks
expand at runtime — see `docs/testing.md` for the variance discussion.

| Crate / package | Test count (source) | Files | Last verified |
|---|---|---|---|
| Host (TypeScript / vitest) — `host/src/__tests__/` | 1048 | 46 | 2026-05-09 |
| Host (TypeScript / vitest) — `host/src/verbs/__tests__/` | 46 | 5 | 2026-05-09 |
| Guest (Rust / cargo) | 132 | 9 | 2026-05-09 |
| Service (Rust / cargo) | 110 | 8 (incl. 2 integration files) | 2026-05-09 |
| Plugin (Rust / cargo) | 135 | 11 (incl. 2 integration files) | 2026-05-09 |
| **Total** | **1471** test attributes / `it()` calls | **79** files | |

> The ROADMAP headline "151 Rust + 769 TS = 920" predates the v0.1.1
> P9 work and the user-session UI/browser milestones. `docs/testing.md`
> now quotes 1094 TypeScript / 377 Rust source-level cases; vitest
> expands parameterized blocks to 1148 run-time tests
> in the current host coverage run.

### Canonical test files (what each one pins)

- **`host/src/__tests__/sanitize.test.ts`** (59 cases) — every input
  validator in `host/src/sanitize.ts` (VM names, labels, paths, commands,
  PowerShell args, URLs, timeouts).
- **`host/src/__tests__/envelope.test.ts`** — result-envelope shape
  and scenario-hash determinism.
- **`host/src/__tests__/orchestrator.test.ts`** + **`orchestrator-events.test.ts`** —
  orchestrator + mocked hypervisor backend; live-emit propagation
  hook (closes P3 C2-residual) and parallel guest-agent readiness waits
  (closes P2 F1). It also pins the C7 teardown guard that runs declared
  teardown after guest-readiness failures, plus the manifest-owned
  provisioning orphan reaper and its dry-run-first MCP tool. It also
  covers the process-exit kd cleanup hook.
- **`host/src/__tests__/proto-shape.test.ts`** — pins the v1 proto
  `oneof platform_details` shape so a stray rebuild can't silently
  change the wire contract.
- **`host/src/__tests__/proto-contract.test.ts`** — proto v1 contract
  (P7 D1) at the source level.
- **`host/src/__tests__/scenario-validation.test.ts`** — walks every
  scenario in `.signalman/scenarios/` and `examples/`, schema-validates.
- **`host/src/__tests__/workflow-api.test.ts`** (20 cases, landed in
  `89b0d1f`) — pins scenario-action → backend/guest-client routing for
  `vm_checkpoint`, `vm_restore`, `vm_copy_file`, `vm_install`, plus an
  E2E chain. P7 D2-prep deliverable.
- **`host/src/__tests__/provisioning-idempotency.test.ts`** (9 cases,
  landed in `50807f6`) — cross-cutting × 3 invocation tests for every
  provisioning verb. Closes P9.4.
- **`host/src/__tests__/template-fetch.test.ts`** + **`provisioning.test.ts`** +
  **`bundle.test.ts`** — P9.5 / P9.1 / P9.2 surfaces.
- **`host/src/__tests__/hyperv-backend.test.ts`** — direct Hyper-V
  backend status mapping and guest-agent health probing.
- **`host/src/__tests__/ui-browser.test.ts`** — pins URL safety,
  Run-dialog browser launch, UIA browser target discovery, stale-target
  fallback, explicit-selector failure behavior, and no-verify browser
  navigation.
- **`host/src/__tests__/vm-browser-tools.test.ts`** — pins the MCP
  wrapper contract for the guest Browser* RPCs, including safe URL
  validation, CSS-selector guardrails, screenshot image content, and
  current UNIMPLEMENTED/CDP-missing error visibility.
- **`host/src/__tests__/selector.test.ts`** — service-first backend
  ordering for both scenario runs and CLI VM verbs.
- **`host/src/__tests__/scenario-retry.test.ts`** — closes P3 C5
  (scenario + step retry policy).
- **`host/src/__tests__/trace.test.ts`** — `signalman-trace-id` header
  generation + propagation (closes P3 C10-residual TS side).
- **`host/src/__tests__/client.test.ts`** + **`host/src/verbs/__tests__/advanced-rename.test.ts`** —
  guest-agent client RPC routing and advanced MCP tool registration,
  including the `vm_ui_*` sidecar-facing UI tools.
- **`host/src/verbs/__tests__/run-lifecycle.test.ts`** — six-verb
  surface end-to-end with mocked executor.
- **`guest/src/cert_pin.rs` `tests` mod** (13 unit cases) +
  **`guest/src/service.rs` integration cases** (`cert_pin_matching_*`,
  `cert_pin_mismatched_*`) — pin enforcement (B2 / Sec F1).
- **`guest/src/main.rs auth_tests`** — bearer-token parsing, constant-time
  compare, allow-insecure invariants (B3, B7).
- **`guest/src/ui_sidecar.rs` `tests` mod** — JSON-line response shape
  and unknown-method error contract for the user-session UI sidecar.
- **`service/tests/named_pipe_smoke.rs`** — Rust↔Rust gRPC over Windows
  named pipe; the only existing integration test on the service crate
  before mtls_smoke landed.
- **`service/tests/mtls_smoke.rs`** (3 cases, landed in `7a07a87`) —
  `mtls_valid_client_succeeds`, `mtls_wrong_ca_rejected`,
  `mtls_no_client_cert_rejected`. Closes P7 D2.
- **`plugins/signalman-loom-plugin/tests/run_lifecycle.rs`** — plugin
  state-store lifecycle including plugin recreation.
- **`plugins/signalman-loom-plugin/src/state.rs`** + **`events.rs`** +
  **`forms.rs`** + **`handlers.rs`** unit tests — P5.3 / P5.4 deliverables.

## Roadmap status (by milestone)

### v0.1.0 — secure scenario runner (READY TO TAG once secrets configured)

All v0.1.0 phases are merged on `main`. Bullet status as of 2026-04-28:

- **P0 — MCP Surface Inversion** — Closed. Six verbs registered;
  `signalman.advanced.*` namespace gated; envelope shipping.
- **P1 — Hyper-V Control-Plane Service** — Closed (commit `3828913`
  per ROADMAP). MSI scaffold, named-pipe + TCP, mTLS, SCM lifecycle.
  Audit A2 closure (default-executor service routing) folded into P3.
- **P2 — Orchestrator Polish** — Closed via `0960ea6` (orphan sweep,
  CI re-enable, schema versioning, env-var test serialization). The F1
  readiness wait follow-up is closed in `f0bebee`: `waitForGuestAgents`
  now checks VM guest agents concurrently while preserving each VM's retry
  loop and timeout. The C7 teardown guard is closed in this branch: once VMs
  are resolved, declared teardown now runs from `finally` even when guest
  readiness, setup, workflow, assertion, or runtime errors occur. The
  provisioning orphan reaper is also closed here: VM creation records a
  manifest, and the `vm_cleanup_orphans` tool only targets manifest-owned VMs
  that lack the target checkpoint, defaulting to dry-run. Process-exit kd
  cleanup is closed here as well: real run orchestrators register a one-shot
  exit hook that synchronously terminates spawned kd sessions if the host exits
  before normal teardown. The final C7 recordings GC is also closed here:
  completed runs prune stale metadata-only `last-run.json` directories for
  deleted scenarios while preserving richer recording captures.
- **P3 — Agent UX Baseline** — Closed: P3.a structured errors
  (`a52d3bb`), P3.b retry (`13f2b0a`), P3.c orchestrator event hook
  (`ec92f80`), P3.d trace-id propagation across TS / Rust / plugin
  (`5a65922`, `9c3bd88`, `e4b1192`).
- **P4 — Security Baseline** — Closed for v0.1.x. Critical and High
  findings B1–B6 closed; Medium findings B7–B12 closed; B13/C3/C4
  carry to v0.1.2 (see Audit closure table).
- **P5 — Loom Plugin** — Closed: P5.3 (EventBus streaming) + P5.4
  (TUI form descriptors) + P5.5 (directive provider) shipped in
  `dfb524b`.
- **P6 — Packaging + Docs** — Scaffolding closed (`e23d838`).
  Tag-triggered MSI / npm / crate publishing wired; secrets gate the
  publish steps.
- **P7 — CI Pipeline + Test Pyramid** — Closed: D1 (`a347301`), D2
  (`7a07a87`), D2-prep (`89b0d1f`), D3+D6 (`2248903`), D4 gated E2E
  (`7a07a87`).
- **P8 — Proto v1 Freeze** — Closed (`c9e8e30`) with
  `platform_details` + `hypervisor_specific` oneofs.

### v0.1.1 — provisioning + bootstrap (CURRENT — READY TO TAG once secrets configured + versions bumped)

Tracking entry: ROADMAP § "v0.1.1 Roadmap (Provisioning + Bootstrap) —
NEW 2026-04-28". Status as of 2026-04-28:

- **P9.1 — Windows guest-agent MSI + `signalman vm provision`** —
  Closed (`e1be740`). 7-step pipeline at
  `host/src/provisioning/provision.ts`. Cert model locked at
  one-CA-many-VMs (Q2(c)).
- **P9.2 — Software bundle manifest + `signalman vm install-bundle`** —
  Closed (`e1be740`, follow-up `50807f6`). Tier 1 sources shipped
  (`winget`, `choco`, `msstore`, `direct`, `docker`).
- **P9.3 — `signalman init` + `signalman vm create`** — Closed
  (`e1be740`). `signalman init --bootstrap` prints the current
  cert/template/provision sequence without running image downloads or
  VM creation implicitly.
- **P9.4 — Idempotent "ensure provisioned" semantics** — Closed
  (`50807f6`, `host/src/__tests__/provisioning-idempotency.test.ts`).
  Per-verb × 3 invocation suite; `provision_if_missing: true` is parsed
  by the scenario schema and wired in `ScenarioOrchestrator.resolveVms`.
- **P9.5 — Template registry + base-image fetch** — Closed
  (`e1be740`). `signalman vm fetch-template`, content-addressed cache
  at `%LOCALAPPDATA%\Signalman\templates\<name>\<sha-prefix>.vhdx`.
  Microsoft Eval URL placeholder still in the shipped template
  (release-day swap).
- **P9.6 — Bootstrap docs** — Closed (`50807f6`). `docs/bootstrap.md`
  is the end-to-end walkthrough; README points at it on the first line.
- **P9.7 — DAG-resolved bundle dependencies** — Closed (`3354ded`).
  `requires:` is parsed in `bundle-types.ts` and planned in
  `install-bundle.ts` with cycle / unknown-dependency checks.

### v0.1.2 — Tier-2 sources + DAG dependencies (closed in `3354ded`)

Promised work closed in `3354ded`:

- P9.7 DAG `requires:` resolver for bundle ordering is closed.
- `provision_if_missing: true` scenario YAML field is closed.
- Guest MSI GitHub Release fallback is closed:
  `discoverGuestMsi` fetches and caches the matching
  `signalman-guest-*.msi` release asset.
- Tier 2 bundle sources are closed: `scoop`, `github_release`,
  `git_repo` (with `ref:` for branch/tag/SHA, `submodules:`/`sparse:`),
  `powershell` (`Install-Module`), `npm`, `pip`, `cargo`,
  `custom_script`.
- B13 (`protoc-bin-vendored` supply-chain documentation), C3
  (capability enforcement), C4 (`${secret:NAME}` resolution), and cert
  rotation are closed in `3354ded`.
- Per-scenario denylist allowlists (B9 follow-up) — locked decision
  was to keep the tripwire-not-boundary stance for v0.1.x.

### v0.2.0+ — record/replay, ephemeral provisioning, per-VM cert identity

Tracked in ROADMAP § "v0.2.0 Roadmap":

- **User-session UI sidecar** — First slice closed in `ba4e8ba`:
  `signalman-guest --ui-sidecar` runs in the interactive desktop session;
  the service-facing guest agent proxies `UIClick`, `UIType`, `UIFind`,
  `UIScreenshot`, and keyboard actions to it over loopback; host MCP exposes
  `vm_ui_snapshot`, `vm_ui_screenshot`, `vm_ui_find`, `vm_ui_wait_for`,
  `vm_ui_click`, `vm_ui_key`, and `vm_ui_type`.
  The native Windows UI Automation engine is now implemented for screenshot,
  find, click, type, and key (`1c29463`, `88efa17`, `f9617a8`). Follow-up
  native hardening added multi-token key sequences (`5627bb5`), find timeout
  polling (`90c134c`), and Value-pattern element descriptors (`b89f9c7`). Live
  `Win11_test` smoke coverage now exercises native health, screenshot,
  wait/find, targeted click, targeted type, direct edit-control value
  observation, indexed typed-text observation, key, snapshot, and compact
  `action_targets` for LLM observation loops. Follow-up native key work added
  common navigation, function, print-screen, pause, and application-menu tokens.
  Event-driven native UI waits now subscribe to UI Automation structure-change
  events with a bounded fallback timeout. Browser-friendly observation metadata
  now includes normalized roles and fallback labels on UI descriptors and action
  targets. Browser launch/navigation coverage now includes `vm_ui_open_url` /
  `ui_open_url` for safely opening `http(s)` URLs through the interactive
  Windows Run dialog and `vm_ui_navigate_url` / `ui_navigate_url` for
  address-bar page transitions in an already-open browser.
  The live `Win11_test` `live-ui-browser-smoke` scenario validates that path by
  closing stale Edge processes, opening Edge to an isolated `example.test` URL,
  observing the browser address bar through UI Automation, navigating to a
  second URL with the reusable browser navigation workflow, verifying that the
  workflow consumed discovered address-bar metadata without needing stale-target
  fallback, verifying the updated address value, capturing a screenshot and UIA
  inventory, identifying the address bar in the scored `browser_targets`
  observation list, and closing the browser. Host-side wrappers and MCP tools
  now expose the reserved guest Browser* RPC contract as
  `vm_browser_navigate`, `vm_browser_click`, `vm_browser_evaluate`, and
  `vm_browser_screenshot`.
  The guest service forwards those Browser* RPCs to the user-session sidecar;
  the native sidecar engine now has an initial loopback-only CDP backend for
  navigation, CSS-selector click, JavaScript page-state evaluation, and
  browser screenshots. PowerShell engines
  still return the stable CDP-unavailable contract, and the native engine
  reports the same unavailable boundary when no local CDP target can be reached.
  The live `scripts/live-browser-cdp-smoke.ps1` check on `Win11_test` validates
  a guest-local HTTP page, interactive Edge CDP launch, Browser* navigation,
  CSS click, DOM evaluation, browser screenshot, and preservation of the `base`
  checkpoint.
  Scenario workflows now expose `browser_navigate`, `browser_click`,
  `browser_expect`, and `browser_snapshot` blocks backed by reusable host
  browser workflow helpers. The live `live-browser-cdp-workflow` scenario on
  `Win11_test` validates the scenario-level path end to end: guest-local HTTP
  page, interactive Edge CDP launch, DOM-state expectation, screenshot capture,
  and cleanup.

- **v0.2.0-1 Record/Replay** — First slice in progress:
  `signalman.record` now starts a durable recording session under
  `.signalman/recordings/<safe-name>/<recording-id>/`, writes `state.json`
  plus `calls.jsonl`, validates recording name/duration, returns the session
  paths through CLI/MCP parity, appends redacted MCP call events while the
  session is active, and rediscovers active sessions after MCP server
  reconstitution. `signalman record finalize` /
  `signalman_record_finalize` now synthesizes candidate `setup.yaml`,
  `workflow.md`, and `assertions.yaml` files from `calls.jsonl`, preserving
  unsupported high-level MCP calls as review comments and requiring explicit
  force before overwriting an existing scenario. Next slice: replay/validate
  a finalized candidate scenario from the recording workflow.
- **v0.2.0-2 Ephemeral VM Provisioning** — Differencing-disk pipeline,
  per-scenario disposable guests, real `template:` wiring (C9), streamed
  `vm_copy_file` progress (C8).
- **v0.2.0-3 Hermetic Envelope** (full triple) — Adds `vm_lineage_hash`
  to the envelope; depends on -2.
- **v0.2.0-4 Explicit Orchestrator (Loom-fronted)** — Loom workflows +
  `loom tui` are the orchestrator; Signalman exposes the contract Loom
  invokes.
- **Per-VM identity certs** — Replaces v0.1.x one-CA-many-VMs cert model
  with per-VM identity certs that consume the B2 pin registry.
- **ISO-to-VHDX conversion** — Out of scope for v0.1.1; v0.2.0 may add.

v0.3.0+ speculative: cross-platform daemon (libvirt, vmrun wrapper),
Linux/macOS guest agent (E3), mobile UI proto shape (E4), per-user
identity certs and per-method capability tokens, hub component
resurrection, hosted orchestration.

## Outstanding TODOs in code

Every TODO/FIXME/XXX/HACK marker in product source as of 2026-04-28.
Format: `path:line — marker: description`.

### Host (TypeScript)

- `host/src/config.ts:156` — TODO: backwards-compat config field; v0.2.0
  will drop.
- `host/src/config.ts:388` — TODO(v0.2.0): top-level `signalman.yaml`
  resolution legacy path.
- `host/src/hypervisors/vmware.ts:126` — TODO: gRPC health check for
  `guestAgentReachable`.
- `host/src/scenarios/templates.ts:204` — TODO: real Microsoft eval URL
  (placeholder until release-prep finalisation).
- `host/src/scenarios/templates.ts:210` — TODO: real SHA-256 (recompute
  from the verified eval VHDX; companion to line 204).
- `host/src/scenarios/project-layout.ts:18` — TODO marker referenced in
  the next entry.
- `host/src/scenarios/project-layout.ts:75` — TODO(v0.2.0): remove the
  legacy fallback entirely.
### Guest (Rust)

- `guest/src/process.rs:606` — TODO: `QueryFullProcessImageNameW` (path
  reporting on Linux process inspect path).
- `guest/src/process.rs:607` — TODO: `NtQueryInformationProcess`
  (`command_line` reporting).
- `guest/src/process.rs:610` — TODO: `GetTokenInformation`
  (`is_appcontainer` reporting on the Linux path).
- `guest/src/process.rs:629` — TODO: `/proc` filesystem parsing for Linux.
- `guest/src/verification.rs:75` — TODO: measure actual latency
  (currently hardcoded `latency_ms: 0`).

### Service (Rust)

- (none)

### Plugin (Rust)

- `plugins/signalman-loom-plugin/src/handlers.rs:57` — TODO(P5.3): once
  `loom_plugin_api::PluginContext` exposes an `EventBus` accessor, swap
  the no-op sink for the real bus.

Cross-bucket: every "deferred to v0.1.2" / "deferred to v0.2.0" mention
is captured in the [Roadmap status](#roadmap-status-by-milestone)
section above. There are no `FIXME`, `XXX`, or `HACK` markers in product
source.

## Release process

### Required GitHub secrets

Configure once in repository Settings → Secrets and variables →
Actions. Source: `.github/workflows/release.yaml` § "Required GitHub
secrets" (lines 18–23).

| Secret | Purpose |
|---|---|
| `WINDOWS_CERT_BASE64` | Code-signing PFX (base64-encoded). Decoded into `RUNNER_TEMP` and shredded after sign — never written under workspace. |
| `WINDOWS_CERT_PASSWORD` | Password for the PFX. |
| `NPM_TOKEN` | npm publish token (Automation type). |
| `CARGO_REGISTRY_TOKEN` | crates.io API token (publish-crates scope). |

When a secret is missing, the corresponding job logs a warning and
skips the publish step but still produces (and uploads) the build
artifact, so dry-runs and pre-cert builds remain useful.

### Operator workflow to ship v0.1.x

```powershell
# 1. Local dry-run (catches version skew, packaging, template errors
#    without round-tripping through CI).
pwsh scripts/release-dry-run.ps1

# 2. Bump every version pin to the same string in one commit:
#      host/package.json
#      Cargo.toml (workspace.package.version — covers service)
#      guest/Cargo.toml
#      plugins/signalman-loom-plugin/Cargo.toml
#    Commit as e.g. "release: v0.1.1".

# 3. Tag and push.
git tag v0.1.1
git push origin v0.1.1

# The Release workflow runs three independent jobs (service-msi,
# host-npm, guest-crate), each verifying manifest-version-equals-tag,
# then aggregates artifacts into a GitHub Release. cargo publish
# always runs --dry-run as a release gate; the real publish is gated
# on CARGO_REGISTRY_TOKEN.
```

### What CI runs on every PR

`.github/workflows/ci.yaml`:

- **`host`** (ubuntu): `npm install`, `tsc --noEmit`, `eslint src/`,
  `vitest run`, `vitest run --coverage` (continue-on-error until
  thresholds wire on).
- **`guest-windows`** (windows): `cargo fmt --check`, `cargo build
  --release`, `cargo test --lib`, `cargo clippy -- -D warnings`.
- **`guest-linux`** (ubuntu): same as guest-windows but debug build.
- **`service-windows`** (windows, re-enabled in commit referenced by
  audit A1): `cargo fmt -p signalman-service --check`, `cargo build
  -p signalman-service --release`, `cargo test -p signalman-service`,
  `cargo clippy -p signalman-service --all-targets -- -D warnings`.

All `uses:` references are SHA-pinned per B12 / Sec F15.

### What CI runs on a tag push

`.github/workflows/release.yaml`:

- **`service-msi`** (windows): build service, `cargo wix`, sign MSI
  via `signtool` (gated on `WINDOWS_CERT_BASE64`), upload artifact.
- **`host-npm`** (ubuntu): build host, run `vitest` as release gate,
  `npm pack`, publish to npm (gated on `NPM_TOKEN`), upload artifact.
- **`guest-crate`** (ubuntu): build, test, `cargo publish --dry-run`
  always, real publish gated on `CARGO_REGISTRY_TOKEN`.
- **`github-release`** (ubuntu): aggregator. Only fires on tag pushes.
  Downloads every uploaded artifact, attaches to a `softprops/action-gh-release`
  release with `generate_release_notes: true`. Pre-release flag set
  automatically for `-rc.` / `-beta.` / `-alpha.` tags.

### Gated lanes

`.github/workflows/e2e.yaml` (P7 D4 — placeholder):

- **Trigger**: `workflow_dispatch` (manual) **or** PR labeled `e2e`.
- **Platform**: `windows-latest` (no Hyper-V on standard runners — see
  the workflow header for the rationale).
- **Steps**: build host (npm) + guest (cargo) + service (cargo) in
  release mode, then run `scripts/e2e-smoke.ps1`. The smoke script is
  a placeholder verifying host `--help` plus guest/service `--version`;
  the real lane lights up when a self-hosted Hyper-V runner
  is wired (P7 D4 follow-up).

## Architecture invariants (decisions that span features)

These are the locked rules that survive any single feature. Each row
points at a primary source of truth so the rule can be re-derived from
the codebase.

| Rule | Source |
|---|---|
| Cert model is one-CA-many-VMs for v0.1.x; per-VM identity certs are deferred to v0.2.0 (consumes the B2 pin registry). | ROADMAP § "P9.1" + `host/src/provisioning/provision.ts:354-365`; locked Q2(c). |
| Symmetry rule: every provisioning capability ships as **both** a CLI verb and an MCP tool with identical input shape. | ROADMAP § "P9 Symmetry rule (locked)". |
| Versioning rule: provisioning verbs are *destructive* but ship in the *default* MCP namespace (not `signalman.advanced.*`); tool descriptions explicitly say "creates / destroys VM state" so LLM clients apply their own confirmation gates. | ROADMAP § "P9 Versioning rule (locked)". |
| Idempotency: re-running any provisioning verb with no changes is a 2-second no-op; `--force` rebuilds. | `host/src/__tests__/provisioning-idempotency.test.ts`; ROADMAP § "P9.4". |
| CLI parity: every MCP verb has a matching CLI command. CI invokes the CLI; agents invoke the MCP. Same execution path, same envelope, same exit codes. | ROADMAP § "Product Direction → CLI parity". |
| Hermetic envelope (staged): v0.1.x emits `(scenario_hash, agent_version, network_class, result, events[], duration)`; full triple including `vm_lineage_hash` lands in v0.2.0-3. | ROADMAP § "Hermetic envelope (staged)"; `host/src/output/envelope.ts`. |
| MCP surface principle: the unit of agent action is a **scenario**, not a raw VM/Docker call. Six verbs (`list`, `describe`, `plan`, `run`, `record`, `status`); raw VM ops live behind `signalman.advanced.*`. | ROADMAP § "MCP surface principle". |
| Failure recovery (provisioning): leave the VM around on failure for inspection; explicit `signalman vm cleanup` to remove. `--cleanup-on-failure` is opt-in. | `host/src/provisioning/provision.ts:25-28`; locked Q decision. |
| `direct` source security gates (locked): SHA-256 REQUIRED, HTTPS-only, allowlist `.msi/.exe/.msix/.appx`. | ROADMAP § "P9.2 `direct` security gates"; `host/src/provisioning/bundle-types.ts:189`. |
| `docker` source security gates (locked): `image_sha256` REQUIRED (digest, not tag), pulls go through the VM's daemon, `restart_policy` defaults to `unless-stopped`. | ROADMAP § "P9.2 `docker` security gates". |
| Bundle ordering: bundles without `requires:` keep author-declared order; bundles with `requires:` are topologically sorted and independent ready packages run in parallel. Unknown dependencies and cycles fail before guest RPCs. | `host/src/provisioning/install-bundle.ts`; `host/src/__tests__/bundle.test.ts`. |
| ISO-to-VHDX conversion is **out of scope** for v0.1.1; operators bring pre-built VHDX. v0.2.0 may add an ISO build step. | `host/src/provisioning/template-fetch.ts:23-24`; ROADMAP § "P9.5". |
| Loom-fronted topology is the default agent surface for v0.1.0; the standalone `signalman.*` MCP server in `host/` keeps shipping for direct CLI/CI consumers and as the substrate the Loom plugin shells to. | ROADMAP § "2026-04-25 architecture decision (Loom-fronted agent surface)"; `README.md` Quick Start. |
| Plugin integration is **process-isolated**: the Loom plugin shells out to the Signalman CLI; Signalman is not a Rust dependency of Loom. | ROADMAP § "P5 Topology and boundaries". |
| Hyper-V is the primary hypervisor backend; VMware Workstation remains a working fallback but is no longer the default. macOS support starts with a Tart-backed host backend (v0.2.0+ may add a first-party Swift helper). | ROADMAP § "2026-04-17 change" + "2026-04-26 Mac virtualization decision". |
| UI automation uses a user-session sidecar, not the Windows service desktop. The guest service proxies UI RPCs to `SIGNALMAN_UI_SIDECAR_ADDR` over loopback; the sidecar is launched with `signalman-guest --ui-sidecar` in the logged-in user's session. Browser and some verification RPCs remain future slots. | `docs/ui-sidecar.md`; `guest/src/ui_sidecar.rs`; `guest/src/service.rs`; `host/src/tools/vm-ui.ts`. |
| `template:` field on scenario `vms[]` is **decorative** for v0.1.0; orchestrator never calls `resolveTemplate`. Wired for real in v0.2.0-2 (C9). | ROADMAP § "Cuts and Deferrals" + § "v0.2.0-2"; `host/src/scenarios/templates.ts:36-74`. |
| Denylist is a **tripwire, not a boundary**: catches blatant agent hallucinations cheaply; the actual security boundary is mTLS + named-pipe ACL + cert pin. Positive allowlist explicitly rejected for generic VM scenario execution. | `guest/src/service.rs:35-90`; ROADMAP § "P4.2 B9". |
| Every cross-process contract needs at least one test pinning its shape. Today: host TS↔service Rust (P7 D2 closed via `service/tests/mtls_smoke.rs`); host TS↔guest agent gRPC (mock-backed today; real-wire test deferred); plugin↔CLI (state side covered, real CLI subprocess test deferred). | `docs/testing.md` § "Test-pyramid invariants"; ROADMAP § "P7.2". |
| Trace-id format: 32-char hex, matches W3C `trace-id` width, rides on gRPC metadata as `signalman-trace-id`. Cheap upgrade path to OTel. | `proto/guest.proto` v1-freeze comment (lines 9–18); `host/src/guest/client.ts` (`parseTraceId`); plugin `src/trace.rs`. |
| Audit cadence (locked 2026-04-28): every P9.x deliverable runs a 6-lens audit (PM / QA / Arch / Sec / DX / Ops) at the delivery milestone, not per-commit, before the merge commit lands. | ROADMAP § "Audit cadence (locked 2026-04-28)". |

## How to resume on a different machine

```bash
# 1. Clone (Loom must live as a sibling of signalman/ for the plugin to
#    build — see plugins/signalman-loom-plugin/Cargo.toml header).
git clone https://github.com/ambray/signalman.git
git clone https://github.com/ambray/loom.git    # sibling, only needed for plugin

# 2. Initial dependencies (run from signalman/).
cd signalman/host && npm install && cd ..
cargo build --release                            # builds workspace (guest + service)

# Loom plugin is intentionally NOT in the Cargo workspace; build it
# explicitly when Loom is checked out alongside.
cargo build --release \
  -p signalman-loom-plugin \
  --manifest-path plugins/signalman-loom-plugin/Cargo.toml

# 3. Run the test suites (1256+ test attributes / it() calls across
#    host TS, guest Rust, service Rust, plugin Rust).
cd host && npm test && cd ..
cargo test --workspace
cd plugins/signalman-loom-plugin && cargo test && cd ../..

# 4. Type-check + lint gates (matches CI).
cd host && npx tsc --noEmit && npm run lint && cd ..
cargo clippy --workspace -- -D warnings
cargo fmt --check

# 5. To start contributing on a new feature
#    - Pick the level. See docs/testing.md § "The five test classes".
#    - Default to a unit test. Reach for integration only when a single
#      function isn't enough.
#    - Run only the relevant slice while iterating:
cd host && npx vitest run src/__tests__/<file>.test.ts
cargo test -p signalman-guest <test_name>

# 6. To ship a release: see "Operator workflow to ship v0.1.x" above.
```

## How to pick up mid-stream in a future Claude session

Copy-paste prompt that bootstraps a fresh session with full context:

```
Read these files in order to bootstrap context for resuming Signalman work:
1. docs/STATUS.md — current state, version pins, audit closure, TODOs.
2. ROADMAP.md § "v0.1.1 Roadmap (Provisioning + Bootstrap)" and the
   "Timeline Summary" table at the bottom.
3. The output of `git log --oneline -10` to see what landed most recently.
4. docs/bootstrap.md if the work involves provisioning / bootstrap UX.
5. docs/testing.md if the work involves adding tests.

Then summarize: (a) what version is on main, (b) what the next planned
work is per ROADMAP, (c) what audit findings are still open. After that,
ask the user what to work on. Do NOT bump version pins, tag, or push
without explicit user instruction — those are operator actions.
```

## Glossary

- **Envelope** — JSON result emitted by `signalman.run` and `signalman
  run` (CLI). Shape: `(envelope_version, run_id, scenario_id,
  scenario_hash, agent_version, network_class, started_at, finished_at,
  duration_ms, result, exit_code, assertions, events[], errors[])`.
  v0.1.x is the staged shape; v0.2.0-3 adds `vm_lineage_hash`.
- **Scenario** — A directory under `.signalman/scenarios/<name>/` (or
  `examples/`) containing `setup.yaml`, `assertions.yaml`, `workflow.md`.
  The unit of agent action.
- **Verb** — One of `list`, `describe`, `plan`, `run`, `record`,
  `status`. The six high-level MCP entry points; each has a matching
  CLI command.
- **Bundle** — A `bundle.yaml` declaring `packages:` from Tier 1
  sources (`winget`, `choco`, `msstore`, `direct`, `docker`).
  `signalman vm install-bundle <vm> <bundle.yaml>` applies it.
- **Loom plugin** — `plugins/signalman-loom-plugin/`. Rust crate that
  registers `loom.signalman.list/describe/plan/run/record/status` MCP
  tools through Loom's `RegisterMcpTools` capability and shells out
  to the Signalman CLI.
- **Provision pipeline** — The 7-step `signalman vm provision` flow:
  resolve_template → create_vm → boot_vm → stage_certs →
  discover_msi → install_msi → checkpoint. Source of truth:
  `host/src/provisioning/provision.ts:1-29`.
- **Tier 1 / 2 / 3 (sources)** — Bundle-source taxonomy.
  Tier 1 ships in v0.1.1 (`winget`, `choco`, `msstore`, `direct`,
  `docker`). Tier 2 is closed in `3354ded` (`scoop`, `github_release`,
  `git_repo`, `powershell`, `npm`, `pip`, `cargo`, `custom_script`).
  Tier 3 later (`brew`, `mas`, `apt`, `dnf`, `flatpak`, `snap`).
- **6-lens audit** — PM, QA, Arch, Sec, DX, Ops. Locked 2026-04-28 as
  the per-milestone audit shape; runs at delivery milestone, not
  per-commit.
- **Hermetic envelope** — The staged contract: same
  `(scenario_hash, agent_version, network_class)` triple in v0.1.x;
  full `(scenario_hash, vm_lineage_hash, agent_version)` in v0.2.0-3.
- **Tripwire-not-boundary** — Doc convention for the `is_denied_command`
  list. The denylist catches obvious agent hallucinations cheaply; the
  actual security boundary is mTLS + named-pipe ACL + cert pin.
- **Symmetry rule** — Every provisioning capability lands as both a
  CLI verb and an MCP tool with identical input shape.

## Document maintenance

This doc is meant to track the codebase. Update triggers:

- **After every milestone-level commit** — refresh: latest commits
  (top 10), test count rows, roadmap status, outstanding TODOs.
- **After every audit finding closure** — update the Audit closure
  table with the closing commit SHA.
- **After every breaking proto change** — bump the proto contract row
  in Versions; add a note in the Architecture invariants section if
  the change touches a locked rule.
- **After every version bump** — update the Versions table to match
  the new manifest values.
- **After every `Last updated:` date change** — bump the date in the
  doc header.

When the doc and the source disagree, the source wins. Open a PR to
update this file rather than working around drift. Same convention as
`docs/bootstrap.md` and `docs/testing.md`.
