/**
 * Tests for the probe runner — each probe kind, plus the matcher
 * semantics.
 */

import { describe, expect, it } from "vitest";
import type { CheckpointHandle, VMHandle } from "../hypervisors/interface.js";
import type {
  DeployBackend,
  DeployVmHandle,
  ExecResult,
} from "../control-plane/deploy/backend.js";
import { runProbe, runProbes } from "../control-plane/probes/index.js";
import type { Probe } from "../control-plane/build/yaml.js";

const handle: VMHandle = {
  id: "fake",
  name: "Win11_demo",
  backend: "fake" as unknown as VMHandle["backend"],
} as VMHandle;

/**
 * A backend that returns canned exec results based on the command/args
 * the caller passes. Tests construct one with a script of expected
 * invocations + canned responses.
 */
function fakeBackend(
  responder: (command: string, args: string[] | undefined) => ExecResult,
): DeployBackend {
  return {
    async resolveVm(): Promise<DeployVmHandle> {
      return { handle, vmName: "Win11_demo" };
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
      return responder(command, args);
    },
  };
}

describe("command probe", () => {
  it("passes when exit matches expected (default 0) and matchers satisfied", async () => {
    const probe: Probe = {
      kind: "command",
      name: "agent_running",
      command: "sc.exe",
      args: ["query", "ExampleAgent"],
      expect_stdout_contains: "RUNNING",
    };
    const backend = fakeBackend(() => ({
      exitCode: 0,
      stdout: "STATE  : 4  RUNNING\n",
      stderr: "",
    }));
    const result = await runProbe({ probe, handle, backend });
    expect(result.status).toBe("pass");
    expect(result.name).toBe("agent_running");
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("fails on unexpected exit code", async () => {
    const probe: Probe = {
      kind: "command",
      name: "x",
      command: "bad",
    };
    const backend = fakeBackend(() => ({ exitCode: 1, stdout: "", stderr: "err" }));
    const result = await runProbe({ probe, handle, backend });
    expect(result.status).toBe("fail");
    expect(result.detail).toMatch(/exit=1/);
  });

  it("fails when stdout doesn't contain the expected substring", async () => {
    const probe: Probe = {
      kind: "command",
      name: "x",
      command: "echo",
      expect_stdout_contains: "MISSING",
    };
    const backend = fakeBackend(() => ({ exitCode: 0, stdout: "other", stderr: "" }));
    const result = await runProbe({ probe, handle, backend });
    expect(result.status).toBe("fail");
    expect(result.detail).toMatch(/did not contain 'MISSING'/);
  });

  it("respects custom expect_exit", async () => {
    const probe: Probe = {
      kind: "command",
      name: "x",
      command: "y",
      expect_exit: 1,
    };
    const backend = fakeBackend(() => ({ exitCode: 1, stdout: "", stderr: "" }));
    const result = await runProbe({ probe, handle, backend });
    expect(result.status).toBe("pass");
  });
});

describe("http_in_guest probe", () => {
  it("passes when PowerShell wrapper exits 0 with expected status", async () => {
    const probe: Probe = {
      kind: "http_in_guest",
      name: "backend_health",
      url: "http://localhost:8080/health",
    };
    const backend = fakeBackend((command) => {
      expect(command).toBe("powershell.exe");
      return { exitCode: 0, stdout: "200\n", stderr: "ok" };
    });
    const result = await runProbe({ probe, handle, backend });
    expect(result.status).toBe("pass");
    expect(result.detail).toBe("status=200");
  });

  it("fails when the HTTP status mismatches expect_status", async () => {
    const probe: Probe = {
      kind: "http_in_guest",
      name: "x",
      url: "http://x",
      expect_status: 200,
    };
    const backend = fakeBackend(() => ({ exitCode: 0, stdout: "500\n", stderr: "boom" }));
    const result = await runProbe({ probe, handle, backend });
    expect(result.status).toBe("fail");
    expect(result.detail).toMatch(/expected HTTP 200, got 500/);
  });

  it("fails when expect_body_contains is missing from the response body", async () => {
    const probe: Probe = {
      kind: "http_in_guest",
      name: "x",
      url: "http://x",
      expect_body_contains: "Example Dashboard",
    };
    const backend = fakeBackend(() => ({
      exitCode: 0,
      stdout: "200",
      stderr: "<html>nope</html>",
    }));
    const result = await runProbe({ probe, handle, backend });
    expect(result.status).toBe("fail");
    expect(result.detail).toMatch(/body did not contain/);
  });

  it("fails when Invoke-WebRequest itself errors (non-zero exit)", async () => {
    const probe: Probe = {
      kind: "http_in_guest",
      name: "x",
      url: "http://x",
    };
    const backend = fakeBackend(() => ({
      exitCode: 1,
      stdout: "",
      stderr: "connection refused",
    }));
    const result = await runProbe({ probe, handle, backend });
    expect(result.status).toBe("fail");
    expect(result.detail).toMatch(/Invoke-WebRequest failed/);
  });
});

describe("file_in_guest probe", () => {
  it("passes when `cmd /c if exist` returns 0", async () => {
    const probe: Probe = {
      kind: "file_in_guest",
      name: "manifest_present",
      path: "C:/Program Files/Example/manifest.json",
    };
    const backend = fakeBackend((command, args) => {
      expect(command).toBe("cmd.exe");
      expect(args![0]).toBe("/c");
      expect(args![1]).toContain('"C:/Program Files/Example/manifest.json"');
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    const result = await runProbe({ probe, handle, backend });
    expect(result.status).toBe("pass");
    expect(result.detail).toBe("present");
  });

  it("fails when `cmd /c if exist` returns 1", async () => {
    const probe: Probe = {
      kind: "file_in_guest",
      name: "x",
      path: "C:/missing",
    };
    const backend = fakeBackend(() => ({ exitCode: 1, stdout: "", stderr: "" }));
    const result = await runProbe({ probe, handle, backend });
    expect(result.status).toBe("fail");
    expect(result.detail).toBe("missing");
  });

  it("refuses a path containing a double-quote (would break cmd quoting)", async () => {
    const probe: Probe = {
      kind: "file_in_guest",
      name: "x",
      path: 'C:/bad"path',
    };
    const backend = fakeBackend(() => ({ exitCode: 0, stdout: "", stderr: "" }));
    const result = await runProbe({ probe, handle, backend });
    expect(result.status).toBe("fail");
    expect(result.detail).toMatch(/may not contain a double-quote/);
  });
});

describe("runProbes (set)", () => {
  it("runs serially and returns results in declaration order", async () => {
    const probes: Probe[] = [
      { kind: "command", name: "a", command: "x" },
      { kind: "command", name: "b", command: "y" },
      { kind: "command", name: "c", command: "z" },
    ];
    let n = 0;
    const backend = fakeBackend(() => ({
      exitCode: n++ === 1 ? 1 : 0, // 'b' fails
      stdout: "",
      stderr: "",
    }));
    const results = await runProbes(probes, handle, backend);
    expect(results.map((r) => r.name)).toEqual(["a", "b", "c"]);
    expect(results.map((r) => r.status)).toEqual(["pass", "fail", "pass"]);
  });

  it("captures thrown errors as fail (not propagation)", async () => {
    const probes: Probe[] = [{ kind: "command", name: "a", command: "x" }];
    const backend: DeployBackend = {
      async resolveVm(): Promise<DeployVmHandle> {
        return { handle, vmName: "x" };
      },
      async createCheckpoint(_h, label): Promise<CheckpointHandle> {
        return { id: label, vmHandle: handle, label } as CheckpointHandle;
      },
      async restoreCheckpoint() {},
      async deleteCheckpoint() {},
      async copyFileToVM() {},
      async isVmReachable() {
        return { reachable: true };
      },
      async executeInGuest() {
        throw new Error("guest exec exploded");
      },
    };
    const [r] = await runProbes(probes, handle, backend);
    expect(r.status).toBe("fail");
    expect(r.detail).toMatch(/guest exec exploded/);
  });
});
