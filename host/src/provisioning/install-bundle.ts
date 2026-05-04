/**
 * `installBundle` — apply a parsed {@link Bundle} to a single VM.
 *
 * P9.2 + Tier-2 v0.1.1. The function:
 *   1. Iterates `bundle.packages` in declaration order, or computes a
 *      DAG plan when packages declare `requires:`.
 *   2. Routes each package to the right `GuestAgentClient` method based
 *      on `source`.
 *   3. Honours `parallel:` groups and DAG-ready levels via `Promise.all`.
 *   4. Runs the optional `verify` post-install command.
 *   5. Counts "already installed" / "container already exists" as
 *      `skipped` (idempotency without a host-side ledger).
 *
 * Tier 1 dispatch summary:
 *   - winget / choco / msstore  -> `client.installSoftware(id, source, version, timeoutMs)`
 *                                  (existing RPC; source string passes through)
 *   - direct                    -> `client.installDirect(...)` (P9.2 RPC)
 *   - docker                    -> `client.installDocker(...)` (P9.2 RPC)
 *
 * Tier 2 dispatch summary:
 *   - scoop                     -> `client.installSoftware(id, "scoop", version, ...)`
 *                                  (Rust handler lands in main session)
 *   - github_release            -> host-side fetch of /repos/<owner>/<repo>/releases/latest
 *                                  + asset glob match -> `client.installDirect(...)`.
 *   - git_repo                  -> 1-3 `client.runCommand("git", [...])` calls
 *                                  (clone + optional sparse-checkout init/set).
 *   - powershell                -> `client.runCommand("pwsh", ["-NonInteractive", "-Command",
 *                                  "Install-Module", "-Name", id, "-Force", "-Scope", scope, ...])`
 *   - npm / pip / cargo         -> `client.runCommand(<tool>, ["install", ...])`.
 *   - custom_script             -> single `client.runCommand("powershell", ...)` that
 *                                  downloads the script with `Invoke-WebRequest`,
 *                                  hashes it with `Get-FileHash`, and invokes the
 *                                  operator-named interpreter against the local copy.
 *                                  See {@link runCustomScript} for details + tradeoffs.
 *
 * The bundle RPC extensions have landed on `GuestAgentClient`; the
 * `BundleCapableClient` alias remains only as a compatibility name for
 * downstream call sites.
 */

import type { HypervisorBackend } from "../hypervisors/interface.js";
import type {
  GuestAgentClient,
  InstallResult,
} from "../guest/client.js";
import type {
  Bundle,
  BundleEntry,
  Package,
  ParallelGroup,
} from "./bundle-types.js";
import { isParallelGroup } from "./bundle-types.js";

// ── Types ────────────────────────────────────────────────────────────────

export interface PerPackageResult {
  package: string;
  source: string;
  status: "installed" | "skipped" | "failed";
  error?: string;
  durationMs: number;
}

export interface InstallBundleResult {
  vmName: string;
  totalPackages: number;
  installed: number;
  skipped: number;
  failed: number;
  perPackageResults: PerPackageResult[];
  durationMs: number;
}

export class BundleDependencyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BundleDependencyError";
  }
}

/**
 * Bundle-capable client. As of P9.2 (proto extension landed,
 * commit following e1be740), the methods this dispatcher needs all
 * live on `GuestAgentClient` directly — no feature-detection
 * needed. The alias is preserved so downstream callers that already
 * type their guest-client variable as `BundleCapableClient` keep
 * compiling.
 */
export type BundleCapableClient = GuestAgentClient;

// ── Helpers ──────────────────────────────────────────────────────────────

/** Default per-RPC install timeout. Big installers run long. */
const DEFAULT_INSTALL_TIMEOUT_MS = 600_000;

/** Default verify-command timeout. Verify runs are expected to be cheap. */
const VERIFY_TIMEOUT_MS = 30_000;

/**
 * Translate an `asset_name_pattern` glob (`fzf-*-windows_amd64.zip`)
 * into a RegExp anchored at both ends. Only `*` and `?` are treated as
 * meta — the schema already rejects `/` and `..`, so the remaining
 * characters are literal.
 */
function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const re = escaped.replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${re}$`);
}

/**
 * Shape returned by `https://api.github.com/repos/<owner>/<repo>/releases/latest`.
 * Only the fields we consume; the API returns much more.
 */
