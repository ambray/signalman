// WS6 M9 — runner-deploy multi-transport tests.
//
// Closes the wave-2 capability matrix #3 gap (deferred M3.5). Tests
// cover:
//   - Binary ref validation
//   - Each transport's bootstrap argv / commands construction
//   - The script transport's output (bash + pwsh emission)
//   - Heartbeat-wait verification (success + timeout + stale-row paths)
//   - The orchestrator (runRunnerDeploy) end-to-end with stub
//     transports + stub heartbeat (audit log entries asserted)
//
// Test strategy: every transport accepts an injectable `exec`, the
// cloud transport accepts injectable `provision` + `getIp`, and
// heartbeat-wait accepts injectable `now` + `sleep`. No real
// subprocesses are spawned and no real network is touched.

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ControlPlane } from "../control-plane/index.js";
import {
  buildDockerPullArgs,
  buildDockerRmArgs,
  buildDockerRunArgs,
  buildRunnerYaml,
  buildSshInstallCommands,
  buildWinRmInvokeArgs,
  buildWinRmScript,
  CloudTransport,
  DockerTransport,
  parseBlobUrlSha256,
  resolveExpectedSha256,
  ScriptTransport,
  SshTransport,
  validateBinaryRef,
  waitForRunnerHeartbeat,
  WinRmTransport,
  runRunnerDeploy,
  type BootstrapCommonOptions,
  type CloudTransportDeps,
  type RunnerDeployTransport,
  type TransportExec,
} from "../runner/deploy/index.js";
import type { Org } from "../control-plane/types.js";

let dataDir: string;
let cp: ControlPlane;
let org: Org;

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "signalman-runner-deploy-"));
  cp = ControlPlane.create({
    storage: { driver: "sqlite", url: path.join(dataDir, "signalman.db") },
    blobs: { driver: "local", root: path.join(dataDir, "blobs") },
  });
  const init = await cp.init();
  org = init.defaultOrg;
});

afterEach(async () => {
  await cp.close();
  await fs.rm(dataDir, { recursive: true, force: true });
});

const COMMON: BootstrapCommonOptions = {
  binary: { url: "https://example.com/v1/blobs/sha256:" + "a".repeat(64) },
  controlPlaneUrl: "http://control-plane:7777",
  token: "tok-abc-123",
  workerName: "test-worker-1",
};

function recordingExec(): {
  exec: TransportExec;
  calls: Array<{ command: string; args: string[]; stdin?: string }>;
} {
  const calls: Array<{ command: string; args: string[]; stdin?: string }> = [];
  const exec: TransportExec = async (command, args, opts = {}) => {
    calls.push({
      command,
      args,
      stdin: opts.stdin ? opts.stdin.toString("utf-8") : undefined,
    });
    return { stdout: "ok", stderr: "", exitCode: 0 };
  };
  return { exec, calls };
}

// ────────────────────────────────────────────────────────────────────
// Binary ref
// ────────────────────────────────────────────────────────────────────

describe("validateBinaryRef + helpers", () => {
  it("accepts a valid registry blob URL", () => {
    expect(() =>
      validateBinaryRef({ url: "https://reg.example/v1/blobs/sha256:" + "a".repeat(64) }),
    ).not.toThrow();
  });

  it("rejects empty / non-string url", () => {
    expect(() => validateBinaryRef({ url: "" })).toThrow(/non-empty string/);
    expect(() => validateBinaryRef({ url: 42 as unknown as string })).toThrow();
  });

  it("rejects non-http(s) urls", () => {
    expect(() => validateBinaryRef({ url: "ftp://example/x" })).toThrow(/http\(s\)/);
  });

  it("rejects malformed sha256", () => {
    expect(() => validateBinaryRef({ url: "https://x/y", sha256: "abc" })).toThrow(/64.*hex/);
  });

  it("parseBlobUrlSha256 extracts from registry URL", () => {
    const hash = "a".repeat(64);
    expect(parseBlobUrlSha256(`https://reg/v1/blobs/sha256:${hash}`)).toBe(hash);
  });

  it("parseBlobUrlSha256 returns null for non-blob URL", () => {
    expect(parseBlobUrlSha256("https://example.com/file.bin")).toBeNull();
  });

  it("resolveExpectedSha256 prefers explicit ref.sha256", () => {
    const explicit = "b".repeat(64);
    const inUrl = "a".repeat(64);
    expect(
      resolveExpectedSha256({
        url: `https://reg/v1/blobs/sha256:${inUrl}`,
        sha256: explicit,
      }),
    ).toBe(explicit);
  });

  it("resolveExpectedSha256 falls back to URL-embedded hash", () => {
    const inUrl = "a".repeat(64);
    expect(
      resolveExpectedSha256({ url: `https://reg/v1/blobs/sha256:${inUrl}` }),
    ).toBe(inUrl);
  });
});

