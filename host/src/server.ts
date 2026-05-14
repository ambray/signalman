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

// ── v0.3.0-5: Cloud-provider tools ────────────────────────────────
//
// These tools let agents drive the cloud backends (AWS / Azure /
// OpenTofu) directly via MCP. The signalman_cloud_* family covers
// single-instance lifecycle (provision / terminate / status / list);
// the signalman_stack_* family wraps the OpenTofu driver.
//
// Vendor backends register themselves at module-load time; importing
// them here pulls them into the registry so a `getCloudBackend("aws")`
// from a tool handler resolves. Tests that don't want side-effects
// import these dynamically per-case.
import "./cloud/aws.js";
import "./cloud/azure.js";
import {
  getCloudBackend,
  listRegisteredBackends,
} from "./cloud/registry.js";
import {
  CloudBackendError,
  type CloudBackendKind,
  type CloudInstanceConfig,
  type CloudInstanceHandle,
} from "./cloud/types.js";
import { TofuDriver } from "./cloud/tofu.js";
import { CloudReaper, getOrCreateReaper } from "./cloud/reaper.js";
import type { CloudBudgetGate } from "./cloud/budget.js";

/**
 * Tool handler error→MCP-result envelope. Cloud errors carry a
 * stable `code`; we surface that to the agent verbatim so the
 * tool consumer can dispatch on it without parsing the message.
 */
function asCloudMcpResult<T>(fn: () => Promise<T>): Promise<{
  content: { type: "text"; text: string }[];
  isError?: boolean;
}> {
  return fn()
    .then((value) => asMcpResult({ ok: true, value }))
    .catch((err: unknown) => {
      const e = err as CloudBackendError;
      const payload = {
        ok: false,
        error: {
          code: e?.code ?? "unknown",
          message: (err as Error)?.message ?? String(err),
        },
      };
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(payload, null, 2) },
        ],
        isError: true,
      };
    });
}

const cloudProviderEnum = z.enum(["aws", "azure"]);

server.tool(
  "signalman_cloud_provision",
  "Provision an ephemeral cloud VM via the AWS or Azure backend. Returns the instance handle (id + region + backend + name) on success. Every instance carries the signalman-managed=true and signalman-org=<org_id> tags so the cost-reaper can identify it.",
  {
    provider: cloudProviderEnum,
    region: z.string().describe("Cloud region (e.g. 'us-east-1', 'eastus')."),
    instance_type: z
      .string()
      .describe("Vendor-specific instance type / VM size."),
    image_ref: z
      .string()
      .describe(
        "Vendor-specific image identifier. AWS: AMI id. Azure: full ARM " +
          "resource id of a gallery image version or custom image.",
      ),
    name: z.string().describe("Friendly instance name (surfaces as Name tag / Azure VM name)."),
    org_id: z
      .string()
      .optional()
      .describe("Owning org for the cost-reaper. Defaults to 'default'."),
    ttl_minutes: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Max lifetime in minutes. Defaults to 60. Cost-reaper enforces."),
    tags: z
      .record(z.string(), z.string())
      .optional()
      .describe(
        "Additional vendor tags. signalman-managed / signalman-org / " +
          "signalman-ttl-minutes keys are filtered out (sentinel tags are " +
          "always set by Signalman; caller can't spoof).",
      ),
    network: z
      .object({
        subnet_id: z.string().optional(),
        security_group_ids: z.array(z.string()).optional(),
        assign_public_ip: z.boolean().optional(),
        mode: z
          .enum(["public_mtls", "aws_ssm", "azure_bastion"])
          .optional()
          .describe(
            "Control-plane → guest reachability mode (sub-task 6). " +
              "Defaults to 'public_mtls'. Use 'aws_ssm' (AWS only) or " +
              "'azure_bastion' (Azure only) for zero-public-surface " +
              "deployments. The backend records the mode on the handle.",
          ),
      })
      .optional()
      .describe(
        "Network config. For Azure, subnet_id holds the pre-created NIC's " +
          "ARM resource id (sub-task 3 limitation; sub-task 4 follow-up " +
          "creates NICs).",
      ),
  },
  async (params) =>
    withRecording("signalman_cloud_provision", params, () =>
      asCloudMcpResult(async () => {
        // Sub-task 8 commit 2: when org_id is supplied AND
        // a per-org credential row exists, construct the backend
        // with that credential. Otherwise fall back to the
        // registry's default backend (SDK default credential
        // chain). Decryption failures propagate.
        const backend = await resolveBackendForRequest(
          params.provider as CloudBackendKind,
          params.org_id,
        );
        const config: CloudInstanceConfig = params as CloudInstanceConfig;
        return await backend.provisionInstance(config);
      }),
    ),
);

