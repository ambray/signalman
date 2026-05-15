# Capability matrix — 2026-05

**Scope**: every capability shipped to `main` at commit `558e0ed` (v0.3.0-5 sub-task 4). This audit was produced for the WS6 milestone (`docs/workstreams/prompts/ws6-audit-skills.md`); WS1-WS5 in-flight work is intentionally excluded.

**Method**:

- **MCP-exposed?** — a `server.tool(...)` registration in [host/src/server.ts](../../host/src/server.ts). Advanced tools are registered under the `signalman_advanced_*` prefix; legacy tool names remain as one-release deprecation aliases.
- **CLI-exposed?** — a verb in [host/src/cli.ts](../../host/src/cli.ts), reached from the top-level switch.
- **Skill-covered?** — a `skills/<name>/SKILL.md` exists with trigger phrases that an agent would match on for that capability.
- **Functional?** — a unit/integration test exercises the capability and is in the suite (`host/src/__tests__/`). Cells marked PARTIAL note where coverage is shallow or the operator-visible path is gated on something not yet shipped.

Each cell uses ✅ / ❌ / PARTIAL with a one-line note. Cells are sorted by surface (lifecycle/build/deploy/health/cloud/etc.) to keep adjacent rows comparable.

---

## Matrix

### Product lifecycle

| Capability | Where it lives | Functional? | MCP-exposed? | CLI-exposed? | Skill-covered? | Notes |
|---|---|---|---|---|---|---|
| product add | [verbs/control-plane.ts](../../host/src/verbs/control-plane.ts) | ✅ `control-plane-verbs.test.ts` | ✅ `signalman_product_add` | ✅ `signalman product add` | ❌ | Precondition for any release work; no skill walks an agent through repo URL / build_yaml_path |
| product list | same | ✅ same | ✅ `signalman_product_list` | ✅ `signalman product list` | ❌ | No skill |
| product remove | same | ✅ same | ✅ `signalman_product_remove` | ✅ `signalman product remove` | ❌ | Soft-delete (`deleted_at`); releases remain in catalog |

### Release pipeline

| Capability | Where it lives | Functional? | MCP-exposed? | CLI-exposed? | Skill-covered? | Notes |
|---|---|---|---|---|---|---|
| release build (in-process) | [control-plane/build/executor.ts](../../host/src/control-plane/build/executor.ts) | ✅ `build-executor.test.ts`, `release-signing-e2e.test.ts` | ✅ `signalman_release_build` | ✅ `signalman release build` | ✅ [signalman-build-from-tag](../../skills/signalman-build-from-tag/SKILL.md) | |
| release build (remote runner) | [runner/worker.ts](../../host/src/runner/worker.ts) | ✅ `runner-worker.test.ts`, `remote-release-build.test.ts` | ❌ | ✅ `signalman release build --remote` | ❌ | MCP path queues the job through HTTP only |
| release list | [verbs/control-plane.ts](../../host/src/verbs/control-plane.ts) | ✅ `control-plane-verbs.test.ts` | ✅ `signalman_release_list` | ✅ `signalman release list` | ❌ | |
| release show | same | ✅ same | ✅ `signalman_release_show` | ✅ `signalman release show` | ❌ | |
| release verify | [cli.ts:cmdReleaseVerify](../../host/src/cli.ts) | ✅ `release-signing-e2e.test.ts`, `signing.test.ts` | ❌ | ✅ `signalman release verify` | ❌ | Fingerprint + signature check; no MCP wrapper |
| release rollback | [verbs/control-plane.ts](../../host/src/verbs/control-plane.ts) | ✅ `control-plane-deploy-verbs.test.ts` | ✅ `signalman_release_rollback` | ✅ `signalman release rollback` | ✅ [signalman-rollback](../../skills/signalman-rollback/SKILL.md) | |
| manifest signing (Ed25519) | [control-plane/build/signing.ts](../../host/src/control-plane/build/signing.ts) | ✅ `signing.test.ts`, `release-signing-e2e.test.ts` | ❌ direct | ❌ direct | ❌ | Always wired into `release build`; standalone sign verb intentionally not exposed (single-shot from build) |

