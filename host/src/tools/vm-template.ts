/**
 * VM template tools (P9.5): download + verify base images.
 *
 * Today this exposes a single tool, `vm_fetch_template`, which the
 * orchestrator (or an LLM driving the MCP server) can call before
 * provisioning to ensure the cached VHDX exists on disk. Idempotent
 * — repeat calls hit the cache and return the same path.
 *
 * The fetch is intentionally separated from provisioning so an
 * operator can pre-warm the cache (e.g. on a CI runner) without
 * touching Hyper-V. Provisioning itself (agent A's territory) calls
 * `resolveTemplateAsync`, which in turn calls the same fetch path.
 */

import type { ToolDefinition, ToolResult } from "./types.js";
import {
  loadTemplates,
  resolveTemplateAsync,
  validateTemplateImageSource,
} from "../scenarios/templates.js";
import { fetchTemplateImage } from "../provisioning/template-fetch.js";

/** Validate a template name — alphanumeric, hyphens, underscores. */
function sanitizeTemplateName(name: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/.test(name)) {
    throw new Error(
      `Invalid template name: "${name}". Must be 1-100 chars, alphanumeric/hyphens/underscores/dots.`,
    );
  }
  return name;
}

/**
 * Creates the VM template tool definitions.
 *
 * Currently a single tool. Kept in its own factory + barrel slot so
 * future template-related tools (`vm_list_templates`, `vm_eject_cache`)
 * have a natural home without bloating the lifecycle file.
 */
export function createVmTemplateTools(): ToolDefinition[] {
  return [
    {
      name: "vm_fetch_template",
      description:
        "Downloads and verifies a VM base image. Idempotent — uses cache if available.",
      inputSchema: {
        type: "object",
        properties: {
          template: {
            type: "string",
            description:
              "Template name (e.g., 'windows-11-eval'). Must be defined in the template registry with base_image_url + base_image_sha256.",
          },
          force: {
            type: "boolean",
            description: "Re-download even if the cache is warm.",
            default: false,
          },
        },
        required: ["template"],
        additionalProperties: false,
      },
      handler: async (params): Promise<ToolResult> => {
        const name = sanitizeTemplateName(params.template as string);
        const force = Boolean(params.force);

        const templates = loadTemplates();
        const tmpl = templates.get(name);
        if (!tmpl) {
          throw new Error(
            `Unknown template '${name}'. Available: ${Array.from(templates.keys()).join(", ")}`,
          );
        }
        // Surfaces the "missing SHA / mixed forms / http://" failures
        // before we hit the network.
        validateTemplateImageSource(tmpl);

        if (!tmpl.base_image_url || !tmpl.base_image_sha256) {
          // BYO templates can't be fetched — return a structured
          // error rather than silently no-op, so the LLM/operator
          // gets a clear signal.
          throw new Error(
            `Template '${name}' has no base_image_url to fetch. ` +
              (tmpl.base_image_path
                ? `It uses base_image_path (BYO disk: ${tmpl.base_image_path}).`
                : `It is an abstract template with no base-image source declared.`),
          );
        }

        const result = await fetchTemplateImage({
          templateName: name,
          url: tmpl.base_image_url,
          expectedSha256: tmpl.base_image_sha256,
          force,
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  template: name,
                  vhdxPath: result.vhdxPath,
                  cached: result.cached,
                  sizeBytes: result.sizeBytes,
                  durationMs: result.durationMs,
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
      name: "vm_resolve_template",
      description:
        "Resolves a template by name and returns its on-disk VHDX path. Triggers a fetch if the template uses base_image_url and the cache is cold. For BYO templates, validates the base_image_path exists.",
      inputSchema: {
        type: "object",
        properties: {
          template: {
            type: "string",
            description: "Template name to resolve.",
          },
        },
        required: ["template"],
        additionalProperties: false,
      },
      handler: async (params): Promise<ToolResult> => {
        const name = sanitizeTemplateName(params.template as string);
        const resolved = await resolveTemplateAsync(name);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  name: resolved.name,
                  vhdxPath: resolved.vhdxPath ?? null,
                  generation: resolved.generation,
                  memoryMB: resolved.memoryMB,
                  processorCount: resolved.processorCount,
                  fetchResult: resolved.fetchResult ?? null,
                },
                null,
                2,
              ),
            },
          ],
        };
      },
    },
  ];
}
