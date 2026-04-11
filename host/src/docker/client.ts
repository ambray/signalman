/**
 * Docker client wrapper.
 *
 * Provides a safe, structured interface to the Docker CLI for container
 * lifecycle management, Docker Compose orchestration, and health checks.
 * All user-supplied inputs are sanitized before passing to execFile.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { sanitizePath, sanitizeLabel } from "../sanitize.js";

const execAsync = promisify(execFile);

/** Default timeout for Docker CLI commands (30 seconds). */
const DEFAULT_TIMEOUT_MS = 30_000;

/** Configuration for creating a container. */
export interface ContainerConfig {
  /** Docker image name (e.g., "postgres:16"). */
  image: string;
  /** Container name. */
  name: string;
  /** Port mappings: host port -> container port. */
  ports?: Record<string, string>;
  /** Environment variables. */
  env?: Record<string, string>;
  /** Volume mounts: host path -> container path. */
  volumes?: Record<string, string>;
  /** Docker network to attach. */
  network?: string;
  /** Override command. */
  command?: string[];
  /** Container health check configuration. */
  healthCheck?: {
    command: string;
    intervalMs: number;
    timeoutMs: number;
    retries: number;
  };
}

/** Runtime status of a container. */
export interface ContainerStatus {
  /** Container ID. */
  id: string;
  /** Container name. */
  name: string;
  /** Image name. */
  image: string;
  /** Container state. */
  state: "running" | "stopped" | "paused" | "created" | "exited" | "unknown";
  /** Port mappings. */
  ports: Record<string, string>;
  /** Health check status. */
  health?: "healthy" | "unhealthy" | "starting" | "none";
}

/** Configuration for Docker Compose operations. */
export interface ComposeConfig {
  /** Compose project name. */
  projectName: string;
  /** Path to docker-compose.yaml file. */
  composeFile: string;
  /** Additional environment variables for compose. */
  env?: Record<string, string>;
}

/**
 * Sanitize a container name.
 *
 * Docker container names must match `[a-zA-Z0-9][a-zA-Z0-9_.-]*`.
 * We use sanitizeLabel which allows alphanumeric, spaces, hyphens,
 * and underscores, then strip spaces and add dots.
 */
function sanitizeContainerName(name: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,199}$/.test(name)) {
    throw new Error(
      `Invalid container name: "${name}". Must be 1-200 chars, alphanumeric/hyphens/underscores/dots.`,
    );
  }
  return name;
}

/**
 * Sanitize a Docker image reference.
 *
 * Allows registry/repo:tag format. Rejects shell metacharacters.
 */
function sanitizeImageRef(image: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_./:@-]{0,299}$/.test(image)) {
    throw new Error(
      `Invalid image reference: "${image}". Must be 1-300 chars, valid Docker image format.`,
    );
  }
  return image;
}

/**
 * Sanitize a Docker network name.
 */
function sanitizeNetworkName(name: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/.test(name)) {
    throw new Error(
      `Invalid network name: "${name}". Must be 1-100 chars, alphanumeric/hyphens/underscores/dots.`,
    );
  }
  return name;
}

/**
 * Validate a port string (numeric, 1-65535).
 */
function sanitizePort(port: string): string {
  const parsed = parseInt(port, 10);
  if (isNaN(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`Invalid port: "${port}". Must be 1-65535.`);
  }
  return String(parsed);
}

/**
 * Sanitize an environment variable key.
 */
function sanitizeEnvKey(key: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,255}$/.test(key)) {
    throw new Error(
      `Invalid environment variable name: "${key}".`,
    );
  }
  return key;
}

/**
 * Sanitize a compose project name.
 *
 * Compose project names must be lowercase alphanumeric plus hyphens/underscores.
 */
function sanitizeProjectName(name: string): string {
  if (!/^[a-z0-9][a-z0-9_-]{0,99}$/.test(name)) {
    throw new Error(
      `Invalid project name: "${name}". Must be lowercase, 1-100 chars, alphanumeric/hyphens/underscores.`,
    );
  }
  return name;
}

/**
 * Docker CLI client.
 *
 * Wraps the Docker CLI using execFile (not shell strings) for safety.
 * All user inputs are validated and sanitized before command construction.
 */
export class DockerClient {
  private dockerPath: string;
  private composePath: string;

  constructor(options?: { dockerPath?: string; composePath?: string }) {
    this.dockerPath = options?.dockerPath ?? "docker";
    this.composePath = options?.composePath ?? "docker";
  }