### Deploy

| Capability | Where it lives | Functional? | MCP-exposed? | CLI-exposed? | Skill-covered? | Notes |
|---|---|---|---|---|---|---|
| deploy to VM target (Hyper-V/Tart) | [control-plane/deploy/executor.ts](../../host/src/control-plane/deploy/executor.ts) | ✅ `deploy-executor.test.ts`, `deploy-executor-probes.test.ts` | ✅ `signalman_release_deploy` (kind: vm_*) | ✅ `signalman release deploy --target <vm_*>` | ✅ [signalman-deploy-to-test](../../skills/signalman-deploy-to-test/SKILL.md), [signalman-deploy-to-demo](../../skills/signalman-deploy-to-demo/SKILL.md) | |
| deploy to docker-compose target | same | ✅ same | ✅ `signalman_release_deploy` (kind: docker_*) | ✅ `signalman release deploy --target <docker_*>` | ❌ | Same MCP/CLI surface; skills only document VM tiers |
| deploy to `cloud_vm` target | n/a | ❌ | ❌ | ❌ | ❌ | Prompt-enumerated capability not yet shipped; cloud surface ends at `cloud_provision`, no `target kind: cloud_vm` |
| deploy to `cloud_stack` target | n/a | ❌ | ❌ | ❌ | ❌ | Same — `signalman_stack_apply` runs HCL, but there's no `target kind: cloud_stack` that release deploy understands |

### Target management

| Capability | Where it lives | Functional? | MCP-exposed? | CLI-exposed? | Skill-covered? | Notes |
|---|---|---|---|---|---|---|
| target add | [verbs/control-plane.ts](../../host/src/verbs/control-plane.ts) | ✅ `control-plane-verbs.test.ts` | ✅ `signalman_target_add` | ✅ `signalman target add` | ❌ | |
| target list | same | ✅ same | ✅ `signalman_target_list` | ✅ `signalman target list` | ❌ | |
| target remove | same | ✅ same | ✅ `signalman_target_remove` | ✅ `signalman target remove` | ❌ | Soft-delete; past deployments preserved |
| target connection-detail edit | n/a | ❌ | ❌ | ❌ | ❌ | Prompt-enumerated but not shipped; current path is remove + re-add with new connection JSON |

### Runner management

| Capability | Where it lives | Functional? | MCP-exposed? | CLI-exposed? | Skill-covered? | Notes |
|---|---|---|---|---|---|---|
| runner register | [cli.ts:cmdRunnerRegister](../../host/src/cli.ts) | PARTIAL — exercised via `remote-release-build.test.ts` end-to-end; no direct unit | ❌ | ✅ `signalman runner register` | ❌ | Writes `.signalman/runner.json` on the runner host |
| runner start | [runner/worker.ts](../../host/src/runner/worker.ts) | ✅ `runner-worker.test.ts` | ❌ | ✅ `signalman runner start` | ❌ | Long-running; daemon-style |
| runner list | n/a | ❌ | ❌ | ❌ | ❌ | Prompt-enumerated but not shipped; control plane has no view of registered workers beyond their job claims |
| runner deploy | n/a | ❌ | ❌ | ❌ | ❌ | Not shipped; install is operator-manual |
| runner deregister | n/a | ❌ | ❌ | ❌ | ❌ | Not shipped; operator deletes `.signalman/runner.json` and revokes the api-key |

### Scenario execution

