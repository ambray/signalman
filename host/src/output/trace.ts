/**
 * Cross-process trace correlation (P3.d — closes audit C10-residual).
 *
 * # Design
 *
 * Signalman propagates three flat correlation values via gRPC metadata
 * (and CLI args, and envelope events):
 *
 *   - `signalman-trace-id` — 32-char lowercase hex string, one per run.
 *     The root correlation key. Width matches W3C `traceparent` `trace-id`
 *     so an upgrade to `traceparent` is wire-compatible — the same hex
 *     string flows directly into the standard format with no migration.
 *
 *   - `signalman-run-id` — the run handle (e.g. `run_abc123…`).
 *     Same value an agent sees on `signalman.run` and `signalman.status`.
 *     Distinct from `trace-id` because external orchestrators (Loom, CI)
 *     may share a single trace-id across multiple Signalman runs that
 *     belong to the same logical workflow.
 *
 *   - `signalman-vm-name` — the target VM for a particular gRPC call.
 *     Lets log demuxing "which guest agent saw this call" survive
 *     fleets where 30 VMs × 10 concurrent runs are live.
 *
 * # Why three values, not one
 *
 * The audit minimum was `signalman-trace-id` only. At fleet scale, a
 * flat trace-id is necessary but not sufficient: an operator needs to
 * answer "which VM produced this stderr line" without correlating
 * gRPC connection metadata or peer addresses. `vm-name` carries that
 * directly. `run-id` lets the agent's view (which has the run handle)
 * line up with system logs (which have the trace-id).
 *
 * # Why flat, not nested spans (yet)
 *
 * v0.1.0 doesn't allocate per-call `span-id`s; every header carries
 * the same trace-id for the run's duration. Nested span trees buy
 * little before there's a real distributed-tracing UI consuming them.
 * The upgrade path is documented: replace these three string headers
 * with W3C `traceparent` + `tracestate` once an OTel exporter or
 * equivalent is wired in. Until then, `grep $TRACE_ID` across host /
 * service / guest log streams is the operator surface.
 *
 * # Sampling
 *
 * Reserved. v0.1.0 always samples (every run gets a trace-id).
 * `signalman-trace-flags` will land alongside `traceparent` upgrade.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import * as crypto from "node:crypto";

/** Length of a Signalman trace-id (matches W3C `trace-id` hex width). */
export const TRACE_ID_LENGTH = 32;

/** Validation regex for a Signalman trace-id. */
const TRACE_ID_PATTERN = /^[0-9a-f]{32}$/;

/**
 * Header names used on the gRPC wire and in subprocess CLI args.
 *
 * Lowercase per gRPC metadata convention (HTTP/2 lowercases header keys).
 * Stable across releases; renaming requires an envelope_version bump and
 * a coordinated host/service/guest/plugin migration.
 */
export const TRACE_HEADER_NAMES = Object.freeze({
  traceId: "signalman-trace-id",
  runId: "signalman-run-id",
  vmName: "signalman-vm-name",
} as const);

/**
 * Trace context attached to a single in-flight call. Created at the verb
 * layer (per `signalman.run`) and threaded through the orchestrator to
 * each outbound gRPC invocation; the `vmName` field is filled in
 * per-call by the gRPC client.
 */
export interface TraceContext {
  traceId: string;
  runId: string;
  /**
   * Target VM for this specific call. Empty string for calls that don't
   * target a VM (e.g., a service-level Health probe). Per-call rather
   * than per-run because a scenario typically touches multiple VMs.
   */
  vmName?: string;
}

/**
 * Generate a fresh 32-char lowercase hex trace-id. Backed by
 * `crypto.randomUUID()` then stripped of hyphens — UUIDv4 provides
 * 122 bits of entropy, ample for a non-cryptographic correlation
 * identifier and matching W3C trace-id width exactly.
 */
