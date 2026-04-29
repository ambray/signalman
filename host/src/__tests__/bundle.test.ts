/**
 * P9.2 bundle tests — schema validation + installBundle dispatch.
 *
 * Mirrors the mock-driven pattern from `workflow-api.test.ts`: the
 * backend / GuestAgentClient surface is faked with vi.fn() and we
 * inspect both the returned `InstallBundleResult` and the mock-call
 * history to assert the routing layer matches the locked design
 * decisions:
 *
 *   - Tier 1 sources (winget/choco/msstore) route through
 *     `client.installSoftware`.
 *   - `direct` and `docker` route through extension methods
 *     (installDirect / installDocker).
 *   - `parallel:` groups fire concurrently.
 *   - Failures surface as failed-status entries, not thrown errors.
 *   - `verify` post-install command is honoured.
 *
 * Schema-rejection cases are also covered here so the gates documented
 * in `bundle-types.ts` are pinned: missing sha256 on direct, http://
 * URL on direct, .bat extension on direct, missing image_sha256 on
 * docker.
 */

import { describe, it, expect, vi } from "vitest";

import {
  parseBundle,
  BundleValidationError,
  type Bundle,
} from "../provisioning/bundle-types.js";
import {
  installBundle,
  type BundleCapableClient,
} from "../provisioning/install-bundle.js";
import type { HypervisorBackend } from "../hypervisors/interface.js";
import type { GuestAgentClient } from "../guest/client.js";

// ── Helpers ─────────────────────────────────────────────────────────

function makeMockBackend(): HypervisorBackend {
  // installBundle holds a reference but doesn't call into it for v0.1.1;
  // the mock is therefore minimal — only the type contract matters.
  return {
    name: "mock",
    isAvailable: vi.fn().mockResolvedValue(true),
  } as unknown as HypervisorBackend;
}

function makeMockClient(
  overrides: Partial<BundleCapableClient> = {},
): BundleCapableClient {
  return {
    connectionState: "connected",
    isConnected: vi.fn().mockResolvedValue(true),
    dispose: vi.fn(),
    close: vi.fn(),
    runCommand: vi.fn().mockResolvedValue({
      exitCode: 0,
      stdout: "",
      stderr: "",
      durationMs: 5,
    }),
    installSoftware: vi.fn().mockResolvedValue({
      success: true,
      exitCode: 0,
      stdout: "installed",
      stderr: "",
      installedPath: "C:\\test",
    }),
    installDirect: vi.fn().mockResolvedValue({
      success: true,
      exitCode: 0,
      stdout: "installed",
      stderr: "",
      installedPath: "C:\\direct",
    }),
    installDocker: vi.fn().mockResolvedValue({
      success: true,
      exitCode: 0,
      stdout: "container started",
      stderr: "",
      installedPath: "",
    }),
    ...overrides,
  } as unknown as BundleCapableClient;
}

// ── parseBundle: success ────────────────────────────────────────────

describe("parseBundle: every Tier 1 source", () => {
  it("accepts a valid bundle with all five sources + a parallel group", () => {
    const raw = {
      apiVersion: "signalman.dev/v1alpha1",
      kind: "Bundle",
      metadata: { name: "all-sources" },
      packages: [
        { id: "Git.Git", source: "winget" },
        { id: "nodejs-lts", source: "choco" },
        { id: "9NBLGGH4MSV6", source: "msstore" },
        {
          id: "vlc",
          source: "direct",
          url: "https://example.com/vlc-installer.msi",
          sha256: "a".repeat(64),
        },
        {
          id: "mailhog",
          source: "docker",
          image: "mailhog/mailhog",
          image_sha256:
            "sha256:8d128e87db96f3ac3d6f80dea5d7cb0b4cd5e1a9b7e69ff84fa28c8a6e1aaa11",
        },
        {
          parallel: [
            { id: "p1", source: "winget" },
            { id: "p2", source: "winget" },
          ],
        },
      ],
    };
    const bundle = parseBundle(raw);
    expect(bundle.metadata.name).toBe("all-sources");
    expect(bundle.packages).toHaveLength(6);
  });
});

// ── parseBundle: rejection cases ────────────────────────────────────