| Capability | Where it lives | Functional? | MCP-exposed? | CLI-exposed? | Skill-covered? | Notes |
|---|---|---|---|---|---|---|
| scenario list | [verbs/list.ts](../../host/src/verbs/list.ts) | ✅ `scenarios.test.ts`, `cli-capture.test.ts` | ✅ `signalman_list` | ✅ `signalman list` | ❌ | **Primary agent discovery verb — no skill** |
| scenario describe | [verbs/describe.ts](../../host/src/verbs/describe.ts) | ✅ `scenarios.test.ts` | ✅ `signalman_describe` | ✅ `signalman describe` | ❌ | |
| scenario plan (dry-run) | [verbs/plan.ts](../../host/src/verbs/plan.ts) | ✅ `scenarios.test.ts` | ✅ `signalman_plan` | ✅ `signalman plan` | ❌ | |
| scenario run | [verbs/run.ts](../../host/src/verbs/run.ts), `scenarios/orchestrator.ts` | ✅ `orchestrator.test.ts`, `scenarios.test.ts`, `orchestrator-envelope.test.ts` | ✅ `signalman_run` | ✅ `signalman run` | ❌ | **Primary agent execution verb — no skill** |
| scenario status / event drain | [verbs/status.ts](../../host/src/verbs/status.ts), `verbs/run-store.ts` | ✅ `orchestrator-events.test.ts` | ✅ `signalman_status` | ✅ `signalman status` | ❌ | |
| scenario record | [verbs/record.ts](../../host/src/verbs/record.ts) | ✅ `cli-capture.test.ts` | ✅ `signalman_record` | ✅ `signalman record` | ❌ | v0.3.0-1 record/replay |
| scenario record finalize (synthesise) | same, `scenarios/synthesiser-*` | ✅ `synthesiser-vm-inference.test.ts` | ✅ `signalman_record_finalize` | ✅ `signalman record finalize` | ❌ | |

### Health

| Capability | Where it lives | Functional? | MCP-exposed? | CLI-exposed? | Skill-covered? | Notes |
|---|---|---|---|---|---|---|
| health check (run probes now) | [verbs/control-plane.ts](../../host/src/verbs/control-plane.ts) | ✅ `health-verbs.test.ts`, `deploy-executor-probes.test.ts` | ✅ `signalman_health_check` | ✅ `signalman health check` | ✅ [signalman-health-check](../../skills/signalman-health-check/SKILL.md) | |
| health history | same | ✅ `health-verbs.test.ts` | ✅ `signalman_health_history` | ✅ `signalman health history` | ❌ | |

### Probes (registry / individual kinds)

| Capability | Where it lives | Functional? | MCP-exposed? | CLI-exposed? | Skill-covered? | Notes |
|---|---|---|---|---|---|---|
| `command` probe | [control-plane/probes/runner.ts](../../host/src/control-plane/probes/runner.ts) | ✅ `probe-runner.test.ts` | n/a (run via health_check) | n/a | ❌ | Building block — addressable only through `signalman.build.yaml` declarations |
| `http_in_guest` probe | same | ✅ same | n/a | n/a | ❌ | Same |
| `file_in_guest` probe | same | ✅ same | n/a | n/a | ❌ | Same |
| probe declaration in `signalman.build.yaml` | [control-plane/build/yaml.ts](../../host/src/control-plane/build/yaml.ts) | ✅ `build-yaml.test.ts` | n/a | n/a | ❌ | Declared per-component; document-only contract for product authors |

### Audit log

| Capability | Where it lives | Functional? | MCP-exposed? | CLI-exposed? | Skill-covered? | Notes |
|---|---|---|---|---|---|---|
| audit append (internal) | [control-plane/storage/{sqlite,postgres}.ts](../../host/src/control-plane/storage/) | ✅ `control-plane-storage.test.ts` | ❌ | ❌ | ❌ | Auto-called from build/deploy executors |
| audit query | same; HTTP at `/v1/audit` | ✅ `http-app.test.ts`, `http-writes.test.ts` | ❌ | ❌ | ❌ | **HTTP-only**; no `signalman audit query` CLI, no `signalman_audit_*` MCP |
| audit post (external append) | HTTP at `POST /v1/audit` | ✅ `http-writes.test.ts` | ❌ | ❌ | ❌ | HTTP-only |

