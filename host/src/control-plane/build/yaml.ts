/**
 * Parser + Zod validator for `signalman.build.yaml`, the contract a
 * product repo declares to signalman.
 *
 * See docs/design/meta-build-system.md §6.1 — narrow on purpose:
 *   * components: list of build invocations + the artifacts each produces
 *   * verification: scenario IDs to run at each tier (consumed in PR 4)
 *
 * The executor (build/executor.ts) reads + validates this file at build
 * time and refuses to proceed if any declared artifact path is missing
 * post-build — that's the explicit fix for the "forgot to build the
 * dashboard" failure class.
 *
 * Variable substitution: `${TAG}`, `${COMMIT_SHA}`, `${COMMIT_SHORT}`
 * are expanded in `build.args`, `artifacts[].path`, `artifacts[].ref`,
 * and `artifacts[].produce` at execution time. Unknown variables raise
 * an error (no silent empty-string substitution).
 */

import { z } from "zod";

// ── Schema ──────────────────────────────────────────────────────────

const ComponentNameSchema = z
  .string()
  .min(1)
  .regex(/^[a-z][a-z0-9_-]*$/, {
    message: "component name must be kebab/snake case, starting with a letter",
  });

const BuildStepSchema = z
  .object({
    cwd: z.string().optional(),
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
  })
  .strict();

const BlobArtifactSchema = z
  .object({
    kind: z.literal("blob"),
    path: z.string().min(1),
    /**
     * Optional post-build command that produces the artifact file at
     * `path`. Run via the platform shell (cmd /C on Windows, sh -c on
     * POSIX). Useful when the main build leaves an artifact directory
     * and the artifact-of-record is a tarball over it.
     */
    produce: z.string().optional(),
  })
  .strict();

const ImageRefArtifactSchema = z
  .object({
    kind: z.literal("image_ref"),
    ref: z.string().min(1),
  })
  .strict();

const ArtifactSchema = z.discriminatedUnion("kind", [
  BlobArtifactSchema,
  ImageRefArtifactSchema,
]);

const ComponentSchema = z
  .object({
    name: ComponentNameSchema,
    build: BuildStepSchema,
    artifacts: z.array(ArtifactSchema).min(1, {
      message: "component must declare at least one artifact",
    }),
  })
  .strict();

const VerificationSchema = z
  .object({
    smoke: z.array(z.string()).optional(),
    torture: z.array(z.string()).optional(),
    e2e: z.array(z.string()).optional(),
  })
  .strict();

// ── Probes (PR 4) ───────────────────────────────────────────────────
// Probes execute against a deployed target to verify a release is
// healthy. signalman ships three primitive shapes (command,
// http_in_guest, file_in_guest); product repos compose Example-specific
// probes from those (e.g. "agent_service" is a windows-service check
// modelled as a `sc.exe query` command probe). The design doc §8 names
// six initial probes for Example — those live in the Example repo's
// signalman.build.yaml, not hardcoded here.

const ProbeNameSchema = z
  .string()
  .min(1)
  .regex(/^[a-z][a-z0-9_]*$/, {
    message: "probe name must be snake_case, starting with a letter",
  });

const CommandProbeSchema = z
  .object({
    kind: z.literal("command"),
    name: ProbeNameSchema,
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
    /** Expected exit code. Default: 0. */
    expect_exit: z.number().int().optional(),
    expect_stdout_contains: z.string().optional(),
    expect_stderr_contains: z.string().optional(),
    /** Wall-clock cap on the in-guest command. Default: 30_000ms. */
    timeout_ms: z.number().int().positive().optional(),
  })
  .strict();

const HttpInGuestProbeSchema = z
  .object({
    kind: z.literal("http_in_guest"),
    name: ProbeNameSchema,
    /** URL fetched from inside the guest (so localhost/loopback works). */
    url: z.string().url(),
    /** Default: 200. */
    expect_status: z.number().int().optional(),
    expect_body_contains: z.string().optional(),
    timeout_ms: z.number().int().positive().optional(),
  })
  .strict();

const FileInGuestProbeSchema = z
  .object({
    kind: z.literal("file_in_guest"),
    name: ProbeNameSchema,
    /** Path inside the guest. */
    path: z.string().min(1),
  })
  .strict();

const ProbeSchema = z.discriminatedUnion("kind", [
  CommandProbeSchema,
  HttpInGuestProbeSchema,
  FileInGuestProbeSchema,
]);