interface GithubReleaseAsset {
  name: string;
  browser_download_url: string;
}
interface GithubReleaseResponse {
  assets?: GithubReleaseAsset[];
}

/**
 * Resolve the latest GitHub release asset whose name matches `glob`.
 *
 * Caller-supplied `fetchImpl` lets the test suite inject a fake — the
 * default uses the global `fetch` (Node 18+ / undici). Throws if the
 * API call fails or no asset matches.
 *
 * Foot-gun: GitHub's anonymous rate limit is 60 req/hr/IP. Bundles with
 * many `github_release` entries can easily blow past that. The error
 * thrown here surfaces the HTTP status verbatim so the operator gets an
 * actionable signal rather than a vague "install failed".
 */
async function resolveGithubReleaseAsset(
  repo: string,
  globPattern: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ url: string; name: string }> {
  const apiUrl = `https://api.github.com/repos/${repo}/releases/latest`;
  let response: Response;
  try {
    response = await fetchImpl(apiUrl, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "signalman-bundle-orchestrator",
      },
    });
  } catch (err) {
    throw new Error(
      `github_release: failed to reach GitHub API: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  if (!response.ok) {
    // 403 + body containing "rate limit" surfaces the rate-limit
    // foot-gun so the operator knows to authenticate or back off.
    const hint =
      response.status === 403
        ? " (possible GitHub API rate limit — set GITHUB_TOKEN or stagger bundle runs)"
        : "";
    throw new Error(
      `github_release: GitHub API ${response.status} ${response.statusText}${hint}`,
    );
  }
  const body = (await response.json()) as GithubReleaseResponse;
  const assets = body.assets ?? [];
  const re = globToRegExp(globPattern);
  const match = assets.find((a) => re.test(a.name));
  if (!match) {
    throw new Error(
      `github_release: no asset in latest release of "${repo}" matched "${globPattern}" (${assets.length} candidates)`,
    );
  }
  return { url: match.browser_download_url, name: match.name };
}

/**
 * Build the PowerShell shell-out for `custom_script`.
 *
 * Approach: download the script via `Invoke-WebRequest`, verify
 * `Get-FileHash` matches `sha256` (case-insensitive — Windows returns
 * uppercase), then invoke the chosen interpreter.
 *
 * Tradeoffs (documented honestly):
 *   - This is `runCommand`-via-PowerShell, NOT a first-class
 *     download-and-verify RPC. The hash comparison happens INSIDE the
 *     guest's PowerShell session; we can audit the command but the
 *     guest is the trust boundary.
 *   - For `bash` on Linux/macOS guests, this command line will fail
 *     (PowerShell isn't universal). v0.1.1 ships pwsh-friendly; bash
 *     support is tracked as v0.1.2 / v0.2.0 — once the guest agent has
 *     a multi-step "download, verify, spawn" RPC, custom_script
 *     migrates to it. For now: pwsh (Windows) is the supported path.
 *   - The interpreter argv is constructed with `& <interp> <tmp>
 *     <args...>`. Because interpreter is enum-locked (`pwsh|bash`)
 *     and args pass through `-ArgumentList` style without expansion,
 *     the operator can't smuggle in a different command.
 */
function buildCustomScriptCommand(
  url: string,
  sha256: string,
  interpreter: "pwsh" | "bash",
  args: string[],
): { command: string; args: string[] } {
  // Quote each script-arg for PowerShell so spaces and embedded quotes
  // don't break parsing. We *do not* shell-expand, but we do need to
  // protect the surrounding `& ... ...` invocation.
  const psQuote = (s: string) => `'${s.replace(/'/g, "''")}'`;
  const quotedArgs = args.map(psQuote).join(" ");
  // Pick a safe extension based on interpreter: `.ps1` for pwsh,
  // `.sh` for bash. The TEMP path uses `New-TemporaryFile` then
  // renames so PathExt resolution doesn't matter.
  const ext = interpreter === "pwsh" ? ".ps1" : ".sh";
  // ScriptBlock — single-quoted to avoid host-side $-expansion. Inside
  // the block we use double-quoted literals for the GitHub-style
  // headers, but the operator-controlled inputs ($url, $sha, $argstr)
  // are templated in here as PowerShell *literals* via the same
  // single-quote escape trick.
  const psUrl = psQuote(url);
  const psSha = psQuote(sha256.toLowerCase());
  const psInterp = psQuote(interpreter);
  const psBody = [
    `$tmp = [System.IO.Path]::Combine($env:TEMP, [System.Guid]::NewGuid().ToString() + '${ext}')`,
    `try {`,
    `  Invoke-WebRequest -Uri ${psUrl} -OutFile $tmp -UseBasicParsing -ErrorAction Stop`,
    `  $hash = (Get-FileHash -Path $tmp -Algorithm SHA256).Hash.ToLower()`,
    `  if ($hash -ne ${psSha}) { throw "custom_script sha256 mismatch: expected ${sha256.toLowerCase()}, got $hash" }`,
    `  & ${psInterp} $tmp ${quotedArgs}`,
    `  exit $LASTEXITCODE`,
    `} finally {`,
    `  if (Test-Path $tmp) { Remove-Item $tmp -Force -ErrorAction SilentlyContinue }`,
    `}`,
  ].join("; ");
  return {
    command: "powershell",
    args: ["-NoProfile", "-NonInteractive", "-Command", psBody],
  };
}

