/**
 * v0.3.0-6 sub-task 1 — KubectlDriver unit + integration tests.
 *
 * Two layers:
 *   - Pure helpers (argv composition, JSON parsing, stderr
 *     classification) tested directly without spawning kubectl.
 *   - Driver lifecycle (apply/rollback/status/health) tested via an
 *     injected exec stub that returns canned `{stdout, stderr,
 *     exitCode}` so we exercise the dispatch + error mapping
 *     without standing up a real cluster.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  KubectlDriver,
  K8sDriverError,
  buildApplyArgs,
  buildRollbackArgs,
  buildStatusArgs,
  buildHealthArgs,
  parseDeploymentsJson,
  classifyStderr,
} from "../k8s/index.js";
import type { K8sExec, K8sExecResult } from "../k8s/index.js";

// ── Helpers ────────────────────────────────────────────────────────

function ok(stdout: string, stderr = ""): K8sExecResult {
  return { stdout, stderr, exitCode: 0 };
}

function fail(exitCode: number, stderr: string, stdout = ""): K8sExecResult {
  return { stdout, stderr, exitCode };
}

function makeBundle(tmp: string, kind: "kustomize" | "plain" | "single"): string {
  if (kind === "single") {
    const file = path.join(tmp, "deployment.yaml");
    fs.writeFileSync(file, "kind: Deployment\n");
    return file;
  }
  const dir = path.join(tmp, `bundle-${kind}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "deployment.yaml"), "kind: Deployment\n");
  if (kind === "kustomize") {
    fs.writeFileSync(
      path.join(dir, "kustomization.yaml"),
      "resources:\n  - deployment.yaml\n",
    );
  }
  return dir;
}

// ── Pure helpers: argv composition ─────────────────────────────────

describe("buildApplyArgs", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sig-k8s-apply-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("uses -k for a directory with kustomization.yaml", () => {
    const bundle = makeBundle(tmp, "kustomize");
    expect(
      buildApplyArgs({ bundleUri: bundle, namespace: "ns-a" }),
    ).toEqual(["apply", "--namespace", "ns-a", "-k", bundle]);
  });

  it("uses -f for a directory without kustomization.yaml", () => {
    const bundle = makeBundle(tmp, "plain");
    expect(
      buildApplyArgs({ bundleUri: bundle, namespace: "ns-a" }),
    ).toEqual(["apply", "--namespace", "ns-a", "-f", bundle]);
  });

  it("uses -f for a single-file bundle", () => {
    const bundle = makeBundle(tmp, "single");
    expect(
      buildApplyArgs({ bundleUri: bundle, namespace: "ns-a" }),
    ).toEqual(["apply", "--namespace", "ns-a", "-f", bundle]);
  });

  it("injects --context before --namespace when context is set", () => {
    const bundle = makeBundle(tmp, "kustomize");
    const args = buildApplyArgs({
      bundleUri: bundle,
      namespace: "ns-a",
      context: "prod-cluster",
    });
    expect(args).toEqual([
      "apply",
      "--context",
      "prod-cluster",
      "--namespace",
      "ns-a",
      "-k",
      bundle,
    ]);
  });
});

describe("buildRollbackArgs", () => {
  it("composes a no-revision rollout undo", () => {
    expect(
      buildRollbackArgs({ releaseId: "deployment/my-app", namespace: "ns" }),
    ).toEqual([
      "rollout",
      "undo",
      "--namespace",
      "ns",
      "deployment/my-app",
    ]);
  });

  it("forwards --to-revision when provided", () => {
    expect(
      buildRollbackArgs({
        releaseId: "deployment/my-app",
        namespace: "ns",
        toRevision: 3,
      }),
    ).toEqual([
      "rollout",
      "undo",
      "--namespace",
      "ns",
      "deployment/my-app",
      "--to-revision=3",
    ]);
  });

  it("injects --context when provided", () => {
    expect(
      buildRollbackArgs({
        releaseId: "deployment/my-app",
        namespace: "ns",
        context: "ctx",
      }),
    ).toEqual([
      "rollout",
      "undo",
      "--context",
      "ctx",
      "--namespace",
      "ns",
      "deployment/my-app",
    ]);
  });
});

describe("buildStatusArgs", () => {
  it("composes a basic deployments list with json output", () => {
    expect(buildStatusArgs({ namespace: "ns" })).toEqual([
      "get",
      "deployments",
      "--namespace",
      "ns",
      "-o",
      "json",
    ]);
  });

  it("forwards a selector via -l", () => {
    expect(
      buildStatusArgs({ namespace: "ns", selector: "app=foo" }),
    ).toEqual([
      "get",
      "deployments",
      "--namespace",
      "ns",
      "-l",
      "app=foo",
      "-o",
      "json",
    ]);
  });
});

describe("buildHealthArgs", () => {
  it("waits on --all when no selector is given and rounds the timeout up", () => {
    expect(
      buildHealthArgs({ namespace: "ns", waitMs: 30_500 }),
    ).toEqual([
      "wait",
      "--for=condition=Ready",
      "pod",
      "--namespace",
      "ns",
      "--all",
      "--timeout=31s",
    ]);
  });

  it("substitutes -l when a selector is provided", () => {
    expect(
      buildHealthArgs({ namespace: "ns", waitMs: 60_000, selector: "app=foo" }),
    ).toEqual([
      "wait",
      "--for=condition=Ready",
      "pod",
      "--namespace",
      "ns",
      "-l",
      "app=foo",
      "--timeout=60s",
    ]);
  });

  it("clamps to at least 1 second when timeout is sub-second", () => {
    const args = buildHealthArgs({ namespace: "ns", waitMs: 50 });
    expect(args).toContain("--timeout=1s");
  });
});

// ── Pure helpers: JSON parsing + stderr classification ─────────────

describe("parseDeploymentsJson", () => {
  it("returns [] for empty stdout", () => {
    expect(parseDeploymentsJson("")).toEqual([]);
  });

  it("returns [] for invalid JSON", () => {
    expect(parseDeploymentsJson("not json")).toEqual([]);
  });

  it("returns [] when items isn't an array", () => {
    expect(parseDeploymentsJson(JSON.stringify({ items: "nope" }))).toEqual([]);
  });

  it("derives healthy when readyReplicas matches replicas", () => {
    const json = JSON.stringify({
      items: [
        {
          kind: "Deployment",
          metadata: { name: "foo" },
          status: {
            replicas: 3,
            readyReplicas: 3,
            availableReplicas: 3,
          },
        },
      ],
    });
    const result = parseDeploymentsJson(json);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      name: "foo",
      kind: "Deployment",
      replicas: 3,
      readyReplicas: 3,
      availableReplicas: 3,
      state: "healthy",
    });
  });

  it("derives degraded when readyReplicas < replicas", () => {
    const json = JSON.stringify({
      items: [
        {
          kind: "Deployment",
          metadata: { name: "foo" },
          status: { replicas: 3, readyReplicas: 1, availableReplicas: 1 },
        },
      ],
    });
    expect(parseDeploymentsJson(json)[0].state).toBe("degraded");
  });

  it("derives unknown when replicas is 0", () => {
    const json = JSON.stringify({
      items: [
        {
          kind: "Deployment",
          metadata: { name: "foo" },
          status: { replicas: 0, readyReplicas: 0, availableReplicas: 0 },
        },
      ],
    });
    expect(parseDeploymentsJson(json)[0].state).toBe("unknown");
  });

  it("tolerates missing replica fields by treating them as zero", () => {
    const json = JSON.stringify({
      items: [
        {
          kind: "Deployment",
          metadata: { name: "foo" },
          status: {},
        },
      ],
    });
    const result = parseDeploymentsJson(json);
    expect(result[0]).toMatchObject({
      replicas: 0,
      readyReplicas: 0,
      availableReplicas: 0,
      state: "unknown",
    });
  });

  it("preserves an empty items array as an empty result", () => {
    expect(parseDeploymentsJson(JSON.stringify({ items: [] }))).toEqual([]);
  });

  it("ignores non-object items rather than crashing", () => {
    const json = JSON.stringify({ items: [null, 42, "string"] });
    expect(parseDeploymentsJson(json)).toEqual([]);
  });
});

describe("classifyStderr", () => {
  it("maps Unauthorized to cluster_auth_failed", () => {
    expect(classifyStderr("Error: Unauthorized")).toBe("cluster_auth_failed");
  });

  it("maps Forbidden to cluster_auth_failed", () => {
    expect(classifyStderr("Forbidden: pods is forbidden")).toBe(
      "cluster_auth_failed",
    );
  });

  it("maps unable-to-load-credentials to cluster_auth_failed", () => {
    expect(
      classifyStderr("unable to load credentials from kubeconfig"),
    ).toBe("cluster_auth_failed");
  });

  it("maps missing-namespace text to namespace_missing", () => {
    expect(
      classifyStderr('Error from server (NotFound): namespaces "ns-x" not found'),
    ).toBe("namespace_missing");
  });

  it("returns null for unrelated kubectl errors", () => {
    expect(
      classifyStderr("connection refused: localhost:8443"),
    ).toBeNull();
  });

  it("returns null for empty stderr", () => {
    expect(classifyStderr("")).toBeNull();
  });
});

// ── Driver lifecycle (via injected exec) ───────────────────────────

describe("KubectlDriver.apply", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sig-k8s-apply-driver-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("runs kubectl apply -k and surfaces a stdout tail", async () => {
    const bundle = makeBundle(tmp, "kustomize");
    const exec = vi.fn<K8sExec>().mockResolvedValue(
      ok("deployment.apps/foo configured\nservice/foo unchanged\n"),
    );
    const driver = new KubectlDriver({ exec });
    const result = await driver.apply({
      bundleUri: bundle,
      namespace: "ns-a",
      releaseName: "my-release",
    });
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec.mock.calls[0][1]).toEqual(
      buildApplyArgs({ bundleUri: bundle, namespace: "ns-a" }),
    );
    expect(result.driver).toBe("kubectl");
    expect(result.bundleKind).toBe("manifest");
    expect(result.releaseName).toBe("my-release");
    expect(result.stdoutTail).toContain("configured");
  });

  it("refuses to apply a helm-chart bundle and points at the helm driver", async () => {
    const dir = path.join(tmp, "chart");
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "Chart.yaml"), "apiVersion: v2\n");
    const exec = vi.fn<K8sExec>();
    const driver = new KubectlDriver({ exec });
    await expect(
      driver.apply({ bundleUri: dir, namespace: "ns" }),
    ).rejects.toMatchObject({
      name: "K8sDriverError",
      code: "kubectl_failed",
      message: expect.stringContaining("HelmDriver"),
    });
    expect(exec).not.toHaveBeenCalled();
  });

  it("surfaces ENOENT as kubectl_not_found", async () => {
    const bundle = makeBundle(tmp, "plain");
    const exec = vi.fn<K8sExec>().mockRejectedValue(
      Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }),
    );
    const driver = new KubectlDriver({ exec });
    await expect(
      driver.apply({ bundleUri: bundle, namespace: "ns" }),
    ).rejects.toMatchObject({
      code: "kubectl_not_found",
    });
  });

  it("classifies 403 Forbidden as cluster_auth_failed on non-zero exit", async () => {
    const bundle = makeBundle(tmp, "plain");
    const exec = vi.fn<K8sExec>().mockResolvedValue(
      fail(1, 'Error from server (Forbidden): pods is forbidden\n'),
    );
    const driver = new KubectlDriver({ exec });
    await expect(
      driver.apply({ bundleUri: bundle, namespace: "ns" }),
    ).rejects.toMatchObject({
      code: "cluster_auth_failed",
    });
  });

  it("classifies a missing-namespace error as namespace_missing", async () => {
    const bundle = makeBundle(tmp, "plain");
    const exec = vi.fn<K8sExec>().mockResolvedValue(
      fail(1, 'Error from server (NotFound): namespaces "ns-x" not found\n'),
    );
    const driver = new KubectlDriver({ exec });
    await expect(
      driver.apply({ bundleUri: bundle, namespace: "ns-x" }),
    ).rejects.toMatchObject({
      code: "namespace_missing",
    });
  });

  it("surfaces a generic non-zero exit as kubectl_failed", async () => {
    const bundle = makeBundle(tmp, "plain");
    const exec = vi.fn<K8sExec>().mockResolvedValue(
      fail(1, "unable to recognize: invalid YAML"),
    );
    const driver = new KubectlDriver({ exec });
    await expect(
      driver.apply({ bundleUri: bundle, namespace: "ns" }),
    ).rejects.toMatchObject({
      code: "kubectl_failed",
    });
  });

  it("rejects with bundle_path_missing when the bundle doesn't exist", async () => {
    const exec = vi.fn<K8sExec>();
    const driver = new KubectlDriver({ exec });
    await expect(
      driver.apply({
        bundleUri: path.join(tmp, "no-such-thing"),
        namespace: "ns",
      }),
    ).rejects.toMatchObject({ code: "bundle_path_missing" });
    expect(exec).not.toHaveBeenCalled();
  });

  it("derives release name from bundle basename when not supplied", async () => {
    const bundle = makeBundle(tmp, "kustomize");
    const exec = vi.fn<K8sExec>().mockResolvedValue(ok(""));
    const driver = new KubectlDriver({ exec });
    const result = await driver.apply({ bundleUri: bundle, namespace: "ns" });
    expect(result.releaseName).toBe(path.basename(bundle));
  });
});

describe("KubectlDriver.rollback", () => {
  it("issues rollout undo and echoes the revision", async () => {
    const exec = vi
      .fn<K8sExec>()
      .mockResolvedValue(ok("deployment.apps/foo rolled back\n"));
    const driver = new KubectlDriver({ exec });
    const result = await driver.rollback({
      releaseId: "deployment/foo",
      namespace: "ns",
      toRevision: 2,
    });
    expect(result.toRevision).toBe(2);
    expect(exec.mock.calls[0][1]).toEqual(
      buildRollbackArgs({
        releaseId: "deployment/foo",
        namespace: "ns",
        toRevision: 2,
      }),
    );
  });

  it("surfaces ENOENT as kubectl_not_found", async () => {
    const exec = vi.fn<K8sExec>().mockRejectedValue(
      Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }),
    );
    const driver = new KubectlDriver({ exec });
    await expect(
      driver.rollback({ releaseId: "deployment/foo", namespace: "ns" }),
    ).rejects.toMatchObject({ code: "kubectl_not_found" });
  });
});

describe("KubectlDriver.status", () => {
  it("parses the canned JSON into normalised workload statuses", async () => {
    const json = JSON.stringify({
      items: [
        {
          kind: "Deployment",
          metadata: { name: "api" },
          status: { replicas: 2, readyReplicas: 2, availableReplicas: 2 },
        },
        {
          kind: "Deployment",
          metadata: { name: "worker" },
          status: { replicas: 3, readyReplicas: 1, availableReplicas: 1 },
        },
      ],
    });
    const exec = vi.fn<K8sExec>().mockResolvedValue(ok(json));
    const driver = new KubectlDriver({ exec });
    const result = await driver.status({ namespace: "ns" });
    expect(result.workloads).toHaveLength(2);
    expect(result.workloads[0].state).toBe("healthy");
    expect(result.workloads[1].state).toBe("degraded");
    expect(result.allHealthy).toBe(false);
  });

  it("reports allHealthy=true when every workload is healthy", async () => {
    const json = JSON.stringify({
      items: [
        {
          kind: "Deployment",
          metadata: { name: "api" },
          status: { replicas: 1, readyReplicas: 1, availableReplicas: 1 },
        },
      ],
    });
    const exec = vi.fn<K8sExec>().mockResolvedValue(ok(json));
    const driver = new KubectlDriver({ exec });
    const result = await driver.status({ namespace: "ns" });
    expect(result.allHealthy).toBe(true);
  });

  it("reports allHealthy=false on an empty namespace", async () => {
    const exec = vi.fn<K8sExec>().mockResolvedValue(ok(JSON.stringify({ items: [] })));
    const driver = new KubectlDriver({ exec });
    const result = await driver.status({ namespace: "ns" });
    expect(result.allHealthy).toBe(false);
    expect(result.workloads).toHaveLength(0);
  });
});

describe("KubectlDriver.health", () => {
  it("returns ready=true on exit 0", async () => {
    const exec = vi
      .fn<K8sExec>()
      .mockResolvedValue(ok("pod/foo condition met\n"));
    const driver = new KubectlDriver({ exec });
    const result = await driver.health({
      namespace: "ns",
      timeoutMs: 1_000,
    });
    expect(result.ready).toBe(true);
    expect(result.detail).toBeNull();
  });

  it("returns ready=false with a detail tail on timeout (non-classifiable exit 1)", async () => {
    const exec = vi.fn<K8sExec>().mockResolvedValue(
      fail(1, 'error: timed out waiting for the condition on pods/foo'),
    );
    const driver = new KubectlDriver({ exec });
    const result = await driver.health({
      namespace: "ns",
      timeoutMs: 1_000,
    });
    expect(result.ready).toBe(false);
    expect(result.detail).toContain("timed out");
  });

  it("rethrows cluster_auth_failed when the wait command hits auth issues", async () => {
    const exec = vi.fn<K8sExec>().mockResolvedValue(
      fail(1, "error: You must be logged in to the server (Unauthorized)"),
    );
    const driver = new KubectlDriver({ exec });
    await expect(
      driver.health({ namespace: "ns", timeoutMs: 1_000 }),
    ).rejects.toBeInstanceOf(K8sDriverError);
  });

  it("surfaces ENOENT as kubectl_not_found from health()", async () => {
    const exec = vi.fn<K8sExec>().mockRejectedValue(
      Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }),
    );
    const driver = new KubectlDriver({ exec });
    await expect(
      driver.health({ namespace: "ns", timeoutMs: 1_000 }),
    ).rejects.toMatchObject({ code: "kubectl_not_found" });
  });
});
