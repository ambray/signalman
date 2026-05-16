# Testing strategy

## Why this doc exists

The 2026-04-25 four-lens audit (QA / Architecture / PM / Security)
flagged the Signalman test pyramid as **inverted-T**: a wide unit base
across host TypeScript and the Rust crates, three real integration tests
in the entire repo, and zero system / smoke / E2E tests that boot a real
VM or cross a real process boundary. P7 (CI Pipeline + Test Pyramid) and
P6 D5 (this document) are the audit's response. P7 fills in the missing
levels; this doc tells contributors which level a new test belongs at,
so additions don't pile onto the unit base by default.

This doc is intentionally repo-aware. Every example is a file that
exists in the current tree (2026-05, post WS3/4/5/6 + Wave-3). When
the file naming or assertion style drifts, update this doc — it is
meant to track the codebase, not to describe an idealized testing
world.

## Current state (2026-05)

Counted from the test source itself (vitest `it`/`test` calls and
Rust `#[test]`/`#[tokio::test]` attributes). Numbers are static
source counts — vitest run-time expansion of parameterized blocks
(`it.each`, `describe.each`) typically produces 10–15% more cases at
run time than this static count.

| Language       | Level                         | Files | Tests | Location |
|----------------|-------------------------------|------:|------:|----------|
| TypeScript     | unit + smoke (in-process)     | 137   | ~2400 | `host/src/__tests__/` |
| TypeScript     | verb integration (in-process) | 5     | 55    | `host/src/verbs/__tests__/` |
| TypeScript     | registry (in-process)         | 14    | ~250  | `registry/src/**/*.test.ts` |
| Rust (guest)   | unit (mod tests)              | ~10   | ~150  | `guest/src/*.rs` `#[cfg(test)] mod tests` |
| Rust (service) | unit + integration            | ~10   | ~140  | `service/src/*.rs`, `service/tests/*.rs` |
| Rust (plugin)  | unit + integration            | ~13   | ~180  | `plugins/signalman-loom-plugin/src/*.rs`, `plugins/signalman-loom-plugin/tests/` |

Totals: **~2700 TypeScript** test cases across 156 files, **~470 Rust**
test cases across 33 files. (The doc-original 2026-04 counts were
**1112 TS / 378 Rust** — the ~2x growth reflects WS3 promotion/webhook/
scheduler, WS4 cross-platform parity, WS5 registry, WS6 cloud + k8s,
and Wave-3 hardening all shipping into the same source tree.)

### What's been added since the 2026-04 audit

Each of these brought a sizable test surface; they all live in
`host/src/__tests__/` (verb-level slices in `host/src/verbs/__tests__/`)
unless noted:

| Surface | Notable test files |
|---|---|
| **WS3 — Auto-promotion (Epic 1)** | `promotion-policy.test.ts`, `promotion-health-gate.test.ts`, `cli-promotion.test.ts`, `server-promotion-tools.test.ts` |
| **WS3 — Webhooks (Epic 2)** | `webhook-dispatcher.test.ts`, `webhook-hmac.test.ts`, `webhook-slack.test.ts`, `webhook-e2e.test.ts` |
| **WS3 — Scheduled health (Epic 3)** | `health-scheduler.test.ts`, `health-scheduler-integration.test.ts`, `health-verbs.test.ts` |
| **WS4 — Cross-platform parity** | `tart-backend.test.ts`, `libvirt-backend.test.ts`, `libvirt-argv.test.ts`, plus guest-side `platform/` unit tests |
| **WS11 — v0.5 libvirt parity** | `libvirt-backend.test.ts` (extended), `libvirt-argv.test.ts` (extended), `libvirt-system.test.ts` (new — real `virsh` against `test:///default`, gated by `SIGNALMAN_LIBVIRT_TESTS=1`) |
| **WS5 — Registry** | `registry/src/**/*.test.ts` (14 files), plus host-side `signalman-registry-blob.test.ts`, `cloud-registry.test.ts` |
| **WS6 — Cloud + k8s** | `cloud-{aws,azure,connection,cost,credentials,deploy,dialers,plan-cost,reaper,registry,tofu,types}.test.ts`, `k8s-{driver,helm,kubectl,executor-integration}.test.ts`, `runner-deploy-k8s.test.ts`, `cli-cloud-*.test.ts`, `server-{cloud,k8s}-tools.test.ts` |
| **Release-signing (cross-wave)** | `signing.test.ts`, `release-signing-e2e.test.ts` |