/**
 * Convert a guest-agent `CommandResult` into our `InstallResult`
 * shape. Tier-2 sources route through `runCommand` rather than a
 * first-class install RPC, so the dispatcher needs to translate.
 */
function commandToInstallResult(
  cmd: { exitCode: number; stdout: string; stderr: string },
): InstallResult {
  return {
    success: cmd.exitCode === 0,
    exitCode: cmd.exitCode,
    stdout: cmd.stdout,
    stderr: cmd.stderr,
    installedPath: "",
  };
}

/**
 * Detect "already installed" / "already exists" outcomes from the install
 * RPC and the underlying package-manager exit messages. We rely on the
 * package manager's idempotency story (Q-locked decision); this function
 * is the host-side decoder of those signals.
 *
 * Heuristics:
 *   - winget exits 0 with "No applicable update found" / "already installed"
 *   - winget exits with 0x8a15002b (-1978335189) for "no applicable upgrade"
 *   - choco exits 0 with "already installed" in stdout
 *   - docker run errors with "container <name> already exists"
 *
 * These are matched on `result.stdout` + `result.stderr` to be tolerant
 * of which stream the package manager wrote to.
 */
function isAlreadyInstalled(result: InstallResult): boolean {
  const haystack =
    `${result.stdout ?? ""}\n${result.stderr ?? ""}`.toLowerCase();
  return (
    haystack.includes("already installed") ||
    haystack.includes("no applicable upgrade") ||
    haystack.includes("no installed package found matching") ||
    haystack.includes("is already installed") ||
    haystack.includes("container already exists") ||
    haystack.includes("name is already in use by container") ||
    /already\s+exists/.test(haystack)
  );
}

/**
 * Detect the "container already exists" idiom thrown by `docker run`.
 * Mirrors {@link isAlreadyInstalled} but for thrown errors — the guest
 * agent might surface this as a non-zero exit *or* as a thrown gRPC
 * Status, depending on implementation. Both paths route through here.
 */
function errorIndicatesAlreadyExists(err: unknown): boolean {
  const msg =
    err instanceof Error
      ? err.message
      : typeof err === "string"
        ? err
        : String(err ?? "");
  const lower = msg.toLowerCase();
  return (
    lower.includes("already installed") ||
    lower.includes("already exists") ||
    lower.includes("name is already in use") ||
    lower.includes("no applicable upgrade")
  );
}

/**
 * Run the optional `verify` post-install command. Returns `null` on
 * success and a string error message on failure. The string is included
 * in the per-package result so authors can debug verify-only failures
 * without grepping the agent log.
 */
async function runVerify(
  client: GuestAgentClient,
  pkg: Package,
): Promise<string | null> {
  if (!pkg.verify) return null;
  let cmdResult;
  try {
    cmdResult = await client.runCommand(pkg.verify, [], {
      timeoutMs: VERIFY_TIMEOUT_MS,
    });
  } catch (err) {
    return `verify command failed to execute: ${
      err instanceof Error ? err.message : String(err)
    }`;
  }
  if (cmdResult.exitCode !== 0) {
    return `verify exited ${cmdResult.exitCode}: ${
      cmdResult.stderr || cmdResult.stdout
    }`;
  }
  if (pkg.verify_expect && !cmdResult.stdout.includes(pkg.verify_expect)) {
    return `verify stdout did not contain "${pkg.verify_expect}"; got: ${cmdResult.stdout}`;
  }
  return null;
}

