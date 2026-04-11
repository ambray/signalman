#!/usr/bin/env node
/**
 * Signalman Host MCP Server
 *
 * Provides VM management tools to Claude Code and other MCP-compatible clients.
 * Discovers available hypervisor backends and exposes a unified tool interface.
 *
 * Usage:
 *   claude mcp add signalman node host/dist/server.js
 *   # or for development:
 *   claude mcp add signalman -- npx tsx host/src/server.ts
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { HypervisorBackend, VMHandle } from "./hypervisors/interface.js";
import { HyperVBackend } from "./hypervisors/hyperv.js";
import {
  sanitizeVmName,
  sanitizeLabel,
  sanitizePath,
  sanitizeCommand,
  sanitizeUrl,
  sanitizeTimeout,
} from "./sanitize.js";

// ── Backend Discovery ─────────────────────────────────────────────

const BACKENDS: HypervisorBackend[] = [
  new HyperVBackend(),
  // new VMwareBackend(),  // TODO: Phase P6
];

let activeBackend: HypervisorBackend | null = null;

async function getBackend(): Promise<HypervisorBackend> {
  if (activeBackend) return activeBackend;

  for (const backend of BACKENDS) {
    if (await backend.isAvailable()) {
      activeBackend = backend;
      console.error(`[signalman] Using ${backend.name} hypervisor backend`);
      return backend;
    }
  }
  throw new Error(
    "No hypervisor backend available. Install Hyper-V or VMware Workstation.",
  );
}

// ── VM Handle Cache ───────────────────────────────────────────────

const vmCache = new Map<string, VMHandle>();

function cacheVM(handle: VMHandle): void {
  vmCache.set(handle.name.toLowerCase(), handle);
}

async function resolveVM(name: string): Promise<VMHandle> {
  const cached = vmCache.get(name.toLowerCase());
  if (cached) return cached;

  // Refresh from backend
  const backend = await getBackend();
  const vms = await backend.listVMs();
  for (const vm of vms) cacheVM(vm);

  const resolved = vmCache.get(name.toLowerCase());
  if (!resolved) throw new Error(`VM '${name}' not found`);
  return resolved;
}

// ── MCP Server Setup ──────────────────────────────────────────────

const server = new McpServer({
  name: "signalman",
  version: "0.1.0",
});

// ── Tools ─────────────────────────────────────────────────────────

server.tool("vm_list", "List all VMs and their status", {}, async () => {
  const backend = await getBackend();
  const vms = await backend.listVMs();
  const statuses = await Promise.all(
    vms.map(async (vm) => {
      cacheVM(vm);
      const status = await backend.getStatus(vm);
      return {
        name: vm.name,
        state: status.state,
        ip: status.ipAddress ?? "unknown",
        guestAgent: status.guestAgentReachable,
        uptime: status.uptimeSeconds ?? 0,
      };
    }),
  );
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(statuses, null, 2),
      },
    ],
  };
});

server.tool(
  "vm_start",
  "Start a virtual machine",
  { name: z.string().describe("VM name") },
  async ({ name }) => {
    sanitizeVmName(name);
    const backend = await getBackend();
    const handle = await resolveVM(name);
    await backend.startVM(handle);
    return {
      content: [{ type: "text" as const, text: `VM '${name}' started.` }],
    };
  },
);

server.tool(
  "vm_stop",
  "Stop a virtual machine",
  {
    name: z.string().describe("VM name"),
    force: z.boolean().optional().describe("Force power off"),
  },
  async ({ name, force }) => {
    sanitizeVmName(name);
    const backend = await getBackend();
    const handle = await resolveVM(name);
    await backend.stopVM(handle, force);
    return {
      content: [{ type: "text" as const, text: `VM '${name}' stopped.` }],
    };
  },
);

server.tool(
  "vm_status",
  "Get VM status including guest agent health",
  { name: z.string().describe("VM name") },
  async ({ name }) => {
    sanitizeVmName(name);
    const backend = await getBackend();
    const handle = await resolveVM(name);
    const status = await backend.getStatus(handle);
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(status, null, 2),
        },
      ],
    };
  },
);

server.tool(
  "vm_checkpoint",
  "Create a named checkpoint (snapshot)",
  {
    name: z.string().describe("VM name"),
    label: z.string().describe("Checkpoint label"),
  },
  async ({ name, label }) => {
    sanitizeVmName(name);
    sanitizeLabel(label);
    const backend = await getBackend();
    const handle = await resolveVM(name);
    const cp = await backend.createCheckpoint(handle, label);
    return {
      content: [
        {
          type: "text" as const,
          text: `Checkpoint '${label}' created for VM '${name}' (id: ${cp.id}).`,
        },
      ],
    };
  },
);

server.tool(
  "vm_restore",
  "Restore a VM to a checkpoint",
  {
    name: z.string().describe("VM name"),
    label: z.string().describe("Checkpoint label to restore"),
  },
  async ({ name, label }) => {
    sanitizeVmName(name);
    sanitizeLabel(label);
    const backend = await getBackend();
    const handle = await resolveVM(name);
    const cp = { id: "", vmHandle: handle, label };
    await backend.restoreCheckpoint(cp);
    return {
      content: [
        {
          type: "text" as const,
          text: `VM '${name}' restored to checkpoint '${label}'.`,
        },
      ],
    };
  },
);

server.tool(
  "vm_list_checkpoints",
  "List all checkpoints for a VM",
  { name: z.string().describe("VM name") },
  async ({ name }) => {
    sanitizeVmName(name);
    const backend = await getBackend();
    const handle = await resolveVM(name);
    const checkpoints = await backend.listCheckpoints(handle);
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(checkpoints, null, 2),
        },
      ],
    };
  },
);

server.tool(
  "vm_copy_file",
  "Copy a file from the host into the VM",
  {
    name: z.string().describe("VM name"),
    src: z.string().describe("Source path on host"),
    dest: z.string().describe("Destination path in VM"),
  },
  async ({ name, src, dest }) => {
    sanitizeVmName(name);
    sanitizePath(src);
    sanitizePath(dest);
    const backend = await getBackend();
    const handle = await resolveVM(name);
    await backend.copyFileToVM(handle, src, dest);
    return {
      content: [
        {
          type: "text" as const,
          text: `Copied '${src}' to VM '${name}' at '${dest}'.`,
        },
      ],
    };
  },
);

server.tool(
  "vm_run_command",
  "Execute a command inside the VM",
  {
    name: z.string().describe("VM name"),
    command: z.string().describe("Command to execute"),
    args: z.array(z.string()).optional().describe("Command arguments"),
    timeout_ms: z.number().optional().describe("Timeout in milliseconds"),
  },
  async ({ name, command, args, timeout_ms }) => {
    sanitizeVmName(name);
    sanitizeCommand(command);
    const safeTimeout = sanitizeTimeout(timeout_ms);
    const backend = await getBackend();
    const handle = await resolveVM(name);
    const result = await backend.executeCommand(
      handle,
      command,
      args ?? [],
      safeTimeout,
    );
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  },
);

server.tool(
  "vm_install",
  "Install software in the VM via winget",
  {
    name: z.string().describe("VM name"),
    package_id: z.string().describe("Package ID (e.g., Cursor.Cursor)"),
    source: z
      .enum(["winget", "choco", "direct"])
      .optional()
      .describe("Package source"),
  },
  async ({ name, package_id, source }) => {
    sanitizeVmName(name);
    const backend = await getBackend();
    const handle = await resolveVM(name);

    const installSource = source ?? "winget";
    let command: string;
    let args: string[];

    switch (installSource) {
      case "winget":
        command = "winget";
        args = ["install", "--id", package_id, "--accept-source-agreements", "--accept-package-agreements", "--silent"];
        break;
      case "choco":
        command = "choco";
        args = ["install", package_id, "-y"];
        break;
      case "direct": {
        // For direct installs, package_id is a URL — validate it
        const safeUrl = sanitizeUrl(package_id);
        command = "powershell";
        args = ["-Command", `Invoke-WebRequest -Uri '${safeUrl}' -OutFile $env:TEMP\\installer.exe; Start-Process $env:TEMP\\installer.exe -Wait`];
        break;
      }
    }

    const result = await backend.executeCommand(handle, command, args, 300_000);
    return {
      content: [
        {
          type: "text" as const,
          text: `Install ${package_id} via ${installSource}: exit code ${result.exitCode}\n${result.stdout}`,
        },
      ],
    };
  },
);

server.tool(
  "vm_screenshot",
  "Take a screenshot of the VM display",
  { name: z.string().describe("VM name") },
  async ({ name }) => {
    // Screenshots require the guest agent — this is a placeholder
    // that will be wired to the guest agent's screenshot capability
    return {
      content: [
        {
          type: "text" as const,
          text: `Screenshot requested for VM '${name}'. Requires guest agent (not yet connected).`,
        },
      ],
    };
  },
);

// ── Start Server ──────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[signalman] Host MCP server started");
}

main().catch((err) => {
  console.error("[signalman] Fatal:", err);
  process.exit(1);
});
