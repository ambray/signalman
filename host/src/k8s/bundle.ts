/**
 * Bundle-kind autodetect (v0.3.0-6 sub-task 1).
 *
 * The K8s deploy driver dispatches between `HelmDriver` and
 * `KubectlDriver` based on the bundle's shape. The rules are:
 *
 *   1. If `bundleUri` is a file: always `manifest` (kubectl apply -f).
 *   2. If `bundleUri` is a directory containing `Chart.yaml` at its
 *      root: `helm_chart`.
 *   3. Otherwise: `manifest` (kubectl apply -k for a directory).
 *
 * Kept as a tiny, pure module so both drivers and the executor can
 * call it without circular imports.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { K8sDriverError, type K8sBundleKind } from "./types.js";

/** Filename that signals a Helm chart at the root of a bundle. */
export const HELM_CHART_FILE = "Chart.yaml";

/**
 * Return `helm_chart` when `bundleUri` is a directory with a
 * `Chart.yaml` inside, otherwise `manifest`. Throws
 * `K8sDriverError("bundle_path_missing", ...)` when the path does
 * not exist so callers fail fast before spawning kubectl/helm.
 */
export function detectBundleKind(bundleUri: string): K8sBundleKind {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(bundleUri);
  } catch (err) {
    throw new K8sDriverError(
      "bundle_path_missing",
      `bundle path does not exist: ${bundleUri}`,
      err,
    );
  }
  if (stat.isFile()) return "manifest";
  if (stat.isDirectory()) {
    const chart = path.join(bundleUri, HELM_CHART_FILE);
    if (fs.existsSync(chart) && fs.statSync(chart).isFile()) {
      return "helm_chart";
    }
    return "manifest";
  }
  throw new K8sDriverError(
    "bundle_path_missing",
    `bundle path is neither a file nor a directory: ${bundleUri}`,
  );
}

/**
 * Return true if `bundleUri` (after validation) is a directory that
 * contains a `kustomization.yaml` / `kustomization.yml` at its root.
 * Used by `KubectlDriver` to decide between `kubectl apply -k` and
 * `kubectl apply -f`. Plain directories without a kustomization
 * still work via `-f <dir>` (kubectl applies every yaml inside).
 */
export function hasKustomization(bundleUri: string): boolean {
  if (!fs.existsSync(bundleUri)) return false;
  if (!fs.statSync(bundleUri).isDirectory()) return false;
  return (
    fs.existsSync(path.join(bundleUri, "kustomization.yaml")) ||
    fs.existsSync(path.join(bundleUri, "kustomization.yml"))
  );
}