/**
 * Dispatch options — currently only the injectable `fetch` for
 * `github_release` testing. Optional everywhere; production callers
 * pass `undefined` and get the platform default.
 */
export interface InstallBundleOptions {
  /**
   * Override the `fetch` used to resolve `github_release` assets. Used
   * by the test suite to mock the GitHub API; production code uses the
   * global `fetch`.
   */
  githubFetch?: typeof fetch;
}

/**
 * Dispatch one package to its source-specific RPC. Returns the install
 * result OR a sentinel { skipped: true } when the source signalled
 * "already installed".
 *
 * Throws on hard RPC failures — the caller wraps those into a
 * `failed` per-package result.
 */
async function dispatchInstall(
  client: BundleCapableClient,
  pkg: Package,
  opts: InstallBundleOptions = {},
): Promise<{ status: "installed" | "skipped"; result?: InstallResult }> {
  switch (pkg.source) {
    case "winget":
    case "choco":
    case "msstore": {
      // Existing RPC; source string passes through unchanged.
      let result: InstallResult;
      try {
        result = await client.installSoftware(
          pkg.id,
          pkg.source,
          pkg.version,
          DEFAULT_INSTALL_TIMEOUT_MS,
        );
      } catch (err) {
        if (errorIndicatesAlreadyExists(err)) {
          return { status: "skipped" };
        }
        throw err;
      }
      if (isAlreadyInstalled(result)) {
        return { status: "skipped", result };
      }
      if (!result.success && result.exitCode !== 0) {
        throw new Error(
          `install failed (exit ${result.exitCode}): ${
            result.stderr || result.stdout
          }`,
        );
      }
      return { status: "installed", result };
    }

    case "direct": {
      // P9.2 proto bump landed: installDirect is now first-class on
      // GuestAgentClient. Guest agent does the HTTPS download +
      // SHA-256 verify + spawn; we just translate field naming
      // conventions (Zod schema uses snake_case for YAML readability,
      // client method takes camelCase to match the rest of the TS API).
      let result: InstallResult;
      try {
        result = await client.installDirect({
          id: pkg.id,
          url: pkg.url,
          sha256: pkg.sha256,
          args: pkg.args,
          installDir: pkg.install_dir,
          timeoutMs: DEFAULT_INSTALL_TIMEOUT_MS,
        });
      } catch (err) {
        if (errorIndicatesAlreadyExists(err)) return { status: "skipped" };
        throw err;
      }
      if (result.alreadyInstalled || isAlreadyInstalled(result)) {
        return { status: "skipped", result };
      }
      if (!result.success && result.exitCode !== 0) {
        throw new Error(
          `direct install failed (exit ${result.exitCode}): ${
            result.stderr || result.stdout
          }`,
        );
      }
      return { status: "installed", result };
    }

    case "docker": {
      const restartPolicy = pkg.restart_policy ?? "unless-stopped";
      let result: InstallResult;
      try {
        result = await client.installDocker({
          id: pkg.id,
          image: pkg.image,
          imageSha256: pkg.image_sha256,
          containerName: pkg.container_name,
          ports: pkg.ports,
          env: pkg.env,
          restartPolicy,
          command: pkg.command,
          timeoutMs: DEFAULT_INSTALL_TIMEOUT_MS,
        });
      } catch (err) {
        if (errorIndicatesAlreadyExists(err)) return { status: "skipped" };
        throw err;
      }
      if (result.alreadyInstalled || isAlreadyInstalled(result)) {
        return { status: "skipped", result };
      }
      if (!result.success && result.exitCode !== 0) {
        throw new Error(
          `docker install failed (exit ${result.exitCode}): ${
            result.stderr || result.stdout
          }`,
        );
      }
      return { status: "installed", result };
    }

    // ── Tier 2 ────────────────────────────────────────────────────────

    case "scoop": {
      // Scoop rides the existing `installSoftware` RPC; the source
      // string passes through to the guest agent's Rust handler arm
      // (lands in main session). Idempotency uses the same heuristics
      // as winget/choco.
      let result: InstallResult;
      try {
        result = await client.installSoftware(
          pkg.package_id,
          "scoop",
          pkg.version,
          DEFAULT_INSTALL_TIMEOUT_MS,
        );
      } catch (err) {
        if (errorIndicatesAlreadyExists(err)) return { status: "skipped" };
        throw err;
      }
      if (result.alreadyInstalled || isAlreadyInstalled(result)) {
        return { status: "skipped", result };
      }
      if (!result.success && result.exitCode !== 0) {
        throw new Error(
          `scoop install failed (exit ${result.exitCode}): ${
            result.stderr || result.stdout
          }`,
        );
      }
      return { status: "installed", result };
    }

    case "github_release": {
      // Host-side: fetch latest release JSON, glob-match an asset,
      // then pipe the resolved URL through `installDirect`.
      const resolved = await resolveGithubReleaseAsset(
        pkg.repo,
        pkg.asset_name_pattern,
        opts.githubFetch,
      );
      if (!pkg.sha256) {
        // We can't pin without a hash. installDirect *requires* one
        // (proto + Zod both enforce). Surface this as a structured
        // failure so the operator either supplies the hash or
        // accepts the risk by switching to `direct` with `# nosec`
        // commentary.
        console.warn(
          `github_release: "${pkg.id}" has no sha256 — TLS-only trust on asset "${resolved.name}"`,
        );
      }
      let result: InstallResult;
      try {
        result = await client.installDirect({
          id: pkg.id,
          url: resolved.url,
          // Without an operator-supplied hash, fall back to a
          // sentinel that the guest will reject. Operators see the
          // warning above + a hard fail rather than silently
          // proceeding with no integrity check.
          sha256: pkg.sha256 ?? "",
          args: pkg.args,
          installDir: pkg.install_dir,
          timeoutMs: DEFAULT_INSTALL_TIMEOUT_MS,
        });
      } catch (err) {
        if (errorIndicatesAlreadyExists(err)) return { status: "skipped" };
        throw err;
      }
      if (result.alreadyInstalled || isAlreadyInstalled(result)) {
        return { status: "skipped", result };
      }
      if (!result.success && result.exitCode !== 0) {
        throw new Error(
          `github_release install failed (exit ${result.exitCode}): ${
            result.stderr || result.stdout
          }`,
        );
      }
      return { status: "installed", result };
    }

    case "git_repo": {
      // 1-3 calls depending on sparse-checkout. Author-ordered
      // dependency: `git` must already be installed (winget Git.Git
      // earlier in the bundle). Idempotency: if `dest` already exists
      // git will refuse, which we map to `skipped`.
      const cloneArgs: string[] = ["clone"];
      const isSparse = pkg.sparse && pkg.sparse.length > 0;
      if (isSparse) {
        cloneArgs.push("--filter=blob:none", "--no-checkout");
      }
      if (pkg.ref) cloneArgs.push("--branch", pkg.ref);
      if (pkg.submodules) cloneArgs.push("--recurse-submodules");
      cloneArgs.push(pkg.url, pkg.dest);
      let cloneResult;
      try {
        cloneResult = await client.runCommand("git", cloneArgs, {
          timeoutMs: DEFAULT_INSTALL_TIMEOUT_MS,
        });
      } catch (err) {
        if (errorIndicatesAlreadyExists(err)) return { status: "skipped" };
        throw err;
      }
      if (cloneResult.exitCode !== 0) {
        const haystack = `${cloneResult.stdout}\n${cloneResult.stderr}`.toLowerCase();
        if (haystack.includes("already exists")) {
          return { status: "skipped", result: commandToInstallResult(cloneResult) };
        }
        throw new Error(
          `git_repo clone failed (exit ${cloneResult.exitCode}): ${
            cloneResult.stderr || cloneResult.stdout
          }`,
        );
      }
      if (isSparse) {
        // `sparse-checkout init --cone` is the cone-pattern default;
        // simpler than non-cone for the common case where authors
        // list directory paths.
        const initResult = await client.runCommand(
          "git",
          ["-C", pkg.dest, "sparse-checkout", "init", "--cone"],
          { timeoutMs: DEFAULT_INSTALL_TIMEOUT_MS },
        );
        if (initResult.exitCode !== 0) {
          throw new Error(
            `git_repo sparse-checkout init failed (exit ${initResult.exitCode}): ${
              initResult.stderr || initResult.stdout
            }`,
          );
        }
        const setResult = await client.runCommand(
          "git",
          ["-C", pkg.dest, "sparse-checkout", "set", ...(pkg.sparse ?? [])],
          { timeoutMs: DEFAULT_INSTALL_TIMEOUT_MS },
        );
        if (setResult.exitCode !== 0) {
          throw new Error(
            `git_repo sparse-checkout set failed (exit ${setResult.exitCode}): ${
              setResult.stderr || setResult.stdout
            }`,
          );
        }
      }
      return {
        status: "installed",
        result: commandToInstallResult(cloneResult),
      };
    }

    case "powershell": {
      const scope = pkg.scope ?? "AllUsers";
      const psArgs = [
        "-NonInteractive",
        "-NoProfile",
        "-Command",
        "Install-Module",
        "-Name",
        pkg.module_id,
        "-Force",
        "-Scope",
        scope,
        ...(pkg.version ? ["-RequiredVersion", pkg.version] : []),
      ];
      const cmd = await client.runCommand("pwsh", psArgs, {
        timeoutMs: DEFAULT_INSTALL_TIMEOUT_MS,
      });
      const haystack = `${cmd.stdout}\n${cmd.stderr}`.toLowerCase();
      if (
        cmd.exitCode === 0 &&
        (haystack.includes("already installed") ||
          haystack.includes("is already installed"))
      ) {
        return { status: "skipped", result: commandToInstallResult(cmd) };
      }
      if (cmd.exitCode !== 0) {
        throw new Error(
          `powershell Install-Module failed (exit ${cmd.exitCode}): ${
            cmd.stderr || cmd.stdout
          }`,
        );
      }
      return { status: "installed", result: commandToInstallResult(cmd) };
    }

    case "npm": {
      const target = pkg.version
        ? `${pkg.package_id}@${pkg.version}`
        : pkg.package_id;
      const cmd = await client.runCommand(
        "npm",
        ["install", "-g", target],
        { timeoutMs: DEFAULT_INSTALL_TIMEOUT_MS },
      );
      if (cmd.exitCode !== 0) {
        throw new Error(
          `npm install failed (exit ${cmd.exitCode}): ${
            cmd.stderr || cmd.stdout
          }`,
        );
      }
      // npm prints "up to date" / "added 0 packages" when already
      // installed at the requested version. Treat as skipped.
      const haystack = `${cmd.stdout}\n${cmd.stderr}`.toLowerCase();
      if (
        haystack.includes("up to date") ||
        haystack.includes("added 0 packages")
      ) {
        return { status: "skipped", result: commandToInstallResult(cmd) };
      }
      return { status: "installed", result: commandToInstallResult(cmd) };
    }

    case "pip": {
      const target = pkg.version
        ? `${pkg.package_id}==${pkg.version}`
        : pkg.package_id;
      const cmd = await client.runCommand(
        "pip",
        ["install", target],
        { timeoutMs: DEFAULT_INSTALL_TIMEOUT_MS },
      );
      if (cmd.exitCode !== 0) {
        throw new Error(
          `pip install failed (exit ${cmd.exitCode}): ${
            cmd.stderr || cmd.stdout
          }`,
        );
      }
      const haystack = `${cmd.stdout}\n${cmd.stderr}`.toLowerCase();
      if (haystack.includes("requirement already satisfied")) {
        return { status: "skipped", result: commandToInstallResult(cmd) };
      }
      return { status: "installed", result: commandToInstallResult(cmd) };
    }

    case "cargo": {
      const cargoArgs = [
        "install",
        pkg.crate_id,
        ...(pkg.version ? ["--version", pkg.version] : []),
      ];
      const cmd = await client.runCommand("cargo", cargoArgs, {
        timeoutMs: DEFAULT_INSTALL_TIMEOUT_MS,
      });
      const haystack = `${cmd.stdout}\n${cmd.stderr}`.toLowerCase();
      if (
        cmd.exitCode !== 0 &&
        // cargo exits non-zero with "already exists" when the crate is
        // already installed at this version. Map to skipped rather
        // than failed.
        haystack.includes("already exists")
      ) {
        return { status: "skipped", result: commandToInstallResult(cmd) };
      }
      if (cmd.exitCode !== 0) {
        throw new Error(
          `cargo install failed (exit ${cmd.exitCode}): ${
            cmd.stderr || cmd.stdout
          }`,
        );
      }
      return { status: "installed", result: commandToInstallResult(cmd) };
    }

    case "custom_script": {
      // pwsh-only Windows path for v0.1.1 (see buildCustomScriptCommand
      // doc-comment). bash on Linux/macOS guests is v0.1.2.
      const built = buildCustomScriptCommand(
        pkg.url,
        pkg.sha256,
        pkg.interpreter,
        pkg.args ?? [],
      );
      const cmd = await client.runCommand(built.command, built.args, {
        timeoutMs: DEFAULT_INSTALL_TIMEOUT_MS,
      });
      if (cmd.exitCode !== 0) {
        throw new Error(
          `custom_script failed (exit ${cmd.exitCode}): ${
            cmd.stderr || cmd.stdout
          }`,
        );
      }
      return { status: "installed", result: commandToInstallResult(cmd) };
    }

    default: {
      // Exhaustiveness check — adding a future-tier source surfaces
      // here at compile time so the dispatcher can't silently skip
      // new sources.
      const _exhaustive: never = pkg;
      void _exhaustive;
      throw new Error(
        `unknown package source: ${(pkg as { source: string }).source}`,
      );
    }
  }
}

