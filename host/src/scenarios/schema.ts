/**
 * Zod schemas for scenario configuration files (setup.yaml /
 * assertions.yaml). Applied by `loadScenario` in `runner.ts`.
 *
 * ## Why bother
 *
 * The existing loader cast yaml.parse() output straight to
 * `ScenarioConfig` with no validation. That means:
 *
 * - A typo'd field (`kernerl_debug`, `vms.check_point_restore`)
 *   silently becomes `undefined` and the scenario runs with the
 *   wrong settings.
 * - Wrong types (`break_on_load: "ospiri.sys"` instead of
 *   `break_on_load: ["ospiri.sys"]`) produce cryptic runtime errors
 *   from deep in the orchestrator.
 * - Missing required fields blow up inconsistently — sometimes at
 *   parse, sometimes mid-scenario.
 *
 * Zod's `.parse()` catches every such case at load time with a
 * precise, line-identifiable error. `.passthrough()` is used so
 * scenario authors can keep arbitrary extra keys (comments /
 * experimental fields) without the schema screaming.
 *
 * ## Scope
 *
 * Validates the shapes Phase 1 cares about: top-level metadata, the
 * `vms` array, setup / teardown / checkpoints stubs, and — most
 * importantly — the `kernel_debug` block added in follow-up C.
 * Assertions.yaml gets a separate schema since it's a different
 * file with a different contract.
 *
 * Permissive-by-default — `.passthrough()` preserves unknown keys
 * (YAML comments, future fields, legacy gunk). Required fields and
 * type mismatches still fail loudly.
 */

import { z } from "zod";

// ── kernel_debug ──────────────────────────────────────────────────

export const kernelDebugConfigSchema = z
  .object({
    enabled: z.boolean(),
    transport: z.literal("serial").optional(),
    pipe: z.string().optional(),
    symbol_path: z.string().optional(),
    break_on_load: z.array(z.string()).optional(),
    break_on_bugcheck: z.boolean().optional(),
    kd_exe: z.string().optional(),
  })
  .passthrough();

// ── vm ────────────────────────────────────────────────────────────

