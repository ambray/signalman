---
name: signalman-build-from-tag
description: Build a signalman release for a registered product at a specific git tag. Clones the product repo, executes its signalman.build.yaml, validates every declared artifact was produced, captures them, and writes a signed-style manifest. Trigger when the user says "build <product> at <tag>", "make a release for tag X", "do a fresh build of <product>".
allowed-tools: Bash
---

# Build a tagged release

## What you need from the user

- **Product name** — must already be registered. Check with `signalman product list`. If it isn't there, ask the user for the repo URL and call `signalman product add --name <NAME> --repo <URL>` first.
- **Tag** — a git tag that exists in the product repo.

## How to invoke

```bash
signalman release build --product <NAME> --tag <TAG> --format json
```

The command streams stderr while building (component-by-component progress, build commands, artifact capture) and prints a JSON summary to stdout on success.

## Expected stdout on success

```json
{
  "release": { "id": "...", "tag": "...", "status": "ready", ... },
  "manifest_sha256": "<64-hex>",
  "artifact_count": <int>
}
```

## Exit codes and failure modes

| Exit | Meaning | What to say to the user |
|------|---------|--------------------------|
| 0 | Build succeeded. | Surface tag, manifest sha256, artifact count. Point them at `signalman release show <id>` for detail. |
| 2 | `ComponentBuildError` / `MissingArtifactError` / `ReleaseAlreadyExistsError`. | Surface the stderr tail — it tells the user which component failed and why. Do NOT auto-retry. |
| 5 | `BuildYamlValidationError`. | The product's `signalman.build.yaml` is broken. Surface the validation issues verbatim; this is a product-repo bug. |

## What NOT to do

- Never soft-delete a `ready` release to force a rebuild — that's destructive. If `ReleaseAlreadyExistsError` fires, tell the user the existing build is current.
- Never retry a `ComponentBuildError` automatically — the underlying build step needs operator attention.
- Don't run `signalman release build` against a tag the operator hasn't actually pushed; surface git's "tag not found" error to them.

## Follow-up suggestions

After a successful build:
- `signalman release show <release_id>` — show the manifest and artifact list.
- `signalman release deploy --release <id> --target <test-target>` — push it onto a test VM.