// ────────────────────────────────────────────────────────────────────
// ScriptTransport
// ────────────────────────────────────────────────────────────────────

describe("ScriptTransport", () => {
  it("emits bash for linux", async () => {
    const t = new ScriptTransport();
    const { exec } = recordingExec();
    const r = await t.bootstrap(COMMON, { kind: "script", os: "linux" }, exec);
    expect(r.transport).toBe("script");
    expect(r.script).toBeDefined();
    expect(r.script).toContain("#!/usr/bin/env bash");
    expect(r.script).toContain(COMMON.binary.url);
    expect(r.script).toContain(`worker_name: ${COMMON.workerName}`);
    // sha256 from the blob URL should be auto-pinned
    expect(r.detail.sha256_pinned).toBe(true);
  });

  it("emits pwsh for windows", async () => {
    const t = new ScriptTransport();
    const { exec } = recordingExec();
    const r = await t.bootstrap(COMMON, { kind: "script", os: "windows" }, exec);
    expect(r.script).toContain("Invoke-WebRequest");
    expect(r.script).not.toContain("#!/usr/bin/env bash");
  });

  it("writes to output_path when set", async () => {
    const outPath = path.join(dataDir, "deploy.sh");
    const t = new ScriptTransport();
    const { exec } = recordingExec();
    await t.bootstrap(
      COMMON,
      { kind: "script", os: "linux", outputPath: outPath },
      exec,
    );
    const body = await fs.readFile(outPath, "utf-8");
    expect(body).toContain("#!/usr/bin/env bash");
  });

  it("omits sha-verify block when no sha pinned", async () => {
    const t = new ScriptTransport();
    const { exec } = recordingExec();
    const r = await t.bootstrap(
      { ...COMMON, binary: { url: "https://example.com/runner" } },
      { kind: "script", os: "linux" },
      exec,
    );
    expect(r.detail.sha256_pinned).toBe(false);
    expect(r.script).not.toMatch(/sha256sum.*signalman-runner.*if.*!=/s);
  });
});

// ────────────────────────────────────────────────────────────────────
// SshTransport
// ────────────────────────────────────────────────────────────────────

describe("SshTransport (argv construction)", () => {
  it("buildRunnerYaml carries all three fields", () => {
    const yaml = buildRunnerYaml(COMMON);
    expect(yaml).toContain(`control_plane_url: ${COMMON.controlPlaneUrl}`);
    expect(yaml).toContain(`token: ${COMMON.token}`);
    expect(yaml).toContain(`worker_name: ${COMMON.workerName}`);
  });

  it("buildSshInstallCommands includes sha256 verify when pinned", () => {
    const sha = "a".repeat(64);
    const cmds = buildSshInstallCommands(COMMON, {
      kind: "ssh",
      host: "user@h",
      identityPath: "/k",
    }, sha);
    expect(cmds.join(" ; ")).toContain(`expected ${sha}`);
  });

  it("buildSshInstallCommands skips sha check when not pinned", () => {
    const cmds = buildSshInstallCommands(COMMON, {
      kind: "ssh",
      host: "u@h",
      identityPath: "/k",
    }, null);
    expect(cmds.join(" ; ")).not.toContain("expected");
  });

  it("bootstrap dispatches expected ssh + ssh + ssh sequence (systemd)", async () => {
    const t = new SshTransport();
    const { exec, calls } = recordingExec();
    await t.bootstrap(
      COMMON,
      { kind: "ssh", host: "user@host", identityPath: "/path/to/key", port: 2222 },
      exec,
    );
    expect(calls).toHaveLength(3); // install + yaml + systemd unit
    expect(calls[0].command).toBe("ssh");
    expect(calls[0].args).toContain("-i");
    expect(calls[0].args).toContain("/path/to/key");
    expect(calls[0].args).toContain("-p");
    expect(calls[0].args).toContain("2222");
    expect(calls[1].stdin).toContain("worker_name:");
    expect(calls[2].stdin).toContain("[Service]"); // systemd unit
  });

  it("serviceManager=launchd writes a plist instead", async () => {
    const t = new SshTransport();
    const { exec, calls } = recordingExec();
    await t.bootstrap(
      COMMON,
      { kind: "ssh", host: "h", identityPath: "/k", serviceManager: "launchd" },
      exec,
    );
    expect(calls[2].stdin).toContain("<plist version=\"1.0\">");
  });

  it("serviceManager=none skips the service step", async () => {
    const t = new SshTransport();
    const { exec, calls } = recordingExec();
    await t.bootstrap(
      COMMON,
      { kind: "ssh", host: "h", identityPath: "/k", serviceManager: "none" },
      exec,
    );
    expect(calls).toHaveLength(2); // install + yaml only
  });

  it("non-zero exit code throws", async () => {
    const t = new SshTransport();
    const exec: TransportExec = async () => ({ stdout: "", stderr: "permission denied", exitCode: 255 });
    await expect(
      t.bootstrap(
        COMMON,
        { kind: "ssh", host: "h", identityPath: "/k" },
        exec,
      ),
    ).rejects.toThrow(/exited with 255/);
  });
});