export const vmConfigSchema = z
  .object({
    name: z.string().min(1, "VM name must be non-empty"),
    template: z.string().min(1, "VM template must be non-empty"),
    /**
     * P9.4 v0.1.1 — auto-provision the VM if it's missing on the
     * host before the scenario starts. When set, `signalman run` calls
     * `provisionVM` (P9.1) to create the VM + install the guest agent
     * + take the `checkpoint_restore` checkpoint, then proceeds with
     * the normal restore flow.
     *
     * Idempotent: if the VM already exists with the matching template
     * and checkpoint label, the provision step is a 2-second no-op.
     *
     * Guarded behaviour: provision_if_missing requires the operator
     * to have run `signalman init --bootstrap` (or the equivalent
     * one-time setup) to land the dev certs at
     * `%ProgramData%\Signalman\certs\`. The orchestrator surfaces a
     * descriptive error if the cert prereq isn't satisfied — it does
     * NOT silently bootstrap them, since cert generation requires
     * elevated privileges that the run context may not have.
     *
     * Default: false. When false, a missing VM surfaces as a setup
     * error (the existing v0.1.0 behaviour).
     */
    provision_if_missing: z
      .boolean()
      .default(false)
      .describe(
        "If true, run signalman vm provision <name> before the scenario " +
          "when the VM doesn't already exist. P9.4 v0.1.1.",
      ),
    checkpoint_restore: z.string().optional(),
    /**
     * Whether the named `checkpoint_restore` is a warm-state checkpoint
     * (taken while the VM was Running with the guest agent stable and
     * Hyper-V integration services healthy).
     *
     * When `true` (the default), the orchestrator assumes a fast restore
     * path: ~2 s to apply, ~300 ms to first PowerShell call, vs. 6-10+
     * minutes for a cold checkpoint that has to JIT-warm everything on
     * every restore. New scenarios that take a Running-state checkpoint
     * (see `host/scripts/harvest-warm-checkpoint.ps1`) inherit this
     * default automatically.
     *
     * Set to `false` for legacy scenarios whose `checkpoint_restore`
     * names a cold (Off-state, freshly-provisioned) checkpoint and
     * therefore needs the longer post-restore stabilisation budget.
     * The orchestrator surfaces a warning so the slow path is visible
     * in scenario output.
     */
    warm_checkpoint: z.boolean().default(true),
    /**
     * When true, signalman skips ALL Hyper-V/VMware management for this
     * VM (`listVMs`, `restoreCheckpoint`, `startVM`, `waitForHeartbeat`).
     * The VM must already be running and at the desired state before
     * the scenario runs; the orchestrator constructs a synthetic
     * VMHandle with id `"pre-started"` and proceeds straight to
     * `waitForGuestAgents` (which only talks to the guest gRPC
     * endpoint).
     *
     * # When to use
     *
     * Unprivileged host-CLI runs.  signalman dropped gsudo-based
     * auto-elevation, so any scenario that uses `vm_restore`,
     * `vm_checkpoint`, or implicit `Start-VM` must run from an
     * elevated shell or via the SystemBackend service.  Setting
     * `pre_started: true` skips the elevation requirement entirely —
     * the only PowerShell signalman runs is the read-only
     * `Get-Command Get-VM` availability probe.
     *
     * # Interaction with `vm_copy_file`
     *
     * For pre-started VMs, `vm_copy_file: host_to_guest` routes
     * through `copyFileToGuestViaHttp` (chunked-base64 over the guest
     * gRPC channel) instead of `Copy-VMFile` (which requires Hyper-V
     * Integration Services + elevation).  See
     * `host/src/guest/file_transfer.ts` for the reliability contract.
     *
     * Default: `false` (existing v0.1.x behaviour — full lifecycle
     * management).
     */
    pre_started: z.boolean().optional(),
    /**
     * Whether the orchestrator should wait for the hypervisor's VM
     * heartbeat integration service after restore/start. Defaults to
     * true for lifecycle-managed VMs. Set false for backend-only smoke
     * scenarios that use PowerShell Direct / Copy-VMFile but do not
     * require guest agent readiness.
     */
    wait_for_heartbeat: z.boolean().default(true),
    guest_agent_port: z
      .number()
      .int()
      .gte(1)
      .lte(65_535, "guest_agent_port must be a valid TCP port"),
    network: z
      .object({
        switch: z.string(),
        static_ip: z.string(),
      })
      .passthrough()
      .optional(),
    kernel_debug: kernelDebugConfigSchema.optional(),
  })
  .passthrough();

// ── retry policy (P3.b — closes audit C5) ─────────────────────────

/**
 * Retry policy for setup/teardown steps. Authors can declare a
 * scenario-level default (top-level `retry:`) and override per-step
 * (`retry:` on the step itself). Empty / unset → no retry.
 *
 * Wire shape:
 * ```yaml
 * retry:
 *   count: 3            # additional attempts after the first (0 = no retry)
 *   backoff_ms: 1000    # base delay between attempts (default 1000)
 *   jitter: false       # add ±25% randomness to backoff (default false)
 * ```
 *
 * Caps are deliberate: `count` ≤ 10 and `backoff_ms` ≤ 60000 prevent
 * pathological scenarios from blocking a run for hours. Total worst-
 * case wait per step is `count * backoff_ms` ≈ 10 minutes at the cap.
 *
 * `count: 0` is the explicit "no retry" form; allowed so authors can
 * disable a scenario-level retry on a particular step. The default
 * across the codebase (no `retry:` block at all) is also no retry.
 */