/**
 * Per-request backend resolver. When org_id is absent, returns
 * the registry's default backend (the existing v0.3.0-5 sub-tasks
 * 2/3 path). When org_id is present, looks up the org's
 * credential via the control-plane storage and constructs a
 * backend with those keys; decryption failures propagate.
 */
async function resolveBackendForRequest(
  kind: CloudBackendKind,
  orgId: string | undefined,
): Promise<ReturnType<typeof getCloudBackend>> {
  if (!orgId || orgId === "default") {
    return getCloudBackend(kind);
  }
  const { resolveBackendForOrgWithDefaults } = await import(
    "./cloud/per-org-backend.js"
  );
  const { ControlPlane } = await import("./control-plane/index.js");
  const { loadConfig } = await import("./config.js");
  const config = loadConfig();
  const cp = ControlPlane.fromConfig(config.controlPlane);
  await cp.init();
  // Note: we don't `cp.close()` here because the backend may
  // outlive this call (callers might re-use it for a status
  // poll). The control-plane handle is a process-wide pool; one
  // un-closed instance per provision is acceptable for v0.3.0-5.
  return resolveBackendForOrgWithDefaults(kind, orgId, cp.cloudCredentials);
}

server.tool(
  "signalman_cloud_terminate",
  "Terminate a cloud VM by handle. Idempotent: returns success for already-terminated instances. Per the cost-reaper contract, the backend handles dependent-resource cleanup (Azure auto-deletes the OS disk via deleteOption=Delete; AWS terminates EC2 atomically).",
  {
    provider: cloudProviderEnum,
    id: z.string().describe("Vendor instance id from signalman_cloud_provision."),
    name: z.string().describe("Instance friendly name."),
    region: z.string().describe("Cloud region."),
  },
  async (params) =>
    withRecording("signalman_cloud_terminate", params, () =>
      asCloudMcpResult(async () => {
        const backend = getCloudBackend(params.provider as CloudBackendKind);
        const handle: CloudInstanceHandle = {
          id: params.id,
          backend: params.provider as CloudBackendKind,
          name: params.name,
          region: params.region,
        };
        await backend.terminateInstance(handle);
        return { ok: true };
      }),
    ),
);

server.tool(
  "signalman_cloud_status",
  "Get the current state of a cloud VM. Returns state (pending/running/stopped/terminated/unknown), IPs when running, and a reason string when state is unknown.",
  {
    provider: cloudProviderEnum,
    id: z.string(),
    name: z.string(),
    region: z.string(),
  },
  async (params) =>
    withRecording("signalman_cloud_status", params, () =>
      asCloudMcpResult(async () => {
        const backend = getCloudBackend(params.provider as CloudBackendKind);
        const handle: CloudInstanceHandle = {
          id: params.id,
          backend: params.provider as CloudBackendKind,
          name: params.name,
          region: params.region,
        };
        return await backend.getInstanceStatus(handle);
      }),
    ),
);

server.tool(
  "signalman_cloud_list",
  "List Signalman-managed cloud VMs. Filtered to signalman-managed=true server-side so operators never accidentally see their other cloud workloads. Optional caller tags narrow further.",
  {
    provider: cloudProviderEnum,
    tags: z
      .record(z.string(), z.string())
      .optional()
      .describe("Additional tag filters to narrow the result."),
  },
  async (params) =>
    withRecording("signalman_cloud_list", params, () =>
      asCloudMcpResult(async () => {
        const backend = getCloudBackend(params.provider as CloudBackendKind);
        return await backend.listInstances({ tags: params.tags });
      }),
    ),
);

server.tool(
  "signalman_cloud_backends",
  "List the cloud backends registered at this signalman host's module-load time. Useful when an agent doesn't know which providers are available.",
  {},
  async (params) =>
    withRecording("signalman_cloud_backends", params, () =>
      asCloudMcpResult(async () => listRegisteredBackends()),
    ),
);

