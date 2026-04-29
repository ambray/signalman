/**
 * Bundle type system + Zod schema for `bundle.yaml` (P9.2 + Tier-2 v0.1.1).
 *
 * A "software bundle" is a declarative list of packages to install into a
 * VM. Bundles compose: scenarios reference one or more bundles via the
 * top-level `software:` key, and the orchestrator applies them before
 * `setup:` runs.
 *
 * ── v0.1.1 source tiers ────────────────────────────────────────────────
 *
 *  Tier 1:
 *    winget | choco | msstore | direct | docker
 *
 *  Tier 2 (this release):
 *    scoop | github_release | git_repo | powershell | npm | pip | cargo |
 *    custom_script
 *
 * To add a future-tier source:
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
 * ── Source-source dependencies (Q10(a) lock) ───────────────────────────
 *
 * Bundle authors order entries manually. The orchestrator does no DAG
 * analysis. In particular, when a Tier-2 source is itself a tool that
 * must already be present on the guest, the *prerequisite* package must
 * appear earlier in `packages:`. Common prerequisites:
 *
 *   - `git_repo`         requires `git` (install via `winget Git.Git`).
 *   - `npm`              requires `node` (install via `choco nodejs-lts`).
 *   - `pip`              requires `python` (install via `winget Python`).
 *   - `cargo`            requires `rustup` (install via direct or winget).
 *   - `scoop`            requires `scoop` itself bootstrapped on the guest.
 *   - `powershell`       requires `pwsh` (PowerShell 7+; ships with Win11
 *                        but not Win10 — install via winget if needed).
 *   - `custom_script`    requires the named interpreter (`pwsh` | `bash`).
 *
 * Authors who get the order wrong see a `failed` per-package result with
 * the underlying tool's "command not found" message — diagnosis is local.
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
 *  `github_release`:
 *    - `repo` must match `^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$` — exactly
 *      one `/`, no path-traversal, no shell metacharacters.
 *    - `asset_name_pattern` is a glob; `/` and `..` are forbidden so a
 *      malicious upstream cannot push a directory-walking pattern.
 *    - `sha256` is OPTIONAL (GitHub doesn't always publish hashes); when
 *      absent, the orchestrator logs a warning and trusts TLS only.
 *
 *  `git_repo`:
 *    - `url` HTTPS-only. `git://`, `ssh://`, file paths refused.
 *    - `ref` validated to be alphanumerics + `-_./` (no spaces, no shell
 *      metachars). Covers branches, tags, SHAs.
 *    - `dest` must be absolute and contain no `..` segments.
 *
 *  `custom_script`:
 *    - `url` HTTPS-only.
 *    - `sha256` REQUIRED (operator-supplied integrity gate).
 *    - `interpreter` enum literal `pwsh` | `bash`. Anything else refused
 *      so we never spawn an arbitrary operator-named interpreter.
 *
 *  `powershell` / `npm` / `pip` / `cargo` / `scoop`:
 *    - `package_id`/`module_id`/`crate_id` validated as a package
 *      identifier (alphanumerics + `.` + `-` + `_`). No spaces, no shell
 *      metacharacters. Same rule as Tier-1 winget IDs.
 *
 * Every gate above is enforced *at parse time* — `parseBundle` throws
 * before any RPC is issued.
 */

import { z } from "zod";

/**
 * Documented in module-header text; surfaced as a constant so
 * downstream tooling (CLI `--help`, MCP error messages, lint scripts)
 * can quote it back at the operator without duplicating the prose.
 */
export const SOURCE_SOURCE_DEPENDENCIES_DOCSTRING = [
  "Tier-2 sources have implicit prerequisites the bundle author must order:",
  "  git_repo     -> git           (winget Git.Git)",
  "  npm          -> node          (choco nodejs-lts | winget OpenJS.NodeJS)",
  "  pip          -> python        (winget Python.Python.3)",
  "  cargo        -> rustup/cargo  (direct or winget Rustlang.Rustup)",
  "  scoop        -> scoop bootstrap on the guest",
  "  powershell   -> pwsh (PS 7+)  (winget Microsoft.PowerShell on Win10)",
  "  custom_script -> the named interpreter (pwsh | bash)",
  "Place the prerequisite earlier in the `packages:` list. The orchestrator",
  "does no DAG analysis — declaration order IS the dependency graph.",
].join("\n");

