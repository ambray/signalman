# Public-release runbook

End-to-end operator procedure for taking Signalman from "structurally
public-ready on a private repo" to "publicly visible v0.4.0 release
with working publish pipeline."

This runbook is the executable closure of the open items in
[`docs/STATUS.md`](../STATUS.md) §Public-release status. WS12
(2026-05-16) prepared everything that lands in-tree; the actions
below are operator-only because they mutate GitHub-side state
(secrets, visibility, tags) that no automation here has credentials
for.

**Read this top-to-bottom before executing.** Skipping the dry-run
step is the most common way operators discover broken release
pipelines in public.

## Prerequisites

- A merged `main` branch carrying the WS12 commits:
  - `feat(v0.5-oss-release-readiness): signalman --version verb`
  - `chore(v0.5-oss-release-readiness): bump version pins to 0.4.0 + consolidated CHANGELOG`
  - `ci(v0.5-oss-release-readiness): enforce host coverage gate in CI`
  - `docs(v0.5-oss-release-readiness): public-release runbook`
  - (and any other WS12 commits — `git log --oneline 7e4cc14..main` to verify)
- `gh` CLI authenticated as a repo admin
  (`gh auth status` shows the right account with `admin:repo` scope).
- Local source for the four secrets, held out-of-band by the operator:
  - Windows code-signing PFX file + password
  - npm publish token (Automation-type token, recommended)
  - crates.io API token (publish-crates scope)

The runbook never asks for those secret values on disk inside the
repo. They live in the operator's password manager or hardware token.

## Step 1 — Upload repo secrets

The release workflow at `.github/workflows/release.yaml` consumes
four secrets. Without them, the workflow builds artifacts but skips
publishing — fine for the dry-run in Step 2; not fine for the real
release in Step 4.

```bash
# Windows code-signing PFX (base64-encoded so it survives the secret
# pipe). Replace the path with your local PFX file.
base64 -w0 /path/to/signalman-codesign.pfx | gh secret set WINDOWS_CERT_BASE64

# Password for the PFX above. `gh secret set` prompts on stdin when
# no value is piped.
gh secret set WINDOWS_CERT_PASSWORD

# npm publish token (https://docs.npmjs.com/creating-and-viewing-access-tokens).
# Use an Automation-type token; Granular-access also works if you scope
# it to the @signalman scope.
gh secret set NPM_TOKEN

# crates.io API token (https://crates.io/settings/tokens). Scope it
# to "publish new" + "publish update" — no admin scope needed.
gh secret set CARGO_REGISTRY_TOKEN
```

Verify all four are set:

```bash
gh secret list
# Expect:
#   CARGO_REGISTRY_TOKEN
#   NPM_TOKEN
#   WINDOWS_CERT_BASE64
#   WINDOWS_CERT_PASSWORD
```

If a secret is missing, the corresponding job in `release.yaml` will
emit a `::warning::` and skip its publish step. The build artifact
still uploads.

## Step 2 — Pre-flight checklist

Run all of these from a clean checkout of `main`:

```bash
git fetch origin
git checkout main
git pull --ff-only
```

Confirm:

- [ ] **Version pins consistent.** All five lockstep entries read
      `0.4.0`:
      ```bash
      grep -H '"version"' host/package.json | head -1
      grep -H "^version" guest/Cargo.toml | head -1
      grep -H "^version" Cargo.toml | head -1   # workspace.package
      grep -H "^version" plugins/signalman-loom-plugin/Cargo.toml | head -1
      ```
      Registry stays at `0.1.1` (independently versioned):
      ```bash
      grep -H '"version"' registry/package.json
      ```
- [ ] **CI green on `main`.**
      ```bash
      gh run list --branch main --limit 1
      ```
      Latest run should show `success` for the `CI` workflow.
- [ ] **No `.workstream-status.md` flags operator-review need.**
      Open the file (root of repo) and confirm `## Operator review
      needed` is empty or absent.
- [ ] **Registry-side smoke tests pass locally.**
      ```bash
      cd registry && npm test && cd ..
      ```
- [ ] **CHANGELOG `[0.4.0]` section reviewed.** Open `CHANGELOG.md`,
      confirm the section accurately covers everything you intend
      to ship.
- [ ] **`signalman --version` returns `signalman 0.4.0`.**
      ```bash
      cd host && npm install && npm run cli -- --version
      # → signalman 0.4.0
      ```

If any box doesn't tick, **stop**. Resolve the gap before proceeding.

## Step 3 — Dry-run tag

Push a release-candidate tag to exercise the full pipeline with
secrets configured, but without committing to the public-visible
artifacts. Operators on private repos can keep tagging RCs until
the pipeline is reliably green.

```bash
git tag -a v0.4.0-rc1 -m "v0.4.0 release candidate 1"
git push origin v0.4.0-rc1
```