server.tool(
  "signalman_stack_apply",
  "Apply an OpenTofu HCL module as a per-stack workspace. Returns parsed outputs from `tofu output -json` plus the change summary (add/change/destroy counts). The workspace lives under <projectRoot>/.signalman/tofu-workspaces/<stack_name>/.",
  {
    stack_name: z
      .string()
      .describe("Stack name (1-64 chars, alphanumeric + _.-). Becomes the workspace subdirectory."),
    module_path: z
      .string()
      .describe("Absolute path to the HCL module directory."),
    vars: z
      .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
      .optional()
      .describe("Variables forwarded as `-var k=v` to tofu apply."),
    auto_approve: z
      .boolean()
      .optional()
      .describe("Pass -auto-approve to tofu apply. Defaults to true."),
  },
  async (params) =>
    withRecording("signalman_stack_apply", params, () =>
      asCloudMcpResult(async () => {
        const driver = new TofuDriver({ projectRoot: process.cwd() });
        return await driver.applyModule({
          stackName: params.stack_name,
          modulePath: params.module_path,
          vars: params.vars,
          autoApprove: params.auto_approve,
        });
      }),
    ),
);

server.tool(
  "signalman_stack_plan_cost",
  "Run a dry-run plan against an OpenTofu module and return a best-effort monthly cost estimate (in cents) for the resources the plan would CREATE. Use this BEFORE signalman_stack_apply to surface a heads-up: 'Deploying this stack costs ~$X/month'. Estimates come from a static SKU × region cost table; unknown SKUs fall back to a high default rate (conservative; better to over-estimate than miss a runaway cost).",
  {
    stack_name: z.string(),
    module_path: z.string(),
    vars: z
      .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
      .optional(),
  },
  async (params) =>
    withRecording("signalman_stack_plan_cost", params, () =>
      asCloudMcpResult(async () => {
        const driver = new TofuDriver({ projectRoot: process.cwd() });
        const planVars: Record<string, string | number | boolean> = {};
        for (const [k, v] of Object.entries(params.vars ?? {})) {
          planVars[k] = v;
        }
        return driver.planModule({
          stackName: params.stack_name,
          modulePath: params.module_path,
          vars: planVars,
        });
      }),
    ),
);

server.tool(
  "signalman_stack_destroy",
  "Destroy an OpenTofu stack's resources. Idempotent: returns alreadyEmpty=true when the workspace doesn't exist. Workspace directory is intentionally NOT removed after destroy so operators can inspect post-mortem.",
  {
    stack_name: z.string(),
    vars: z
      .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
      .optional(),
    auto_approve: z.boolean().optional(),
  },
  async (params) =>
    withRecording("signalman_stack_destroy", params, () =>
      asCloudMcpResult(async () => {
        const driver = new TofuDriver({ projectRoot: process.cwd() });
        return await driver.destroyModule({
          stackName: params.stack_name,
          vars: params.vars,
          autoApprove: params.auto_approve,
        });
      }),
    ),
);

// ── v0.3.0-5 sub-task 6: Network connection descriptor ───────────
//
// Operator + agent helper: given a handle (with its recorded
// network_mode), return the addressing parameters a
// control-plane client needs to reach the guest agent. The
// actual tunnel implementation (SSM session-manager, Azure
// Bastion port forwarding, raw TCP) is the caller's job; this
// tool returns data, not connections.

