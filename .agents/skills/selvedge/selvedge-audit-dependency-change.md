---
name: selvedge-audit-dependency-change
description: Supply-chain audit for a dependency addition or version bump. Identify changed packages → check_package for CVEs + slopsquat risk → scan_dependencies on lockfile → inspect import usage → triage each finding before the lockfile lands.
allowed-tools: [selvedge.check_package, selvedge.scan_dependencies, selvedge.list_findings, selvedge.triage, Read, Grep, Glob, Bash]
---

# Dependency change audit

Every package add or bump is a supply-chain event. Review before the lockfile lands.

## Loop

1. **Identify changed packages.** `Bash`:
   ```
   git diff HEAD -- package.json requirements*.txt pyproject.toml Cargo.toml go.mod
   ```
   Extract: name, old version → new version, ecosystem.

2. **check_package for each new or bumped package.**
   ```json
   { "tool": "selvedge.check_package", "arguments": { "name": "<pkg>", "version": "<ver>", "ecosystem": "<npm|pypi|cargo|go>" } }
   ```
   Flag: `known_cves` (CVSS ≥ 7.0 → high priority), `slopsquat_risk: true` → critical (do not add
   without manual registry verification), `deprecation: true` → prefer active fork.

3. **scan_dependencies on full lockfile.**
   ```json
   { "tool": "selvedge.scan_dependencies", "arguments": {} }
   ```
   Compare against pre-change findings. Focus on anything newly introduced.

4. **Check import usage.** `Grep` for `import <pkg>` / `from '<pkg>'` / `require('<pkg>')`.
   Note if the package is used in auth, crypto, parsing, or networking paths. Verify the safe
   API surface is being used.

5. **Triage each finding.**
   - CVE: check if your project exercises the vulnerable code path; upgrade or dismiss with
     a documented reason.
   - Slopsquat: escalate to user, `selvedge.triage { state: "needs-review" }` with the
     correct canonical package URL.
   - Deprecated: accept with migration plan or find active fork.
   - Unsafe API usage: open a SAST finding via `selvedge.scan_code` on the import site.

## Invariants

- Never self-approve a slopsquat flag — escalate to user every time.
- CVE with CVSS ≥ 7.0 requires human review before dismissal.
- Pin exact versions for packages in security-sensitive paths.
