/**
 * Signalman configuration system.
 *
 * Loads configuration from YAML files with the following precedence:
 * 1. Explicit path passed to loadConfig()
 * 2. SIGNALMAN_CONFIG environment variable
 * 3. ./.signalman/config.yaml in the current working directory
 * 4. Legacy fallback (deprecated, removed in v0.2.0): ./signalman.yaml
 * 5. ~/.signalman/config.yaml in the user's home directory
 *
 * Environment variable overrides are supported for sensitive or
 * deployment-specific values.
 *
 * The .signalman/ layout was introduced in v0.1.0 (P0 MCP Surface
 * Inversion); see docs/design/p0-mcp-surface.md §2. The legacy
 * `signalman.yaml` continues to work with a deprecation warning until
 * v0.2.0.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import YAML from "yaml";

// ── Configuration Interface ────────────────────────────────────────

/** Signalman host configuration. */
export interface SignalmanConfig {
  /** Hypervisor backend settings. */
  hypervisor: {
    /** Which hypervisor backend to prefer.
     *
     * - "service": the signalman-service daemon (default; preferred-when-available, P1)
     * - "hyperv": direct PowerShell + gsudo elevation
     * - "vmware": VMware Workstation/Fusion via vmrun
     * - "tart": Tart on Apple Silicon macOS hosts
     */
    backend: "service" | "hyperv" | "vmware" | "tart";
    /** Path to vmrun executable (VMware only). */
    vmrunPath?: string;
    /** Path to tart executable (Tart/macOS only). */
    tartPath?: string;
    /** Default guest credentials for hypervisor-level operations. */
    guestCredentials?: {
      username: string;
      password: string;
    };
    /** Service transport override for development/alternate listeners. */
    service?: {
      host?: string;
      port?: number;
      certDir?: string;
    };
  };
  /** Guest agent connection settings. */
  guestAgent: {
    /** Default gRPC port for the guest agent. */
    defaultPort: number;
    /** Optional bearer token sent as `Authorization: Bearer <token>`. */
    authToken?: string;
    /** TLS settings for guest agent connections. */
    tls: {
      /** Whether TLS is enabled for guest agent connections. */
      enabled: boolean;
      /** Path to CA certificate (PEM). */
      caPath?: string;
      /** Path to client certificate (PEM) for mTLS. */
      certPath?: string;
      /** Path to client private key (PEM) for mTLS. */
      keyPath?: string;
    };
  };
  /** Scenario execution settings. */
  scenarios: {
    /** Directory containing scenario YAML files. */
    dir: string;
    /** Directory for test output and reports. */
    outputDir: string;
    /** Directory for VM screenshots. */
    screenshotDir: string;
  };
  /** Optional hub API settings for result reporting. */
  hub?: {
    /** Hub API URL. */
    apiUrl: string;
    /** Hub API key for authentication. */
    apiKey: string;
  };
  /** Optional Docker configuration for container orchestration. */
  docker?: {
    /** Path to docker binary (default: "docker"). */
    path?: string;
    /** Path to docker compose binary (default: "docker"). */
    composePath?: string;
    /** Default Docker network name for test containers. */
    defaultNetwork?: string;
    /** Registry auth token for private registries. */
    registryAuth?: string;
  };
  /**
   * Optional logical-to-physical VM-name aliases.
   *
   * Scenarios reference VMs by stable logical names ("endpoint-1");
   * the actual hypervisor name varies per machine. The orchestrator
   * (see scenarios/orchestrator.ts:1220) consults this map when
   * resolving a scenario's `vms[]` entry against `backend.listVMs()`.
   *
   * The field was used by user configs (e.g. signalman.yaml) before
   * P0; making it part of the typed schema closes a long-standing
   * tsc error in the orchestrator.
   */
  vmAliases?: Record<string, string>;
}

// ── Default Configuration ──────────────────────────────────────────

