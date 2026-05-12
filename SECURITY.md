# Security Policy

Thank you for helping keep Signalman secure. This document covers how to
report a vulnerability, what to expect, and which versions receive
security fixes.

## Reporting a vulnerability

**Please do not file public GitHub issues for security bugs.** The
preferred channel is GitHub's private vulnerability reporting:

- Open a private advisory at
  [github.com/.../signalman/security/advisories/new](https://github.com/ambray/signalman/security/advisories/new)
  (replace `ambray` with the canonical owner once the repo is public).
- Alternatively, email **security@eldritchtech.io** with details. Please
  include "Signalman security report" in the subject line. PGP is not
  currently required; if you would like an encrypted channel, request a
  key in your first message.

When reporting, please include:

1. A description of the issue and the impact you think it has.
2. Reproduction steps — concrete enough that we can confirm the bug
   without guessing about your environment.
3. The affected version (`signalman --version` output, or commit SHA if
   you're on a development branch).
4. Any proof-of-concept code, log snippets, or screenshots that help.

You do not need a fix in hand to report. A clear bug report is enough.

## What to expect

- **Acknowledgement within 72 hours** of receipt. We will confirm we
  received the report and assign it a working tracking ID.
- **Initial assessment within 7 days**: severity classification (using
  [CVSS 3.1](https://www.first.org/cvss/calculator/3.1)), whether we
  can reproduce, and a tentative fix timeline.
- **Resolution within 90 days** for High or Critical findings; lower
  severities ship on the next regular release cycle. If a fix is going
  to take longer, we will tell you and explain why.
- **Coordinated disclosure**: we will request you keep the issue
  confidential until a fixed release ships or the 90-day window closes,
  whichever comes first. We will credit you in the release notes
  (unless you ask us not to).

## Scope

The following are in-scope for this policy:

- The Signalman host (`host/`) and its CLI / MCP server surfaces.
- The Signalman guest agent (`guest/`).
- The Hyper-V host service (`service/`).
- The Loom plugin (`plugins/signalman-loom-plugin/`).
- The control-plane HTTP API (`signalman serve`) including auth,
  storage, and blob drivers.
- The Ed25519 manifest-signing path (`signalman release build --sign`,
  `signalman release verify`).
- Release artifacts (signed MSIs, the npm package, the crates.io
  package).

Out of scope for this policy (but interesting to us — file regular
issues if you'd like):

- Bugs in scenarios checked into a consuming product's own repo.
- Issues that require physical access to the host or a malicious
  operator with administrator-level local access (these are part of
  the threat model documented in
  [docs/design/meta-build-system.md](docs/design/meta-build-system.md)).
- Social-engineering, phishing, or supply-chain attacks against
  individual maintainers' accounts (report those to the relevant
  platform).

## Supported versions

We provide security fixes for:

| Version line | Status | Security fixes |
|---|---|---|
| `0.3.x` (current development) | Active | ✅ Yes |
| `0.1.x` | Maintained | ✅ Yes |
| `0.2.x` (skipped — folded into 0.3) | — | — |
| Pre-`0.1.0` | Unmaintained | ❌ No |

Once we reach `1.0.0`, the supported window will narrow to the current
major + the most recent prior major.

## Dependency vulnerabilities

We track dependency CVEs via `npm audit` and `cargo audit` on every
CI run. If you find an issue in one of our dependencies that we have
not yet picked up, please open a regular GitHub issue rather than a
security advisory — these are public information by the time we see
them. If exploiting it requires a Signalman-specific configuration or
code path, then it's also a Signalman issue and the advisory channel
above applies.

## Public-facing security work

The pre-public-release security audit closed findings F1 through F5;
the structured report is in the commit message of `618f353` (`security
+ docs: pre-public-release readiness pass`) and the changes that
addressed them.
