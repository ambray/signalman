/**
 * Result envelope — emitted by both `signalman.run` (MCP) and the CLI.
 *
 * Per docs/design/p0-mcp-surface.md §4. The envelope is the single
 * shared output shape between the MCP path and the CLI path; both
 * surfaces feed the same writer so consumers see byte-identical
 * results.
 *
 * Hashing contract: `scenario_hash` is a SHA-256 over the
 * canonicalised `setup.yaml` + `assertions.yaml` + `workflow.md`
 * concatenation, prefixed by file labels so a YAML key swap between
 * files cannot collide. Same scenario contents always yield the same
 * hash regardless of YAML key ordering or trailing whitespace.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import YAML from "yaml";

// ── Event taxonomy ────────────────────────────────────────────────

/**
 * Result envelope event types — mirrors the table in design doc §4.
 *
 * Every event emitted by the runner is one of these shapes; a stable
 * `seq` is assigned by the queue so consumers can paginate through
 * `signalman.status` long-poll without losing ordering.
 */
export type EnvelopeEventType =
  | "run.started"
  | "run.finished"
  | "step.started"
  | "step.completed"
  | "step.failed"
  | "assertion.passed"
  | "assertion.failed"
  | "vm.state_changed"
  | "tool.started"
  | "tool.completed"
  | "log";

/** A single event in the envelope's `events[]` array. */
export interface EnvelopeEvent {
  /** Monotonic per-run sequence number, starting at 0. */
  seq: number;
  /** ISO 8601 timestamp of when the event was emitted. */
  ts: string;
  /** Event type. */
  type: EnvelopeEventType;
  /** Free-form fields per event taxonomy (e.g. `step_index`, `vm`, `id`, …). */
  [field: string]: unknown;
}

/** Input shape for `EventQueue.push()` — type required, seq/ts auto-assigned. */
export interface EnvelopeEventInput {
  type: EnvelopeEventType;
  seq?: number;
  ts?: string;
  [field: string]: unknown;
}

/** Per-assertion result row in the envelope. */
export interface EnvelopeAssertionResult {
  id: string;
  passed: boolean;
  severity: "critical" | "high" | "medium" | "low";
  duration_ms?: number;
  expected?: unknown;
  actual?: unknown;
  error?: string;
}

/** Aggregate assertion summary. */
export interface EnvelopeAssertions {
  total: number;
  passed: number;
  failed: number;
  results: EnvelopeAssertionResult[];
}

/** Top-level result outcome. */
export type EnvelopeResult = "pass" | "fail" | "error";

/**
 * The shared result envelope. v0.1.0 schema; v0.2.0 adds optional
 * `vm_lineage_hash` and `recording_path` fields without breaking
 * v0.1.0 readers.
 */
export interface ResultEnvelope {
  envelope_version: "0.1.0";
  run_id: string;
  scenario_id: string;
  scenario_hash: string;
  agent_version: string;
  network_class: "isolated" | "nat" | "internet";
  started_at: string;
  finished_at: string;
  duration_ms: number;
  result: EnvelopeResult;
  exit_code: number;
  assertions: EnvelopeAssertions;
  events: EnvelopeEvent[];
  errors: string[];
}

// ── scenario_hash ─────────────────────────────────────────────────

/**
 * Canonicalise a YAML object for deterministic hashing.
 *
 * Recursively sorts object keys lexicographically. Arrays preserve
 * order (semantically meaningful in scenarios — step order matters).
 * Non-object values pass through unchanged.
 */
function canonicalise(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalise);
  }
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    const keys = Object.keys(value as Record<string, unknown>).sort();
    for (const k of keys) {
      sorted[k] = canonicalise((value as Record<string, unknown>)[k]);
    }
    return sorted;
  }
  return value;
}

/** Read + canonicalise a YAML file. Returns `null` if the file is missing. */
function canonicalYaml(filePath: string): string | null {
  if (!fs.existsSync(filePath)) return null;
  const raw = fs.readFileSync(filePath, "utf-8");
  if (!raw.trim()) return "";
  const parsed = YAML.parse(raw, { maxAliasCount: 100 });
  return JSON.stringify(canonicalise(parsed));
}

/** Read + normalise a markdown file (LF line endings, trailing newline trim). */
function canonicalMarkdown(filePath: string): string | null {
  if (!fs.existsSync(filePath)) return null;
  const raw = fs.readFileSync(filePath, "utf-8");
  return raw.replace(/\r\n/g, "\n").replace(/\s+$/u, "");
}

/**
 * Compute the deterministic scenario hash over a scenario directory.
 *
 * Hashes the labelled concatenation of `setup.yaml`, `assertions.yaml`,
 * and `workflow.md` (each canonicalised). Returns `sha256:<hex>`.
 * Throws if `setup.yaml` is missing — every scenario must have one.
 */