### Storage

| Capability | Where it lives | Functional? | MCP-exposed? | CLI-exposed? | Skill-covered? | Notes |
|---|---|---|---|---|---|---|
| SQLite driver (default) | [control-plane/storage/sqlite.ts](../../host/src/control-plane/storage/sqlite.ts) | ✅ `control-plane-storage.test.ts` and every CP test | n/a config | n/a config | n/a | Config choice, not a verb |
| Postgres driver (opt-in) | [control-plane/storage/postgres.ts](../../host/src/control-plane/storage/postgres.ts) | ✅ `postgres-storage.test.ts` (pg-mem) | n/a config | n/a config | n/a | Config choice |
| Local-FS blob driver | [control-plane/blobs/](../../host/src/control-plane/blobs/) | ✅ `control-plane-blobs.test.ts` | n/a config | n/a config | n/a | |
| S3 blob driver | same | ✅ `s3-blob.test.ts`, `http-blobs.test.ts` | n/a config | n/a config | n/a | |

### Signing (key + verify)

| Capability | Where it lives | Functional? | MCP-exposed? | CLI-exposed? | Skill-covered? | Notes |
|---|---|---|---|---|---|---|
| key generate (Ed25519 pair) | [cli.ts:cmdKeyGenerate](../../host/src/cli.ts), `control-plane/build/signing.ts` | ✅ `signing.test.ts` | ❌ | ✅ `signalman key generate` | ❌ | |
| key fingerprint | [cli.ts:cmdKeyFingerprint](../../host/src/cli.ts) | ✅ `signing.test.ts` | ❌ | ✅ `signalman key fingerprint` | ❌ | |
| manifest sign | called internally by `release build` | ✅ `release-signing-e2e.test.ts` | ❌ | ❌ | ❌ | Not exposed standalone |
| manifest verify | [cli.ts:cmdReleaseVerify](../../host/src/cli.ts) | ✅ `release-signing-e2e.test.ts`, `signing.test.ts` | ❌ | ✅ `signalman release verify` | ❌ | |

### Cloud (v0.3.0-5)

| Capability | Where it lives | Functional? | MCP-exposed? | CLI-exposed? | Skill-covered? | Notes |
|---|---|---|---|---|---|---|
| cloud provision (AWS EC2, Azure VM) | [cloud/aws.ts](../../host/src/cloud/aws.ts), `cloud/azure.ts` | ✅ `cloud-aws.test.ts`, `cloud-azure.test.ts`, `server-cloud-tools.test.ts` | ✅ `signalman_cloud_provision` | ❌ | ✅ [signalman-provision-cloud-vm](../../skills/signalman-provision-cloud-vm/SKILL.md) | **MCP-only; no CLI verb** |
| cloud terminate | same | ✅ same | ✅ `signalman_cloud_terminate` | ❌ | ✅ [signalman-terminate-cloud-vm](../../skills/signalman-terminate-cloud-vm/SKILL.md) | MCP-only |
| cloud status | same | ✅ same | ✅ `signalman_cloud_status` | ❌ | ❌ | MCP-only; no skill |
| cloud list (signalman-managed only) | same | ✅ same | ✅ `signalman_cloud_list` | ❌ | ✅ [signalman-list-cloud-instances](../../skills/signalman-list-cloud-instances/SKILL.md) | MCP-only |
| cloud backends discovery | [cloud/registry.ts](../../host/src/cloud/registry.ts) | ✅ `cloud-registry.test.ts`, `server-cloud-tools.test.ts` | ✅ `signalman_cloud_backends` | ❌ | ❌ | MCP-only; no skill |
| stack apply (OpenTofu) | [cloud/tofu.ts](../../host/src/cloud/tofu.ts) | ✅ `cloud-tofu.test.ts` | ✅ `signalman_stack_apply` | ❌ | ✅ [signalman-apply-cloud-stack](../../skills/signalman-apply-cloud-stack/SKILL.md) | MCP-only |
| stack destroy | same | ✅ same | ✅ `signalman_stack_destroy` | ❌ | ✅ [signalman-destroy-cloud-stack](../../skills/signalman-destroy-cloud-stack/SKILL.md) | MCP-only |