  // ── Container Lifecycle ─────────────────────────────────────────

  /**
   * Create a container from a configuration.
   *
   * @returns The container ID.
   */
  async createContainer(config: ContainerConfig): Promise<string> {
    const args: string[] = ["create", "--name", sanitizeContainerName(config.name)];

    if (config.ports) {
      for (const [hostPort, containerPort] of Object.entries(config.ports)) {
        args.push("-p", `${sanitizePort(hostPort)}:${sanitizePort(containerPort)}`);
      }
    }

    if (config.env) {
      for (const [key, value] of Object.entries(config.env)) {
        args.push("-e", `${sanitizeEnvKey(key)}=${value}`);
      }
    }

    if (config.volumes) {
      for (const [hostPath, containerPath] of Object.entries(config.volumes)) {
        args.push("-v", `${sanitizePath(hostPath)}:${sanitizePath(containerPath)}`);
      }
    }

    if (config.network) {
      args.push("--network", sanitizeNetworkName(config.network));
    }

    if (config.healthCheck) {
      args.push(
        "--health-cmd", config.healthCheck.command,
        "--health-interval", `${config.healthCheck.intervalMs}ms`,
        "--health-timeout", `${config.healthCheck.timeoutMs}ms`,
        "--health-retries", String(config.healthCheck.retries),
      );
    }

    args.push(sanitizeImageRef(config.image));

    if (config.command) {
      args.push(...config.command);
    }

    const { stdout } = await this.exec(args);
    return stdout.trim();
  }

  /** Start a container by name or ID. */
  async startContainer(nameOrId: string): Promise<void> {
    await this.exec(["start", sanitizeContainerName(nameOrId)]);
  }

  /** Stop a container gracefully. */
  async stopContainer(nameOrId: string, timeoutSec?: number): Promise<void> {
    const args = ["stop"];
    if (timeoutSec !== undefined) {
      args.push("-t", String(Math.max(0, Math.floor(timeoutSec))));
    }
    args.push(sanitizeContainerName(nameOrId));
    await this.exec(args);
  }

  /** Remove a container. */
  async removeContainer(nameOrId: string, force?: boolean): Promise<void> {
    const args = ["rm"];
    if (force) args.push("-f");
    args.push(sanitizeContainerName(nameOrId));
    await this.exec(args);
  }

  /** Get the status of a container. */
  async getContainerStatus(nameOrId: string): Promise<ContainerStatus> {
    const { stdout } = await this.exec([
      "inspect",
      "--format", "json",
      sanitizeContainerName(nameOrId),
    ]);

    const inspectData = JSON.parse(stdout);
    const info = Array.isArray(inspectData) ? inspectData[0] : inspectData;

    return this.parseInspectToStatus(info);
  }

  /** List containers. */
  async listContainers(all?: boolean): Promise<ContainerStatus[]> {
    const args = ["ps", "--format", "json", "--no-trunc"];
    if (all) args.push("-a");

    const { stdout } = await this.exec(args);
    if (!stdout.trim()) return [];

    // docker ps --format json outputs one JSON object per line
    const lines = stdout.trim().split("\n").filter(Boolean);
    return lines.map((line) => {
      const obj = JSON.parse(line);
      return {
        id: obj.ID ?? "",
        name: obj.Names ?? "",
        image: obj.Image ?? "",
        state: this.mapState(obj.State ?? ""),
        ports: this.parsePorts(obj.Ports ?? ""),
        health: this.mapHealth(obj.Status ?? ""),
      };
    });
  }

  // ── Container Operations ────────────────────────────────────────

  /** Execute a command inside a running container. */
  async execInContainer(
    nameOrId: string,
    command: string[],
    timeoutMs?: number,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const args = ["exec", sanitizeContainerName(nameOrId), ...command];
    try {
      const { stdout, stderr } = await this.exec(args, timeoutMs);
      return { stdout, stderr, exitCode: 0 };
    } catch (err: unknown) {
      const e = err as { stdout?: string; stderr?: string; code?: number };
      return {
        stdout: e.stdout ?? "",
        stderr: e.stderr ?? "",
        exitCode: e.code ?? 1,
      };
    }
  }

  /** Get container logs. */
  async getContainerLogs(nameOrId: string, tail?: number): Promise<string> {
    const args = ["logs"];
    if (tail !== undefined) {
      args.push("--tail", String(Math.max(1, Math.floor(tail))));
    }
    args.push(sanitizeContainerName(nameOrId));
    const { stdout } = await this.exec(args);
    return stdout;
  }

