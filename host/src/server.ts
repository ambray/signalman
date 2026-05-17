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
  createDefaultProbeInvoker,
  runAuditAppend,
  runAuditQuery,
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
  runReleaseVerify,
  runRunnerDeregister,
  runRunnerList,
  runScheduleAdd,
  runScheduleDisable,
  runScheduleEnable,
  runScheduleList,
  runScheduleRemove,
  runTargetAdd,
  runTargetEdit,
  runTargetList,
  runTargetRemove,
  runWebhookAdd,
  runWebhookList,
  runWebhookRemove,
  runWebhookTest,
  runPromotionPolicyAdd,
  runPromotionPolicyList,
  runPromotionPolicyRemove,
  runApprovalList,
  runPromotionApprove,
  runPromotionReject,
  runPromotionTickVerb,
  withControlPlane,
} from "./verbs/control-plane.js";
import {
  runSigningKeysAdd,
  runSigningKeysList,
  runSigningKeysRevoke,
  runSigningKeysRotate,
  runSigningVerify,
} from "./verbs/signing.js";
import type { SignEnvelope } from "./control-plane/signing/index.js";
import { runSchedulerTick } from "./control-plane/scheduler/index.js";
// WS6 M2: P1 MCP wrapper deps
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  generateKeypair,
  fingerprintPublicKey,
} from "./control-plane/build/signing.js";
import { generateApiKey } from "./http/auth.js";
import { ControlPlane } from "./control-plane/index.js";
import { loadConfig as loadHostConfig } from "./config.js";
import {
  writeRunnerConfig,
  defaultRunnerConfigPath,
  type RunnerConfig,
} from "./runner/config.js";
import { HttpClient, HttpClientError } from "./runner/client.js";
import { resolvePemInput } from "./server-helpers.js";

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
  "signalman_target_edit",
  "Edit an existing target's name and/or connection. `kind` and `id` are intentionally NOT editable — for a kind change, use remove + re-add. Past deployments are not retroactively updated; rollback and health-check use the post-edit connection. Logs a `target.edited` audit entry with before/after detail.",
  {
    name: z.string().describe("Current target name (lookup key)."),
    new_name: z
      .string()
      .optional()
      .describe("Rename the target. Must be unique among active targets in the same org."),
    connection: z
      .record(z.string(), z.unknown())
      .optional()
      .describe(
        "Replacement connection JSON. Replaces the whole object; do not pass a partial patch.",
      ),
  },
  async (params) =>
    withRecording("signalman_target_edit", params, async () => {
      const p = params as {
        name: string;
        new_name?: string;
        connection?: Record<string, unknown>;
      };
      const updated = await withControlPlane((cp) =>
        runTargetEdit(cp, {
          name: p.name,
          newName: p.new_name,
          newConnection: p.connection,
        }),
      );
      return asMcpResult(updated);
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

// ── WS6 milestone 2 — P1 MCP wrappers for CLI-only verbs ──────────
//
// The capability matrix flagged several CLI-only verbs as P1. Agents
// previously had to shell out via Bash; these tools give them a
// structured MCP surface. Each tool's CLI counterpart still exists
// and behaves the same — these are additive.
//
// Tool families:
//   - signalman_release_verify — Ed25519 manifest signature check
//   - signalman_key_generate / signalman_key_fingerprint — key ops
//   - signalman_api_key_create / _list / _revoke — bearer token CRUD
//   - signalman_runner_build_config / _persist_config — runner setup
//     (split per operator's "Both as separate tools" preference)
//   - signalman_release_build_remote — submit + poll release.build job

server.tool(
  "signalman_release_verify",
  "Verify a release's Ed25519 manifest signature against a public key. Returns verified=true on fingerprint + signature match; verified=false with a reason string otherwise. CLI parity with `signalman release verify`.",
  {
    release_id: z.string().describe("Release ULID (from signalman_release_list)."),
    public_key_path: z
      .string()
      .optional()
      .describe(
        "Filesystem path to the Ed25519 public key PEM on the host. Mutually exclusive with public_key_pem.",
      ),
    public_key_pem: z
      .string()
      .optional()
      .describe(
        "Literal PEM-encoded Ed25519 public key. Mutually exclusive with public_key_path; use this when running on a different host than the keys.",
      ),
  },
  async (params) =>
    withRecording("signalman_release_verify", params, async () => {
      const p = params as {
        release_id: string;
        public_key_path?: string;
        public_key_pem?: string;
      };
      const pem = await resolvePemInput(
        p.public_key_path,
        p.public_key_pem,
        "signalman_release_verify",
      );
      const result = await withControlPlane((cp) =>
        runReleaseVerify(cp, { releaseId: p.release_id, publicKeyPem: pem }),
      );
      return asMcpResult({
        verified: result.verified,
        release: {
          id: result.release.id,
          tag: result.release.tag,
          product: result.product.name,
          manifest_sha256: result.release.manifestSha256,
          signed_by: result.release.signedBy,
        },
        ...(result.verified ? {} : { reason: result.reason }),
      });
    }),
);

server.tool(
  "signalman_key_generate",
  "Generate a fresh Ed25519 signing keypair. Default: write to ~/.signalman/keys/signing.{pub,key} (private mode 0600). When write_to_disk=false, returns the PEM text inline and writes nothing — useful for hosted mode where the agent shouldn't write to the server's filesystem.",
  {
    name: z
      .string()
      .optional()
      .describe("Filename stem (default: 'signing'). Output is <out>/<name>.pub + <name>.key."),
    out_dir: z
      .string()
      .optional()
      .describe("Output directory (default: ~/.signalman/keys). Ignored when write_to_disk=false."),
    force: z
      .boolean()
      .optional()
      .describe("Overwrite existing keys at the target paths. Default false; refuses to clobber."),
    write_to_disk: z
      .boolean()
      .optional()
      .describe("Write PEMs to disk. Default true. When false, response carries the PEMs inline."),
  },
  async (params) =>
    withRecording("signalman_key_generate", params, async () => {
      const p = params as {
        name?: string;
        out_dir?: string;
        force?: boolean;
        write_to_disk?: boolean;
      };
      const kp = generateKeypair();
      const fp = fingerprintPublicKey(kp.publicKeyPem);
      const writeToDisk = p.write_to_disk !== false; // default true

      if (!writeToDisk) {
        return asMcpResult({
          fingerprint: fp,
          public_key_pem: kp.publicKeyPem,
          private_key_pem: kp.privateKeyPem,
          written: false,
        });
      }

      const outDir = p.out_dir
        ? path.resolve(p.out_dir)
        : path.join(os.homedir(), ".signalman", "keys");
      const stem = p.name ?? "signing";
      const pubPath = path.join(outDir, `${stem}.pub`);
      const privPath = path.join(outDir, `${stem}.key`);

      if (!p.force) {
        for (const target of [pubPath, privPath]) {
          if (fs.existsSync(target)) {
            throw new Error(
              `signalman_key_generate: ${target} already exists. Pass force=true to overwrite (loses the existing key).`,
            );
          }
        }
      }
      await fsp.mkdir(outDir, { recursive: true });
      await fsp.writeFile(pubPath, kp.publicKeyPem, "utf-8");
      await fsp.writeFile(privPath, kp.privateKeyPem, {
        encoding: "utf-8",
        mode: 0o600,
      });
      return asMcpResult({
        fingerprint: fp,
        public_key_path: pubPath,
        private_key_path: privPath,
        written: true,
      });
    }),
);

server.tool(
  "signalman_key_fingerprint",
  "Compute the 16-hex-char fingerprint (first 16 chars of sha256(DER pubkey)) of an Ed25519 public key. Accepts either a path on the host or inline PEM. The fingerprint matches the `signed_by` field on releases this key signed.",
  {
    public_key_path: z
      .string()
      .optional()
      .describe("Filesystem path to the public key PEM. Mutually exclusive with public_key_pem."),
    public_key_pem: z
      .string()
      .optional()
      .describe("Literal PEM-encoded Ed25519 public key. Mutually exclusive with public_key_path."),
  },
  async (params) =>
    withRecording("signalman_key_fingerprint", params, async () => {
      const p = params as { public_key_path?: string; public_key_pem?: string };
      const pem = await resolvePemInput(
        p.public_key_path,
        p.public_key_pem,
        "signalman_key_fingerprint",
      );
      const fp = fingerprintPublicKey(pem);
      return asMcpResult({ fingerprint: fp });
    }),
);

server.tool(
  "signalman_api_key_create",
  "Mint a new bearer-token API key for the active org. The secret token is returned ONCE in the response — there is no way to recover it later. Agents must surface it to the operator and not retain it across calls.",
  {
    name: z.string().describe("Friendly name for the key (e.g. 'builder-1', 'ci-pipeline')."),
    expires_at: z
      .string()
      .optional()
      .describe("Optional ISO-8601 expiry. Omit for non-expiring keys."),
  },
  async (params) =>
    withRecording("signalman_api_key_create", params, async () => {
      const p = params as { name: string; expires_at?: string };
      const config = loadHostConfig();
      const cp = ControlPlane.fromConfig(config.controlPlane);
      try {
        const { defaultOrg } = await cp.init();
        const generated = generateApiKey();
        const row = await cp.apiKeys.create({
          orgId: defaultOrg.id,
          name: p.name,
          prefix: generated.prefix,
          hash: generated.hash,
          expiresAt: p.expires_at,
        });
        return asMcpResult({
          api_key: {
            id: row.id,
            name: row.name,
            prefix: row.prefix,
            expires_at: row.expiresAt ?? null,
            created_at: row.createdAt,
          },
          token: generated.token,
          warning: "Token shown ONCE — save it now; it cannot be recovered later.",
        });
      } finally {
        await cp.close();
      }
    }),
);

server.tool(
  "signalman_api_key_list",
  "List active (non-revoked) API keys for the active org. Returns id, name, prefix, and expiry — never the secret or its hash.",
  {},
  async (params) =>
    withRecording("signalman_api_key_list", params, async () => {
      const config = loadHostConfig();
      const cp = ControlPlane.fromConfig(config.controlPlane);
      try {
        const { defaultOrg } = await cp.init();
        const keys = await cp.apiKeys.listForOrg(defaultOrg.id);
        return asMcpResult({
          api_keys: keys.map((k) => ({
            id: k.id,
            name: k.name,
            prefix: k.prefix,
            expires_at: k.expiresAt ?? null,
            created_at: k.createdAt,
          })),
        });
      } finally {
        await cp.close();
      }
    }),
);

server.tool(
  "signalman_api_key_revoke",
  "Soft-delete an API key by id. The key immediately stops authenticating; past audit-log entries referencing it remain.",
  {
    id: z.string().describe("API key ULID (from signalman_api_key_list)."),
  },
  async (params) =>
    withRecording("signalman_api_key_revoke", params, async () => {
      const p = params as { id: string };
      const config = loadHostConfig();
      const cp = ControlPlane.fromConfig(config.controlPlane);
      try {
        await cp.init();
        const key = await cp.apiKeys.get(p.id);
        if (!key) throw new Error(`api key not found: ${p.id}`);
        await cp.apiKeys.softDelete(key.id);
        return asMcpResult({
          revoked: { id: key.id, name: key.name, prefix: key.prefix },
        });
      } finally {
        await cp.close();
      }
    }),
);

server.tool(
  "signalman_runner_build_config",
  "Construct and validate a runner registration config (control_plane_url + token + optional worker_name). Returns the config envelope WITHOUT writing it. Pair with signalman_runner_persist_config to actually register the runner; the split lets callers inspect or transform the envelope before commit.",
  {
    control_plane_url: z
      .string()
      .describe("Base URL of the control plane (e.g. http://control.example.com:8765)."),
    token: z
      .string()
      .describe("Bearer token for this runner. Mint via signalman_api_key_create on the control-plane host."),
    worker_name: z
      .string()
      .optional()
      .describe("Optional friendly worker name. When omitted, the runner derives one at start time."),
  },
  async (params) =>
    withRecording("signalman_runner_build_config", params, async () => {
      const p = params as {
        control_plane_url: string;
        token: string;
        worker_name?: string;
      };
      if (p.control_plane_url.length === 0) {
        throw new Error("signalman_runner_build_config: control_plane_url must be non-empty");
      }
      if (p.token.length === 0) {
        throw new Error("signalman_runner_build_config: token must be non-empty");
      }
      const envelope: RunnerConfig = {
        controlPlaneUrl: p.control_plane_url,
        token: p.token,
        ...(p.worker_name ? { workerName: p.worker_name } : {}),
      };
      return asMcpResult({
        config: {
          control_plane_url: envelope.controlPlaneUrl,
          token_prefix: envelope.token.slice(0, 12) + "…",
          worker_name: envelope.workerName ?? null,
        },
        envelope,
        target_path: defaultRunnerConfigPath(),
      });
    }),
);

server.tool(
  "signalman_runner_persist_config",
  "Write a runner config envelope to disk. Default target: $SIGNALMAN_DATA_DIR/runner.yaml (or ~/.signalman/runner.yaml when unset). Mode 0600 on POSIX. Idempotent: overwrites whatever is there.",
  {
    control_plane_url: z.string(),
    token: z.string(),
    worker_name: z.string().optional(),
    target_path: z
      .string()
      .optional()
      .describe("Override the default target path. Useful for tests and non-default install layouts."),
  },
  async (params) =>
    withRecording("signalman_runner_persist_config", params, async () => {
      const p = params as {
        control_plane_url: string;
        token: string;
        worker_name?: string;
        target_path?: string;
      };
      const target = p.target_path ?? defaultRunnerConfigPath();
      await writeRunnerConfig(
        {
          controlPlaneUrl: p.control_plane_url,
          token: p.token,
          workerName: p.worker_name,
        },
        target,
      );
      return asMcpResult({ written: true, path: target });
    }),
);

server.tool(
  "signalman_runner_list",
  "List registered build runners for the active org, newest-last_seen first. Each entry carries the raw runner row plus an `isStale` flag computed from `last_seen_at` + a threshold (default 90s; configurable). Stale rows are preserved for audit; use `signalman_runner_deregister` to actually remove a dead runner.",
  {
    stale_threshold_seconds: z
      .number()
      .int()
      .min(1)
      .max(86400)
      .optional()
      .describe(
        "Seconds since `last_seen_at` to flag a runner as stale. Default 90 (matches the worker heartbeat cadence of 30s + 2 missed beats).",
      ),
  },
  async (params) =>
    withRecording("signalman_runner_list", params, async () => {
      const p = params as { stale_threshold_seconds?: number };
      const entries = await withControlPlane((cp) =>
        runRunnerList(cp, { staleThresholdSeconds: p.stale_threshold_seconds }),
      );
      return asMcpResult({
        runners: entries.map((e) => ({
          id: e.runner.id,
          name: e.runner.name,
          last_seen_at: e.runner.lastSeenAt,
          registered_at: e.runner.registeredAt,
          meta: e.runner.meta,
          is_stale: e.isStale,
        })),
      });
    }),
);

server.tool(
  "signalman_runner_deregister",
  "Soft-delete a registered runner by name or id. The row is preserved for audit. A worker that heartbeats again under the same name will resurrect the row with a fresh registered_at; deregister is for the case where the operator wants to mark a worker permanently retired.",
  {
    name: z
      .string()
      .optional()
      .describe("Runner name (preferred for operator use)."),
    id: z
      .string()
      .optional()
      .describe("Runner ULID (preferred for automation)."),
  },
  async (params) =>
    withRecording("signalman_runner_deregister", params, async () => {
      const p = params as { name?: string; id?: string };
      const result = await withControlPlane((cp) =>
        runRunnerDeregister(cp, { name: p.name, id: p.id }),
      );
      return asMcpResult({ deregistered: result });
    }),
);

// WS6 M9 — runner deploy multi-transport (script / ssh / winrm / docker / cloud).
server.tool(
  "signalman_runner_deploy",
  "Deploy a Signalman runner to a remote target via one of five transports (script / ssh / winrm / docker / cloud). The `binary_url` points at the runner binary (typically a `@signalman/registry` blob URL); the transport downloads it on the remote, writes the registration config, and starts the service. By default waits up to 60s for the runner to heartbeat before declaring success. Set `wait_timeout_ms: 0` to fire-and-forget. The `script` transport returns an executable script string instead of dispatching remotely — operator runs it themselves.",
  {
    binary_url: z
      .string()
      .url()
      .describe("HTTP(S) URL to the runner binary. Registry blob URLs (`/v1/blobs/sha256:<hash>`) work; any URL the remote can curl is acceptable."),
    binary_sha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional()
      .describe("Optional sha256 (64 hex chars). When set, transport verifies after download and refuses to install on mismatch."),
    binary_version: z
      .string()
      .optional()
      .describe("Operator-named version string for audit clarity."),
    control_plane_url: z
      .string()
      .url()
      .describe("Control-plane URL the runner reports to."),
    token: z
      .string()
      .describe("API key the runner authenticates with (mint via signalman_api_key_create)."),
    worker_name: z
      .string()
      .describe("Friendly worker name; surfaces in the runners table."),
    transport: z
      .union([
        z.object({
          kind: z.literal("script"),
          os: z.enum(["linux", "macos", "windows"]),
          output_path: z.string().optional(),
        }),
        z.object({
          kind: z.literal("ssh"),
          host: z.string(),
          identity_path: z.string(),
          port: z.number().int().optional(),
          service_manager: z.enum(["systemd", "launchd", "none"]).optional(),
          proxy_jump: z.string().optional(),
        }),
        z.object({
          kind: z.literal("winrm"),
          host: z.string(),
          username: z.string(),
          password: z.string(),
          port: z.number().int().optional(),
          use_ssl: z.boolean().optional(),
        }),
        z.object({
          kind: z.literal("docker"),
          image: z.string(),
          context: z.string().optional(),
          container_name: z.string().optional(),
          extra_volumes: z.array(z.string()).optional(),
          extra_env: z.record(z.string()).optional(),
        }),
        z.object({
          kind: z.literal("cloud"),
          provider: z.enum(["aws", "azure"]),
          region: z.string(),
          instance_type: z.string(),
          image_ref: z.string(),
          name: z.string(),
          os_family: z.enum(["linux", "windows"]),
          inner_ssh_identity_path: z.string().optional(),
          inner_winrm_username: z.string().optional(),
          inner_winrm_password: z.string().optional(),
          org_id: z.string().optional(),
          ttl_minutes: z.number().int().optional(),
        }),
      ])
      .describe("Transport-specific options. Discriminated by `kind`."),
    wait_timeout_ms: z
      .number()
      .int()
      .min(0)
      .max(600_000)
      .optional()
      .describe("Heartbeat-verification budget. 0 disables. Default 60000."),
  },
  async (params) =>
    withRecording("signalman_runner_deploy", params, async () => {
      const p = params as {
        binary_url: string;
        binary_sha256?: string;
        binary_version?: string;
        control_plane_url: string;
        token: string;
        worker_name: string;
        transport: Record<string, unknown> & { kind: string };
        wait_timeout_ms?: number;
      };
      // Translate snake_case wire schema into the verb's
      // camelCase TransportOptions union.
      const t = p.transport;
      let transportOpts:
        | import("./runner/deploy/index.js").TransportOptions;
      switch (t.kind) {
        case "script":
          transportOpts = {
            kind: "script",
            os: t.os as "linux" | "macos" | "windows",
            outputPath: t.output_path as string | undefined,
          };
          break;
        case "ssh":
          transportOpts = {
            kind: "ssh",
            host: t.host as string,
            identityPath: t.identity_path as string,
            port: t.port as number | undefined,
            serviceManager: t.service_manager as
              | "systemd"
              | "launchd"
              | "none"
              | undefined,
            proxyJump: t.proxy_jump as string | undefined,
          };
          break;
        case "winrm":
          transportOpts = {
            kind: "winrm",
            host: t.host as string,
            username: t.username as string,
            password: t.password as string,
            port: t.port as number | undefined,
            useSsl: t.use_ssl as boolean | undefined,
          };
          break;
        case "docker":
          transportOpts = {
            kind: "docker",
            image: t.image as string,
            context: t.context as string | undefined,
            containerName: t.container_name as string | undefined,
            extraVolumes: t.extra_volumes as string[] | undefined,
            extraEnv: t.extra_env as Record<string, string> | undefined,
          };
          break;
        case "cloud":
          transportOpts = {
            kind: "cloud",
            provider: t.provider as "aws" | "azure",
            region: t.region as string,
            instanceType: t.instance_type as string,
            imageRef: t.image_ref as string,
            name: t.name as string,
            osFamily: t.os_family as "linux" | "windows",
            innerSsh: t.inner_ssh_identity_path
              ? { identityPath: t.inner_ssh_identity_path as string }
              : undefined,
            innerWinRm:
              t.inner_winrm_username && t.inner_winrm_password
                ? {
                    username: t.inner_winrm_username as string,
                    password: t.inner_winrm_password as string,
                  }
                : undefined,
            orgId: t.org_id as string | undefined,
            ttlMinutes: t.ttl_minutes as number | undefined,
          };
          break;
        default:
          throw new Error(`unknown transport kind: ${t.kind}`);
      }
      const { runRunnerDeploy } = await import("./runner/deploy/index.js");
      const result = await withControlPlane((cp) =>
        runRunnerDeploy(cp, {
          binary: {
            url: p.binary_url,
            sha256: p.binary_sha256,
            version: p.binary_version,
          },
          controlPlaneUrl: p.control_plane_url,
          token: p.token,
          workerName: p.worker_name,
          transport: transportOpts,
          waitTimeoutMs: p.wait_timeout_ms,
        }),
      );
      return asMcpResult({
        bootstrap: result.bootstrap,
        verification: result.verification ?? null,
      });
    }),
);

server.tool(
  "signalman_release_build_remote",
  "Submit a release.build job to the runner queue and poll until terminal. Equivalent to `signalman release build --remote`. Requires a registered runner config (~/.signalman/runner.yaml). Long-running: a successful response means the job finished (succeeded or failed); intermediate progress is recorded via the call's withRecording wrapper.",
  {
    product: z.string().describe("Product name."),
    tag: z.string().describe("Git tag to build."),
    poll_interval_ms: z
      .number()
      .int()
      .min(100)
      .max(10000)
      .optional()
      .describe("How often to poll the job for terminal state. Default 750ms (matches CLI)."),
  },
  async (params) =>
    withRecording("signalman_release_build_remote", params, async () => {
      const p = params as {
        product: string;
        tag: string;
        poll_interval_ms?: number;
      };
      // Read runner config from disk; same as the CLI path.
      const { loadRunnerConfig } = await import("./runner/config.js");
      const config = await loadRunnerConfig();
      const client = new HttpClient({
        baseUrl: config.controlPlaneUrl,
        token: config.token,
      });
      let product;
      try {
        product = await client.productByName(p.product);
      } catch (err) {
        if (err instanceof HttpClientError) {
          throw new Error(
            `signalman_release_build_remote: HTTP ${err.status} (${err.code}) resolving product '${p.product}': ${err.message}`,
          );
        }
        throw err;
      }
      const job = await client.submitJob("release.build", {
        product_id: product.id,
        product_name: product.name,
        tag: p.tag,
      });
      const pollMs = p.poll_interval_ms ?? 750;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const cur = await client.getJob(job.id);
        if (cur.status === "succeeded" || cur.status === "failed") {
          return asMcpResult({
            job: {
              id: cur.id,
              status: cur.status,
              kind: cur.kind,
              error: cur.error ?? null,
              result: cur.result ?? null,
            },
          });
        }
        await new Promise((r) => setTimeout(r, pollMs));
      }
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

// ── Scheduled health verbs (v0.4.0-3 / Epic 3) ────────────────────

server.tool(
  "signalman_schedule_list",
  "List periodic health-check schedules in the active org. Optionally filtered to one target.",
  {
    target: z
      .string()
      .optional()
      .describe("Filter to schedules attached to this target by name."),
  },
  async (params) =>
    withRecording("signalman_schedule_list", params, async () =>
      asMcpResult(
        await withControlPlane((cp) =>
          runScheduleList(cp, {
            targetName: (params as { target?: string }).target,
          }),
        ),
      ),
    ),
);

server.tool(
  "signalman_schedule_add",
  "Register a periodic health-check schedule for a target. The scheduler tick (signalman schedule run-once / start) re-runs the named probes against the target's active deployment every interval_seconds.",
  {
    target: z.string().describe("Target name to probe."),
    interval_seconds: z
      .number()
      .int()
      .min(60)
      .describe("Minimum gap between runs (seconds). >= 60."),
    probes: z
      .array(z.string())
      .optional()
      .describe(
        "Probe names from the target's active release's build.yaml. " +
          "Empty / omitted = all declared probes.",
      ),
    active: z
      .boolean()
      .optional()
      .describe("Set false to register the schedule disabled. Default true."),
  },
  async (params) =>
    withRecording("signalman_schedule_add", params, async () =>
      asMcpResult(
        await withControlPlane((cp) =>
          runScheduleAdd(cp, {
            targetName: (params as { target: string }).target,
            intervalSeconds: (params as { interval_seconds: number }).interval_seconds,
            probeNames: (params as { probes?: string[] }).probes,
            active: (params as { active?: boolean }).active,
          }),
        ),
      ),
    ),
);

server.tool(
  "signalman_schedule_disable",
  "Disable a health schedule without deleting it. Inactive schedules are skipped by the scheduler tick but stay queryable via signalman_schedule_list.",
  {
    id: z.string().describe("Schedule id from signalman_schedule_list."),
  },
  async (params) =>
    withRecording("signalman_schedule_disable", params, async () =>
      asMcpResult(
        await withControlPlane((cp) =>
          runScheduleDisable(cp, { id: (params as { id: string }).id }),
        ),
      ),
    ),
);

server.tool(
  "signalman_schedule_enable",
  "Re-enable a previously-disabled health schedule.",
  {
    id: z.string().describe("Schedule id."),
  },
  async (params) =>
    withRecording("signalman_schedule_enable", params, async () =>
      asMcpResult(
        await withControlPlane((cp) =>
          runScheduleEnable(cp, { id: (params as { id: string }).id }),
        ),
      ),
    ),
);

server.tool(
  "signalman_schedule_remove",
  "Soft-delete a health schedule. The row remains in storage for audit but is invisible to subsequent list calls.",
  {
    id: z.string().describe("Schedule id."),
  },
  async (params) =>
    withRecording("signalman_schedule_remove", params, async () => {
      await withControlPlane((cp) =>
        runScheduleRemove(cp, { id: (params as { id: string }).id }),
      );
      return asMcpResult({ removed: true });
    }),
);

server.tool(
  "signalman_schedule_run_once",
  "Execute a single scheduler tick: find due schedules, run their probes, persist results. Returns the count of schedules processed. Useful for CI cron paths and on-demand verification.",
  {},
  async (params) =>
    withRecording("signalman_schedule_run_once", params, async () =>
      asMcpResult(
        await withControlPlane(async (cp) => ({
          processed: await runSchedulerTick({
            controlPlane: cp,
            invoke: createDefaultProbeInvoker(cp),
          }),
        })),
      ),
    ),
);

// ── Webhook verbs (v0.4.0-2 / Epic 2) ─────────────────────────────

server.tool(
  "signalman_webhook_list",
  "List webhook subscriptions registered in the active org. Returns both active and disabled subscriptions; the dispatcher only delivers to active ones.",
  {},
  async (params) =>
    withRecording("signalman_webhook_list", params, async () =>
      asMcpResult(await withControlPlane((cp) => runWebhookList(cp))),
    ),
);

server.tool(
  "signalman_webhook_add",
  "Register a webhook subscription. Generic = POST JSON with HMAC-SHA256 signature header X-Signalman-Signature. Slack = formatted blocks. Email = mailto: URL with SMTP from SIGNALMAN_SMTP_URL (no-op when unset).",
  {
    kind: z.enum(["generic", "slack", "email"]),
    url: z
      .string()
      .describe(
        "Generic / Slack: http(s):// endpoint. Email: mailto:user@host or bare user@host.",
      ),
    secret: z
      .string()
      .optional()
      .describe(
        "HMAC-SHA256 shared secret. Generic kind only; ignored by Slack/email.",
      ),
    event_kinds: z
      .array(z.string())
      .optional()
      .describe(
        "Event kinds to receive (release-built / release-deployed / " +
          "deployment-rolled-back / health-failed / promotion-approved / " +
          "promotion-rejected). Empty / omitted = all kinds.",
      ),
    description: z.string().optional(),
  },
  async (params) =>
    withRecording("signalman_webhook_add", params, async () =>
      asMcpResult(
        await withControlPlane((cp) =>
          runWebhookAdd(cp, {
            kind: (params as { kind: "generic" | "slack" | "email" }).kind,
            url: (params as { url: string }).url,
            secretHmacKey: (params as { secret?: string }).secret,
            eventKinds: (params as { event_kinds?: string[] }).event_kinds,
            description: (params as { description?: string }).description,
          }),
        ),
      ),
    ),
);

server.tool(
  "signalman_webhook_remove",
  "Soft-delete a webhook subscription. The row stays in storage for audit.",
  {
    id: z.string().describe("Webhook subscription id from signalman_webhook_list."),
  },
  async (params) =>
    withRecording("signalman_webhook_remove", params, async () => {
      await withControlPlane((cp) =>
        runWebhookRemove(cp, { id: (params as { id: string }).id }),
      );
      return asMcpResult({ removed: true });
    }),
);

server.tool(
  "signalman_webhook_test",
  "Send a synthetic release-built event to a single subscription. Returns delivery outcome (status code for generic/slack, error reason for failures). Useful before relying on a subscription in the release-build / deploy paths.",
  {
    id: z.string().describe("Webhook subscription id."),
  },
  async (params) =>
    withRecording("signalman_webhook_test", params, async () =>
      asMcpResult(
        await withControlPlane((cp) =>
          runWebhookTest(cp, { id: (params as { id: string }).id }),
        ),
      ),
    ),
);

// ── Promotion verbs (v0.4.0-1 / Epic 1) ───────────────────────────

server.tool(
  "signalman_promotion_list",
  "List promotion policies in the active org. Each policy describes how a release of a product moves from one tier (source target) to another (dest target) — auto, manual, or time-delay gate.",
  {},
  async (params) =>
    withRecording("signalman_promotion_list", params, async () =>
      asMcpResult(await withControlPlane((cp) => runPromotionPolicyList(cp))),
    ),
);

server.tool(
  "signalman_promotion_add",
  "Register a promotion policy. Auto = fires deploy immediately on release-built. Manual = creates a pending approval row that signalman_promotion_approve flips. Time-delay = pending until auto_approve_at elapses; the promotion tick fires the deploy.",
  {
    product: z.string().describe("Product name."),
    dest: z.string().describe("Dest target name."),
    source: z
      .string()
      .optional()
      .describe("Source target name. Omit for the initial-tier policy (fires on release-built)."),
    gate: z.enum(["auto", "manual", "time_delay"]),
    gate_config: z
      .record(z.string(), z.unknown())
      .optional()
      .describe(
        "Kind-specific config. For time_delay supply { delay_seconds: N }.",
      ),
    description: z.string().optional(),
  },
  async (params) =>
    withRecording("signalman_promotion_add", params, async () =>
      asMcpResult(
        await withControlPlane((cp) =>
          runPromotionPolicyAdd(cp, {
            productName: (params as { product: string }).product,
            destTargetName: (params as { dest: string }).dest,
            sourceTargetName: (params as { source?: string }).source,
            gateKind: (params as { gate: "auto" | "manual" | "time_delay" }).gate,
            gateConfig: (params as { gate_config?: Record<string, unknown> }).gate_config,
            description: (params as { description?: string }).description,
          }),
        ),
      ),
    ),
);

server.tool(
  "signalman_promotion_remove",
  "Soft-delete a promotion policy. Existing in-flight approvals are not affected.",
  {
    id: z.string().describe("Promotion policy id."),
  },
  async (params) =>
    withRecording("signalman_promotion_remove", params, async () => {
      await withControlPlane((cp) =>
        runPromotionPolicyRemove(cp, { id: (params as { id: string }).id }),
      );
      return asMcpResult({ removed: true });
    }),
);

server.tool(
  "signalman_promotion_approve",
  "Approve a pending approval row and fire the deploy. Returns the deploy outcome (success / failed) and the resulting deployment id when one was created.",
  {
    id: z.string().describe("Approval id."),
    decided_by: z.string().optional().describe("Audit-log actor label."),
    reason: z.string().optional(),
  },
  async (params) =>
    withRecording("signalman_promotion_approve", params, async () =>
      asMcpResult(
        await withControlPlane((cp) =>
          runPromotionApprove(cp, {
            id: (params as { id: string }).id,
            decidedBy: (params as { decided_by?: string }).decided_by,
            reason: (params as { reason?: string }).reason,
          }),
        ),
      ),
    ),
);

server.tool(
  "signalman_promotion_reject",
  "Reject a pending approval. The approval row is preserved with status=rejected; no deploy is attempted.",
  {
    id: z.string().describe("Approval id."),
    decided_by: z.string().optional(),
    reason: z.string().optional(),
  },
  async (params) =>
    withRecording("signalman_promotion_reject", params, async () =>
      asMcpResult(
        await withControlPlane((cp) =>
          runPromotionReject(cp, {
            id: (params as { id: string }).id,
            decidedBy: (params as { decided_by?: string }).decided_by,
            reason: (params as { reason?: string }).reason,
          }),
        ),
      ),
    ),
);

server.tool(
  "signalman_promotion_approvals",
  "List approval rows in the active org. Optional status filter (pending / approved / rejected / auto_approved).",
  {
    status: z.enum(["pending", "approved", "rejected", "auto_approved"]).optional(),
  },
  async (params) =>
    withRecording("signalman_promotion_approvals", params, async () =>
      asMcpResult(
        await withControlPlane((cp) =>
          runApprovalList(cp, {
            status: (params as { status?: "pending" | "approved" | "rejected" | "auto_approved" })
              .status,
          }),
        ),
      ),
    ),
);

server.tool(
  "signalman_promotion_tick",
  "Process due `time_delay` approvals: find pending rows whose auto_approve_at has elapsed, flip to auto_approved, fire the deploy. Returns the count dispatched. Useful for cron paths.",
  {},
  async (params) =>
    withRecording("signalman_promotion_tick", params, async () =>
      asMcpResult(await withControlPlane((cp) => runPromotionTickVerb(cp))),
    ),
);

// ── WS6 M5 — audit log surface (P2 closure) ───────────────────────

server.tool(
  "signalman_audit_query",
  "List audit-log entries for the active org, newest-first. Filters are AND-combined: `entity_type` + `entity_id` narrow to a specific entity; `actor` + `action` filter by who/what; `since` is an ISO-8601 lower bound on createdAt. The repo handles entity-* + limit natively; actor/action/since are applied post-filter. For high-volume queries, narrow by entity_type or entity_id first. The audit log is immutable; this is read-only.",
  {
    since: z
      .string()
      .optional()
      .describe(
        "ISO-8601 lower bound on createdAt (e.g. '2026-05-01T00:00:00Z'). Entries older than this are dropped.",
      ),
    entity_type: z
      .string()
      .optional()
      .describe("Filter by exact entity_type (e.g. 'target', 'release', 'runner', 'deployment')."),
    entity_id: z
      .string()
      .optional()
      .describe("Filter by exact entity_id (typically a ULID or name)."),
    actor: z
      .string()
      .optional()
      .describe("Filter by exact actor (e.g. 'cli', 'ci', 'scheduler', or a user identifier)."),
    action: z
      .string()
      .optional()
      .describe("Filter by exact action (e.g. 'target.edited', 'release.deploy', 'runner.deregistered')."),
    limit: z
      .number()
      .int()
      .min(1)
      .max(1000)
      .optional()
      .describe("Max entries to return. Default unbounded (the repo caps internally for performance)."),
  },
  async (params) =>
    withRecording("signalman_audit_query", params, async () => {
      const p = params as {
        since?: string;
        entity_type?: string;
        entity_id?: string;
        actor?: string;
        action?: string;
        limit?: number;
      };
      const entries = await withControlPlane((cp) =>
        runAuditQuery(cp, {
          since: p.since,
          entityType: p.entity_type,
          entityId: p.entity_id,
          actor: p.actor,
          action: p.action,
          limit: p.limit,
        }),
      );
      return asMcpResult({
        entries: entries.map((e) => ({
          id: e.id,
          org_id: e.orgId,
          actor: e.actor,
          action: e.action,
          entity_type: e.entityType,
          entity_id: e.entityId,
          detail: e.detail,
          at: e.at,
          created_at: e.createdAt,
        })),
      });
    }),
);

server.tool(
  "signalman_audit_append",
  "Append a new audit-log entry. The audit log is immutable — there is no update or delete; this is the only operator-driven write path. Use for documenting out-of-band gestures (e.g. 'manually restarted target X', postmortem decisions) that complement the executor-driven appends (build / deploy / target edit / runner deregister auto-emit).",
  {
    actor: z
      .string()
      .min(1)
      .describe("Who is performing the action (e.g. 'cli', 'ci', or an operator identifier)."),
    action: z
      .string()
      .min(1)
      .describe("What is being done (e.g. 'incident.restart', 'manual.intervention')."),
    entity_type: z
      .string()
      .min(1)
      .describe("Kind of thing being acted on (e.g. 'target', 'release', 'runner')."),
    entity_id: z
      .string()
      .min(1)
      .describe("ULID or canonical name of the entity."),
    detail: z
      .record(z.unknown())
      .optional()
      .describe("Free-form structured detail blob. Stored verbatim; no schema enforced."),
  },
  async (params) =>
    withRecording("signalman_audit_append", params, async () => {
      const p = params as {
        actor: string;
        action: string;
        entity_type: string;
        entity_id: string;
        detail?: Record<string, unknown>;
      };
      const entry = await withControlPlane((cp) =>
        runAuditAppend(cp, {
          actor: p.actor,
          action: p.action,
          entityType: p.entity_type,
          entityId: p.entity_id,
          detail: p.detail,
        }),
      );
      return asMcpResult({
        entry: {
          id: entry.id,
          org_id: entry.orgId,
          actor: entry.actor,
          action: entry.action,
          entity_type: entry.entityType,
          entity_id: entry.entityId,
          detail: entry.detail,
          at: entry.at,
          created_at: entry.createdAt,
        },
      });
    }),
);

// ── WS9 M3 — signing-service MCP tools ───────────────────────────

server.tool(
  "signalman_signing_keys_list",
  "List signing keys registered in the WS9 catalog for the active org. Filter by provider with `provider`; include revoked rows with `include_revoked=true`. Hybrid keys appear as two rows sharing a `pair_id` and `hybrid_alias` (one classical, one post-quantum).",
  {
    provider: z
      .string()
      .optional()
      .describe("Filter to a single provider id (e.g. 'local-disk', 'aws-kms')."),
    include_revoked: z
      .boolean()
      .optional()
      .describe("Include revoked rows. Default false."),
  },
  async (params) =>
    withRecording("signalman_signing_keys_list", params, async () => {
      const p = params as { provider?: string; include_revoked?: boolean };
      const rows = await withControlPlane(async (cp) => {
        const { defaultOrg } = await cp.init();
        return runSigningKeysList(cp, defaultOrg.id, {
          provider: p.provider,
          includeRevoked: p.include_revoked,
        });
      });
      return asMcpResult({ keys: rows });
    }),
);

server.tool(
  "signalman_signing_keys_add",
  "Register a new signing key with the WS9 catalog. v0.5.0 supports `provider=local-disk` only (AwsKmsProvider lands in M4). Default `algorithm=hybrid` creates a paired Ed25519 + ML-DSA-65 key (post-quantum ready); operator can opt to `ed25519` or `ecdsa-p256-sha256` for classical-only. Files are written under `keys_dir` (default `~/.signalman/keys`).",
  {
    provider: z
      .string()
      .optional()
      .describe("Provider id. Default 'local-disk'."),
    alias: z
      .string()
      .describe(
        "Operator-facing alias. For local-disk, becomes the filesystem stem (`<alias>-ed25519.{pub,key}` etc. for hybrid, or `<alias>.{pub,key}` for single-algorithm).",
      ),
    algorithm: z
      .enum(["hybrid", "ed25519", "ecdsa-p256-sha256"])
      .optional()
      .describe(
        "Algorithm choice. Default 'hybrid' (Ed25519 + ML-DSA-65, post-quantum ready). 'ml-dsa-65' single-algorithm not yet exposed in M3.",
      ),
    label: z
      .string()
      .optional()
      .describe("Human label for the catalog row."),
    keys_dir: z
      .string()
      .optional()
      .describe("Override the default keys directory (~/.signalman/keys)."),
  },
  async (params) =>
    withRecording("signalman_signing_keys_add", params, async () => {
      const p = params as {
        provider?: string;
        alias: string;
        algorithm?: "hybrid" | "ed25519" | "ecdsa-p256-sha256";
        label?: string;
        keys_dir?: string;
      };
      const result = await withControlPlane(async (cp) => {
        const { defaultOrg } = await cp.init();
        return runSigningKeysAdd(cp, defaultOrg.id, {
          provider: p.provider ?? "local-disk",
          alias: p.alias,
          algorithm: p.algorithm,
          label: p.label,
          keysDir: p.keys_dir,
          actor: "mcp:signing-keys-add",
        });
      });
      return asMcpResult({
        added: result.added,
        classical_path: result.classicalPath ?? null,
        pq_path: result.pqPath ?? null,
      });
    }),
);

server.tool(
  "signalman_signing_keys_revoke",
  "Revoke a signing key in the catalog. Identifier is a 16-hex fingerprint OR an alias (hybrid alias revokes both halves). The row is preserved so past signatures still verify; revoked keys are filtered from the default `signalman_signing_keys_list` output.",
  {
    identifier: z
      .string()
      .describe("Fingerprint (16 hex) or alias."),
    reason: z
      .string()
      .describe("Human-readable revocation reason; recorded in the audit log."),
  },
  async (params) =>
    withRecording("signalman_signing_keys_revoke", params, async () => {
      const p = params as { identifier: string; reason: string };
      const revoked = await withControlPlane(async (cp) => {
        const { defaultOrg } = await cp.init();
        return runSigningKeysRevoke(cp, defaultOrg.id, {
          identifier: p.identifier,
          reason: p.reason,
          actor: "mcp:signing-keys-revoke",
        });
      });
      return asMcpResult({ revoked });
    }),
);

server.tool(
  "signalman_signing_keys_rotate",
  "Rotate a signing key (local-disk only in M3). Generates a fresh key under an alias-derived stem, records the rotation linkage (old fingerprint → new fingerprint) in the catalog, and audit-logs `signing.key_rotated`. Hybrid keys rotate both halves atomically.",
  {
    identifier: z
      .string()
      .describe("Fingerprint (16 hex) or alias of the key(s) to rotate."),
    keys_dir: z
      .string()
      .optional()
      .describe("Override the default keys directory."),
  },
  async (params) =>
    withRecording("signalman_signing_keys_rotate", params, async () => {
      const p = params as { identifier: string; keys_dir?: string };
      const result = await withControlPlane(async (cp) => {
        const { defaultOrg } = await cp.init();
        return runSigningKeysRotate(cp, defaultOrg.id, {
          identifier: p.identifier,
          keysDir: p.keys_dir,
          actor: "mcp:signing-keys-rotate",
        });
      });
      return asMcpResult({
        old_keys: result.oldKeys,
        new_keys: result.newKeys,
      });
    }),
);

server.tool(
  "signalman_signing_verify",
  "Verify a signing envelope against the catalog. Caller supplies the envelope + payload (base64); the verifier looks up each entry's public key by fingerprint, then runs verify in the requested mode. Mode `transition` (default) accepts any one entry verifying; `strict` requires every entry; `classical-only` ignores ml-dsa-65 entries.",
  {
    envelope: z
      .object({
        signatures: z.array(
          z.object({
            signatureB64: z.string(),
            signedBy: z.string(),
            algorithm: z.string(),
            signedAt: z.string(),
          }),
        ),
        nonce: z.string(),
        payloadSha256: z.string(),
      })
      .describe("SignEnvelope to verify (as produced by sign())."),
    payload_base64: z
      .string()
      .describe("Base64-encoded payload bytes that were signed."),
    mode: z
      .enum(["strict", "transition", "classical-only"])
      .optional()
      .describe("Verifier mode. Default 'transition'."),
  },
  async (params) =>
    withRecording("signalman_signing_verify", params, async () => {
      const p = params as {
        envelope: SignEnvelope;
        payload_base64: string;
        mode?: "strict" | "transition" | "classical-only";
      };
      const payload = Buffer.from(p.payload_base64, "base64");
      const result = await withControlPlane(async (cp) => {
        const { defaultOrg } = await cp.init();
        return runSigningVerify(cp, defaultOrg.id, {
          envelope: p.envelope,
          payload,
          mode: p.mode,
        });
      });
      return asMcpResult(result);
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
