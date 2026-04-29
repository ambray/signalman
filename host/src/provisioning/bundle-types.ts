/**
 * Bundle type system + Zod schema for `bundle.yaml` (P9.2).
 *
 * A "software bundle" is a declarative list of packages to install into a
 * VM. Bundles compose: scenarios reference one or more bundles via the
 * top-level `software:` key, and the orchestrator applies them before
 * `setup:` runs.
 *
 * ── v0.1.1 source tiers ────────────────────────────────────────────────
 *
 *  Tier 1 (this file's `PackageSource` union):
 *    winget | choco | msstore | direct | docker
 *
 *  Tier 2 (deferred — adding any of these is a ~10-line patch):
 *    scoop, github_release, git_repo, powershell, npm, pip, cargo,
 *    custom_script.
 *
 * To add a Tier 2 source:
 *    1. Add the literal to `PackageSource` (one line).
 *    2. Add a `XyzPackage extends BasePackage { source: "xyz"; ... }`
 *       interface declaring its source-specific fields.
 *    3. Add `XyzPackage` to the `Package` union (one line).
 *    4. Add an entry in `packageSchema` mirroring the new interface and
 *       any source-specific validation (e.g. extension allowlist, hash
 *       requirement).
 *    5. Add a dispatch arm in `installBundle` (host/src/provisioning/
 *       install-bundle.ts) that knows how to invoke the source.
 *
 * Steps 1–4 live in this file; step 5 is the orchestrator-side wiring.
 *
 * ── Security gates (REQUIRED for v0.1.1) ───────────────────────────────
 *
 *  `direct`:
 *    - URL must be `https://`. http and file/ftp/etc are refused.
 *    - SHA-256 must be 64 lowercase hex chars; matched after download.
 *    - Extension is allowlisted: `.msi`, `.exe`, `.msix`, `.appx`. The
 *      extension lock is intentionally narrow for v0.1.1 — we don't ship
 *      an arbitrary-script-runner gate yet.
 *
 *  `docker`:
 *    - `image_sha256` (image digest pin) is required. The schema accepts
 *      either the canonical `sha256:<64hex>` form or `<algo>:<hex>` so
 *      future digest algorithms work without a schema change.
 *    - `restart_policy` defaults to "unless-stopped" at the install-time
 *      layer; the schema only validates the literal set.
 *
 * Every gate above is enforced *at parse time* — `parseBundle` throws
 * before any RPC is issued.
 */

import { z } from "zod";

// ── Source tier 1 ────────────────────────────────────────────────────────

/** Tier 1 sources shipped in v0.1.1. Tier 2 list is documented above. */
export type PackageSource =
  | "winget"
  | "choco"
  | "msstore"
  | "direct"
  | "docker";

// ── Type system ──────────────────────────────────────────────────────────

/**
 * Common fields shared by every package, regardless of source.
 *
 * `verify` runs *after* the install RPC succeeds. Exit code 0 + an
 * optional substring-match of stdout decides "really installed". Authors
 * use this to defeat package managers that report success on a no-op.
 */
export interface BasePackage {
  /** Human-readable identifier; surfaces in install-result entries. */
  id: string;
  source: PackageSource;
  /** Optional pinned version. */
  version?: string;
  /** Post-install shell command run via `client.runCommand`; expected to exit 0. */
  verify?: string;
  /** Optional substring expected in stdout of `verify`. */
  verify_expect?: string;
}

export interface WingetPackage extends BasePackage {
  source: "winget";
}

export interface ChocoPackage extends BasePackage {
  source: "choco";
}

export interface MsstorePackage extends BasePackage {
  source: "msstore";
}

/**
 * Direct-download installer.
 *
 * Security gates: HTTPS-only URL, SHA-256 required, allowlisted
 * `.msi`/`.exe`/`.msix`/`.appx` extension.
 */
export interface DirectPackage extends BasePackage {
  source: "direct";
  /** HTTPS URL of the installer. */
  url: string;
  /** Lowercase 64-hex SHA-256 digest of the downloaded artifact. */
  sha256: string;
  /** Silent-install args, e.g. `["/quiet", "/norestart"]`. */
  args?: string[];
  /** Optional install directory; passed through to the guest. */
  install_dir?: string;
}