export function computeScenarioHash(scenarioDir: string): string {
  const setup = canonicalYaml(path.join(scenarioDir, "setup.yaml"));
  if (setup === null) {
    throw new Error(`Missing setup.yaml in ${scenarioDir}`);
  }
  const assertions =
    canonicalYaml(path.join(scenarioDir, "assertions.yaml")) ?? "";
  const workflow = canonicalMarkdown(path.join(scenarioDir, "workflow.md")) ?? "";

  const labelled =
    `setup.yaml:${setup}\n` +
    `assertions.yaml:${assertions}\n` +
    `workflow.md:${workflow}\n`;

  const hash = crypto.createHash("sha256").update(labelled, "utf-8").digest("hex");
  return `sha256:${hash}`;
}

// ── Event queue ───────────────────────────────────────────────────

/**
 * In-memory event queue for a single run. Used by the runner to emit
 * events; consumers (MCP `signalman.status`, CLI `--follow`) drain
 * them via `drain()` or wait via `waitForNext()`.
 *
 * Persistence is a v0.2.0 deliverable — handles do not survive a
 * host restart.
 */
export class EventQueue {
  private events: EnvelopeEvent[] = [];
  private nextSeq = 0;
  private waiters: Array<() => void> = [];
  private terminal = false;

  /** Append a new event. Auto-assigns `seq` and `ts` if not set. */
  push(event: EnvelopeEventInput): EnvelopeEvent {
    const out: EnvelopeEvent = {
      ...event,
      type: event.type,
      seq: event.seq ?? this.nextSeq++,
      ts: event.ts ?? new Date().toISOString(),
    };
    this.events.push(out);
    this.notify();
    return out;
  }

  /** Snapshot of events with `seq >= since`. */
  drain(since = 0, limit = 1000): { events: EnvelopeEvent[]; nextSeq: number; terminal: boolean } {
    const slice = this.events.filter((e) => e.seq >= since).slice(0, limit);
    const nextSeq = slice.length === 0 ? since : slice[slice.length - 1].seq + 1;
    return { events: slice, nextSeq, terminal: this.terminal };
  }

  /** All emitted events. Used to build the final envelope. */
  all(): EnvelopeEvent[] {
    return this.events.slice();
  }

  /** Wait up to `waitMs` for any new event past `since`. */
  async waitForNext(since: number, waitMs: number): Promise<void> {
    if (this.terminal) return;
    if (this.events.some((e) => e.seq >= since)) return;
    if (waitMs <= 0) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== wake);
        resolve();
      }, waitMs);
      const wake = () => {
        clearTimeout(timer);
        resolve();
      };
      this.waiters.push(wake);
    });
  }

  /** Mark the queue terminal — `signalman.status` callers can stop polling. */
  finish(): void {
    this.terminal = true;
    this.notify();
  }

  isTerminal(): boolean {
    return this.terminal;
  }

  private notify() {
    const w = this.waiters;
    this.waiters = [];
    for (const fn of w) fn();
  }
}

// ── Exit code mapping ─────────────────────────────────────────────

/** Map an envelope `result` + breakdown to the design doc §5 exit code. */
export function exitCodeFor(envelope: Pick<ResultEnvelope, "result"> & { breakdown?: ExitBreakdown }): number {
  if (envelope.result === "pass") return 0;
  if (envelope.result === "fail") {
    return envelope.breakdown === "workflow" ? 2 : 1;
  }
  // error
  if (envelope.breakdown === "validation") return 5;
  if (envelope.breakdown === "infra") return 4;
  return 3;
}

/** Categorisation for the error path (drives exit code). */
export type ExitBreakdown = "assertion" | "workflow" | "setup" | "infra" | "validation";

// ── Agent version ─────────────────────────────────────────────────

/**
 * Semi-stable agent version string emitted on every envelope.
 *
 * Reads `host/package.json` once at module load. Includes a short git
 * SHA suffix when running from a checkout, so support engineers can
 * trace an envelope back to a specific build. Falls back to plain
 * version when the SHA is unavailable (e.g. installed package).
 */
let cachedAgentVersion: string | null = null;
export function agentVersion(): string {
  if (cachedAgentVersion) return cachedAgentVersion;
  let version = "0.1.0";
  try {
    // host/dist/output/envelope.js → host/package.json (3 levels up at runtime,
    // host/src/output/envelope.ts → host/package.json (2 levels up under tsx).
    const candidates = [
      path.resolve(import.meta.dirname ?? ".", "..", "..", "package.json"),
      path.resolve(import.meta.dirname ?? ".", "..", "..", "..", "package.json"),
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) {
        const pkg = JSON.parse(fs.readFileSync(c, "utf-8")) as { version?: string };
        if (pkg.version) version = pkg.version;
        break;
      }
    }
  } catch {
    // Fall through to default
  }
  cachedAgentVersion = `signalman/${version}`;
  return cachedAgentVersion;
}