describe("parseBundle: security gates", () => {
  it("rejects direct missing sha256", () => {
    expect(() =>
      parseBundle({
        apiVersion: "signalman.dev/v1alpha1",
        kind: "Bundle",
        metadata: { name: "x" },
        packages: [
          {
            id: "x",
            source: "direct",
            url: "https://example.com/x.msi",
          },
        ],
      }),
    ).toThrow(BundleValidationError);
  });

  it("rejects direct with http:// URL (HTTPS-only gate)", () => {
    expect(() =>
      parseBundle({
        apiVersion: "signalman.dev/v1alpha1",
        kind: "Bundle",
        metadata: { name: "x" },
        packages: [
          {
            id: "x",
            source: "direct",
            url: "http://example.com/x.msi",
            sha256: "a".repeat(64),
          },
        ],
      }),
    ).toThrow(/https/);
  });

  it("rejects direct with .bat extension (allowlist gate)", () => {
    expect(() =>
      parseBundle({
        apiVersion: "signalman.dev/v1alpha1",
        kind: "Bundle",
        metadata: { name: "x" },
        packages: [
          {
            id: "x",
            source: "direct",
            url: "https://example.com/x.bat",
            sha256: "a".repeat(64),
          },
        ],
      }),
    ).toThrow(/allowlisted/);
  });

  it("rejects docker missing image_sha256", () => {
    expect(() =>
      parseBundle({
        apiVersion: "signalman.dev/v1alpha1",
        kind: "Bundle",
        metadata: { name: "x" },
        packages: [
          {
            id: "x",
            source: "docker",
            image: "mailhog/mailhog",
          },
        ],
      }),
    ).toThrow(BundleValidationError);
  });

  it("rejects docker with malformed digest pin", () => {
    expect(() =>
      parseBundle({
        apiVersion: "signalman.dev/v1alpha1",
        kind: "Bundle",
        metadata: { name: "x" },
        packages: [
          {
            id: "x",
            source: "docker",
            image: "mailhog/mailhog",
            image_sha256: "not-a-digest",
          },
        ],
      }),
    ).toThrow(BundleValidationError);
  });

  it("rejects sha256 with wrong length", () => {
    expect(() =>
      parseBundle({
        apiVersion: "signalman.dev/v1alpha1",
        kind: "Bundle",
        metadata: { name: "x" },
        packages: [
          {
            id: "x",
            source: "direct",
            url: "https://example.com/x.msi",
            sha256: "abc",
          },
        ],
      }),
    ).toThrow(/64 lowercase hex/);
  });
});

// ── installBundle: routing ─────────────────────────────────────────

describe("installBundle: Tier 1 source routing", () => {
  it("winget/choco/msstore route through client.installSoftware with the source string", async () => {
    const backend = makeMockBackend();
    const client = makeMockClient();
    const bundle: Bundle = parseBundle({
      apiVersion: "signalman.dev/v1alpha1",
      kind: "Bundle",
      metadata: { name: "tier1" },
      packages: [
        { id: "Git.Git", source: "winget" },
        { id: "nodejs-lts", source: "choco" },
        { id: "9NBLGGH4MSV6", source: "msstore" },
      ],
    });
    const result = await installBundle(
      backend,
      client as unknown as GuestAgentClient,
      "endpoint-1",
      bundle,
    );
    expect(result.installed).toBe(3);
    expect(result.failed).toBe(0);
    expect(client.installSoftware).toHaveBeenCalledTimes(3);
    const calls = (client.installSoftware as ReturnType<typeof vi.fn>).mock
      .calls;
    expect(calls[0][1]).toBe("winget");
    expect(calls[1][1]).toBe("choco");
    expect(calls[2][1]).toBe("msstore");
  });

  it("direct routes through client.installDirect with url + sha256", async () => {
    const backend = makeMockBackend();
    const client = makeMockClient();
    const bundle = parseBundle({
      apiVersion: "signalman.dev/v1alpha1",
      kind: "Bundle",
      metadata: { name: "direct-only" },
      packages: [
        {
          id: "vlc",
          source: "direct",
          url: "https://example.com/vlc.msi",
          sha256: "a".repeat(64),
          args: ["/S"],
        },
      ],
    });
    const result = await installBundle(
      backend,
      client as unknown as GuestAgentClient,
      "endpoint-1",
      bundle,
    );
    expect(result.installed).toBe(1);
    expect(client.installDirect).toHaveBeenCalledTimes(1);
    const arg = (client.installDirect as ReturnType<typeof vi.fn>).mock
      .calls[0][0];
    expect(arg.url).toBe("https://example.com/vlc.msi");
    expect(arg.sha256).toBe("a".repeat(64));
    expect(arg.args).toEqual(["/S"]);
  });

  it("docker routes through client.installDocker with image_sha256 and default restart_policy", async () => {
    const backend = makeMockBackend();
    const client = makeMockClient();
    const bundle = parseBundle({
      apiVersion: "signalman.dev/v1alpha1",
      kind: "Bundle",
      metadata: { name: "docker-only" },
      packages: [
        {
          id: "mailhog",
          source: "docker",
          image: "mailhog/mailhog",
          image_sha256:
            "sha256:8d128e87db96f3ac3d6f80dea5d7cb0b4cd5e1a9b7e69ff84fa28c8a6e1aaa11",
        },
      ],
    });
    const result = await installBundle(
      backend,
      client as unknown as GuestAgentClient,
      "endpoint-1",
      bundle,
    );
    expect(result.installed).toBe(1);
    expect(client.installDocker).toHaveBeenCalledTimes(1);
    const arg = (client.installDocker as ReturnType<typeof vi.fn>).mock
      .calls[0][0];
    expect(arg.image).toBe("mailhog/mailhog");
    expect(arg.image_sha256).toMatch(/^sha256:/);
    expect(arg.restart_policy).toBe("unless-stopped");
  });
});

