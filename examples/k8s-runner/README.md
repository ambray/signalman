# Signalman runner on Kubernetes

Reference manifests for running Signalman scenario runners on top of
Kubernetes — both as one-shot `Job`s (the common CI shape) and as
warm `Deployment`s (lower-latency, polling, but slightly more
expensive at idle).

## What lands in these manifests

| File | What it deploys | When to use |
|---|---|---|
| [`serviceaccount.yaml`](./serviceaccount.yaml) | `ServiceAccount` + `Role` + `RoleBinding` that grants the runner the cluster permissions Signalman expects. | Once per namespace, before any runner Job/Deployment. |
| [`secret.example.yaml`](./secret.example.yaml) | Stencil for the `Secret` holding the runner's Bearer token + control-plane URL. **Do not commit a real token.** | Once per namespace. Regenerate the token on rotation. |
| [`job.yaml`](./job.yaml) | One-shot `Job` (`restartPolicy: Never`) that registers, polls once, and exits when its scenario run completes. | CI / matrix-build shape — fan out one Job per scenario invocation. |
| [`deployment.yaml`](./deployment.yaml) | Long-lived `Deployment` (1 replica) that registers and polls the control plane indefinitely. | Warm-pool / interactive-debug shape. Scale via `kubectl scale`. |

All manifests are namespace-scoped (no `ClusterRole`/`ClusterRoleBinding`).
You can run Signalman runners in many namespaces side-by-side on the
same cluster without permission overlap.

## Cluster prerequisites

Per docs/design/meta-build-system.md §14.2:

1. **`ServiceAccount`** in the target namespace with permissions to
   read its own pods + secrets, and to write Lease objects (used for
   leader election in future versions). Provided in
   `serviceaccount.yaml`. The runner uses
   `automountServiceAccountToken: true` (the cluster default) for
   in-cluster auth.
2. **`Secret`** holding the runner Bearer token + control-plane URL.
   The token authenticates the runner to the Signalman control plane
   HTTP service; rotate via `signalman api-key revoke` + `create`,
   then update the Secret. Provided as a template in
   `secret.example.yaml`. **Generate a real token via
   `signalman api-key create --name <runner>`; do not reuse the
   placeholder value.**
3. **Per-tenant namespace** (for multi-tenant shared clusters). One
   runner deployment per namespace; runners are blind to other
   namespaces because their RBAC stops at the namespace boundary.

## Quick start

```bash
# 1. Create the namespace (skip if it exists)
kubectl create namespace signalman-runners

# 2. Generate a runner token on the control-plane host
signalman api-key create --name k8s-runner-team-a

# 3. Copy the printed token into secret.example.yaml's data.token
#    base64-encoded, then apply:
kubectl -n signalman-runners apply -f serviceaccount.yaml
kubectl -n signalman-runners apply -f secret.example.yaml

# 4. Submit a Job (preferred for CI; Job exits when scenario completes)
kubectl -n signalman-runners apply -f job.yaml

# OR — submit a Deployment (preferred for warm-pool / dev)
kubectl -n signalman-runners apply -f deployment.yaml
```

`signalman runner deploy-k8s --manifest <path>` from the CLI wraps
this `kubectl apply` and additionally waits for the runner to
register with the control plane (it polls `GET /v1/runners` for the
runner-name your manifest declared in `metadata.generateName` /
`spec.template.metadata.labels.signalman-runner-name`).

## Customising

- **Image**: `ghcr.io/ambray/signalman-runner:0.3.0-6` (placeholder
  — replace with the image your release pipeline publishes).
- **Tenant id**: the runner reads its tenant from the downward-API
  `metadata.namespace` env var (`spec.template.spec.containers[0].env[2]`
  in both `job.yaml` and `deployment.yaml`). One namespace == one
  tenant by default.
- **Resource limits**: `requests` / `limits` in both manifests are
  sized for the v0.2.x scenario-runner footprint (256Mi memory).
  Bump when your scenarios drive heavier guest agents.
- **Concurrency**: `Job.spec.parallelism` defaults to 1; raise it
  to fan out parallel scenario polls from a single Job. For
  Deployment, scale via `kubectl scale deployment/signalman-runner
  --replicas=N`.

## Caveats

- These manifests use the **submit-mode** runner (PR 8 — see
  `host/src/runner/`); the runner polls `GET /v1/jobs` and claims
  one. They do not run the scenario-orchestrator in-cluster; that
  remains on the host that owns the test target (VM or, soon, a
  K8s deploy target as in v0.3.0-6 sub-task 1).
- The `Secret` strategy assumes the operator manages rotation. For
  cluster-side secret-rotation automation (External Secrets,
  Vault, etc.), wire those into the Secret rather than committing
  long-lived tokens.
- Multi-tenant isolation is namespace-only. For stronger isolation
  on shared clusters (image isolation, dedicated nodes), pair the
  `nodeSelector` + `tolerations` knobs in the manifests with your
  cluster's tenancy primitives.
