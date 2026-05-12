<!--
Thanks for sending a PR! A few notes before you fill this in:

- For security fixes, please read SECURITY.md first. We coordinate
  disclosure for vulnerabilities and you may want to file a private
  advisory before the public PR.
- Keep PRs small and single-topic when you can. "While I'm here"
  cleanup is best as a follow-up PR.
- See CONTRIBUTING.md for the dev environment, test commands, and
  what reviewers look for.
-->

## Summary

One or two sentences on what changes and why.

## Type of change

- [ ] Bug fix (a behavior the codebase advertised was already broken)
- [ ] Feature (new behavior the codebase didn't have before)
- [ ] Refactor (no behavior change, just internal structure)
- [ ] Documentation
- [ ] Test or tooling (new tests, CI config, lint rules, etc.)
- [ ] Security fix
- [ ] Breaking change (existing scripts / configs / scenarios need updating)

## What changed

A short narrative of the change, oriented around the diff. If you
introduced a new abstraction or made a non-obvious trade-off, this
is the place to explain the why.

## Test plan

How you convinced yourself the change works. For each:

- [ ] Unit / integration tests added or updated
- [ ] `npm run lint && npx tsc --noEmit` clean (host)
- [ ] `npx vitest run` passes locally (host)
- [ ] `cargo fmt --check && cargo clippy -- -D warnings && cargo test` clean
      for any Rust crate the PR touches (`guest/`, `service/`,
      `plugins/signalman-loom-plugin/`)
- [ ] Manual verification — describe what you ran and what you saw,
      especially for changes that aren't easy to unit-test
      (CLI UX, MCP tool surfaces, gRPC contracts, scenario behavior)

## Related issues

Closes #
<!-- Or "Related to #X" if this is a partial fix or a follow-up. -->

## Anything reviewers should know

Trade-offs you considered and rejected, follow-up work you plan
for a separate PR, places where reviewers' eyes are especially
welcome (gnarly logic, security-sensitive paths, anything you're
unsure about).
