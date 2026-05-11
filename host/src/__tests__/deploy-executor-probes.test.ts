/**
 * Tests for PR 4: declared probes integrated into the deploy executor.
 *
 * Confirms that:
 *   * probes from a release's persisted build_yaml_json run after
 *     vm_reachable on deploy
 *   * each probe result becomes a health_check row
 *   * any probe failure causes the deploy to fail + restore checkpoint
 *   * deploys for releases without declared probes still work
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ControlPlane } from "../control-plane/index.js";
import {
  DeployHealthFailedError,
  runDeploy,
} from "../control-plane/deploy/index.js";
import type {
  DeployBackend,
  DeployVmHandle,
  ExecResult,
} from "../control-plane/deploy/backend.js";
import type {
  CheckpointHandle,
  VMHandle,
} from "../hypervisors/interface.js";
import type { Org, Product, Release, Target } from "../control-plane/types.js";

interface Harness {
  dataDir: string;
  cp: ControlPlane;
  org: Org;
  product: Product;
  release: Release;
  target: Target;
}

async function setup(buildYaml: object): Promise<Harness> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "signalman-probes-test-"));
  const cp = ControlPlane.create({
    storage: { driver: "sqlite", url: path.join(dataDir, "signalman.db") },
    blobs: { driver: "local", root: path.join(dataDir, "blobs") },
  });
  const { defaultOrg } = await cp.init();
  const product = await cp.products.create({
    orgId: defaultOrg.id,
    name: "p",
    repoUrl: "u",
  });
  const release = await cp.releases.create({
    orgId: defaultOrg.id,
    productId: product.id,
    tag: "v1",
    commitSha: "c",
  });
  // Stamp the release as ready + attach the build.yaml snapshot the
  // deploy executor will re-read at probe time.
  await cp.releases.update(release.id, {
    status: "ready",
    buildYamlJson: JSON.stringify(buildYaml),
  });
  // One trivial blob artifact so the deploy has something to stage.
  const blob = await cp.blobs.put({
    orgId: defaultOrg.id,
    body: Buffer.from("agent-binary"),
  });
  await cp.artifacts.create({
    releaseId: release.id,
    component: "agent",
    kind: "blob",
    sha256: blob.sha256,
    sizeBytes: blob.size,
    blobUri: blob.uri,
  });
  const target = await cp.targets.create({
    orgId: defaultOrg.id,
    name: "win11-test",
    kind: "vm_test",
    connection: { vmName: "X" },
  });
  const fresh = await cp.releases.get(release.id);
  return { dataDir, cp, org: defaultOrg, product, release: fresh!, target };
}

async function tearDown(h: Harness): Promise<void> {
  await h.cp.close();
  await fs.rm(h.dataDir, { recursive: true, force: true });
}

interface FakeOptions {
  /** A function that mocks executeInGuest based on command/args. */
  exec: (command: string, args?: string[]) => ExecResult;
}

function fakeBackend(opts: FakeOptions): DeployBackend {
  const handle: VMHandle = {
    id: "fake",
    name: "X",
    backend: "fake" as unknown as VMHandle["backend"],
  } as VMHandle;
  return {
    async resolveVm(): Promise<DeployVmHandle> {
      return { handle, vmName: "X" };
    },
    async createCheckpoint(_h: VMHandle, label: string): Promise<CheckpointHandle> {
      return { id: label, vmHandle: handle, label } as CheckpointHandle;
    },
    async restoreCheckpoint() {},
    async deleteCheckpoint() {},
    async copyFileToVM() {},
    async isVmReachable() {
      return { reachable: true };
    },
    async executeInGuest(_h, command, args) {
      return opts.exec(command, args);
    },
  };
}

const silentSink: NodeJS.WritableStream = Object.assign(
  Object.create(null) as object,
  { write: () => true, end: () => undefined, on: () => silentSink, emit: () => true },
) as unknown as NodeJS.WritableStream;

describe("deploy with declared probes", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await setup({
      schema_version: 1,
      components: [
        {
          name: "agent",
          build: { command: "node", args: ["-e", "void 0"] },
          artifacts: [{ kind: "blob", path: "x" }],
        },
      ],
      probes: [
        {
          kind: "command",
          name: "agent_service",
          command: "sc.exe",
          args: ["query", "ExampleAgent"],
          expect_stdout_contains: "RUNNING",
        },
        {
          kind: "file_in_guest",
          name: "manifest_present",
          path: "C:/Program Files/Example/manifest.json",
        },
      ],
    });
  });
  afterEach(() => tearDown(h));

  it("runs every declared probe + writes one health_check per probe + vm_reachable", async () => {
    const backend = fakeBackend({
      exec: (command, args) => {
        if (command === "sc.exe") {
          return {
            exitCode: 0,
            stdout: "STATE  : 4  RUNNING\n",
            stderr: "",
          };
        }
        if (command === "cmd.exe" && args?.[0] === "/c") {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        throw new Error(`unexpected exec: ${command} ${(args ?? []).join(" ")}`);
      },
    });

    const result = await runDeploy({
      controlPlane: h.cp,
      orgId: h.org.id,
      releaseId: h.release.id,
      targetId: h.target.id,
      backend,
      out: silentSink,
    });

    expect(result.deployment.status).toBe("active");
    expect(result.healthSummary.total).toBe(3); // vm_reachable + 2 declared
    expect(result.healthSummary.pass).toBe(3);

    const checks = await h.cp.healthChecks.listForDeployment(result.deployment.id);
    const names = checks.map((c) => c.probeName).sort();
    expect(names).toEqual(["agent_service", "manifest_present", "vm_reachable"]);
  });

  it("fails the deploy when any probe fails + restores checkpoint", async () => {
    const backend = fakeBackend({
      exec: (command) => {
        if (command === "sc.exe") {
          return { exitCode: 1, stdout: "", stderr: "service not found" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });

    await expect(
      runDeploy({
        controlPlane: h.cp,
        orgId: h.org.id,
        releaseId: h.release.id,
        targetId: h.target.id,
        backend,
        out: silentSink,
      }),
    ).rejects.toBeInstanceOf(DeployHealthFailedError);

    // Deployment marked failed.
    const ds = await h.cp.deployments.listForTarget(h.target.id);
    expect(ds[0].status).toBe("failed");

    // The failed probe is recorded.
    const checks = await h.cp.healthChecks.listForDeployment(ds[0].id);
    const failed = checks.find((c) => c.probeName === "agent_service");
    expect(failed?.status).toBe("fail");
  });
});

describe("deploy without declared probes", () => {
  it("succeeds with only vm_reachable when build.yaml has no probes section", async () => {
    const h = await setup({
      schema_version: 1,
      components: [
        {
          name: "agent",
          build: { command: "node", args: ["-e", "void 0"] },
          artifacts: [{ kind: "blob", path: "x" }],
        },
      ],
    });
    try {
      const backend = fakeBackend({
        exec: () => ({ exitCode: 0, stdout: "", stderr: "" }),
      });
      const result = await runDeploy({
        controlPlane: h.cp,
        orgId: h.org.id,
        releaseId: h.release.id,
        targetId: h.target.id,
        backend,
        out: silentSink,
      });
      expect(result.deployment.status).toBe("active");
      expect(result.healthSummary.total).toBe(1);
    } finally {
      await tearDown(h);
    }
  });
});