/**
 * Returns the default configuration with sensible values.
 *
 * All paths are relative to the current working directory unless
 * overridden by environment variables or config file.
 */
export function defaultConfig(): SignalmanConfig {
  return {
    hypervisor: {
      backend: "service",
    },
    guestAgent: {
      defaultPort: 50051,
      tls: {
        enabled: false,
      },
    },
    scenarios: {
      // v0.1.0 default — see docs/design/p0-mcp-surface.md §2.
      // Legacy `./scenarios` is still honored by the runner via the
      // project-layout fallback in src/scenarios/project-layout.ts.
      dir: "./.signalman/scenarios",
      outputDir: "./output",
      screenshotDir: "./output/screenshots",
    },
  };
}

// ── Configuration Loading ──────────────────────────────────────────

/** One-time deprecation warning latch for legacy `signalman.yaml`. */
let warnedLegacyConfig = false;

/** Candidate paths to search for the config file. */
function configSearchPaths(): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  const add = (candidate: string) => {
    const resolved = path.resolve(candidate);
    if (!seen.has(resolved)) {
      seen.add(resolved);
      paths.push(resolved);
    }
  };

  // Environment variable override
  const envPath = process.env.SIGNALMAN_CONFIG;
  if (envPath) {
    add(envPath);
  }

  // CWD — `.signalman/config.yaml` takes precedence over the legacy
  // `signalman.yaml`. The legacy path stays accessible during v0.1.0
  // for backwards compat; v0.2.0 will drop it (TODO marker).
  let dir = process.cwd();
  while (true) {
    add(path.join(dir, ".signalman", "config.yaml"));
    add(path.join(dir, "signalman.yaml"));
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // Home directory
  const home = os.homedir();
  add(path.resolve(home, ".signalman", "config.yaml"));

  return paths;
}

function configBaseDir(configPath: string): string {
  const dir = path.dirname(configPath);
  if (path.basename(configPath) === "config.yaml" && path.basename(dir) === ".signalman") {
    return path.dirname(dir);
  }
  return dir;
}

function resolveConfigPath(value: string | undefined, baseDir: string): string | undefined {
  if (!value || path.isAbsolute(value) || path.win32.isAbsolute(value)) {
    return value;
  }
  return path.resolve(baseDir, value);
}

function normalizeConfigPaths(
  config: SignalmanConfig,
  baseDir: string | undefined,
): SignalmanConfig {
  if (!baseDir) return config;
  const result = structuredClone(config);
  if (result.hypervisor.service?.certDir) {
    result.hypervisor.service.certDir = resolveConfigPath(
      result.hypervisor.service.certDir,
      baseDir,
    );
  }
  if (result.guestAgent.tls.caPath) {
    result.guestAgent.tls.caPath = resolveConfigPath(result.guestAgent.tls.caPath, baseDir);
  }
  if (result.guestAgent.tls.certPath) {
    result.guestAgent.tls.certPath = resolveConfigPath(result.guestAgent.tls.certPath, baseDir);
  }
  if (result.guestAgent.tls.keyPath) {
    result.guestAgent.tls.keyPath = resolveConfigPath(result.guestAgent.tls.keyPath, baseDir);
  }
  result.scenarios.dir = resolveConfigPath(result.scenarios.dir, baseDir) ?? result.scenarios.dir;
  result.scenarios.outputDir =
    resolveConfigPath(result.scenarios.outputDir, baseDir) ?? result.scenarios.outputDir;
  result.scenarios.screenshotDir =
    resolveConfigPath(result.scenarios.screenshotDir, baseDir) ?? result.scenarios.screenshotDir;
  return result;
}

/**
 * Deep-merges a partial config object into a base config.
 * Only sets values that are actually present in the partial.
 */
