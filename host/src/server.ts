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
import { recordMcpCall, runRecord, runRecordFinalize } from "./verbs/record.js";
import { createDefaultExecutor } from "./verbs/default-executor.js";
import {
  runHealthCheck,
  runHealthHistory,
  runProductAdd,
  runProductList,
  runProductRemove,
  runReleaseBuild,
  runReleaseDeploy,
  runReleaseList,
  runReleaseRollback,
  runReleaseShow,
  runTargetAdd,
  runTargetList,
  runTargetRemove,
  withControlPlane,
} from "./verbs/control-plane.js";

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
  const wrappedHandler = async (params: Record<string, unknown>) =>
    withRecording(advancedName, params, async () => {
      const result = await handler(params);
      return {
        content: result.content.map((c) => ({
          type: c.type as "text",
          text: c.text ?? "",
        })),
      };
    });

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

async function withRecording<T>(
  tool: string,
  params: Record<string, unknown>,
  fn: () => Promise<T> | T,
  options: { capture?: boolean } = {},
): Promise<T> {
  const started = new Date();
  try {
    const result = await fn();
    const finished = new Date();
    if (options.capture !== false) {
      recordMcpCall({
        tool,
        params,
        result,
        started_at: started.toISOString(),
        finished_at: finished.toISOString(),
        duration_ms: finished.getTime() - started.getTime(),
      });
    }
    return result;
  } catch (err) {
    const finished = new Date();
    if (options.capture !== false) {
      recordMcpCall({
        tool,
        params,
        error: err,
        started_at: started.toISOString(),
        finished_at: finished.toISOString(),
        duration_ms: finished.getTime() - started.getTime(),
      });
    }
    throw err;
  }
}

server.tool(
  "signalman_list",
  "List all scenarios under .signalman/scenarios/. Returns id, name, tags, scenario_hash, and last_run if available.",
  {
    tag: z.string().optional().describe("Filter by tag."),
    pattern: z.string().optional().describe("Glob pattern matching the scenario id (e.g. 'mygroup/**')."),
  },
  async (params) =>
    withRecording("signalman_list", params, () =>
      asMcpResult(runList(params as { tag?: string; pattern?: string })),
    ),
);

server.tool(
  "signalman_describe",
  "Return the contents of a scenario without executing it. Returns parsed setup, assertions, and workflow markdown.",
  {
    id: z.string().describe("Scenario id (e.g. 'mygroup/v2/scenario-name')."),
  },
  async (params) =>
    withRecording("signalman_describe", params, () =>
      asMcpResult(runDescribe(params as { id: string })),
    ),
);

server.tool(
  "signalman_plan",
  "Dry-run a scenario: load, validate, expand parameters, return resolved step plan and affected resources. No state mutation.",
  {
    id: z.string().describe("Scenario id."),
    parameters: z.record(z.string(), z.unknown()).optional().describe("Caller-supplied parameter overrides."),
  },
  async (params) =>
    withRecording("signalman_plan", params, () =>
      asMcpResult(runPlan(params as { id: string; parameters?: Record<string, unknown> })),
    ),
);

