/**
 * VM template configuration.
 *
 * Templates define the base configuration for VMs used in scenarios.
 * They can be loaded from a YAML file or use built-in defaults.
 */

import * as fs from "node:fs";
import * as yaml from "yaml";

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
 * If no configPath is provided, returns only the built-in defaults.
 * File format:
 * ```yaml
 * templates:
 *   - name: custom-vm
 *     generation: 2
 *     memoryMB: 8192
 *     processorCount: 4
 *     networkSwitch: "Custom Switch"
 *     checkpoints:
 *       clean: "Fresh install"
 * ```
 *
 * @param configPath - Optional path to a YAML file with template definitions.
 * @returns Map of template name to VmTemplate.
 */
export function loadTemplates(configPath?: string): Map<string, VmTemplate> {
  const templates = defaultTemplates();

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
