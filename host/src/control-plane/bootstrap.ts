/**
 * Control-plane bootstrap.
 *
 * Ensures the default org exists. In v0.2.0 (local mode) all entities
 * pin to this org since multi-tenant operations aren't surfaced yet
 * (per docs/design/meta-build-system.md §12 phasing). The schema fully
 * supports multiple orgs from day one; only the *surface* defers.
 *
 * The default org's id is stable across restarts because we look it up
 * by name. If it's missing we create it. Either way the returned id is
 * what every other PR-1+ caller uses as the implicit org scope.
 */

import type { Org } from "./types.js";
import type { StorageDriver } from "./storage/index.js";

export const DEFAULT_ORG_NAME = "default";

/**
 * Idempotently ensure the default org exists. Returns its current row.
 * Safe to call on every process start.
 */
export async function ensureDefaultOrg(storage: StorageDriver): Promise<Org> {
  const existing = await storage.orgs.getByName(DEFAULT_ORG_NAME);
  if (existing) return existing;
  return storage.orgs.create({ name: DEFAULT_ORG_NAME, tier: "free" });
}
