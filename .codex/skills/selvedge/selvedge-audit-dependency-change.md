---
name: selvedge-audit-dependency-change
description: Supply-chain security audit triggered by a dependency addition or version bump. For each
---

# Dependency change audit

Every dependency addition or version bump is a supply-chain event. This skill drives a structured
review of new or changed packages before they land in a lockfile — catching known CVEs, typosquat
package names, and suspicious metadata before the code ships.

## Five-step loop

### 1. Identify the changed packages

Diff the manifest and lockfile to surface which packages are new or bumped:

```bash
# npm / yarn / pnpm
git diff HEAD -- package.json package-lock.json yarn.lock pnpm-lock.yaml

# Python
git diff HEAD -- pyproject.toml requirements*.txt

# Rust
git diff HEAD -- Cargo.toml Cargo.lock

# Go
git diff HEAD -- go.mod go.sum
```

Extract: package name, previous version (if upgrade), new version, and ecosystem (`npm`, `pypi`,
`cargo`, `go`).

### 2. Check each package via selvedge.check_package

For every new or bumped package:

```json
{
  "tool": "selvedge.check_package",
  "arguments": {
    "name": "<package name>",
    "version": "<new version>",
    "ecosystem": "<npm | pypi | cargo | go>"
  }
}
```

The tool returns:

- `known_cves` — CVEs affecting this version range.
- `reputation` — download count, age, maintainer signals.
- `slopsquat_risk` — whether the name resembles a popular package with a character substitution
  (AI-hallucinated package names often follow this pattern).
- `deprecation` — whether the package is deprecated or abandoned.

Flag any `known_cves` with CVSS ≥ 7.0 as high priority. Flag any `slopsquat_risk: true` as
critical — do not add the package until the name is manually verified against the canonical
registry URL.

### 3. Run selvedge.scan_dependencies on the full lockfile

```json
{
  "tool": "selvedge.scan_dependencies",
  "arguments": {}
}
```

This cross-references every transitive dependency against the OSV database. Review the returned
findings for anything introduced by the lockfile change (compare against findings from before the
change if available).

### 4. Check import usage in the codebase

Use `Grep` to find where the new package is imported:

```bash
# Python
grep -r "import <package>" src/

# TypeScript / JavaScript
grep -r "from '<package>'" src/
grep -r "require('<package>')" src/
```

Understand:
- Is the package used in a security-sensitive path (auth, crypto, parsing, networking)?
- Is the API surface being used safely? (e.g., does the code call the package's safe wrapper,
  or the raw unsafe interface?)
- Is the version pinned in a way that allows silent upgrades?

### 5. Assess and triage

For each finding (CVE, slopsquat risk, usage concern):

- **Known CVE in this version range:** check whether the vulnerability is in a code path your
  project exercises. If yes, upgrade or pin a patched version. If no, dismiss with a reason
  documenting which feature is unaffected.
- **Slopsquat / typosquat name:** escalate to the user immediately. Do not add the package
  until the registry URL is confirmed. Triage as `needs-review` with the correct package name.
- **Deprecated package:** prefer an active fork or alternative. If no alternative, accept with
  a documented reason and open a follow-up to migrate.
- **Unsafe API usage:** note in the SAST/completeness findings and drive via `selvedge.sast-fix`
  or `selvedge.audit-completeness`.

Record every decision via `selvedge.triage`.

## Invariants

- Verify slopsquat/typosquat package names against the registry directly before adding any
  package flagged as suspicious. Do not self-approve.
- For any CVE with CVSS ≥ 7.0, surface it to the user — do not dismiss without human review.
- Pin exact versions in lockfiles for packages used in security-sensitive paths.
- Check transitive dependencies, not just direct ones.

## Companion tools

- `selvedge.check_package` — per-package reputation, CVE, and slopsquat assessment.
- `selvedge.scan_dependencies` — full lockfile OSV cross-reference.
- `selvedge.list_findings` — review prior dependency findings.
- `selvedge.triage` — record the final disposition of each finding.
- `Grep` — locate where the package is imported and how it's used.
- `Bash` — diff manifests to identify exactly what changed.

