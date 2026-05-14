---
name: signalman-k8s-status
description: Read deployment/release status in a Kubernetes namespace via `kubectl get deployments -o json` (default) or `helm status -o json`. Trigger on "what's running in namespace foo", "are the pods ready", "is my deploy healthy", "show me deployment state". Normalises across kubectl + helm into a single workload list with a derived state (healthy / degraded / unknown).
allowed-tools: mcp__signalman__signalman_k8s_status
---

# Read K8s deployment status

This skill drives `signalman_k8s_status`, the MCP entry point onto
`runK8sStatus`. The driver dispatches to `KubectlDriver.status`
(parsing `kubectl get deployments -o json`) by default, or to
`HelmDriver.status` (parsing `helm status <release> -o json`) when
`driver: "helm"` + `release_name` are passed.

State derivation (kubectl path):
- `healthy`: `replicas > 0 && readyReplicas === replicas`
- `degraded`: `replicas > 0 && readyReplicas < replicas`
- `unknown`: `replicas === 0` or fields missing

State derivation (helm path):
- `healthy`: `info.status === "deployed"`
- `unknown`: `info.status` starts with `pending-`
- `degraded`: any other status (failed, superseded, …)

## What you need from the user

- **`namespace`** — Kubernetes namespace to inspect.
- (Optional) **`cluster_context`** — kubectl/helm context name.
- (Optional) **`selector`** — label selector forwarded to
  `kubectl get -l <selector>`. Ignored by the helm path.
- (Optional) **`driver`** — `"kubectl"` (default) or `"helm"`.
- **`release_name`** — required when `driver: "helm"`; the executor
  rejects with `helm_failed` otherwise.

## How to invoke

```jsonc
// All deployments in a namespace
{ "namespace": "team-a-ci" }
```

```jsonc
// Filter by label
{ "namespace": "team-a-ci", "selector": "app=checkout" }
```

```jsonc
// Helm release status
{ "namespace": "team-a-ci", "driver": "helm", "release_name": "my-app" }
```

## Expected response envelope

Success (kubectl, two deployments):

```jsonc
{
  "ok": true,
  "value": {
    "namespace": "team-a-ci",
    "workloads": [
      {
        "name": "api",
        "kind": "Deployment",
        "replicas": 3,
        "readyReplicas": 3,
        "availableReplicas": 3,
        "state": "healthy"
      },
      {
        "name": "worker",
        "kind": "Deployment",
        "replicas": 5,
        "readyReplicas": 2,
        "availableReplicas": 2,
        "state": "degraded"
      }
    ],
    "allHealthy": false
  }
}
```

Success (helm — single normalised entry):

```jsonc
{
  "ok": true,
  "value": {
    "namespace": "team-a-ci",
    "workloads": [
      {
        "name": "my-app",
        "kind": "HelmRelease",
        "replicas": 0,
        "readyReplicas": 0,
        "availableReplicas": 0,
        "state": "healthy"
      }
    ],
    "allHealthy": true
  }
}
```

The helm path leaves `replicas`/`readyReplicas` at zero because
Helm's status JSON only carries release-level state, not pod-level
counts. Compose with a second kubectl-driver call against the same
namespace if you need the pod-level data.

## Error codes you may see

| `code` | What happened | What to tell the user |
|---|---|---|
| `kubectl_not_found` / `helm_not_found` | Tool binary missing. | Install or set `SIGNALMAN_*_BIN`. |
| `kubectl_failed` / `helm_failed` | Tool exited non-zero. For helm, the most common cause is "release: not found" (the `release_name` is wrong or never installed). | Surface stderr. |
| `cluster_auth_failed` | 401/403 from the cluster. | Operator fixes kubeconfig / RBAC. |
| `namespace_missing` | Namespace doesn't exist. | Use a different namespace or create it. |

## What NOT to do

- **Never** poll status faster than once per second — kubectl/helm
  invocations are not free and the kube-apiserver rate-limits.
- **Never** use this to wait for readiness — `signalman_k8s_deploy`
  already runs `kubectl wait` after apply when `wait_for_health`
  is true (the default). Use this for diagnostic snapshots, not
  health gating.
- **Never** assume the helm path returns pod-level counts; if you
  need replicas, call again with the kubectl driver against the
  same namespace.

## Follow-up suggestions

- For a degraded workload, fetch `kubectl logs` (out of scope for
  this skill — operator does it directly) and decide whether to
  `signalman_k8s_rollback` to the prior revision.
- For an `unknown`-state Helm release (`pending-install`,
  `pending-upgrade`), wait a few seconds and re-poll — Helm
  transitions out of pending fairly quickly under normal
  conditions, and a stuck pending state usually means a Helm hook
  is hanging.
