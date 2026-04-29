/**
 * `vm_install_bundle` MCP tool — installs a list of software packages on
 * a VM in one declarative call.
 *
 * Tool description (locked):
 *   "Installs a list of software packages on a VM. Modifies VM state."
 *
 * Input shape:
 *   { vm: string, bundle: string | Bundle }
 *
 * The `bundle` field is either:
 *   - a path to a `.yaml` / `.yml` file on the host, OR
 *   - an inline {@link Bundle} object (already parsed structure).
 *
 * Output: serialized {@link InstallBundleResult}.
 *
 * The tool requires a guest agent to be reachable on the target VM and
 * a {@link GuestAgentClient} to be supplied via the `getClient` resolver.
 * The orchestrator wires both up — this tool is a thin façade over
 * {@link installBundle}.
 */

import * as fs from "node:fs";
import * as yaml from "yaml";

import type { ToolDefinition, ToolResult } from "./types.js";
import type { HypervisorBackend } from "../hypervisors/interface.js";
import type { GuestAgentClient } from "../guest/client.js";
import { resolveVM } from "../vm-cache.js";
import { sanitizeVmName, sanitizePath } from "../sanitize.js";
import { parseBundle, type Bundle } from "../provisioning/bundle-types.js";
import { installBundle } from "../provisioning/install-bundle.js";

/**
 * Resolve the input `bundle` field into a parsed Bundle.
 *
 * If `raw` is a string, it's treated as a host path:
 *   - The path is sanitized via `sanitizePath` to reject shell-meta chars.
 *   - The file must exist and be readable.
 *   - YAML or JSON is auto-detected by the `yaml` parser (which accepts
 *     JSON as a YAML subset).
 *
 * If `raw` is an object, it's passed through to `parseBundle` as-is.
 */
function resolveBundleInput(raw: unknown): Bundle {
  if (typeof raw === "string") {
    const path = sanitizePath(raw);
    if (!fs.existsSync(path)) {
      throw new Error(`Bundle file not found: ${path}`);
    }
    const text = fs.readFileSync(path, "utf-8");
    const parsed = yaml.parse(text);
    return parseBundle(parsed);
  }
  if (typeof raw === "object" && raw !== null) {
    return parseBundle(raw);
  }
  throw new Error(
    `vm_install_bundle: 'bundle' must be a path string or an inline object (got ${typeof raw})`,
  );
}

/**
 * Factory creating the `vm_install_bundle` MCP tool.
 *
 * @param getBackend - Async resolver for the hypervisor backend.
 * @param getClient  - Async resolver for the GuestAgentClient bound to a
 *                     given VM name. The orchestrator already maintains
 *                     a `Map<string, GuestAgentClient>` — exposing it via
 *                     this resolver decouples the tool from the runtime
 *                     wiring.
 */
export function createVmInstallBundleTool(
  getBackend: () => Promise<HypervisorBackend>,
  getClient: (vmName: string) => Promise<GuestAgentClient>,
): ToolDefinition {
  return {
    name: "vm_install_bundle",
    description:
      "Installs a list of software packages on a VM. Modifies VM state.",
    inputSchema: {
      type: "object",
      properties: {
        vm: { type: "string", description: "VM name" },
        bundle: {
          // The MCP-side schema is loose because the field can be either
          // a path string or an inline object. Strict bundle-shape
          // validation happens host-side via `parseBundle`, which gives
          // far better error messages than JSON Schema can.
          description:
            "Path to a bundle.yaml file on the host, OR an inline Bundle object.",
        },
      },
      required: ["vm", "bundle"],
      additionalProperties: false,
    },
    handler: async (params): Promise<ToolResult> => {
      const vm = sanitizeVmName(params.vm as string);
      const bundle = resolveBundleInput(params.bundle);

      const backend = await getBackend();
      // Touch the VM cache so the install path benefits from any cached
      // handle resolution. Even though installBundle doesn't use the
      // handle today, future changes (pre-flight VM-state checks) will,
      // and the resolveVM call validates the VM exists right now.
      await resolveVM(backend, vm);

      const client = await getClient(vm);
      const result = await installBundle(backend, client, vm, bundle);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
        // Mark errors so the caller can branch on isError. Failed
        // packages don't fail the tool itself — we still want the agent
        // to see partial-success — but a fully-failed bundle (every
        // package in the failed bucket) is worth flagging.
        isError: result.failed > 0 && result.installed === 0,
      };
    },
  };
}