function mergeConfig(
  base: SignalmanConfig,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  partial: Record<string, any>,
): SignalmanConfig {
  const result = structuredClone(base);

  if (partial.hypervisor) {
    if (partial.hypervisor.backend) {
      result.hypervisor.backend = partial.hypervisor.backend;
    }
    if (partial.hypervisor.vmrunPath !== undefined) {
      result.hypervisor.vmrunPath = partial.hypervisor.vmrunPath;
    }
    if (partial.hypervisor.tartPath !== undefined) {
      result.hypervisor.tartPath = partial.hypervisor.tartPath;
    }
    if (partial.hypervisor.guestCredentials) {
      result.hypervisor.guestCredentials = partial.hypervisor.guestCredentials;
    }
    if (partial.hypervisor.service) {
      result.hypervisor.service = {
        ...(result.hypervisor.service ?? {}),
      };
      if (partial.hypervisor.service.host !== undefined) {
        result.hypervisor.service.host = partial.hypervisor.service.host;
      }
      if (partial.hypervisor.service.port !== undefined) {
        result.hypervisor.service.port = partial.hypervisor.service.port;
      }
      if (partial.hypervisor.service.certDir !== undefined) {
        result.hypervisor.service.certDir = partial.hypervisor.service.certDir;
      }
    }
  }

  if (partial.guestAgent) {
    if (partial.guestAgent.defaultPort !== undefined) {
      result.guestAgent.defaultPort = partial.guestAgent.defaultPort;
    }
    if (partial.guestAgent.authToken !== undefined) {
      result.guestAgent.authToken = partial.guestAgent.authToken;
    }
    if (partial.guestAgent.tls) {
      if (partial.guestAgent.tls.enabled !== undefined) {
        result.guestAgent.tls.enabled = partial.guestAgent.tls.enabled;
      }
      if (partial.guestAgent.tls.caPath !== undefined) {
        result.guestAgent.tls.caPath = partial.guestAgent.tls.caPath;
      }
      if (partial.guestAgent.tls.certPath !== undefined) {
        result.guestAgent.tls.certPath = partial.guestAgent.tls.certPath;
      }
      if (partial.guestAgent.tls.keyPath !== undefined) {
        result.guestAgent.tls.keyPath = partial.guestAgent.tls.keyPath;
      }
    }
  }

  if (partial.scenarios) {
    if (partial.scenarios.dir !== undefined) {
      result.scenarios.dir = partial.scenarios.dir;
    }
    if (partial.scenarios.outputDir !== undefined) {
      result.scenarios.outputDir = partial.scenarios.outputDir;
    }
    if (partial.scenarios.screenshotDir !== undefined) {
      result.scenarios.screenshotDir = partial.scenarios.screenshotDir;
    }
  }

  if (partial.hub) {
    result.hub = {
      apiUrl: partial.hub.apiUrl ?? "",
      apiKey: partial.hub.apiKey ?? "",
    };
  }

  if (partial.vmAliases && typeof partial.vmAliases === "object") {
    result.vmAliases = { ...(result.vmAliases ?? {}), ...partial.vmAliases };
  }

  if (partial.docker) {
    result.docker = {
      ...(result.docker ?? {}),
    };
    if (partial.docker.path !== undefined) {
      result.docker.path = partial.docker.path;
    }
    if (partial.docker.composePath !== undefined) {
      result.docker.composePath = partial.docker.composePath;
    }
    if (partial.docker.defaultNetwork !== undefined) {
      result.docker.defaultNetwork = partial.docker.defaultNetwork;
    }
    if (partial.docker.registryAuth !== undefined) {
      result.docker.registryAuth = partial.docker.registryAuth;
    }
  }

  return result;
}

