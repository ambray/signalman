/**
 * Shared VM handle cache.
 *
 * Provides a centralized cache for resolved VMHandle objects, avoiding
 * redundant hypervisor lookups. All tool modules and the server import
 * from this single module instead of maintaining independent caches.
 */

import type { HypervisorBackend, VMHandle } from "./hypervisors/interface.js";

export class VmCache {
  private cache = new Map<string, VMHandle>();

  /** Retrieve a cached VM handle by name (case-insensitive). */
  get(name: string): VMHandle | undefined {
    return this.cache.get(name.toLowerCase());
  }

  /** Cache a VM handle (keyed by lowercase name). */
  set(name: string, handle: VMHandle): void {
    this.cache.set(name.toLowerCase(), handle);
  }

  /** Remove a VM handle from the cache. */
  delete(name: string): void {
    this.cache.delete(name.toLowerCase());
  }

  /** Clear all cached handles. */
  clear(): void {
    this.cache.clear();
  }

  /** Check whether a VM name is cached. */
  has(name: string): boolean {
    return this.cache.has(name.toLowerCase());
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
