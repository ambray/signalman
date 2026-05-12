# Contributing to Signalman

Thanks for your interest in contributing. This guide covers what to
expect when filing issues, setting up a dev environment, and sending
pull requests.

> **Looking for a security issue?** Please don't file it as a public
> issue — see [SECURITY.md](SECURITY.md) for our private reporting
> channel.

## What we welcome

- **Bug reports** with clear reproduction steps.
- **Feature suggestions**, especially ones grounded in a real use case
  (`I tried X and hit Y`).
- **Documentation fixes** — even a single typo is welcome.
- **Pull requests** for any open issue tagged `good first issue`,
  `help wanted`, or `bug`. For larger changes, please open an issue
  first to align on the design before you spend time on code.

If you have an idea but aren't sure whether it fits, opening a
discussion is fine — we'd rather hear early than have you write a PR
that doesn't land.

## Filing issues

Pick the closest issue template:

- **Bug report** — something is broken; you have steps to reproduce.
- **Feature request** — you want something Signalman doesn't do today.
- **Question / discussion** — you're not sure if it's a bug, or you
  want to talk through design choices.

For bugs, please include:

1. What you ran (`signalman ...` command, MCP tool call, or HTTP
   request).
2. What you expected.
3. What actually happened, including the full error output and the
   first 20-or-so lines of any stack trace.
4. Your environment — installed version (`npm ls @signalman/host`) or
   commit SHA (`git rev-parse HEAD`) if you built from source; OS;
   Node version (`node -v`); Rust version (`rustc -V`) if relevant.

## Dev environment

You need:

- **Node.js ≥ 22.5** — the TypeScript host uses the built-in
  `node:sqlite` module which lands in 22.5. Older Node versions
  will fail at startup.
- **Rust stable** — recent enough to satisfy the Cargo workspace
  (currently `edition = "2021"`).
- **protoc** — the gRPC stubs are generated at build time. Most
  package managers have a `protobuf` package; on Windows,
  `winget install Google.Protobuf` or `choco install protoc` works.
- **Git**.

Clone, install, build:

```bash
git clone https://github.com/<owner>/signalman.git
cd signalman

# Host (TypeScript) — CLI + MCP server + control plane
cd host
npm ci
npm run build

# Guest agent (Rust) — gRPC server that runs inside each VM
cd ../guest
cargo build --release

# Hyper-V control-plane service (Rust, Windows-only)
cd ..
cargo build -p signalman-service --release

# Loom plugin (Rust, requires Loom checked out alongside)
cd plugins/signalman-loom-plugin
cargo build --release
```

The Loom plugin lives outside the workspace because it has a
`path = "../../../loom"` dependency that's only resolvable if you have
the Loom repo checked out next to this one. If you don't have Loom,
skip it — nothing else depends on it.

## Running the tests

We run three test suites, all of which must pass in CI:

```bash
# Host (TypeScript) — 1400+ vitest tests
cd host
npm run lint       # ESLint, must report 0 errors
npx tsc --noEmit   # Type check
npx vitest run     # Test suite

# Guest (Rust)
cd ../guest
cargo fmt --check
cargo clippy -- -D warnings
cargo test

# Hyper-V service (Rust, Windows only)
cargo fmt -p signalman-service --check
cargo clippy -p signalman-service --all-targets -- -D warnings
cargo test -p signalman-service
```

The host suite includes integration tests that spin up real
control-plane servers, real S3 mocks, and a real local-FS blob store
under a tempdir. They run in-process so they're fast; you don't need
docker or a VM for any of them.

Two tests are marked `it.skip()` because they require a real Postgres
instance — they run in the CI matrix when a Postgres service container
is available, and locally if you set `SIGNALMAN_TEST_PG_URL`.

## Pull-request expectations

We don't have a heavy process, but a few things make review easier:

- **Tests for new code.** If you're fixing a bug, add a regression
  test that fails without your fix. If you're adding a feature, write
  at least one happy-path test and one failure-mode test.
- **Lint + type check clean.** `npm run lint && npx tsc --noEmit`
  should report zero errors. CI runs these on every PR.
- **Small PRs over large PRs.** A PR that touches 3 files is easier
  to review than one that touches 30. If you find yourself wanting
  to do "while I'm here" cleanup, split it into a second PR.
- **One topic per PR.** Mixing a feature + an unrelated refactor +
  a docs cleanup makes everything harder to review and revert.
- **Conventional Commit messages**: `<type>(<scope>): <subject>`.
  Common types: `feat`, `fix`, `docs`, `chore`, `refactor`, `test`,
  `security`. Scope is optional but helpful (e.g.
  `feat(http): add /v1/blobs/:sha256`).
- **Mention the issue your PR closes** in the description:
  `Closes #123`. GitHub auto-closes the issue when the PR merges.

### What we'll look for in review

The maintainer reviewing your PR will be checking:

- **QA**: does the change work, are there tests, do the tests
  actually exercise the new behavior (not just the happy path)?
- **Architecture**: does the code fit the surrounding patterns? If
  not, is there a good reason it doesn't?
- **Product**: does this change make Signalman better for the
  operators who depend on it, or does it solve a problem only the
  contributor cared about?
- **Security**: especially for control-plane changes, what's the
  surface area? Is auth involved? Does anything new read or write
  privileged paths?

You don't need to spell these out in your PR description — that's
our job — but knowing the lens helps you anticipate questions.

## Releases

Releases are tag-triggered. See `.github/workflows/release.yaml` for
the published pipeline (signed MSIs, npm publish, crates.io publish,
GitHub Release). The release-day checklist:

1. Bump the four version pins in lockstep:
   `host/package.json`, `guest/Cargo.toml`,
   root `Cargo.toml` (workspace), `plugins/signalman-loom-plugin/Cargo.toml`.
2. Run `pwsh scripts/release-dry-run.ps1` locally to catch packaging
   issues before pushing.
3. Commit the version bumps and tag: `git tag vX.Y.Z && git push
   origin vX.Y.Z`.
4. The workflow will validate manifest-version matches the tag before
   publishing — this catches the most common release-day mistake.

If you're contributing toward a release, you don't have to touch
versions. The maintainer doing the release will bump them.

## Working together

We try to keep this a project people enjoy contributing to: be
welcoming to newcomers, give people the benefit of the doubt, and
assume positive intent on both sides of a review. If something feels
off about an interaction, please flag it to the maintainers privately
(see [SECURITY.md](SECURITY.md) for contact paths).

## License

By submitting a contribution, you agree your work is licensed under
the Apache License 2.0 — the same license as the rest of the
project. See [LICENSE](LICENSE) for the full text.
