/**
 * v0.3.0-6 sub-task 1 — HelmDriver unit + integration tests.
 *
 * Mirrors the kubectl test layout: pure argv composition + JSON
 * parsing tested directly, then full apply/rollback/status
 * lifecycle through an injected exec stub.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  HelmDriver,
  K8sDriverError,
  buildHelmApplyArgs,
  buildHelmRollbackArgs,
  buildHelmStatusArgs,
  parseHelmStatusJson,
} from "../k8s/index.js";
import type { K8sExec, K8sExecResult } from "../k8s/index.js";

function ok(stdout: string, stderr = ""): K8sExecResult {
  return { stdout, stderr, exitCode: 0 };
}

function fail(exitCode: number, stderr: string, stdout = ""): K8sExecResult {
  return { stdout, stderr, exitCode };
}

function makeChart(tmp: string, withChart = true): string {
  const dir = path.join(tmp, "my-chart");
  fs.mkdirSync(dir);
  if (withChart) {
    fs.writeFileSync(
      path.join(dir, "Chart.yaml"),
      "apiVersion: v2\nname: my-chart\nversion: 0.0.1\n",
    );
  }
  fs.writeFileSync(path.join(dir, "values.yaml"), "image: nginx\n");
  return dir;
}

// ── Pure helpers ───────────────────────────────────────────────────

describe("buildHelmApplyArgs", () => {
  it("composes upgrade --install with --create-namespace", () => {
    expect(
      buildHelmApplyArgs({
        releaseName: "my-rel",
        chartPath: "/abs/chart",
        namespace: "ns-a",
      }),
    ).toEqual([
      "upgrade",
      "--install",
      "my-rel",
      "/abs/chart",
      "--namespace",
      "ns-a",
      "--create-namespace",
    ]);
  });

  it("forwards --kube-context when provided", () => {
    expect(
      buildHelmApplyArgs({
        releaseName: "rel",
        chartPath: "/c",
        namespace: "ns",
        context: "prod",
      }),
    ).toEqual([
      "upgrade",
      "--install",
      "rel",
      "/c",
      "--kube-context",
      "prod",
      "--namespace",
      "ns",
      "--create-namespace",
    ]);
  });
});

describe("buildHelmRollbackArgs", () => {
  it("composes rollback with no revision", () => {
    expect(
      buildHelmRollbackArgs({ releaseName: "rel", namespace: "ns" }),
    ).toEqual(["rollback", "rel", "--namespace", "ns"]);
  });

  it("includes the revision as a positional arg", () => {
    expect(
      buildHelmRollbackArgs({
        releaseName: "rel",
        namespace: "ns",
        toRevision: 4,
      }),
    ).toEqual(["rollback", "rel", "4", "--namespace", "ns"]);
  });

  it("inserts --kube-context after the revision", () => {
    expect(
      buildHelmRollbackArgs({
        releaseName: "rel",
        namespace: "ns",
        toRevision: 2,
        context: "ctx",
      }),
    ).toEqual([
      "rollback",
      "rel",
      "2",
      "--kube-context",
      "ctx",
      "--namespace",
      "ns",
    ]);
  });
});

describe("buildHelmStatusArgs", () => {
  it("composes status -o json", () => {
    expect(
      buildHelmStatusArgs({ releaseName: "rel", namespace: "ns" }),
    ).toEqual(["status", "rel", "--namespace", "ns", "-o", "json"]);
  });
});

describe("parseHelmStatusJson", () => {
  it("returns null for empty stdout", () => {
    expect(parseHelmStatusJson("", "rel")).toBeNull();
  });

  it("returns null for invalid JSON", () => {
    expect(parseHelmStatusJson("nope", "rel")).toBeNull();
  });

  it("maps status=deployed to healthy", () => {
    const json = JSON.stringify({ name: "rel", info: { status: "deployed" } });
    expect(parseHelmStatusJson(json, "rel")).toMatchObject({
      name: "rel",
      kind: "HelmRelease",
      state: "healthy",
    });
  });

  it("maps pending-install / pending-upgrade to unknown", () => {
    expect(
      parseHelmStatusJson(
        JSON.stringify({ info: { status: "pending-install" } }),
        "rel",
      )?.state,
    ).toBe("unknown");
    expect(
      parseHelmStatusJson(
        JSON.stringify({ info: { status: "pending-upgrade" } }),
        "rel",
      )?.state,
    ).toBe("unknown");
  });

  it("maps failed / superseded / unknown to degraded", () => {
    for (const s of ["failed", "superseded", "weird-state"]) {
      const json = JSON.stringify({ info: { status: s } });
      expect(parseHelmStatusJson(json, "rel")?.state).toBe("degraded");
    }
  });

  it("falls back to the provided release name when JSON has no name", () => {
    const json = JSON.stringify({ info: { status: "deployed" } });
    expect(parseHelmStatusJson(json, "fallback")?.name).toBe("fallback");
  });
});

// ── Driver lifecycle ───────────────────────────────────────────────

describe("HelmDriver.apply", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sig-helm-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("runs helm upgrade --install on a chart bundle", async () => {
    const chart = makeChart(tmp);
    const exec = vi.fn<K8sExec>().mockResolvedValue(
      ok('Release "my-rel" has been upgraded. Happy Helming!\n'),
    );
    const driver = new HelmDriver({ exec });
    const result = await driver.apply({
      bundleUri: chart,
      namespace: "ns-a",
      releaseName: "my-rel",
    });
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec.mock.calls[0][1]).toEqual(
      buildHelmApplyArgs({
        releaseName: "my-rel",
        chartPath: chart,
        namespace: "ns-a",
      }),
    );
    expect(result.driver).toBe("helm");
    expect(result.bundleKind).toBe("helm_chart");
    expect(result.releaseName).toBe("my-rel");
    expect(result.stdoutTail).toContain("upgraded");
  });

  it("refuses a manifest bundle and points at kubectl", async () => {
    const dir = makeChart(tmp, /*withChart*/ false);
    const exec = vi.fn<K8sExec>();
    const driver = new HelmDriver({ exec });
    await expect(
      driver.apply({ bundleUri: dir, namespace: "ns" }),
    ).rejects.toMatchObject({
      name: "K8sDriverError",
      code: "helm_failed",
      message: expect.stringContaining("KubectlDriver"),
    });
    expect(exec).not.toHaveBeenCalled();
  });

  it("surfaces ENOENT as helm_not_found", async () => {
    const chart = makeChart(tmp);
    const exec = vi.fn<K8sExec>().mockRejectedValue(
      Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }),
    );
    const driver = new HelmDriver({ exec });
    await expect(
      driver.apply({ bundleUri: chart, namespace: "ns" }),
    ).rejects.toMatchObject({ code: "helm_not_found" });
  });

  it("classifies Unauthorized stderr as cluster_auth_failed", async () => {
    const chart = makeChart(tmp);
    const exec = vi
      .fn<K8sExec>()
      .mockResolvedValue(fail(1, "Error: Unauthorized\n"));
    const driver = new HelmDriver({ exec });
    await expect(
      driver.apply({ bundleUri: chart, namespace: "ns" }),
    ).rejects.toMatchObject({ code: "cluster_auth_failed" });
  });

  it("surfaces other non-zero exits as helm_failed", async () => {
    const chart = makeChart(tmp);
    const exec = vi
      .fn<K8sExec>()
      .mockResolvedValue(fail(1, "Error: rendered manifest is empty\n"));
    const driver = new HelmDriver({ exec });
    await expect(
      driver.apply({ bundleUri: chart, namespace: "ns" }),
    ).rejects.toMatchObject({ code: "helm_failed" });
  });

  it("rejects with bundle_path_missing when the chart path doesn't exist", async () => {
    const exec = vi.fn<K8sExec>();
    const driver = new HelmDriver({ exec });
    await expect(
      driver.apply({
        bundleUri: path.join(tmp, "no-such-chart"),
        namespace: "ns",
      }),
    ).rejects.toMatchObject({ code: "bundle_path_missing" });
    expect(exec).not.toHaveBeenCalled();
  });

  it("derives release name from chart dir basename when not supplied", async () => {
    const chart = makeChart(tmp);
    const exec = vi.fn<K8sExec>().mockResolvedValue(ok(""));
    const driver = new HelmDriver({ exec });
    const result = await driver.apply({ bundleUri: chart, namespace: "ns" });
    expect(result.releaseName).toBe(path.basename(chart));
  });
});