// ────────────────────────────────────────────────────────────────────
// WinRmTransport
// ────────────────────────────────────────────────────────────────────

describe("WinRmTransport (argv construction)", () => {
  it("buildWinRmScript includes sha verify when pinned", () => {
    const body = buildWinRmScript(COMMON, "a".repeat(64));
    expect(body).toContain("Get-FileHash");
    expect(body).toContain(COMMON.binary.url);
  });

  it("buildWinRmInvokeArgs uses HTTPS by default + reads pwd from env", () => {
    const args = buildWinRmInvokeArgs({
      kind: "winrm",
      host: "win-target",
      username: "DOMAIN\\admin",
      password: "secret",
    });
    expect(args).toContain("-Command");
    const cmd = args[args.length - 1];
    expect(cmd).toContain("Invoke-Command -ComputerName 'win-target'");
    expect(cmd).toContain("$env:SIGNALMAN_WINRM_PASSWORD");
    expect(cmd).toContain("-UseSSL");
  });

  it("useSsl=false changes port + flag", () => {
    const args = buildWinRmInvokeArgs({
      kind: "winrm",
      host: "h",
      username: "u",
      password: "p",
      useSsl: false,
    });
    expect(args[args.length - 1]).toContain("Port 5985");
    expect(args[args.length - 1]).not.toContain("UseSSL");
  });

  it("bootstrap detail records username + port but NOT password", async () => {
    const t = new WinRmTransport();
    const { exec } = recordingExec();
    const r = await t.bootstrap(
      COMMON,
      { kind: "winrm", host: "h", username: "u", password: "secret-no-leak" },
      exec,
    );
    expect(r.detail.username).toBe("u");
    expect(JSON.stringify(r.detail)).not.toContain("secret-no-leak");
  });

  it("password is passed via env var, not on argv", async () => {
    const t = new WinRmTransport();
    const calls: Array<{ env?: Record<string, string>; args: string[] }> = [];
    const exec: TransportExec = async (_cmd, args, opts = {}) => {
      calls.push({ env: opts.env, args });
      return { stdout: "", stderr: "", exitCode: 0 };
    };
    await t.bootstrap(
      COMMON,
      { kind: "winrm", host: "h", username: "u", password: "secret-xyz" },
      exec,
    );
    expect(calls[0].env?.SIGNALMAN_WINRM_PASSWORD).toBe("secret-xyz");
    expect(calls[0].args.join(" ")).not.toContain("secret-xyz");
  });
});

// ────────────────────────────────────────────────────────────────────
// DockerTransport
// ────────────────────────────────────────────────────────────────────

