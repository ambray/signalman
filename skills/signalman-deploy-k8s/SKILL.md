---
name: signalman-deploy-k8s
description: Deploy a manifest bundle or Helm chart to a Kubernetes namespace via Signalman. Auto-dispatches between `kubectl apply -k` and `helm upgrade --install` based on whether the bundle contains Chart.yaml at its root. Trigger on "deploy to k8s", "kubectl apply this", "helm install this chart", "land this release on the test cluster". Surfaces structured error codes for missing bundle paths, missing namespaces, and cluster auth failures.
allowed-tools: mcp__signalman__signalman_k8s_deploy, mcp__signalman__signalman_k8s_status
---

# Deploy to a Kubernetes target

This skill drives `signalman_k8s_deploy`, the MCP entry point onto
the `runK8sDeploy` executor. The executor inspects the bundle
directory — if it contains `Chart.yaml` at the root it dispatches
to `HelmDriver` (running `helm upgrade --install`), otherwise to
`KubectlDriver` (running `kubectl apply -k` for kustomize trees, or
`kubectl apply -f` for plain manifest dirs / single files).

`kubectl` (and `helm`, if you're applying a chart) must be on PATH
on the Signalman host. If a binary isn't found, the driver surfaces
`kubectl_not_found` / `helm_not_found`.

## What you need from the user

- **`bundle_uri`** — absolute path to a manifest bundle directory,
  a single `.yaml` file, or a Helm chart directory containing
  `Chart.yaml` at its root.
- **`namespace`** — Kubernetes namespace to deploy into. The driver
  does not default and does not read `$KUBE_NAMESPACE`; pin it
  explicitly so multi-tenant runs cohabit safely.
- (Optional) **`cluster_context`** — kubectl/helm context name.
  Omit to fall back to `$KUBECONFIG` selection.
- (Optional) **`release_name`** — Helm release name. Ignored for
  kubectl bundles. Defaults to the bundle directory's basename.
- (Optional) **`wait_for_health`** — defaults to true. When true,
  the executor runs `kubectl wait --for=condition=Ready pod --all`
  after apply and surfaces `health.ready` in the response.
- (Optional) **`health_timeout_ms`** — wait timeout in ms (default
  5 minutes). Translated to `kubectl wait --timeout=<seconds>s`.

## How to invoke

```jsonc
// signalman_k8s_deploy — Helm chart
{
  "bundle_uri": "/abs/path/to/my-chart",
  "namespace": "team-a-ci",
  "release_name": "my-app"
}
```

```jsonc
// signalman_k8s_deploy — kustomize dir
{
  "bundle_uri": "/abs/path/to/manifests",
  "namespace": "team-a-ci"
}
```

## Expected response envelope

Success:

```jsonc
{
  "ok": true,
  "value": {
    "apply": {
      "releaseName": "my-app",
      "namespace": "team-a-ci",
      "driver": "helm",
      "bundleKind": "helm_chart",
      "stdoutTail": "Release \"my-app\" has been upgraded. Happy Helming!\n",
      "durationMs": 8421
    },
    "health": {
      "namespace": "team-a-ci",
      "ready": true,
      "detail": null,
      "durationMs": 14223
    },
    "bundleKind": "helm_chart"
  }
}
```

Error envelope (`isError: true`):

```jsonc
{
  "ok": false,
  "error": {
    "code": "cluster_auth_failed",
    "message": "kubectl exited 1: Error from server (Forbidden): pods is forbidden..."
  }
}
```

## Error codes you may see

| `code` | What happened | What to tell the user |
|---|---|---|
| `bundle_path_missing` | `bundle_uri` does not exist on disk. | Operator must check the path. |
| `kubectl_not_found` | `kubectl` is not on PATH. | Install kubectl or set `SIGNALMAN_KUBECTL_BIN`. |
| `helm_not_found` | `helm` is not on PATH (only relevant for Chart.yaml bundles). | Install Helm or set `SIGNALMAN_HELM_BIN`. |
| `kubectl_failed` / `helm_failed` | Subprocess exited non-zero for a non-auth, non-namespace reason. | Surface the stderr tail; usually a manifest or resource issue. |
| `cluster_auth_failed` | kubectl/helm hit 401/403/credentials-missing. | Operator fixes kubeconfig / cluster context. |
| `namespace_missing` | The target namespace doesn't exist. | Operator creates it, or use a chart that includes the namespace (Helm's `--create-namespace` is on by default in this skill's helm path). |

## What NOT to do

- **Never** retry `kubectl_failed` or `helm_failed` blindly. The
  manifest or chart needs operator inspection — a blind retry
  usually fails the same way and may leave partial state in the
  cluster.
- **Never** apply a Helm chart with a `release_name` that clashes
  with an unrelated operator release in the same namespace. Helm
  release names are namespace-scoped; collisions overwrite the
  other team's release.
- **Never** disable `wait_for_health` for a "real" deploy in CI —
  the readiness probe is the only way the executor reports a
  "did the workload come up" signal back to the agent.

## Follow-up suggestions

- Pipe the `apply.driver` field into the corresponding
  `signalman_k8s_rollback` call; pass `driver: "helm"` for Helm
  releases, `driver: "kubectl"` for kubectl ones.
- Use `signalman_k8s_status` to inspect post-deploy state; for
  kubectl-deployed releases it parses `kubectl get deployments -o
  json` into normalised counts, for helm it reads `helm status
  <release> -o json`.
