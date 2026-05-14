/**
 * v0.3.0-6 sub-task 2 — `signalman runner deploy-k8s` verb tests.
 *
 * Exercises the apply-then-wait orchestration in
 * `runner/deploy-k8s.ts` via injected `KubectlDriver` exec stubs.
 * No real kubectl, no real cluster, no real control-plane HTTP.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runRunnerDeployK8s } from "../runner/deploy-k8s.js";
import { K8sDriverError } from "../k8s/index.js";
import type { K8sExec, K8sExecResult } from "../k8s/index.js";

function ok(stdout: string, stderr = ""): K8sExecResult {
  return { stdout, stderr, exitCode: 0 };
}

function fail(exitCode: number, stderr: string, stdout = ""): K8sExecResult {
  return { stdout, stderr, exitCode };
}

let tmp: string;
let manifest: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sig-rdk8s-"));
  manifest = path.join(tmp, "job.yaml");
  fs.writeFileSync(manifest, "kind: Job\napiVersion: batch/v1\n");
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ── Happy path ────────────────────────────────────────────────────

describe("runRunnerDeployK8s — happy path", () => {
  it("runs kubectl apply then kubectl wait and reports ready=true", async () => {
    const exec = vi
      .fn<K8sExec>()
      .mockResolvedValueOnce(ok("job.batch/signalman-runner created\n"))
      .mockResolvedValueOnce(ok("pod/signalman-runner-x condition met\n"));
    const result = await runRunnerDeployK8s({
      manifestPath: manifest,
      namespace: "signalman-runners",
      driverOptions: { exec },
    });
    expect(result.ready).toBe(true);
    expect(result.health?.ready).toBe(true);
    expect(exec).toHaveBeenCalledTimes(2);
    // First call is the apply. Argv order: ["apply", "--namespace",
    // <ns>, "-f", <manifest>] because the manifest is a single file.
    const applyArgs = exec.mock.calls[0][1];
    expect(applyArgs[0]).toBe("apply");
    expect(applyArgs).toContain("--namespace");
    expect(applyArgs).toContain("signalman-runners");
    expect(applyArgs).toContain("-f");
    expect(applyArgs).toContain(manifest);
    // Second call is the wait. Should carry the default selector.
    const waitArgs = exec.mock.calls[1][1];
    expect(waitArgs[0]).toBe("wait");
    expect(waitArgs).toContain("-l");
    expect(waitArgs).toContain("app.kubernetes.io/name=signalman-runner");
  });

  it("forwards a custom selector to the wait phase", async () => {
    const exec = vi
      .fn<K8sExec>()
      .mockResolvedValueOnce(ok(""))
      .mockResolvedValueOnce(ok("condition met\n"));
    await runRunnerDeployK8s({
      manifestPath: manifest,
      namespace: "ns",
      selector: "signalman.dev/lifecycle=oneshot",
      driverOptions: { exec },
    });
    const waitArgs = exec.mock.calls[1][1];
    expect(waitArgs).toContain("signalman.dev/lifecycle=oneshot");
  });

  it("forwards --context to both subprocess calls when set", async () => {
    const exec = vi
      .fn<K8sExec>()
      .mockResolvedValue(ok(""));
    await runRunnerDeployK8s({
      manifestPath: manifest,
      namespace: "ns",
      context: "prod-cluster",
      driverOptions: { exec },
    });
    for (const call of exec.mock.calls) {
      const args = call[1];
      expect(args).toContain("--context");
      expect(args).toContain("prod-cluster");
    }
  });

  it("skips the wait phase when waitForReady=false", async () => {
    const exec = vi.fn<K8sExec>().mockResolvedValueOnce(ok(""));
    const result = await runRunnerDeployK8s({
      manifestPath: manifest,
      namespace: "ns",
      waitForReady: false,
      driverOptions: { exec },
    });
    expect(result.health).toBeNull();
    expect(result.ready).toBe(true);
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it("forwards waitTimeoutMs to kubectl wait --timeout", async () => {
    const exec = vi
      .fn<K8sExec>()
      .mockResolvedValueOnce(ok(""))
      .mockResolvedValueOnce(ok(""));
    await runRunnerDeployK8s({
      manifestPath: manifest,
      namespace: "ns",
      waitTimeoutMs: 30_000,
      driverOptions: { exec },
    });
    const waitArgs = exec.mock.calls[1][1];
    expect(waitArgs).toContain("--timeout=30s");
  });
});

// ── Failure paths ─────────────────────────────────────────────────

describe("runRunnerDeployK8s — failure paths", () => {
  it("rejects with bundle_path_missing when the manifest is absent", async () => {
    const exec = vi.fn<K8sExec>();
    try {
      await runRunnerDeployK8s({
        manifestPath: path.join(tmp, "missing.yaml"),
        namespace: "ns",
        driverOptions: { exec },
      });
      throw new Error("expected throw");
    } catch (err) {
      const e = err as { code?: string };
      expect(e.code).toBe("bundle_path_missing");
    }
    expect(exec).not.toHaveBeenCalled();
  });

  it("rethrows kubectl_failed from the apply step", async () => {
    const exec = vi
      .fn<K8sExec>()
      .mockResolvedValueOnce(fail(1, "error: invalid yaml: line 12"));
    await expect(
      runRunnerDeployK8s({
        manifestPath: manifest,
        namespace: "ns",
        driverOptions: { exec },
      }),
    ).rejects.toBeInstanceOf(K8sDriverError);
    // wait phase must not run if apply failed
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it("rethrows cluster_auth_failed when the API rejects auth", async () => {
    const exec = vi
      .fn<K8sExec>()
      .mockResolvedValueOnce(fail(1, "error: You must be logged in to the server (Unauthorized)"));
    await expect(
      runRunnerDeployK8s({
        manifestPath: manifest,
        namespace: "ns",
        driverOptions: { exec },
      }),
    ).rejects.toMatchObject({ code: "cluster_auth_failed" });
  });

  it("rethrows namespace_missing for a missing namespace", async () => {
    const exec = vi
      .fn<K8sExec>()
      .mockResolvedValueOnce(
        fail(1, 'Error from server (NotFound): namespaces "absent" not found'),
      );
    await expect(
      runRunnerDeployK8s({
        manifestPath: manifest,
        namespace: "absent",
        driverOptions: { exec },
      }),
    ).rejects.toMatchObject({ code: "namespace_missing" });
  });

  it("returns ready=false when kubectl wait times out (non-classifiable exit 1)", async () => {
    const exec = vi
      .fn<K8sExec>()
      .mockResolvedValueOnce(ok("job.batch/signalman-runner created\n"))
      .mockResolvedValueOnce(
        fail(1, "error: timed out waiting for the condition on pods/foo"),
      );
    const result = await runRunnerDeployK8s({
      manifestPath: manifest,
      namespace: "ns",
      waitTimeoutMs: 1_000,
      driverOptions: { exec },
    });
    expect(result.ready).toBe(false);
    expect(result.health?.ready).toBe(false);
    expect(result.health?.detail).toContain("timed out");
  });

  it("surfaces kubectl_not_found when the binary is missing", async () => {
    const exec = vi.fn<K8sExec>().mockRejectedValueOnce(
      Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }),
    );
    await expect(
      runRunnerDeployK8s({
        manifestPath: manifest,
        namespace: "ns",
        driverOptions: { exec },
      }),
    ).rejects.toMatchObject({ code: "kubectl_not_found" });
  });
});

// ── Output sink ───────────────────────────────────────────────────

describe("runRunnerDeployK8s — output sink", () => {
  it("writes progress to the provided sink (not stderr)", async () => {
    const chunks: string[] = [];
    const sink = {
      write(s: string) {
        chunks.push(s);
        return true;
      },
    };
    const exec = vi
      .fn<K8sExec>()
      .mockResolvedValueOnce(ok(""))
      .mockResolvedValueOnce(ok(""));
    await runRunnerDeployK8s({
      manifestPath: manifest,
      namespace: "ns",
      driverOptions: { exec },
      out: sink as unknown as NodeJS.WritableStream,
    });
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks.join("")).toContain("applying");
    expect(chunks.join("")).toContain("Ready");
  });
});