export function newTraceId(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

/**
 * Validate that `value` is a well-formed Signalman trace-id (32 chars,
 * lowercase hex). Rejects empty strings, uppercase, dashes, leading
 * whitespace, etc. Used by CLI arg parsing and the MCP request handler
 * so a caller-supplied trace-id can't smuggle ambiguous content into
 * gRPC metadata.
 *
 * Lowercase-only is deliberate: HTTP/2 lowercases metadata keys and
 * many tracing UIs are case-sensitive on values; canonicalising here
 * prevents subtle correlation misses across processes.
 */
export function isValidTraceId(value: unknown): value is string {
  return typeof value === "string" && TRACE_ID_PATTERN.test(value);
}

/**
 * Coerce a caller-supplied trace-id (CLI arg, MCP param) into the
 * canonical form, or throw. Accepts the lowercase hex format and the
 * dashed UUID form (e.g. `xxxxxxxx-xxxx-…`). Throws on anything else
 * with a descriptive message naming the field.
 */
export function parseTraceId(value: string, fieldLabel = "trace_id"): string {
  const stripped = value.replace(/-/g, "").toLowerCase();
  if (!TRACE_ID_PATTERN.test(stripped)) {
    throw new Error(
      `${fieldLabel} must be a 32-char lowercase hex string (UUID without dashes); got '${value}'`,
    );
  }
  return stripped;
}

/**
 * Build the gRPC metadata key/value map for a [`TraceContext`].
 * Returns a plain object so the caller (which may use `@grpc/grpc-js`
 * Metadata, a tonic `MetadataMap`, or a fetch headers init) can adapt
 * to its transport.
 *
 * Keys absent when their value is empty so the wire stays clean for
 * calls that don't carry a vm-name (e.g., service-level probes).
 */
export function traceMetadata(ctx: TraceContext): Record<string, string> {
  const out: Record<string, string> = {
    [TRACE_HEADER_NAMES.traceId]: ctx.traceId,
    [TRACE_HEADER_NAMES.runId]: ctx.runId,
  };
  if (ctx.vmName && ctx.vmName.length > 0) {
    out[TRACE_HEADER_NAMES.vmName] = ctx.vmName;
  }
  return out;
}

// ── AsyncLocalStorage propagation ─────────────────────────────────

/**
 * Process-local trace context storage (P3.d). Survives `await`
 * boundaries via Node's async-hooks machinery, so a trace set at the
 * orchestrator level automatically flows into every gRPC call it
 * subsequently triggers — no need to thread `TraceContext` through
 * every method signature.
 *
 * **Why ALS over passing context explicitly:** at fleet scale (many
 * concurrent runs, each touching multiple VMs), explicit threading
 * would mean adding `trace?: TraceContext` to every `GuestAgentClient`
 * method, every `HypervisorBackend` method, every helper. ALS keeps
 * the call sites unchanged and isolation correct: each `runWithTrace`
 * invocation has its own context, so concurrent runs cannot leak
 * trace IDs into each other even when sharing client instances.
 *
 * **Caveat — Node only.** AsyncLocalStorage relies on Node's
 * async-hooks and doesn't exist in browsers. Signalman host runs in
 * Node exclusively, so this is fine. If a browser-resident component
 * ever needs the same machinery, swap to explicit threading.
 */
const traceStorage = new AsyncLocalStorage<TraceContext>();

/**
 * Run `fn` with `trace` as the active correlation context. Inside
 * `fn` (and any async work it spawns), [`currentTrace`] returns the
 * supplied `trace`. Outside of `fn`, the context is unchanged.
 *
 * When `trace` is `undefined`, `fn` runs with no trace context — same
 * as if the caller hadn't wrapped at all. Call sites use this to
 * keep the un-traced path identical to the traced path.
 */
export function runWithTrace<T>(
  trace: TraceContext | undefined,
  fn: () => T | Promise<T>,
): T | Promise<T> {
  if (!trace) return fn();
  return traceStorage.run(trace, fn);
}

/**
 * Return the current async-local trace context, or `undefined` if no
 * `runWithTrace` is active. gRPC clients call this from `unaryCall`
 * to inject metadata; callers outside any traced run get the
 * un-traced behaviour.
 */
export function currentTrace(): TraceContext | undefined {
  return traceStorage.getStore();
}
