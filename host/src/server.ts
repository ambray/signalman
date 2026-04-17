#!/usr/bin/env node
/**
 * Signalman Host MCP Server
 *
 * Provides VM management tools to Claude Code and other MCP-compatible clients.
 * Discovers available hypervisor backends and exposes a unified tool interface.
 *
 * Tool implementations live in tools/*.ts; this file handles MCP server setup,
 * backend discovery, and tool registration.
 *
 * Usage:
 *   claude mcp add signalman node host/dist/server.js
 *   # or for development:
 *   claude mcp add signalman -- npx tsx host/src/server.ts
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { HypervisorBackend } from "./hypervisors/interface.js";
import { HyperVBackend } from "./hypervisors/hyperv.js";
import { VmwareBackend } from "./hypervisors/vmware.js";
import { loadConfig } from "./config.js";
import { createAllTools } from "./tools/index.js";

// ── Backend Discovery ─────────────────────────────────────────────

/**
 * Build the ordered backend list from configuration.
 *
 * Hyper-V is the primary backend since 2026-04 (required for Example
 * correlator silo validation scenarios). VMware remains a legacy
 * fallback. If the config specifies a preferred backend, it goes first.
 */
function buildBackendList(preferredBackend?: string): HypervisorBackend[] {
  const config = loadConfig();
  const vmware = new VmwareBackend({
    vmrunPath: config.hypervisor.vmrunPath,
    vmDirs: config.hypervisor.vmDirs,
    guestUser: config.hypervisor.guestCredentials?.username,
    guestPass: config.hypervisor.guestCredentials?.password,
  });
  const hyperv = new HyperVBackend();

  if (preferredBackend === "vmware") return [vmware, hyperv];
  if (preferredBackend === "hyperv") return [hyperv, vmware];
  // Default: prefer Hyper-V (changed from VMware-first on 2026-04).
  return [hyperv, vmware];
}

let activeBackend: HypervisorBackend | null = null;

async function getBackend(): Promise<HypervisorBackend> {
  if (activeBackend) return activeBackend;

  const config = loadConfig();
  const backends = buildBackendList(config.hypervisor.backend);

  for (const backend of backends) {
    if (await backend.isAvailable()) {
      activeBackend = backend;
      console.error(`[signalman] Using ${backend.name} hypervisor backend`);
      return backend;
    }
  }
  throw new Error(
    "No hypervisor backend available. Install Hyper-V or VMware Workstation.",
  );
}

// ── MCP Server Setup ──────────────────────────────────────────────

const server = new McpServer({
  name: "signalman",
  version: "0.1.0",
});

// ── Register Tools from Modular Definitions ───────────────────────

/**
 * Convert a JSON Schema property definition to a Zod type.
 *
 * The modular tool definitions use plain JSON Schema objects for their
 * inputSchema, but McpServer.tool() expects Zod schemas. This bridge
 * converts each property at registration time.
 */
/** VM name regex: alphanumeric, dashes, dots, underscores. */
const VM_NAME_RE = /^[a-zA-Z0-9_.\-]+$/;
/** Label regex: same character set as VM names. */
const LABEL_RE = /^[a-zA-Z0-9_.\-]+$/;

function jsonSchemaPropertyToZod(
  schema: { type: string; description?: string; enum?: string[]; items?: { type: string } },
  required: boolean,
  fieldName?: string,
): z.ZodTypeAny {
  let field: z.ZodTypeAny;

  switch (schema.type) {
    case "boolean":
      field = z.boolean();
      break;
    case "number":
      field = z.number();
      break;
    case "array":
      field = z.array(z.string());
      break;
    case "string":
      if (schema.enum) {
        field = z.enum(schema.enum as [string, ...string[]]);
      } else {
        field = z.string();
      }
      break;
    default:
      field = z.string();
  }

  // ── Input validation constraints (Phase 1.2) ────────────────────
  // Apply stricter Zod-level validation for well-known field names so
  // that invalid values are rejected before they reach any handler.
  if (fieldName === "name") {
    // "name" is always a VM name in this tool set.
    field = z
      .string()
      .min(1)
      .max(100)
      .regex(VM_NAME_RE, "VM name must be alphanumeric with dashes/dots/underscores");
  } else if (fieldName === "label") {
    field = z
      .string()
      .min(1)
      .max(100)
      .regex(LABEL_RE, "Label must be alphanumeric with dashes/dots/underscores");
  } else if (fieldName === "timeout_ms") {
    field = z.number().int().min(1000).max(600000).default(30000);
  }

  if (schema.description) {
    field = field.describe(schema.description);
  }

  if (!required) {
    // For fields that already have a .default(), wrapping in optional
    // keeps the default effective while allowing the field to be omitted.
    field = field.optional();
  }

  return field;
}

const allTools = createAllTools(getBackend);

for (const tool of allTools) {
  const props = (tool.inputSchema.properties ?? {}) as Record<
    string,
    { type: string; description?: string; enum?: string[]; items?: { type: string } }
  >;
  const requiredFields = new Set((tool.inputSchema.required ?? []) as string[]);

  const zodShape: Record<string, z.ZodTypeAny> = {};
  for (const [key, schema] of Object.entries(props)) {
    zodShape[key] = jsonSchemaPropertyToZod(schema, requiredFields.has(key), key);
  }

  const handler = tool.handler;
  server.tool(tool.name, tool.description, zodShape, async (params) => {
    const result = await handler(params as Record<string, unknown>);
    return {
      content: result.content.map((c) => ({
        type: c.type as "text",
        text: c.text ?? "",
      })),
    };
  });
}

// ── Start Server ──────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[signalman] Host MCP server started");
}

main().catch((err) => {
  console.error("[signalman] Fatal:", err);
  process.exit(1);
});
