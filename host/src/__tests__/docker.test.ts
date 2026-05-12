import { describe, it, expect, vi, beforeEach } from "vitest";
import { ComposeBuilder } from "../docker/compose-builder.js";
import YAML from "yaml";

// ── Mock child_process.execFile ──────────────────────────────────

const mockExecFile = vi.fn();

vi.mock("node:child_process", () => ({
  execFile: (() => {})  // placeholder — promisify replaces it
}));

vi.mock("node:util", () => ({
  promisify: () => mockExecFile,
}));

// Import DockerClient after mocks are set up (hoisted)
const { DockerClient } = await import("../docker/client.js");
type ContainerConfig = import("../docker/client.js").ContainerConfig;

/** Helper: resolve mockExecFile with stdout/stderr. */
function mockExecSuccess(stdout = "", stderr = "") {
  mockExecFile.mockResolvedValueOnce({ stdout, stderr });
}

/** Helper: reject mockExecFile with an error. */
function mockExecFailure(message = "command failed", code = 1) {
  const err = new Error(message) as Error & {
    stdout: string;
    stderr: string;
    code: number;
  };
  err.stdout = "";
  err.stderr = message;
  err.code = code;
  mockExecFile.mockRejectedValueOnce(err);
}

describe("DockerClient", () => {
  let client: DockerClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new DockerClient();
  });

  // ── isDockerAvailable ────────────────────────────────────────

  describe("isDockerAvailable", () => {
    it("returns true when docker version succeeds", async () => {
      mockExecSuccess('{"Client":{"Version":"24.0.0"}}');
      const result = await client.isDockerAvailable();
      expect(result).toBe(true);
      expect(mockExecFile).toHaveBeenCalledWith(
        "docker",
        ["version", "--format", "json"],
        expect.objectContaining({ timeout: 30_000 }),
      );
    });

    it("returns false when docker is not installed", async () => {
      mockExecFailure("command not found");
      const result = await client.isDockerAvailable();
      expect(result).toBe(false);
    });
  });

  // ── createContainer ──────────────────────────────────────────

  describe("createContainer", () => {
    it("builds correct args from minimal config", async () => {
      mockExecSuccess("abc123def456\n");
      const config: ContainerConfig = {
        image: "nginx:latest",
        name: "test-nginx",
      };
      const id = await client.createContainer(config);
      expect(id).toBe("abc123def456");
      expect(mockExecFile).toHaveBeenCalledWith(
        "docker",
        ["create", "--name", "test-nginx", "nginx:latest"],
        expect.any(Object),
      );
    });

    it("includes port mappings", async () => {
      mockExecSuccess("abc123\n");
      const config: ContainerConfig = {
        image: "nginx:latest",
        name: "test-nginx",
        ports: { "8080": "80", "8443": "443" },
      };
      await client.createContainer(config);
      const args = mockExecFile.mock.calls[0][1] as string[];
      expect(args).toContain("-p");
      expect(args).toContain("8080:80");
      expect(args).toContain("8443:443");
    });

    it("includes environment variables", async () => {
      mockExecSuccess("abc123\n");
      const config: ContainerConfig = {
        image: "postgres:16",
        name: "test-pg",
        env: { POSTGRES_DB: "test", POSTGRES_USER: "admin" },
      };
      await client.createContainer(config);
      const args = mockExecFile.mock.calls[0][1] as string[];
      expect(args).toContain("-e");
      expect(args).toContain("POSTGRES_DB=test");
      expect(args).toContain("POSTGRES_USER=admin");
    });

    it("includes volume mounts", async () => {
      mockExecSuccess("abc123\n");
      const config: ContainerConfig = {
        image: "nginx:latest",
        name: "test-nginx",
        volumes: { "/host/data": "/container/data" },
      };
      await client.createContainer(config);
      const args = mockExecFile.mock.calls[0][1] as string[];
      expect(args).toContain("-v");
      expect(args).toContain("/host/data:/container/data");
    });

    it("rejects invalid container names", async () => {
      const config: ContainerConfig = {
        image: "nginx:latest",
        name: "invalid name with spaces!",
      };
      await expect(client.createContainer(config)).rejects.toThrow(
        "Invalid container name",
      );
    });
  });

  // ── startContainer / stopContainer ───────────────────────────

  describe("startContainer", () => {
    it("calls docker start with correct name", async () => {
      mockExecSuccess();
      await client.startContainer("my-container");
      expect(mockExecFile).toHaveBeenCalledWith(
        "docker",
        ["start", "my-container"],
        expect.any(Object),
      );
    });
  });

  describe("stopContainer", () => {
    it("calls docker stop with correct name", async () => {
      mockExecSuccess();
      await client.stopContainer("my-container");
      expect(mockExecFile).toHaveBeenCalledWith(
        "docker",
        ["stop", "my-container"],
        expect.any(Object),
      );
    });

    it("passes timeout flag when specified", async () => {
      mockExecSuccess();
      await client.stopContainer("my-container", 10);
      const args = mockExecFile.mock.calls[0][1] as string[];
      expect(args).toContain("-t");
      expect(args).toContain("10");
    });
  });

  // ── removeContainer ──────────────────────────────────────────

  describe("removeContainer", () => {
    it("calls docker rm", async () => {
      mockExecSuccess();
      await client.removeContainer("my-container");
      expect(mockExecFile).toHaveBeenCalledWith(
        "docker",
        ["rm", "my-container"],
        expect.any(Object),
      );
    });

    it("includes force flag", async () => {
      mockExecSuccess();
      await client.removeContainer("my-container", true);
      const args = mockExecFile.mock.calls[0][1] as string[];
      expect(args).toContain("-f");
    });
  });

  // ── listContainers ───────────────────────────────────────────

  describe("listContainers", () => {
    it("parses JSON output from docker ps", async () => {
      const jsonLines = [
        '{"ID":"abc123","Names":"web","Image":"nginx","State":"running","Ports":"0.0.0.0:8080->80/tcp","Status":"Up 5 minutes (healthy)"}',
        '{"ID":"def456","Names":"db","Image":"postgres:16","State":"exited","Ports":"","Status":"Exited (0) 2 hours ago"}',
      ].join("\n");
      mockExecSuccess(jsonLines);

      const containers = await client.listContainers();
      expect(containers).toHaveLength(2);
      expect(containers[0].name).toBe("web");
      expect(containers[0].state).toBe("running");
      expect(containers[0].health).toBe("healthy");
      expect(containers[0].ports).toEqual({ "8080": "80" });
      expect(containers[1].state).toBe("exited");
    });

    it("returns empty array for no containers", async () => {
      mockExecSuccess("");
      const containers = await client.listContainers();
      expect(containers).toEqual([]);
    });

    it("passes -a flag when all=true", async () => {
      mockExecSuccess("");
      await client.listContainers(true);
      const args = mockExecFile.mock.calls[0][1] as string[];
      expect(args).toContain("-a");
    });
  });

  // ── getContainerStatus ───────────────────────────────────────

  describe("getContainerStatus", () => {
    it("parses docker inspect output", async () => {
      const inspectJson = JSON.stringify([
        {
          Id: "abc123def456789",
          Name: "/test-container",
          Config: { Image: "nginx:latest" },
          State: {
            Status: "running",
            Health: { Status: "healthy" },
          },
          NetworkSettings: {
            Ports: {
              "80/tcp": [{ HostIp: "0.0.0.0", HostPort: "8080" }],
            },
          },
        },
      ]);
      mockExecSuccess(inspectJson);

      const status = await client.getContainerStatus("test-container");
      expect(status.name).toBe("test-container");
      expect(status.state).toBe("running");
      expect(status.health).toBe("healthy");
      expect(status.ports).toEqual({ "8080": "80" });
    });
  });

  // ── execInContainer ──────────────────────────────────────────

  describe("execInContainer", () => {
    it("returns stdout, stderr, and exitCode on success", async () => {
      mockExecSuccess("hello world\n", "");
      const result = await client.execInContainer("my-container", [
        "echo",
        "hello world",
      ]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("hello world\n");
    });

    it("handles command failure with non-zero exit code", async () => {
      mockExecFailure("command not found", 127);
      const result = await client.execInContainer("my-container", [
        "nonexistent",
      ]);
      expect(result.exitCode).toBe(127);
    });

    it("passes timeout to underlying exec", async () => {
      mockExecSuccess("ok");
      await client.execInContainer("my-container", ["ls"], 5000);
      expect(mockExecFile).toHaveBeenCalledWith(
        "docker",
        ["exec", "my-container", "ls"],
        expect.objectContaining({ timeout: 5000 }),
      );
    });
  });

  // ── getContainerLogs ─────────────────────────────────────────

  describe("getContainerLogs", () => {
    it("returns logs with tail limit", async () => {
      mockExecSuccess("line1\nline2\nline3\n");
      const logs = await client.getContainerLogs("my-container", 3);
      expect(logs).toContain("line1");
      const args = mockExecFile.mock.calls[0][1] as string[];
      expect(args).toContain("--tail");
      expect(args).toContain("3");
    });

    it("returns all logs when no tail specified", async () => {
      mockExecSuccess("all logs here");
      const logs = await client.getContainerLogs("my-container");
      expect(logs).toBe("all logs here");
      const args = mockExecFile.mock.calls[0][1] as string[];
      expect(args).not.toContain("--tail");
    });
  });

  // ── copyToContainer / copyFromContainer ──────────────────────

  describe("copyToContainer", () => {
    it("builds correct docker cp command", async () => {
      mockExecSuccess();
      await client.copyToContainer(
        "my-container",
        "/host/file.txt",
        "/container/file.txt",
      );
      expect(mockExecFile).toHaveBeenCalledWith(
        "docker",
        ["cp", "/host/file.txt", "my-container:/container/file.txt"],
        expect.any(Object),
      );
    });
  });

  describe("copyFromContainer", () => {
    it("builds correct docker cp command", async () => {
      mockExecSuccess();
      await client.copyFromContainer(
        "my-container",
        "/container/output.log",
        "/host/output.log",
      );
      expect(mockExecFile).toHaveBeenCalledWith(
        "docker",
        ["cp", "my-container:/container/output.log", "/host/output.log"],
        expect.any(Object),
      );
    });
  });

  // ── composeUp ────────────────────────────────────────────────

  describe("composeUp", () => {
    it("runs docker compose up -d with project name", async () => {
      mockExecSuccess(); // compose up
      await client.composeUp({
        projectName: "test-project",
        composeFile: "/path/to/docker-compose.yaml",
      });
      const args = mockExecFile.mock.calls[0][1] as string[];
      expect(args).toEqual([
        "compose",
        "-f",
        "/path/to/docker-compose.yaml",
        "-p",
        "test-project",
        "up",
        "-d",
      ]);
    });

    it("passes specific services when provided", async () => {
      mockExecSuccess();
      await client.composeUp(
        {
          projectName: "test-project",
          composeFile: "/path/to/docker-compose.yaml",
        },
        ["backend", "postgres"],
      );
      const args = mockExecFile.mock.calls[0][1] as string[];
      expect(args).toContain("backend");
      expect(args).toContain("postgres");
    });
  });

  // ── composeDown ──────────────────────────────────────────────

  describe("composeDown", () => {
    it("runs docker compose down", async () => {
      mockExecSuccess();
      await client.composeDown({
        projectName: "test-project",
        composeFile: "/path/to/docker-compose.yaml",
      });
      const args = mockExecFile.mock.calls[0][1] as string[];
      expect(args).toContain("down");
      expect(args).not.toContain("-v");
    });

    it("includes -v flag when removeVolumes is true", async () => {
      mockExecSuccess();
      await client.composeDown(
        {
          projectName: "test-project",
          composeFile: "/path/to/docker-compose.yaml",
        },
        true,
      );
      const args = mockExecFile.mock.calls[0][1] as string[];
      expect(args).toContain("-v");
    });
  });

  // ── composePs ────────────────────────────────────────────────

  describe("composePs", () => {
    it("parses compose ps JSON output", async () => {
      const jsonLines = [
        '{"ID":"abc","Name":"backend","Image":"example:latest","State":"running","Ports":"8443","Health":"healthy"}',
      ].join("\n");
      mockExecSuccess(jsonLines);

      const result = await client.composePs({
        projectName: "test",
        composeFile: "/path/compose.yaml",
      });
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe("backend");
    });
  });

  // ── waitForHealthy ───────────────────────────────────────────

  describe("waitForHealthy", () => {
    it("returns true when container becomes healthy", async () => {
      mockExecSuccess("healthy\n");
      const result = await client.waitForHealthy("my-container", 5000);
      expect(result).toBe(true);
    });

    it("returns false on timeout when unhealthy", async () => {
      // Always return "starting" — mock will keep returning this
      mockExecFile.mockResolvedValue({ stdout: "starting\n", stderr: "" });
      const result = await client.waitForHealthy("my-container", 1500);
      expect(result).toBe(false);
      // Reset to default cleared state
      mockExecFile.mockReset();
    });
  });

  // ── createNetwork / removeNetwork ────────────────────────────

  describe("createNetwork", () => {
    it("runs docker network create", async () => {
      mockExecSuccess("net123\n");
      const id = await client.createNetwork("test-net");
      expect(id).toBe("net123");
      const args = mockExecFile.mock.calls[0][1] as string[];
      expect(args).toEqual(["network", "create", "test-net"]);
    });

    it("passes driver when specified", async () => {
      mockExecSuccess("net123\n");
      await client.createNetwork("test-net", "overlay");
      const args = mockExecFile.mock.calls[0][1] as string[];
      expect(args).toContain("--driver");
      expect(args).toContain("overlay");
    });
  });

  describe("removeNetwork", () => {
    it("runs docker network rm", async () => {
      mockExecSuccess();
      await client.removeNetwork("test-net");
      expect(mockExecFile).toHaveBeenCalledWith(
        "docker",
        ["network", "rm", "test-net"],
        expect.any(Object),
      );
    });
  });

  // ── pullImage / imageExists ──────────────────────────────────

  describe("pullImage", () => {
    it("runs docker pull with correct image", async () => {
      mockExecSuccess();
      await client.pullImage("nginx:latest");
      expect(mockExecFile).toHaveBeenCalledWith(
        "docker",
        ["pull", "nginx:latest"],
        expect.objectContaining({ timeout: 300_000 }),
      );
    });
  });

  describe("imageExists", () => {
    it("returns true when image exists", async () => {
      mockExecSuccess("{}");
      const exists = await client.imageExists("nginx:latest");
      expect(exists).toBe(true);
    });

    it("returns false when image does not exist", async () => {
      mockExecFailure("No such image");
      const exists = await client.imageExists("nonexistent:v1");
      expect(exists).toBe(false);
    });
  });

  // ── Input sanitization ───────────────────────────────────────

  describe("input sanitization", () => {
    it("rejects container names with shell metacharacters", async () => {
      await expect(
        client.startContainer("test; rm -rf /"),
      ).rejects.toThrow("Invalid container name");
    });

    it("rejects image refs with shell metacharacters", async () => {
      const config: ContainerConfig = {
        image: "$(evil)",
        name: "test",
      };
      await expect(client.createContainer(config)).rejects.toThrow(
        "Invalid image reference",
      );
    });
  });
});

