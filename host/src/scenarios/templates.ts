/**
 * VM template configuration.
 *
 * Templates define the base configuration for VMs used in scenarios.
 * They can be loaded from a YAML file or use built-in defaults.
 *
 * # P9.5 (v0.1.1) — base-image source forms
 *
 * Each template declares **at most one** of two source forms for its
 * base VHDX:
 *
 *   1. `base_image_path:` — operator-owned absolute path. Signalman
 *      treats it as authoritative and never downloads. Use this for
 *      hand-built images (Win11 + your tooling layered in).
 *   2. `base_image_url:` + `base_image_sha256:` — remote VHDX. Signalman
 *      downloads it on demand, verifies the SHA-256, and caches it
 *      under the platform's local cache directory. HTTPS only;
 *      SHA-256 is REQUIRED.
 *
 * If neither is set, the template is "abstract" — a config-only
 * record, useful for tests or scenarios that boot a pre-existing VM
 * by name without provisioning a new disk.
 *
 * The orchestrator never reads `base_image_path` / `_url` directly.
 * It calls {@link resolveTemplateAsync}, which populates `vhdxPath`
 * with the resolved real path on disk after download/verification.
 * That contract is what agent A's provisioning pipeline consumes.
 *
 * # ISO -> VHDX conversion is OUT of scope
 *
 * v0.1.1 ships VHDX-only fetching. Operators wanting to install from
 * an ISO build the VHDX themselves (e.g. `Convert-WindowsImage.ps1`)
 * and reference it via `base_image_path`. A first-class ISO->VHDX
 * conversion path is reserved for a follow-up sprint; the fetch
 * module is layered (network vs. resolve) so wedging a converter in
 * front of resolve is straightforward.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as yaml from "yaml";
import { resolveLayout } from "./project-layout.js";
import {
  fetchTemplateImage,
  normalizeSha256,
  requireHttpsUrl,
  type FetchTemplateOptions,
  type FetchTemplateResult,
} from "../provisioning/template-fetch.js";

// ── Types ──────────────────────────────────────────────────────────

/** VM template definition. */
export interface VmTemplate {
  /** Template name (e.g., "win11-base", "win10-dev"). */
  name: string;
  /**
   * Resolved path to the VHDX disk image. Populated by
   * {@link resolveTemplateAsync} for both BYO and URL templates. The
   * orchestrator passes this to Hyper-V `New-VM` directly.
   *
   * For BYO (`base_image_path`) templates this equals the configured
   * absolute path. For URL templates, this is the cache path returned
   * by {@link fetchTemplateImage}.
   */
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

  // ── P9.5: base-image source forms ────────────────────────────────

  /**
   * Operator-owned absolute path to a pre-built VHDX. Mutually
   * exclusive with `base_image_url`. Validated to exist at resolve
   * time; nothing is downloaded.
   */
  base_image_path?: string;
  /**
   * HTTPS URL of a downloadable VHDX. Mutually exclusive with
   * `base_image_path`. Requires `base_image_sha256`. http:// is
   * rejected at validation time — see locked design in
   * `provisioning/template-fetch.ts`.
   */
  base_image_url?: string;
  /**
   * SHA-256 of the downloadable VHDX. REQUIRED whenever
   * `base_image_url` is set. 64 lowercase hex chars.
   */
  base_image_sha256?: string;
}

// ── Validation ─────────────────────────────────────────────────────

/**
 * Validate the base-image fields on a template. Catches the
 * "operator added a URL but forgot the SHA" class of mistake at load
 * time rather than waiting for the first scenario run to fail.
 *
 * Rules (locked):
 *   - At most one of `base_image_path` / `base_image_url` may be set.
 *   - `base_image_url` MUST be `https://` (http:// rejected).
 *   - `base_image_url` MUST be paired with `base_image_sha256`.
 *   - `base_image_sha256` (when present) must be 64 lowercase hex.
 *
 * Templates with neither field are valid (abstract config).
 */
export function validateTemplateImageSource(tmpl: VmTemplate): void {
  const hasPath = Boolean(tmpl.base_image_path && tmpl.base_image_path.length > 0);
  const hasUrl = Boolean(tmpl.base_image_url && tmpl.base_image_url.length > 0);
  const hasSha = Boolean(
    tmpl.base_image_sha256 && tmpl.base_image_sha256.length > 0,
  );

  if (hasPath && hasUrl) {
    throw new Error(
      `Template '${tmpl.name}' declares both base_image_path and base_image_url. ` +
        `Pick one — base_image_path for BYO disks, base_image_url for downloaded ones.`,
    );
  }

  if (hasUrl) {
    requireHttpsUrl(tmpl.base_image_url as string);
    if (!hasSha) {
      throw new Error(
        `Template '${tmpl.name}' declares base_image_url without base_image_sha256. ` +
          `SHA-256 is required for downloaded VHDX images — refusing to fetch unverified data.`,
      );
    }
    // Throws if malformed.
    normalizeSha256(tmpl.base_image_sha256 as string);
  } else if (hasSha) {
    // SHA without URL is a config bug worth surfacing (an operator
    // probably deleted the URL line by mistake).
    throw new Error(
      `Template '${tmpl.name}' declares base_image_sha256 without base_image_url. ` +
        `Either add the URL or remove the orphaned SHA.`,
    );
  }
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

  // P9.5: curated downloadable template pointing at the Microsoft
  // Windows 11 Enterprise 90-day evaluation VHDX. The eval license
  // covers redistribution, so making it the default fetch target is
  // legally clean. URL + SHA below are PLACEHOLDERS; the main session
  // (or a follow-up agent) replaces them with the verified production
  // values before the v0.1.1 release.
  templates.set("windows-11-eval", {
    name: "windows-11-eval",
    generation: 2,
    memoryMB: 4096,
    processorCount: 2,
    networkSwitch: "Default Switch",
    checkpoints: {
      clean: "Windows 11 Enterprise 90-day evaluation, freshly installed",
    },
    // TODO: real Microsoft eval URL — Microsoft's eval portal currently
    // distributes Win11 Enterprise as an ISO; the canonical VHDX needs
    // to be confirmed (Microsoft Eval Center or a mirrored bucket the
    // project controls). Leaving placeholder so the registry surface
    // exists and tests can validate the URL form end-to-end.
    base_image_url: "https://example.com/eval/win11-eval.vhdx",
    // TODO: real SHA-256 — recompute from the verified eval VHDX.
    base_image_sha256:
      "0000000000000000000000000000000000000000000000000000000000000000",
  });

  return templates;
}