server.tool(
  "signalman_cloud_connection_descriptor",
  "Build a connection descriptor for reaching the guest agent on a cloud VM given its handle. The descriptor kind reflects the network mode the VM was provisioned with: public_mtls (returns port), aws_ssm (region + instance_id), azure_bastion (subscription_id + resource_group + vm_name). For public_mtls + no host, the caller fetches the IP via getInstanceIp and feeds it back. For azure_bastion, the operator passes subscription_id and resource_group hints (the handle alone doesn't carry them).",
  {
    handle: z
      .object({
        id: z.string(),
        backend: z.enum(["aws", "azure"]),
        name: z.string(),
        region: z.string(),
        network_mode: z
          .enum(["public_mtls", "aws_ssm", "azure_bastion"])
          .optional(),
      })
      .describe("Handle returned by signalman_cloud_provision or signalman_cloud_list."),
    port: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("gRPC port (defaults to 443)."),
    subscription_id: z
      .string()
      .optional()
      .describe("Azure subscription id (required when mode=azure_bastion)."),
    resource_group: z
      .string()
      .optional()
      .describe("Azure resource group (required when mode=azure_bastion)."),
  },
  async (params) =>
    withRecording("signalman_cloud_connection_descriptor", params, () =>
      asCloudMcpResult(async () => {
        const { getConnectionDescriptor } = await import("./cloud/connection.js");
        return getConnectionDescriptor(params.handle as CloudInstanceHandle, {
          port: params.port,
          subscriptionId: params.subscription_id,
          resourceGroup: params.resource_group,
        });
      }),
    ),
);

// ── v0.3.0-5 sub-task 5: Cost guardrails — TTL reaper ─────────────
//
// The reaper sweeps registered cloud backends for instances whose
// `signalman-ttl-expires-at` tag (epoch seconds) is in the past and
// terminates them. Two operator-facing MCP tools:
//
//   - signalman_reaper_run_once — force a single sweep now. Useful
//     in CI ("clean up everything past-TTL before I exit"), in
//     incident response, and for the parallel `signalman cloud
//     reaper run` CLI verb.
//   - signalman_reaper_status — return the result of the most
//     recent sweep in this MCP server's process (null if never).
//
// The singleton wires through `getOrCreateReaper` so `run_once` and
// `status` share state across handler invocations. A long-running
// host process can additionally call `reaper.start()` to wire the
// 5-min cadence; the MCP server itself does NOT start the
// scheduler today (operators wire it via cron / systemd or
// scheduled MCP invocations until sub-task 6 wires it into the
// daemon path).

function reaperSingleton(): CloudReaper {
  return getOrCreateReaper(
    () =>
      new CloudReaper({
        getBackends: () => {
          return listRegisteredBackends().map((k) => getCloudBackend(k));
        },
      }),
  );
}

server.tool(
  "signalman_reaper_run_once",
  "Run a single cost-reaper sweep across every registered cloud backend. Lists Signalman-managed instances, terminates any whose signalman-ttl-expires-at tag (epoch seconds) is in the past. Returns per-backend counts + the per-instance terminate errors (if any). Idempotent — repeat sweeps are safe; terminating an already-terminated handle is a no-op per the backend contract.",
  {},
  async (params) =>
    withRecording("signalman_reaper_run_once", params, () =>
      asCloudMcpResult(async () => reaperSingleton().runOnce()),
    ),
);

server.tool(
  "signalman_reaper_status",
  "Return the result of the most recent reaper sweep in this MCP server's process. Returns null when the reaper has not yet run. Use this to confirm a sweep happened + see what it did, without re-triggering it.",
  {},
  async (params) =>
    withRecording("signalman_reaper_status", params, () =>
      asCloudMcpResult(async () => ({
        isRunning: reaperSingleton().isRunning(),
        lastResult: reaperSingleton().getLastResult(),
      })),
    ),
);

// ── v0.3.0-5 sub-task 5: Cost guardrails — per-org budgets ────────
//
// Three tools exposing the budget gate's data surface:
//
//   - signalman_budget_get      Return the org's configured budget
//                               (or null) plus current month usage.
//   - signalman_budget_set      Create or update the org's budget.
//                               Idempotent — same org_id replaces.
//   - signalman_budget_usage    List per-instance usage rows for the
//                               current month so operators can see
//                               what's accumulating.
//
// All three lazily construct a SqliteStorageDriver via
// resolveControlPlaneConfig so the MCP server doesn't need a
// long-lived storage handle. The same code path the CLI uses.

async function withBudgetGate<T>(
  fn: (gate: CloudBudgetGate, controlPlane: { close(): Promise<void> }) => Promise<T>,
): Promise<T> {
  const { ControlPlane } = await import("./control-plane/index.js");
  const { CloudBudgetGate } = await import("./cloud/budget.js");
  const { loadConfig } = await import("./config.js");
  const config = loadConfig();
  const cp = ControlPlane.fromConfig(config.controlPlane);
  await cp.init();
  const gate = new CloudBudgetGate({
    budgets: cp.cloudBudgets,
    usage: cp.cloudUsage,
  });
  try {
    return await fn(gate, cp);
  } finally {
    await cp.close();
  }
}

