#!/usr/bin/env node
/**
 * Signalman Host MCP Server
 *
 * Provides VM management tools to Claude Code and other MCP-compatible clients.
 * Discovers available hypervisor backends and exposes a unified tool interface.
 *
 * v0.1.0 (P0 MCP Surface Inversion, see docs/design/p0-mcp-surface.md):
 *   - Six high-level verbs (`signalman_list`, `signalman_describe`,
 *     `signalman_plan`, `signalman_run`, `signalman_record`,
 *     `signalman_status`) are the default agent surface.
 *   - The legacy ~25 fine-grained tools live behind a
 *     `signalman_advanced_` prefix. Their old names remain registered
 *     as deprecated aliases for one release; v0.2.0 removes them.
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
import { loadConfig } from "./config.js";
import { buildBackendList } from "./hypervisors/selector.js";
import { createAllTools } from "./tools/index.js";
import { runList } from "./verbs/list.js";
import { runDescribe } from "./verbs/describe.js";
import { runPlan } from "./verbs/plan.js";
import { runRun } from "./verbs/run.js";
import { runStatus } from "./verbs/status.js";
import { runRecord } from "./verbs/record.js";
import { createDefaultExecutor } from "./verbs/default-executor.js";

// ── Backend Discovery ─────────────────────────────────────────────

let activeBackend: HypervisorBackend | null = null;

async function getBackend(): Promise<HypervisorBackend> {
  if (activeBackend) return activeBackend;

  const config = loadConfig();
  const backends = buildBackendList(config);

  for (const backend of backends) {
    if (await backend.isAvailable()) {
      activeBackend = backend;
      console.error(`[signalman] Using ${backend.name} hypervisor backend`);
      return backend;
    }
  }
  throw new Error(
    "No hypervisor backend available. Install Signalman service, Hyper-V, Tart, or VMware Workstation/Fusion.",
  );
}

// ── MCP Server Setup ──────────────────────────────────────────────

const server = new McpServer({
  name: "signalman",
  version: "0.1.0",
});

// ── JSON Schema → Zod bridge ──────────────────────────────────────

/**
 * Convert a JSON Schema property definition to a Zod type.
 *
 * The modular tool definitions use plain JSON Schema objects for their
 * inputSchema, but McpServer.tool() expects Zod schemas. This bridge
 * converts each property at registration time.
 */
/** VM name regex: alphanumeric, dashes, dots, underscores. */
const VM_NAME_RE = /^[a-zA-Z0-9_.-]+$/;
/** Label regex: same character set as VM names. */
const LABEL_RE = /^[a-zA-Z0-9_.-]+$/;

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

// ── Advanced tools (renamed) + deprecated aliases ─────────────────

const allTools = createAllTools(getBackend);

/**
 * One-time deprecation warning per legacy tool name. The first call
 * to any old `vm_*` / `docker_*` / `kernel_*` / `driver_*` name
 * prints a warning to stderr; subsequent calls don't repeat. v0.2.0
 * drops the legacy names entirely.
 */
const warnedLegacyNames = new Set<string>();
function warnLegacyToolName(legacy: string, replacement: string) {
  if (warnedLegacyNames.has(legacy)) return;
  warnedLegacyNames.add(legacy);
  console.error(
    `[signalman] DEPRECATION: tool "${legacy}" is renamed to "${replacement}" in v0.1.0; ` +
      `the old name is removed in v0.2.0. Update Claude Code permissions and any direct callers.`,
  );
}

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
  const advancedName = `signalman_advanced_${tool.name}`;
  const wrappedHandler = async (params: Record<string, unknown>) => {
    const result = await handler(params);
    return {
      content: result.content.map((c) => ({
        type: c.type as "text",
        text: c.text ?? "",
      })),
    };
  };

  server.tool(advancedName, tool.description, zodShape, wrappedHandler);

  // Deprecated alias under the old name. Emits a one-time warning per
  // process so legacy callers still work for one release.
  server.tool(
    tool.name,
    `[DEPRECATED — renamed to ${advancedName} in v0.1.0; old name removed in v0.2.0] ${tool.description}`,
    zodShape,
    async (params: Record<string, unknown>) => {
      warnLegacyToolName(tool.name, advancedName);
      return wrappedHandler(params);
    },
  );
}

