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
exists at the UI browser MCP contract milestone. When the file
naming or assertion style drifts, update this doc — it is meant to track
the codebase, not to describe an idealized testing world.

## Current state

Counted at the UI sidecar CDP milestone from the test source itself (vitest
`it`/`test` calls and Rust `#[test]`/`#[tokio::test]` attributes); the
ROADMAP-quoted top-line numbers come from the same counting method.

| Language       | Level                       | Files | Tests | Location |
|----------------|-----------------------------|-------|-------|----------|
| TypeScript     | unit + smoke (in-process)   | 46    | 1048  | `host/src/__tests__/` |
| TypeScript     | verb integration (in-process) | 5   | 46    | `host/src/verbs/__tests__/` |
| Rust (guest)   | unit (mod tests)            | 9     | 131   | `guest/src/*.rs` `#[cfg(test)] mod tests` |
| Rust (service) | unit + integration          | 8     | 110   | `service/src/*.rs`, `service/tests/*.rs` |
| Rust (plugin)  | unit + integration          | 11    | 135   | `plugins/signalman-loom-plugin/src/*.rs`, `plugins/signalman-loom-plugin/tests/` |

Totals: **1094 TypeScript** test cases across 51 files, **376 Rust**
test cases across 28 files. ROADMAP.md reports `151 Rust + 769 TS = 920`
as an older rounded headline — the per-call count above is the more
granular number, and the per-class split here counts `it(...)`
invocations from the test sources directly rather than the post-vitest
run-time count (parameterized blocks expand at runtime). The 2026-05-09
host coverage run expanded to **1148** vitest cases across **51** files.

Two files are smoke tests within `host/src/__tests__/`:
`scenario-validation.test.ts` (4 cases — walks every scenario directory
and validates schemas) and `proto-shape.test.ts` (7 cases — pins the
v1 proto `oneof` shape). They are part of the 27-file row above; called
out here because the "When to add a smoke test" section below references
them.

Test counts on this branch are *static* (counted from source); CI does
not yet measure or enforce them. P7.1 turns on the
`service-windows` job that runs `cargo test --workspace`, and P7.2/D1
adds the first real cross-process integration test (`host TS ↔ service
Rust` over the wire). Until then, "tests pass on a contributor's
machine" is the verification surface.

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
`silo-validation` (or a purpose-built `smoke` scenario), asserts pass.

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
paths at **95%+**. Critical paths are: `host/src/scenarios/orchestrator.ts`,
`host/src/scenarios/assertions.ts`, `host/src/sanitize.ts`,
`host/src/output/envelope.ts`, the guest gRPC handlers
(`guest/src/service.rs`), and the plugin state store
(`plugins/signalman-loom-plugin/src/state.rs`).

As of the UI browser MCP contract milestone, **coverage measurement is not wired into CI**.
The tooling exists and can be run locally, and the current host run is
above the product target: `npm --prefix host run coverage` reports
**86.57% statements / 81.68% branches** across 1148 vitest cases.

- TypeScript: `cd host && npx vitest run --coverage`. The
  `@vitest/coverage-v8` package is already in `host/package.json`
  devDependencies.
- Rust: `cargo install cargo-llvm-cov` (one-time, per machine), then
  `cargo llvm-cov --workspace --html` and open
  `target/llvm-cov/html/index.html`.

When P7 wires coverage into CI, this section will document the
threshold gate and the badge URL.

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
  against a real scenario (`silo-validation` or a purpose-built
  `smoke`), and asserts on the envelope.
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