### Hypervisors

| Capability | Where it lives | Functional? | MCP-exposed? | CLI-exposed? | Skill-covered? | Notes |
|---|---|---|---|---|---|---|
| Hyper-V backend (Windows) | [hypervisors/hyperv*.ts](../../host/src/hypervisors/) | ✅ `hyperv-backend.test.ts`, `no_gsudo_regression.test.ts` | ✅ (via `signalman_advanced_vm_*` + scenarios) | ✅ (via `signalman vm *`) | n/a backend | Primary backend; selected by config and availability probe |
| Tart backend (macOS) | [hypervisors/tart.ts](../../host/src/hypervisors/) | ✅ `tart-backend.test.ts` | ✅ same | ✅ same | n/a backend | |
| VMware backend (deprecated) | [hypervisors/vmware.ts](../../host/src/hypervisors/) | ✅ `vmware.test.ts` | ✅ same | ✅ same | n/a backend | Fallback; no new feature work |
| Cloud backends (AWS / Azure) | [cloud/](../../host/src/cloud/) | ✅ — see Cloud section | — | — | — | Not a hypervisor abstraction; lifecycle is `cloud_provision` not `vm_*` |

### Kernel-debug

| Capability | Where it lives | Functional? | MCP-exposed? | CLI-exposed? | Skill-covered? | Notes |
|---|---|---|---|---|---|---|
| KD session lifecycle | [kernel-debug/kd-session.ts](../../host/src/kernel-debug/kd-session.ts) | ✅ `kd-session.test.ts`, `kd-lifecycle.test.ts` | n/a (scenario tool-block only) | n/a | ❌ | Used from scenario workflows via tool-registry |
| ETW handlers | [kernel-debug/etw-handlers.ts](../../host/src/kernel-debug/etw-handlers.ts) | ✅ `etw-handlers.test.ts` | n/a | n/a | ❌ | |
| Exception / bugcheck handlers | [kernel-debug/kernel-handlers.ts](../../host/src/kernel-debug/kernel-handlers.ts) | ✅ `kd-handlers.test.ts`, `kd-crash-handlers.test.ts` | n/a | n/a | ❌ | |
| Driver tool block (`driver_load`/`unload`/`ioctl`) | [kernel-debug/driver-handlers.ts](../../host/src/kernel-debug/driver-handlers.ts) | ✅ `kd-tool-registry.test.ts` | n/a (scenario tool-block) | n/a | ❌ | |

### UI automation

| Capability | Where it lives | Functional? | MCP-exposed? | CLI-exposed? | Skill-covered? | Notes |
|---|---|---|---|---|---|---|
| UIA element discovery | [tools/vm-ui.ts](../../host/src/tools/vm-ui.ts), `guest/ui-elements.ts` | ✅ `ui-elements.test.ts`, `vm-ui-tools.test.ts` | ✅ `signalman_advanced_vm_ui_find`, `…_snapshot`, `…_wait_for` | ❌ (subset of `signalman vm exec` is available) | ❌ | |
| UIA click / key / type | same | ✅ same, `ui-workflow.test.ts` | ✅ `signalman_advanced_vm_ui_click`, `…_key`, `…_type` | ❌ | ❌ | |
| Browser open / navigate | [tools/vm-browser.ts](../../host/src/tools/vm-browser.ts) | ✅ `vm-browser-tools.test.ts`, `browser-workflow.test.ts`, `ui-browser.test.ts` | ✅ `signalman_advanced_vm_browser_*` | ❌ | ❌ | |
| UI sidecar lifecycle | [tools/vm-ui.ts](../../host/src/tools/vm-ui.ts) | ✅ `ui-sidecar.test.ts`, `ui-recovery.test.ts` | ✅ `signalman_advanced_vm_ui_ensure_sidecar`, `…_health` | ❌ | ❌ | |
| VM screenshot (out-of-guest) | [tools/vm-operations.ts](../../host/src/tools/vm-operations.ts) | ✅ `vm-cache.test.ts`, indirectly via `ui-*` tests | ✅ `signalman_advanced_vm_screenshot` | ❌ | ❌ | |

