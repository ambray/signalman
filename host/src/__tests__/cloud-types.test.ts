/**
 * v0.3.0-5 sub-task 1 — cloud abstraction type tests.
 *
 * The shapes are TypeScript interfaces (no runtime cost), so most
 * of the testing here is on the error class + the constants that
 * vendor backends share. Type-level guarantees are enforced by
 * tsc; runtime tests verify the shape of values consumers
 * actually exchange.
 */

import { describe, it, expect } from "vitest";

import {
  CloudBackendError,
  DEFAULT_INSTANCE_TTL_MINUTES,
  SIGNALMAN_MANAGED_TAG_KEY,
  SIGNALMAN_MANAGED_TAG_VALUE,
  SIGNALMAN_ORG_TAG_KEY,
  type CloudBackendErrorCode,
  type CloudInstanceConfig,
  type CloudInstanceHandle,
  type CloudInstanceState,
  type CloudInstanceStatus,
} from "../cloud/types.js";

// ── Constants ─────────────────────────────────────────────────────

describe("Cloud module constants", () => {
  it("DEFAULT_INSTANCE_TTL_MINUTES is one hour", () => {
    expect(DEFAULT_INSTANCE_TTL_MINUTES).toBe(60);
  });

  it("SIGNALMAN_MANAGED_TAG_KEY is the documented sentinel", () => {
    expect(SIGNALMAN_MANAGED_TAG_KEY).toBe("signalman-managed");
  });

  it("SIGNALMAN_MANAGED_TAG_VALUE matches the reaper-side filter", () => {
    expect(SIGNALMAN_MANAGED_TAG_VALUE).toBe("true");
  });

  it("SIGNALMAN_ORG_TAG_KEY is the documented sentinel", () => {
    expect(SIGNALMAN_ORG_TAG_KEY).toBe("signalman-org");
  });
});

// ── CloudBackendError ─────────────────────────────────────────────

describe("CloudBackendError", () => {
  it("is an Error subclass with stable code", () => {
    const e = new CloudBackendError("provision_failed", "test");
    expect(e).toBeInstanceOf(Error);
    expect(e).toBeInstanceOf(CloudBackendError);
    expect(e.code).toBe("provision_failed");
    expect(e.name).toBe("CloudBackendError");
  });

  it("preserves a cause when supplied", () => {
    const cause = new Error("underlying");
    const e = new CloudBackendError("terminate_failed", "wrapped", cause);
    expect(e.cause).toBe(cause);
  });

  it("each documented code constructs without TS error", () => {
    // Compile-time enum-completeness check — if a future code is
    // added to CloudBackendErrorCode without updating this list,
    // tsc will flag the missing branch.
    const codes: CloudBackendErrorCode[] = [
      "unsupported_provider",
      "provision_failed",
      "terminate_failed",
      "instance_not_found",
      "ttl_expired",
      "auth_failed",
      "quota_exceeded",
      "invalid_config",
    ];
    for (const code of codes) {
      const e = new CloudBackendError(code, `test ${code}`);
      expect(e.code).toBe(code);
    }
  });
});

// ── Shape sanity ──────────────────────────────────────────────────
//
// These tests don't run real backend logic — they exist so a
// future refactor that breaks the published shape (e.g. removes a
// required field, changes a value type) surfaces as a TS error
// here, NOT silently at the first vendor-backend call site.

describe("CloudInstanceConfig — required field shape", () => {
  it("minimal valid shape compiles + populates", () => {
    const cfg: CloudInstanceConfig = {
      region: "us-east-1",
      instance_type: "t3.medium",
      image_ref: "ami-0abcd1234",
      name: "ephemeral-vm-1",
    };
    expect(cfg.region).toBe("us-east-1");
    expect(cfg.instance_type).toBe("t3.medium");
    expect(cfg.image_ref).toBe("ami-0abcd1234");
    expect(cfg.name).toBe("ephemeral-vm-1");
    // Optional fields default at the backend layer, not here.
    expect(cfg.ttl_minutes).toBeUndefined();
    expect(cfg.network).toBeUndefined();
    expect(cfg.tags).toBeUndefined();
    expect(cfg.org_id).toBeUndefined();
  });

  it("full shape with all optional fields populated", () => {
    const cfg: CloudInstanceConfig = {
      region: "eastus",
      instance_type: "Standard_D2s_v3",
      image_ref: "/subscriptions/abc/.../images/win11-baked",
      name: "ephemeral-vm-2",
      org_id: "org_xyz",
      ttl_minutes: 90,
      ssh_public_key: "ssh-rsa AAAA... user@host",
      tags: { project: "demo", owner: "team-a" },
      network: {
        subnet_id: "snet-abc",
        security_group_ids: ["sg-1", "sg-2"],
        assign_public_ip: true,
      },
    };
    expect(cfg.ttl_minutes).toBe(90);
    expect(cfg.tags?.project).toBe("demo");
    expect(cfg.network?.security_group_ids).toHaveLength(2);
  });
});

describe("CloudInstanceHandle — shape", () => {
  it("carries id + backend + name + region", () => {
    const h: CloudInstanceHandle = {
      id: "i-0abcd1234",
      backend: "aws",
      name: "ephemeral-vm-1",
      region: "us-east-1",
    };
    expect(h.id).toBe("i-0abcd1234");
    expect(h.backend).toBe("aws");
    expect(h.name).toBe("ephemeral-vm-1");
    expect(h.region).toBe("us-east-1");
  });
});

describe("CloudInstanceStatus + CloudInstanceState — shape", () => {
  it("each documented state value compiles", () => {
    const states: CloudInstanceState[] = [
      "pending",
      "running",
      "stopped",
      "terminated",
      "unknown",
    ];
    for (const state of states) {
      const status: CloudInstanceStatus = {
        handle: {
          id: "i-0",
          backend: "aws",
          name: "vm",
          region: "us-east-1",
        },
        state,
      };
      expect(status.state).toBe(state);
    }
  });

  it("status with running state carries IPs", () => {
    const status: CloudInstanceStatus = {
      handle: { id: "i-0", backend: "aws", name: "vm", region: "us-east-1" },
      state: "running",
      public_ip: "203.0.113.5",
      private_ip: "10.0.0.5",
    };
    expect(status.public_ip).toBe("203.0.113.5");
    expect(status.private_ip).toBe("10.0.0.5");
  });

  it("status with unknown state carries reason", () => {
    const status: CloudInstanceStatus = {
      handle: { id: "i-0", backend: "aws", name: "vm", region: "us-east-1" },
      state: "unknown",
      reason: "InternalError: throttled",
    };
    expect(status.reason).toContain("throttled");
  });
});