/**
 * Install a single {@link Package} and produce its result entry. Captures
 * RPC failures as `failed` rather than throwing — the orchestrator wants
 * the full picture of which packages succeeded.
 */
async function installOne(
  client: BundleCapableClient,
  pkg: Package,
  opts: InstallBundleOptions = {},
): Promise<PerPackageResult> {
  const startedAt = Date.now();
  try {
    const dispatch = await dispatchInstall(client, pkg, opts);
    if (dispatch.status === "skipped") {
      return {
        package: pkg.id,
        source: pkg.source,
        status: "skipped",
        durationMs: Date.now() - startedAt,
      };
    }
    // Verify only after a real install — skipping verify on `skipped`
    // is intentional. The caller is asking "is the bundle applied", and
    // "already installed" is a yes; re-running verify would be wasted
    // RPCs in the common pre-warmed-VM case.
    const verifyError = await runVerify(client, pkg);
    if (verifyError) {
      return {
        package: pkg.id,
        source: pkg.source,
        status: "failed",
        error: verifyError,
        durationMs: Date.now() - startedAt,
      };
    }
    return {
      package: pkg.id,
      source: pkg.source,
      status: "installed",
      durationMs: Date.now() - startedAt,
    };
  } catch (err) {
    return {
      package: pkg.id,
      source: pkg.source,
      status: "failed",
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - startedAt,
    };
  }
}