Watch the workflow:

```bash
gh run watch
# or
gh run list --workflow release.yaml --limit 1
```

Verify, on success:

- [ ] All five jobs ran (service MSI, guest MSI, npm publish, cargo
      publish, GitHub Release).
- [ ] Each job logged either a successful publish OR a
      `::warning::` about a missing secret. Any `::error::` is a
      stop condition.
- [ ] Artifacts (`signalman-service.msi`, `signalman-guest.msi`,
      tarballs) attached to the `v0.4.0-rc1` GitHub Release.

If the dry-run reveals issues, fix them, delete the tag, and re-run:

```bash
git tag -d v0.4.0-rc1
git push --delete origin v0.4.0-rc1
# Fix issue, then re-tag rc2.
```

**Don't proceed to Step 4 until at least one RC tag completes cleanly.**

## Step 4 — Push the real v0.4.0 tag

```bash
git tag -a v0.4.0 -m "v0.4.0"
git push origin v0.4.0
gh run watch
```

The workflow runs identically to the RC tag but actually publishes
to npm + crates.io. After it completes:

- [ ] `npm view @signalman/host version` → `0.4.0`
- [ ] `cargo search signalman-guest` shows version `0.4.0`
- [ ] GitHub Release page shows `v0.4.0` with MSI + tarball attachments
- [ ] `https://github.com/<owner>/signalman/releases/tag/v0.4.0` resolves

## Step 5 — Visibility flip (after observation window)

Per Q7 (operator-locked 2026-05-16): **stagger the flip** — let the
v0.4.0 release run privately for at least a few days so any
pipeline regression is caught before public eyes. Once the release
is stable:

```bash
# Flip to public. The --accept-visibility-change-consequences flag
# acknowledges that prior private-only forks become discoverable,
# clone counts reset, and historical issue links may rot.
gh repo edit <owner>/signalman \
  --visibility public \
  --accept-visibility-change-consequences
```

GitHub-side state that survives the flip:

- Secrets — stay configured.
- Webhooks — stay configured.
- Collaborators / team grants — stay configured.
- Issues, PRs, releases — all retained.

GitHub-side state that changes:

- Forks — private forks remain private; their owners can opt into
  visibility independently.
- Default visibility for new forks becomes public.
- Free private CI minutes counter resets (the public repo has
  unlimited Actions minutes for Linux + Windows runners).

## Step 6 — Post-flip smoke test

From a freshly-cloned working copy on a clean host (or a different
machine than your dev box):

```bash
git clone https://github.com/<owner>/signalman.git
cd signalman
cd host && npm install && npm test && cd ..
cargo build --workspace
```

If `npm install` or `cargo build` fails on the public clone but
succeeded on your dev box, you've shipped with a secret-dependency
(probably a private registry URL in a config or lockfile). Roll back
(Step 7) and investigate.

## Step 7 — Rollback (if a post-flip problem surfaces)

If the public smoke test fails, or if a serious issue appears in
the first 24 hours of public visibility, flip back:

```bash
gh repo edit <owner>/signalman --visibility private
```

The visibility flip is reversible. Most state survives intact. The
artifacts already published to npm + crates.io are NOT recallable
(this is by design; npm/crates.io intentionally make unpublish
hostile), but you can `npm deprecate` a problematic version with a
message:

```bash
npm deprecate @signalman/host@0.4.0 "Recalled — see release notes"
```

crates.io has a `cargo yank` equivalent:

```bash
cargo yank --version 0.4.0 signalman-guest
```

Yanking does NOT delete; it removes the version from the resolver's
candidate set so new `Cargo.lock` files won't pick it. Existing
lockfiles continue to install the yanked version unchanged.

## After completion

Update `docs/STATUS.md` §Public-release status:

- Mark "Visibility flip" closed with the date and commit SHA the
  flip ran against.
- Mark "GitHub repo secrets" closed.
- Leave `CODE_OF_CONDUCT.md` open (WS12 M2 deferred).

Then commit:

```bash
git add docs/STATUS.md
git commit -m "docs(status): record v0.4.0 public-release flip"
git push origin main
```

## Appendix: secret rotation

Routine rotation policy (recommend annually):

- **`WINDOWS_CERT_BASE64`** rotates with the code-signing
  certificate's expiry. Typical EV cert: 1–3 years. Plan rotation
  60 days before expiry.
- **`NPM_TOKEN`** Automation tokens have no expiry by default;
  rotate annually anyway.
- **`CARGO_REGISTRY_TOKEN`** crates.io tokens have no expiry;
  rotate annually.
- **`WINDOWS_CERT_PASSWORD`** rotates only when the PFX is
  regenerated.

After rotating, `gh secret set <NAME>` overwrites the prior value;
no other action needed.