/**
 * Docker container-as-a-package.
 *
 * Security gates: `image_sha256` required (digest pin, not the tag).
 * `restart_policy` defaults to "unless-stopped" downstream of the schema.
 */
export interface DockerPackage extends BasePackage {
  source: "docker";
  /** Image reference, e.g. `mailhog/mailhog`. */
  image: string;
  /**
   * Image digest pin. Canonical `sha256:<64hex>` form is enforced today;
   * the regex also accepts `<algo>:<hex>` so future algorithms (sha512,
   * blake3) ride in without a schema change.
   */
  image_sha256: string;
  container_name?: string;
  /** Port mappings, e.g. `["1025:1025"]`. */
  ports?: string[];
  env?: Record<string, string>;
  restart_policy?: "no" | "always" | "unless-stopped" | "on-failure";
  /** Override container entrypoint args. */
  command?: string[];
}

/** Discriminated union of every Tier 1 package shape. */
export type Package =
  | WingetPackage
  | ChocoPackage
  | MsstorePackage
  | DirectPackage
  | DockerPackage;

/**
 * Group of packages installed concurrently.
 *
 * Bundle authors are responsible for asserting independence — the
 * orchestrator does no DAG analysis in v0.1.1. If two parallel packages
 * fight over the same resource, the failure surfaces in the per-package
 * results, not in the schema.
 */
export interface ParallelGroup {
  parallel: Package[];
}

/** A bundle entry is either a single package or a parallel group. */
export type BundleEntry = Package | ParallelGroup;

/**
 * Top-level bundle document.
 *
 * `apiVersion` + `kind` follow the Kubernetes-style metadata convention
 * deliberately: bundles are static config the operator versions in git,
 * and a `kubectl`-shaped header keeps the migration path straightforward
 * if Signalman ever ingests bundles via a controller.
 */
export interface Bundle {
  apiVersion: "signalman.dev/v1alpha1";
  kind: "Bundle";
  metadata: {
    name: string;
    description?: string;
  };
  packages: BundleEntry[];
}

// ── Zod schemas ──────────────────────────────────────────────────────────

const SHA256_HEX = /^[0-9a-f]{64}$/;
/**
 * Allow `sha256:<64hex>` (canonical) and also `algo:hex` so future digest
 * algorithms work. We intentionally do NOT validate the algorithm against
 * a list — Docker registries are the source of truth.
 */
const IMAGE_DIGEST = /^[a-z][a-z0-9]*:[0-9a-fA-F]{32,}$/;
const ALLOWED_DIRECT_EXTS = [".msi", ".exe", ".msix", ".appx"] as const;

const baseFields = {
  id: z.string().min(1, "package id is required"),
  version: z.string().optional(),
  verify: z.string().optional(),
  verify_expect: z.string().optional(),
};

const wingetSchema = z.object({
  ...baseFields,
  source: z.literal("winget"),
});

const chocoSchema = z.object({
  ...baseFields,
  source: z.literal("choco"),
});

const msstoreSchema = z.object({
  ...baseFields,
  source: z.literal("msstore"),
});

/**
 * Direct package — base shape (object). HTTPS / extension validation
 * lives in a post-discriminated-union refinement (see `packageSchema`)
 * because `z.discriminatedUnion` only accepts plain `ZodObject`s — a
 * `ZodEffects` (what `.superRefine` returns) breaks discrimination.
 */
const directSchema = z.object({
  ...baseFields,
  source: z.literal("direct"),
  url: z.string().min(1, "direct.url is required"),
  sha256: z
    .string()
    .regex(
      SHA256_HEX,
      "direct.sha256 must be 64 lowercase hex characters (SHA-256)",
    ),
  args: z.array(z.string()).optional(),
  install_dir: z.string().optional(),
});

const dockerSchema = z.object({
  ...baseFields,
  source: z.literal("docker"),
  image: z.string().min(1, "docker.image is required"),
  image_sha256: z
    .string()
    .regex(
      IMAGE_DIGEST,
      'docker.image_sha256 must be an image-digest pin like "sha256:<64hex>"',
    ),
  container_name: z.string().optional(),
  ports: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  restart_policy: z
    .enum(["no", "always", "unless-stopped", "on-failure"])
    .optional(),
  command: z.array(z.string()).optional(),
});