describe("DockerTransport (argv construction)", () => {
  it("buildDockerRunArgs includes registration env vars", () => {
    const args = buildDockerRunArgs(COMMON, {
      kind: "docker",
      image: "my-runner:0.4.x",
    });
    expect(args).toContain(`SIGNALMAN_CONTROL_PLANE=${COMMON.controlPlaneUrl}`);
    expect(args).toContain(`SIGNALMAN_TOKEN=${COMMON.token}`);
    expect(args).toContain(`SIGNALMAN_WORKER_NAME=${COMMON.workerName}`);
    expect(args).toContain("my-runner:0.4.x");
    expect(args).toContain("--restart");
    expect(args).toContain("on-failure");
  });

  it("buildDockerRunArgs honours context", () => {
    const args = buildDockerRunArgs(COMMON, {
      kind: "docker",
      image: "img",
      context: "remote-daemon",
    });
    expect(args.slice(0, 2)).toEqual(["--context", "remote-daemon"]);
  });

  it("context=default drops the --context flag", () => {
    const args = buildDockerRunArgs(COMMON, {
      kind: "docker",
      image: "img",
      context: "default",
    });
    expect(args).not.toContain("--context");
  });

  it("extraVolumes + extraEnv append in order", () => {
    const args = buildDockerRunArgs(COMMON, {
      kind: "docker",
      image: "img",
      extraVolumes: ["/h:/c", "/h2:/c2"],
      extraEnv: { K: "V" },
    });
    expect(args.filter((a) => a === "-v")).toHaveLength(2);
    expect(args).toContain("K=V");
  });

  it("buildDockerPullArgs / RmArgs match the expected shape", () => {
    expect(
      buildDockerPullArgs({ kind: "docker", image: "img", context: "ctx" }),
    ).toEqual(["--context", "ctx", "pull", "img"]);
    expect(
      buildDockerRmArgs(COMMON, { kind: "docker", image: "img" }),
    ).toContain(`signalman-runner-${COMMON.workerName}`);
  });

  it("bootstrap calls pull -> rm -> run in order", async () => {
    const t = new DockerTransport();
    const { exec, calls } = recordingExec();
    await t.bootstrap(COMMON, { kind: "docker", image: "img" }, exec);
    expect(calls).toHaveLength(3);
    expect(calls[0].args).toContain("pull");
    expect(calls[1].args).toContain("rm");
    expect(calls[2].args).toContain("run");
  });

  it("pull failure propagates", async () => {
    const t = new DockerTransport();
    const exec: TransportExec = async (_c, args) => {
      if (args.includes("pull")) return { stdout: "", stderr: "no such image", exitCode: 1 };
      return { stdout: "", stderr: "", exitCode: 0 };
    };
    await expect(
      t.bootstrap(COMMON, { kind: "docker", image: "missing:tag" }, exec),
    ).rejects.toThrow(/pull exited with 1/);
  });
});

// ────────────────────────────────────────────────────────────────────
// CloudTransport
// ────────────────────────────────────────────────────────────────────

describe("CloudTransport (orchestration)", () => {
  function deps(opts: { ip?: string | null } = {}): CloudTransportDeps {
    return {
      provision: vi.fn().mockResolvedValue({
        id: "i-0abc",
        backend: "aws",
        name: "scenario-x",
        region: "us-east-1",
      }),
      getIp: vi.fn().mockResolvedValue(opts.ip === undefined ? "203.0.113.42" : opts.ip),
      sleep: async () => {},
    };
  }

  it("linux: provisions, polls IP, dispatches to SshTransport", async () => {
    const t = new CloudTransport(deps());
    const { exec, calls } = recordingExec();
    const r = await t.bootstrap(
      COMMON,
      {
        kind: "cloud",
        provider: "aws",
        region: "us-east-1",
        instanceType: "t3.medium",
        imageRef: "ami-x",
        name: "n",
        osFamily: "linux",
        innerSsh: { identityPath: "/k" },
      },
      exec,
    );
    expect(r.transport).toBe("cloud");
    expect(r.detail.inner_transport).toBe("ssh");
    expect(r.detail.public_ip).toBe("203.0.113.42");
    // 3 ssh exec calls fired inside the inner SshTransport
    expect(calls).toHaveLength(3);
    expect(calls[0].command).toBe("ssh");
  });

  it("windows: dispatches to WinRmTransport", async () => {
    const t = new CloudTransport(deps());
    const { exec, calls } = recordingExec();
    const r = await t.bootstrap(
      COMMON,
      {
        kind: "cloud",
        provider: "azure",
        region: "eastus",
        instanceType: "Standard_D2s_v3",
        imageRef: "urn:p:o:s:v",
        name: "n",
        osFamily: "windows",
        innerWinRm: { username: "Admin", password: "pw" },
      },
      exec,
    );
    expect(r.detail.inner_transport).toBe("winrm");
    expect(calls[0].command).toBe("pwsh");
  });

  it("linux + missing innerSsh: refuses BEFORE provisioning", async () => {
    const d = deps();
    const t = new CloudTransport(d);
    const { exec } = recordingExec();
    await expect(
      t.bootstrap(
        COMMON,
        {
          kind: "cloud",
          provider: "aws",
          region: "r",
          instanceType: "t",
          imageRef: "i",
          name: "n",
          osFamily: "linux",
        },
        exec,
      ),
    ).rejects.toThrow(/innerSsh\.identityPath is required/);
    expect(d.provision).not.toHaveBeenCalled();
  });

  it("windows + missing winrm creds: refuses BEFORE provisioning", async () => {
    const d = deps();
    const t = new CloudTransport(d);
    const { exec } = recordingExec();
    await expect(
      t.bootstrap(
        COMMON,
        {
          kind: "cloud",
          provider: "azure",
          region: "r",
          instanceType: "t",
          imageRef: "i",
          name: "n",
          osFamily: "windows",
        },
        exec,
      ),
    ).rejects.toThrow(/innerWinRm.*required/);
    expect(d.provision).not.toHaveBeenCalled();
  });

  it("IP timeout: surfaces the handle in the error message", async () => {
    const d = deps({ ip: null });
    d.ipPollIntervalMs = 1;
    d.ipPollTimeoutMs = 2;
    const t = new CloudTransport(d);
    const { exec } = recordingExec();
    await expect(
      t.bootstrap(
        COMMON,
        {
          kind: "cloud",
          provider: "aws",
          region: "r",
          instanceType: "t",
          imageRef: "i",
          name: "n",
          osFamily: "linux",
          innerSsh: { identityPath: "/k" },
        },
        exec,
      ),
    ).rejects.toThrow(/did not surface a public IP/);
  });
});

