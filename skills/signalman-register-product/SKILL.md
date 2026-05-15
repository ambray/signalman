---
name: signalman-register-product
description: Register, list, or soft-delete a signalman product (the external git repo whose tags signalman will build). Trigger when the user says "add product <name>", "register <repo>", "what products are registered", "list products", "remove product <name>", or hits a ProductNotFoundError from release build and needs to register first.
allowed-tools: mcp__signalman__signalman_product_add, mcp__signalman__signalman_product_list, mcp__signalman__signalman_product_remove
---

# Manage signalman products

A signalman *product* is the external repo whose tags signalman builds.
Every `release build` references a registered product. Three MCP tools
cover the lifecycle: `signalman_product_add`, `signalman_product_list`,
`signalman_product_remove`.

This is the **precondition skill** — if a release-related call returns
`ProductNotFoundError`, this is the recovery path.

## What you need from the user

For `signalman_product_add`:

- **`name`** — unique per org, used as the product identifier in every
  later call. Short, lowercase, hyphen-separated is the convention.
- **`repo_url`** — git URL signalman will clone at build time. HTTPS
  or SSH; signalman doesn't authenticate URLs at registration, so a
  typo here doesn't surface until the first build.
- (Optional) **`build_yaml_path`** — path to `signalman.build.yaml`
  inside the repo (default: repo root). Set this when the product is
  a monorepo and signalman should only build a subset of components.

For `signalman_product_list` — nothing required.

For `signalman_product_remove`:

- **`name`** — the product to soft-delete. Releases stay in the catalog
  for historical reference; you can still inspect them after the
  product is removed.

## How to invoke

```jsonc
// signalman_product_add
{
  "name": "myapp",
  "repo_url": "https://github.com/myorg/myapp.git",
  "build_yaml_path": "build/signalman.build.yaml"  // omit for repo root
}

// signalman_product_list
{}

// signalman_product_remove
{ "name": "myapp" }
```

## Expected response

`signalman_product_add` returns the new product record:

```jsonc
{
  "id": "01HX…",
  "name": "myapp",
  "repo_url": "https://github.com/myorg/myapp.git",
  "build_yaml_path": "build/signalman.build.yaml",
  "created_at": "2026-05-14T…"
}
```

`signalman_product_list` returns the active set (soft-deleted excluded):

```jsonc
{
  "products": [
    { "id": "01HX…", "name": "myapp", "repo_url": "…", "created_at": "…" }
  ]
}
```

`signalman_product_remove` returns `{ "removed": true }` and the product
no longer appears in `list`. Releases keyed off it remain visible
through `signalman_release_list`.

## Errors you may see

| Error class | What happened | What to tell the user |
|---|---|---|
| `ProductAlreadyExistsError` | `add` with a name that's already registered. | Surface the existing product's row from `signalman_product_list`; ask whether the user wants to remove + re-add or use the existing entry. |
| `ProductNotFoundError` | `remove` against a name that doesn't exist or is already soft-deleted. | Surface the list; the operator may already have removed it. |
| `ValidationError` | Malformed `repo_url`, empty `name`, etc. | Surface verbatim; this is an input bug. |

## What NOT to do

- **Don't validate the `repo_url` by cloning it from the skill.** The
  build executor clones at build time; registration is a metadata
  step and should stay cheap. Surface a typo by waiting for the first
  build to fail with a clearer git-side message.
- **Don't soft-delete a product to "force a fresh build."** Soft-delete
  is a metadata gesture; the right verb for a fresh build is to call
  `signalman_release_build` with a new tag. If the user wants to
  re-register because the repo URL changed, ask them explicitly —
  removing in-flight history is a one-way gesture.
- **Don't omit `build_yaml_path` when the product is in a monorepo.**
  The default is repo-root; build will fail with `BuildYamlNotFoundError`
  if `signalman.build.yaml` isn't at the root. Surface the path
  explicitly during registration so the user catches it then.

## Follow-up suggestions

After `add`:

- `signalman-build-from-tag` — the natural next step; the user
  registered a product because they want to build a tag of it.
- If the product is on a private git host, remind the user that the
  build runner needs read access (SSH key, deploy token, etc.) — the
  registration itself doesn't carry credentials.

After `list`:

- If the user is exploring what's available before deciding what to
  build, point them at `signalman_release_list --product <name>` to
  see existing releases.

After `remove`:

- Surface that historical releases remain visible — the soft-delete
  doesn't wipe the catalog.
