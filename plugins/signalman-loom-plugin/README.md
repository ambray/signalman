# signalman-loom-plugin

Loom trusted-plugin that registers `loom.signalman.{list,describe,plan,run,status,record}` MCP tools backed by the Signalman scenario runner.

This crate is the **P5.1 deliverable** on Signalman's v0.1.0 critical path. See `ROADMAP.md` (P5) for the full Loom-fronted architecture rationale.

## Layout assumption

The plugin depends on Loom's crates via path dependencies, assuming this directory structure:

```
E:/source/repos/
├── signalman/
│   └── plugins/
│       └── signalman-loom-plugin/    <-- you are here
└── loom/
    └── crates/
        ├── loom-plugin-api/          <-- depended on
        └── loom-core/                <-- transitive dep
```

If your sibling layout differs, update the `path = "..."` entries in `Cargo.toml` accordingly. The crate is intentionally **outside** Signalman's main Cargo workspace so that `cargo check --workspace` from the Signalman root remains green when Loom is not present.

## Building

```bash
# From this directory:
cargo check
cargo test
```

## Linking into Loom

Loom discovers trusted plugins via the `inventory` crate at compile time. To make Loom load the Signalman plugin, add this crate as a dependency of `apps/loom` (or whichever Loom crate produces the final binary) and reference it from the binary's `main.rs` (an unused `use` statement is enough to force linkage; the `inventory::submit!` registration runs as a static initializer).

A `--features signalman` flag on `apps/loom` is the recommended entry point; the README's Quick Start walks the user through the build.

## Plugin contract (P5.1)

| Capability | Value |
|---|---|
| `RegisterMcpTools` | yes — six `loom.signalman.*` tools |
| `RunSubprocess { allowlist }` | `["signalman", "node"]` |
| Tier | `Free` |
| Stability | `Experimental` (graduates to `Stable` once the contract bakes) |

### Subprocess discovery

The plugin invokes:

1. `$SIGNALMAN_CMD` (space-separated; supports `node host/dist/cli.js` form)
2. otherwise `signalman` on PATH

The resolved program's basename (without extension) is validated against the allowlist before spawn. `cmd.exe`, `powershell`, `rm`, `/bin/sh` etc. are rejected as defense-in-depth on top of Loom's plugin-host enforcement of the `RunSubprocess` capability.

### What it does NOT do (yet)

P5.1 is intentionally a thin pass-through. The following arrive in subsequent P5 sub-phases:

- **P5.2 — Scenario↔Loom Task mapping.** Run handles persisted via Loom's `TaskOwnership` shape so they survive host restarts. Closes the audit C1 finding (run-handle in-memory `Map`).
- **P5.3 — Live event streaming.** Envelope events emitted into Loom's `EventBus` so agents can subscribe with `since_event_seq` long-poll semantics rather than the current post-hoc replay. Closes audit C2 + C10 (trace-id propagation via `TelemetryEvent.labels`).
- **P5.4 — Descriptor-backed forms.** Each scenario rendered as a `loom tui` command form with required/optional/validated fields.
- **P5.5 — Loom directive.** `validate-on-vm` directive surfacing "use Signalman for VM-based validation" defaults to Claude Code / Codex.

The `signalman.advanced.*` tools (raw VM/Docker ops, the `signalman_advanced_*` namespace from the standalone MCP server) are deliberately **not** re-exposed through this plugin. They remain behind the standalone MCP server's advanced namespace and are off the default agent loop. See ROADMAP §"What Signalman is today" and §P0.

## License

MIT. Same as Signalman.