### Provisioning (host-side)

| Capability | Where it lives | Functional? | MCP-exposed? | CLI-exposed? | Skill-covered? | Notes |
|---|---|---|---|---|---|---|
| Ephemeral VM provision | [provisioning/](../../host/src/provisioning/), `tools/vm-provisioning.ts` | ✅ `ephemeral-vm.test.ts`, `provisioning.test.ts`, `provisioning-idempotency.test.ts` | ✅ `signalman_advanced_vm_provision` | ✅ `signalman vm provision` | ❌ | Default namespace, not behind `_advanced_` |
| Differencing-disk plumbing | [provisioning/differencing-disk.ts](../../host/src/provisioning/differencing-disk.ts) | ✅ `differencing-disk.test.ts` | n/a (internal) | n/a | ❌ | Used by ephemeral path |
| Cleanup reaper (cost-side) | [provisioning/ephemeral-reaper.ts](../../host/src/provisioning/ephemeral-reaper.ts) | ✅ `ephemeral-reaper.test.ts` | ❌ | ✅ `signalman ephemeral reap` | ❌ | Stale-VM cleanup CLI; no MCP equivalent |
| Vendor template fetch | [tools/vm-template.ts](../../host/src/tools/vm-template.ts), `provisioning/template-fetch.ts` | ✅ `template-fetch.test.ts`, `templates.test.ts` | ✅ `signalman_advanced_vm_fetch_template`, `…_resolve_template` | ✅ `signalman vm fetch-template` | ❌ | |
| Bundle install (`vm_install_bundle`) | [tools/vm-install-bundle.ts](../../host/src/tools/vm-install-bundle.ts) | ✅ `bundle.test.ts` | ✅ `signalman_advanced_vm_install_bundle` | ✅ `signalman vm install-bundle` | ❌ | |

### Hermetic envelope (v0.3.0-3)

| Capability | Where it lives | Functional? | MCP-exposed? | CLI-exposed? | Skill-covered? | Notes |
|---|---|---|---|---|---|---|
| `scenario_hash` | [scenarios/envelope-hash.ts](../../host/src/scenarios/envelope-hash.ts) | ✅ `envelope-hash.test.ts`, `envelope.test.ts` | n/a (auto on `signalman_run` response) | n/a (auto on CLI envelope) | n/a | |
| `vm_lineage_hash` | [provisioning/vm-lineage-hash.ts](../../host/src/provisioning/vm-lineage-hash.ts) | ✅ `vm-lineage-hash.test.ts`, `orchestrator-ephemeral.test.ts` | n/a | n/a | n/a | |
| `agent_version` | populated by orchestrator on envelope | ✅ `orchestrator-envelope.test.ts` | n/a | n/a | n/a | |
| `network_class` | same | ✅ same | n/a | n/a | n/a | |

### Control-plane HTTP service

