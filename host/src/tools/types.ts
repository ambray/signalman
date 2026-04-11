/**
 * MCP tool definition types.
 *
 * Provides a structured interface for defining MCP tools with typed
 * input schemas and handler functions. Tool files export arrays of
 * ToolDefinition objects that the barrel index re-exports.
 */

/** Result content item returned by MCP tool handlers. */
export interface ToolContent {
  type: "text" | "image" | "resource";
  text?: string;
  data?: string;
  mimeType?: string;
}

/** MCP tool result returned by handlers. */
export interface ToolResult {
  content: ToolContent[];
  isError?: boolean;
}

/**
 * Structured MCP tool definition.
 *
 * Each tool has a unique name, a human-readable description, a JSON Schema
 * for its input parameters, and an async handler function.
 */
export interface ToolDefinition {
  /** Unique tool name (e.g., "vm_list"). */
  name: string;
  /** Human-readable description shown to the MCP client. */
  description: string;
  /** JSON Schema describing the tool's input parameters. */
  inputSchema: Record<string, unknown>;
  /** Async handler that executes the tool logic. */
  handler: (params: Record<string, unknown>) => Promise<ToolResult>;
}
