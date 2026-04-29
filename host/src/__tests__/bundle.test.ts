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
    // P9.2 proto bump: client method takes camelCase to match the
    // rest of the TS API; the YAML schema still uses snake_case for
    // operator readability, install-bundle.ts translates.
    expect(arg.imageSha256).toMatch(/^sha256:/);
    expect(arg.restartPolicy).toBe("unless-stopped");
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

// ── Tier 2: schema accept ──────────────────────────────────────────

describe("parseBundle: Tier 2 sources accept valid bundles", () => {
  it("accepts a scoop entry", () => {
    const bundle = parseBundle({
      apiVersion: "signalman.dev/v1alpha1",
      kind: "Bundle",
      metadata: { name: "scoop" },
      packages: [
        { id: "scoop-nodejs", source: "scoop", package_id: "nodejs" },
      ],
    });
    expect(bundle.packages).toHaveLength(1);
  });

  it("accepts a github_release entry without sha256", () => {
    const bundle = parseBundle({
      apiVersion: "signalman.dev/v1alpha1",
      kind: "Bundle",
      metadata: { name: "gh" },
      packages: [
        {
          id: "fzf",
          source: "github_release",
          repo: "junegunn/fzf",
          asset_name_pattern: "fzf-*-windows_amd64.zip",
        },
      ],
    });
    expect(bundle.packages).toHaveLength(1);
  });

  it("accepts a git_repo entry with sparse + submodules", () => {
    const bundle = parseBundle({
      apiVersion: "signalman.dev/v1alpha1",
      kind: "Bundle",
      metadata: { name: "git" },
      packages: [
        {
          id: "checkout",
          source: "git_repo",
          url: "https://github.com/example/repo.git",
          ref: "v1.2.3",
          dest: "C:\\src\\repo",
          submodules: true,
          sparse: ["docs", "test"],
        },
      ],
    });
    expect(bundle.packages).toHaveLength(1);
  });

  it("accepts a powershell entry", () => {
    const bundle = parseBundle({
      apiVersion: "signalman.dev/v1alpha1",
      kind: "Bundle",
      metadata: { name: "ps" },
      packages: [
        {
          id: "psreadline",
          source: "powershell",
          module_id: "PSReadLine",
          scope: "AllUsers",
          version: "2.3.4",
        },
      ],
    });
    expect(bundle.packages).toHaveLength(1);
  });

  it("accepts npm/pip/cargo entries", () => {
    const bundle = parseBundle({
      apiVersion: "signalman.dev/v1alpha1",
      kind: "Bundle",
      metadata: { name: "lang" },
      packages: [
        { id: "tsc", source: "npm", package_id: "typescript", version: "5.4.5" },
        { id: "req", source: "pip", package_id: "requests" },
        { id: "just", source: "cargo", crate_id: "just" },
      ],
    });
    expect(bundle.packages).toHaveLength(3);
  });

  it("accepts a custom_script entry", () => {
    const bundle = parseBundle({
      apiVersion: "signalman.dev/v1alpha1",
      kind: "Bundle",
      metadata: { name: "cs" },
      packages: [
        {
          id: "boot",
          source: "custom_script",
          url: "https://example.com/bootstrap.ps1",
          sha256: "a".repeat(64),
          interpreter: "pwsh",
          args: ["-Force"],
        },
      ],
    });
    expect(bundle.packages).toHaveLength(1);
  });
});

// ── Tier 2: schema reject — missing required fields ────────────────