export const retryConfigSchema = z
  .object({
    count: z
      .number()
      .int()
      .min(0)
      .max(10, "retry.count capped at 10 to prevent pathological scenarios")
      .describe("Additional attempts after the first (0 = no retry)"),
    backoff_ms: z
      .number()
      .int()
      .min(0)
      .max(60_000, "retry.backoff_ms capped at 60s")
      .default(1000)
      .describe("Base delay between attempts in milliseconds"),
    jitter: z
      .boolean()
      .default(false)
      .describe("Add ±25% randomness to backoff to break retry-storm correlation"),
  })
  .passthrough();

export type ValidatedRetryPolicy = z.infer<typeof retryConfigSchema>;

// ── setup steps / checkpoints ─────────────────────────────────────

/**
 * The existing `SetupStep` type uses a loose `action: string` + extra
 * fields. Represented here as the minimum guaranteed shape; individual
 * actions validate their own params.
 *
 * `retry`, when present, applies only to this step and overrides any
 * scenario-level [`retryConfigSchema`] policy.
 */
export const setupStepSchema = z
  .object({
    action: z.string().min(1, "setup step must have non-empty action"),
    vm: z.string().optional(),
    retry: retryConfigSchema.optional(),
  })
  .passthrough();

/**
 * `checkpoints` block — every field is an optional boolean today.
 * Future additions land here.
 */
export const checkpointConfigSchema = z
  .object({
    before_test: z.boolean().optional(),
    on_failure: z.boolean().optional(),
  })
  .passthrough();

// ── P4 runtime guard blocks ───────────────────────────────────────

/**
 * `capabilities` block — documents what the scenario is allowed to
 * touch. When present, the orchestrator refuses VM, network, and host
 * path access outside the declared set.
 *
 * `.passthrough()` keeps unknown sub-fields so authors can experiment
 * while the enforced subset stays backward-compatible.
 */
