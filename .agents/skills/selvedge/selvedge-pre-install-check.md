---
name: selvedge-pre-install-check
description: Reflex check before dependency additions. Call selvedge.check_package before any install/add/upgrade; refuse installs that come back as decision_hint=block.
allowed-tools: [selvedge.check_package, selvedge.preflight_install, selvedge.scan_dependencies, selvedge.triage]
---

# Pre-install check

Before adding any dependency to the project, call `selvedge.check_package` first. Do not run
`npm install`, `pip install`, `cargo add`, `go get`, or any equivalent until you have read the
advisory.

## When to invoke

Recognize these intents and trigger this check every time:

- "install <package>"
- "add <package>"
- "depend on <package>"
- "upgrade <package>"
- Any Bash call that would mutate a manifest to introduce or bump a dependency

## How to call the tool

```json
{
  "tool": "selvedge.check_package",
  "arguments": {
    "ecosystem": "npm",
    "name": "express",
    "version_spec": "4.16.0"
  }
}
```

Supported `ecosystem` values in Free: `npm`, `pypi`. For `cargo`, `go`, and `maven`, call
`selvedge.scan_dependencies` against the already-modified manifest as a fallback.

## How to interpret the result

The response is a `PackageAdvisory` with a `decision_hint` field:

- **`proceed`**: install it.
- **`warn`**: summarize advisories, suggest `recommended_version`, ask the user, and only
  proceed on explicit confirmation.
- **`block`**: refuse. Output the advisory ids, severities, and summaries. Propose an
  alternative package if one is reasonable. Do not install even if the user insists, without
  an explicit `selvedge.triage --state accepted` override recorded on the finding.

## Pro augmentation

If `selvedge.preflight_install` is available, call it in addition to `check_package`. Respect
the stricter of the two decision hints.

## Invariants

- Never silently install a package without running this check.
- Never strip vulnerability details from what you show the user.
- `block` is a hard stop, not advisory.

## Companion tools

- `selvedge.scan_dependencies` — run this after the install settles if you want to confirm
  the whole dependency tree.
- `selvedge.triage` — record a decision on a finding, including the override path for a
  blocked package the user explicitly accepts.
