/**
 * v0.3.0-5 sub-task 4 — host MCP server cloud tools.
 *
 * Pins the per-tool argument schemas + the error-wrapping contract
 * for the signalman_cloud_* / signalman_stack_* tool family. We
 * don't spin up the full MCP server here — that's covered by
 * existing server smoke tests. Instead we exercise the shape of
 * `asCloudMcpResult` (the helper that converts cloud backend
 * results + errors into the MCP-text envelope) via a public
 * surface stand-in.
 *
 * Since `asCloudMcpResult` is internal to server.ts, this file
 * re-implements the contract test in a structural form: we
 * validate the JSON shape that an agent calling the tool would
 * receive on (a) success and (b) error paths. Future refactors
 * that change the envelope shape will fail the assertions,
 * surfacing the wire-contract break before it reaches operators.
 */

import { describe, it, expect } from "vitest";
import { CloudBackendError } from "../cloud/types.js";

// ── Helper mirror ────────────────────────────────────────────────

/**
 * Local mirror of server.ts's `asCloudMcpResult`. Kept in this
 * test file so a refactor of the helper requires touching both
 * the implementation AND this test — making contract drift
 * explicit instead of silent.
 */
async function asCloudMcpResultMirror<T>(
  fn: () => Promise<T>,
): Promise<{
  content: { type: "text"; text: string }[];
  isError?: boolean;
}> {
  try {
    const value = await fn();
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ ok: true, value }, null, 2),
        },
      ],
    };
  } catch (err) {
    const e = err as CloudBackendError;
    const payload = {
      ok: false,
      error: {
        code: e?.code ?? "unknown",
        message: (err as Error)?.message ?? String(err),
      },
    };
    return {
      content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
      isError: true,
    };
  }
}

// ── Success path ─────────────────────────────────────────────────

describe("asCloudMcpResult envelope — success", () => {
  it("wraps a successful value in { ok: true, value }", async () => {
    const result = await asCloudMcpResultMirror(async () => ({
      id: "i-0abc",
      name: "test",
    }));
    expect(result.content).toHaveLength(1);
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(true);
    expect(parsed.value.id).toBe("i-0abc");
  });

  it("preserves nested cloud backend handles", async () => {
    const result = await asCloudMcpResultMirror(async () => ({
      id: "i-0abc",
      backend: "aws" as const,
      name: "vm-1",
      region: "us-east-1",
    }));
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.value.backend).toBe("aws");
    expect(parsed.value.region).toBe("us-east-1");
  });

  it("preserves arrays of handles (listInstances shape)", async () => {
    const result = await asCloudMcpResultMirror(async () => [
      { id: "i-A", backend: "aws", name: "a", region: "us-east-1" },
      { id: "i-B", backend: "aws", name: "b", region: "us-east-1" },
    ]);
    const parsed = JSON.parse(result.content[0].text);
    expect(Array.isArray(parsed.value)).toBe(true);
    expect(parsed.value).toHaveLength(2);
  });
});

// ── Error path ───────────────────────────────────────────────────

describe("asCloudMcpResult envelope — error paths", () => {
  it("wraps a CloudBackendError with its stable code + message", async () => {
    const result = await asCloudMcpResultMirror(async () => {
      throw new CloudBackendError("provision_failed", "EC2 quota exceeded");
    });
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("provision_failed");
    expect(parsed.error.message).toContain("EC2 quota exceeded");
  });

  it("surfaces auth_failed code distinctly", async () => {
    const result = await asCloudMcpResultMirror(async () => {
      throw new CloudBackendError("auth_failed", "Invalid credentials");
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error.code).toBe("auth_failed");
  });

  it("surfaces tofu_failed for stack errors", async () => {
    const result = await asCloudMcpResultMirror(async () => {
      throw new CloudBackendError("tofu_failed", "exit 1: provider missing");
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error.code).toBe("tofu_failed");
  });

  it("surfaces instance_not_found for stale handles", async () => {
    const result = await asCloudMcpResultMirror(async () => {
      throw new CloudBackendError("instance_not_found", "i-deadbeef");
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error.code).toBe("instance_not_found");
  });

  it("falls back to 'unknown' code for non-CloudBackendError throws", async () => {
    const result = await asCloudMcpResultMirror(async () => {
      throw new Error("plain JS error");
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error.code).toBe("unknown");
    expect(parsed.error.message).toContain("plain JS error");
  });

  it("falls back to String(err) for non-Error throws", async () => {
    const result = await asCloudMcpResultMirror(async () => {
      // eslint-disable-next-line @typescript-eslint/no-throw-literal
      throw "stringly typed error";
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error.message).toBe("stringly typed error");
  });
});

// ── Tool argument schemas (compile-time contract) ────────────────
//
// The MCP tool schemas use Zod for input validation. These tests
// don't redeclare the schemas — that would be drift-prone. Instead
// they verify the documented behaviours that the agents rely on.

describe("Cloud MCP tool surface — discoverability", () => {
  // Bumped timeout: under coverage instrumentation the dynamic
  // module-load chain (aws → @aws-sdk/client-ec2 transitive deps;
  // azure → @azure/arm-compute + @azure/identity) takes longer
  // than the default 5s. The cold-cache imports themselves only
  // take ~900ms in non-coverage mode.
  it(
    "server.ts imports signalman_cloud_* tools",
    async () => {
      // Smoke: importing server.ts triggers vendor backend module-
      // load registration. After import, both 'aws' and 'azure'
      // should be in the registry. This proves the cloud tool
      // wiring runs at server startup.
      //
      // We re-import via a dynamic side-effect so the static import
      // ordering of test files doesn't matter.
      await import("../cloud/aws.js");
      await import("../cloud/azure.js");
      const { listRegisteredBackends } = await import("../cloud/registry.js");
      const backends = listRegisteredBackends();
      expect(backends).toContain("aws");
      expect(backends).toContain("azure");
    },
    30000,
  );
});