/**
 * Applies environment variable overrides to the configuration.
 *
 * Supported environment variables:
 * - SIGNALMAN_BACKEND: hypervisor backend ("service" | "hyperv" | "vmware" | "tart")
 * - SIGNALMAN_SERVICE_HOST: service backend host
 * - SIGNALMAN_SERVICE_PORT: service backend port
 * - SIGNALMAN_SERVICE_CERT_DIR: service backend cert directory
 * - SIGNALMAN_VMRUN_PATH: path to vmrun executable
 * - SIGNALMAN_TART_PATH: path to tart executable
 * - SIGNALMAN_GUEST_PORT: guest agent default port
 * - SIGNALMAN_GUEST_TOKEN: guest agent bearer token
 * - SIGNALMAN_GUEST_TLS: enable guest agent TLS ("true" | "false")
 * - SIGNALMAN_GUEST_CA: path to CA certificate
 * - SIGNALMAN_GUEST_CERT: path to client certificate
 * - SIGNALMAN_GUEST_KEY: path to client key
 * - SIGNALMAN_SCENARIOS_DIR: scenarios directory
 * - SIGNALMAN_OUTPUT_DIR: output directory
 * - SIGNALMAN_SCREENSHOT_DIR: screenshot directory
 * - SIGNALMAN_HUB_URL: hub API URL
 * - SIGNALMAN_HUB_KEY: hub API key
 */
function applyEnvOverrides(config: SignalmanConfig): SignalmanConfig {
  const result = structuredClone(config);

  const backend = process.env.SIGNALMAN_BACKEND;
  if (backend === "hyperv" || backend === "vmware" || backend === "service" || backend === "tart") {
    result.hypervisor.backend = backend;
  }

  const serviceHost = process.env.SIGNALMAN_SERVICE_HOST;
  const servicePort = process.env.SIGNALMAN_SERVICE_PORT;
  const serviceCertDir = process.env.SIGNALMAN_SERVICE_CERT_DIR;
  if (serviceHost || servicePort || serviceCertDir) {
    result.hypervisor.service = {
      ...(result.hypervisor.service ?? {}),
    };
    if (serviceHost) result.hypervisor.service.host = serviceHost;
    if (servicePort) {
      const parsed = parseInt(servicePort, 10);
      if (!isNaN(parsed) && parsed > 0 && parsed <= 65535) {
        result.hypervisor.service.port = parsed;
      }
    }
    if (serviceCertDir) result.hypervisor.service.certDir = serviceCertDir;
  }

  if (process.env.SIGNALMAN_VMRUN_PATH) {
    result.hypervisor.vmrunPath = process.env.SIGNALMAN_VMRUN_PATH;
  }

  if (process.env.SIGNALMAN_TART_PATH) {
    result.hypervisor.tartPath = process.env.SIGNALMAN_TART_PATH;
  }

  const guestPort = process.env.SIGNALMAN_GUEST_PORT;
  if (guestPort) {
    const parsed = parseInt(guestPort, 10);
    if (!isNaN(parsed) && parsed > 0 && parsed <= 65535) {
      result.guestAgent.defaultPort = parsed;
    }
  }

  if (process.env.SIGNALMAN_GUEST_TOKEN) {
    result.guestAgent.authToken = process.env.SIGNALMAN_GUEST_TOKEN;
  }

  const guestTls = process.env.SIGNALMAN_GUEST_TLS;
  if (guestTls === "true") result.guestAgent.tls.enabled = true;
  if (guestTls === "false") result.guestAgent.tls.enabled = false;

  if (process.env.SIGNALMAN_GUEST_CA) {
    result.guestAgent.tls.caPath = process.env.SIGNALMAN_GUEST_CA;
  }
  if (process.env.SIGNALMAN_GUEST_CERT) {
    result.guestAgent.tls.certPath = process.env.SIGNALMAN_GUEST_CERT;
  }
  if (process.env.SIGNALMAN_GUEST_KEY) {
    result.guestAgent.tls.keyPath = process.env.SIGNALMAN_GUEST_KEY;
  }

  if (process.env.SIGNALMAN_SCENARIOS_DIR) {
    result.scenarios.dir = process.env.SIGNALMAN_SCENARIOS_DIR;
  }
  if (process.env.SIGNALMAN_OUTPUT_DIR) {
    result.scenarios.outputDir = process.env.SIGNALMAN_OUTPUT_DIR;
  }
  if (process.env.SIGNALMAN_SCREENSHOT_DIR) {
    result.scenarios.screenshotDir = process.env.SIGNALMAN_SCREENSHOT_DIR;
  }

  const hubUrl = process.env.SIGNALMAN_HUB_URL;
  const hubKey = process.env.SIGNALMAN_HUB_KEY;
  if (hubUrl || hubKey) {
    result.hub = {
      apiUrl: hubUrl ?? result.hub?.apiUrl ?? "",
      apiKey: hubKey ?? result.hub?.apiKey ?? "",
    };
  }

  const dockerPath = process.env.SIGNALMAN_DOCKER_PATH;
  const dockerComposePath = process.env.SIGNALMAN_DOCKER_COMPOSE_PATH;
  const dockerNetwork = process.env.SIGNALMAN_DOCKER_NETWORK;
  const dockerRegistryAuth = process.env.SIGNALMAN_DOCKER_REGISTRY_AUTH;
  if (dockerPath || dockerComposePath || dockerNetwork || dockerRegistryAuth) {
    result.docker = {
      ...(result.docker ?? {}),
    };
    if (dockerPath) result.docker.path = dockerPath;
    if (dockerComposePath) result.docker.composePath = dockerComposePath;
    if (dockerNetwork) result.docker.defaultNetwork = dockerNetwork;
    if (dockerRegistryAuth) result.docker.registryAuth = dockerRegistryAuth;
  }

  return result;
}

