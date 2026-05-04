# Supply Chain Notes

## `protoc-bin-vendored`

Signalman uses `protoc-bin-vendored` in the Rust guest and service build scripts so Windows, Linux, and macOS contributors get a pinned `protoc` binary through Cargo rather than relying on a mutable system install.

This is an intentional v0.1.x tradeoff:

- It keeps proto generation reproducible across local development, CI, and release builds.
- It avoids asking Windows operators to install and place `protoc.exe` on `PATH` before they can build the service or guest.
- The package is present only as a build dependency; it is not shipped in the runtime service or guest binaries.
- The lockfile pins the exact crate versions and platform packages consumed by the build.

Operational guardrails:

- Treat any `protoc-bin-vendored*` version bump as a supply-chain event and review the Cargo diff before merging.
- Keep generated proto shape pinned with `host/src/__tests__/proto-shape.test.ts` and `host/src/__tests__/proto-contract.test.ts`.
- Prefer replacing this dependency with a checked-in, signed, release-managed `protoc` tool only if the vendored crate becomes unmaintained, starts pulling unexpected platforms, or blocks reproducible release builds.

## `cargo-wix`

Signalman uses `cargo-wix` only as release/build tooling for the
service and guest MSI packages.

Decision:

- CI installs the pinned version with `cargo install cargo-wix --locked --version 0.3.9`.
- The local `scripts/release-dry-run.ps1` does not auto-install it; operators must install it explicitly before building MSIs locally.
- `cargo-wix` is not linked into or shipped with the Signalman runtime binaries.

Operational guardrails:

- Keep the version pin synchronized between `.github/workflows/release.yaml`, `scripts/release-dry-run.ps1`, and `docs/bootstrap.md`.
- Re-check the pin before bumping it, and prefer `--locked` so transitive versions stay constrained by the crate's lockfile.
