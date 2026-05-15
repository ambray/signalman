# Changelog

All notable changes to Signalman will land here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
aims for [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Cross-platform milestone (v0.4.0-4 / WS4). Lands first-class Linux
and macOS support across the guest agent and host hypervisor
surfaces, plus the explicit platform-capability machinery the host
orchestrator needs to skip-gate scenarios that require Windows-only
behaviour on non-Windows VMs.

Not wire-breaking. The new `install_software` sources are additive
string values; the `hypervisor.backend` union gains
`"libvirt" | "vmrun"` but existing values stay valid; the guest
proto is unchanged.

### Added (host hypervisor backends)

- `host/src/hypervisors/libvirt.ts` — libvirt / KVM backend driven
  by the `virsh` CLI (no native libvirt-node dep, so Windows CI
  keeps building). Covers lifecycle, snapshots, file transfer
  (via qemu-guest-agent JSON-RPC), and command execution.
  Constructor accepts an injectable `LibvirtExec` callback for
  tests, mirroring `cloud/tofu.ts`.
- `host/src/hypervisors/vmrun.ts` — parallel-track VMware
  Workstation / Fusion backend wrapping `vmrun`. Same shape as
  libvirt: injectable `VmrunExec`, stable error codes, S-14
  password redaction on every stderr egress. The existing
  `vmware.ts` (with its `govc` vSphere fallback) is unchanged.
  Operators opt in via `hypervisor.backend = "vmrun"`.
  Convergence onto a single VMware backend is tracked as a
  roadmap follow-up.
- New error classes `LibvirtBackendError` and `VmrunBackendError`
  with stable codes the orchestrator dispatches on without
  parsing CLI phrasing.

### Added (guest agent platform layer)

- `guest/src/platform/{windows,linux,macos,other}.rs` — new
  `Platform` trait the service layer dispatches through.
  Capability getters (`supports_ui_automation`,
  `supports_system_elevation`, `supported_package_sources`)
  let RPC handlers return a clean `Status::unimplemented`
  on platforms that don't implement a given operation,
  rather than letting the call hang on a sidecar that will
  never connect.
- All four `Platform` impls compile on every target; only the
  `Current` re-export is `cfg`-gated so trait tests can
  exercise each impl regardless of build host.

### Added (Linux SYSTEM-elevation)

- `process::start_process_as_system` on Linux now shells
  `sudo -n [-E] -- <path> <args>`. Sudoers refusal surfaces
  as `Status::permission_denied`; the agent's invoking user
  must have NOPASSWD configured for the commands the operator
  intends to run.
- `build_sudo_argv` is factored out as a free function so the
  argv shape is unit-testable on every build host.

### Added (install_software sources)

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

### Changed (cross-platform RPC behaviour)

- Windows-only RPCs (`ui_click` / `ui_type` / `ui_key` /
  `ui_find` / `ui_screenshot` / `browser_*` /
  `install_software` with Windows-only sources /
  `run_command(run_as="system")` on macOS) now return
  `Status::unimplemented` with a canonical
  "<feature> is not supported on <os>" message rather than
  failing through downstream subsystems.
- `ui_health` is the deliberate exception: keeps its
  OK-with-payload shape on non-Windows and reports
  `sidecar_reachable=false` with the canonical message in
  the `error` field, so existing host pattern-matching on
  that shape continues to work.
- `install_software` distinguishes three failure modes for
  an unrecognised source: wrong-platform →
  `Status::unimplemented`; typo / unknown source →
  `Status::invalid_argument`; empty source on Linux + macOS
  → `Status::invalid_argument` with a hint of the supported
  set (Windows still defaults to winget for backwards compat).

### Changed (selector + config)

- `host/src/hypervisors/selector.ts` registers libvirt and
  vmrun in `buildBackendList`. Platform-aware default
  ordering: Linux gets libvirt first, macOS keeps tart first,
  Windows keeps the existing service-first chain.
- `SignalmanConfig.hypervisor` adds `virshPath` and
  `libvirtUri` fields; the `backend` union now accepts
  `"libvirt" | "vmrun"` in addition to the existing values.
  Env overrides: `SIGNALMAN_VIRSH_BIN`,
  `LIBVIRT_DEFAULT_URI`.

### Tests

- Guest: +29 tests (147 → 159 over the WS4 commits, plus
  +12 from the follow-up sudo + package-manager work).
  Coverage of every `LinuxPlatform` / `MacosPlatform` /
  `WindowsPlatform` capability surface; cross-platform
  trait dispatch tests that exercise non-host impls from a
  Windows build host; argv-helper coverage for
  `build_sudo_argv`.
- Host: +85 tests (1795 → 1880). Libvirt argv composition,
  parser coverage with fixture files under
  `host/src/__tests__/fixtures/virsh-*.txt`, integration
  tests covering every `LibvirtBackendError` and
  `VmrunBackendError` code path, selector registration.
  Held-core coverage holds at 86.57% statements / 81.61%
  branches / 91.15% functions / 86.57% lines (well above
  the 80/70/80/80 floors).

### Deferred (tracked in ROADMAP)

- macOS UI automation parity with the Win32 UIA sidecar.
  Trait contract + unimplemented-message tests are in
  place; the AppleScript / Accessibility-API
  implementation requires a real macOS dev host.
- `vmrun.ts` + `vmware.ts` convergence. Deliberately
  deferred until `vmrun.ts` has seen at least one
  production scenario end-to-end so the merge target isn't
  unproven.

See ROADMAP §"2026-05-14 (v0.4.0-4 cross-platform
followups)" for both items' restart preconditions.

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
