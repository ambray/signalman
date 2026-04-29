/**
 * `installBundle` — apply a parsed {@link Bundle} to a single VM.
 *
 * P9.2 deliverable. The function:
 *   1. Iterates `bundle.packages` in declaration order.
 *   2. Routes each package to the right `GuestAgentClient` method based
 *      on `source`.
 *   3. Honours `parallel:` groups via `Promise.all`.
 *   4. Runs the optional `verify` post-install command.
 *   5. Counts "already installed" / "container already exists" as
 *      `skipped` (idempotency without a host-side ledger).
 *
 * Tier 1 dispatch summary:
 *   - winget / choco / msstore  → `client.installSoftware(id, source, version, timeoutMs)`
 *                                 (existing RPC; source string passes through)
 *   - direct                   → `client.installDirect(...)` (P9.2 RPC)
 *   - docker                   → `client.installDocker(...)` (P9.2 RPC)
 *
 * Per the locked design decisions, this file does NOT touch
 * `proto/guest.proto`. Where a new RPC is needed, the call site has a
 * `// TODO(P9.2): proto extension needed` comment and we cast the client
 * through {@link BundleCapableClient} so the host code compiles ahead of
 * the Rust handler landing.
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

    default: {
      // Exhaustiveness check — adding a Tier 2 source surfaces here at
      // compile time so the dispatcher can't silently skip new sources.
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
): Promise<PerPackageResult> {
  const startedAt = Date.now();
  try {
    const dispatch = await dispatchInstall(client, pkg);
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
): Promise<PerPackageResult[]> {
  if (isParallelGroup(entry)) {
    const group = entry as ParallelGroup;
    return Promise.all(group.parallel.map((p) => installOne(client, p)));
  }
  const single = entry as Package;
  return [await installOne(client, single)];
}

// ── Public API ───────────────────────────────────────────────────────────

/**
 * Apply a parsed {@link Bundle} to the named VM.
 *
 * Iterates `bundle.packages` in author-declared order, dispatching each
 * to the appropriate guest-agent RPC. Returns the full
 * {@link InstallBundleResult} including per-package status, even when
 * individual installs fail — callers (CLI, MCP, scenario orchestrator)
 * decide whether to halt based on `failed > 0`.
 *
 * @param backend - Hypervisor backend (reserved for future use, e.g. VM
 *                  status checks; held but not currently exercised in v0.1.1).
 * @param client  - Guest-agent client for the target VM.
 * @param vmName  - Logical VM name; included in the result envelope.
 * @param bundle  - Parsed bundle.
 */
export async function installBundle(
  backend: HypervisorBackend,
  client: GuestAgentClient,
  vmName: string,
  bundle: Bundle,
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

  // Sequential entry iteration; each entry may itself be a parallel
  // group, but groups are sequenced *between* entries. This is the
  // ordering contract: bundle authors order entries to express
  // dependencies, and parallel-grouped peers express independence.
  for (const entry of bundle.packages) {
    const entryResults = await installEntry(capable, entry);
    perPackageResults.push(...entryResults);
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