// ── Loading ────────────────────────────────────────────────────────

/**
 * Load VM templates from a YAML config file, merged with defaults.
 *
 * Resolution (in order, first wins per template name):
 *   1. Built-in defaults (win11-base, win10-base, win11-dev,
 *      windows-11-eval).
 *   2. `.signalman/templates/<name>.yaml` files (one template per file)
 *      — extracted from this file in v0.1.0; see design doc §2.
 *   3. The optional `configPath` (legacy multi-template YAML); kept for
 *      callers that pre-date the .signalman/templates layout.
 *
 * Every template is validated for source-form consistency
 * ({@link validateTemplateImageSource}) at load time.
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
 * # Optional — pick at most one source form:
 * base_image_path: "D:/images/custom-vm.vhdx"
 * # OR:
 * # base_image_url: "https://..."
 * # base_image_sha256: "<64 hex>"
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

  // Validate every template's image-source fields. Fail fast at load
  // time so a typo in a YAML file doesn't surface as an opaque
  // download error mid-scenario.
  for (const tmpl of templates.values()) {
    validateTemplateImageSource(tmpl);
  }

  return templates;
}

/**
 * Resolve a template by name (synchronous, no fetch).
 *
 * Preserves the v0.1.0 call signature for back-compat with callers
 * that don't need the on-disk VHDX path resolved (e.g. config
 * inspection, `signalman list`, scenario validation).
 *
 * Use {@link resolveTemplateAsync} when you need `vhdxPath`
 * populated — it triggers a download for URL-form templates.
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

// ── Async resolve (P9.5) ──────────────────────────────────────────

/**
 * Options for {@link resolveTemplateAsync}. Most callers pass only
 * `name` and let the loader pull from defaults + `.signalman/templates`.
 */
export interface ResolveTemplateOptions {
  /** Template registry to look up against. Defaults to {@link loadTemplates}. */
  templates?: Map<string, VmTemplate>;
  /** Override cache root for downloaded VHDX. */
  cacheDir?: string;
  /** Re-download even when the cache is warm. */
  force?: boolean;
  /**
   * Injected fetch impl for tests (passed through to
   * {@link fetchTemplateImage}).
   */
  fetchImpl?: FetchTemplateOptions["fetchImpl"];
}

/**
 * Resolve a template AND ensure its VHDX is materialised on disk.
 *
 * Behaviour by source form:
 *   - `base_image_path`: validates the path exists, populates
 *     `vhdxPath` directly. Never downloads.
 *   - `base_image_url`: invokes {@link fetchTemplateImage} (cache hit
 *     when warm, download + verify when cold). `vhdxPath` is the
 *     cache path on success.
 *   - Neither: returns the template with `vhdxPath` left undefined —
 *     this is the abstract-config case (legacy templates).
 *
 * The returned VmTemplate is a shallow copy of the registry entry —
 * we never mutate the registry-backed template object.
 *
 * @throws If the template doesn't exist, its source form is invalid,
 *   the BYO path is missing, or the download fails.
 */
export async function resolveTemplateAsync(
  name: string,
  opts: ResolveTemplateOptions = {},
): Promise<VmTemplate & { fetchResult?: FetchTemplateResult }> {
  const registry = opts.templates ?? loadTemplates();
  const tmpl = resolveTemplate(name, registry);
  // Defensive re-validate — registry-loaded entries pass through
  // loadTemplates(), but a caller may construct a Map manually.
  validateTemplateImageSource(tmpl);

  // Shallow clone so we don't mutate the registry's reference.
  const out: VmTemplate & { fetchResult?: FetchTemplateResult } = { ...tmpl };

  if (tmpl.base_image_path && tmpl.base_image_path.length > 0) {
    const abs = path.resolve(tmpl.base_image_path);
    if (!fs.existsSync(abs)) {
      throw new Error(
        `Template '${name}' base_image_path does not exist on disk: ${abs}. ` +
          `BYO templates require the operator to provision the VHDX before use.`,
      );
    }
    out.vhdxPath = abs;
    return out;
  }

  if (tmpl.base_image_url && tmpl.base_image_sha256) {
    const result = await fetchTemplateImage({
      templateName: name,
      url: tmpl.base_image_url,
      expectedSha256: tmpl.base_image_sha256,
      cacheDir: opts.cacheDir,
      force: opts.force,
      fetchImpl: opts.fetchImpl,
    });
    out.vhdxPath = result.vhdxPath;
    out.fetchResult = result;
    return out;
  }

  // Abstract template — no source form declared. Caller decides what
  // to do (e.g. boot a pre-existing VM by name without a VHDX).
  return out;
}