// ── ComposeBuilder Tests ───────────────────────────────────────

describe("ComposeBuilder", () => {
  describe("addService", () => {
    it("adds a service to the spec", () => {
      const builder = new ComposeBuilder();
      builder.addService("web", {
        image: "nginx:latest",
        ports: ["8080:80"],
      });
      const spec = builder.getSpec();
      expect(spec.services.web).toBeDefined();
      expect(spec.services.web.image).toBe("nginx:latest");
    });

    it("supports chaining", () => {
      const builder = new ComposeBuilder();
      const result = builder
        .addService("web", { image: "nginx" })
        .addService("db", { image: "postgres:16" });
      expect(result).toBe(builder);
      expect(Object.keys(builder.getSpec().services)).toHaveLength(2);
    });
  });

  describe("toYaml", () => {
    it("produces valid YAML with services", () => {
      const builder = new ComposeBuilder();
      builder.addService("web", {
        image: "nginx:latest",
        ports: ["8080:80"],
        environment: { NODE_ENV: "test" },
      });

      const yamlStr = builder.toYaml();
      const parsed = YAML.parse(yamlStr);

      expect(parsed.services).toBeDefined();
      expect(parsed.services.web.image).toBe("nginx:latest");
      expect(parsed.services.web.ports).toEqual(["8080:80"]);
      expect(parsed.services.web.environment.NODE_ENV).toBe("test");
    });

    it("includes networks and volumes when defined", () => {
      const builder = new ComposeBuilder();
      builder
        .addService("web", { image: "nginx" })
        .addNetwork("backend", "bridge")
        .addVolume("data");

      const yamlStr = builder.toYaml();
      const parsed = YAML.parse(yamlStr);

      expect(parsed.networks).toBeDefined();
      expect(parsed.networks.backend.driver).toBe("bridge");
      expect(parsed.volumes).toBeDefined();
      expect(parsed.volumes.data).toBeDefined();
    });

    it("omits networks and volumes when empty", () => {
      const builder = new ComposeBuilder();
      builder.addService("web", { image: "nginx" });

      const yamlStr = builder.toYaml();
      const parsed = YAML.parse(yamlStr);

      expect(parsed.networks).toBeUndefined();
      expect(parsed.volumes).toBeUndefined();
    });
  });

  describe("exampleBackendStack", () => {
    it("creates a sqlite backend stack by default", () => {
      const builder = ComposeBuilder.exampleBackendStack({
        backendImage: "example-backend:latest",
      });
      const spec = builder.getSpec();

      expect(spec.services.backend).toBeDefined();
      expect(spec.services.backend.image).toBe("example-backend:latest");
      expect(spec.services.backend.ports).toEqual(["8443:8443"]);
      expect(spec.services.backend.environment?.DATABASE_URL).toContain(
        "sqlite",
      );
      // Default JWT secret is randomly generated per stack (32 random
      // bytes → 64 hex chars). See F1/F2 fix in
      // `host/src/docker/compose-builder.ts`: hardcoded defaults were
      // replaced to avoid static-scanner findings on the public repo.
      expect(spec.services.backend.environment?.JWT_SECRET).toMatch(
        /^[0-9a-f]{64}$/,
      );
      expect(spec.services.backend.healthcheck).toBeDefined();
      expect(spec.volumes?.["backend-data"]).toBeDefined();
    });

    it("creates a postgres backend stack when requested", () => {
      const builder = ComposeBuilder.exampleBackendStack({
        backendImage: "example-backend:latest",
        dbType: "postgres",
      });
      const spec = builder.getSpec();

      expect(spec.services.backend).toBeDefined();
      expect(spec.services.postgres).toBeDefined();
      expect(spec.services.postgres.image).toBe("postgres:16");
      expect(spec.services.backend.depends_on).toContain("postgres");
      expect(spec.services.backend.environment?.DATABASE_URL).toContain(
        "postgres",
      );
      // Default Postgres password is randomly generated per stack.
      // Assert format only — the literal value differs every call.
      expect(spec.services.postgres.environment?.POSTGRES_PASSWORD).toMatch(
        /^[0-9a-f]{64}$/,
      );
      expect(spec.networks?.backend).toBeDefined();
      expect(spec.volumes?.["postgres-data"]).toBeDefined();
    });

    it("uses a pinned postgresPassword when one is provided", () => {
      const builder = ComposeBuilder.exampleBackendStack({
        backendImage: "example-backend:latest",
        dbType: "postgres",
        postgresPassword: "pinned-for-test",
      });
      const spec = builder.getSpec();
      expect(spec.services.postgres.environment?.POSTGRES_PASSWORD).toBe(
        "pinned-for-test",
      );
      expect(spec.services.backend.environment?.DATABASE_URL).toContain(
        "pinned-for-test",
      );
    });

    it("uses custom port and jwt secret", () => {
      const builder = ComposeBuilder.exampleBackendStack({
        backendImage: "example-backend:v2",
        backendPort: 9090,
        jwtSecret: "custom-secret",
      });
      const spec = builder.getSpec();

      expect(spec.services.backend.ports).toEqual(["9090:9090"]);
      expect(spec.services.backend.environment?.JWT_SECRET).toBe(
        "custom-secret",
      );
    });

    it("includes extra environment variables", () => {
      const builder = ComposeBuilder.exampleBackendStack({
        backendImage: "example-backend:latest",
        extraEnv: { CUSTOM_VAR: "hello" },
      });
      const spec = builder.getSpec();
      expect(spec.services.backend.environment?.CUSTOM_VAR).toBe("hello");
    });

    it("uses custom postgres image", () => {
      const builder = ComposeBuilder.exampleBackendStack({
        backendImage: "example-backend:latest",
        dbType: "postgres",
        postgresImage: "postgres:15-alpine",
      });
      const spec = builder.getSpec();
      expect(spec.services.postgres.image).toBe("postgres:15-alpine");
    });
  });
});