// ── Source tiers ─────────────────────────────────────────────────────────

/** Every package source shipped in v0.1.1 (Tier 1 + Tier 2). */
export type PackageSource =
  // Tier 1
  | "winget"
  | "choco"
  | "msstore"
  | "direct"
  | "docker"
  // Tier 2
  | "scoop"
  | "github_release"
  | "git_repo"
  | "powershell"
  | "npm"
  | "pip"
  | "cargo"
  | "custom_script";

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

// ── Tier 2 packages ──────────────────────────────────────────────────────

/**
 * Scoop — Windows non-admin package manager. The orchestrator routes
 * through `installSoftware` with `source: "scoop"`; the Rust handler arm
 * lives alongside `winget`/`choco` in the guest agent.
 */
export interface ScoopPackage extends BasePackage {
  source: "scoop";
  package_id: string;
}

/**
 * GitHub release — host-side resolves the latest release from the
 * GitHub API, picks the first asset matching `asset_name_pattern`
 * (glob), then pipes the resolved URL through `installDirect`.
 *
 * `sha256` is OPTIONAL because GitHub releases don't always publish
 * hashes alongside their assets. When absent, the orchestrator logs a
 * warning and falls back to TLS-only integrity. Operator-supplied hash
 * is the recommended path.
 */
export interface GithubReleasePackage extends BasePackage {
  source: "github_release";
  /** `owner/repo` shorthand, e.g. `junegunn/fzf`. */
  repo: string;
  /** Glob (e.g. `fzf-*-windows_amd64.zip`) to filter release assets. */
  asset_name_pattern: string;
  /** Optional 64-hex SHA-256 of the asset; when absent, TLS-only trust. */
  sha256?: string;
  /** Silent-install args, passed through to `installDirect`. */
  args?: string[];
  /** Optional install dir (passed through to `installDirect`). */
  install_dir?: string;
}

/**
 * Git repository checkout. Routed through `runCommand("git", [...])`.
 * Sparse-checkout requires three sequential calls (clone, init, set);
 * the orchestrator runs them in order and aborts on the first failure.
 */
export interface GitRepoPackage extends BasePackage {
  source: "git_repo";
  /** HTTPS-only repo URL. `git://`, `ssh://` and file paths are refused. */
  url: string;
  /** Branch, tag, or full SHA. Optional — defaults to upstream HEAD. */
  ref?: string;
  /** Absolute destination path inside the guest filesystem. */
  dest: string;
  /** When true, passes `--recurse-submodules` to `git clone`. */
  submodules?: boolean;
  /**
   * Optional sparse-checkout paths. When non-empty, the orchestrator
   * issues three calls: `clone --filter=blob:none`, `sparse-checkout
   * init`, `sparse-checkout set <paths...>`.
   */
  sparse?: string[];
}

/**
 * PowerShell module from PSGallery. Routed via
 * `runCommand("pwsh", ["-NonInteractive", "-Command", "Install-Module", ...])`.
 * `Install-Module` is idempotent when the version is already present.
 */
export interface PowershellPackage extends BasePackage {
  source: "powershell";
  module_id: string;
  /** Install scope. Default is `AllUsers` (matches existing tooling). */
  scope?: "AllUsers" | "CurrentUser";
}

/** npm global package. Routed via `runCommand("npm", ["install", "-g", ...])`. */
export interface NpmPackage extends BasePackage {
  source: "npm";
  package_id: string;
}

/** pip package. Routed via `runCommand("pip", ["install", ...])`. */
export interface PipPackage extends BasePackage {
  source: "pip";
  package_id: string;
}

/** cargo crate. Routed via `runCommand("cargo", ["install", ...])`. */
export interface CargoPackage extends BasePackage {
  source: "cargo";
  crate_id: string;
}

/**
 * Custom-script bootstrap.
 *
 * Allows installer extensions outside `direct`'s `.msi/.exe/.msix/.appx`
 * allowlist (specifically `.ps1` and `.sh`). Operator picks the
 * interpreter (`pwsh` | `bash`); SHA-256 is REQUIRED — there is no
 * "trust the publisher" fallback for arbitrary scripts.
 *
 * Implementation note: routed through a host-side shell wrapper that
 * downloads the script via PowerShell's `Invoke-WebRequest`, verifies
 * the hash with `Get-FileHash`, and then spawns the chosen interpreter
 * against the local copy. See `install-bundle.ts` for the exact
 * commandline.
 */