export const capabilitiesSchema = z
  .object({
    hosts: z.array(z.string()).optional(),
    networks: z.array(z.string()).optional(),
    vms: z.array(z.string()).optional(),
    host_paths: z
      .object({
        read: z.array(z.string()).optional(),
        write: z.array(z.string()).optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

/**
 * `parameters` block — declares parameter names and (optional)
 * defaults that callers can override via `signalman.run`'s
 * `parameters` arg or the CLI `--param k=v` flag.
 *
 * Per resolved Question 2 (option (a) — strict, doc-able through
 * `signalman.describe`), this records the declared shape. Runtime
 * execution resolves `${param:NAME}` from caller-supplied parameters
 * plus declared defaults and `${secret:NAME}` from host environment
 * variables.
 *
 * Values are free-form (string, number, boolean, object) so authors
 * can declare nested-shape parameters without Zod limiting them.
 */
export const parametersSchema = z.record(z.string(), z.unknown());

// ── top-level scenario config ─────────────────────────────────────

/**
 * Scenario metadata + structure. All fields required are genuinely
 * required by the loader — a scenario missing `name` or `vms` can't
 * run.
 */
export const scenarioConfigSchema = z
  .object({
    name: z.string().min(1, "scenario name is required"),
    version: z.string().min(1, "scenario version is required"),
    tags: z.array(z.string()).default([]),
    vms: z.array(vmConfigSchema).min(1, "scenario must define at least one VM"),
    /**
     * P9.2 — list of bundle paths to apply BEFORE `setup:` runs. Each
     * entry is a path to a `bundle.yaml` (relative to the scenario dir
     * or absolute). The orchestrator reads + parses each bundle and
     * dispatches `installBundle` against the bundle's target VM
     * (taken from the `vm` field of the entry, or the lone scenario
     * VM when there's exactly one).
     *
     * Bundles are applied in array order; multi-VM scenarios disambiguate
     * via `{ path: "...", vm: "endpoint-1" }` entries. A bare string is
     * sugar for `{ path: <string> }`.
     */
    software: z
      .array(
        z.union([
          z.string(),
          z
            .object({
              path: z.string(),
              vm: z.string().optional(),
            })
            .passthrough(),
        ]),
      )
      .optional(),
    setup: z.array(setupStepSchema).default([]),
    teardown: z.array(setupStepSchema).default([]),
    checkpoints: checkpointConfigSchema.default({}),
    sandbox_modes: z.array(z.string()).optional(),
    /** Runtime capability gate — see {@link capabilitiesSchema}. */
    capabilities: capabilitiesSchema.optional(),
    /** Runtime parameter/default declarations — see {@link parametersSchema}. */
    parameters: parametersSchema.optional(),
    /**
     * Default retry policy applied to every setup/teardown step that
     * does not declare its own `retry:` block. P3.b deliverable.
     * See {@link retryConfigSchema}.
     */
    retry: retryConfigSchema.optional(),
  })
  .passthrough();

// ── assertions.yaml ───────────────────────────────────────────────

/**
 * Assertions file schema — a single `assertions` array + threshold
 * fields. Individual assertion shapes vary widely; we validate the
 * envelope and let the evaluator do per-type validation.
 */
export const assertionConfigSchema = z
  .object({
    assertions: z.array(z.record(z.string(), z.unknown())).default([]),
    pass_threshold: z.number().gte(0).lte(1).default(1.0),
    critical_must_pass: z.boolean().default(true),
  })
  .passthrough();

// ── Inferred types ────────────────────────────────────────────────

export type ValidatedScenarioConfig = z.infer<typeof scenarioConfigSchema>;
export type ValidatedVmConfig = z.infer<typeof vmConfigSchema>;
export type ValidatedKernelDebugConfig = z.infer<
  typeof kernelDebugConfigSchema
>;
export type ValidatedAssertionConfig = z.infer<typeof assertionConfigSchema>;

// ── Parse + format helpers ────────────────────────────────────────

/**
 * Thrown on schema validation failure. Message contains a
 * human-readable report of every issue — zod's native error output
 * is JSON, which the YAML author has to squint at.
 */
export class ScenarioValidationError extends Error {
  constructor(
    public readonly filePath: string,
    public readonly issues: readonly { path: string; message: string }[],
  ) {
    const header = `Scenario config validation failed: ${filePath}`;
    const body = issues
      .map((i) => `  - ${i.path || "(root)"}: ${i.message}`)
      .join("\n");
    super(`${header}\n${body}`);
    this.name = "ScenarioValidationError";
  }
}

/**
 * Parse + validate a setup.yaml already-parsed object. Throws
 * {@link ScenarioValidationError} on any issue, with a message that
 * identifies each failing path.
 *
 * @param raw - the object yaml.parse() returned
 * @param filePath - path to the source YAML, used in errors
 */
export function validateScenarioConfig(
  raw: unknown,
  filePath: string,
): ValidatedScenarioConfig {
  const result = scenarioConfigSchema.safeParse(raw);
  if (!result.success) {
    throw new ScenarioValidationError(
      filePath,
      formatZodIssues(result.error),
    );
  }
  return result.data;
}

/**
 * Parse + validate assertions.yaml. Same error contract as
 * {@link validateScenarioConfig}.
 */
export function validateAssertionConfig(
  raw: unknown,
  filePath: string,
): ValidatedAssertionConfig {
  const result = assertionConfigSchema.safeParse(raw);
  if (!result.success) {
    throw new ScenarioValidationError(
      filePath,
      formatZodIssues(result.error),
    );
  }
  return result.data;
}

/**
 * Collapse zod's `ZodError` into the flat `{ path, message }` shape
 * used by {@link ScenarioValidationError}. Paths are dot-joined so
 * nested errors point at the exact field
 * (`vms.0.kernel_debug.enabled`).
 */
function formatZodIssues(
  err: z.ZodError,
): { path: string; message: string }[] {
  return err.issues.map((issue) => ({
    path: issue.path.map((p) => String(p)).join("."),
    message: issue.message,
  }));
}