/**
 * Discriminated-union of every package source. Adding a Tier 2 source
 * means adding a new schema literal here and to `PackageSource`/`Package`
 * — see the file header for the full checklist.
 *
 * Source-specific cross-field validation (e.g. direct's HTTPS-only +
 * extension allowlist) attaches via `.superRefine` AFTER the union so
 * `z.discriminatedUnion`'s plain-object requirement is preserved.
 */
const packageSchema = z
  .discriminatedUnion("source", [
    wingetSchema,
    chocoSchema,
    msstoreSchema,
    directSchema,
    dockerSchema,
  ])
  .superRefine((pkg, ctx) => {
    if (pkg.source !== "direct") return;
    // HTTPS-only + allowlisted extension. Centralised here so authors
    // get a single, well-pathed error message per offending field.
    let parsed: URL;
    try {
      parsed = new URL(pkg.url);
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["url"],
        message: `direct.url is not a valid URL: "${pkg.url}"`,
      });
      return;
    }
    if (parsed.protocol !== "https:") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["url"],
        message: `direct.url must use https:// (got "${parsed.protocol}")`,
      });
    }
    const lowerPath = parsed.pathname.toLowerCase();
    const ok = ALLOWED_DIRECT_EXTS.some((ext) => lowerPath.endsWith(ext));
    if (!ok) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["url"],
        message:
          `direct.url extension is not allowlisted; allowed: ${ALLOWED_DIRECT_EXTS.join(
            ", ",
          )} (got "${parsed.pathname}")`,
      });
    }
  });

const parallelGroupSchema = z.object({
  parallel: z
    .array(packageSchema)
    .min(1, "parallel group must contain at least one package"),
});

/**
 * Bundle entry: either a single package or a `parallel:` group.
 *
 * We don't use a discriminatedUnion here because the discriminator
 * differs (source on packages, presence-of-`parallel` on groups). A
 * plain `z.union` is clearer.
 *
 * Note: no `z.ZodType<BundleEntry>` annotation. The zod-inferred type
 * is structurally compatible with `BundleEntry` (it's a union of
 * exactly the same shapes) but TS can't prove it through the
 * discriminator-on-`source` plus presence-of-`parallel` split. The
 * `parseBundle` exit cast (`result.data as Bundle`) handles the
 * widening safely — the schema's `safeParse` gives us the runtime
 * guarantee that the cast is true.
 */
const bundleEntrySchema = z.union([packageSchema, parallelGroupSchema]);

const bundleMetadataSchema = z.object({
  name: z.string().min(1, "metadata.name is required"),
  description: z.string().optional(),
});

const bundleSchema = z.object({
  apiVersion: z.literal("signalman.dev/v1alpha1"),
  kind: z.literal("Bundle"),
  metadata: bundleMetadataSchema,
  packages: z.array(bundleEntrySchema).default([]),
});

// ── parseBundle ──────────────────────────────────────────────────────────

/**
 * Thrown when a bundle fails schema validation. The message includes
 * a path-prefixed list of issues so authors can fix typos without
 * squinting at JSON.
 */
export class BundleValidationError extends Error {
  constructor(
    public readonly issues: readonly { path: string; message: string }[],
  ) {
    const lines = issues.map(
      (i) => `  - ${i.path === "" ? "(root)" : i.path}: ${i.message}`,
    );
    super(
      `Bundle validation failed:\n${lines.join("\n")}`,
    );
    this.name = "BundleValidationError";
  }
}

/**
 * Parse and validate a bundle document.
 *
 * Accepts the raw output of a YAML parser (or an inline JS object). On
 * success returns a strongly-typed `Bundle`; on failure throws
 * {@link BundleValidationError} with every issue collected at once so
 * authors don't play whack-a-mole.
 */
export function parseBundle(raw: unknown): Bundle {
  const result = bundleSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((i) => ({
      path: i.path.join("."),
      message: i.message,
    }));
    throw new BundleValidationError(issues);
  }
  return result.data as Bundle;
}

/**
 * Type-guard for the `parallel:` group shape inside a `BundleEntry`.
 * Lets the orchestrator branch without re-running the schema.
 */
export function isParallelGroup(entry: BundleEntry): entry is ParallelGroup {
  return (
    typeof entry === "object" &&
    entry !== null &&
    "parallel" in entry &&
    Array.isArray((entry as ParallelGroup).parallel)
  );
}
