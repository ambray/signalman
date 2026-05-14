---
name: signalman-rollback-k8s
description: Roll back a Kubernetes release via `kubectl rollout undo` or `helm rollback`. Trigger on "rollback the k8s deploy", "undo the helm release", "revert deployment/foo in namespace bar". For kubectl, the release id is the rollout subject (e.g. `deployment/my-app`); for helm, it's the Helm release name. Optional `to_revision` pins an explicit revision; omitting picks the immediately-preceding one.
allowed-tools: mcp__signalman__signalman_k8s_rollback, mcp__signalman__signalman_k8s_status
---

# Roll back a Kubernetes release

This skill drives `signalman_k8s_rollback`, the MCP entry point
onto `runK8sRollback`. The executor dispatches to `KubectlDriver`
(`kubectl rollout undo`) by default, or to `HelmDriver`
(`helm rollback`) when `driver: "helm"` is passed.

Kubernetes maintains its own revision history per workload (or per
Helm release), so this skill is **not** "redeploy the prior release
artifact" — that flow lives on the VM-target path. Here we simply
ask the cluster to revert the live workload to the prior revision.

## What you need from the user

- **`release_id`** — the rollback subject.
  - For kubectl: a workload rollout reference, typically
    `deployment/<name>` but also `daemonset/<name>`,
    `statefulset/<name>`, etc.
  - For helm: the Helm release name (the same name used at install).
- **`namespace`** — Kubernetes namespace. Mandatory; the rollback
  does not default it.
- (Optional) **`cluster_context`** — kubectl/helm context name.
- (Optional) **`to_revision`** — explicit revision number. When
  omitted, both tools pick the immediately-preceding revision (the
  common "undo last deploy" case).
- (Optional) **`driver`** — `"kubectl"` (default) or `"helm"`. The
  operator knows whether the release was applied via helm or
  kubectl; the skill does not auto-detect.

## How to invoke

```jsonc
// signalman_k8s_rollback — kubectl path
{
  "release_id": "deployment/my-app",
  "namespace": "team-a-ci"
}
```

```jsonc
// signalman_k8s_rollback — helm path with explicit revision
{
  "release_id": "my-app",
  "namespace": "team-a-ci",
  "to_revision": 3,
  "driver": "helm"
}
```

## Expected response envelope

Success:

```jsonc
{
  "ok": true,
  "value": {
    "releaseId": "deployment/my-app",
    "namespace": "team-a-ci",
    "driver": "kubectl",
    "toRevision": null,
    "stdoutTail": "deployment.apps/my-app rolled back\n",
    "durationMs": 1240
  }
}
```

Error envelope (`isError: true`):

```jsonc
{
  "ok": false,
  "error": {
    "code": "kubectl_failed",
    "message": "kubectl exited 1: error: deployments.apps \"my-app\" not found"
  }
}
```

## Error codes you may see

| `code` | What happened | What to tell the user |
|---|---|---|
| `kubectl_not_found` / `helm_not_found` | Tool binary missing on PATH. | Install or set the corresponding `SIGNALMAN_*_BIN`. |
| `kubectl_failed` / `helm_failed` | Tool exited non-zero (often because the named release does not exist, or the cluster rejects the rollback). | Surface stderr; the operator decides whether to retry with a different `release_id` or revision. |
| `cluster_auth_failed` | kubectl/helm hit 401/403. | Operator fixes kubeconfig / RBAC. |
| `namespace_missing` | Namespace doesn't exist. | The release can't be there either; check the namespace name. |

## What NOT to do

- **Never** rollback a Helm release using `driver: "kubectl"` — the
  workload owner is Helm, and a kubectl rollout undo will drop the
  release out of sync with the Helm history. (Conversely, kubectl-
  deployed workloads can't be rolled back with helm.)
- **Never** pass `to_revision: 0`. Kubernetes revisions start at
  1; the validator rejects ≤0.
- **Never** invoke rollback in a tight loop. Both tools have side
  effects on the cluster; agents should treat rollback as an
  intentional operator decision, not a polling primitive.

## Follow-up suggestions

- Confirm with `signalman_k8s_status` (same namespace, same driver
  hint) that the workload state matches expectations after rollback.
- For Helm, the prior revision's `--values` are restored too —
  remind the user that a rollback is not just a code revert.