// ── Six high-level verbs ──────────────────────────────────────────

const defaultRunExecutor = createDefaultExecutor();

/**
 * Wrap a verb handler in an MCP-shaped result so tool registration
 * stays one-line per verb. Errors thrown by the verb implementation
 * propagate as MCP-level `isError: true` results.
 */
function asMcpResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  };
}

server.tool(
  "signalman_list",
  "List all scenarios under .signalman/scenarios/. Returns id, name, tags, scenario_hash, and last_run if available.",
  {
    tag: z.string().optional().describe("Filter by tag."),
    pattern: z.string().optional().describe("Glob pattern matching the scenario id (e.g. 'ospiri/**')."),
  },
  async (params) => asMcpResult(runList(params as { tag?: string; pattern?: string })),
);

server.tool(
  "signalman_describe",
  "Return the contents of a scenario without executing it. Returns parsed setup, assertions, and workflow markdown.",
  {
    id: z.string().describe("Scenario id (e.g. 'ospiri/v2/network-egress')."),
  },
  async (params) => asMcpResult(runDescribe(params as { id: string })),
);

server.tool(
  "signalman_plan",
  "Dry-run a scenario: load, validate, expand parameters, return resolved step plan and affected resources. No state mutation.",
  {
    id: z.string().describe("Scenario id."),
    parameters: z.record(z.string(), z.unknown()).optional().describe("Caller-supplied parameter overrides."),
  },
  async (params) =>
    asMcpResult(runPlan(params as { id: string; parameters?: Record<string, unknown> })),
);

server.tool(
  "signalman_run",
  "Execute a scenario. Returns a run handle synchronously; events stream via signalman_status long-poll.",
  {
    id: z.string().describe("Scenario id."),
    parameters: z.record(z.string(), z.unknown()).optional().describe("Caller-supplied parameter overrides."),
    network_class: z.enum(["isolated", "nat", "internet"]).optional().describe("Reserved for P4 — declared, not enforced in v0.1.0."),
    trace_id: z.string().optional().describe(
      "P3.d: optional 32-char hex (or dashed UUID) correlation root. " +
      "When omitted, Signalman generates one and surfaces it on the run handle. " +
      "Upstream orchestrators (Loom plugin, CI) supply this so log streams across host/service/guest correlate by `grep $trace_id`.",
    ),
  },
  async (params) =>
    asMcpResult(
      await runRun(
        params as {
          id: string;
          parameters?: Record<string, unknown>;
          network_class?: "isolated" | "nat" | "internet";
          trace_id?: string;
        },
        defaultRunExecutor,
      ),
    ),
);

server.tool(
  "signalman_status",
  "Environment + run status. Without run_id: host health and recent runs. With run_id: drain events and (when terminal) full envelope.",
  {
    run_id: z.string().optional().describe("Run handle from signalman_run."),
    since_event_seq: z.number().int().min(0).optional().describe("Drain events with seq >= this value."),
    wait_ms: z.number().int().min(0).max(30_000).optional().describe("Long-poll up to this many ms for the next event."),
  },
  async (params) =>
    asMcpResult(
      await runStatus(params as { run_id?: string; since_event_seq?: number; wait_ms?: number }),
    ),
);

server.tool(
  "signalman_record",
  "[v0.2.0 stub] Capture the next N MCP calls into .signalman/recordings/<run_id>/ as a candidate scenario.",
  {
    name: z.string().describe("Scenario name to record under."),
    duration_seconds: z.number().int().min(1).optional().describe("Max recording duration; default 600s."),
  },
  async (params) => asMcpResult(runRecord(params as { name: string; duration_seconds?: number })),
);

// ── Start Server ──────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[signalman] Host MCP server started");
}

// Only run main() if this file is the entry point (not when imported by tests).
const isEntryPoint =
  import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}` ||
  process.argv[1]?.endsWith("server.ts") ||
  process.argv[1]?.endsWith("server.js");

if (isEntryPoint) {
  main().catch((err) => {
    console.error("[signalman] Fatal:", err);
    process.exit(1);
  });
}
