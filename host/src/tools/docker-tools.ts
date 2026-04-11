/**
 * Docker container orchestration MCP tools.
 *
 * Provides tools for managing Docker containers and Compose stacks
 * alongside VM-based E2E testing scenarios. Tools follow the same
 * pattern as vm-lifecycle.ts and vm-operations.ts.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ToolDefinition, ToolResult } from "./types.js";
import { DockerClient, type ComposeConfig } from "../docker/client.js";
import { sanitizePath } from "../sanitize.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Validate that a compose file path is within the allowed project directory.
 *
 * Resolves the path to an absolute path and checks it resides under the
 * project's scenarios/ or compose/ directory. Rejects path traversal
 * attempts and absolute paths outside the allowed root.
 */
function validateComposeFilePath(composeFile: string): string {
  // Sanitize for shell metacharacters first
  sanitizePath(composeFile);

  // Resolve to the project root (host/src/tools -> host -> project root)
  const projectRoot = path.resolve(__dirname, "..", "..", "..");
  const resolved = path.resolve(composeFile);

  // Normalize both paths for consistent comparison (Windows case, trailing sep)
  const normalizedResolved = path.normalize(resolved) + path.sep;
  const normalizedRoot = path.normalize(projectRoot) + path.sep;

  if (!normalizedResolved.startsWith(normalizedRoot)) {
    throw new Error(
      `Compose file "${resolved}" resolves outside the allowed project directory "${projectRoot}". ` +
      `Path traversal is not allowed.`,
    );
  }

  return resolved;
}

/**
 * Creates Docker orchestration tool definitions.
 *
 * @param getDocker - Factory function that returns a configured DockerClient.
 * @returns Array of ToolDefinition objects for Docker operations.
 */
export function createDockerTools(
  getDocker: () => DockerClient,
): ToolDefinition[] {
  return [
    {
      name: "docker_compose_up",
      description:
        "Start a Docker Compose stack in detached mode. Starts all services or a subset.",
      inputSchema: {
        type: "object",
        properties: {
          projectName: {
            type: "string",
            description: "Compose project name (lowercase, alphanumeric, hyphens, underscores)",
          },
          composeFile: {
            type: "string",
            description: "Path to the docker-compose.yaml file",
          },
          services: {
            type: "array",
            items: { type: "string" },
            description: "Optional list of services to start (default: all)",
          },
        },
        required: ["projectName", "composeFile"],
        additionalProperties: false,
      },
      handler: async (params): Promise<ToolResult> => {
        const docker = getDocker();
        const validatedPath = validateComposeFilePath(params.composeFile as string);
        const config: ComposeConfig = {
          projectName: params.projectName as string,
          composeFile: validatedPath,
        };
        const services = params.services as string[] | undefined;

        await docker.composeUp(config, services);
        const containers = await docker.composePs(config);

        return {
          content: [
            {
              type: "text",
              text: `Compose stack '${config.projectName}' started.\n${JSON.stringify(containers, null, 2)}`,
            },
          ],
        };
      },
    },
    {
      name: "docker_compose_down",
      description:
        "Stop and remove a Docker Compose stack. Optionally remove volumes.",
      inputSchema: {
        type: "object",
        properties: {
          projectName: {
            type: "string",
            description: "Compose project name",
          },
          composeFile: {
            type: "string",
            description: "Path to the docker-compose.yaml file",
          },
          removeVolumes: {
            type: "boolean",
            description: "Also remove volumes (default: false)",
          },
        },
        required: ["projectName", "composeFile"],
        additionalProperties: false,
      },
      handler: async (params): Promise<ToolResult> => {
        const docker = getDocker();
        const validatedPath = validateComposeFilePath(params.composeFile as string);
        const config: ComposeConfig = {
          projectName: params.projectName as string,
          composeFile: validatedPath,
        };
        const removeVolumes = params.removeVolumes as boolean | undefined;

        await docker.composeDown(config, removeVolumes);

        return {
          content: [
            {
              type: "text",
              text: `Compose stack '${config.projectName}' stopped and removed.${removeVolumes ? " Volumes removed." : ""}`,
            },
          ],
        };
      },
    },
    {
      name: "docker_status",
      description:
        "Get the status of a Docker container by name or ID.",
      inputSchema: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Container name or ID",
          },
        },
        required: ["name"],
        additionalProperties: false,
      },
      handler: async (params): Promise<ToolResult> => {
        const docker = getDocker();
        // Defense-in-depth: sanitize at tool handler level
        const name = sanitizePath(params.name as string);

        const status = await docker.getContainerStatus(name);

        return {
          content: [
            { type: "text", text: JSON.stringify(status, null, 2) },
          ],
        };
      },
    },
    {
      name: "docker_logs",
      description:
        "Get logs from a Docker container. Optionally limit to the last N lines.",
      inputSchema: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Container name or ID",
          },
          tail: {
            type: "number",
            description: "Number of lines from the end (default: all)",
          },
        },
        required: ["name"],
        additionalProperties: false,
      },
      handler: async (params): Promise<ToolResult> => {
        const docker = getDocker();
        // Defense-in-depth: sanitize at tool handler level
        const name = sanitizePath(params.name as string);
        const tail = params.tail as number | undefined;

        const logs = await docker.getContainerLogs(name, tail);

        return {
          content: [{ type: "text", text: logs || "(no logs)" }],
        };
      },
    },
    {
      name: "docker_exec",
      description:
        "Execute a command inside a running Docker container.",
      inputSchema: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Container name or ID",
          },
          command: {
            type: "array",
            items: { type: "string" },
            description: "Command and arguments to execute (e.g., [\"ls\", \"-la\"])",
          },
          timeoutMs: {
            type: "number",
            description: "Timeout in milliseconds (default: 30000)",
          },
        },
        required: ["name", "command"],
        additionalProperties: false,
      },
      handler: async (params): Promise<ToolResult> => {
        const docker = getDocker();
        // Defense-in-depth: sanitize at tool handler level
        const name = sanitizePath(params.name as string);
        const command = params.command as string[];
        const timeoutMs = params.timeoutMs as number | undefined;

        const result = await docker.execInContainer(name, command, timeoutMs);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  exitCode: result.exitCode,
                  stdout: result.stdout,
                  stderr: result.stderr,
                },
                null,
                2,
              ),
            },
          ],
        };
      },
    },
    {
      name: "docker_wait_healthy",
      description:
        "Wait for a Docker container health check to report healthy.",
      inputSchema: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Container name or ID",
          },
          timeoutMs: {
            type: "number",
            description: "Maximum wait time in milliseconds (default: 30000)",
          },
        },
        required: ["name"],
        additionalProperties: false,
      },
      handler: async (params): Promise<ToolResult> => {
        const docker = getDocker();
        // Defense-in-depth: sanitize at tool handler level
        const name = sanitizePath(params.name as string);
        const timeoutMs = params.timeoutMs as number | undefined;

        const healthy = await docker.waitForHealthy(name, timeoutMs);

        return {
          content: [
            {
              type: "text",
              text: healthy
                ? `Container '${name}' is healthy.`
                : `Container '${name}' did not become healthy within the timeout.`,
            },
          ],
          isError: !healthy,
        };
      },
    },
  ];
}