describe("HelmDriver.rollback", () => {
  it("issues helm rollback and surfaces the revision", async () => {
    const exec = vi
      .fn<K8sExec>()
      .mockResolvedValue(ok('Rollback was a success!\n'));
    const driver = new HelmDriver({ exec });
    const result = await driver.rollback({
      releaseId: "my-rel",
      namespace: "ns",
      toRevision: 2,
    });
    expect(result.toRevision).toBe(2);
    expect(result.driver).toBe("helm");
    expect(exec.mock.calls[0][1]).toEqual(
      buildHelmRollbackArgs({
        releaseName: "my-rel",
        namespace: "ns",
        toRevision: 2,
      }),
    );
  });

  it("propagates helm_failed on non-zero rollback", async () => {
    const exec = vi
      .fn<K8sExec>()
      .mockResolvedValue(fail(1, "Error: release: not found\n"));
    const driver = new HelmDriver({ exec });
    await expect(
      driver.rollback({ releaseId: "missing", namespace: "ns" }),
    ).rejects.toMatchObject({ code: "helm_failed" });
  });

  it("surfaces ENOENT as helm_not_found", async () => {
    const exec = vi.fn<K8sExec>().mockRejectedValue(
      Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }),
    );
    const driver = new HelmDriver({ exec });
    await expect(
      driver.rollback({ releaseId: "r", namespace: "n" }),
    ).rejects.toMatchObject({ code: "helm_not_found" });
  });
});