Two files remain the canonical **smoke tests** within
`host/src/__tests__/`: `scenario-validation.test.ts` (walks every
scenario directory and validates schemas) and `proto-shape.test.ts`
(pins the v1 proto `oneof` shape). The "When to add a smoke test"
section below still references them.

Test counts on this branch are *static* (counted from source). CI
does run the host + registry vitest suites and `cargo test --workspace`
on PR, but does not yet enforce a coverage gate — see the
[Coverage](#coverage) section below for the current local numbers.

## The five test classes

When you reach for a test, pick the lowest level that catches the bug
class you care about. Levels are listed cheapest-first; a unit test
that runs in 8ms 50 times a day beats an E2E test that runs in 12min
once a night for nearly every defect.

### 1. Unit tests — pure logic, mocked I/O

A unit test exercises one function or one module. It does not spawn
subprocesses, open sockets, or touch the filesystem outside a tempdir.
External dependencies are replaced with mocks (`vi.mock` for TS,
`vi.fn`-style stubs for client objects, hand-rolled fakes for Rust
traits).

Canonical examples in this repo:

- `host/src/__tests__/sanitize.test.ts` — 59 cases over the seven
  validators in `sanitize.ts`. No I/O at all.
- `host/src/__tests__/envelope.test.ts` — 14 cases over result-envelope
  shape and hashing.
- `guest/src/main.rs auth_tests` (sub-mod, line 552) — bearer-token
  parsing, constant-time compare, allow-insecure invariants. Pure logic,
  no listener.
- `host/src/__tests__/docker.test.ts` — uses `vi.mock("node:child_process",
  ...)` (lines 9-13) to fake `execFile`. This is the **canonical mocking
  pattern** for host TS unit tests; copy this when you mock `node:`
  modules.

When to add a unit test: any new pure function, schema validator,
sanitizer, helper, or stateless transformer. If you're tempted to
write a unit test that requires a fake gRPC server, that's a sign
you should be writing an integration test instead.

### 2. Integration tests — multi-module, in-process

An integration test wires multiple modules together inside a single
process. No subprocess, no real network, no real VM — but the modules
exercise their real interfaces with each other. Trait implementations
are real; only the leaves (the Hyper-V dispatcher, the guest gRPC
server) are mocked.

Canonical examples:

- `service/tests/named_pipe_smoke.rs` — Rust↔Rust gRPC over a Windows
  named pipe. Spins up a real `tonic` server bound to the pipe, drives
  it from a real client. Integration without a second process.
- `host/src/__tests__/orchestrator.test.ts` — orchestrator + mocked
  hypervisor backend + mocked guest client. Real scenario YAML, real
  assertion eval, real lifecycle wiring.
- `host/src/__tests__/orchestrator-events.test.ts` — narrower test that
  pins live-emit propagation: the orchestrator's `(event) => void`
  hook fires synchronously as steps complete. Closes P3 C2-residual.
- `plugins/signalman-loom-plugin/tests/run_lifecycle.rs` — plugin's
  state-store lifecycle including plugin recreation. Exercises
  `state.rs` end-to-end with a tempdir-backed store.
- `host/src/verbs/__tests__/run-lifecycle.test.ts` — the six-verb
  surface end-to-end with mocked executor.

When to add an integration test: behavior that crosses module
boundaries (orchestrator + scenario loader + assertion eval; plugin
state + plugin handlers; gRPC service + transport + sanitize). If
your only assertions are on a single function's return value, drop
to a unit test.

### 3. System tests — multi-process or external dependencies

A system test crosses a process boundary or requires an external
dependency the test harness does not own. Two real OS processes
talking over a real socket. A real `signalman-service` binary that the
test must spawn and tear down.

The 2026-04-25 audit found **zero** of these in the v0.1.0 codebase.
The slot is reserved for **P7.2 D1** — the proto contract test that
spins up `signalman-service` (or a tonic server backed by `MockBackend`)
on a TCP port in CI and drives it through the real `@grpc/grpc-js`
client from the host. See ROADMAP.md "P7.2 — Real integration tests"
for the design.

When P7.2 D1 lands, this section graduates to "How to add a system
test." Until then, the absence is itself the test-pyramid hole the
audit named.

### 4. Smoke tests — fast, broad coverage

A smoke test runs in seconds (under 10s as a class — see invariants
below) and walks a wide surface to catch contract drift cheaply. It
does not exercise behaviors deeply; it asks "is anything fundamentally
broken?" and bails early.

Canonical examples:

- `host/src/__tests__/scenario-validation.test.ts` — walks every
  scenario in `.signalman/scenarios/` and `examples/`, calls
  `parseSetup` and `parseAssertions`, and fails on the first schema
  error. Catches "rotted scenario" bugs in 4 cases.
- `host/src/__tests__/proto-shape.test.ts` — pins the v1 proto `oneof`
  shape so a stray rebuild of `proto/guest.proto` can't silently change
  the wire contract.

When to add a smoke test: catching schema or contract drift cheaply.
If a single test can guard "does the codebase still parse / load /
type-check at the protocol level," it belongs here.

### 5. End-to-end (E2E) — real VM, real binary, real scenario

An E2E test boots a real Hyper-V VM, runs the actual `signalman` CLI
binary, executes a real scenario, and asserts on the resulting
envelope. Reserved for **P7.3 D4**: a single E2E gated by
`SIGNALMAN_E2E=1`, run nightly on a self-hosted Windows runner, **not**
on PR. Restores a known checkpoint, runs `signalman.run` against
a smoke scenario (e.g. `service-backend-smoke`), asserts pass.

When this lands, the section will document:

- How to provision the self-hosted Windows runner.
- The checkpoint contract (which checkpoint name the test expects).
- The escape valve for "my PR broke something the nightly catches" —
  re-run on demand via workflow_dispatch.

Until D4 ships, no test in this repo boots a VM. Treat that as a known
gap, not a contract.

## How to add a test — checklist

A practical checklist for a new test, in the order the questions arise.

**1. Pick the language.**

- Host code, scenario engine, MCP server, hypervisor backends, Docker
  client → TypeScript (vitest).
- Guest agent, hypervisor service, Loom plugin → Rust (built-in
  test runner, `tokio::test` for async).

**2. Pick the level.**

Use the section above. Default to unit. Reach for integration only when
a single function isn't enough. Reach for system / E2E only when in-
process won't catch the bug class.

**3. Use the repo's conventions.**

- TypeScript: `vitest`. Use `describe / it / expect`. Mock `node:` and
  third-party modules with `vi.mock(...)` at module top — see
  `docker.test.ts` (lines 9-13) as the canonical pattern. Mock client
  objects with `vi.fn()` returning resolved promises.
- Rust async: `#[tokio::test]` with `#[tokio::test(flavor =
  "current_thread")]` if you need single-threaded determinism.
- Rust sync: plain `#[test]`.
- Both: tests live next to or beside the code, not in a parallel
  fixture tree.

**4. Where to put the file.**

| Code being tested | Test file |
|---|---|
| Host TS — module under `host/src/` | `host/src/__tests__/<name>.test.ts` |
| Host TS — verb under `host/src/verbs/` | `host/src/verbs/__tests__/<name>.test.ts` |
| Guest Rust — unit (single module) | same file: `#[cfg(test)] mod tests { ... }` at bottom |
| Service Rust — unit (single module) | same file: `#[cfg(test)] mod tests { ... }` at bottom |
| Service Rust — integration (cross-module) | `service/tests/<name>.rs` |
| Plugin Rust — unit | `plugins/signalman-loom-plugin/src/<module>.rs` mod tests |
| Plugin Rust — integration | `plugins/signalman-loom-plugin/tests/<name>.rs` |

**5. Naming.**

- Rust test functions: `snake_case`, narrate behavior. Good:
  `record_started_writes_initial_state`, `auth_rejects_empty_token`.
  Avoid: `test1`, `it_works`.
- vitest `it(...)` strings: imperative camelCase / sentence case
  describing observable behavior. Good: `it("issues a run_id
  immediately, then streams events")`. Avoid: `it("works")`.
- vitest `describe(...)` strings: the unit under test (module name,
  function name, or feature). Good: `describe("sanitizeVmName")`.

**6. Shared state, env vars, filesystem.**

This is where Rust's parallel test runner bites if you're not careful.
Concrete patterns:

- TypeScript filesystem: `os.tmpdir()` + `fs.mkdtempSync(...)` for a
  per-test temp directory. Clean up in `afterEach` if you care, or
  rely on OS-level cleanup if you don't.
- Rust filesystem: `tempfile::tempdir()`. The `TempDir` drops at end
  of scope and removes the directory.
- Rust env vars: `cargo test` runs tests in parallel by default within
  a crate. Two tests that both `std::env::set_var("FOO", ...)` race.
  Either: (a) save and restore the prior value with a guard, or
  (b) collapse both paths into one test that exercises them
  back-to-back. The plugin crate uses pattern (b) — see
  `plugins/signalman-loom-plugin/src/subprocess.rs` test
  `resolve_command_handles_env_var_lifecycle` (line 134) for the
  canonical example. Pattern (a) requires a mutex (`std::sync::Mutex`
  in a `OnceLock`); if you need it, copy the pattern from a similar
  Rust crate, don't invent one.
- TypeScript env vars: `vi.stubEnv(...)` + `vi.unstubAllEnvs()` in
  `beforeEach`/`afterEach`. Vitest doesn't share process env across
  workers by default, but in-file races are still possible.

**7. Mocks vs. real.**

- Real where cheap and deterministic: in-memory state stores, real
  YAML/JSON parsing, real schema validation, real assertion
  evaluation.
- Mocked where expensive or non-deterministic: subprocess spawns
  (`child_process.execFile`), gRPC servers (mock the client trait),
  Win32 calls, network sockets, file watchers.
- The seam usually lives at the I/O boundary. If you find yourself
  mocking three layers deep, the design probably wants a trait /
  interface at the seam — refactor first, test second.

## Running tests

Run from the repo root unless noted.

| What | Command |
|---|---|
| Full host suite | `cd host && npm test` |
| Single host file | `cd host && npx vitest run src/__tests__/<file>.test.ts` |
| Host watch mode | `cd host && npx vitest` |
| Single host test by name | `cd host && npx vitest run -t "<test name fragment>"` |
| Rust workspace | `cargo test --workspace` |
| Single Rust crate | `cargo test -p signalman-guest` |
| Single Rust crate (service) | `cargo test -p signalman-service` |
| Single Rust test | `cargo test -p signalman-guest <test_name>` |
| Loom plugin | `cd plugins/signalman-loom-plugin && cargo test` |
| Type-check host only | `cd host && npx tsc --noEmit` |
| Lint host | `cd host && npm run lint` |
| Lint Rust | `cargo clippy --workspace -- -D warnings` |
| Format Rust | `cargo fmt --check` |

The Loom plugin has a path dependency on the Loom crate. From a fresh
worktree under `.claude/worktrees/`, `cargo test` for the plugin will
fail to resolve the Loom path-dep. Run plugin tests from a normal
checkout where Loom is checked out as a sibling directory of
Signalman.

## Coverage

The product target is **80% line coverage minimum**, with critical
paths at **95%+**. Critical paths grew with each wave; the current
list is:

- `host/src/scenarios/orchestrator.ts`, `host/src/scenarios/assertions.ts`
- `host/src/sanitize.ts`, `host/src/output/envelope.ts`
- `host/src/control-plane/build/signing.ts` (Ed25519 release signing)
- `host/src/control-plane/events/{dispatcher,hmac,slack}.ts` (WS3 webhooks)
- `host/src/control-plane/promotion/listener.ts` (WS3 auto-promotion)
- `host/src/control-plane/scheduler/runner.ts` (WS3 scheduled health)
- `host/src/control-plane/cloud/credentials.ts` (per-org AES-GCM creds)
- `host/src/control-plane/storage/{sqlite,postgres}.ts` (storage drivers)
- `registry/src/manifest/signing.ts`, `registry/src/http/forensic.ts`
- The guest gRPC handlers (`guest/src/service.rs`) and the
  guest `Platform` trait impls (`guest/src/platform/`)
- The plugin state store (`plugins/signalman-loom-plugin/src/state.rs`)

CI runs both the host vitest suite and `cargo test --workspace` on PR,
but **coverage thresholds are not yet enforced in CI**. The tooling
exists and can be run locally:

- TypeScript host: `npm --prefix host run coverage`. The most recent
  local run reports **>85% statements / >80% branches** across the
  full ~2400-case host suite.
- TypeScript registry: `npm --prefix registry run coverage`. The
  registry suite gates at the WS3 product targets (80% lines, 95% on
  signing / forensic paths).
- Rust: `cargo install cargo-llvm-cov` (one-time, per machine), then
  `cargo llvm-cov --workspace --html` and open
  `target/llvm-cov/html/index.html`.

Threshold enforcement in CI is gated on the OSS-hygiene trio epic
(see [STATUS.md](STATUS.md)) — once that lands, this section will
document the per-package thresholds, the badge URL, and the gate
that blocks PRs that regress coverage on a critical path.

## New test patterns since v0.2.0

A few patterns are worth calling out so future contributors copy from
the right canonical example rather than inventing a parallel shape:

### Storage drivers: pg-mem + better-sqlite3

`host/src/__tests__/postgres-storage.test.ts` runs the full
`StorageDriver` contract against [`pg-mem`](https://github.com/oguimbal/pg-mem),
an in-memory Postgres-compatible engine. Two semantics are
`it.skip("[integration only] …")` because pg-mem doesn't faithfully
emulate `SELECT … FOR UPDATE SKIP LOCKED` or concurrent-claim under
real connection pooling — see [postgres-driver.md](postgres-driver.md)
for the operator-validated escape path. SQLite tests run against
real `better-sqlite3` with a tempdir-backed file.

### Cloud backends: provider SDK mocks at the boundary

`host/src/__tests__/cloud-aws.test.ts` and `cloud-azure.test.ts`
mock the AWS SDK / Azure SDK clients at the **client object** boundary
(not the HTTP layer). The pattern: `vi.mock("@aws-sdk/client-ec2",
...)` returns a fake `EC2Client` whose `send()` method is a `vi.fn()`.
This keeps tests fast and deterministic. LocalStack / Azurite is the
operator-validated path for "did we get the SDK call right" — out of
scope for CI in v0.4.x.

### Hypervisor backends: argv shape + CLI-mock

Each `HypervisorBackend` impl has a paired argv test (`libvirt-argv.test.ts`,
`tart-backend.test.ts`) that asserts the exact subprocess argv the
backend would invoke for each lifecycle verb. The dispatcher is
`vi.mock("node:child_process")`'d so no real `virsh` / `tart` / `vmrun`
binary is required in CI. Real-backend smoke testing happens on
operator hosts — see [bootstrap.md §5–§6](bootstrap.md).

### Webhook signature verification

`webhook-hmac.test.ts` exercises HMAC-SHA256 over the canonical JSON
payload using `crypto.timingSafeEqual` for constant-time compare. The
test asserts both the success path and the negative path (modified
body, wrong key, wrong header format). Copy this pattern when adding
any new outbound-signed surface.

### Scheduler tick + fake clock

`health-scheduler-integration.test.ts` is the canonical example of
how to drive a time-based listener (the scheduler ticks every minute
looking for `last_run_at` older than `interval_seconds`). Use the
`fakeNowAfter(schedule, offsetMs)` helper which anchors the fake
clock to the row's real `createdAt` — naive `vi.setSystemTime()` will
race with the row insert and produce flaky tests.

## libvirt system lane (v0.5 WS11)

A focused system lane sits between the fully-mocked
`libvirt-backend.test.ts` integration suite and the Hyper-V-anchored
E2E lane above. It drives the **real** `virsh` binary against
libvirt's in-memory test driver (`test:///default`), which ships
with libvirt itself — no QEMU, no storage pools, no real network.

```bash
# Linux host with libvirt-clients installed:
SIGNALMAN_LIBVIRT_TESTS=1 npm test -- libvirt-system
```

Properties:

- Gated by `SIGNALMAN_LIBVIRT_TESTS=1`. Default invocations skip
  the suite (and the file's seven cases collapse to one always-on
  documentation case).
- Linux-only (`describe.skipIf` checks `process.platform`).
- Catches parser / argv drift that the mocked suite can't see —
  e.g. a virsh point release changing the `domifaddr` column shape.
- Runs in <1 second when enabled; no operator-side fixtures
  required because the test driver is fully self-contained inside
  the libvirt daemon.

## Gated E2E lane (preview — P7.3 D4)

This section is a placeholder for the lane that lands with P7.3 D4.
Reserved shape:

```bash
# Run on the self-hosted Windows runner only:
SIGNALMAN_E2E=1 cargo test -p signalman-e2e
# (or the equivalent npm script if E2E lives in host/)
```

Properties of the lane:

- Gated by the `SIGNALMAN_E2E=1` environment variable. Default cargo /
  vitest invocations skip the suite.
- Runs nightly on a self-hosted Windows runner. **Not** PR-gated.
  Failures surface in the CI dashboard as a separate workflow.
- Each test restores a known Hyper-V checkpoint, runs `signalman.run`
  against a real scenario (e.g. `service-backend-smoke`), and asserts
  on the envelope.
- Test wall-clock budget: 5–30 minutes per test.
- Re-run via `workflow_dispatch` when triaging a PR-suspect failure.

Until this ships, no test in this repo boots a VM.

## Test-pyramid invariants

Operating principles. Use these as criteria when reviewing test
additions, not just when writing them.

1. **The pyramid is wide at the unit base, narrow at E2E.** A repo
   with more E2E tests than unit tests is slow and flaky and won't
   stay healthy. Push tests down the pyramid whenever feasible.
2. **Smoke tests must run in under 10s as a class.** If a smoke test
   crosses the 10s budget, it has graduated to integration — move it,
   re-tag it, or shrink it.
3. **Unit tests must NOT spawn subprocesses or open network sockets.**
   If you need to mock `child_process.spawn`, you're writing a unit
   test. If you need a real subprocess, you're writing an integration
   or system test — pick one and put it in the right file.
4. **Integration tests SHOULD use tempdirs.** Never write to
   `~/.signalman/`, `%ProgramData%\Signalman\`, or any other
   user-writable persistent path. Use `tempfile::tempdir()` (Rust) or
   `fs.mkdtempSync(os.tmpdir(), ...)` (TS).
5. **E2E tests MAY take 5–30 min and require external resources** (a
   real Hyper-V host, a checkpoint, a service binary). They MUST be
   gated, never PR-blocking on first run.
6. **Every cross-process contract needs at least one test pinning its
   shape.** The contracts that matter today:
   - host TS ↔ `signalman-service` Rust gRPC (P7.2 D1 — **open**).
   - host TS ↔ guest agent gRPC (covered in part by mock-backed
     orchestrator tests; no real-wire test).
   - Loom plugin ↔ Signalman CLI (covered by
     `plugins/signalman-loom-plugin/tests/run_lifecycle.rs` for the
     plugin state side; no real CLI subprocess test).

   The audit's "inverted-T" finding is principle 6 written as a
   measurement: today the host-TS↔service-Rust contract has zero
   real-wire tests. P7.2 D1 closes that.

## When this doc is wrong

This doc is meant to track the codebase. If you find a test pattern in
the repo that contradicts this doc, the codebase is the source of
truth — update this doc in the same PR. If you're adding a new test
class (e.g., a fuzzing lane, a property-based suite), add a section
here so the next contributor knows the level exists.