// ────────────────────────────────────────────────────────────────────
// Heartbeat-wait
// ────────────────────────────────────────────────────────────────────

describe("waitForRunnerHeartbeat", () => {
  it("returns immediately when runner heartbeats inside the window", async () => {
    // Have the runner heartbeat once first
    await cp.runners.heartbeat({ orgId: org.id, name: "w1", meta: null });
    const r = await waitForRunnerHeartbeat(cp, {
      orgId: org.id,
      workerName: "w1",
      pollIntervalMs: 1,
      waitTimeoutMs: 1000,
      freshAfter: new Date(Date.now() - 60_000),
    });
    expect(r.heartbeated).toBe(true);
    expect(r.lastSeenAt).toBeTruthy();
  });

  it("waitTimeoutMs=0 short-circuits", async () => {
    const r = await waitForRunnerHeartbeat(cp, {
      orgId: org.id,
      workerName: "never",
      waitTimeoutMs: 0,
    });
    expect(r.heartbeated).toBe(false);
    expect(r.reason).toMatch(/verification disabled/);
  });

  it("times out when nobody heartbeats", async () => {
    const r = await waitForRunnerHeartbeat(cp, {
      orgId: org.id,
      workerName: "ghost",
      waitTimeoutMs: 50,
      pollIntervalMs: 10,
    });
    expect(r.heartbeated).toBe(false);
    expect(r.reason).toMatch(/never registered/);
  });

  it("treats a stale (pre-bootstrap) row as not-yet-heartbeated", async () => {
    // Stale heartbeat first
    await cp.runners.heartbeat({ orgId: org.id, name: "w2", meta: null });
    // freshAfter = "now" — meaning the existing row is too old
    const r = await waitForRunnerHeartbeat(cp, {
      orgId: org.id,
      workerName: "w2",
      waitTimeoutMs: 50,
      pollIntervalMs: 10,
      freshAfter: new Date(Date.now() + 60_000),
    });
    expect(r.heartbeated).toBe(false);
    expect(r.reason).toMatch(/is stale/);
  });
});

// ────────────────────────────────────────────────────────────────────
// runRunnerDeploy orchestrator
// ────────────────────────────────────────────────────────────────────

