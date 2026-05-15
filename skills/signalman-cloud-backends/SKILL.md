---
name: signalman-cloud-backends
description: List the cloud backends (aws, azure, …) that are registered on this Signalman host. Useful when the agent doesn't know which providers are available before calling provision / terminate / status / list. Trigger when the user says "what cloud providers do we have", "is aws wired up", "is azure available", "list registered cloud backends", "check what clouds I can target", or hits unsupported_provider and needs to discover what IS supported.
allowed-tools: mcp__signalman__signalman_cloud_backends
---

# List registered cloud backends

`signalman_cloud_backends` returns the cloud providers the host has
registered at module-load time. Read-only, no parameters, no
mutation, no vendor API calls — it just inspects the in-process
registry.

This is the **discovery skill** that pairs with the rest of the
cloud surface. If a user asks "spin up a VM" without specifying a
provider, call this first to know what's actually available before
asking them to pick.

## What you need from the user

Nothing. The tool takes no parameters.

## How to invoke

```jsonc
// signalman_cloud_backends
{}
```

## Expected response

```jsonc
{
  "ok": true,
  "value": ["aws", "azure"]
}
```

The array is the set of `CloudBackendKind` values currently in the
registry. On a host with no cloud SDKs installed the array could be
empty; that's not an error, just a fact about this host's wiring.

## Errors you may see

This tool has no documented error envelope — it's a pure registry
read. If you somehow get `ok: false`, surface the error message
verbatim; that's a host-wiring bug worth reporting.

## What NOT to do

- **Don't memoize the response across hosts.** A different Signalman
  host (different machine, different env) may have a different set.
  Call once per session, per host.
- **Don't assume the order is meaningful.** The array reflects
  module-load order in `host/src/server.ts`; "first" doesn't mean
  "preferred." If you need to pick one, ask the user.
- **Don't infer "this provider has credentials."** Registration is
  a code-side fact (the SDK is imported) — *credentials* are an env
  fact (`AWS_ACCESS_KEY_ID`, `AZURE_TENANT_ID`, etc.). A registered
  backend can still fail with `auth_failed` on first call.

## Follow-up suggestions

- The user wants to provision: hand them
  `signalman-provision-cloud-vm` with the matching `provider` field.
- The user is debugging "why does provision fail with
  unsupported_provider": the answer is in this skill's response.
  Surface the registered set and the requested provider side-by-side
  so the typo / missing-SDK gap is visible.
- The user wants to know if a *different* backend (e.g., GCP) is
  coming: that's a roadmap question, not a Signalman runtime
  question. Point them at the roadmap doc rather than guessing.