/**
 * Install one bundle entry — either a single package or a parallel group.
 * Parallel groups invoke `Promise.all` so independent installs run
 * concurrently. Failure of one parallel package does NOT short-circuit
 * the others — the user wants the full per-package picture.
 */
async function installEntry(
  client: BundleCapableClient,
  entry: BundleEntry,
  opts: InstallBundleOptions = {},
): Promise<PerPackageResult[]> {
  if (isParallelGroup(entry)) {
    const group = entry as ParallelGroup;
    return Promise.all(group.parallel.map((p) => installOne(client, p, opts)));
  }
  const single = entry as Package;
  return [await installOne(client, single, opts)];
}

function flattenBundleEntries(entries: BundleEntry[]): Package[] {
  const packages: Package[] = [];
  for (const entry of entries) {
    if (isParallelGroup(entry)) {
      packages.push(...entry.parallel);
    } else {
      packages.push(entry);
    }
  }
  return packages;
}

function hasDeclaredDependencies(entries: BundleEntry[]): boolean {
  return flattenBundleEntries(entries).some(
    (pkg) => (pkg.requires ?? []).length > 0,
  );
}

function dependencyLevels(entries: BundleEntry[]): Package[][] {
  const packages = flattenBundleEntries(entries);
  const byId = new Map<string, Package>();
  for (const pkg of packages) {
    if (byId.has(pkg.id)) {
      throw new BundleDependencyError(
        `bundle dependency graph has duplicate package id "${pkg.id}"`,
      );
    }
    byId.set(pkg.id, pkg);
  }

  for (const pkg of packages) {
    for (const dep of pkg.requires ?? []) {
      if (!byId.has(dep)) {
        throw new BundleDependencyError(
          `package "${pkg.id}" requires unknown package "${dep}"`,
        );
      }
      if (dep === pkg.id) {
        throw new BundleDependencyError(
          `package "${pkg.id}" cannot require itself`,
        );
      }
    }
  }

  const completed = new Set<string>();
  const remaining = new Map(byId);
  const levels: Package[][] = [];
  while (remaining.size > 0) {
    const ready: Package[] = [];
    for (const pkg of packages) {
      if (!remaining.has(pkg.id)) continue;
      if ((pkg.requires ?? []).every((dep) => completed.has(dep))) {
        ready.push(pkg);
      }
    }
    if (ready.length === 0) {
      const blocked = Array.from(remaining.values())
        .map((pkg) => `${pkg.id} -> ${(pkg.requires ?? []).join(", ")}`)
        .join("; ");
      throw new BundleDependencyError(
        `bundle dependency graph contains a cycle or unsatisfied edge: ${blocked}`,
      );
    }
    for (const pkg of ready) {
      remaining.delete(pkg.id);
      completed.add(pkg.id);
    }
    levels.push(ready);
  }
  return levels;
}