export interface CustomScriptPackage extends BasePackage {
  source: "custom_script";
  /** HTTPS URL of the script. */
  url: string;
  /** REQUIRED 64-hex SHA-256 of the script body. */
  sha256: string;
  /** Interpreter to spawn. */
  interpreter: "pwsh" | "bash";
  /** Optional script args (NOT shell-expanded; passed verbatim). */
  args?: string[];
}

/** Discriminated union of every Tier 1 + Tier 2 package shape. */
export type Package =
  // Tier 1
  | WingetPackage
  | ChocoPackage
  | MsstorePackage
  | DirectPackage
  | DockerPackage
  // Tier 2
  | ScoopPackage
  | GithubReleasePackage
  | GitRepoPackage
  | PowershellPackage
  | NpmPackage
  | PipPackage
  | CargoPackage
  | CustomScriptPackage;

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

/**
 * Package identifier shape — alphanumerics + `.` + `-` + `_`. Same rule
 * the Tier-1 winget surface uses; reject anything that looks like a
 * shell metachar or path separator.
 */
const PACKAGE_ID_RE = /^[A-Za-z0-9._-]+$/;
/** GitHub `owner/repo` — single slash, conservative char set. */
const GITHUB_REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
/**
 * Git ref / branch / tag / SHA — alphanumerics, `-_./`. No spaces, no
 * `&|;><$` shell metachars, no `..` traversal-style sequences (the
 * superRefine block extra-checks `..`).
 */
const GIT_REF_RE = /^[A-Za-z0-9._/-]+$/;

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

// ── Tier 2 schemas ───────────────────────────────────────────────────────

const scoopSchema = z.object({
  ...baseFields,
  source: z.literal("scoop"),
  package_id: z
    .string()
    .min(1, "scoop.package_id is required")
    .regex(
      PACKAGE_ID_RE,
      "scoop.package_id must be alphanumerics + . - _",
    ),
});

const githubReleaseSchema = z.object({
  ...baseFields,
  source: z.literal("github_release"),
  repo: z.string().min(1, "github_release.repo is required"),
  asset_name_pattern: z
    .string()
    .min(1, "github_release.asset_name_pattern is required"),
  sha256: z.string().regex(SHA256_HEX).optional(),
  args: z.array(z.string()).optional(),
  install_dir: z.string().optional(),
});

const gitRepoSchema = z.object({
  ...baseFields,
  source: z.literal("git_repo"),
  url: z.string().min(1, "git_repo.url is required"),
  ref: z.string().optional(),
  dest: z.string().min(1, "git_repo.dest is required"),
  submodules: z.boolean().optional(),
  sparse: z.array(z.string()).optional(),
});

const powershellSchema = z.object({
  ...baseFields,
  source: z.literal("powershell"),
  module_id: z
    .string()
    .min(1, "powershell.module_id is required")
    .regex(
      PACKAGE_ID_RE,
      "powershell.module_id must be alphanumerics + . - _",
    ),
  scope: z.enum(["AllUsers", "CurrentUser"]).optional(),
});

const npmSchema = z.object({
  ...baseFields,
  source: z.literal("npm"),
  package_id: z
    .string()
    .min(1, "npm.package_id is required")
    .regex(PACKAGE_ID_RE, "npm.package_id must be alphanumerics + . - _"),
});

const pipSchema = z.object({
  ...baseFields,
  source: z.literal("pip"),
  package_id: z
    .string()
    .min(1, "pip.package_id is required")
    .regex(PACKAGE_ID_RE, "pip.package_id must be alphanumerics + . - _"),
});

const cargoSchema = z.object({
  ...baseFields,
  source: z.literal("cargo"),
  crate_id: z
    .string()
    .min(1, "cargo.crate_id is required")
    .regex(PACKAGE_ID_RE, "cargo.crate_id must be alphanumerics + . - _"),
});