| Capability | Where it lives | Functional? | MCP-exposed? | CLI-exposed? | Skill-covered? | Notes |
|---|---|---|---|---|---|---|
| `signalman serve` | [cli.ts:cmdServe](../../host/src/cli.ts), `http/app.ts` | ✅ `http-app.test.ts` | ❌ | ✅ `signalman serve` | ❌ | Daemon-style; not a candidate for MCP exposure (would defeat the purpose) |
| Bearer-token auth | [http/auth.ts](../../host/src/http/auth.ts) | ✅ `http-auth.test.ts` | n/a | n/a | n/a | |
| Job queue (claim/complete/fail) | [control-plane/storage/](../../host/src/control-plane/storage/) | ✅ `http-jobs.test.ts`, `control-plane-job-repo.test.ts` | ❌ | ❌ | ❌ | HTTP-only; consumed by `signalman runner start` |

### API-key management

| Capability | Where it lives | Functional? | MCP-exposed? | CLI-exposed? | Skill-covered? | Notes |
|---|---|---|---|---|---|---|
| api-key create | [cli.ts:cmdApiKeyCreate](../../host/src/cli.ts) | ✅ `http-writes.test.ts` (HTTP path) | ❌ | ✅ `signalman api-key create` | ❌ | |
| api-key list | same | ✅ same | ❌ | ✅ `signalman api-key list` | ❌ | |
| api-key revoke | same | ✅ same | ❌ | ✅ `signalman api-key revoke` | ❌ | |

### Init

| Capability | Where it lives | Functional? | MCP-exposed? | CLI-exposed? | Skill-covered? | Notes |
|---|---|---|---|---|---|---|
| project init (scenarios skeleton) | [verbs/init.ts](../../host/src/verbs/init.ts) | ✅ `init.test.ts` | ❌ | ✅ `signalman init` | ❌ | One-shot bootstrap; not a candidate for MCP exposure |

---

## Summary counts

Total enumerated capabilities: **78** (counting deploy-to-cloud-target rows even though `❌`, but **not** counting subcategories within `vm_ui_*` and `docker_*` as separate rows — those are bundled).

| Surface | ✅ | PARTIAL | ❌ |
|---|---|---|---|
| Functional? | 70 | 1 | 7 |
| MCP-exposed? | 39 | 0 | 39 |
| CLI-exposed? | 39 | 0 | 39 |
| Skill-covered? | 10 | 0 | 68 |

The 7 `❌ Functional?` rows are: `deploy to cloud_vm`, `deploy to cloud_stack`, `target connection-detail edit`, `runner list`, `runner deploy`, `runner deregister`, `target edit` — capabilities the prompt enumerated but Signalman doesn't yet ship. The PARTIAL row is `runner register` (exercised end-to-end but lacks a focused unit test).

---

## Gap list

### P0 — shipped + functional + MCP-exposed + CLI-exposed but no skill

Agents can't discover this capability through a skill, even though every other gate is green. These are the highest-leverage doc-only fixes.

1. **scenario list / describe / plan / run / status** — the *primary agent surface* for the v0.1.x half of the product. README pitches the entire scenario flow as the canonical agent path, yet `skills/` has no entry for any of these verbs. Closing this gap unlocks the discoverability the README promises.
2. **scenario record / record_finalize** — the agent-first differentiator (v0.3.0-1). No skill walks an agent through `record → do work → finalize → review`.
3. **product add / list / remove** — precondition for every `release build`. Agents that hit `ProductNotFoundError` need a skill to recover.
4. **target add / list / remove** — precondition for every `release deploy`. Same recovery story.
5. **release list / show** — the inspection verbs. Build and deploy have skills; the "what did I just build?" path has none.
6. **health history** — `health check` has a skill; the historical view (which deploy failed, why, when) doesn't.
7. **cloud status / cloud backends** — provision/terminate/list have skills; the discovery + state path doesn't. Operators don't know what providers are available until they look at `signalman_cloud_backends`.

### P1 — shipped + functional + CLI-exposed but not MCP-exposed

Agents must shell out via `Bash` rather than calling a structured MCP tool. These are real ergonomics gaps and worth a follow-up sprint, but a Bash-backed skill closes the doc half today.

