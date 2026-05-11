---
name: signalman-deploy-to-demo
description: Deploy a tagged release to the clean demo target VM. Only run this for an explicit minor-version tag the operator has named, after the release has been built and tested. Triggers on "ship <tag> to demo", "deploy <tag> to win11-demo", "promote the release". Refuses if the release was never deployed to a test target first.
allowed-tools: Bash
---

# Deploy a release to the demo VM

The demo surface is the **clean** half of the two-tier deploy model. Per the operator's release operating model:

- Only deployed at **minor-version tag boundaries** (e.g. `v1.2.0`).
- Only after the same release has passed test-tier verification.
- Operator must have explicitly said "tag and ship X.Y.0" — don't infer this from chat history.
- Each minor-version tag = one demo deploy. Refuse incremental deploys.

## Prerequisites — check before invoking

1. The release exists and is `ready`. `signalman release show <id>` or `signalman release list --status ready`.
2. The tag is a minor-version boundary (matches `vN.M.0`). If it's a patch tag (`v1.2.1`) ask the user to confirm — that's not the normal pattern.
3. A prior deploy of this release to a `vm_test` target completed successfully. `signalman health history --target <test-target>` should show that release with all probes passing.
4. The demo target exists and is `kind: vm_demo`. `signalman target list`.

If any of these fail, STOP and tell the user what's missing. Do not deploy.

## How to invoke

```bash
signalman release deploy --release <ID> --target <DEMO_TARGET> --format json
```

(Same machinery as test deploy — only the target kind differs.)

## On failure

A demo deploy failure auto-restores the pre-deploy checkpoint, so the VM goes back to the previous good state. Surface:
- Which probe(s) failed.
- The previous active deployment that was preserved.

Recommend `signalman release rollback --target <DEMO_TARGET>` only if the deploy actually succeeded but the operator wants to revert. In a failure case rollback is unnecessary (the checkpoint already restored).

## What NOT to do

- Never deploy a non-tagged or pre-release build to demo.
- Never auto-promote without operator confirmation — even if the release ran clean on test.
- Don't deploy "to test it on demo" — that's a category error. Test on `vm_test`.

## Follow-up suggestions

- Announce the new demo state to the operator (release tag + deployment id).
- Suggest `signalman release rollback --target <DEMO>` if anything looks off in operator-driven testing.
