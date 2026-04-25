/**
 * Shared VM handle cache.
 *
 * Provides a centralized cache for resolved VMHandle objects, avoiding
 * redundant hypervisor lookups. All tool modules and the server import
 * from this single module instead of maintaining independent caches.
 *
 * # Staleness controls (Sprint 60 steelman audit S-17, P2 follow-up)
 *
 * Cache entries expire after {@link DEFAULT_TTL_MS} (30 s). On `get()`,
 * an expired entry is evicted and treated as a miss so the caller refreshes
 * from the backend. Callers that mutate VM state (delete in particular)
 * should call {@link VmCache.invalidate} so the next lookup goes to the
 * backend rather than returning a handle pointing at a deleted VM.
 *
 * Tests can inject a fake clock via the `now` constructor parameter to
 * exercise TTL semantics without `setTimeout`.
 */

import type { HypervisorBackend, VMHandle } from "./hypervisors/interface.js";

/** Default cache entry TTL. Entries older than this are evicted on access. */
export const DEFAULT_TTL_MS = 30_000;

interface CacheEntry {
  handle: VMHandle;
  /** Wall-clock ms when the entry was inserted. */
  insertedAt: number;
}

export class VmCache {
  private cache = new Map<string, CacheEntry>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  /**
   * @param options.ttlMs - Entry TTL in milliseconds. Defaults to {@link DEFAULT_TTL_MS}.
   * @param options.now - Clock function returning ms; injectable for tests.
   */
  constructor(options: { ttlMs?: number; now?: () => number } = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.now = options.now ?? Date.now;
  }

  /**
   * Retrieve a cached VM handle by name (case-insensitive).
   *
   * Returns `undefined` if no entry exists OR if the entry is older than
   * the configured TTL. Expired entries are evicted as a side effect so
   * the cache doesn't grow unboundedly with stale data.
   */
  get(name: string): VMHandle | undefined {
    const key = name.toLowerCase();
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    if (this.now() - entry.insertedAt > this.ttlMs) {
      this.cache.delete(key);
      return undefined;
    }
    return entry.handle;
  }

  /** Cache a VM handle (keyed by lowercase name). Resets the TTL. */
  set(name: string, handle: VMHandle): void {
    this.cache.set(name.toLowerCase(), {
      handle,
      insertedAt: this.now(),
    });
  }

  /** Remove a VM handle from the cache. */
  delete(name: string): void {
    this.cache.delete(name.toLowerCase());
  }

  /**
   * Evict the cache entry for `name` if present.
   *
   * Equivalent to {@link delete} — this method exists as the explicit
   * mutation-after-state-change name used by call sites that just deleted
   * the VM (e.g. the `vm_delete` tool handler). Keeps that intent legible
   * at the call site without forcing the caller to import a different verb.
   */
  invalidate(name: string): void {
    this.cache.delete(name.toLowerCase());
  }

  /** Clear all cached handles. */
  clear(): void {
    this.cache.clear();
  }

  /**
   * Check whether a VM name is cached AND still fresh.
   *
   * Mirrors {@link get}'s TTL semantics — an expired entry counts as
   * absent and is evicted as a side effect.
   */
  has(name: string): boolean {
    const key = name.toLowerCase();
    const entry = this.cache.get(key);
    if (!entry) return false;
    if (this.now() - entry.insertedAt > this.ttlMs) {
      this.cache.delete(key);
      return false;
    }
    return true;
  }
}

/** Global VM cache shared across all tool modules. */
export const globalVmCache = new VmCache();

/**
 * Cache a VM handle in the global cache.
 *
 * Convenience function used by tool handlers after listing VMs.
 */
export function cacheVM(handle: VMHandle): void {
  globalVmCache.set(handle.name, handle);
}

/**
 * Resolve a VM handle by name, refreshing from the backend if not cached.
 *
 * @param backend - The active hypervisor backend.
 * @param name - VM name to resolve.
 * @returns The resolved VMHandle.
 * @throws If the VM cannot be found after a backend refresh.
 */
export async function resolveVM(
  backend: HypervisorBackend,
  name: string,
): Promise<VMHandle> {
  const cached = globalVmCache.get(name);
  if (cached) return cached;

  // Refresh from backend
  const vms = await backend.listVMs();
  for (const vm of vms) cacheVM(vm);

  const resolved = globalVmCache.get(name);
  if (!resolved) throw new Error(`VM '${name}' not found`);
  return resolved;
}