export const BuildYamlSchema = z
  .object({
    schema_version: z.literal(1),
    components: z.array(ComponentSchema).min(1, {
      message: "components is required",
    }),
    verification: VerificationSchema.optional(),
    probes: z.array(ProbeSchema).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const seen = new Set<string>();
    for (const c of value.components) {
      if (seen.has(c.name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["components"],
          message: `duplicate component name: ${c.name}`,
        });
      }
      seen.add(c.name);
    }
    if (value.probes) {
      const seenProbes = new Set<string>();
      for (const p of value.probes) {
        if (seenProbes.has(p.name)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["probes"],
            message: `duplicate probe name: ${p.name}`,
          });
        }
        seenProbes.add(p.name);
      }
    }
  });

export type BuildYaml = z.infer<typeof BuildYamlSchema>;
export type BuildComponent = z.infer<typeof ComponentSchema>;
export type BuildArtifact = z.infer<typeof ArtifactSchema>;
export type BlobArtifact = z.infer<typeof BlobArtifactSchema>;
export type ImageRefArtifact = z.infer<typeof ImageRefArtifactSchema>;
export type Probe = z.infer<typeof ProbeSchema>;
export type CommandProbe = z.infer<typeof CommandProbeSchema>;
export type HttpInGuestProbe = z.infer<typeof HttpInGuestProbeSchema>;
export type FileInGuestProbe = z.infer<typeof FileInGuestProbeSchema>;

// ── Parse + validate ────────────────────────────────────────────────

export class BuildYamlValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BuildYamlValidationError";
  }
}

/**
 * Validate a parsed YAML document. Throws BuildYamlValidationError with
 * a human-readable summary on failure.
 */
export function validateBuildYaml(raw: unknown): BuildYaml {
  const result = BuildYamlSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => {
        const path = i.path.length > 0 ? i.path.join(".") : "<root>";
        return `${path}: ${i.message}`;
      })
      .join("\n  ");
    throw new BuildYamlValidationError(
      `signalman.build.yaml is invalid:\n  ${issues}`,
    );
  }
  return result.data;
}

// ── Variable substitution ───────────────────────────────────────────

export interface BuildVariables {
  TAG: string;
  COMMIT_SHA: string;
  COMMIT_SHORT: string;
  [k: string]: string;
}

export class UnknownBuildVariableError extends Error {
  constructor(name: string, where: string) {
    super(`unknown build variable \${${name}} referenced in ${where}`);
    this.name = "UnknownBuildVariableError";
  }
}

const VAR_RE = /\$\{([A-Z_][A-Z0-9_]*)\}/g;

/**
 * Replace `${VAR}` occurrences in `s` with values from `vars`. Throws
 * UnknownBuildVariableError if `s` references a variable not in `vars`.
 * Pass `where` for a useful error message (e.g. "components[0].build.args[2]").
 */
export function substituteVariables(
  s: string,
  vars: BuildVariables,
  where = "<string>",
): string {
  return s.replace(VAR_RE, (_match, name: string) => {
    if (!(name in vars)) {
      throw new UnknownBuildVariableError(name, where);
    }
    return vars[name];
  });
}

/**
 * Recursively substitute variables across a component's build args and
 * artifact paths/refs/produce-commands. Returns a new component object
 * with substitutions applied; original is untouched.
 */
export function substituteComponent(
  component: BuildComponent,
  vars: BuildVariables,
): BuildComponent {
  const subbedArgs = component.build.args?.map((a, i) =>
    substituteVariables(a, vars, `${component.name}.build.args[${i}]`),
  );
  const subbedArtifacts: BuildArtifact[] = component.artifacts.map((a, i) => {
    if (a.kind === "blob") {
      return {
        kind: "blob",
        path: substituteVariables(a.path, vars, `${component.name}.artifacts[${i}].path`),
        produce: a.produce
          ? substituteVariables(
              a.produce,
              vars,
              `${component.name}.artifacts[${i}].produce`,
            )
          : undefined,
      };
    }
    return {
      kind: "image_ref",
      ref: substituteVariables(a.ref, vars, `${component.name}.artifacts[${i}].ref`),
    };
  });
  return {
    name: component.name,
    build: {
      ...component.build,
      args: subbedArgs,
    },
    artifacts: subbedArtifacts,
  };
}
