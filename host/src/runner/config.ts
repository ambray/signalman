/**
 * Read/write `~/.signalman/runner.yaml` — the per-machine runner
 * registration file.
 *
 * Kept distinct from the main `config.yaml` so a `signalman runner
 * register` command never touches operator-owned hypervisor or
 * scenario settings.
 *
 * File shape:
 *   control_plane_url: http://control.example.com:8765
 *   token: sk_…_…
 *   worker_name: my-laptop-01      # optional; defaults at start time
 */

import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import YAML from "yaml";

export interface RunnerConfig {
  controlPlaneUrl: string;
  token: string;
  workerName?: string;
}

export function defaultRunnerConfigPath(): string {
  const dataDir =
    process.env.SIGNALMAN_DATA_DIR && process.env.SIGNALMAN_DATA_DIR.length > 0
      ? path.resolve(process.env.SIGNALMAN_DATA_DIR)
      : path.join(os.homedir(), ".signalman");
  return path.join(dataDir, "runner.yaml");
}

export async function loadRunnerConfig(
  configPath: string = defaultRunnerConfigPath(),
): Promise<RunnerConfig> {
  if (!fs.existsSync(configPath)) {
    throw new Error(
      `runner is not registered (no ${configPath}). Run 'signalman runner register --control-plane URL --token TOKEN' first.`,
    );
  }
  const raw = await fsp.readFile(configPath, "utf-8");
  const parsed = YAML.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`runner config at ${configPath} is not a YAML mapping`);
  }
  const obj = parsed as Record<string, unknown>;
  const controlPlaneUrl = obj.control_plane_url;
  const token = obj.token;
  if (typeof controlPlaneUrl !== "string" || controlPlaneUrl.length === 0) {
    throw new Error(`runner config at ${configPath} missing 'control_plane_url'`);
  }
  if (typeof token !== "string" || token.length === 0) {
    throw new Error(`runner config at ${configPath} missing 'token'`);
  }
  return {
    controlPlaneUrl,
    token,
    workerName:
      typeof obj.worker_name === "string" && obj.worker_name.length > 0
        ? obj.worker_name
        : undefined,
  };
}

export async function writeRunnerConfig(
  config: RunnerConfig,
  configPath: string = defaultRunnerConfigPath(),
): Promise<void> {
  await fsp.mkdir(path.dirname(configPath), { recursive: true });
  const yamlOut = YAML.stringify({
    control_plane_url: config.controlPlaneUrl,
    token: config.token,
    ...(config.workerName ? { worker_name: config.workerName } : {}),
  });
  await fsp.writeFile(configPath, yamlOut, { encoding: "utf-8", mode: 0o600 });
}