describe("parseBundle: Tier 2 missing-required-field rejection", () => {
  it("rejects scoop without package_id", () => {
    expect(() =>
      parseBundle({
        apiVersion: "signalman.dev/v1alpha1",
        kind: "Bundle",
        metadata: { name: "x" },
        packages: [{ id: "s", source: "scoop" }],
      }),
    ).toThrow(BundleValidationError);
  });

  it("rejects github_release without repo", () => {
    expect(() =>
      parseBundle({
        apiVersion: "signalman.dev/v1alpha1",
        kind: "Bundle",
        metadata: { name: "x" },
        packages: [
          {
            id: "g",
            source: "github_release",
            asset_name_pattern: "*.zip",
          },
        ],
      }),
    ).toThrow(BundleValidationError);
  });

  it("rejects git_repo without dest", () => {
    expect(() =>
      parseBundle({
        apiVersion: "signalman.dev/v1alpha1",
        kind: "Bundle",
        metadata: { name: "x" },
        packages: [
          {
            id: "g",
            source: "git_repo",
            url: "https://github.com/x/y.git",
          },
        ],
      }),
    ).toThrow(BundleValidationError);
  });

  it("rejects powershell without module_id", () => {
    expect(() =>
      parseBundle({
        apiVersion: "signalman.dev/v1alpha1",
        kind: "Bundle",
        metadata: { name: "x" },
        packages: [{ id: "p", source: "powershell" }],
      }),
    ).toThrow(BundleValidationError);
  });

  it("rejects npm without package_id", () => {
    expect(() =>
      parseBundle({
        apiVersion: "signalman.dev/v1alpha1",
        kind: "Bundle",
        metadata: { name: "x" },
        packages: [{ id: "n", source: "npm" }],
      }),
    ).toThrow(BundleValidationError);
  });

  it("rejects pip without package_id", () => {
    expect(() =>
      parseBundle({
        apiVersion: "signalman.dev/v1alpha1",
        kind: "Bundle",
        metadata: { name: "x" },
        packages: [{ id: "n", source: "pip" }],
      }),
    ).toThrow(BundleValidationError);
  });

  it("rejects cargo without crate_id", () => {
    expect(() =>
      parseBundle({
        apiVersion: "signalman.dev/v1alpha1",
        kind: "Bundle",
        metadata: { name: "x" },
        packages: [{ id: "c", source: "cargo" }],
      }),
    ).toThrow(BundleValidationError);
  });

  it("rejects custom_script without sha256", () => {
    expect(() =>
      parseBundle({
        apiVersion: "signalman.dev/v1alpha1",
        kind: "Bundle",
        metadata: { name: "x" },
        packages: [
          {
            id: "cs",
            source: "custom_script",
            url: "https://example.com/x.ps1",
            interpreter: "pwsh",
          },
        ],
      }),
    ).toThrow(BundleValidationError);
  });
});

// ── Tier 2: security gates ────────────────────────────────────────