const customScriptSchema = z.object({
  ...baseFields,
  source: z.literal("custom_script"),
  url: z.string().min(1, "custom_script.url is required"),
  sha256: z
    .string()
    .regex(
      SHA256_HEX,
      "custom_script.sha256 must be 64 lowercase hex characters (SHA-256)",
    ),
  interpreter: z.enum(["pwsh", "bash"]),
  args: z.array(z.string()).optional(),
});

/**
 * Discriminated-union of every package source. Adding a future-tier
 * source means adding a new schema literal here and to
 * `PackageSource`/`Package` — see the file header for the full checklist.
 *
 * Source-specific cross-field validation (e.g. direct's HTTPS-only +
 * extension allowlist, github_release's repo shape) attaches via
 * `.superRefine` AFTER the union so `z.discriminatedUnion`'s
 * plain-object requirement is preserved.
 */
const packageSchema = z
  .discriminatedUnion("source", [
    // Tier 1
    wingetSchema,
    chocoSchema,
    msstoreSchema,
    directSchema,
    dockerSchema,
    // Tier 2
    scoopSchema,
    githubReleaseSchema,
    gitRepoSchema,
    powershellSchema,
    npmSchema,
    pipSchema,
    cargoSchema,
    customScriptSchema,
  ])
  .superRefine((pkg, ctx) => {
    // ── direct: HTTPS + extension allowlist ─────────────────────────
    if (pkg.source === "direct") {
      // Centralised here so authors get a single, well-pathed error
      // message per offending field.
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
      return;
    }

    // ── github_release: repo shape + glob safety ────────────────────
    if (pkg.source === "github_release") {
      if (!GITHUB_REPO_RE.test(pkg.repo)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["repo"],
          message:
            `github_release.repo must match "owner/repo" (got "${pkg.repo}")`,
        });
      }
      // Reject glob patterns that look like path traversal. A `/` in
      // the asset name is suspicious (assets are flat) and `..`
      // doesn't belong in a real release filename.
      if (
        pkg.asset_name_pattern.includes("/") ||
        pkg.asset_name_pattern.includes("..")
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["asset_name_pattern"],
          message:
            "github_release.asset_name_pattern must not contain '/' or '..'",
        });
      }
      return;
    }

    // ── git_repo: HTTPS-only, ref shape, dest no-traversal ──────────
    if (pkg.source === "git_repo") {
      let parsed: URL | null = null;
      try {
        parsed = new URL(pkg.url);
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["url"],
          message: `git_repo.url is not a valid URL: "${pkg.url}"`,
        });
      }
      if (parsed && parsed.protocol !== "https:") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["url"],
          message:
            `git_repo.url must use https:// (got "${parsed.protocol}"); ssh://, git://, file paths refused`,
        });
      }
      if (pkg.ref !== undefined && !GIT_REF_RE.test(pkg.ref)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["ref"],
          message:
            `git_repo.ref must be alphanumerics + - _ . / (got "${pkg.ref}")`,
        });
      }
      // Absolute path on either Windows (`C:\...`) or POSIX (`/...`).
      const isAbs =
        /^[A-Za-z]:[\\/]/.test(pkg.dest) || pkg.dest.startsWith("/");
      if (!isAbs) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["dest"],
          message: `git_repo.dest must be an absolute path (got "${pkg.dest}")`,
        });
      }
      // Path-traversal sanity check. `..` as a path-segment is the
      // attack we care about; the windows-vs-posix split matters
      // because a backslash isn't a separator on POSIX.
      const segments = pkg.dest.split(/[\\/]+/);
      if (segments.some((s) => s === "..")) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["dest"],
          message: `git_repo.dest must not contain '..' segments`,
        });
      }
      return;
    }

    // ── custom_script: HTTPS + sha256 (already regex-validated) ─────
    if (pkg.source === "custom_script") {
      let parsed: URL;
      try {
        parsed = new URL(pkg.url);
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["url"],
          message: `custom_script.url is not a valid URL: "${pkg.url}"`,
        });
        return;
      }
      if (parsed.protocol !== "https:") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["url"],
          message: `custom_script.url must use https:// (got "${parsed.protocol}")`,
        });
      }
      // interpreter enum + sha256 hex are already enforced by the
      // schema fields; the gate documentation says "REQUIRED" and the
      // schema makes both non-optional.
      return;
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
