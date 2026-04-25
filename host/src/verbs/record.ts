/**
 * `signalman.record` — stub for v0.1.0.
 *
 * Per design doc §1.5. The full implementation (capture next N MCP
 * calls, write a candidate scenario into `.signalman/recordings/<run_id>/`)
 * lands in v0.2.0 (ROADMAP v0.2.0-1). The stub exists in v0.1.0 so
 * prompts and Loom registration can target the final tool name —
 * callers get a clear "not implemented" rather than `tool-not-found`.
 */

export interface RecordParams {
  name: string;
  duration_seconds?: number;
}

export interface RecordResult {
  status: "not-implemented";
  message: string;
}

export function runRecord(_params: RecordParams): RecordResult {
  return {
    status: "not-implemented",
    message:
      "signalman.record lands in v0.2.0 (ROADMAP v0.2.0-1). The verb is reserved so prompts and Loom registration can target the final shape.",
  };
}
