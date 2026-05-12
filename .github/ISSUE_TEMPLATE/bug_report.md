---
name: Bug report
about: Something is broken; you have steps to reproduce.
title: "[bug] "
labels: ["bug"]
---

<!--
For a security issue, please DO NOT file a public bug report.
See SECURITY.md for the private disclosure channel.
-->

## What you ran

Paste the exact command, MCP tool call, or HTTP request.

```
signalman <verb> ...
```

## What you expected

One or two sentences describing the intended behavior.

## What actually happened

What did you see instead? Paste the full error output and the first
20-or-so lines of any stack trace.

```
<stderr / log output>
```

## Reproduction steps

Numbered steps that get from a clean checkout to the broken state.
If a fresh `git clone && cd host && npm ci && npm run build` reproduces
it, say so — that's the most useful baseline.

1.
2.
3.

## Environment

- `signalman --version` output:
- OS + version:
- Node version (`node -v`):
- Rust version (`rustc -V`) — only if you built from source:
- Hypervisor backend (Hyper-V / Tart / VMware) — if relevant:

## Anything else

Logs, screenshots, suspected root cause, related issues — anything
that might help triage. Workarounds you've found also welcome.
