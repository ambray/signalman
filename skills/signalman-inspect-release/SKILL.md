---
name: signalman-inspect-release
description: List or show the contents of signalman releases without rebuilding or redeploying them. Returns release rows, manifest sha256, signing fingerprint, and artifact metadata. Trigger when the user says "list releases", "show release <id>", "what releases of <product> do we have", "what's in release X", "find a release", "inspect the manifest", or any read-only "what did we build" intent.
allowed-tools: mcp__signalman__signalman_release_list, mcp__signalman__signalman_release_show
---

# Inspect signalman releases

Two read-only MCP tools cover the inspection path: `signalman_release_list`
filters the catalog; `signalman_release_show` returns one release's
full row including manifest sha256 and artifact list. **Neither mutates
state.**

Use this when:

- The user wants to find a release id before deploy (`release deploy
  --release <id>` instead of `--product + --tag`).
- A deploy failed and the user is checking which artifacts were
  staged.
- The user is auditing what was built recently and by whom.

## What you need from the user

For `signalman_release_list` — nothing required:

- (Optional) **`product`** — filter to releases of one product.
- (Optional) **`status`** — one of `building`, `ready`, `failed`. When
  the user says "find my latest broken build" → filter by `failed`.

For `signalman_release_show`:

- **`release_id`** — ULID. The user usually has this from a prior
  `release_list` or from a `release_build` response.

## How to invoke

```jsonc
// signalman_release_list — recent failures for one product
{ "product": "myapp", "status": "failed" }

// signalman_release_show
{ "release_id": "01HX1234ABCD…" }
```

## Expected response

`signalman_release_list`:

```jsonc
{
  "releases": [
    {
      "id": "01HX…",
      "product_id": "01HW…",
      "product_name": "myapp",
      "tag": "v1.4.2",
      "status": "ready",
      "manifest_sha256": "0a1b2c…",
      "signed_by": "abc123def456…",
      "created_at": "2026-05-13T18:22:01Z"
    }
  ]
}
```

`signalman_release_show` returns the full row plus the artifact list:

```jsonc
{
  "release": {
    "id": "01HX…",
    "tag": "v1.4.2",
    "status": "ready",
    "manifest_sha256": "0a1b2c…",
    "signed_by": "abc123def456…",
    "build_started_at": "…",
    "build_finished_at": "…",
    "build_log_blob_uri": "…",
    "created_at": "…"
  },
  "artifacts": [
    {
      "id": "…",
      "component": "api",
      "kind": "blob",
      "sha256": "…",
      "size_bytes": 1234567,
      "blob_uri": "local:default/0a/0a1b2c…"
    },
    {
      "id": "…",
      "component": "web",
      "kind": "image",
      "image_ref": "ghcr.io/myorg/myapp-web:v1.4.2"
    }
  ]
}
```

The `signed_by` field is the first 16 hex chars of the Ed25519 public
key fingerprint. Use it to confirm which signing key was active when
the release was built; `signalman key fingerprint <pub-key>` returns
the same value for verification.

## Errors you may see

| Error class | What happened | What to tell the user |
|---|---|---|
| `ReleaseNotFoundError` | Bad `release_id` (or the release is from a soft-deleted product, which would still appear — check `release_list` for the canonical name). | Surface `release_list` so the user can pick the right id. |
| `ValidationError` | Bad `status` enum value. | Surface the message; valid values are `building` / `ready` / `failed`. |

## What NOT to do

- **Don't pull artifacts out of the blob store from this skill.** This
  is metadata-only inspection; downloading artifacts is a separate
  operator gesture (and usually goes through the deploy verb, not
  manual extraction).
- **Don't recompute manifest sha256 from the skill.** Surface the
  stored value; if the user wants to verify, point them at
  `signalman release verify <id> --public-key <pub-key>` which checks
  both fingerprint and signature.
- **Don't paraphrase the artifact list.** The components,
  `kind`s, and either `sha256`/`blob_uri` or `image_ref` are the
  operator-readable contract — quote them.
- **Don't suggest a re-build when a `failed` release is found.** The
  user may be inspecting failures for debugging, not asking for a
  retry. Ask their intent before recommending `release build` again.

## Follow-up suggestions

After `list`:

- If filtering by `failed`, point the user at
  `signalman_release_show <id>` for the build log URI (in the row's
  `build_log_blob_uri` field — the actual log lives in the blob store).
- If the user wants to deploy: `signalman-deploy-to-test` /
  `signalman-deploy-to-demo` accept either `release` (id) or
  `product` + `tag`. Recommend the explicit id when ambiguity matters.

After `show`:

- Point at `signalman release verify <id>` if the user is asking about
  signature trust (CLI verb; no MCP equivalent in v0.3.0-5).
- Point at `signalman_health_history --target <name>` if the user is
  trying to remember which target this release was deployed to.
