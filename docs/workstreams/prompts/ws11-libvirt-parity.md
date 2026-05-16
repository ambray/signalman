# WS11 — v0.5 libvirt parity

**Status:** redirected 2026-05-16. The original WS11 scope (VMware backend convergence — merge `vmware.ts` + `vmrun.ts`) was reassigned to a follow-up; the **actual** v0.5 hypervisor workstream is driving the existing `LibvirtBackend` to parity with `hyperv.ts` on Linux/KVM hosts.

**Authoritative sources:**

- Design doc: [`docs/design/v0.5-libvirt-parity.md`](../../design/v0.5-libvirt-parity.md) — locked decisions, conformance matrix vs `hyperv.ts`, QGA payload shapes, test taxonomy, definition of done.
- Workstream status: [`/.workstream-status-ws11.md`](../../../.workstream-status-ws11.md) — commits, tests-added inventory, 4-lens audit, deferred-demo runbook.

**Branch:** `feat/v0.5-libvirt-parity` (cut from `main`).

## What WS11 actually closes

Driven against `host/src/hypervisors/libvirt.ts` + its existing test pair (`host/src/__tests__/libvirt-{argv,backend}.test.ts`). Adds a third test file (`libvirt-system.test.ts`, gated by `SIGNALMAN_LIBVIRT_TESTS=1`).

Eight milestones:

- **M0** — Design doc + operator review (gate).
- **M1** — `executeCommand` polls `guest-exec-status` for real exit code + base64-decoded stdout/stderr. Replaces the submit-only stub.
- **M2** — `copyFileToVM` / `copyFileFromVM` use the real QGA `guest-file-open` → chunked `guest-file-write`/`read` → `guest-file-close` round-trip. Replaces the non-existent `guest-file-open-write`/`-read` verbs.
- **M3** — `getStatus.guestAgentReachable` probes `guest-ping`; `getVmIpAddress` walks lease → agent → arp source fallback.
- **M4** — Optional interface methods for parity: `waitForHeartbeat`, `setVmMemory`, `setVmProcessor`.
- **M5** — `createVM` builds a minimal q35 domain XML (virtio + QGA channel), creates a sparse copy-on-write qcow2 disk via `qemu-img create -b`, registers the domain via `virsh define`.
- **M6** — System-lane test against libvirt's deterministic in-memory `test:///default` driver. Linux-only, gated by `SIGNALMAN_LIBVIRT_TESTS=1`.
- **M7** — `.workstream-status-ws11.md` runbook + `docs/STATUS.md` + `docs/testing.md` updates. Real-VM demo log is operator-triggered and appended when run.

## Out of scope (deferred to later workstreams)

- **VMware backend convergence.** Original WS11 scope; tracked as v0.6+ work if it ever ships.
- **CLI/MCP/skill exposure of the new optional methods** (`waitForHeartbeat`, `setVmMemory`, `setVmProcessor`). Backend implementations land in WS11; surfacing them through `signalman vm …` verbs + MCP tools + Claude skills is its own workstream.
- **Real-VM provisioning demo.** Runbook lives in `.workstream-status-ws11.md`; operator runs when convenient and appends the log.
- **ProgressCallback wiring for `copyFile*`.** Interface accepts the callback; chunked transfer is wired but progress events aren't emitted yet.

## Historical note

The original `ws11-vmrun-vmware-convergence.md` prompt was added in commit `104d353` (2026-05-16) as part of the v0.5-cohort scoping pass. The operator redirected the scope later the same day after realizing the actual v0.5 hypervisor blocker on their dev host (Ubuntu 26.04 + libvirt + KVM) was the half-finished libvirt backend, not the parallel VMware tracks. This file is the rewritten successor; `git log --follow` will still show the original prompt content if a future operator wants the redirected-from context.