server.tool(
  "signalman_budget_get",
  "Return the per-org cloud-spend budget configuration (monthly cents limit + soft-warn percentage) plus current calendar-month usage in cents. Returns null in `budget` when no budget is configured for the org (back-compat: unlimited).",
  {
    org_id: z.string().describe("Owning org id."),
  },
  async (params) =>
    withRecording("signalman_budget_get", params, () =>
      asCloudMcpResult(async () =>
        withBudgetGate(async (_gate, cp) => {
          const facade = cp as unknown as {
            cloudBudgets: import("./control-plane/storage/driver.js").CloudBudgetRepo;
            cloudUsage: import("./control-plane/storage/driver.js").CloudUsageRepo;
          };
          const { monthBoundsUtc } = await import("./cloud/budget.js");
          const budget = await facade.cloudBudgets.get(params.org_id);
          const { startedAtFrom, startedAtTo } = monthBoundsUtc(new Date());
          const usageCents = await facade.cloudUsage.sumForRange({
            orgId: params.org_id,
            startedAtFrom,
            startedAtTo,
          });
          return { orgId: params.org_id, budget, usageCents, monthStart: startedAtFrom };
        }),
      ),
    ),
);

server.tool(
  "signalman_budget_set",
  "Create or update the per-org cloud-spend budget. Soft-warn percentage defaults to 80% (per design §13.5). Hard refusal at 100% is non-configurable. Setting a budget is the explicit opt-in — orgs without a row in the table are treated as unlimited.",
  {
    org_id: z.string().describe("Owning org id."),
    monthly_cents_limit: z
      .number()
      .int()
      .positive()
      .describe("Monthly limit in cents (e.g. 50000 = $500/month)."),
    soft_warn_pct: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe("Soft-warning threshold, defaults to 80."),
  },
  async (params) =>
    withRecording("signalman_budget_set", params, () =>
      asCloudMcpResult(async () =>
        withBudgetGate(async (_gate, cp) => {
          const facade = cp as unknown as {
            cloudBudgets: import("./control-plane/storage/driver.js").CloudBudgetRepo;
          };
          return facade.cloudBudgets.upsert({
            orgId: params.org_id,
            monthlyCentsLimit: params.monthly_cents_limit,
            softWarnPct: params.soft_warn_pct,
          });
        }),
      ),
    ),
);

server.tool(
  "signalman_budget_usage",
  "List per-instance cloud usage rows for the org's current calendar month. Each row has the SKU, region, started/terminated timestamps, and estimated cost in cents. Use this to investigate budget exhaustion (which instance types / scenarios are accumulating).",
  {
    org_id: z.string().describe("Owning org id."),
  },
  async (params) =>
    withRecording("signalman_budget_usage", params, () =>
      asCloudMcpResult(async () =>
        withBudgetGate(async (_gate, cp) => {
          const facade = cp as unknown as {
            cloudUsage: import("./control-plane/storage/driver.js").CloudUsageRepo;
          };
          const { monthBoundsUtc } = await import("./cloud/budget.js");
          const { startedAtFrom, startedAtTo } = monthBoundsUtc(new Date());
          const rows = await facade.cloudUsage.listForOrg(params.org_id, {
            startedAtFrom,
            startedAtTo,
          });
          const totalCents = rows.reduce((s, r) => s + r.estimatedCents, 0);
          return { orgId: params.org_id, monthStart: startedAtFrom, totalCents, rows };
        }),
      ),
    ),
);

// ── v0.3.0-5 sub-task 6: per-org credentials at rest ─────────────
//
// Three operator-facing tools (get / set / remove). All three
// touch encrypted-at-rest credentials; reads return REDACTED
// hints, never the plaintext secret. Decryption happens only
// at the call site (provisionInstance) via the loader helper.

