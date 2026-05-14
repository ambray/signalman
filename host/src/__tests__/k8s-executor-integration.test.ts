/**
 * v0.3.0-6 sub-task 1 — K8s executor integration tests.
 *
 * Exercises `runK8sDeploy` / `runK8sRollback` / `runK8sStatus`
 * (dispatch + driver composition) and the
 * `runReleaseDeploy` → `runK8sReleaseDeploy` route in the verbs
 * layer that the CLI + MCP server call.
 *
 * All subprocess calls flow through injected `K8sExec` stubs — no
 * real kubectl or cluster.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  HelmDriver,
  KubectlDriver,
  K8sDriverError,
  runK8sDeploy,
  runK8sRollback,
  runK8sStatus,
  runK8sHealth,
  type K8sDriverPair,
  type K8sExec,
} from "../k8s/index.js";
import { ControlPlane } from "../control-plane/index.js";
import { runK8sReleaseDeploy, runK8sReleaseRollback } from "../verbs/control-plane.js";

// ── Helpers ────────────────────────────────────────────────────────

function makeBundle(tmp: string, kind: "kustomize" | "plain" | "helm"): string {
  const dir = path.join(tmp, `bundle-${kind}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "deployment.yaml"), "kind: Deployment\n");
  if (kind === "kustomize") {
    fs.writeFileSync(
      path.join(dir, "kustomization.yaml"),
      "resources:\n  - deployment.yaml\n",
    );
  }
  if (kind === "helm") {
    fs.writeFileSync(
      path.join(dir, "Chart.yaml"),
      "apiVersion: v2\nname: bundle-helm\nversion: 0.0.1\n",
    );
  }
  return dir;
}

function makeDrivers(opts: {
  kubectlExec?: K8sExec;
  helmExec?: K8sExec;
}): K8sDriverPair {
  return {
    kubectl: new KubectlDriver({
      exec:
        opts.kubectlExec ??
        vi.fn<K8sExec>().mockResolvedValue({
          stdout: "",
          stderr: "",
          exitCode: 0,
        }),
    }),
    helm: new HelmDriver({
      exec:
        opts.helmExec ??
        vi.fn<K8sExec>().mockResolvedValue({
          stdout: "",
          stderr: "",
          exitCode: 0,
        }),
    }),
  };
}

async function makeControlPlane(): Promise<{
  cp: ControlPlane;
  cleanup: () => Promise<void>;
}> {
  // SQLite in-memory with the project-default migrations applied —
  // matches the shape from control-plane-bootstrap.test.ts so we
  // exercise the same config-resolution path the CLI does.
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sig-k8s-cp-"));
  const cp = ControlPlane.create({
    storage: { driver: "sqlite", url: path.join(dataDir, "signalman.db") },
    blobs: { driver: "local", root: path.join(dataDir, "blobs") },
  });
  await cp.init();
  return {
    cp,
    cleanup: async () => {
      await cp.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

// ── Direct K8s executor entry points ───────────────────────────────

describe("runK8sDeploy — bundle dispatch", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sig-k8s-exec-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("routes a Chart.yaml bundle through HelmDriver", async () => {
    const bundle = makeBundle(tmp, "helm");
    const helmExec = vi.fn<K8sExec>().mockResolvedValue({
      stdout: "Release upgraded\n",
      stderr: "",
      exitCode: 0,
    });
    const kubectlExec = vi.fn<K8sExec>().mockResolvedValue({
      stdout: "pod/foo condition met\n",
      stderr: "",
      exitCode: 0,
    });
    const drivers = makeDrivers({ helmExec, kubectlExec });

    const result = await runK8sDeploy({
      bundleUri: bundle,
      namespace: "ns",
      drivers,
    });

    expect(result.bundleKind).toBe("helm_chart");
    expect(result.apply.driver).toBe("helm");
    expect(helmExec).toHaveBeenCalled();
    expect(kubectlExec).toHaveBeenCalled(); // health probe
    expect(result.health?.ready).toBe(true);
  });

  it("routes a kustomize bundle through KubectlDriver", async () => {
    const bundle = makeBundle(tmp, "kustomize");
    const kubectlExec = vi.fn<K8sExec>().mockResolvedValue({
      stdout: "deployment.apps/foo configured\n",
      stderr: "",
      exitCode: 0,
    });
    const helmExec = vi.fn<K8sExec>();
    const drivers = makeDrivers({ kubectlExec, helmExec });

    const result = await runK8sDeploy({
      bundleUri: bundle,
      namespace: "ns",
      drivers,
    });

    expect(result.bundleKind).toBe("manifest");
    expect(result.apply.driver).toBe("kubectl");
    // First call: apply, second call: health
    expect(kubectlExec).toHaveBeenCalledTimes(2);
    expect(helmExec).not.toHaveBeenCalled();
  });

  it("skips health probe when waitForHealth=false", async () => {
    const bundle = makeBundle(tmp, "kustomize");
    const kubectlExec = vi.fn<K8sExec>().mockResolvedValue({
      stdout: "",
      stderr: "",
      exitCode: 0,
    });
    const drivers = makeDrivers({ kubectlExec });
    const result = await runK8sDeploy({
      bundleUri: bundle,
      namespace: "ns",
      waitForHealth: false,
      drivers,
    });
    expect(result.health).toBeNull();
    expect(kubectlExec).toHaveBeenCalledTimes(1);
  });

  it("propagates K8sDriverError from the apply step unchanged", async () => {
    const bundle = makeBundle(tmp, "kustomize");
    const kubectlExec = vi.fn<K8sExec>().mockResolvedValue({
      stdout: "",
      stderr: "Error: Forbidden\n",
      exitCode: 1,
    });
    const drivers = makeDrivers({ kubectlExec });
    await expect(
      runK8sDeploy({ bundleUri: bundle, namespace: "ns", drivers }),
    ).rejects.toMatchObject({ code: "cluster_auth_failed" });
  });
});

describe("runK8sRollback — driver selection", () => {
  it("dispatches to kubectl by default", async () => {
    const kubectlExec = vi.fn<K8sExec>().mockResolvedValue({
      stdout: "rolled back\n",
      stderr: "",
      exitCode: 0,
    });
    const helmExec = vi.fn<K8sExec>();
    const drivers = makeDrivers({ kubectlExec, helmExec });
    const result = await runK8sRollback({
      releaseId: "deployment/foo",
      namespace: "ns",
      drivers,
    });
    expect(result.driver).toBe("kubectl");
    expect(kubectlExec).toHaveBeenCalled();
    expect(helmExec).not.toHaveBeenCalled();
  });

  it("dispatches to helm when driver='helm'", async () => {
    const kubectlExec = vi.fn<K8sExec>();
    const helmExec = vi.fn<K8sExec>().mockResolvedValue({
      stdout: "Rollback was a success!\n",
      stderr: "",
      exitCode: 0,
    });
    const drivers = makeDrivers({ kubectlExec, helmExec });
    const result = await runK8sRollback({
      releaseId: "my-rel",
      namespace: "ns",
      driver: "helm",
      drivers,
    });
    expect(result.driver).toBe("helm");
    expect(helmExec).toHaveBeenCalled();
  });
});

describe("runK8sStatus — driver selection", () => {
  it("returns kubectl status by default", async () => {
    const json = JSON.stringify({
      items: [
        {
          kind: "Deployment",
          metadata: { name: "a" },
          status: { replicas: 1, readyReplicas: 1, availableReplicas: 1 },
        },
      ],
    });
    const kubectlExec = vi.fn<K8sExec>().mockResolvedValue({
      stdout: json,
      stderr: "",
      exitCode: 0,
    });
    const drivers = makeDrivers({ kubectlExec });
    const result = await runK8sStatus({ namespace: "ns", drivers });
    expect(result.allHealthy).toBe(true);
  });

  it("returns helm status when driver='helm' + releaseName provided", async () => {
    const helmExec = vi.fn<K8sExec>().mockResolvedValue({
      stdout: JSON.stringify({ name: "rel", info: { status: "deployed" } }),
      stderr: "",
      exitCode: 0,
    });
    const drivers = makeDrivers({ helmExec });
    const result = await runK8sStatus({
      namespace: "ns",
      driver: "helm",
      releaseName: "rel",
      drivers,
    });
    expect(result.workloads[0].kind).toBe("HelmRelease");
  });

  it("throws if driver='helm' is used without releaseName", async () => {
    const drivers = makeDrivers({});
    await expect(
      runK8sStatus({ namespace: "ns", driver: "helm", drivers }),
    ).rejects.toBeInstanceOf(K8sDriverError);
  });
});

describe("runK8sHealth", () => {
  it("delegates to KubectlDriver.health", async () => {
    const kubectlExec = vi.fn<K8sExec>().mockResolvedValue({
      stdout: "pod/foo condition met\n",
      stderr: "",
      exitCode: 0,
    });
    const drivers = makeDrivers({ kubectlExec });
    const result = await runK8sHealth({
      namespace: "ns",
      timeoutMs: 1_000,
      drivers,
    });
    expect(result.ready).toBe(true);
    expect(kubectlExec).toHaveBeenCalled();
  });
});

// ── Control-plane release-deploy adapter ───────────────────────────

describe("runK8sReleaseDeploy — control-plane adapter", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sig-k8s-cp-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("creates a Deployment row, runs k8s apply, and marks it active", async () => {
    const { cp, cleanup } = await makeControlPlane();
    try {
      const { defaultOrg } = await cp.init();
      const product = await cp.products.create({
        orgId: defaultOrg.id,
        name: "p",
        repoUrl: "https://x",
        buildYamlPath: "signalman.build.yaml",
      });
      const release = await cp.releases.create({
        orgId: defaultOrg.id,
        productId: product.id,
        tag: "v1",
        commitSha: "deadbeef",
      });
      await cp.releases.update(release.id, { status: "ready" });
      const bundle = makeBundle(tmp, "kustomize");
      const target = await cp.targets.create({
        orgId: defaultOrg.id,
        name: "k8s-ci",
        kind: "k8s_test",
        connection: { bundleUri: bundle, namespace: "ci" },
      });

      const kubectlExec = vi.fn<K8sExec>().mockResolvedValue({
        stdout: "deployment.apps/foo configured\n",
        stderr: "",
        exitCode: 0,
      });
      const drivers = makeDrivers({ kubectlExec });

      const result = await runK8sReleaseDeploy(cp, {
        orgId: defaultOrg.id,
        releaseId: release.id,
        target,
        drivers,
      });

      expect(result.deployment.status).toBe("active");
      expect(result.healthSummary.pass).toBe(1);
      expect(kubectlExec).toHaveBeenCalledTimes(2); // apply + health
      // Audit + health-check rows recorded
      const checks = await cp.healthChecks.listForDeployment(result.deployment.id);
      expect(checks.some((c) => c.probeName === "k8s_pods_ready" && c.status === "pass")).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it("marks the deployment failed when k8s health fails", async () => {
    const { cp, cleanup } = await makeControlPlane();
    try {
      const { defaultOrg } = await cp.init();
      const product = await cp.products.create({
        orgId: defaultOrg.id,
        name: "p",
        repoUrl: "https://x",
        buildYamlPath: "signalman.build.yaml",
      });
      const release = await cp.releases.create({
        orgId: defaultOrg.id,
        productId: product.id,
        tag: "v1",
        commitSha: "deadbeef",
      });
      await cp.releases.update(release.id, { status: "ready" });
      const bundle = makeBundle(tmp, "kustomize");
      const target = await cp.targets.create({
        orgId: defaultOrg.id,
        name: "k8s-ci",
        kind: "k8s_test",
        connection: { bundleUri: bundle, namespace: "ci" },
      });

      // Apply succeeds; the subsequent health probe times out
      // (exit 1 with no auth/namespace classifier match).
      const kubectlExec = vi
        .fn<K8sExec>()
        .mockResolvedValueOnce({
          stdout: "deployment.apps/foo configured\n",
          stderr: "",
          exitCode: 0,
        })
        .mockResolvedValueOnce({
          stdout: "",
          stderr: "error: timed out waiting for the condition on pods/foo",
          exitCode: 1,
        });
      const drivers = makeDrivers({ kubectlExec });

      await expect(
        runK8sReleaseDeploy(cp, {
          orgId: defaultOrg.id,
          releaseId: release.id,
          target,
          drivers,
        }),
      ).rejects.toThrow(/health check failed/);

      const target2 = await cp.targets.get(target.id);
      expect(target2).not.toBeNull();
      const deployments = await cp.deployments.listForTarget(target.id);
      expect(deployments[0].status).toBe("failed");
    } finally {
      await cleanup();
    }
  });

  it("rejects when the target connection is missing bundleUri", async () => {
    const { cp, cleanup } = await makeControlPlane();
    try {
      const { defaultOrg } = await cp.init();
      const product = await cp.products.create({
        orgId: defaultOrg.id,
        name: "p",
        repoUrl: "https://x",
        buildYamlPath: "signalman.build.yaml",
      });
      const release = await cp.releases.create({
        orgId: defaultOrg.id,
        productId: product.id,
        tag: "v1",
        commitSha: "deadbeef",
      });
      await cp.releases.update(release.id, { status: "ready" });
      const target = await cp.targets.create({
        orgId: defaultOrg.id,
        name: "k8s-bad",
        kind: "k8s_test",
        connection: { namespace: "ci" },
      });
      const drivers = makeDrivers({});
      await expect(
        runK8sReleaseDeploy(cp, {
          orgId: defaultOrg.id,
          releaseId: release.id,
          target,
          drivers,
        }),
      ).rejects.toThrow(/missing connection.bundleUri/);
    } finally {
      await cleanup();
    }
  });
});

describe("runK8sReleaseRollback — control-plane adapter", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sig-k8s-cp-rb-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("calls kubectl rollout undo + marks active deployment rolled_back", async () => {
    const { cp, cleanup } = await makeControlPlane();
    try {
      const { defaultOrg } = await cp.init();
      const product = await cp.products.create({
        orgId: defaultOrg.id,
        name: "p",
        repoUrl: "https://x",
        buildYamlPath: "signalman.build.yaml",
      });
      const release = await cp.releases.create({
        orgId: defaultOrg.id,
        productId: product.id,
        tag: "v1",
        commitSha: "deadbeef",
      });
      await cp.releases.update(release.id, { status: "ready" });
      const bundle = makeBundle(tmp, "kustomize");
      const target = await cp.targets.create({
        orgId: defaultOrg.id,
        name: "k8s-ci",
        kind: "k8s_test",
        connection: {
          bundleUri: bundle,
          namespace: "ci",
          releaseName: "my-app",
        },
      });
      // Seed an active deployment.
      const deployment = await cp.deployments.create({
        orgId: defaultOrg.id,
        releaseId: release.id,
        targetId: target.id,
      });
      await cp.deployments.update(deployment.id, { status: "active" });

      const kubectlExec = vi.fn<K8sExec>().mockResolvedValue({
        stdout: "deployment.apps/my-app rolled back\n",
        stderr: "",
        exitCode: 0,
      });
      const drivers = makeDrivers({ kubectlExec });

      const result = await runK8sReleaseRollback(cp, {
        orgId: defaultOrg.id,
        target,
        drivers,
      });

      expect(result.deployment.status).toBe("rolled_back");
      expect(kubectlExec).toHaveBeenCalledTimes(1);
      // Inspect the argv passed to kubectl — it should be
      // rollout undo deployment/my-app.
      const passedArgs = kubectlExec.mock.calls[0][1];
      expect(passedArgs).toContain("rollout");
      expect(passedArgs).toContain("undo");
      expect(passedArgs).toContain("deployment/my-app");
    } finally {
      await cleanup();
    }
  });

  it("throws when no active deployment is present", async () => {
    const { cp, cleanup } = await makeControlPlane();
    try {
      const { defaultOrg } = await cp.init();
      const target = await cp.targets.create({
        orgId: defaultOrg.id,
        name: "k8s-empty",
        kind: "k8s_test",
        connection: { bundleUri: "/tmp/bundle", namespace: "ci" },
      });
      const drivers = makeDrivers({});
      await expect(
        runK8sReleaseRollback(cp, {
          orgId: defaultOrg.id,
          target,
          drivers,
        }),
      ).rejects.toThrow(/no active deployment/);
    } finally {
      await cleanup();
    }
  });
});
