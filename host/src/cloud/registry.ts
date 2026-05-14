/**
 * Cloud-backend registry (v0.3.0-5 sub-task 1).
 *
 * Module-singleton store mapping {@link CloudBackendKind} to
 * factories. Vendor backends (`aws.ts`, `azure.ts`, ...) register
 * themselves at module load time; the orchestrator looks up the
 * right backend per scenario via `getCloudBackend(kind)`.
 *
 * # Locked design (do not re-litigate)
 *
 * - **Factories, not eager instances.** Each registered entry is
 *   a `() => CloudBackend` closure. The vendor SDK / client is
 *   constructed only when a scenario actually needs that
 *   provider — saves the cost of loading every cloud SDK on
 *   every signalman invocation, and lets tests substitute fakes
 *   without re-registering at the module level.
 * - **Module singleton, but resettable.** The registry lives on
 *   a module-level Map. `resetRegistryForTests` clears it
 *   between test cases so registrations from one test don't
 *   leak into the next. Production callers never invoke reset.
 * - **No re-registration without `force`.** Calling
 *   `registerCloudBackend` twice for the same kind throws —
 *   silently replacing a backend hides bugs. Tests pass
 *   `force: true` when they need to swap; production never
 *   does.
 */

import { CloudBackendError, type CloudBackend, type CloudBackendKind } from "./types.js";

// ── Internal storage ──────────────────────────────────────────────

/**
 * Module-singleton registry. Keys are `CloudBackendKind`,
 * values are factories that lazily construct the backend.
 *
 * Internal — exposed surface is via the `registerCloudBackend` /
 * `getCloudBackend` / `listRegisteredBackends` /
 * `resetRegistryForTests` functions below.
 */
const factories = new Map<CloudBackendKind, () => CloudBackend>();

/**
 * Cache of constructed backends keyed by kind. Each backend is
 * constructed exactly once per process, on first
 * `getCloudBackend(kind)`. The cache survives between calls so
 * vendor SDK clients (which often hold socket pools and auth
 * tokens) aren't rebuilt on every scenario.
 *
 * Reset by `resetRegistryForTests` alongside the factory map.
 */
const instances = new Map<CloudBackendKind, CloudBackend>();

// ── Public API ────────────────────────────────────────────────────

/**
 * Register a cloud-backend factory for a vendor kind.
 *
 * Vendor modules call this at module load time (e.g. from
 * `host/src/cloud/aws.ts`). The factory is invoked lazily on
 * first `getCloudBackend(kind)`.
 *
 * @throws {@link CloudBackendError} with code `invalid_config`
 *         when a backend for `kind` is already registered and
 *         `force` is not true.
 */
export function registerCloudBackend(
  kind: CloudBackendKind,
  factory: () => CloudBackend,
  opts: { force?: boolean } = {},
): void {
  if (factories.has(kind) && !opts.force) {
    throw new CloudBackendError(
      "invalid_config",
      `cloud backend '${kind}' is already registered; pass { force: true } to replace it`,
    );
  }
  factories.set(kind, factory);
  // Invalidate any cached instance — a re-registration with
  // force means the caller wants the new factory's output.
  instances.delete(kind);
}

/**
 * Resolve a cloud backend by kind. Constructs the backend on
 * first call (via the registered factory) and caches the result.
 *
 * @throws {@link CloudBackendError} with code `unsupported_provider`
 *         when no factory has been registered for `kind`.
 */
export function getCloudBackend(kind: CloudBackendKind): CloudBackend {
  const cached = instances.get(kind);
  if (cached) return cached;
  const factory = factories.get(kind);
  if (!factory) {
    const registered = Array.from(factories.keys()).sort();
    throw new CloudBackendError(
      "unsupported_provider",
      `no cloud backend registered for '${kind}'. ` +
        `Registered: [${registered.join(", ") || "(none)"}]. ` +
        `Vendor backends register themselves at module load; ` +
        `import the relevant module (e.g. ` +
        `"./aws.js") to pull it into the registry.`,
    );
  }
  const instance = factory();
  if (instance.name !== kind) {
    throw new CloudBackendError(
      "invalid_config",
      `cloud backend factory for '${kind}' produced a backend ` +
        `whose .name is '${instance.name}'; refusing to cache a ` +
        `kind-mismatched backend (would silently route AWS calls ` +
        `to Azure etc).`,
    );
  }
  instances.set(kind, instance);
  return instance;
}

/**
 * Return the sorted list of currently-registered backend kinds.
 *
 * Stable order so audit / status tooling can compare across runs.
 * Returns `[]` when no vendor module has been loaded yet.
 */
export function listRegisteredBackends(): CloudBackendKind[] {
  return Array.from(factories.keys()).sort();
}

/**
 * Reset both the factory map and the instance cache. Tests call
 * this between cases so registrations from one test don't leak
 * into the next.
 *
 * **Not for production use.** The registry is meant to be
 * append-only across a process lifetime; reset breaks the
 * "one client per backend" invariant.
 */
export function resetRegistryForTests(): void {
  factories.clear();
  instances.clear();
}
