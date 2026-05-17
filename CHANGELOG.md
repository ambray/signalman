# Changelog

All notable changes to Signalman will land here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
aims for [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

(WS9-WS12 cohort + WS7/WS8 in flight — see `docs/workstreams/README.md`.)

## [0.4.0] — 2026-05-XX

Consolidated release covering everything that landed on `main` after
v0.2.1: the v0.3.0 sub-tags (record/replay, ephemeral VMs, hermetic
envelope, Loom-fronted orchestrator, cloud-provider support, Kubernetes)
plus the v0.4.0 sub-tags (auto-promotion, webhooks, scheduled health,
cross-platform parity). The standalone `@signalman/registry` package is
independently versioned and reached v0.1.1 in parallel.

The version pins in `host/package.json`, `guest/Cargo.toml`,
`Cargo.toml`, `service/Cargo.toml` (inherited), and
`plugins/signalman-loom-plugin/Cargo.toml` move from 0.2.1 → 0.4.0 in
one coordinated bump. `host/src/http/app.ts`'s formerly hardcoded
`VERSION` constant now reads from `host/package.json` via the shared
`host/src/version.ts` helper, so subsequent bumps only touch
`package.json`.

Not wire-breaking. Additive across all surfaces — config unions gain
options, MCP tools gain verbs, RPCs gain capability gates.

### Added — v0.3.0-1 Record/Replay

- Record/replay surface that captures MCP tool calls + CLI
  invocations into a single unified `calls.jsonl` per session.
- Loom plugin response shape graduates the record/replay
  surface so the orchestrator can correlate envelopes with
  recorded inputs.
- `signalman record` + `signalman record finalize` verbs;
  `parsedArgsToRecord` helper for tooling that wants to
  programmatically capture argv.

### Added — v0.3.0-2 Ephemeral VMs

- Ephemeral VM provisioning module with deterministic teardown
  on scenario exit. Backed by differencing-disk primitives so
  the parent image is never mutated.
- `vm_lineage_hash` canonicalization module — every ephemeral
  VM carries a stable hash naming its base image + diff chain.
- Streamed `vm_copy_file` progress (Closure C8) — host gets
  byte-count progress callbacks during long transfers.
- Orchestrator wiring + `template:` shorthand for scenario
  fixtures (Closure C9).

### Added — v0.3.0-3 Hermetic Envelope (full triple)

- ScenarioResult envelope graduates with the full hermetic
  triple: code hash, data hash, environment hash.
- `aggregateUniqueStrings` helper extracted as the shared
  primitive for envelope construction.
- Envelope-hash helpers + design note for the three-axis model.

### Added — v0.3.0-4 Loom-fronted Orchestrator

- `hermetic_identity` field promoted to the Loom plugin
  response so Loom workflows can be the orchestrator with
  Signalman exposing the contract surface.

### Added — v0.3.0-5 Cloud-provider support (AWS + Azure)

WS1 cohort. Closes ROADMAP `v0.3.0-5`.

- Cloud-backend abstraction + registry: `CloudBackend` interface
  with `provisionInstance` / `terminateInstance` / `getStatus` /
  `listInstances` / `getBackends`. Per-backend error codes
  unionized as `CloudBackendErrorCode`.
- **AWS EC2** cloud backend via `@aws-sdk/client-ec2`.
- **Azure VM** cloud backend via `@azure/arm-compute`.
- **OpenTofu driver** for `cloud_stack_test` target kind —
  plan / apply / destroy + `tofu plan -json` parsing for
  cost estimation.
- MCP cloud + stack tools: `signalman_cloud_provision`,
  `signalman_cloud_terminate`, `signalman_cloud_status`,
  `signalman_cloud_list`, `signalman_cloud_backends`,
  `signalman_stack_apply`, `signalman_stack_destroy`,
  `signalman_stack_plan_cost`.
- **Cost guardrails** (sub-task 5): TTL reaper (5-min poll
  terminates past-TTL instances), per-org spend budget gate
  with cost table + soft-warn-at-80% / hard-refuse-at-100%
  semantics, pre-flight cost estimate from `tofu plan -json`.
- **Network connection descriptor** (sub-task 6): three modes
  for guest reachability — `public_mtls`, `aws_ssm`,
  `azure_bastion`. Per-org credentials at rest in the
  `cloud_org_credentials` table.
- **CLI** (sub-task 8): `signalman cloud {provision,
  terminate, status, list, backends, reaper, budget, creds,
  connection-descriptor}` + `signalman stack {apply, destroy,
  plan-cost}`.
- 5 cloud skills.

### Added — v0.3.0-6 Kubernetes (WS2)

- **K8s deploy target**: `k8s_test` / `k8s_demo` target kinds.
  `KubectlDriver` shells `kubectl apply -k` for kustomize;
  `HelmDriver` shells `helm upgrade --install`. Rollback via
  `kubectl rollout undo` / `helm rollback`. Health via
  `kubectl wait`. New `K8sDriverError` for stable error codes.
- **K8s runner substrate**: operator-authored manifest pattern
  with `Job` (one-shot) and `Deployment` (warm-pool)
  examples under `examples/k8s-runner/`.
- New MCP tools `signalman_k8s_{deploy,rollback,status}` +
  CLI verbs `signalman k8s {deploy,rollback,status}` and
  `signalman runner deploy-k8s`.

### Added — v0.4.0-1 Auto-promotion (WS3)

- **Promotion policy schema** + listener on build-completed
  event. Three gate kinds: `auto` (immediate),
  `manual` (operator approves), `time_delay` (auto after
  duration).
- **Tier-to-tier promotion** with approver allow-list.
- CLI: `signalman promotion {list, add, remove, approve,
  reject, tick, approvals}`. MCP mirrors. Skill:
  `signalman-promote-release`.

### Added — v0.4.0-2 Webhooks (WS3)

- **Event dispatcher** + `webhook_subscription` table.
  Generic-webhook driver with HMAC signing; **Slack** driver;
  **Email** driver (gated by `SIGNALMAN_SMTP_URL`).
- Events fired on release-built / deployed / rolled-back /
  health-failed / promotion-approved.
- CLI: `signalman webhook {list, add, remove, test}`. MCP
  mirrors. Skill: `signalman-webhook-setup`.

### Added — v0.4.0-3 Scheduled health (WS3)

- **`health_schedule` table** + scheduler (1-min tick) +
  hook into audit log + event dispatcher.
- CLI: `signalman schedule {list, add, disable, enable,
  remove, run-once, start}`. MCP mirrors. Skill:
  `signalman-schedule-health`.

### Added — v0.4.0-4 Cross-platform (WS4)

#### Host hypervisor backends

- `host/src/hypervisors/libvirt.ts` — libvirt / KVM backend
  driven by the `virsh` CLI (no native libvirt-node dep, so
  Windows CI keeps building). Covers lifecycle, snapshots,
  file transfer (via qemu-guest-agent JSON-RPC), and command
  execution. Constructor accepts an injectable `LibvirtExec`
  callback for tests, mirroring `cloud/tofu.ts`.
- `host/src/hypervisors/vmrun.ts` — parallel-track VMware
  Workstation / Fusion backend wrapping `vmrun`. Same shape
  as libvirt: injectable `VmrunExec`, stable error codes,
  S-14 password redaction on every stderr egress. The
  existing `vmware.ts` (with its `govc` vSphere fallback) is
  unchanged. Operators opt in via
  `hypervisor.backend = "vmrun"`. Convergence onto a single
  VMware backend is tracked as a roadmap follow-up (WS11).
- New error classes `LibvirtBackendError` and
  `VmrunBackendError` with stable codes the orchestrator
  dispatches on without parsing CLI phrasing.

#### Guest agent platform layer

- `guest/src/platform/{windows,linux,macos,other}.rs` — new
  `Platform` trait the service layer dispatches through.
  Capability getters (`supports_ui_automation`,
  `supports_system_elevation`,
  `supported_package_sources`) let RPC handlers return a
  clean `Status::unimplemented` on platforms that don't
  implement a given operation, rather than letting the call
  hang on a sidecar that will never connect.
- All four `Platform` impls compile on every target; only
  the `Current` re-export is `cfg`-gated so trait tests can
  exercise each impl regardless of build host.

#### Linux SYSTEM-elevation

- `process::start_process_as_system` on Linux now shells
  `sudo -n [-E] -- <path> <args>`. Sudoers refusal surfaces
  as `Status::permission_denied`; the agent's invoking user
  must have NOPASSWD configured for the commands the operator
  intends to run.
- `build_sudo_argv` factored out as a free function so the
  argv shape is unit-testable on every build host.

#### install_software sources

- Linux: `apt` (shells `apt-get install -y`), `dnf`
  (`dnf install -y`), `yum` (legacy RHEL ≤ 7 alias). Version
  pinning via `<pkg>=<ver>` (apt) or `<pkg>-<ver>` (dnf/yum).
- macOS: `brew` (`brew install`). Version pinning via
  `<pkg>@<ver>` (note: brew's `@`-suffix names are separate
  formulas, not literal version pins).
- Idempotent re-runs detected via stable phrasing matching:
  "is already the newest version" (apt), "Nothing to do." /
  "is already installed" (dnf/yum), "already installed" /
  "up-to-date" (brew).

#### Changed — cross-platform RPC behaviour

- Windows-only RPCs (`ui_click` / `ui_type` / `ui_key` /
  `ui_find` / `ui_screenshot` / `browser_*` /
  `install_software` with Windows-only sources /
  `run_command(run_as="system")` on macOS) now return
  `Status::unimplemented` with a canonical
  "<feature> is not supported on <os>" message.
- `ui_health` keeps its OK-with-payload shape on non-Windows
  and reports `sidecar_reachable=false` with the canonical
  message in the `error` field.
- `install_software` distinguishes three failure modes for
  an unrecognised source: wrong-platform →
  `Status::unimplemented`; typo / unknown source →
  `Status::invalid_argument`; empty source on Linux + macOS
  → `Status::invalid_argument` with a hint of the supported
  set (Windows still defaults to winget for backwards compat).

#### Changed — selector + config

- `host/src/hypervisors/selector.ts` registers libvirt and
  vmrun in `buildBackendList`. Platform-aware default
  ordering: Linux gets libvirt first, macOS keeps tart first,
  Windows keeps the existing service-first chain.
- `SignalmanConfig.hypervisor` adds `virshPath` and
  `libvirtUri` fields; the `backend` union now accepts
  `"libvirt" | "vmrun"` in addition to the existing values.
  Env overrides: `SIGNALMAN_VIRSH_BIN`, `LIBVIRT_DEFAULT_URI`.

### Added — WS6 wave-2: capability audit + skills

- Capability matrix doc enumerating every shipped capability
  × {functional? MCP-exposed? CLI-exposed? skill-covered?}.
- 25 skill `SKILL.md` files for the highest-impact gaps.
- P1 MCP wrappers + target-edit + runner table.
- Skill-frontmatter validator test.

### Added — WS6 wave-3 (M5–M10.6): production readiness

- **M5**: Audit-log CLI + MCP surface (`signalman audit
  {query, append}`).
- **M6**: MCP tools wired into `promote-release` +
  `schedule-health` skills.
- **M7**: Promotion auto-approver health-gate
  (WS2 readiness check).
- **M8**: `cloud_vm` + `cloud_stack` target kinds + deploy
  adapters; install-bundle integration.
- **M9**: Multi-transport runner deploy
  (script / ssh / winrm / docker / cloud).
- **M10.1–M10.6**: Standalone registry productionization —
  registry schema for cargo, sparse-index read path, publish
  + yank, virtual-registry pull-through with re-signing,
  forensic + provenance HTTP API, operator CLI + skill.
  Cloud_vm install-bundle + cloud rollback + SSM/Bastion
  dialers. Packer golden-image scaffolding. Multi-transport
  deploy integration tests.

### Added — `@signalman/registry` (independently versioned, v0.1.0 → v0.1.2)

Built in parallel with the host work as a standalone OSS package
at `registry/`. Federates with `@signalman/host` via the existing
`BlobDriver` interface.

- Package skeleton, generic blob + manifest types,
  `LocalFsBlobStore` (content-addressed), SQLite manifest
  catalog, Ed25519 manifest signing port.
- Minimal HTTP API + `LocalFsRegistryStorage` facade;
  registry CLI + MCP surface (`serve`, `verify`, `keygen`).
- `signalman-registry` BlobDriver on the host side proves
  federation works.
- **v0.1.1**: npm protocol facade — publish + install +
  virtual mirror (cargo facade landed earlier in wave-3).
- **v0.1.2 (WS10, 2026-05-17)**: OCI Distribution Spec v1.1
  facade. `docker push` / `docker pull` / `crane copy` /
  `cosign verify` work end to end. Multi-arch image indexes,
  bearer-challenge auth flow, virtual upstreams against Docker
  Hub + GHCR + ECR, cosign-style signing on the `<digest>.sig`
  tag convention, `oci sign`/`oci verify` CLI verbs, OCI
  Distribution Spec conformance lane scaffolded (CI gated by
  `SIGNALMAN_OCI_CONFORMANCE=1`). 578 tests across 33 files
  at v0.1.2 close; coverage on `registry/src/oci/` 92.64
  stmts / 85.95 branches / 96.71 funcs / 92.64 lines.

### Tests

Held-core coverage holds at 86.57% statements / 81.61%
branches / 91.15% functions / 86.57% lines on the host (well
above the 80/70/80/80 floors enforced by `vitest.config.ts`).

- Guest: ~159 tests over the WS4 commits (147 → 159), plus
  the +12 follow-up sudo + package-manager tests.
  Cross-platform trait dispatch tests exercise non-host
  impls from a Windows build host; argv-helper coverage for
  `build_sudo_argv`.
- Host: 1880+ tests (1795 → 1880 in WS4 alone). Libvirt
  argv composition, virsh parser coverage with fixture files
  under `host/src/__tests__/fixtures/virsh-*.txt`,
  integration tests covering every `LibvirtBackendError` and
  `VmrunBackendError` code path. Cloud-provider backend
  tests, K8s driver tests, promotion / webhook / schedule
  end-to-end tests, audit-log integration, multi-transport
  runner deploy integration tests.

### Public-release readiness (WS12 partial)

- **`signalman --version` verb** lands — `host/src/cli.ts` +
  `host/src/version.ts` shared helper. `http/app.ts` migrates
  to consume the helper, eliminating the hardcoded `VERSION
  = "0.2.1"` drift.
- **`registry/package.json`** version-pin drift resolved
  (`0.0.1` → `0.1.1`) to match the ROADMAP claim.
- **CI coverage gate** wired into `.github/workflows/ci.yaml`
  (matches `vitest.config.ts` thresholds exactly).
- **Public-release operator runbook** at
  `docs/runbooks/public-release.md` covers `gh secret set`
  for the four release secrets, pre-flight checklist,
  dry-run tag, visibility flip, post-flip smoke, rollback.
- **Bug-report issue template** makes the `signalman
  --version` field required.

### Deferred (tracked in ROADMAP / STATUS)

- **macOS UI automation parity** with the Win32 UIA sidecar
  (Tart-backed Mac runner shipped in v0.4.0-4; AppleScript /
  Accessibility-API driver awaits Mac dev-host availability).
  Scoped prompt preserved at
  `docs/workstreams/prompts/ws-future-macos-ui-parity.md`.
- **`vmrun.ts` + `vmware.ts` convergence** (WS11) —
  deliberately deferred until vmrun.ts has seen at least one
  production scenario end-to-end. Design + parity test suite
  scoped in the WS9–WS12 cohort.
- **`CODE_OF_CONDUCT.md`** — STATUS.md item #4. Land outside
  this WS12 pass.
- **Visibility flip** + **GitHub repo secrets** — operator
  gestures, documented in `docs/runbooks/public-release.md`.

See ROADMAP §"v0.5+ — Claude Code plugin + next-10 epics" for
in-flight follow-on work (WS7 plugin, WS8 identity certs, WS9
signing service, WS10 registry OCI, WS11 vmware convergence).

## [0.2.1] — 2026-05-13

Capability-surface scrub: removes the AI-restriction / sandbox
machinery that came from the prior consuming product. Scenarios
that test a specific product's behavior live in the consuming
product's repo; signalman ships the orchestrator and a thin set of
generic probes.

This release adjusts the `signalman.guest.v1` wire contract. The
v1 freeze in v0.2.0 (P8) was tagged on a public release but no
package was actually published to npm/crates.io before this scrub
landed (release-workflow gate was held), so no external consumer
relies on the dropped surface. If you have a fork on a private
registry, treat this as a wire-breaking change.

### Removed (proto v1, wire-breaking)

- `VerifyRestriction` RPC and its `VerifyRestrictionRequest` /
  `VerifyRestrictionResponse` messages.
- `WindowsRestrictionDetails`, `LinuxRestrictionDetails`,
  `MacOsRestrictionDetails` (the `platform_details` oneof variants
  on the dropped response).
- "Restriction Verification" section header in `proto/guest.proto`
  — renamed to "Network / File-access probes". `TestNetwork` and
  `TestFileAccess` RPCs remain unchanged.

### Removed (host scenario surface)

- `SandboxMode` TypeScript union type.
- `sandbox_modes:` scenario-config field (Zod schema + runner type).
- `sandbox_mode` field on `ScenarioResult`.
- `runScenarioMultiMode` orchestrator method + `MultiModeResult`
  return type.
- `substituteSandboxMode`, `currentSandboxMode`, and
  `revertVmsToCheckpoints` orchestrator helpers.
- `${SANDBOX_MODE}` template placeholder. `${param:NAME}` /
  `${param:NAME:-default}` / `${secret:NAME}` are unchanged.
- `verifyRestriction` host-side client wrapper, `RestrictionVerdict` /
  `WindowsRestrictionDetails` interfaces, and the
  `getWindowsRestrictionDetails` accessor in
  `host/src/guest/client.ts`.

### Removed (guest crate)

- `RestrictionVerdict`, `RestrictionMode`, `Verdict`, and
  `RestrictionCheck` types in the guest crate.
- `verify_restriction` RPC handler stub.
- The `guest/src/verification.rs` module is renamed to
  `guest/src/probes.rs` and now only carries the generic
  `test_network_connectivity`, `test_file_access`, and
  `verify_software_installed` helpers.

### Renamed (no semantic change)

- `silo-test-harness` → `test-harness` in `host/src/kernel-debug/`
  tool descriptions and test fixtures. The actual binary name in
  the consuming product's repo is unaffected by this rename.
- Test fixtures: `silo-validation` → `example-torture`,
  `silo_apis_available` → `api_available`, `P2-terminate-silo` →
  `P2-terminate-process`, `P1-appcontainer-silo-compose` →
  `P1-compose-smoke`, `silo.sys` → `helper.sys`.

### Kept (deliberately)

- `is_appcontainer`, `appcontainer_sid` on `WindowsProcessDetails`
  and the AppContainer fields on `WindowsInspectDetails`.
  AppContainer is a real Windows OS concept the guest can inspect
  generically; signalman has no internal use for these fields today
  but they're cheap to keep alongside `is_low_integrity` and
  `is_in_job` for symmetry.
- `substituteVarsDeep` orchestrator helper. No callers in v0.2.1;
  preserved as a generic utility for future matrix-style scenario
  substitution.

### Docs

- README, ROADMAP, design docs, gated-E2E workflow comment, and
  service smoke-test runbook genericized: removed product-
  specific scenario names and niche-positioning framing in favor
  of general-purpose capability descriptions. v0.2.0 release
  notes (this file at §0.2.0) are deliberately preserved as a
  historical record.

### Repo hygiene

- `.gitignore`: added `target-*/` glob to catch `CARGO_TARGET_DIR`
  overrides (e.g. `target-codex-check/`) alongside the existing
  `target/` rule.

## [0.2.0] — 2026-05-12

First versioned release. Bundles the original "v0.2.0 local meta
build" + the "v0.3.0 networked control plane" scopes into one tag
since the two were developed in lockstep on the same branch and
neither shipped independently. Also packages the public-release
security pass and the standard OSS community-health files.

Manifest pins bumped in lockstep: `host/package.json`,
`guest/Cargo.toml`, root `Cargo.toml`, and
`plugins/signalman-loom-plugin/Cargo.toml`. In-code `VERSION`
constant in `host/src/http/app.ts` set to `0.2.0` (was
`0.3.0-dev`). Git history was scrubbed of prior product-specific
references via `git filter-repo`.

### Public-release readiness

- **Added** `SECURITY.md` — vulnerability disclosure policy with GitHub
  Security Advisories as the primary channel; scope definition,
  supported-versions table, 72h-ack / 90d-fix commitment for high/
  critical findings.
- **Added** `CONTRIBUTING.md` — dev environment setup (Node 22.5+,
  Rust stable, protoc), per-stack test commands, PR expectations,
  release-day version-pin checklist.
- **Added** `.github/ISSUE_TEMPLATE/{bug_report,feature_request}.md`
  plus `config.yml` — structured forms; blank issues disabled;
  security-advisory + discussions paths surfaced in the picker.
- **Added** `.github/PULL_REQUEST_TEMPLATE.md` — change-type checklist
  and test-plan checklist.
- **Added** `NOTICE` at the repo root — Apache-2.0 conventional
  attribution alongside `LICENSE`.
- **Added** `CHANGELOG.md` (this file).
- **Fixed** `.github/workflows/{ci,release}.yaml` — bumped Node
  from 20 to 22 (required for the built-in `node:sqlite` module the
  v0.2+ control plane uses). The mismatch would have silently broken
  CI and the release pipeline once the meta-build commits landed on
  main.
- **Fixed** README quickstart commands so they actually match the
  CLI: `--repo` (not `--repo-url` only), `--key` (not `--signing-key`),
  `runner register --control-plane --token` (not `--name`),
  `health check --target` (not `--deployment`),
  `key generate` (no `--out` file form; default lands keys in
  `~/.signalman/keys/signing.{pub,key}`),
  `key fingerprint <path>` (positional, not `--key`).
- **Fixed** `docs/bootstrap.md` Node prerequisite row (20 LTS → 22.5+).
- **Fixed** `SECURITY.md` + `CONTRIBUTING.md` + bug-report template:
  replaced `signalman --version` references (the CLI doesn't have
  that flag) with paths that actually work
  (`npm ls @signalman/host` / `git rev-parse HEAD`).
- **Fixed** `host/package.json` + new `host/.npmignore` — the npm
  tarball was shipping `src/` + tests + configs (627 files / 4.9 MB
  unpacked) instead of the compiled `dist/` output. Now ships
  `dist/` + `package.json` (417 files / 2.5 MB), with proper
  `repository`, `bugs`, `homepage`, expanded `description`, and
  expanded `keywords` for npm-registry discoverability.
- **Tightened** `.gitignore` — added `.claude/settings.local.json`,
  `.claude/worktrees/`, `host/*.tgz`, `*.log`, control-plane local
  state (`signalman.db*`, `.signalman/{blobs,recordings}/`).

### History scrub + repo cleanup

- **Removed** the dormant `hub/` directory (122 LOC of TODO stubs).
- **Scrubbed** prior product-specific references from source, tests,
  scenarios, docs, and the entire git history (`git filter-repo`
  rewrote 60 prior commits).
- **Deleted** 10 stale WIP branches from origin (`fix/*`,
  `worktree-agent-*`, etc.) plus the dangling
  `loom/codex/add-scenario-orphan-cleanup-reaper` branch whose
  Loom task was marked `cancelled` after inspection.

### Security + license

- **Changed** License from MIT to Apache-2.0 across `LICENSE`,
  `NOTICE`, root `Cargo.toml`, `guest/Cargo.toml`,
  `plugins/signalman-loom-plugin/Cargo.toml`, `host/package.json`,
  and the README footer. All four package manifests now agree.
- **Removed** 14 product-specific scenario directories
  (`.signalman/scenarios/example-driver-v3-*`, `cursor-restrict`,
  `sandbox-enforcement`, `silo-validation*`; `examples/example/`).
  They moved to the consuming product's own repository.
- **Changed** Source code, tests, scenarios, and docs to remove
  all references to the original consuming product:
  `ComposeBuilder.exampleBackendStack()` → `backendStack()`,
  ETW session-name defaults, kernel-driver path defaults, test
  fixture product names, design-doc examples, ROADMAP narrative.
- **Security: fixed F4 (high)** — git-clone argument-injection guard
  at HTTP intake (`POST /v1/products`, `PATCH /v1/products/:id`,
  `POST /v1/releases`, `POST /v1/jobs` when `kind=release.build`).
  Adds `validateRepoUrl` + `validateGitRef` for option-injection
  defense (CVE-2017-1000117 family) and a `--` separator before
  positional args in every `git clone` invocation.
- **Security: fixed F3 (med-high)** — `signalman serve
  --disable-loopback-bypass` flag wired through the CLI; stale
  "until PR 7 lands" warning replaced with current-state guidance
  that mentions the new flag.
- **Security: fixed F5 (medium)** — `streamBody` HTTP routes now
  honor a `maxBodyBytes` route option (default 1 GiB, blob upload
  pinned at 1 GiB). Content-Length and running-total enforcement
  via a byte-counting `PassThrough` wrapping the raw
  `IncomingMessage`; returns 413 on cap exceed.
- **Security: fixed F1/F2 (low)** — docker compose-builder test-stack
  defaults (`test-password`, `test-secret-for-e2e`) replaced with
  per-call `crypto.randomBytes(32).toString("hex")` secrets.
- **Security: dependency bumps** — `rustls-webpki` 0.103.11 →
  0.103.13 (RUSTSEC-2024-0399); `@modelcontextprotocol/sdk`
  transitive bumps via `npm audit fix` (4 vulns).
- **Added** new validator unit tests
  (`host/src/__tests__/git-validation.test.ts`, 42 cases) and
  streamBody-cap router tests
  (`host/src/__tests__/http-router-streambody-cap.test.ts`, 4 cases).

### Networked control plane (HTTP serve, runners, signing, Postgres, S3)

The five v0.3-scoped PRs that landed on this branch. Tag candidates: ship
as `v0.3.0` once the operator decides on a version-bump strategy.

- **Added** `signalman serve` — HTTP control plane on `node:http`
  with bearer-token auth (`Authorization: Bearer sk_...`) and
  loopback bypass for local-mode workflows. Routes the full v0.2
  control-plane surface plus `/v1/api-keys`, `/v1/jobs`, `/v1/blobs`.
- **Added** `signalman runner register / start` — stateless runner
  workers that poll the control plane for `release.build` jobs,
  claim them atomically, clone the product repo at the release's
  tag, run the build executor against an `HttpControlPlane` shim,
  and upload the resulting artifacts.
- **Added** `signalman release build --remote` — submit-mode build
  that queues a `release.build` job onto the remote control plane
  instead of running in-process.
- **Added** `PostgresStorageDriver` — `pg`-backed implementation
  of the storage interface. Same migration files as SQLite (
  `host/src/control-plane/storage/migrations/`) run verbatim.
  Atomic job-claim via `SELECT FOR UPDATE SKIP LOCKED`. See
  `docs/postgres-driver.md` for the setup guide.
- **Added** Ed25519 manifest signing — `signalman key generate /
  fingerprint`, `signalman release build --sign --key <path>`,
  `signalman release verify <id> --public-key <path>`. Signs the
  canonical manifest JSON; verification checks the public-key
  fingerprint before the crypto verify so a wrong key fails fast.
- **Added** `S3BlobDriver` — `@aws-sdk/client-s3` implementation
  with content-addressed keys, presigned downloads via
  `@aws-sdk/s3-request-presigner`, and `resolveBySha(orgId, sha256)`
  for cross-driver URI reconstruction.

### Local in-process meta build system

The PR-1-through-PR-5 work that initiated the meta-build platform.

- **Added** Control-plane data model: products, releases, artifacts,
  targets, deployments, health checks, audit log, organisations, API
  keys, jobs. ULID PKs, ISO-8601 timestamps, partial unique indexes
  for soft-deletion. Same migration files run against SQLite +
  Postgres.
- **Added** `SqliteStorageDriver` — `node:sqlite` (built-in, no
  `better-sqlite3` dependency). Requires Node 22.5+.
- **Added** `LocalFsBlobDriver` — content-addressed,
  `<root>/<org_id>/<sha[0:2]>/<sha>` layout. Rejects path traversal
  via `..`/`/`/`\` in `orgId`; enforces hex-64 on sha256.
- **Added** `release build` verb — clones a product repo at a tag,
  runs each component's declared build command, captures artifacts
  into the blob store, computes a canonical manifest, writes the
  release row.
- **Added** `release deploy / rollback / list / show / verify` verbs.
- **Added** `target add / list / remove` verbs.
- **Added** `health check / history` verbs with the
  `vm_reachable` floor plus per-product declared probes from
  `signalman.build.yaml`.
- **Added** Design doc (`docs/design/meta-build-system.md`) — full
  architecture, schema, CLI surface, phasing.

## [0.1.x] — pre-public scenario-runner platform

The original Signalman surface that exists on `main` today. No
formal v0.1.0 / v0.1.1 tags shipped; the version was set in
manifests but no public release happened. STATUS.md describes the
operationally-frozen surface.

### Highlights

- **MCP surface (P0)** — six high-level verbs that constitute the
  agent contract: `list`, `describe`, `plan`, `run`, `record`,
  `status`. Hermetic result envelopes (scenario hash, agent version,
  events, duration). `signalman.advanced.*` namespace for direct
  VM/Docker tools behind an explicit opt-in.
- **Hyper-V control-plane service (P1)** — Rust crate
  (`service/`) that brokers privileged Hyper-V cmdlets via mTLS gRPC,
  eliminating per-call gsudo prompts. MSI-installable; runs under a
  dedicated service account with minimum Hyper-V Admin privileges.
  Named-pipe + localhost TCP transports.
- **Guest agent** — Rust agent (`guest/`) that runs inside each VM
  and exposes process control, command execution, file operations,
  and network / filesystem verification primitives over gRPC with
  bearer-token + optional mTLS.
- **Hypervisor backends** — Hyper-V (primary, Windows),
  Tart (macOS on Apple Silicon, `docs/mac-virtualization.md`),
  VMware Workstation (fallback, deprioritised).
- **Loom plugin** (`plugins/signalman-loom-plugin/`) — Rust crate
  registering `loom.signalman.*` MCP tools through Loom's
  trusted-plugin contract. State persists via Loom's
  `TaskOwnership`; events stream through Loom's `EventBus`;
  scenarios surface as descriptor-backed forms in `loom tui`.
- **Provisioning + bootstrap (P9)** — `signalman vm provision`,
  `signalman vm fetch-template`, `signalman vm install-bundle`,
  `signalman vm cleanup`, `signalman init`, software-bundle schema,
  end-to-end onboarding guide at `docs/bootstrap.md`.
- **UI sidecar** — `signalman-guest --ui-sidecar` interactive
  user-session sidecar with MCP tools for screenshots, UIA
  snapshot/find/wait, click, keyboard input, type;
  `vm_ui_open_url` / `vm_ui_navigate_url` browser primitives;
  loopback-only CDP implementation behind reserved `Browser*`
  RPCs.
- **Release pipeline** — signed-MSI release workflow at
  `.github/workflows/release.yaml`. Cert signing via
  `WINDOWS_CERT_BASE64` / `WINDOWS_CERT_PASSWORD` repo secrets;
  npm publish via `NPM_TOKEN`; crates.io publish via
  `CARGO_REGISTRY_TOKEN`. Tag-triggered (`v*.*.*`) with
  manifest-version-matches-tag validation.

### Audit closures

The April 2026 four-lens audit (QA / Architecture / PM / Security)
documented in `docs/STATUS.md` closed 8 of the original 13
findings: cert ACL hardening, client-cert pinning, loopback
enforcement, denylist parity, drop `cmd.exe /C` on SYSTEM path,
named-pipe SDDL, constant-time bearer-token compare, TLS 1.3
pin. The remaining findings either rolled forward into v0.2 / v0.3
work or remain documented limitations.

[Unreleased]: https://github.com/ambray/signalman/compare/HEAD