  /** Copy a file from host into a container. */
  async copyToContainer(
    nameOrId: string,
    hostPath: string,
    containerPath: string,
  ): Promise<void> {
    await this.exec([
      "cp",
      sanitizePath(hostPath),
      `${sanitizeContainerName(nameOrId)}:${sanitizePath(containerPath)}`,
    ]);
  }

  /** Copy a file from a container to the host. */
  async copyFromContainer(
    nameOrId: string,
    containerPath: string,
    hostPath: string,
  ): Promise<void> {
    await this.exec([
      "cp",
      `${sanitizeContainerName(nameOrId)}:${sanitizePath(containerPath)}`,
      sanitizePath(hostPath),
    ]);
  }

  // ── Docker Compose ──────────────────────────────────────────────

  /** Start a compose stack in detached mode. */
  async composeUp(config: ComposeConfig, services?: string[]): Promise<void> {
    const args = this.composeBaseArgs(config);
    args.push("up", "-d");
    if (services) {
      for (const s of services) {
        args.push(sanitizeContainerName(s));
      }
    }
    await this.execCompose(args, config.env);
  }

  /** Stop and remove a compose stack. */
  async composeDown(config: ComposeConfig, removeVolumes?: boolean): Promise<void> {
    const args = this.composeBaseArgs(config);
    args.push("down");
    if (removeVolumes) args.push("-v");
    await this.execCompose(args, config.env);
  }

  /** List containers in a compose project. */
  async composePs(config: ComposeConfig): Promise<ContainerStatus[]> {
    const args = this.composeBaseArgs(config);
    args.push("ps", "--format", "json");

    const { stdout } = await this.execCompose(args, config.env);
    if (!stdout.trim()) return [];

    const lines = stdout.trim().split("\n").filter(Boolean);
    return lines.map((line) => {
      const obj = JSON.parse(line);
      return {
        id: obj.ID ?? "",
        name: obj.Name ?? obj.Names ?? "",
        image: obj.Image ?? "",
        state: this.mapState(obj.State ?? ""),
        ports: this.parsePorts(obj.Ports ?? ""),
        health: this.mapHealth(obj.Health ?? obj.Status ?? ""),
      };
    });
  }

  /** Get logs from compose services. */
  async composeLogs(
    config: ComposeConfig,
    services?: string[],
    tail?: number,
  ): Promise<string> {
    const args = this.composeBaseArgs(config);
    args.push("logs");
    if (tail !== undefined) {
      args.push("--tail", String(Math.max(1, Math.floor(tail))));
    }
    if (services) {
      for (const s of services) {
        args.push(sanitizeContainerName(s));
      }
    }
    const { stdout } = await this.execCompose(args, config.env);
    return stdout;
  }

  // ── Health Checks ───────────────────────────────────────────────