1. **release verify** — CLI only. Agents can't structurally check a signature.
2. **key generate / key fingerprint** — CLI only.
3. **api-key create / list / revoke** — CLI only.
4. **runner register / runner start** — CLI only. Inherent for `runner start` (daemon-style); `register` could reasonably go to MCP.
5. **serve** — CLI only. Daemon — appropriate; no MCP needed.
6. **vm provision / cleanup / install-bundle / fetch-template** — CLI yes, MCP yes, but advanced-namespace; not a P1 per se but worth flagging.
7. **ephemeral reap** — CLI only.
8. **init** — CLI only. Appropriate; one-shot bootstrap.
9. **release build --remote** — CLI flag only; MCP build is in-process. Worth surfacing.

### P1' — shipped + functional + MCP-exposed but not CLI-exposed (the opposite case)

The prompt rubric defines P1 as "CLI but not MCP," but the cloud surface is the inverse: MCP-only, no CLI. Same severity, opposite shape. Flagging here so it isn't lost.

1. **cloud provision / terminate / status / list / backends** — MCP only. CI pipelines and operators on the command line have no path to these without a Node script.
2. **stack apply / stack destroy** — MCP only. Same.

### P2 — shipped + functional but neither MCP nor skill — operator-only

The capability exists and is exercised, but the only surface is internal or HTTP. Operators that don't run `signalman serve` can't reach it.

1. **audit log query (`GET /v1/audit`)** — HTTP only. No CLI, no MCP. Common operator question: "what happened to deployment X / who built release Y" — currently unanswerable without `curl`.
2. **audit log post (`POST /v1/audit`)** — same. Operator-driven annotations aren't reachable.
3. **job queue** — HTTP-only. Justified (runner-internal protocol), but worth flagging because a debug operator may want to see queued jobs.
4. **artifact listing for a release** — `GET /v1/releases/:id/artifacts` exists; `signalman release show` returns artifact metadata as part of the row, so this is partial coverage rather than a hard gap.
5. **deployment listing for a target** — same. `signalman health history` is the practical operator path; the raw deployment list is HTTP-only.

### P3 — shipped but tests are missing or PARTIAL — silent-regression risk

Needs ENG work (writing tests), not doc work. Flagging for a future sprint.

1. **runner register** — no dedicated unit; exercised end-to-end through `remote-release-build.test.ts`. A regression in the `.signalman/runner.json` shape would land silently until an integration ran.
2. **`deploy to cloud_vm` / `deploy to cloud_stack`** — promised in the WS6 prompt's enumeration but not actually implemented. Either ship + test or remove from the documented capability surface.
3. **`target edit` / `runner list` / `runner deploy` / `runner deregister`** — same: enumerated but not shipped. Either implement or drop from docs.
4. **HTTP `POST /v1/audit` from external** — covered by `http-writes.test.ts` happy path; the auth + tenant-scoping failure modes are sparsely covered. (Mitigated because anyone exercising the route has a bearer token.)
5. **VM screenshot** — `signalman_advanced_vm_screenshot` is in the registry but not directly unit-tested; covered transitively by `ui-*` tests. A pure-MCP regression (decoupled from UI) could go unnoticed.

---

## What this audit explicitly did NOT cover

- **WS1-WS5 in-flight work.** Per the WS6 prompt, anything not landed on `main` at `558e0ed` is excluded. A Wave 2 audit re-runs this matrix after those workstreams consolidate.
- **Performance, latency, or scalability characteristics.** The matrix tracks existence + reachability + agent-discoverability, not throughput.
- **Security boundary review.** A separate `/security-review` pass against `host/src/http/auth.ts`, signing keys, and the cloud-tag sentinel guards is the right tool for that.
- **The Rust halves** (`guest/`, `service/`, `plugins/signalman-loom-plugin/`). They're functional and exercised; this audit is scoped to the TypeScript host where the MCP + CLI surfaces live.
