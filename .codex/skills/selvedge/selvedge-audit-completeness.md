---
name: selvedge-audit-completeness
description: Investigate a Selvedge completeness ("fray") finding and drive it to a triage decision.
---

# Completeness audit

A completeness ("fray") finding signals a gap in a security path — not a vulnerability pattern
like SAST, but evidence that something that *should* be implemented isn't yet. Each category
requires a different resolution strategy.

## Category guide

| category slug | what it flags | typical resolution |
|---|---|---|
| `placeholder-literal` | Hard-coded strings that look like template values (`"changeme"`, `"your-api-key-here"`, `"admin"`) in assignments that name security-relevant variables | Replace with real credentials via a secret manager, env var, or vault reference |
| `security-stub` | Function bodies that are skeletons (`pass`, `return True`, `raise NotImplementedError`) in functions that a security path calls | Implement the real logic, or explicitly document why the stub is intentional |
| `todo-in-security` | `TODO` / `FIXME` / `XXX` comments within `WINDOW_LINES` of security-relevant identifiers | Complete the TODO, or dismiss with a documented reason if it's informational |
| `hallucinated-import` | An import of a package name that doesn't exist in the registry (often AI-generated) | Correct to the real package name or remove the import |
| `hardening-default` | A framework or library configured below its secure baseline | Enable the secure option explicitly |
| `access-control-consistency` | A route handler in a cluster missing a decorator that the cluster majority carries (e.g. `@login_required` everywhere except one route) | Apply the missing decorator if the route belongs in the cluster's access-control regime; document the exemption otherwise |

## Six-step loop

### 1. Read the finding

Every completeness finding includes:

- `rule_id` — namespaced as `completeness.<category>.<name>`.
- `message` — prefixed with the category slug (e.g., `[placeholder-literal] Literal placeholder…`).
- `context.code_region` — `{ path, start_line, end_line, snippet }`.
- `severity` and `confidence`.

Parse the category from the `rule_id` prefix to know which strategy to follow below.

### 2. Read the actual code region

Open the file at `code_region.path`. Read `start_line..=end_line` plus at least 10 lines of
surrounding context. Understand:

- What is the function's role in the codebase?
- Is it in a security path (authentication, authorization, crypto, validation)?
- Is the gap intentional (a test fixture, a demo endpoint, a deliberate fallback) or accidental
  (a developer placeholder that shipped)?
- Are there other callers of this function? (`Grep` for the function name to assess blast radius.)

### 3. Apply the category-specific resolution strategy

#### Placeholder literals

Check whether the variable is actually used in a security-sensitive context:

```
Grep: <variable name> across the repo
```

If the variable feeds into an auth check, API call, JWT signing, or DB connection:

1. **Real environment:** Replace the literal with an environment variable reference or vault
   lookup. Use whatever secret-management pattern the codebase already uses (check `.env` usage,
   `os.environ`, `process.env`, config loaders).
2. **Test fixture:** If the file is in `tests/`, `fixtures/`, or `__tests__/`, and the literal
   is only referenced in test code, dismiss with reason "test fixture — not reachable in
   production."
3. **Documentation example:** If the file is documentation or a sample, dismiss with reason
   "documentation example — not deployed code."

Never replace a placeholder with a real credential inline. Always use an indirection layer.

#### Security stubs

Read the function signature and its callers. Determine what the function is supposed to do.

If the stub is in production code and is called from a live path:

1. Implement the function body. Use `Grep` to find similar functions in the codebase for
   style reference.
2. If you can't implement it safely without more context, set triage to `needs-review` with a
   detailed reason describing what the function should do and what information is missing.

If the stub is in a test helper or abstract base:

1. Check whether subclasses or test implementations exist (`Grep` for the class name and any
   subclasses). If concrete implementations exist and the stub is a base-class default:
   dismiss as "abstract base — concrete implementations handle this."
2. If no concrete implementations exist, flag as `needs-review`.

#### TODO in security

Read the comment and the surrounding 5 lines. Assess:

- **Actionable TODO:** The comment describes real missing functionality (e.g.,
  `# TODO: validate JWT signature`, `// TODO: add rate limiting`). Implement the described
  check, or triage as `needs-review` with the specific implementation needed.
