---
name: selvedge-pre-install-check
description: Reflex check before proposing dependency additions. Teaches the agent to call
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
- Any tool call that would mutate a manifest (`package.json`, `requirements.txt`, `Cargo.toml`,
  `go.mod`, `pom.xml`) to introduce or bump a dependency

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
`selvedge.scan_dependencies` against the already-modified manifest as a fallback (see the
Phase B roadmap for direct `check_package` support).

## How to interpret the result

The response is a `PackageAdvisory`:

```json
{
  "ecosystem": "npm",
  "name": "express",
  "requested": "4.16.0",
  "vulnerabilities": [
    {
      "id": "GHSA-rv95-896h-c2vc",
      "severity": "high",
      "summary": "...",
      "fixed_in": "4.17.3"
    }
  ],
  "recommended_version": "4.17.3",
  "decision_hint": "warn"
}
```

Three possible `decision_hint` values, and your required behavior for each:

### `proceed`

No vulnerabilities known. You may run the install. Consider mentioning to the user that the
package is clean.

### `warn`

Vulnerabilities exist but a fix is available. You MUST NOT install silently:

1. Summarize the advisories (ids + severities + one-line summaries).
2. Point the user at `recommended_version` as a drop-in upgrade.
3. Ask the user to confirm: "Install the fixed version instead?" or "Install anyway?"
4. Only proceed on explicit user confirmation.

### `block`

A high or critical severity vulnerability exists with no known fix. You MUST refuse the install:

1. Output the advisory ids, severities, and summaries.
2. Explain that no fix is available yet.
3. If a reasonable alternative package exists that serves the same purpose, propose it.
4. Do not proceed even if the user insists, without an explicit override like
   `selvedge triage --state accepted` recorded on the finding.

## Pro augmentation

If `selvedge.preflight_install` is available in the tool list, also call it:

```json
{
  "tool": "selvedge.preflight_install",
  "arguments": {
    "ecosystem": "npm",
    "name": "express",
    "version_spec": "4.16.0"
  }
}
```

`preflight_install` adds checks that `check_package` doesn't do:

- Slopsquat / typosquat pattern detection against curated popular-package lists.
- Install-script static analysis (`postinstall`, `setup.py`, `build.rs`).
- Maintainer-change signals on long-dormant packages.
- License compatibility.

If `preflight_install` returns a stricter decision than `check_package` (e.g., `check_package`
says `proceed` but `preflight_install` says `warn` due to a fresh-maintainer flag), respect the
stricter signal. When in doubt, show both results to the user.

## Examples

### Adding a new dependency

> User: Please add express to the project.

Flow:
1. Call `selvedge.check_package("npm", "express", "latest")`.
2. Read the decision_hint.
3. On `proceed`, run `npm install express`. On `warn`, ask first. On `block`, refuse.

### Upgrading an existing dependency

> User: Upgrade lodash to 4.17.21.

Flow:
1. Call `selvedge.check_package("npm", "lodash", "4.17.21")`.
2. If proceed or user confirms warn, update `package.json`.
3. If block, surface the advisory and don't touch the manifest.

### User insists on installing a blocked package

> User: I don't care, install it anyway.

Refuse. Explain the finding. Suggest the user triage the finding as `accepted` via
`selvedge.triage`, recording a reason — that makes the decision auditable and preserves it
across agent sessions.

## Invariants

- Never silently install a package without running this check.
- Never strip vulnerability details from the output you show the user. The advisory ids are
  the audit trail.
- Never treat `block` as advisory. It is a hard stop.