server.tool(
  "signalman_creds_set",
  "Encrypt and store per-org cloud credentials. AWS shape: {access_key_id, secret_access_key, session_token?}. Azure shape: {tenant_id, client_id, client_secret}. Requires SIGNALMAN_CRED_KEY env var (base64 32-byte AES-256-GCM key). Returns only the redacted hint; the plaintext does NOT echo back. Idempotent upsert — re-running with new plaintext rotates the stored secret.",
  {
    org_id: z.string().describe("Owning org id."),
    backend: z.enum(["aws", "azure"]),
    aws: z
      .object({
        access_key_id: z.string(),
        secret_access_key: z.string(),
        session_token: z.string().optional(),
      })
      .optional()
      .describe("AWS credential plaintext (required when backend=aws)."),
    azure: z
      .object({
        tenant_id: z.string(),
        client_id: z.string(),
        client_secret: z.string(),
      })
      .optional()
      .describe("Azure credential plaintext (required when backend=azure)."),
  },
  async (params) =>
    withRecording("signalman_creds_set", params, () =>
      asCloudMcpResult(async () => {
        const { setCredential } = await import("./cloud/credentials.js");
        const { ControlPlane } = await import("./control-plane/index.js");
        const { loadConfig } = await import("./config.js");
        const config = loadConfig();
        const cp = ControlPlane.fromConfig(config.controlPlane);
        await cp.init();
        try {
          if (params.backend === "aws") {
            if (!params.aws) {
              throw new CloudBackendError(
                "invalid_config",
                "backend=aws requires the 'aws' plaintext object",
              );
            }
            return setCredential(cp.cloudCredentials, params.org_id, "aws", params.aws);
          } else {
            if (!params.azure) {
              throw new CloudBackendError(
                "invalid_config",
                "backend=azure requires the 'azure' plaintext object",
              );
            }
            return setCredential(cp.cloudCredentials, params.org_id, "azure", params.azure);
          }
        } finally {
          await cp.close();
        }
      }),
    ),
);

server.tool(
  "signalman_creds_get",
  "Return the per-org credential row's REDACTED metadata: backend, redacted hint (e.g. 'AKIA****EXAMPLE'), encryption method, timestamps. The plaintext secret is NEVER returned; this tool is for confirming the right credential is wired, not for retrieving secrets. Returns null when no credential is configured (caller falls back to SDK default chain).",
  {
    org_id: z.string(),
    backend: z.enum(["aws", "azure"]),
  },
  async (params) =>
    withRecording("signalman_creds_get", params, () =>
      asCloudMcpResult(async () => {
        const { ControlPlane } = await import("./control-plane/index.js");
        const { loadConfig } = await import("./config.js");
        const config = loadConfig();
        const cp = ControlPlane.fromConfig(config.controlPlane);
        await cp.init();
        try {
          const row = await cp.cloudCredentials.get(params.org_id, params.backend);
          if (!row) return null;
          // Return only the safe fields; do NOT echo ciphertextB64.
          return {
            id: row.id,
            orgId: row.orgId,
            backend: row.backend,
            redactedHint: row.redactedHint,
            encryptionMethod: row.encryptionMethod,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
          };
        } finally {
          await cp.close();
        }
      }),
    ),
);

server.tool(
  "signalman_creds_remove",
  "Remove the per-org credential row. Idempotent — removing a non-existent row is success. After remove, provision falls back to the SDK default credential chain.",
  {
    org_id: z.string(),
    backend: z.enum(["aws", "azure"]),
  },
  async (params) =>
    withRecording("signalman_creds_remove", params, () =>
      asCloudMcpResult(async () => {
        const { ControlPlane } = await import("./control-plane/index.js");
        const { loadConfig } = await import("./config.js");
        const config = loadConfig();
        const cp = ControlPlane.fromConfig(config.controlPlane);
        await cp.init();
        try {
          await cp.cloudCredentials.remove(params.org_id, params.backend);
          return { ok: true };
        } finally {
          await cp.close();
        }
      }),
    ),
);

// ── K8s tools (v0.3.0-6 sub-task 1) ───────────────────────────────

/**
 * K8s-specific result envelope. Mirrors `asCloudMcpResult`: surfaces
 * the K8sDriverError stable `code` to agents verbatim so they can
 * dispatch on it without parsing message strings. Kept separate so a
 * future refactor of either envelope helper doesn't fan out.
 */
