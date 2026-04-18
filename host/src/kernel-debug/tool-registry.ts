/**
 * Pluggable tool-registry for scenario workflow tool blocks.
 *
 * ## Why
 *
 * The orchestrator's `executeToolBlock` started as a flat switch over
 * tool names. That's readable when the switch has five cases; the
 * Phase 1 audit flagged it as heading toward unwieldiness as each
 * kernel-debug sprint adds 2-5 new tool types. A registry lets new
 * tools register themselves from their own module, keeps related
 * tool + handler definitions co-located, and makes the available-tools
 * list introspectable.
 *
 * ## Scope
 *
 * This registry starts with the five tools added in Sprint 60.7.5
 * (`driver_load` / `driver_unload` / `driver_ioctl` /
 * `kernel_expect_bugcheck` / `kernel_break_on`). Existing tools
 * (`vm_run_command` / `wait` / `ui_*` / `docker_*` / etc.) stay in
 * the orchestrator's switch for now — migrating them would be a
 * bigger, independent refactor. The orchestrator checks the registry
 * before the final `default: throw` so new tools are discovered first.
 *
 * ## ToolContext
 *
 * Tools receive a narrow context (`vmName` + `vmMap` + an
 * `orchestrator` back-reference exposing just the lookups tools need).
 * The back-reference is typed as `ToolOrchestratorView` to avoid
 * making tools depend on the full `ScenarioOrchestrator` class
 * surface, which would make unit testing them harder.
 */

import type { VMHandle } from "../hypervisors/interface.js";
import type { GuestAgentClient } from "../guest/client.js";
import type { BreakLog } from "./break-log.js";
import type { KdSession } from "./kd-session.js";

/**
 * Per-VM kernel-debug resources exposed to tools. Shape mirrors what
 * the orchestrator stores in its `kernelDebug` map; tools never need
 * to synthesize this themselves.
 */
export interface KernelDebugBinding {
  readonly session: KdSession;
  readonly breakLog: BreakLog;
}

/**
 * Minimal orchestrator surface tools depend on. Extracting this
 * interface (rather than passing the concrete `ScenarioOrchestrator`)
 * decouples tool implementations from orchestrator internals — tests
 * can hand tools a 30-line stub that answers a few lookups.
 */
export interface ToolOrchestratorView {
  getGuestClient(vmName: string): GuestAgentClient | undefined;
  getKernelDebug(vmName: string): KernelDebugBinding | undefined;
}

/**
 * Context handed to every tool handler.
 */
export interface ToolContext {
  readonly vmName: string;
  readonly vmMap: Map<string, VMHandle>;
  readonly orchestrator: ToolOrchestratorView;
}

/**
 * Handler signature. Params are loosely typed because scenario YAML
 * can't express TypeScript generics; each handler casts into its
 * specific shape (and errors cleanly on bad params — see e.g.
 * `handleDriverIoctl`).
 */
export type ToolHandler = (
  ctx: ToolContext,
  params: Record<string, unknown>,
) => Promise<string>;

/**
 * A single registered tool definition.
 */
export interface ToolDefinition {
  /** YAML tool key, e.g. "driver_load". Unique within a registry. */
  readonly name: string;
  /** Short human-readable description; shown by `orchestrator.list-tools`. */
  readonly description?: string;
  readonly handler: ToolHandler;
}

/**
 * Thrown when a tool name collides with an existing registration.
 * Surfaces the bug at registration time rather than silently
 * overwriting the prior handler.
 */
export class ToolAlreadyRegisteredError extends Error {
  constructor(public readonly name: string) {
    super(`Tool already registered: '${name}'`);
    this.name = "ToolAlreadyRegisteredError";
  }
}

/**
 * Thrown by `execute()` when the requested tool is unknown.
 * Orchestrators usually prefer to check `has()` and fall through to
 * their legacy switch, so this is a library-level escape hatch.
 */
export class UnknownToolError extends Error {
  constructor(public readonly name: string) {
    super(`Unknown tool: '${name}'`);
    this.name = "UnknownToolError";
  }
}

/**
 * Ordered tool-name → definition map. Order is insertion order —
 * `names()` returns tools in the order they were registered, which
 * keeps help output stable and deterministic.
 */
export class ToolRegistry {
  private readonly tools: Map<string, ToolDefinition> = new Map();

  /**
   * Register a tool. Throws {@link ToolAlreadyRegisteredError} if
   * `def.name` is already taken. Registration is intentionally
   * strict — silent overwrites have burned too many codebases.
   */
  register(def: ToolDefinition): void {
    if (this.tools.has(def.name)) {
      throw new ToolAlreadyRegisteredError(def.name);
    }
    this.tools.set(def.name, def);
  }

  /** True iff a tool with `name` is registered. */
  has(name: string): boolean {
    return this.tools.has(name);
  }

  /** Look up a tool definition (for introspection / docs). */
  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  /** Tool names in registration order. */
  names(): string[] {
    return [...this.tools.keys()];
  }

  /** Every registered definition in registration order. */
  all(): ToolDefinition[] {
    return [...this.tools.values()];
  }

  /**
   * Execute the registered tool. Throws {@link UnknownToolError} when
   * no matching tool is found. The handler's error propagates
   * unchanged — tools are responsible for their own error shapes.
   */
  async execute(
    name: string,
    ctx: ToolContext,
    params: Record<string, unknown>,
  ): Promise<string> {
    const def = this.tools.get(name);
    if (!def) {
      throw new UnknownToolError(name);
    }
    return def.handler(ctx, params);
  }

  /**
   * Number of registered tools. Primarily for tests.
   */
  get size(): number {
    return this.tools.size;
  }
}