// ── Public API ───────────────────────────────────────────────────────────

/**
 * Apply a parsed {@link Bundle} to the named VM.
 *
 * Iterates `bundle.packages` in author-declared order, or topologically
 * sorts packages when any package declares `requires:`. Returns the full
 * {@link InstallBundleResult} including per-package status, even when
 * individual installs fail — callers (CLI, MCP, scenario orchestrator)
 * decide whether to halt based on `failed > 0`.
 *
 * @param backend - Hypervisor backend (reserved for future use, e.g. VM
 *                  status checks; held but not currently exercised in v0.1.1).
 * @param client  - Guest-agent client for the target VM.
 * @param vmName  - Logical VM name; included in the result envelope.
 * @param bundle  - Parsed bundle.
 * @param opts    - Optional dispatch overrides — primarily a `fetch`
 *                  override for `github_release` testing.
 */
export async function installBundle(
  backend: HypervisorBackend,
  client: GuestAgentClient,
  vmName: string,
  bundle: Bundle,
  opts: InstallBundleOptions = {},
): Promise<InstallBundleResult> {
  // `backend` is part of the signature so future enhancements (capture
  // checkpoint pre/post, query VM state before installing, etc.) don't
  // break the public contract. Mark as intentionally retained.
  void backend;

  const startedAt = Date.now();
  const perPackageResults: PerPackageResult[] = [];

  // Cast to BundleCapableClient — the optional installDirect /
  // installDocker fields are feature-detected in the dispatcher.
  const capable = client as BundleCapableClient;

  if (hasDeclaredDependencies(bundle.packages)) {
    const levels = dependencyLevels(bundle.packages);
    const failedPackages = new Set<string>();
    for (const level of levels) {
      const blocked = level.filter((pkg) =>
        (pkg.requires ?? []).some((dep) => failedPackages.has(dep)),
      );
      perPackageResults.push(
        ...blocked.map((pkg) => ({
          package: pkg.id,
          source: pkg.source,
          status: "failed" as const,
          error: "dependency failed; package was not attempted",
          durationMs: 0,
        })),
      );
      for (const pkg of blocked) {
        failedPackages.add(pkg.id);
      }

      const runnable = level.filter((pkg) => !failedPackages.has(pkg.id));
      if (runnable.length === 0) continue;
      const levelResults = await Promise.all(
        runnable.map((pkg) => installOne(capable, pkg, opts)),
      );
      perPackageResults.push(...levelResults);
      for (const result of levelResults) {
        if (result.status === "failed") {
          failedPackages.add(result.package);
        }
      }
    }
  } else {
    // Sequential entry iteration; each entry may itself be a parallel
    // group, but groups are sequenced *between* entries. This preserves
    // the v0.1.1 author-ordering contract for bundles that do not opt
    // into `requires:`.
    for (const entry of bundle.packages) {
      const entryResults = await installEntry(capable, entry, opts);
      perPackageResults.push(...entryResults);
    }
  }

  const installed = perPackageResults.filter(
    (r) => r.status === "installed",
  ).length;
  const skipped = perPackageResults.filter(
    (r) => r.status === "skipped",
  ).length;
  const failed = perPackageResults.filter(
    (r) => r.status === "failed",
  ).length;

  return {
    vmName,
    totalPackages: perPackageResults.length,
    installed,
    skipped,
    failed,
    perPackageResults,
    durationMs: Date.now() - startedAt,
  };
}