// ── installBundle: parallel groups ──────────────────────────────────

describe("installBundle: parallel groups", () => {
  it("Promise.all-fires inner installs concurrently", async () => {
    const backend = makeMockBackend();
    // Each install takes ~100 ms; running three sequentially would be
    // ~300 ms, in parallel ~100 ms. We assert the wall-clock < 250 ms
    // to avoid flakiness on a slow CI box but still catch sequential
    // dispatch.
    const client = makeMockClient({
      installSoftware: vi.fn().mockImplementation(async () => {
        await new Promise((r) => setTimeout(r, 100));
        return {
          success: true,
          exitCode: 0,
          stdout: "ok",
          stderr: "",
          installedPath: "",
        };
      }),
    });
    const bundle = parseBundle({
      apiVersion: "signalman.dev/v1alpha1",
      kind: "Bundle",
      metadata: { name: "parallel" },
      packages: [
        {
          parallel: [
            { id: "a", source: "winget" },
            { id: "b", source: "winget" },
            { id: "c", source: "winget" },
          ],
        },
      ],
    });
    const t0 = Date.now();
    const result = await installBundle(
      backend,
      client as unknown as GuestAgentClient,
      "endpoint-1",
      bundle,
    );
    const elapsed = Date.now() - t0;
    expect(result.installed).toBe(3);
    expect(client.installSoftware).toHaveBeenCalledTimes(3);
    expect(elapsed).toBeLessThan(250);
  });
});

// ── installBundle: failure handling ─────────────────────────────────

describe("installBundle: failure propagation", () => {
  it("RPC errors land as failed-status per-package entries, not throws", async () => {
    const backend = makeMockBackend();
    const client = makeMockClient({
      installSoftware: vi
        .fn()
        .mockRejectedValueOnce(new Error("winget: package not found")),
    });
    const bundle = parseBundle({
      apiVersion: "signalman.dev/v1alpha1",
      kind: "Bundle",
      metadata: { name: "fail" },
      packages: [{ id: "Bogus.Pkg", source: "winget" }],
    });
    const result = await installBundle(
      backend,
      client as unknown as GuestAgentClient,
      "endpoint-1",
      bundle,
    );
    expect(result.failed).toBe(1);
    expect(result.installed).toBe(0);
    expect(result.perPackageResults[0].status).toBe("failed");
    expect(result.perPackageResults[0].error).toMatch(/not found/);
  });

  it("verify-command failure marks the package as failed", async () => {
    const backend = makeMockBackend();
    const client = makeMockClient({
      runCommand: vi.fn().mockResolvedValue({
        exitCode: 1,
        stdout: "",
        stderr: "command not found",
        durationMs: 5,
      }),
    });
    const bundle = parseBundle({
      apiVersion: "signalman.dev/v1alpha1",
      kind: "Bundle",
      metadata: { name: "verify-fail" },
      packages: [
        {
          id: "Git.Git",
          source: "winget",
          verify: "git --version",
        },
      ],
    });
    const result = await installBundle(
      backend,
      client as unknown as GuestAgentClient,
      "endpoint-1",
      bundle,
    );
    expect(result.failed).toBe(1);
    expect(result.installed).toBe(0);
    expect(result.perPackageResults[0].status).toBe("failed");
    expect(result.perPackageResults[0].error).toMatch(/verify exited 1/);
  });

  it("verify_expect substring miss marks the package as failed", async () => {
    const backend = makeMockBackend();
    const client = makeMockClient({
      runCommand: vi.fn().mockResolvedValue({
        exitCode: 0,
        stdout: "some other output",
        stderr: "",
        durationMs: 5,
      }),
    });
    const bundle = parseBundle({
      apiVersion: "signalman.dev/v1alpha1",
      kind: "Bundle",
      metadata: { name: "verify-substr" },
      packages: [
        {
          id: "Git.Git",
          source: "winget",
          verify: "git --version",
          verify_expect: "git version",
        },
      ],
    });
    const result = await installBundle(
      backend,
      client as unknown as GuestAgentClient,
      "endpoint-1",
      bundle,
    );
    expect(result.failed).toBe(1);
    expect(result.perPackageResults[0].error).toMatch(
      /did not contain "git version"/,
    );
  });

  it("'already installed' RPC stdout produces a skipped entry, not failed", async () => {
    const backend = makeMockBackend();
    const client = makeMockClient({
      installSoftware: vi.fn().mockResolvedValue({
        success: true,
        exitCode: 0,
        stdout: "Package already installed",
        stderr: "",
        installedPath: "",
      }),
    });
    const bundle = parseBundle({
      apiVersion: "signalman.dev/v1alpha1",
      kind: "Bundle",
      metadata: { name: "skip" },
      packages: [{ id: "Git.Git", source: "winget" }],
    });
    const result = await installBundle(
      backend,
      client as unknown as GuestAgentClient,
      "endpoint-1",
      bundle,
    );
    expect(result.skipped).toBe(1);
    expect(result.installed).toBe(0);
    expect(result.failed).toBe(0);
  });
});