/**
 * Loads the Signalman configuration.
 *
 * Resolution order:
 * 1. If configPath is provided, load that file (error if not found).
 * 2. Otherwise, search the standard paths (CWD, home dir).
 * 3. Start with defaults, merge file config, apply env overrides.
 *
 * @param configPath - Optional explicit path to a YAML config file.
 * @returns The resolved SignalmanConfig.
 */
export function loadConfig(configPath?: string): SignalmanConfig {
  let config = defaultConfig();
  let loadedConfigPath: string | undefined;

  if (configPath) {
    // Explicit path: must exist
    const resolved = path.resolve(configPath);
    if (!fs.existsSync(resolved)) {
      throw new Error(`Configuration file not found: ${resolved}`);
    }
    const raw = fs.readFileSync(resolved, "utf-8");
    const parsed = YAML.parse(raw, { maxAliasCount: 100 }) as Record<string, unknown>;
    if (parsed && typeof parsed === "object") {
      config = mergeConfig(config, parsed);
    }
    loadedConfigPath = resolved;
  } else {
    // Search standard paths
    const candidates = configSearchPaths();
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        // Emit a one-time deprecation warning when the legacy
        // top-level signalman.yaml is the chosen file. TODO(v0.2.0):
        // drop the legacy file entirely.
        if (
          !warnedLegacyConfig &&
          path.basename(candidate) === "signalman.yaml" &&
          path.basename(path.dirname(candidate)) !== ".signalman"
        ) {
          warnedLegacyConfig = true;
          console.error(
            `[signalman] DEPRECATION: ${candidate} is the legacy config location. ` +
              `Move it to .signalman/config.yaml; the legacy fallback is removed in v0.2.0.`,
          );
        }
        const raw = fs.readFileSync(candidate, "utf-8");
        const parsed = YAML.parse(raw, { maxAliasCount: 100 }) as Record<string, unknown>;
        if (parsed && typeof parsed === "object") {
          config = mergeConfig(config, parsed);
        }
        loadedConfigPath = candidate;
        break; // Use first found
      }
    }
  }

  // Environment overrides always win
  config = applyEnvOverrides(config);
  config = normalizeConfigPaths(
    config,
    loadedConfigPath ? configBaseDir(loadedConfigPath) : undefined,
  );

  return config;
}
