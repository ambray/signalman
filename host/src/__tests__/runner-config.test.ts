// WS6 Milestone 1 — dedicated unit test for the runner registration
// config writer/loader. `remote-release-build.test.ts` exercises the
// wider runner flow end-to-end but never touches `runner/config.ts`
// directly; a regression in YAML field naming or the mode-0o600 write
// would land silently until an integration ran. This file pins the
// shape.
//
// Each test uses a per-test temp directory so the real
// `~/.signalman/runner.yaml` is never read or written, and tests stay
// independent of each other.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  defaultRunnerConfigPath,
  loadRunnerConfig,
  writeRunnerConfig,
} from "../runner/config.js";

let tmpDir: string;
const originalEnv = process.env.SIGNALMAN_DATA_DIR;

beforeEach(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "sg-runner-config-"));
});

afterEach(async () => {
  // Restore env first so the next test's defaultRunnerConfigPath() is
  // clean even if a test inside touched the env.
  if (originalEnv === undefined) delete process.env.SIGNALMAN_DATA_DIR;
  else process.env.SIGNALMAN_DATA_DIR = originalEnv;
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

describe("defaultRunnerConfigPath", () => {
  it("honors SIGNALMAN_DATA_DIR when set", () => {
    process.env.SIGNALMAN_DATA_DIR = tmpDir;
    const got = defaultRunnerConfigPath();
    expect(got).toBe(path.join(tmpDir, "runner.yaml"));
  });

  it("falls back to ~/.signalman/runner.yaml when env unset", () => {
    delete process.env.SIGNALMAN_DATA_DIR;
    const got = defaultRunnerConfigPath();
    expect(got).toBe(path.join(os.homedir(), ".signalman", "runner.yaml"));
  });

  it("falls back to ~/.signalman when env is set but empty (zero-length string)", () => {
    process.env.SIGNALMAN_DATA_DIR = "";
    const got = defaultRunnerConfigPath();
    expect(got).toBe(path.join(os.homedir(), ".signalman", "runner.yaml"));
  });
});

describe("writeRunnerConfig + loadRunnerConfig — round-trip", () => {
  it("round-trips the basic (no workerName) shape", async () => {
    const target = path.join(tmpDir, "runner.yaml");
    await writeRunnerConfig(
      {
        controlPlaneUrl: "http://cp.example.com:8765",
        token: "sk_test_abc",
      },
      target,
    );
    const loaded = await loadRunnerConfig(target);
    expect(loaded.controlPlaneUrl).toBe("http://cp.example.com:8765");
    expect(loaded.token).toBe("sk_test_abc");
    expect(loaded.workerName).toBeUndefined();
  });

  it("round-trips with an explicit workerName", async () => {
    const target = path.join(tmpDir, "runner.yaml");
    await writeRunnerConfig(
      {
        controlPlaneUrl: "http://cp.example.com:8765",
        token: "sk_test_abc",
        workerName: "builder-01",
      },
      target,
    );
    const loaded = await loadRunnerConfig(target);
    expect(loaded.workerName).toBe("builder-01");
  });

  it("creates the parent directory if it does not exist", async () => {
    const nested = path.join(tmpDir, "deep", "nested", "runner.yaml");
    expect(fs.existsSync(path.dirname(nested))).toBe(false);
    await writeRunnerConfig(
      { controlPlaneUrl: "http://cp:8765", token: "sk_t" },
      nested,
    );
    expect(fs.existsSync(nested)).toBe(true);
  });

  it("omits worker_name in the YAML when workerName is undefined", async () => {
    const target = path.join(tmpDir, "runner.yaml");
    await writeRunnerConfig(
      { controlPlaneUrl: "http://cp:8765", token: "sk_t" },
      target,
    );
    const raw = await fsp.readFile(target, "utf-8");
    expect(raw).not.toMatch(/worker_name/);
  });

  it.skipIf(process.platform === "win32")(
    "writes the YAML file with 0o600 permissions on POSIX",
    async () => {
      const target = path.join(tmpDir, "runner.yaml");
      await writeRunnerConfig(
        { controlPlaneUrl: "http://cp:8765", token: "sk_t" },
        target,
      );
      const stat = await fsp.stat(target);
      // The umask + open(2) mode interaction makes us mask down to
      // the low 9 bits and compare against 0o600.
      expect(stat.mode & 0o777).toBe(0o600);
    },
  );
});

describe("loadRunnerConfig — error paths", () => {
  it("rejects a missing config file with a 'not registered' hint", async () => {
    const missing = path.join(tmpDir, "does-not-exist.yaml");
    await expect(loadRunnerConfig(missing)).rejects.toThrow(
      /runner is not registered/,
    );
    await expect(loadRunnerConfig(missing)).rejects.toThrow(
      /signalman runner register/,
    );
  });

  it("rejects YAML that doesn't parse to a mapping", async () => {
    const target = path.join(tmpDir, "runner.yaml");
    await fsp.writeFile(target, "[just, an, array]\n", "utf-8");
    await expect(loadRunnerConfig(target)).rejects.toThrow(/YAML mapping/);
  });

  it("rejects YAML missing control_plane_url", async () => {
    const target = path.join(tmpDir, "runner.yaml");
    await fsp.writeFile(target, "token: sk_t\n", "utf-8");
    await expect(loadRunnerConfig(target)).rejects.toThrow(
      /'control_plane_url'/,
    );
  });

  it("rejects YAML missing token", async () => {
    const target = path.join(tmpDir, "runner.yaml");
    await fsp.writeFile(
      target,
      "control_plane_url: http://cp:8765\n",
      "utf-8",
    );
    await expect(loadRunnerConfig(target)).rejects.toThrow(/'token'/);
  });

  it("rejects an empty-string control_plane_url", async () => {
    const target = path.join(tmpDir, "runner.yaml");
    await fsp.writeFile(
      target,
      'control_plane_url: ""\ntoken: sk_t\n',
      "utf-8",
    );
    await expect(loadRunnerConfig(target)).rejects.toThrow(
      /'control_plane_url'/,
    );
  });

  it("rejects an empty-string token", async () => {
    const target = path.join(tmpDir, "runner.yaml");
    await fsp.writeFile(
      target,
      'control_plane_url: http://cp:8765\ntoken: ""\n',
      "utf-8",
    );
    await expect(loadRunnerConfig(target)).rejects.toThrow(/'token'/);
  });

  it("treats a non-string workerName as 'no workerName' (undefined)", async () => {
    // Defensive: if someone hand-edits worker_name: 42 we shouldn't
    // crash, just ignore it. Default-at-start-time path is then used.
    const target = path.join(tmpDir, "runner.yaml");
    await fsp.writeFile(
      target,
      "control_plane_url: http://cp:8765\ntoken: sk_t\nworker_name: 42\n",
      "utf-8",
    );
    const loaded = await loadRunnerConfig(target);
    expect(loaded.workerName).toBeUndefined();
  });

  it("treats an empty-string workerName as 'no workerName' (undefined)", async () => {
    const target = path.join(tmpDir, "runner.yaml");
    await fsp.writeFile(
      target,
      'control_plane_url: http://cp:8765\ntoken: sk_t\nworker_name: ""\n',
      "utf-8",
    );
    const loaded = await loadRunnerConfig(target);
    expect(loaded.workerName).toBeUndefined();
  });
});