- **Informational TODO:** The comment is a note to self about a non-security concern (e.g.,
  `# TODO: refactor this after the migration`). Dismiss with reason "informational TODO —
  not a security gap."
- **Out-of-scope TODO:** The comment references a larger project tracked elsewhere. Dismiss
  with the tracking reference (e.g., "tracked in ISSUE-1234").

#### Hallucinated imports

Cross-reference the package name against the real registry:

```
selvedge.check_package { name: "<package>", ecosystem: "<npm|pypi>" }
```

If the package doesn't exist, find the correct package (Grep for similar names, check the
real registry manually) and replace the import. This is often an AI-generated import of a
package that sounds plausible but isn't real — a common supply-chain attack vector.

#### Hardening defaults

Read the framework documentation link from the rule message. Apply the recommended secure
configuration option to the existing initialization code. Run tests to confirm nothing breaks.

#### Access-control consistency

The finding's message names the missing decorator and the cluster's majority/total counts
(e.g., `Route handler \`d\` is missing decorator \`@login_required\` that 3/4 sibling routes
carry`). Three resolutions are possible:

1. **Apply the decorator** (most common). The outlier route was almost certainly meant to
   carry the same access-control decorator as its peers. Add the decorator above the route
   handler, in the same position the peers use, and rerun the scan.
2. **Document the exemption.** The route is intentionally public/different (a webhook callback,
   a health check, a login endpoint). Add an inline comment explaining why this route is
   exempt from the cluster's regime, then dismiss the finding with `state: "dismissed"` and
   the same reason.
3. **Refactor the cluster.** If the cluster genuinely contains routes with different
   access-control needs (e.g. `/api/v1/*` admin routes mixed with `/api/v1/health` and
   `/api/v1/webhooks/*`), split them into separate Blueprints / APIRouters so the majority
   calculation operates on truly comparable peers.

Note: the detector currently clusters by file. A cross-file refactor (move webhook routes to
their own module) is the right answer when the file mixes two regimes.

### 4. Implement or document

Either:

- **Fix:** Make the code change. Edit the file. For placeholder/stub/TODO fixes, keep changes
  minimal — don't refactor beyond the gap itself.
- **Document:** If the gap is intentional, add an inline comment explaining why (e.g.,
  `# Not a real credential — seeded for local dev only, never deployed`).

### 5. Rerun the scanner

After any code change, rerun the scanner narrowed to the affected path to confirm the finding
no longer fires:

```json
{
  "tool": "selvedge.scan_completeness",
  "arguments": { "paths": ["<fixed file>"] }
}
```

If the finding still fires after the fix, re-examine — the pattern is broader than the single
change.

### 6. Record a triage decision

```json
{
  "tool": "selvedge.triage",
  "arguments": {
    "finding_id": "<finding id from the completeness scan>",
    "state": "fixed",
    "reason": "Replaced placeholder jwt_secret with os.environ['JWT_SECRET'] reference.",
    "actor": { "kind": "agent", "id": "claude-code" }
  }
}
```

| state | when to use |
|---|---|
| `fixed` | Code was changed and the scanner confirms the finding no longer fires |
| `dismissed` | Gap is intentional (test fixture, demo, documented fallback) with a recorded reason |
| `needs-review` | You can't implement the fix safely without more context — describe what's needed |
| `accepted` | Gap is acknowledged and left as-is (use sparingly; requires a strong reason) |

## Invariants

- Read the actual file before proposing any fix. The snippet is an excerpt.
- Never mark `fixed` without rerunning `selvedge.scan_completeness` narrowed to the patched
  path to confirm the rule no longer fires.
- Never dismiss a placeholder that feeds a production auth/crypto path without verifying it is
  genuinely not deployed (check environment configs, CI vars, deployment scripts).
- For hallucinated imports: always run `selvedge.check_package` before deciding the import is
  hallucinated — some niche packages do exist.

## Companion tools

- `selvedge.scan_completeness` — run after a fix to confirm the finding stops firing.
- `selvedge.check_package` — verify hallucinated import names against the real registry.
- `selvedge.list_findings` — review prior completeness triage on the same rule.
- `selvedge.triage` — record the final disposition.
- `Grep` — find callers, subclasses, or similar implementations for context.
- `Read` — read the full file, not just the snippet.