describe("parseBundle: Tier 2 security gates", () => {
  it("rejects github_release with malformed repo (path traversal)", () => {
    expect(() =>
      parseBundle({
        apiVersion: "signalman.dev/v1alpha1",
        kind: "Bundle",
        metadata: { name: "x" },
        packages: [
          {
            id: "x",
            source: "github_release",
            repo: "../etc/passwd",
            asset_name_pattern: "*.zip",
          },
        ],
      }),
    ).toThrow(/owner\/repo/);
  });

  it("rejects github_release asset_name_pattern containing '/'", () => {
    expect(() =>
      parseBundle({
        apiVersion: "signalman.dev/v1alpha1",
        kind: "Bundle",
        metadata: { name: "x" },
        packages: [
          {
            id: "x",
            source: "github_release",
            repo: "junegunn/fzf",
            asset_name_pattern: "../*.zip",
          },
        ],
      }),
    ).toThrow(/'\/'|'\.\.'/);
  });

  it("rejects git_repo with http:// URL (HTTPS-only)", () => {
    expect(() =>
      parseBundle({
        apiVersion: "signalman.dev/v1alpha1",
        kind: "Bundle",
        metadata: { name: "x" },
        packages: [
          {
            id: "x",
            source: "git_repo",
            url: "http://github.com/example/r.git",
            dest: "C:\\src\\r",
          },
        ],
      }),
    ).toThrow(/https:\/\//);
  });

  it("rejects git_repo with ssh:// URL", () => {
    expect(() =>
      parseBundle({
        apiVersion: "signalman.dev/v1alpha1",
        kind: "Bundle",
        metadata: { name: "x" },
        packages: [
          {
            id: "x",
            source: "git_repo",
            url: "ssh://git@github.com/example/r.git",
            dest: "C:\\src\\r",
          },
        ],
      }),
    ).toThrow(/https:\/\//);
  });

  it("rejects git_repo with bad ref (shell metachars)", () => {
    expect(() =>
      parseBundle({
        apiVersion: "signalman.dev/v1alpha1",
        kind: "Bundle",
        metadata: { name: "x" },
        packages: [
          {
            id: "x",
            source: "git_repo",
            url: "https://github.com/example/r.git",
            ref: "main; rm -rf /",
            dest: "C:\\src\\r",
          },
        ],
      }),
    ).toThrow(/ref/);
  });

  it("rejects git_repo with relative dest", () => {
    expect(() =>
      parseBundle({
        apiVersion: "signalman.dev/v1alpha1",
        kind: "Bundle",
        metadata: { name: "x" },
        packages: [
          {
            id: "x",
            source: "git_repo",
            url: "https://github.com/example/r.git",
            dest: "src/r",
          },
        ],
      }),
    ).toThrow(/absolute/);
  });

  it("rejects git_repo dest containing '..'", () => {
    expect(() =>
      parseBundle({
        apiVersion: "signalman.dev/v1alpha1",
        kind: "Bundle",
        metadata: { name: "x" },
        packages: [
          {
            id: "x",
            source: "git_repo",
            url: "https://github.com/example/r.git",
            dest: "C:\\src\\..\\evil",
          },
        ],
      }),
    ).toThrow(/'\.\.'/);
  });

  it("rejects custom_script with http:// URL", () => {
    expect(() =>
      parseBundle({
        apiVersion: "signalman.dev/v1alpha1",
        kind: "Bundle",
        metadata: { name: "x" },
        packages: [
          {
            id: "x",
            source: "custom_script",
            url: "http://example.com/x.ps1",
            sha256: "a".repeat(64),
            interpreter: "pwsh",
          },
        ],
      }),
    ).toThrow(/https:\/\//);
  });

  it("rejects custom_script with bogus interpreter", () => {
    expect(() =>
      parseBundle({
        apiVersion: "signalman.dev/v1alpha1",
        kind: "Bundle",
        metadata: { name: "x" },
        packages: [
          {
            id: "x",
            source: "custom_script",
            url: "https://example.com/x.ps1",
            sha256: "a".repeat(64),
            interpreter: "cmd",
          },
        ],
      }),
    ).toThrow(BundleValidationError);
  });

  it("rejects npm package_id with shell metachars", () => {
    expect(() =>
      parseBundle({
        apiVersion: "signalman.dev/v1alpha1",
        kind: "Bundle",
        metadata: { name: "x" },
        packages: [
          { id: "x", source: "npm", package_id: "typescript; rm -rf /" },
        ],
      }),
    ).toThrow(/alphanumerics/);
  });
});

// ── Tier 2: dispatch routing ───────────────────────────────────────

describe("installBundle: Tier 2 dispatch routing", () => {
  it("scoop routes through client.installSoftware with source=scoop", async () => {
    const backend = makeMockBackend();
    const client = makeMockClient();
    const bundle = parseBundle({
      apiVersion: "signalman.dev/v1alpha1",
      kind: "Bundle",
      metadata: { name: "scoop" },
      packages: [
        { id: "node", source: "scoop", package_id: "nodejs", version: "20.11.0" },
      ],
    });
    const result = await installBundle(
      backend,
      client as unknown as GuestAgentClient,
      "vm",
      bundle,
    );
    expect(result.installed).toBe(1);
    expect(client.installSoftware).toHaveBeenCalledTimes(1);
    const call = (client.installSoftware as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toBe("nodejs");
    expect(call[1]).toBe("scoop");
    expect(call[2]).toBe("20.11.0");
  });

  it("github_release fetches GitHub API and routes through installDirect", async () => {
    const backend = makeMockBackend();
    const client = makeMockClient();
    const fakeFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({
        assets: [
          {
            name: "fzf-0.50.0-linux_amd64.tar.gz",
            browser_download_url: "https://example.com/fzf-linux.tar.gz",
          },
          {
            name: "fzf-0.50.0-windows_amd64.zip",
            browser_download_url:
              "https://example.com/fzf-windows.zip",
          },
        ],
      }),
    } as unknown as Response);
    const bundle = parseBundle({
      apiVersion: "signalman.dev/v1alpha1",
      kind: "Bundle",
      metadata: { name: "gh" },
      packages: [
        {
          id: "fzf",
          source: "github_release",
          repo: "junegunn/fzf",
          asset_name_pattern: "fzf-*-windows_amd64.zip",
          sha256: "a".repeat(64),
        },
      ],
    });
    const result = await installBundle(
      backend,
      client as unknown as GuestAgentClient,
      "vm",
      bundle,
      { githubFetch: fakeFetch as unknown as typeof fetch },
    );
    expect(result.installed).toBe(1);
    expect(fakeFetch).toHaveBeenCalledTimes(1);
    const apiUrl = (fakeFetch.mock.calls[0] as unknown as [string])[0];
    expect(apiUrl).toBe(
      "https://api.github.com/repos/junegunn/fzf/releases/latest",
    );
    expect(client.installDirect).toHaveBeenCalledTimes(1);
    const arg = (client.installDirect as ReturnType<typeof vi.fn>).mock
      .calls[0][0];
    expect(arg.url).toBe("https://example.com/fzf-windows.zip");
    expect(arg.sha256).toBe("a".repeat(64));
  });

  it("github_release surfaces GitHub API failure as a failed result", async () => {
    const backend = makeMockBackend();
    const client = makeMockClient();
    const fakeFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      statusText: "Forbidden",
      json: async () => ({}),
    } as unknown as Response);
    const bundle = parseBundle({
      apiVersion: "signalman.dev/v1alpha1",
      kind: "Bundle",
      metadata: { name: "gh-rate" },
      packages: [
        {
          id: "fzf",
          source: "github_release",
          repo: "junegunn/fzf",
          asset_name_pattern: "*.zip",
          sha256: "a".repeat(64),
        },
      ],
    });
    const result = await installBundle(
      backend,
      client as unknown as GuestAgentClient,
      "vm",
      bundle,
      { githubFetch: fakeFetch as unknown as typeof fetch },
    );
    expect(result.failed).toBe(1);
    expect(result.perPackageResults[0].error).toMatch(/rate limit|403/);
    expect(client.installDirect).not.toHaveBeenCalled();
  });

  it("git_repo with sparse-checkout issues three runCommand calls", async () => {
    const backend = makeMockBackend();
    const client = makeMockClient({
      runCommand: vi.fn().mockResolvedValue({
        exitCode: 0,
        stdout: "",
        stderr: "",
        durationMs: 5,
      }),
    });
    const bundle = parseBundle({
      apiVersion: "signalman.dev/v1alpha1",
      kind: "Bundle",
      metadata: { name: "git-sparse" },
      packages: [
        {
          id: "checkout",
          source: "git_repo",
          url: "https://github.com/example/repo.git",
          dest: "C:\\src\\repo",
          sparse: ["docs", "test"],
        },
      ],
    });
    const result = await installBundle(
      backend,
      client as unknown as GuestAgentClient,
      "vm",
      bundle,
    );
    expect(result.installed).toBe(1);
    // Exactly three git invocations: clone + sparse-checkout init +
    // sparse-checkout set.
    expect(client.runCommand).toHaveBeenCalledTimes(3);
    const calls = (client.runCommand as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0][0]).toBe("git");
    expect(calls[0][1]).toContain("clone");
    expect(calls[0][1]).toContain("--filter=blob:none");
    expect(calls[1][1]).toContain("init");
    expect(calls[2][1]).toContain("set");
    expect(calls[2][1]).toContain("docs");
    expect(calls[2][1]).toContain("test");
  });

  it("git_repo without sparse-checkout issues a single runCommand call", async () => {
    const backend = makeMockBackend();
    const client = makeMockClient({
      runCommand: vi.fn().mockResolvedValue({
        exitCode: 0,
        stdout: "",
        stderr: "",
        durationMs: 5,
      }),
    });
    const bundle = parseBundle({
      apiVersion: "signalman.dev/v1alpha1",
      kind: "Bundle",
      metadata: { name: "git-simple" },
      packages: [
        {
          id: "checkout",
          source: "git_repo",
          url: "https://github.com/example/repo.git",
          ref: "v1.0.0",
          dest: "C:\\src\\repo",
        },
      ],
    });
    const result = await installBundle(
      backend,
      client as unknown as GuestAgentClient,
      "vm",
      bundle,
    );
    expect(result.installed).toBe(1);
    expect(client.runCommand).toHaveBeenCalledTimes(1);
    const args = (client.runCommand as ReturnType<typeof vi.fn>).mock
      .calls[0][1];
    expect(args).toContain("clone");
    expect(args).toContain("--branch");
    expect(args).toContain("v1.0.0");
  });

  it("powershell routes through runCommand pwsh Install-Module", async () => {
    const backend = makeMockBackend();
    const client = makeMockClient({
      runCommand: vi.fn().mockResolvedValue({
        exitCode: 0,
        stdout: "",
        stderr: "",
        durationMs: 5,
      }),
    });
    const bundle = parseBundle({
      apiVersion: "signalman.dev/v1alpha1",
      kind: "Bundle",
      metadata: { name: "ps" },
      packages: [
        {
          id: "psr",
          source: "powershell",
          module_id: "PSReadLine",
          scope: "AllUsers",
        },
      ],
    });
    const result = await installBundle(
      backend,
      client as unknown as GuestAgentClient,
      "vm",
      bundle,
    );
    expect(result.installed).toBe(1);
    expect(client.runCommand).toHaveBeenCalledTimes(1);
    const call = (client.runCommand as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toBe("pwsh");
    expect(call[1]).toContain("Install-Module");
    expect(call[1]).toContain("PSReadLine");
    expect(call[1]).toContain("AllUsers");
  });

  it("npm routes through runCommand with version pin", async () => {
    const backend = makeMockBackend();
    const client = makeMockClient({
      runCommand: vi.fn().mockResolvedValue({
        exitCode: 0,
        stdout: "added 1 package",
        stderr: "",
        durationMs: 5,
      }),
    });
    const bundle = parseBundle({
      apiVersion: "signalman.dev/v1alpha1",
      kind: "Bundle",
      metadata: { name: "npm" },
      packages: [
        {
          id: "tsc",
          source: "npm",
          package_id: "typescript",
          version: "5.4.5",
        },
      ],
    });
    const result = await installBundle(
      backend,
      client as unknown as GuestAgentClient,
      "vm",
      bundle,
    );
    expect(result.installed).toBe(1);
    const call = (client.runCommand as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toBe("npm");
    expect(call[1]).toEqual(["install", "-g", "typescript@5.4.5"]);
  });

  it("pip routes through runCommand with version-pin syntax", async () => {
    const backend = makeMockBackend();
    const client = makeMockClient({
      runCommand: vi.fn().mockResolvedValue({
        exitCode: 0,
        stdout: "Successfully installed requests",
        stderr: "",
        durationMs: 5,
      }),
    });
    const bundle = parseBundle({
      apiVersion: "signalman.dev/v1alpha1",
      kind: "Bundle",
      metadata: { name: "pip" },
      packages: [
        {
          id: "req",
          source: "pip",
          package_id: "requests",
          version: "2.32.3",
        },
      ],
    });
    const result = await installBundle(
      backend,
      client as unknown as GuestAgentClient,
      "vm",
      bundle,
    );
    expect(result.installed).toBe(1);
    const call = (client.runCommand as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toBe("pip");
    expect(call[1]).toEqual(["install", "requests==2.32.3"]);
  });

  it("cargo routes through runCommand with --version", async () => {
    const backend = makeMockBackend();
    const client = makeMockClient({
      runCommand: vi.fn().mockResolvedValue({
        exitCode: 0,
        stdout: "",
        stderr: "",
        durationMs: 5,
      }),
    });
    const bundle = parseBundle({
      apiVersion: "signalman.dev/v1alpha1",
      kind: "Bundle",
      metadata: { name: "cargo" },
      packages: [
        {
          id: "j",
          source: "cargo",
          crate_id: "just",
          version: "1.30.0",
        },
      ],
    });
    const result = await installBundle(
      backend,
      client as unknown as GuestAgentClient,
      "vm",
      bundle,
    );
    expect(result.installed).toBe(1);
    const call = (client.runCommand as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toBe("cargo");
    expect(call[1]).toEqual(["install", "just", "--version", "1.30.0"]);
  });

  it("custom_script routes through runCommand powershell with hash check", async () => {
    const backend = makeMockBackend();
    const client = makeMockClient({
      runCommand: vi.fn().mockResolvedValue({
        exitCode: 0,
        stdout: "",
        stderr: "",
        durationMs: 5,
      }),
    });
    const bundle = parseBundle({
      apiVersion: "signalman.dev/v1alpha1",
      kind: "Bundle",
      metadata: { name: "cs" },
      packages: [
        {
          id: "boot",
          source: "custom_script",
          url: "https://example.com/bootstrap.ps1",
          sha256: "b".repeat(64),
          interpreter: "pwsh",
          args: ["-Force"],
        },
      ],
    });
    const result = await installBundle(
      backend,
      client as unknown as GuestAgentClient,
      "vm",
      bundle,
    );
    expect(result.installed).toBe(1);
    const call = (client.runCommand as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toBe("powershell");
    // The PowerShell script-block must reference Get-FileHash, the
    // operator-supplied URL, and the operator-supplied hash.
    const script = (call[1] as string[])[3];
    expect(script).toContain("Get-FileHash");
    expect(script).toContain("Invoke-WebRequest");
    expect(script).toContain("https://example.com/bootstrap.ps1");
    expect(script).toContain("b".repeat(64));
  });
});