describe("runRunnerDeploy orchestrator", () => {
  function stubTransport(): {
    transport: RunnerDeployTransport;
    calls: Array<{ workerName: string }>;
  } {
    const calls: Array<{ workerName: string }> = [];
    const transport: RunnerDeployTransport = {
      kind: "ssh",
      async bootstrap(common) {
        calls.push({ workerName: common.workerName });
        return {
          transport: "ssh",
          workerName: common.workerName,
          detail: { stub: true },
        };
      },
    };
    return { transport, calls };
  }

  it("logs runner.deploy.started + .bootstrapped + .verified on success", async () => {
    // Stub bootstrap triggers a heartbeat DURING bootstrap so it
    // counts as "fresh" relative to bootstrapStartIso.
    const heartbeatingTransport: RunnerDeployTransport = {
      kind: "ssh",
      async bootstrap(common) {
        await cp.runners.heartbeat({ orgId: org.id, name: common.workerName, meta: null });
        return {
          transport: "ssh",
          workerName: common.workerName,
          detail: { stub: true },
        };
      },
    };
    const r = await runRunnerDeploy(cp, {
      binary: { url: "https://reg/v1/blobs/sha256:" + "a".repeat(64) },
      controlPlaneUrl: "http://cp",
      token: "tok",
      workerName: "wA",
      transport: { kind: "ssh", host: "h", identityPath: "/k" },
      transportRegistry: { ssh: heartbeatingTransport },
      waitTimeoutMs: 1000,
      orgId: org.id,
    });
    expect(r.bootstrap.detail).toEqual({ stub: true });
    expect(r.verification?.heartbeated).toBe(true);
    const entries = await cp.auditLog.listForOrg(org.id, { entityType: "runner" });
    const actions = entries.map((e) => e.action);
    expect(actions).toContain("runner.deploy.started");
    expect(actions).toContain("runner.deploy.bootstrapped");
    expect(actions).toContain("runner.deploy.verified");
  });

  it("script transport: skips verification (operator runs script later)", async () => {
    const r = await runRunnerDeploy(cp, {
      binary: { url: "https://reg/v1/blobs/sha256:" + "a".repeat(64) },
      controlPlaneUrl: "http://cp",
      token: "tok",
      workerName: "wScript",
      transport: { kind: "script", os: "linux" },
      orgId: org.id,
    });
    expect(r.bootstrap.script).toContain("#!/usr/bin/env bash");
    expect(r.verification).toBeUndefined();
  });

  it("waitTimeoutMs=0 disables verification", async () => {
    const { transport } = stubTransport();
    const r = await runRunnerDeploy(cp, {
      binary: { url: "https://reg/v1/blobs/sha256:" + "a".repeat(64) },
      controlPlaneUrl: "http://cp",
      token: "tok",
      workerName: "wNoVer",
      transport: { kind: "ssh", host: "h", identityPath: "/k" },
      transportRegistry: { ssh: transport },
      waitTimeoutMs: 0,
      orgId: org.id,
    });
    expect(r.verification).toBeUndefined();
  });

  it("bootstrap throw audits runner.deploy.failed", async () => {
    const exploding: RunnerDeployTransport = {
      kind: "ssh",
      async bootstrap() {
        throw new Error("auth refused");
      },
    };
    await expect(
      runRunnerDeploy(cp, {
        binary: { url: "https://reg/v1/blobs/sha256:" + "a".repeat(64) },
        controlPlaneUrl: "http://cp",
        token: "tok",
        workerName: "wFail",
        transport: { kind: "ssh", host: "h", identityPath: "/k" },
        transportRegistry: { ssh: exploding },
        orgId: org.id,
      }),
    ).rejects.toThrow(/auth refused/);
    const entries = await cp.auditLog.listForOrg(org.id, { entityType: "runner" });
    expect(entries.some((e) => e.action === "runner.deploy.failed")).toBe(true);
  });

  it("verification timeout audits runner.deploy.verification_failed", async () => {
    const { transport } = stubTransport();
    // Nobody heartbeats
    const r = await runRunnerDeploy(cp, {
      binary: { url: "https://reg/v1/blobs/sha256:" + "a".repeat(64) },
      controlPlaneUrl: "http://cp",
      token: "tok",
      workerName: "wTimeout",
      transport: { kind: "ssh", host: "h", identityPath: "/k" },
      transportRegistry: { ssh: transport },
      waitTimeoutMs: 50,
      orgId: org.id,
    });
    expect(r.verification?.heartbeated).toBe(false);
    const entries = await cp.auditLog.listForOrg(org.id, { entityType: "runner" });
    expect(entries.some((e) => e.action === "runner.deploy.verification_failed")).toBe(true);
  });
});
