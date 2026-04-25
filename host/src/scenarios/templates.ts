/**
 * VM template configuration.
 *
 * Templates define the base configuration for VMs used in scenarios.
 * They can be loaded from a YAML file or use built-in defaults.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as yaml from "yaml";
import { resolveLayout } from "./project-layout.js";

// ── Types ──────────────────────────────────────────────────────────

/** VM template definition. */
export interface VmTemplate {
  /** Template name (e.g., "win11-base", "win10-dev"). */
  name: string;
  /** Path to the VHDX disk image (optional, for creation). */
  vhdxPath?: string;
  /** Hyper-V generation (1 or 2). */
  generation?: 1 | 2;
  /** Memory in MB. */
  memoryMB?: number;
  /** Number of virtual processors. */
  processorCount?: number;
  /** Virtual switch name for networking. */
  networkSwitch?: string;
  /** Named checkpoints available in this template. */
  checkpoints?: Record<string, string>;
}

// ── Default Templates ──────────────────────────────────────────────

/** Built-in default templates. */
function defaultTemplates(): Map<string, VmTemplate> {
  const templates = new Map<string, VmTemplate>();

  templates.set("win11-base", {
    name: "win11-base",
    generation: 2,
    memoryMB: 4096,
    processorCount: 2,
    networkSwitch: "Default Switch",
    checkpoints: {
      clean: "Freshly installed Windows 11 with updates",
    },
  });

  templates.set("win10-base", {
    name: "win10-base",
    generation: 2,
    memoryMB: 4096,
    processorCount: 2,
    networkSwitch: "Default Switch",
    checkpoints: {
      clean: "Freshly installed Windows 10 with updates",
    },
  });

  templates.set("win11-dev", {
    name: "win11-dev",
    generation: 2,
    memoryMB: 8192,
    processorCount: 4,
    networkSwitch: "Default Switch",
    checkpoints: {
      clean: "Windows 11 with development tools",
      "with-agent": "Windows 11 with Example agent installed",
    },
  });

  return templates;
}

// ── Loading ────────────────────────────────────────────────────────

/**
 * Load VM templates from a YAML config file, merged with defaults.
 *
 * Resolution (in order, first wins per template name):
 *   1. Built-in defaults (win11-base, win10-base, win11-dev).
 *   2. `.signalman/templates/<name>.yaml` files (one template per file)
 *      — extracted from this file in v0.1.0; see design doc §2.
 *   3. The optional `configPath` (legacy multi-template YAML); kept for
 *      callers that pre-date the .signalman/templates layout.
 *
 * Per-file YAML format (preferred):
 * ```yaml
 * name: custom-vm
 * generation: 2
 * memoryMB: 8192
 * processorCount: 4
 * networkSwitch: "Custom Switch"
 * checkpoints:
 *   clean: "Fresh install"
 * ```
 *
 * @param configPath - Optional legacy multi-template YAML file path.
 * @returns Map of template name to VmTemplate.
 */
export function loadTemplates(configPath?: string): Map<string, VmTemplate> {
  const templates = defaultTemplates();

  // .signalman/templates/<name>.yaml — one template per file.
  const layout = resolveLayout();
  if (layout.templatesDir && fs.existsSync(layout.templatesDir)) {
    const entries = fs.readdirSync(layout.templatesDir, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isFile() || !/\.ya?ml$/i.test(e.name)) continue;
      const filePath = path.join(layout.templatesDir, e.name);
      const raw = fs.readFileSync(filePath, "utf-8");
      const parsed = yaml.parse(raw) as VmTemplate | { templates?: VmTemplate[] } | null;
      if (parsed && typeof parsed === "object") {
        if (Array.isArray((parsed as { templates?: VmTemplate[] }).templates)) {
          // Multi-template file; merge each.
          for (const tmpl of (parsed as { templates: VmTemplate[] }).templates) {
            if (!tmpl.name) {
              throw new Error(`Template entry missing required 'name' field in ${filePath}`);
            }
            templates.set(tmpl.name, tmpl);
          }
        } else if ((parsed as VmTemplate).name) {
          templates.set((parsed as VmTemplate).name, parsed as VmTemplate);
        }
      }
    }
  }

  if (configPath) {
    if (!fs.existsSync(configPath)) {
      throw new Error(`Template config file not found: ${configPath}`);
    }
    const raw = fs.readFileSync(configPath, "utf-8");
    const parsed = yaml.parse(raw) as { templates?: VmTemplate[] };
    if (parsed?.templates && Array.isArray(parsed.templates)) {
      for (const tmpl of parsed.templates) {
        if (!tmpl.name) {
          throw new Error("Template entry missing required 'name' field");
        }
        templates.set(tmpl.name, tmpl);
      }
    }
  }

  return templates;
}

/**
 * Resolve a template by name.
 *
 * @param name - Template name to look up.
 * @param templates - Map of available templates.
 * @returns The resolved VmTemplate.
 * @throws If the template name is not found.
 */
export function resolveTemplate(
  name: string,
  templates: Map<string, VmTemplate>,
): VmTemplate {
  const tmpl = templates.get(name);
  if (!tmpl) {
    const available = Array.from(templates.keys()).join(", ");
    throw new Error(
      `Unknown template '${name}'. Available templates: ${available}`,
    );
  }
  return tmpl;
}
