/**
 * Tests for the shared VM handle cache.
 *
 * Covers TTL expiry semantics (S-17 deferred from Sprint 60 steelman),
 * explicit invalidation, and the case-insensitive lookup contract.
 *
 * Uses an injected clock so TTL expiry is deterministic without
 * `setTimeout` / `vi.useFakeTimers()`.
 */
import { describe, it, expect } from "vitest";
import type { VMHandle } from "../hypervisors/interface.js";
import { VmCache, DEFAULT_TTL_MS } from "../vm-cache.js";

function handle(name: string): VMHandle {
  return { id: `id-${name}`, name, backend: "mock" };
}

describe("VmCache — basic semantics", () => {
  it("returns a stored handle by exact name", () => {
    const cache = new VmCache();
    const h = handle("vm1");
    cache.set("vm1", h);
    expect(cache.get("vm1")).toBe(h);
  });

  it("looks up case-insensitively", () => {
    const cache = new VmCache();
    const h = handle("Win11x64");
    cache.set("Win11x64", h);
    expect(cache.get("win11x64")).toBe(h);
    expect(cache.get("WIN11X64")).toBe(h);
  });

  it("returns undefined for an unknown name", () => {
    const cache = new VmCache();
    expect(cache.get("missing")).toBeUndefined();
  });

  it("clear() drops every entry", () => {
    const cache = new VmCache();
    cache.set("a", handle("a"));
    cache.set("b", handle("b"));
    cache.clear();
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBeUndefined();
  });
});

describe("VmCache — TTL expiry", () => {
  it("evicts and misses on get() when the entry is older than ttlMs", () => {
    let now = 1_000;
    const cache = new VmCache({ ttlMs: 1_000, now: () => now });
    cache.set("vm1", handle("vm1"));

    // Within TTL — still present
    now = 1_500;
    expect(cache.get("vm1")?.name).toBe("vm1");

    // At the boundary (insertedAt + ttlMs) — still present (strictly greater check)
    now = 2_000;
    expect(cache.get("vm1")?.name).toBe("vm1");

    // Past the boundary — eviction + miss
    now = 2_001;
    expect(cache.get("vm1")).toBeUndefined();
  });

  it("set() refreshes the TTL window for an existing key", () => {
    let now = 0;
    const cache = new VmCache({ ttlMs: 100, now: () => now });
    cache.set("vm1", handle("vm1"));
    now = 80;
    cache.set("vm1", handle("vm1")); // re-set advances insertedAt
    now = 150; // would have expired at original insertion (0 + 100)
    expect(cache.get("vm1")?.name).toBe("vm1");
    now = 181; // 80 + 100 + 1
    expect(cache.get("vm1")).toBeUndefined();
  });

  it("has() honors TTL the same way get() does", () => {
    let now = 0;
    const cache = new VmCache({ ttlMs: 50, now: () => now });
    cache.set("vm1", handle("vm1"));
    expect(cache.has("vm1")).toBe(true);
    now = 51;
    expect(cache.has("vm1")).toBe(false);
    // has() also evicts, so a subsequent get() also misses without
    // touching the original entry (no resurrection).
    expect(cache.get("vm1")).toBeUndefined();
  });

  it("default TTL is 30 seconds", () => {
    expect(DEFAULT_TTL_MS).toBe(30_000);
    let now = 0;
    const cache = new VmCache({ now: () => now });
    cache.set("vm1", handle("vm1"));
    now = DEFAULT_TTL_MS; // exactly at boundary — still present
    expect(cache.get("vm1")?.name).toBe("vm1");
    now = DEFAULT_TTL_MS + 1;
    expect(cache.get("vm1")).toBeUndefined();
  });
});

describe("VmCache — invalidate()", () => {
  it("removes the entry for the given name", () => {
    const cache = new VmCache();
    cache.set("vm1", handle("vm1"));
    cache.invalidate("vm1");
    expect(cache.get("vm1")).toBeUndefined();
  });

  it("is case-insensitive like the rest of the API", () => {
    const cache = new VmCache();
    cache.set("Win11x64", handle("Win11x64"));
    cache.invalidate("WIN11X64");
    expect(cache.get("Win11x64")).toBeUndefined();
  });

  it("is a no-op for an unknown name (no throw)", () => {
    const cache = new VmCache();
    expect(() => cache.invalidate("missing")).not.toThrow();
  });

  it("does not affect other entries", () => {
    const cache = new VmCache();
    cache.set("a", handle("a"));
    cache.set("b", handle("b"));
    cache.invalidate("a");
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")?.name).toBe("b");
  });
});