server.tool(
  "signalman_run",
  "Execute a scenario. Returns a run handle synchronously; events stream via signalman_status long-poll.",
  {
    id: z.string().describe("Scenario id."),
    parameters: z.record(z.string(), z.unknown()).optional().describe("Caller-supplied parameter overrides."),
    network_class: z.enum(["isolated", "nat", "internet"]).optional().describe("Recorded in the result envelope; not a host network-policy switch."),
    trace_id: z.string().optional().describe(
      "P3.d: optional 32-char hex (or dashed UUID) correlation root. " +
      "When omitted, Signalman generates one and surfaces it on the run handle. " +
      "Upstream orchestrators (Loom plugin, CI) supply this so log streams across host/service/guest correlate by `grep $trace_id`.",
    ),
  },
  async (params) =>
    withRecording("signalman_run", params, async () =>
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
    withRecording("signalman_status", params, async () =>
      asMcpResult(
        await runStatus(params as { run_id?: string; since_event_seq?: number; wait_ms?: number }),
      ),
    ),
);

server.tool(
  "signalman_record",
  "Start a durable v0.2.0 record/replay session under .signalman/recordings/<name>/<recording_id>/.",
  {
    name: z.string().describe("Scenario name to record under."),
    duration_seconds: z.number().int().min(1).optional().describe("Max recording duration; default 600s."),
  },
  async (params) =>
    withRecording(
      "signalman_record",
      params,
      () => asMcpResult(runRecord(params as { name: string; duration_seconds?: number })),
      { capture: false },
    ),
);

server.tool(
  "signalman_record_finalize",
  "Synthesize candidate scenario files from a record/replay calls.jsonl capture.",
  {
    recording_path: z.string().optional().describe("Recording directory or state.json path."),
    recording_id: z.string().optional().describe("Recording id to find under .signalman/recordings/."),
    scenario_id: z.string().optional().describe("Scenario id/path to write under .signalman/scenarios/."),
    force: z.boolean().optional().describe("Overwrite an existing candidate scenario directory."),
  },
  async (params) =>
    withRecording(
      "signalman_record_finalize",
      params,
      () =>
        asMcpResult(
          runRecordFinalize(
            params as {
              recording_path?: string;
              recording_id?: string;
              scenario_id?: string;
              force?: boolean;
            },
          ),
        ),
      { capture: false },
    ),
);

// ── Control-plane verbs (PR 2 — product, release) ────────────────

server.tool(
  "signalman_product_add",
  "Register a product for signalman to build. The product's signalman.build.yaml declares its components.",
  {
    name: z.string().describe("Product name (unique per org)."),
    repo_url: z.string().describe("Git URL signalman will clone at build time."),
    build_yaml_path: z
      .string()
      .optional()
      .describe("Path to signalman.build.yaml inside the repo (default: signalman.build.yaml)."),
  },
  async (params) =>
    withRecording("signalman_product_add", params, async () =>
      asMcpResult(
        await withControlPlane((cp) =>
          runProductAdd(cp, {
            name: (params as { name: string }).name,
            repoUrl: (params as { repo_url: string }).repo_url,
            buildYamlPath: (params as { build_yaml_path?: string }).build_yaml_path,
          }),
        ),
      ),
    ),
);

server.tool(
  "signalman_product_list",
  "List registered products in the active org.",
  {},
  async (params) =>
    withRecording("signalman_product_list", params, async () =>
      asMcpResult(await withControlPlane((cp) => runProductList(cp))),
    ),
);

server.tool(
  "signalman_product_remove",
  "Soft-delete a product by name. Releases remain in the catalog for historical reference.",
  {
    name: z.string().describe("Product name to remove."),
  },
  async (params) =>
    withRecording("signalman_product_remove", params, async () => {
      await withControlPlane((cp) =>
        runProductRemove(cp, { name: (params as { name: string }).name }),
      );
      return asMcpResult({ removed: true });
    }),
);

server.tool(
  "signalman_release_build",
  "Build a release of a product at a tag. Clones the repo, executes signalman.build.yaml, captures artifacts.",
  {
    product: z.string().describe("Product name."),
    tag: z.string().describe("Git tag to build."),
    work_dir: z
      .string()
      .optional()
      .describe("Pre-cloned source tree (skips the internal clone). Useful for offline builds and tests."),
  },
  async (params) =>
    withRecording("signalman_release_build", params, async () => {
      const p = params as { product: string; tag: string; work_dir?: string };
      const result = await withControlPlane((cp) =>
        runReleaseBuild(
          cp,
          { productName: p.product, tag: p.tag, workDir: p.work_dir },
          { out: process.stderr },
        ),
      );
      return asMcpResult({
        release: result.release,
        manifest_sha256: result.manifestSha256,
        artifact_count: result.artifacts.length,
      });
    }),
);

server.tool(
  "signalman_release_list",
  "List releases, optionally filtered by product or status.",
  {
    product: z.string().optional().describe("Filter by product name."),
    status: z
      .enum(["building", "ready", "failed"])
      .optional()
      .describe("Filter by release status."),
  },
  async (params) =>
    withRecording("signalman_release_list", params, async () =>
      asMcpResult(
        await withControlPlane((cp) =>
          runReleaseList(cp, {
            productName: (params as { product?: string }).product,
            status: (params as { status?: "building" | "ready" | "failed" }).status,
          }),
        ),
      ),
    ),
);

server.tool(
  "signalman_release_show",
  "Show a release's full record: status, manifest sha, and the list of artifacts.",
  {
    release_id: z.string().describe("Release id (ULID, from signalman_release_list)."),
  },
  async (params) =>
    withRecording("signalman_release_show", params, async () =>
      asMcpResult(
        await withControlPlane((cp) =>
          runReleaseShow(cp, {
            releaseId: (params as { release_id: string }).release_id,
          }),
        ),
      ),
    ),
);

// ── Target verbs (PR 3) ───────────────────────────────────────────

server.tool(
  "signalman_target_add",
  "Register a deployable surface (VM or Docker stack) that signalman can deploy releases onto.",
  {
    name: z.string().describe("Target name (unique per org)."),
    kind: z.enum(["vm_test", "vm_demo", "docker_test", "docker_demo"]).describe("Target kind."),
    vm_name: z.string().optional().describe("Hyper-V VM name (for vm_test / vm_demo)."),
    backend: z.string().optional().describe("Hypervisor backend override (default: from config)."),
    connection: z
      .record(z.string(), z.unknown())
      .optional()
      .describe("Raw connection JSON; overrides vm_name + backend if supplied."),
  },
  async (params) =>
    withRecording("signalman_target_add", params, async () => {
      const p = params as {
        name: string;
        kind: "vm_test" | "vm_demo" | "docker_test" | "docker_demo";
        vm_name?: string;
        backend?: string;
        connection?: Record<string, unknown>;
      };
      const connection = p.connection
        ? p.connection
        : {
            ...(p.vm_name ? { vmName: p.vm_name } : {}),
            ...(p.backend ? { backend: p.backend } : {}),
          };
      const target = await withControlPlane((cp) =>
        runTargetAdd(cp, { name: p.name, kind: p.kind, connection }),
      );
      return asMcpResult(target);
    }),
);

server.tool(
  "signalman_target_list",
  "List registered targets in the active org.",
  {},
  async (params) =>
    withRecording("signalman_target_list", params, async () =>
      asMcpResult(await withControlPlane((cp) => runTargetList(cp))),
    ),
);

server.tool(
  "signalman_target_remove",
  "Soft-delete a target by name. Past deployments remain in the ledger.",
  {
    name: z.string().describe("Target name."),
  },
  async (params) =>
    withRecording("signalman_target_remove", params, async () => {
      await withControlPlane((cp) =>
        runTargetRemove(cp, { name: (params as { name: string }).name }),
      );
      return asMcpResult({ removed: true });
    }),
);

server.tool(
  "signalman_release_deploy",
  "Deploy a release to a target. Pre-deploy checkpoint, stage artifacts, health probe, promote on pass.",
  {
    target: z.string().describe("Target name."),
    release: z.string().optional().describe("Release id (alternative to product + tag)."),
    product: z.string().optional().describe("Product name (with --tag, alternative to --release)."),
    tag: z.string().optional().describe("Release tag (with --product, alternative to --release)."),
  },
  async (params) =>
    withRecording("signalman_release_deploy", params, async () => {
      const p = params as {
        target: string;
        release?: string;
        product?: string;
        tag?: string;
      };
      const result = await withControlPlane((cp) =>
        runReleaseDeploy(
          cp,
          {
            targetName: p.target,
            releaseId: p.release,
            productName: p.product,
            tag: p.tag,
          },
          { out: process.stderr },
        ),
      );
      return asMcpResult({
        deployment: result.deployment,
        release: result.release,
        target: result.target,
        health: result.healthSummary,
      });
    }),
);

server.tool(
  "signalman_release_rollback",
  "Roll back a target by redeploying the previous-active release (or an explicit prior release).",
  {
    target: z.string().describe("Target name."),
    to_release: z
      .string()
      .optional()
      .describe("Optional explicit release id to roll back to. Default: most recent superseded."),
  },
  async (params) =>
    withRecording("signalman_release_rollback", params, async () => {
      const p = params as { target: string; to_release?: string };
      const result = await withControlPlane((cp) =>
        runReleaseRollback(
          cp,
          { targetName: p.target, toReleaseId: p.to_release },
          { out: process.stderr },
        ),
      );
      return asMcpResult({
        deployment: result.deployment,
        release: result.release,
        target: result.target,
        health: result.healthSummary,
      });
    }),
);

// ── Health verbs (PR 4) ───────────────────────────────────────────

server.tool(
  "signalman_health_check",
  "Run health probes against a target. Default: the target's active deployment + all declared probes.",
  {
    target: z.string().describe("Target name."),
    probe_names: z
      .array(z.string())
      .optional()
      .describe("Subset of probe names to run. Default: all declared on the release."),
    release: z
      .string()
      .optional()
      .describe("Optional release id override; default uses the target's active deployment."),
  },
  async (params) =>
    withRecording("signalman_health_check", params, async () => {
      const p = params as {
        target: string;
        probe_names?: string[];
        release?: string;
      };
      const result = await withControlPlane((cp) =>
        runHealthCheck(
          cp,
          { targetName: p.target, probeNames: p.probe_names, releaseId: p.release },
          { out: process.stderr },
        ),
      );
      return asMcpResult(result);
    }),
);

server.tool(
  "signalman_health_history",
  "Query past health-check results for a target's deployments, newest first.",
  {
    target: z.string().describe("Target name."),
    since: z.string().optional().describe("ISO-8601 lower bound on checked_at."),
    limit: z.number().int().positive().optional().describe("Max entries per deployment."),
  },
  async (params) =>
    withRecording("signalman_health_history", params, async () => {
      const p = params as { target: string; since?: string; limit?: number };
      const entries = await withControlPlane((cp) =>
        runHealthHistory(cp, {
          targetName: p.target,
          sinceIso: p.since,
          limit: p.limit,
        }),
      );
      return asMcpResult(entries);
    }),
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
