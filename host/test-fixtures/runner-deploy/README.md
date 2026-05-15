# Runner-deploy integration test fixtures

WS6 wave-3 carve-out #3. The M9 runner-deploy multi-transport surface
(`host/src/runner/deploy/`) ships with 45 unit tests pinning every
argv shape. This directory holds the scaffolding for running the
transports against real targets — which the unit tests can't cover.

The integration tests live at
`host/src/__tests__/runner-deploy.integration.test.ts`. They are
**gated** on `SIGNALMAN_INTEGRATION_TESTS=1`; without it, every case
is skipped and `npx vitest run` passes cleanly.

## Running locally

Prerequisites:

- Docker (for the sshd + busybox fixtures)
- Node 22+ (matches the host's runtime requirement)
- `ssh-keygen` (for the throwaway SSH keypair)

Steps:

```bash
# 1. From repo root: generate a throwaway SSH keypair
mkdir -p host/test-fixtures/runner-deploy/fixtures
ssh-keygen -t ed25519 -N "" -f host/test-fixtures/runner-deploy/fixtures/id_int -C "signalman-integration"
cp host/test-fixtures/runner-deploy/fixtures/id_int.pub \
   host/test-fixtures/runner-deploy/fixtures/authorized_keys

# 2. Start the sshd fixture
docker compose -f host/test-fixtures/runner-deploy/docker-compose.yml up -d

# 3. Run the integration tests
cd host
SIGNALMAN_INTEGRATION_TESTS=1 \
SIGNALMAN_INTEGRATION_SSH_IDENTITY=$(realpath ../host/test-fixtures/runner-deploy/fixtures/id_int) \
npx vitest run src/__tests__/runner-deploy.integration.test.ts

# 4. Tear down
docker compose -f host/test-fixtures/runner-deploy/docker-compose.yml down
```

## Env-var checklist

The integration tests self-skip when their pre-conditions aren't met.
Here's what activates each leg:

| Transport | Env var(s) | What gets tested |
|---|---|---|
| `script` | `SIGNALMAN_INTEGRATION_TESTS=1` | Emits the bash script; verifies `curl` against a local mock binary server. Linux/macOS only (Windows uses pwsh, not validated end-to-end here). |
| `ssh` | + `SIGNALMAN_INTEGRATION_SSH_IDENTITY=<path-to-private-key>` (override host/port via `_SSH_HOST` / `_SSH_PORT`; defaults to `127.0.0.1:2222`) | Runs `SshTransport.bootstrap` against the containerised sshd. Uses `serviceManager: "none"` so the test doesn't require sudo on the container. |
| `winrm` | + `SIGNALMAN_INTEGRATION_WINRM_HOST` + `_WINRM_USER` + `_WINRM_PASS` | Operator-driven only — points at a real Windows host with `Enable-PSRemoting -Force`. There's no containerised Windows fixture (cross-platform WinRM-in-Docker is genuinely awkward). |
| `docker` | `SIGNALMAN_INTEGRATION_TESTS=1` (no extras) | `DockerTransport.bootstrap` against the local Docker daemon. Uses `busybox:latest` as a stand-in image; tests the docker argv + run lifecycle. |
| `cloud` | + `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` *or* `AZURE_TENANT_ID` / `AZURE_CLIENT_ID` / `AZURE_CLIENT_SECRET` + **`SIGNALMAN_INTEGRATION_CLOUD_OPT_IN=1`** | Provisions a real VM. **Costs money.** The opt-in env var double-confirms operator consent before any vendor API call. |

The cloud leg is intentionally extra-gated — it bills real money. The
double opt-in (creds present **and** explicit `_CLOUD_OPT_IN=1`) is
deliberate.

## CI workflow

`.github/workflows/runner-deploy-integration.yml` automates this:

- Runs on `workflow_dispatch`, weekly schedule, and PRs touching
  `host/src/runner/deploy/**`.
- Starts the docker-compose fixtures, generates a throwaway keypair,
  runs the gated test file.
- Cloud leg gated on `secrets.AWS_ACCESS_KEY_ID != ''` — skipped in
  forked-PR builds where secrets aren't available.

## What's NOT tested here

- **WinRM end-to-end**: requires a real Windows target. Operator's
  responsibility to run that against their actual on-prem / Windows
  Server / Azure-VM fixture.
- **The signalman-runner binary itself**: the integration tests use
  a sentinel HTTP body as the "binary"; they don't validate that a
  real runner actually starts. The unit-tests in
  `runner-deploy.test.ts` pin the argv shape; the
  signalman-guest crate's own test suite covers the runner.
- **Cross-region cloud**: only one region per cloud, per run. The
  cost-reaper's wave-2 tests cover multi-region tag scanning.

## Files

- `docker-compose.yml` — sshd fixture (linuxserver/openssh-server).
- `fixtures/` (gitignored; created locally) — throwaway SSH keys.
- This README.

## Gitignore

The `fixtures/` directory is gitignored at the repo root (see
`.gitignore`). Throwaway keys MUST NOT be committed.