describe("HelmDriver.status", () => {
  it("returns allHealthy=true for a deployed release", async () => {
    const json = JSON.stringify({ name: "rel", info: { status: "deployed" } });
    const exec = vi.fn<K8sExec>().mockResolvedValue(ok(json));
    const driver = new HelmDriver({ exec });
    const result = await driver.status({ namespace: "ns", releaseName: "rel" });
    expect(result.allHealthy).toBe(true);
    expect(result.workloads).toHaveLength(1);
    expect(result.workloads[0].kind).toBe("HelmRelease");
  });

  it("returns allHealthy=false for a failed release", async () => {
    const json = JSON.stringify({ info: { status: "failed" } });
    const exec = vi.fn<K8sExec>().mockResolvedValue(ok(json));
    const driver = new HelmDriver({ exec });
    const result = await driver.status({ namespace: "ns", releaseName: "rel" });
    expect(result.allHealthy).toBe(false);
    expect(result.workloads[0].state).toBe("degraded");
  });

  it("throws when releaseName is omitted", async () => {
    const driver = new HelmDriver({ exec: vi.fn<K8sExec>() });
    await expect(driver.status({ namespace: "ns" })).rejects.toBeInstanceOf(
      K8sDriverError,
    );
  });

  it("returns an empty workload list when JSON is unparseable", async () => {
    const exec = vi.fn<K8sExec>().mockResolvedValue(ok("not json"));
    const driver = new HelmDriver({ exec });
    const result = await driver.status({ namespace: "ns", releaseName: "rel" });
    expect(result.workloads).toEqual([]);
    expect(result.allHealthy).toBe(false);
  });
});
