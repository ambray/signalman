/**
 * Programmatic docker-compose.yaml generation.
 *
 * Provides a builder API for constructing Docker Compose specifications
 * and serializing them to YAML. Includes a factory method for the
 * standard Ospiri backend stack used in E2E testing.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";

/** Docker Compose service definition. */
export interface ComposeService {
  /** Docker image. */
  image: string;
  /** Port mappings (e.g., ["8443:8443"]). */
  ports?: string[];
  /** Environment variables. */
  environment?: Record<string, string>;
  /** Volume mounts (e.g., ["backend-data:/data"]). */
  volumes?: string[];
  /** Services this service depends on. */
  depends_on?: string[];
  /** Health check configuration. */
  healthcheck?: {
    test: string[];
    interval: string;
    timeout: string;
    retries: number;
  };
  /** Networks to attach. */
  networks?: string[];
  /** Restart policy. */
  restart?: string;
}

/** Full Docker Compose specification. */
export interface ComposeSpec {
  /** Compose file version (optional, modern compose ignores this). */
  version?: string;
  /** Service definitions. */
  services: Record<string, ComposeService>;
  /** Network definitions. */
  networks?: Record<string, { driver?: string }>;
  /** Volume definitions. */
  volumes?: Record<string, { driver?: string }>;
}

/**
 * Builder for Docker Compose specifications.
 *
 * Provides a fluent API for building compose specs programmatically
 * and serializing them to YAML files.
 */
export class ComposeBuilder {
  private spec: ComposeSpec = { services: {} };

  /**
   * Add a service to the compose spec.
   *
   * @param name - Service name (e.g., "backend", "postgres").
   * @param service - Service configuration.
   * @returns this for chaining.
   */
  addService(name: string, service: ComposeService): this {
    this.spec.services[name] = service;
    return this;
  }

  /**
   * Add a named network.
   *
   * @param name - Network name.
   * @param driver - Network driver (default: bridge).
   * @returns this for chaining.
   */
  addNetwork(name: string, driver?: string): this {
    if (!this.spec.networks) this.spec.networks = {};
    this.spec.networks[name] = { driver: driver ?? "bridge" };
    return this;
  }

  /**
   * Add a named volume.
   *
   * @param name - Volume name.
   * @returns this for chaining.
   */
  addVolume(name: string): this {
    if (!this.spec.volumes) this.spec.volumes = {};
    this.spec.volumes[name] = {};
    return this;
  }

  /**
   * Generate the docker-compose.yaml content as a string.
   *
   * @returns YAML string representation of the compose spec.
   */
  toYaml(): string {
    // Clean up empty objects for cleaner output
    const output: Record<string, unknown> = {
      services: this.spec.services,
    };

    if (this.spec.networks && Object.keys(this.spec.networks).length > 0) {
      output.networks = this.spec.networks;
    }
    if (this.spec.volumes && Object.keys(this.spec.volumes).length > 0) {
      output.volumes = this.spec.volumes;
    }

    return YAML.stringify(output);
  }

  /**
   * Write the compose spec to a temporary file.
   *
   * @param dir - Directory to write to (defaults to OS temp dir).
   * @returns Absolute path to the written docker-compose.yaml file.
   */
  async writeToFile(dir?: string): Promise<string> {
    const targetDir = dir ?? os.tmpdir();
    const filePath = path.join(targetDir, `docker-compose-${Date.now()}.yaml`);
    await fs.promises.writeFile(filePath, this.toYaml(), "utf-8");
    return filePath;
  }

  /**
   * Get the underlying spec for inspection.
   *
   * @returns A deep clone of the current compose spec.
   */
  getSpec(): ComposeSpec {
    return structuredClone(this.spec);
  }

  /**
   * Create a standard Ospiri backend stack for E2E testing.
   *
   * Generates a ready-to-go compose spec with the Ospiri backend server
   * and optional PostgreSQL database. Defaults to SQLite for lightweight
   * testing.
   *
   * @param config - Backend stack configuration.
   * @returns A configured ComposeBuilder instance.
   */
  static ospiriBackendStack(config: {
    backendImage: string;
    backendPort?: number;
    dbType?: "sqlite" | "postgres";
    postgresImage?: string;
    jwtSecret?: string;
    extraEnv?: Record<string, string>;
  }): ComposeBuilder {
    const builder = new ComposeBuilder();
    const port = config.backendPort ?? 8443;
    const jwtSecret = config.jwtSecret ?? "test-secret-for-e2e";
    const dbType = config.dbType ?? "sqlite";

    const backendEnv: Record<string, string> = {
      JWT_SECRET: jwtSecret,
      RUST_LOG: "info",
      ...(config.extraEnv ?? {}),
    };

    const backendService: ComposeService = {
      image: config.backendImage,
      ports: [`${port}:${port}`],
      environment: backendEnv,
      healthcheck: {
        test: ["CMD", "curl", "-f", `http://localhost:${port}/health`],
        interval: "5s",
        timeout: "3s",
        retries: 5,
      },
      restart: "unless-stopped",
    };

    if (dbType === "postgres") {
      const pgImage = config.postgresImage ?? "postgres:16";

      backendEnv.DATABASE_URL = "postgres://ospiri:test-password@postgres:5432/ospiri";

      backendService.depends_on = ["postgres"];
      backendService.networks = ["backend"];

      builder.addService("postgres", {
        image: pgImage,
        environment: {
          POSTGRES_DB: "ospiri",
          POSTGRES_USER: "ospiri",
          POSTGRES_PASSWORD: "test-password",
        },
        healthcheck: {
          test: ["CMD-SHELL", "pg_isready -U ospiri"],
          interval: "5s",
          timeout: "3s",
          retries: 5,
        },
        volumes: ["postgres-data:/var/lib/postgresql/data"],
        networks: ["backend"],
        restart: "unless-stopped",
      });

      builder.addVolume("postgres-data");
      builder.addNetwork("backend");
    } else {
      // SQLite: mount a volume for the database file
      backendEnv.DATABASE_URL = "sqlite:///data/ospiri.db";
      backendService.volumes = ["backend-data:/data"];
      builder.addVolume("backend-data");
    }

    builder.addService("backend", backendService);

    return builder;
  }
}
