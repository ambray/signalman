---
name: selvedge-audit-module
description: Full security audit of a single file or directory. Understand the module's security surface → run scan_code + scan_completeness + scan_secrets narrowed to target → add data-flow context to each finding → drive to triage → produce a summary.
allowed-tools: [selvedge.scan_code, selvedge.scan_completeness, selvedge.scan_secrets, selvedge.scan_dependencies, selvedge.check_package, selvedge.list_findings, selvedge.triage, Read, Grep, Glob, Edit]
---

# Module audit

Focused security review of a single path. Deeper than a diff audit — full coverage, with
data-flow context added to every finding.

## Loop

1. **Resolve path.** `Glob` if the target is ambiguous. If > 5 000 lines, split into per-file
   passes.

2. **Understand the surface.** `Read` the module. Note: what untrusted data enters, what security
   decisions it makes (auth, crypto, parsing, DB, shell), what external systems it calls.

3. **Run all scanners narrowed to target.**
   ```
   selvedge.scan_code        { paths: [<target>] }
   selvedge.scan_completeness { paths: [<target>] }
   selvedge.scan_secrets     { scope: "paths", paths: [<target>] }
   ```
   If the module is a service entrypoint: also `selvedge.scan_dependencies` + `selvedge.check_package`
   for each package the module imports directly.

4. **Surface findings with context.** For each: rule id + one-line meaning, file:line, data-flow
   note (does this path touch untrusted input?), effective severity given auth context.
   Sort: critical → high → medium → low → info.

5. **Triage each finding in context.**
   - `sast` → read file → fix → rerun on path → `selvedge.triage`
   - `completeness` → read stub/placeholder/TODO → fix gap or document intention → triage
   - `secrets` → verify → surface to user → rotate if live → triage

6. **Write summary.** Module path, scan date, rules fired, finding counts by state, any expected
   categories with zero findings (positive signal or a gap worth noting).

## Invariants

- Read the actual file before proposing any fix.
- Never mark `fixed` without rerunning on the patched path.
- Triage each finding individually — don't bulk-dismiss.
- Test-path modules have lower production attack surface; note this in triage reasons.