function asK8sMcpResult<T>(fn: () => Promise<T>): Promise<{
  content: { type: "text"; text: string }[];
  isError?: boolean;
}> {
  return fn()
    .then((value) => asMcpResult({ ok: true, value }))
    .catch((err: unknown) => {
      const e = err as { code?: string };
      const payload = {
        ok: false,
        error: {
          code: typeof e?.code === "string" ? e.code : "unknown",
          message: (err as Error)?.message ?? String(err),
        },
      };
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(payload, null, 2) },
        ],
        isError: true,
      };
    });
}

server.tool(
  "signalman_k8s_deploy",
  "Deploy a Kubernetes bundle. Auto-dispatches between `kubectl apply -k` and `helm upgrade --install` based on whether the bundle directory contains Chart.yaml. Optionally runs `kubectl wait --for=condition=Ready pod` after apply.",
  {
    bundle_uri: z
      .string()
      .describe(
        "Absolute path to a manifest bundle (directory or single .yaml file) or a Helm chart directory containing Chart.yaml.",
      ),
    namespace: z.string().describe("Target Kubernetes namespace."),
    cluster_context: z
      .string()
      .optional()
      .describe("Optional kubectl/helm context name; defaults to KUBECONFIG selection."),
    release_name: z
      .string()
      .optional()
      .describe("Helm release name (ignored for kubectl). Defaults to bundle basename."),
    wait_for_health: z
      .boolean()
      .optional()
      .describe(
        "If true (default), run `kubectl wait` after apply and surface health.ready in the response.",
      ),
    health_timeout_ms: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Wait timeout in milliseconds; defaults to 5 minutes."),
  },
  async (params) =>
    withRecording("signalman_k8s_deploy", params, () =>
      asK8sMcpResult(async () => {
        const { runK8sDeployVerb } = await import("./verbs/control-plane.js");
        return await runK8sDeployVerb({
          bundleUri: params.bundle_uri,
          namespace: params.namespace,
          clusterContext: params.cluster_context,
          releaseName: params.release_name,
          waitForHealth: params.wait_for_health,
          healthTimeoutMs: params.health_timeout_ms,
        });
      }),
    ),
);

server.tool(
  "signalman_k8s_rollback",
  "Roll back a Kubernetes release via `kubectl rollout undo` or `helm rollback`. Pass driver=helm for Helm-deployed releases. release_id is the rollout subject for kubectl (e.g. 'deployment/my-app') or the Helm release name for helm.",
  {
    release_id: z
      .string()
      .describe(
        "Rollback subject. For kubectl: 'deployment/<name>'. For helm: the Helm release name.",
      ),
    namespace: z.string(),
    cluster_context: z.string().optional(),
    to_revision: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Optional explicit revision to roll back to."),
    driver: z
      .enum(["kubectl", "helm"])
      .optional()
      .describe("Driver to use. Defaults to 'kubectl'."),
  },
  async (params) =>
    withRecording("signalman_k8s_rollback", params, () =>
      asK8sMcpResult(async () => {
        const { runK8sRollbackVerb } = await import("./verbs/control-plane.js");
        return await runK8sRollbackVerb({
          releaseId: params.release_id,
          namespace: params.namespace,
          clusterContext: params.cluster_context,
          toRevision: params.to_revision,
          driver: params.driver,
        });
      }),
    ),
);

server.tool(
  "signalman_k8s_status",
  "Read deployment status in a namespace. Defaults to `kubectl get deployments -o json`; pass driver=helm + release_name for `helm status`. Returns a normalised workload list with derived state (healthy/degraded/unknown).",
  {
    namespace: z.string(),
    cluster_context: z.string().optional(),
    selector: z
      .string()
      .optional()
      .describe("Optional label selector (kubectl `-l`)."),
    release_name: z
      .string()
      .optional()
      .describe("Required when driver='helm'."),
    driver: z.enum(["kubectl", "helm"]).optional(),
  },
  async (params) =>
    withRecording("signalman_k8s_status", params, () =>
      asK8sMcpResult(async () => {
        const { runK8sStatusVerb } = await import("./verbs/control-plane.js");
        return await runK8sStatusVerb({
          namespace: params.namespace,
          clusterContext: params.cluster_context,
          selector: params.selector,
          releaseName: params.release_name,
          driver: params.driver,
        });
      }),
    ),
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
