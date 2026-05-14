/**
 * v0.3.0-5 sub-task 1 — cloud-backend registry tests.
 *
 * Module-singleton registry; tests reset between cases via the
 * `resetRegistryForTests` helper to avoid cross-test leakage.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

import {
  getCloudBackend,
  listRegisteredBackends,
  registerCloudBackend,
  resetRegistryForTests,
} from "../cloud/registry.js";
import {
  CloudBackendError,
  type CloudBackend,
  type CloudBackendKind,
  type CloudInstanceHandle,
} from "../cloud/types.js";

// ── Test-only fake backend ────────────────────────────────────────

function makeFakeBackend(
  kind: CloudBackendKind,
  overrides: Partial<CloudBackend> = {},
): CloudBackend {
  return {
    name: kind,
    provisionInstance: vi.fn(async () => ({
      id: `i-fake-${kind}`,
      backend: kind,
      name: "fake-vm",
      region: "us-test-1",
    })),
    terminateInstance: vi.fn(async () => undefined),
    getInstanceStatus: vi.fn(async (h: CloudInstanceHandle) => ({
      handle: h,
      state: "running" as const,
    })),
    getInstanceIp: vi.fn(async () => "203.0.113.1"),
    listInstances: vi.fn(async () => []),
    ...overrides,
  };
}

beforeEach(() => {
  resetRegistryForTests();
});

// ── Empty registry ────────────────────────────────────────────────

describe("Empty registry", () => {
  it("listRegisteredBackends returns empty array", () => {
    expect(listRegisteredBackends()).toEqual([]);
  });

  it("getCloudBackend throws unsupported_provider when nothing is registered", () => {
    try {
      getCloudBackend("aws");
      expect.fail("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(CloudBackendError);
      expect((err as CloudBackendError).code).toBe("unsupported_provider");
      expect((err as Error).message).toContain("aws");
      // Empty-registry message includes "(none)" so the operator
      // sees a clear hint about what to import.
      expect((err as Error).message).toContain("(none)");
    }
  });
});

// ── Registration + lookup ─────────────────────────────────────────

describe("registerCloudBackend + getCloudBackend", () => {
  it("registered backend is discoverable via getCloudBackend", () => {
    const backend = makeFakeBackend("aws");
    registerCloudBackend("aws", () => backend);
    const resolved = getCloudBackend("aws");
    expect(resolved).toBe(backend);
  });

  it("constructs the backend lazily on first getCloudBackend", () => {
    const factory = vi.fn(() => makeFakeBackend("aws"));
    registerCloudBackend("aws", factory);
    // Factory not called yet.
    expect(factory).toHaveBeenCalledTimes(0);
    // First lookup triggers construction.
    getCloudBackend("aws");
    expect(factory).toHaveBeenCalledTimes(1);
    // Second lookup uses cached instance.
    getCloudBackend("aws");
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("caches per-kind so two providers don't share an instance", () => {
    const aws = makeFakeBackend("aws");
    const azure = makeFakeBackend("azure");
    const awsFactory = vi.fn(() => aws);
    const azureFactory = vi.fn(() => azure);
    registerCloudBackend("aws", awsFactory);
    registerCloudBackend("azure", azureFactory);

    expect(getCloudBackend("aws")).toBe(aws);
    expect(getCloudBackend("azure")).toBe(azure);
    expect(awsFactory).toHaveBeenCalledTimes(1);
    expect(azureFactory).toHaveBeenCalledTimes(1);
  });

  it("listRegisteredBackends returns sorted unique kinds", () => {
    registerCloudBackend("azure", () => makeFakeBackend("azure"));
    registerCloudBackend("aws", () => makeFakeBackend("aws"));
    registerCloudBackend("gcp", () => makeFakeBackend("gcp"));
    expect(listRegisteredBackends()).toEqual(["aws", "azure", "gcp"]);
  });

  it("rejects double-registration without force", () => {
    registerCloudBackend("aws", () => makeFakeBackend("aws"));
    expect(() =>
      registerCloudBackend("aws", () => makeFakeBackend("aws")),
    ).toThrowError(
      expect.objectContaining({
        name: "CloudBackendError",
        code: "invalid_config",
      }),
    );
  });

  it("accepts re-registration with force: true", () => {
    const first = makeFakeBackend("aws");
    const second = makeFakeBackend("aws");
    registerCloudBackend("aws", () => first);
    expect(getCloudBackend("aws")).toBe(first);
    registerCloudBackend("aws", () => second, { force: true });
    // Cache should have been invalidated; second lookup returns the new instance.
    expect(getCloudBackend("aws")).toBe(second);
  });

  it("force re-register clears the cached instance", () => {
    const factory1 = vi.fn(() => makeFakeBackend("aws"));
    const factory2 = vi.fn(() => makeFakeBackend("aws"));
    registerCloudBackend("aws", factory1);
    getCloudBackend("aws"); // construct via factory1
    expect(factory1).toHaveBeenCalledTimes(1);

    registerCloudBackend("aws", factory2, { force: true });
    expect(factory2).toHaveBeenCalledTimes(0); // lazy
    getCloudBackend("aws"); // construct via factory2 now
    expect(factory2).toHaveBeenCalledTimes(1);
  });
});

// ── Kind-mismatch defence ─────────────────────────────────────────

describe("getCloudBackend — kind-mismatch refusal", () => {
  it("rejects a backend whose .name disagrees with the registered kind", () => {
    // Misregistration: factory keyed as 'aws' but returns a backend
    // whose .name === 'azure'. Could happen if a copy-paste error
    // leaks into a vendor module. We refuse to cache it.
    const wrongKind = makeFakeBackend("azure");
    registerCloudBackend("aws", () => wrongKind);
    try {
      getCloudBackend("aws");
      expect.fail("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(CloudBackendError);
      expect((err as CloudBackendError).code).toBe("invalid_config");
      expect((err as Error).message).toContain("mismatched");
    }
  });
});

// ── Error-message ergonomics ──────────────────────────────────────

describe("getCloudBackend — error message guides the operator", () => {
  it("lists registered backends so the operator sees what's available", () => {
    registerCloudBackend("aws", () => makeFakeBackend("aws"));
    registerCloudBackend("azure", () => makeFakeBackend("azure"));
    try {
      getCloudBackend("gcp");
      expect.fail("expected throw");
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain("gcp");
      expect(msg).toContain("aws");
      expect(msg).toContain("azure");
      // The hint about importing the relevant module is meant to
      // be the actionable step.
      expect(msg).toContain("import");
    }
  });
});