  /**
   * Wait for a container to become healthy.
   *
   * Polls `docker inspect` at 1-second intervals until the container
   * health status is "healthy" or the timeout expires.
   *
   * @returns true if the container became healthy, false on timeout.
   */
  async waitForHealthy(nameOrId: string, timeoutMs?: number): Promise<boolean> {
    const deadline = Date.now() + (timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const name = sanitizeContainerName(nameOrId);

    while (Date.now() < deadline) {
      try {
        const { stdout } = await this.exec([
          "inspect",
          "--format", "{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}",
          name,
        ]);
        const status = stdout.trim();
        if (status === "healthy") return true;
      } catch {
        // Container may not exist yet; keep polling
      }
      await this.sleep(1000);
    }
    return false;
  }

  /** Check if Docker is available on this system. */
  async isDockerAvailable(): Promise<boolean> {
    try {
      await this.exec(["version", "--format", "json"]);
      return true;
    } catch {
      return false;
    }
  }

  // ── Network ─────────────────────────────────────────────────────

  /** Create a Docker network. Returns the network ID. */
  async createNetwork(name: string, driver?: string): Promise<string> {
    const args = ["network", "create"];
    if (driver) {
      args.push("--driver", sanitizeLabel(driver));
    }
    args.push(sanitizeNetworkName(name));
    const { stdout } = await this.exec(args);
    return stdout.trim();
  }

  /** Remove a Docker network. */
  async removeNetwork(name: string): Promise<void> {
    await this.exec(["network", "rm", sanitizeNetworkName(name)]);
  }

  // ── Image Management ────────────────────────────────────────────

  /** Pull an image from a registry. */
  async pullImage(image: string): Promise<void> {
    await this.exec(["pull", sanitizeImageRef(image)], 300_000);
  }

  /** Check if an image exists locally. */
  async imageExists(image: string): Promise<boolean> {
    try {
      await this.exec(["image", "inspect", sanitizeImageRef(image)]);
      return true;
    } catch {
      return false;
    }
  }

  // ── Private Helpers ─────────────────────────────────────────────

  /** Execute a Docker CLI command via execFile. */
  private async exec(
    args: string[],
    timeoutMs?: number,
  ): Promise<{ stdout: string; stderr: string }> {
    const { stdout, stderr } = await execAsync(this.dockerPath, args, {
      timeout: timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024,
    });
    return { stdout, stderr };
  }

  /** Execute a Docker Compose command via execFile. */
  private async execCompose(
    args: string[],
    extraEnv?: Record<string, string>,
  ): Promise<{ stdout: string; stderr: string }> {
    const env = extraEnv
      ? { ...process.env, ...extraEnv }
      : process.env;

    const { stdout, stderr } = await execAsync(this.composePath, args, {
      timeout: DEFAULT_TIMEOUT_MS * 4,
      maxBuffer: 10 * 1024 * 1024,
      env: env as NodeJS.ProcessEnv,
    });
    return { stdout, stderr };
  }

  /** Build base args for docker compose commands. */
  private composeBaseArgs(config: ComposeConfig): string[] {
    return [
      "compose",
      "-f", sanitizePath(config.composeFile),
      "-p", sanitizeProjectName(config.projectName),
    ];
  }

  /** Map Docker state string to typed enum. */
  private mapState(
    state: string,
  ): ContainerStatus["state"] {
    const lower = state.toLowerCase();
    if (lower === "running") return "running";
    if (lower === "exited") return "exited";
    if (lower === "paused") return "paused";
    if (lower === "created") return "created";
    if (lower === "stopped" || lower === "dead") return "stopped";
    return "unknown";
  }

  /** Map health status from docker inspect or docker ps output. */
  private mapHealth(
    statusOrHealth: string,
  ): ContainerStatus["health"] {
    const lower = statusOrHealth.toLowerCase();
    if (lower.includes("healthy") && !lower.includes("unhealthy")) return "healthy";
    if (lower.includes("unhealthy")) return "unhealthy";
    if (lower.includes("starting")) return "starting";
    return "none";
  }

  /** Parse docker ps Ports string into a record. */
  private parsePorts(portsStr: string): Record<string, string> {
    const ports: Record<string, string> = {};
    if (!portsStr) return ports;

    // Example: "0.0.0.0:8080->80/tcp, 0.0.0.0:443->443/tcp"
    const parts = portsStr.split(",").map((s) => s.trim());
    for (const part of parts) {
      const match = part.match(/(\d+)->(\d+)/);
      if (match) {
        ports[match[1]] = match[2];
      }
    }
    return ports;
  }

  /** Parse docker inspect JSON to ContainerStatus. */
  private parseInspectToStatus(info: Record<string, unknown>): ContainerStatus {
    const state = info.State as Record<string, unknown> | undefined;
    const config = info.Config as Record<string, unknown> | undefined;
    const networkSettings = info.NetworkSettings as Record<string, unknown> | undefined;

    let healthStatus: ContainerStatus["health"] = "none";
    if (state?.Health) {
      const health = state.Health as Record<string, unknown>;
      healthStatus = this.mapHealth(String(health.Status ?? "none"));
    }

    const ports: Record<string, string> = {};
    if (networkSettings?.Ports) {
      const portsObj = networkSettings.Ports as Record<string, unknown>;
      for (const [containerPort, bindings] of Object.entries(portsObj)) {
        if (Array.isArray(bindings) && bindings.length > 0) {
          const binding = bindings[0] as Record<string, string>;
          const hostPort = binding.HostPort;
          const cp = containerPort.split("/")[0];
          if (hostPort && cp) {
            ports[hostPort] = cp;
          }
        }
      }
    }

    return {
      id: String(info.Id ?? "").slice(0, 12),
      name: String(info.Name ?? "").replace(/^\//, ""),
      image: String(config?.Image ?? ""),
      state: this.mapState(String(state?.Status ?? "unknown")),
      ports,
      health: healthStatus,
    };
  }

  /** Sleep for the given number of milliseconds. */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
