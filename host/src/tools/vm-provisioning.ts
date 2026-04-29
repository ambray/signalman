/**
 * VM provisioning MCP tools (P9.1).
 *
 * Exposes two tools mirroring the new `signalman vm provision` /
 * `signalman vm cleanup` CLI verbs:
 *
 *   - `vm_provision` — creates a new VM and installs the guest agent.
 *     Destructive — only run when explicitly authorized by the user.
 *   - `vm_cleanup`   — deletes a VM and its disks. Destructive.
 *
 * The tool descriptions explicitly call out the destructive nature so
 * LLM clients can apply their own confirmation gates before invoking.
 *
 * Per the locked roadmap decision, these tools live in the DEFAULT
 * MCP namespace (not `signalman.advanced.*`) — agents should be able
 * to provision VMs without users hand-toggling an advanced flag — but
 * the description text is the contract that signals destructiveness.
 */

import type { ToolDefinition, ToolResult } from "./types.js";
import type { HypervisorBackend } from "../hypervisors/interface.js";
import { provisionVM, type ProvisionEvent } from "../provisioning/provision.js";
import { cleanupVM } from "../provisioning/cleanup.js";
import { GuestMsiDiscoveryError } from "../provisioning/guest-msi-discovery.js";

/**
 * Build the vm_provision + vm_cleanup tool definitions.
 *
 * @param getBackend - async resolver for the active hypervisor backend.
 */
export function createVmProvisioningTools(
  getBackend: () => Promise<HypervisorBackend>,
): ToolDefinition[] {
  return [
    {
      name: "vm_provision",
      description:
        "Creates a new VM and installs the guest agent. Destructive — only run when explicitly authorized by the user. " +
        "Re-running with the same name is a 2-second no-op when the VM already exists with the matching checkpoint label. " +
        "Use --force / force=true to tear down + redo from scratch. On failure the VM is left in place for inspection " +
        "unless cleanup_on_failure=true is passed.",
      inputSchema: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "VM name. Used as the Hyper-V VM name and the cleanup key.",
          },
          template: {
            type: "string",
            description: "Template name (default: 'win11-base'). Must resolve via loadTemplates().",
          },
          guest_msi_path: {
            type: "string",
            description:
              "Optional explicit path to the guest .msi. If omitted, the discovery chain searches " +
              "(1) bundled dist/guest/, (2) GitHub Releases for the matching version.",
          },
          checkpoint: {
            type: "string",
            description: "Checkpoint label to take after install (default: 'agent-installed').",
          },
          force: {
            type: "boolean",
            description: "Tear down the existing VM + checkpoints first.",
          },
          cleanup_on_failure: {
            type: "boolean",
            description:
              "When true, run cleanupVM if any pipeline step fails. Defaults to false (operator inspects the partial state).",
          },
          bind_addr: {
            type: "string",
            description:
              "Optional override for the guest-agent bind address. Defaults to '127.0.0.1:50051' (loopback).",
          },
          auth_token: {
            type: "string",
            description:
              "Optional explicit bearer token. When omitted, a random 32-byte token is generated and stored alongside the dev certs.",
          },
        },
        required: ["name"],
        additionalProperties: false,
      },
      handler: async (params): Promise<ToolResult> => {
        const backend = await getBackend();
        const events: ProvisionEvent[] = [];
        try {
          const result = await provisionVM(backend, {
            vmName: params.name as string,
            templateName: params.template as string | undefined,
            guestMsiPath: params.guest_msi_path as string | undefined,
            checkpointLabel: params.checkpoint as string | undefined,
            force: params.force as boolean | undefined,
            cleanupOnFailure: params.cleanup_on_failure as boolean | undefined,
            bindAddr: params.bind_addr as string | undefined,
            authToken: params.auth_token as string | undefined,
            onProgress: (e) => events.push(e),
          });
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    vmName: result.vmName,
                    checkpointLabel: result.checkpointLabel,
                    alreadyProvisioned: result.alreadyProvisioned,
                    durationMs: result.durationMs,
                    msiSource: result.msiSource ?? null,
                    progress: events,
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        } catch (err) {
          // Build a structured error envelope. For
          // GuestMsiDiscoveryError we surface the searched paths +
          // remediation list separately so an LLM agent can read the
          // remediation steps and decide what to do (e.g. ask the
          // user to run cargo wix, or re-invoke with a path).
          const payload: Record<string, unknown> = {
            error: (err as Error).message,
          };
          if (err instanceof GuestMsiDiscoveryError) {
            payload.searched = err.searched;
            payload.remediation = err.remediation;
          }
          if ((err as { step?: string }).step !== undefined) {
            payload.step = (err as { step?: string }).step;
          }
          payload.progress = events;
          return {
            isError: true,
            content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
          };
        }
      },
    },
    {
      name: "vm_cleanup",
      description:
        "Deletes a VM and its disks. Destructive — only run when explicitly authorized by the user. " +
        "Idempotent: returns success when the VM is already gone. Removes per-VM dev cert artifacts " +
        "from the host tempdir but does NOT touch the shared %ProgramData%\\Signalman\\certs\\ tree.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "VM name (must match a `vm_provision` invocation)." },
        },
        required: ["name"],
        additionalProperties: false,
      },
      handler: async (params): Promise<ToolResult> => {
        const backend = await getBackend();
        const name = params.name as string;
        try {
          await cleanupVM(backend, name);
          return {
            content: [{ type: "text", text: `VM '${name}' cleaned up.` }],
          };
        } catch (err) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: JSON.stringify({ error: (err as Error).message }, null, 2),
              },
            ],
          };
        }
      },
    },
  ];
}
