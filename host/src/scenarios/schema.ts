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

// ── setup steps / checkpoints ─────────────────────────────────────

/**
 * The existing `SetupStep` type uses a loose `action: string` + extra
 * fields. Represented here as the minimum guaranteed shape; individual
 * actions validate their own params.
 */
export const setupStepSchema = z
  .object({
    action: z.string().min(1, "setup step must have non-empty action"),
    vm: z.string().optional(),
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
    setup: z.array(setupStepSchema).default([]),
    teardown: z.array(setupStepSchema).default([]),
    checkpoints: checkpointConfigSchema.default({}),
    sandbox_modes: z.array(z.string()).optional(),
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
