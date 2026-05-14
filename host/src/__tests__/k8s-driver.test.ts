/**
 * v0.3.0-6 sub-task 1 — k8s driver type + bundle-detect unit tests.
 *
 * Pins the K8sDriverError code-dispatch shape and the bundle-kind
 * autodetection rules that both KubectlDriver and HelmDriver depend
 * on. Tests in this file are pure — no subprocess + no real
 * Kubernetes cluster.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  detectBundleKind,
  hasKustomization,
  HELM_CHART_FILE,
  K8sDriverError,
  type K8sDriverErrorCode,
} from "../k8s/index.js";

// ── K8sDriverError code-dispatch contract ──────────────────────────

describe("K8sDriverError", () => {
  it("carries a stable code, message, and optional cause", () => {
    const cause = new Error("underlying");
    const err = new K8sDriverError(
      "kubectl_failed",
      "exit 1: forbidden",
      cause,
    );
    expect(err.name).toBe("K8sDriverError");
    expect(err.code).toBe("kubectl_failed");
    expect(err.message).toContain("forbidden");
    expect(err.cause).toBe(cause);
    expect(err instanceof Error).toBe(true);
  });

  it("supports every documented stable code without typecast tricks", () => {
    const codes: K8sDriverErrorCode[] = [
      "kubectl_failed",
      "kubectl_not_found",
      "helm_failed",
      "helm_not_found",
      "bundle_path_missing",
      "cluster_auth_failed",
      "namespace_missing",
    ];
    for (const code of codes) {
      const err = new K8sDriverError(code, `msg for ${code}`);
      expect(err.code).toBe(code);
    }
  });

  it("allows callers to dispatch by code in a switch", () => {
    const err = new K8sDriverError("cluster_auth_failed", "401 unauthorized");
    let dispatched = "unhandled";
    switch (err.code) {
      case "cluster_auth_failed":
        dispatched = "auth";
        break;
      case "kubectl_failed":
      case "helm_failed":
      case "kubectl_not_found":
      case "helm_not_found":
      case "bundle_path_missing":
      case "namespace_missing":
        dispatched = "other";
        break;
    }
    expect(dispatched).toBe("auth");
  });
});

// ── bundle-kind detection ──────────────────────────────────────────

describe("detectBundleKind", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sig-k8s-bundle-"));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("returns 'manifest' for a single yaml file", () => {
    const f = path.join(tmp, "deployment.yaml");
    fs.writeFileSync(f, "kind: Deployment\n");
    expect(detectBundleKind(f)).toBe("manifest");
  });

  it("returns 'helm_chart' when Chart.yaml is at the bundle root", () => {
    fs.writeFileSync(path.join(tmp, HELM_CHART_FILE), "apiVersion: v2\n");
    fs.writeFileSync(path.join(tmp, "values.yaml"), "{}\n");
    expect(detectBundleKind(tmp)).toBe("helm_chart");
  });

  it("returns 'manifest' for a directory without Chart.yaml", () => {
    fs.writeFileSync(path.join(tmp, "deployment.yaml"), "kind: Deployment\n");
    fs.writeFileSync(path.join(tmp, "service.yaml"), "kind: Service\n");
    expect(detectBundleKind(tmp)).toBe("manifest");
  });

  it("throws bundle_path_missing for a path that doesn't exist", () => {
    const missing = path.join(tmp, "does-not-exist");
    try {
      detectBundleKind(missing);
      throw new Error("expected throw");
    } catch (err) {
      const e = err as K8sDriverError;
      expect(e).toBeInstanceOf(K8sDriverError);
      expect(e.code).toBe("bundle_path_missing");
      expect(e.message).toContain(missing);
    }
  });

  it("treats Chart.yaml as helm_chart only when it's at the bundle root", () => {
    // A chart nested one level deep is NOT auto-detected; operator
    // should point at the chart dir directly. Documented behaviour
    // so the kubectl path stays predictable for kustomize trees.
    fs.mkdirSync(path.join(tmp, "subdir"));
    fs.writeFileSync(
      path.join(tmp, "subdir", HELM_CHART_FILE),
      "apiVersion: v2\n",
    );
    expect(detectBundleKind(tmp)).toBe("manifest");
  });

  it("returns helm_chart even when other yaml files coexist", () => {
    fs.writeFileSync(path.join(tmp, HELM_CHART_FILE), "apiVersion: v2\n");
    fs.writeFileSync(path.join(tmp, "values.yaml"), "{}\n");
    fs.writeFileSync(path.join(tmp, "kustomization.yaml"), "kind: Kustomization\n");
    expect(detectBundleKind(tmp)).toBe("helm_chart");
  });
});

describe("hasKustomization", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sig-k8s-kust-"));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("detects kustomization.yaml at the root", () => {
    fs.writeFileSync(path.join(tmp, "kustomization.yaml"), "kind: Kustomization\n");
    expect(hasKustomization(tmp)).toBe(true);
  });

  it("detects kustomization.yml (alternate extension) at the root", () => {
    fs.writeFileSync(path.join(tmp, "kustomization.yml"), "kind: Kustomization\n");
    expect(hasKustomization(tmp)).toBe(true);
  });

  it("returns false for a plain directory of manifests", () => {
    fs.writeFileSync(path.join(tmp, "deployment.yaml"), "kind: Deployment\n");
    expect(hasKustomization(tmp)).toBe(false);
  });

  it("returns false for a single-file bundle (kustomization makes no sense)", () => {
    const f = path.join(tmp, "deployment.yaml");
    fs.writeFileSync(f, "kind: Deployment\n");
    expect(hasKustomization(f)).toBe(false);
  });

  it("returns false for a path that doesn't exist", () => {
    expect(hasKustomization(path.join(tmp, "nope"))).toBe(false);
  });
});
