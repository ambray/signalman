# WS4 starting prompt — Cross-platform (v0.4.0-4)

Paste the block below into a fresh Claude Code session that has shell + write access to `C:\Users\ucale\source\repos\signalman-cross-platform`.

---

You are working on Signalman, an agent-first DevOps platform. Host is TypeScript (`host/`), guest agent is Rust (`guest/`). The guest crate compiles on Linux today but `ProcessInspect` is Win32-only. The host hypervisor backends cover Hyper-V (Windows) and Tart (macOS); libvirt (Linux) and vmrun (VMware) are missing. Main is at `558e0ed`.

**Your worktree**: `C:\Users\ucale\source\repos\signalman-cross-platform` — branch `feat/v0.4.0-cross-platform`. `cd` there. All git ops from inside that worktree. **Do NOT push to origin.**

## Orientation reading (in order, before any code)

1. `docs/workstreams/PLAN.md` in your worktree if present — cross-stream coordination rules
2. `CLAUDE.md` at repo root — Loom protocol
3. `guest/src/service.rs` — current gRPC service impl (very large; read in chunks)
4. `guest/Cargo.toml` — target features + platform-conditional deps
5. `host/src/hypervisors/interface.ts` — `HypervisorBackend` contract (parallels cloud abstraction)
6. `host/src/hypervisors/hyperv.ts` — reference Windows impl
7. `host/src/hypervisors/tart.ts` — reference macOS impl (NB: file is `tart.ts`, **not** `tart-backend.ts`)
8. `host/src/hypervisors/vmware.ts` — **already exists**; before starting Chunk 3, clarify with operator whether your `vmrun.ts` is a parallel-track backend or a rename/replacement
9. `proto/signalman_service.proto` — RPC surface
10. `docs/design/meta-build-system.md` and ROADMAP.md "E3 — Linux/macOS guest agent" entry

## Your milestone — three chunks; ship in order

Ship at least Chunk 1 complete. Chunks 2 + 3 may slip to a followup session if scope runs over. **Do not** half-ship a hypervisor backend.

### Chunk 1: Guest agent platform split (must ship)

- Reorganise `guest/src/` so platform-conditional code lives in `platform/{windows,linux,macos}.rs` behind a trait the service layer dispatches through
- Implement Linux + macOS versions of the **portable** RPCs: Health, Register, RunCommand, TestNetwork, TestFileAccess (these don't need OS-specific introspection)
- Windows-only RPCs (ProcessInspect via UIA, UI element selectors, kernel-debug attaches) return `Status::unimplemented("not supported on linux/macos")` on non-Windows platforms — clear message, not a silent panic
- Cargo features / cfg-conditional compilation: `#[cfg(target_os = "windows")]`, `linux`, `macos`. `cargo test` (default) and `cargo test --all-features` both green on the build host
- Update `guest/Cargo.toml` deps so Win32-only crates only pull in on Windows

### Chunk 2: libvirt host hypervisor backend

- `host/src/hypervisors/libvirt.ts` implementing `HypervisorBackend`
- Subprocess-driven via `virsh` (do NOT pull libvirt-node native deps — subprocess pattern matches the existing convention and avoids native-build pain on Windows CI)
- Methods: `provisionVm`, `terminateVm`, `snapshotVm`, `restoreVm`, `copyFileTo`, `runGuestCommand` (proxy to guest agent), `getIpAddress`
- Inject `exec` for testability (mirror `host/src/cloud/tofu.ts`'s `defaultExec` pattern)
- New error class `LibvirtBackendError` with stable codes: `virsh_not_found`, `vm_not_found`, `snapshot_failed`, `network_unavailable`, `guest_agent_unreachable`, etc.

### Chunk 3: vmrun host hypervisor backend (clarify scope first)

**Pre-check**: existing `host/src/hypervisors/vmware.ts` may already cover this. Read it before scoping. If it's a different vendor surface (e.g. vSphere), `vmrun.ts` is parallel-track. If it's the same surface, this chunk becomes "extend `vmware.ts` to use vmrun CLI."

- Same shape as libvirt — subprocess-driven via VMware Fusion / Workstation `vmrun` CLI
- Injectable exec
- New error class `VmrunBackendError` with stable codes

## Reserved blocks (don't collide with other workstreams)

- Migration block: **none** (this stream doesn't need control-plane schema)
- No new MCP tools in this milestone (hypervisor backends register via the existing `registerHypervisorBackend` pattern)

## Test taxonomy — write all three layers

**Rust guest crate:**
- Unit: per-platform module exports the expected fn set; trait dispatch picks the right impl by `cfg`
- Integration: trait-based tests that inject the platform impl rather than relying on real OS
- Confirm `Status::unimplemented` paths return cleanly (not panic)

**Host TS:**
- Unit: virsh / vmrun argv composition; error-code dispatch; XML parsing for `virsh dominfo` output (fixture under `host/src/__tests__/fixtures/`)
- Integration: each backend with injected exec stub returning canned XML/text; registry registration like `host/src/cloud/registry.ts`
- System: full VM lifecycle (provision → snapshot → restore → terminate) via injected exec, asserting argv sequences

Tests in `host/src/__tests__/`: `libvirt-backend.test.ts`, `libvirt-argv.test.ts`, `vmrun-backend.test.ts`, `hypervisor-cross-platform-integration.test.ts`. For Rust, follow patterns already in `guest/src/`.

## Definition of Done (must pass at each chunk completion)

**Host TS:**
1. `cd host && npm test` — full suite green
2. `cd host && npx tsc --noEmit` — zero errors
3. `cd host && npm run coverage -- --testTimeout=30000` — ≥80% lines / ≥70% branches / ≥80% functions / ≥80% statements

**Guest Rust (Chunk 1):**
4. `cd guest && cargo build --all-features` — zero errors
5. `cd guest && cargo test --all-features` — green
6. `cd guest && cargo clippy --all-features -- -D warnings` — zero warnings

7. **4-lens audit completed** at the end of each chunk — write a `## 4-lens audit` section in `.workstream-status.md` covering QA / Architecture / Product / Security, each ending **PASS** or **specific concern**. **Required** — three chunks = three audit cycles.
8. Commits ready (Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>) but **NOT pushed**.

## Commit pattern

- Chunk 1: ~3 commits (refactor → linux impl → macos impl; or one-shot if cleaner)
- Chunk 2: ~3 commits (driver + tests, integration tests, registry wiring)
- Chunk 3: ~2-3 commits (same pattern)
- Subject format: `feat(v0.4.0-4): <what> (cross-platform chunk N)`

## Status report (when complete)

Write `.workstream-status.md` at the worktree root with sections:
- `## Commits`, `## Tests added` (per language), `## Coverage` (host % + guest test count), `## 4-lens audit` (one per chunk), `## Deferred`, `## Operator review needed`

Return a ≤300 word summary.

## Conventions

- Rust: standard rustfmt + clippy; explicit `unimplemented!()` not silent panics; thiserror for error types if already used in the crate (check existing)
- TypeScript strict; no `any` without justifying comment
- No emojis
- Read CLAUDE.md; use Loom MCP tools if available

Start by `cd C:\Users\ucale\source\repos\signalman-cross-platform`, read orientation files, **especially `vmware.ts`** to scope Chunk 3 correctly, then plan, then implement.
