/**
 * `signalman.record` — start a durable record/replay capture session.
 *
 * This is the first v0.2.0 record/replay slice: create a stable recording
 * directory and manifest that later MCP/CLI capture hooks can append to.
 * It deliberately does not claim to intercept calls yet.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import YAML from "yaml";
import { resolveLayout } from "../scenarios/project-layout.js";

export interface RecordParams {
  name: string;
  duration_seconds?: number;
}

export interface RecordResult {
  status: "recording";
  recording_id: string;
  name: string;
  safe_name: string;
  started_at: string;
  expires_at: string;
  duration_seconds: number;
  recording_path: string;
  state_path: string;
  calls_path: string;
  message: string;
}

export interface RecordFinalizeParams {
  recording_path?: string;
  recording_id?: string;
  scenario_id?: string;
  force?: boolean;
}

export interface RecordFinalizeResult {
  status: "finalized";
  recording_id: string;
  scenario_id: string;
  scenario_path: string;
  setup_path: string;
  workflow_path: string;
  assertions_path: string;
  captured_call_count: number;
  emitted_tool_blocks: number;
  skipped_call_count: number;
  malformed_line_count: number;
}

export interface RecordedMcpCallInput {
  tool: string;
  params: unknown;
  result?: unknown;
  error?: unknown;
  started_at?: string;
  finished_at?: string;
  duration_ms?: number;
}

interface ActiveRecording {
  recording_id: string;
  state_path: string;
  calls_path: string;
  expires_at: string;
  captured_call_count: number;
}

export class RecordValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecordValidationError";
  }
}

const activeRecordings = new Map<string, ActiveRecording>();
let lastDiscoveryAt = 0;
const DISCOVERY_INTERVAL_MS = 5_000;
const MAX_STRING_LENGTH = 4_096;
const MAX_ARRAY_ITEMS = 50;
const MAX_OBJECT_KEYS = 100;
const MAX_REDACTION_DEPTH = 6;
const SENSITIVE_KEY_RE =
  /(?:password|passwd|pwd|token|secret|credential|authorization|auth|api[_-]?key|bearer|private[_-]?key)/i;

export function runRecord(params: RecordParams, cwd: string = process.cwd()): RecordResult {
  const name = validateRecordingName(params.name);
  const safeName = recordingSafeName(name);
  const durationSeconds = validateDurationSeconds(params.duration_seconds);
  const startedAt = new Date();
  const expiresAt = new Date(startedAt.getTime() + durationSeconds * 1000);
  const recordingId = newRecordingId(startedAt);
  const layout = resolveLayout(cwd);
  const recordingPath = path.join(layout.recordingsDir, safeName, recordingId);
  const statePath = path.join(recordingPath, "state.json");
  const callsPath = path.join(recordingPath, "calls.jsonl");

  fs.mkdirSync(recordingPath, { recursive: true });
  const state = {
    schema_version: 1,
    status: "recording",
    recording_id: recordingId,
    name,
    safe_name: safeName,
    started_at: startedAt.toISOString(),
    expires_at: expiresAt.toISOString(),
    duration_seconds: durationSeconds,
    calls_path: "calls.jsonl",
    captured_call_count: 0,
    capture_state: "session-started",
    capture_note:
      "Call interception is a follow-up v0.2.0 slice; this manifest pins the durable recording session contract.",
  };
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n");
  fs.writeFileSync(callsPath, "");
  registerActiveRecording({
    recording_id: recordingId,
    state_path: statePath,
    calls_path: callsPath,
    expires_at: expiresAt.toISOString(),
    captured_call_count: 0,
  });

  return {
    status: "recording",
    recording_id: recordingId,
    name,
    safe_name: safeName,
    started_at: startedAt.toISOString(),
    expires_at: expiresAt.toISOString(),
    duration_seconds: durationSeconds,
    recording_path: recordingPath,
    state_path: statePath,
    calls_path: callsPath,
    message:
      "Recording session started. Capture hooks will append MCP calls to calls.jsonl in a follow-up v0.2.0 slice.",
  };
}

export function runRecordFinalize(
  params: RecordFinalizeParams,
  cwd: string = process.cwd(),
): RecordFinalizeResult {
  const layout = resolveLayout(cwd);
  const statePath = resolveRecordingStatePath(params, layout.recordingsDir);
  const state = readRecordingStateForFinalize(statePath);
  const scenarioId = validateScenarioId(params.scenario_id ?? state.safe_name ?? state.recording_id);
  const scenarioPath = path.join(layout.scenariosDir, ...scenarioId.split("/"));
  if (fs.existsSync(scenarioPath) && !params.force) {
    throw new RecordValidationError(
      `candidate scenario already exists: ${scenarioId}; pass force to overwrite`,
    );
  }

  const recordingDir = path.dirname(statePath);
  const callsPath = resolveRecordingFilePath(
    recordingDir,
    typeof state.calls_path === "string" ? state.calls_path : "calls.jsonl",
  );
  const { calls, malformedLineCount } = readRecordedCalls(callsPath);
  const synthesized = synthesizeScenarioFromCalls({
    name: typeof state.name === "string" ? state.name : scenarioId,
    scenarioId,
    recordingId: state.recording_id,
    calls,
    malformedLineCount,
  });

  fs.mkdirSync(scenarioPath, { recursive: true });
  const setupPath = path.join(scenarioPath, "setup.yaml");
  const workflowPath = path.join(scenarioPath, "workflow.md");
  const assertionsPath = path.join(scenarioPath, "assertions.yaml");
  fs.writeFileSync(setupPath, synthesized.setupYaml);
  fs.writeFileSync(workflowPath, synthesized.workflowMarkdown);
  fs.writeFileSync(assertionsPath, synthesized.assertionsYaml);
  updateRecordingState(
    {
      recording_id: state.recording_id,
      state_path: statePath,
      calls_path: callsPath,
      expires_at: typeof state.expires_at === "string" ? state.expires_at : new Date().toISOString(),
      captured_call_count: synthesized.capturedCallCount,
    },
    {
      status: "finalized",
      finalized_at: new Date().toISOString(),
      scenario_id: scenarioId,
      scenario_path: scenarioPath,
      emitted_tool_blocks: synthesized.emittedToolBlocks,
      skipped_call_count: synthesized.skippedCallCount,
      malformed_line_count: malformedLineCount,
    },
  );

  return {
    status: "finalized",
    recording_id: state.recording_id,
    scenario_id: scenarioId,
    scenario_path: scenarioPath,
    setup_path: setupPath,
    workflow_path: workflowPath,
    assertions_path: assertionsPath,
    captured_call_count: synthesized.capturedCallCount,
    emitted_tool_blocks: synthesized.emittedToolBlocks,
    skipped_call_count: synthesized.skippedCallCount,
    malformed_line_count: malformedLineCount,
  };
}

export function recordMcpCall(input: RecordedMcpCallInput, cwd: string = process.cwd()): void {
  try {
    refreshActiveRecordings(cwd);
    if (activeRecordings.size === 0) return;

    for (const rec of Array.from(activeRecordings.values())) {
      if (isExpired(rec.expires_at)) {
        markRecordingExpired(rec);
        activeRecordings.delete(rec.recording_id);
        continue;
      }

      const seq = rec.captured_call_count;
      const event = {
        schema_version: 1,
        seq,
        ts: input.finished_at ?? new Date().toISOString(),
        recording_id: rec.recording_id,
        tool: input.tool,
        started_at: input.started_at,
        finished_at: input.finished_at,
        duration_ms: input.duration_ms,
        ok: input.error == null,
        params_redacted: sanitizeForRecording(input.params),
        result_redacted: input.error == null ? sanitizeForRecording(input.result) : undefined,
        error: input.error == null ? undefined : sanitizeErrorForRecording(input.error),
      };

      fs.appendFileSync(rec.calls_path, JSON.stringify(event) + "\n");
      rec.captured_call_count += 1;
      updateCapturedCallCount(rec);
    }
  } catch {
    // Recording must never change tool semantics. A broken disk, stale path, or
    // malformed state file should cost us capture fidelity, not scenario execution.
  }
}

export function _resetRecordCaptureForTests(): void {
  activeRecordings.clear();
  lastDiscoveryAt = 0;
}

type RecordingState = Record<string, unknown> & {
  recording_id: string;
  safe_name?: string;
  name?: string;
  calls_path?: string;
  expires_at?: string;
};

interface RecordedCallEvent {
  seq?: number;
  tool?: string;
  ok?: boolean;
  params_redacted?: unknown;
  error?: unknown;
}

interface SynthesisInput {
  name: string;
  scenarioId: string;
  recordingId: string;
  calls: RecordedCallEvent[];
  malformedLineCount: number;
}

interface SynthesisOutput {
  setupYaml: string;
  workflowMarkdown: string;
  assertionsYaml: string;
  capturedCallCount: number;
  emittedToolBlocks: number;
  skippedCallCount: number;
}

function validateRecordingName(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new RecordValidationError("record name must not be empty");
  }
  if (trimmed.length > 100) {
    throw new RecordValidationError("record name must be at most 100 characters");
  }
  if (trimmed.includes("\0")) {
    throw new RecordValidationError("record name contains a null byte");
  }
  return trimmed;
}

function validateDurationSeconds(value: number | undefined): number {
  const duration = value ?? 600;
  if (!Number.isInteger(duration) || duration < 1 || duration > 86_400) {
    throw new RecordValidationError("duration_seconds must be an integer between 1 and 86400");
  }
  return duration;
}

function validateScenarioId(value: string): string {
  const trimmed = value.trim().replace(/\\/g, "/");
  if (trimmed.length === 0 || trimmed.length > 160) {
    throw new RecordValidationError("scenario_id must be 1-160 characters");
  }
  if (
    trimmed.startsWith("/") ||
    trimmed.includes("//") ||
    trimmed.split("/").some((part) => part === "." || part === ".." || part.length === 0) ||
    !/^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*$/.test(trimmed)
  ) {
    throw new RecordValidationError(
      "scenario_id must be a safe relative path using letters, numbers, dots, dashes, underscores, and slashes",
    );
  }
  return trimmed;
}

function recordingSafeName(value: string): string {
  const safe = value
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100);
  if (!safe || safe === "." || safe === "..") {
    throw new RecordValidationError("record name must contain at least one letter or number");
  }
  return safe;
}

function newRecordingId(now: Date): string {
  const ts = now.toISOString().replace(/[:.]/g, "-").replace(/Z$/, "Z");
  return `rec_${ts}_${randomBytes(3).toString("hex")}`;
}

function resolveRecordingStatePath(params: RecordFinalizeParams, recordingsDir: string): string {
  if (params.recording_path) {
    const recordingPath = path.resolve(params.recording_path);
    return fs.existsSync(path.join(recordingPath, "state.json"))
      ? path.join(recordingPath, "state.json")
      : recordingPath;
  }
  if (!params.recording_id) {
    throw new RecordValidationError("record finalize requires recording_path or recording_id");
  }
  if (!/^rec_[A-Za-z0-9_.-]+$/.test(params.recording_id)) {
    throw new RecordValidationError("recording_id has invalid characters");
  }
  const found = findRecordingStateById(recordingsDir, params.recording_id);
  if (!found) {
    throw new RecordValidationError(`recording_id not found: ${params.recording_id}`);
  }
  return found;
}

function findRecordingStateById(recordingsDir: string, recordingId: string): string | null {
  for (const safeNameEntry of safeReadDir(recordingsDir)) {
    if (!safeNameEntry.isDirectory()) continue;
    const candidate = path.join(recordingsDir, safeNameEntry.name, recordingId, "state.json");
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function readRecordingStateForFinalize(statePath: string): RecordingState {
  try {
    const state = JSON.parse(fs.readFileSync(statePath, "utf-8")) as RecordingState;
    if (!state || typeof state.recording_id !== "string") {
      throw new RecordValidationError("recording state is missing recording_id");
    }
    return state;
  } catch (err) {
    if (err instanceof RecordValidationError) throw err;
    throw new RecordValidationError(`cannot read recording state: ${(err as Error).message}`);
  }
}

function resolveRecordingFilePath(recordingDir: string, relativePath: string): string {
  const normalized = relativePath.trim().replace(/\\/g, "/");
  if (
    normalized.length === 0 ||
    normalized.startsWith("/") ||
    normalized.includes("//") ||
    normalized.split("/").some((part) => part === "." || part === ".." || part.length === 0)
  ) {
    throw new RecordValidationError("recording state has an unsafe calls_path");
  }
  return path.join(recordingDir, ...normalized.split("/"));
}

function readRecordedCalls(callsPath: string): {
  calls: RecordedCallEvent[];
  malformedLineCount: number;
} {
  if (!fs.existsSync(callsPath)) {
    return { calls: [], malformedLineCount: 0 };
  }
  const calls: RecordedCallEvent[] = [];
  let malformedLineCount = 0;
  const lines = fs.readFileSync(callsPath, "utf-8").split(/\r?\n/);
  for (const line of lines) {
    if (line.trim().length === 0) continue;
    try {
      const parsed = JSON.parse(line) as RecordedCallEvent;
      calls.push(parsed);
    } catch {
      malformedLineCount += 1;
    }
  }
  calls.sort((a, b) => (typeof a.seq === "number" ? a.seq : 0) - (typeof b.seq === "number" ? b.seq : 0));
  return { calls, malformedLineCount };
}

function synthesizeScenarioFromCalls(input: SynthesisInput): SynthesisOutput {
  const setup = {
    name: `${input.name} candidate`,
    version: "1.0",
    tags: ["recorded", "candidate"],
    vms: [
      {
        name: "recorded-vm",
        template: "recorded-template",
        guest_agent_port: 50051,
        pre_started: true,
      },
    ],
  };
  let emittedToolBlocks = 0;
  let skippedCallCount = 0;
  const sections = [
    `# ${input.name} candidate`,
    "",
    `Generated from recording \`${input.recordingId}\`. Review VM placeholders, selectors, waits, and assertions before treating this as a stable scenario.`,
    "",
  ];

  for (const call of input.calls) {
    const tool = typeof call.tool === "string" ? call.tool : "";
    const workflowTool = workflowToolName(tool);
    if (!workflowTool) {
      skippedCallCount += 1;
      sections.push(`<!-- Skipped recorded MCP call ${labelSeq(call)}: ${tool || "(missing tool)"} -->`, "");
      continue;
    }
    const params =
      call.params_redacted && typeof call.params_redacted === "object"
        ? (call.params_redacted as Record<string, unknown>)
        : {};
    emittedToolBlocks += 1;
    sections.push(
      `## Recorded call ${labelSeq(call)}`,
      "",
      "```tool",
      `${workflowTool}:`,
      indentYaml(YAML.stringify(params).trimEnd()),
      "```",
      "",
    );
    if (call.ok === false) {
      sections.push(`<!-- Recorded call failed: ${JSON.stringify(call.error ?? {})} -->`, "");
    }
  }

  if (input.malformedLineCount > 0) {
    sections.push(`<!-- ${input.malformedLineCount} malformed calls.jsonl line(s) were ignored. -->`, "");
  }

  const assertions = {
    assertions: [],
    pass_threshold: 1.0,
    critical_must_pass: true,
  };
  return {
    setupYaml: YAML.stringify(setup),
    workflowMarkdown: sections.join("\n").replace(/\n{3,}/g, "\n\n"),
    assertionsYaml: YAML.stringify(assertions),
    capturedCallCount: input.calls.length,
    emittedToolBlocks,
    skippedCallCount,
  };
}

function workflowToolName(tool: string): string | null {
  if (tool.startsWith("signalman_advanced_")) {
    return tool.slice("signalman_advanced_".length);
  }
  if (/^(vm|docker|kernel|driver|ui|browser)_/.test(tool)) {
    return tool;
  }
  return null;
}

function labelSeq(call: RecordedCallEvent): string {
  return typeof call.seq === "number" ? String(call.seq) : "?";
}

function indentYaml(value: string): string {
  if (!value) return "  {}";
  return value
    .split(/\r?\n/)
    .map((line) => `  ${line}`)
    .join("\n");
}

function registerActiveRecording(recording: ActiveRecording): void {
  activeRecordings.set(recording.recording_id, recording);
  lastDiscoveryAt = Date.now();
}

function refreshActiveRecordings(cwd: string): void {
  const now = Date.now();
  if (now - lastDiscoveryAt < DISCOVERY_INTERVAL_MS) return;
  lastDiscoveryAt = now;

  const layout = resolveLayout(cwd);
  if (!fs.existsSync(layout.recordingsDir)) return;

  for (const safeNameEntry of safeReadDir(layout.recordingsDir)) {
    if (!safeNameEntry.isDirectory()) continue;
    const safeNameDir = path.join(layout.recordingsDir, safeNameEntry.name);
    for (const recordingEntry of safeReadDir(safeNameDir)) {
      if (!recordingEntry.isDirectory()) continue;
      const statePath = path.join(safeNameDir, recordingEntry.name, "state.json");
      const active = readActiveRecordingState(statePath);
      if (!active) continue;
      activeRecordings.set(active.recording_id, active);
    }
  }
}

function readActiveRecordingState(statePath: string): ActiveRecording | null {
  try {
    const state = JSON.parse(fs.readFileSync(statePath, "utf-8")) as {
      status?: unknown;
      recording_id?: unknown;
      expires_at?: unknown;
      captured_call_count?: unknown;
      calls_path?: unknown;
    };
    if (state.status !== "recording") return null;
    if (typeof state.recording_id !== "string") return null;
    if (typeof state.expires_at !== "string" || isExpired(state.expires_at)) return null;
    const callsRel = typeof state.calls_path === "string" ? state.calls_path : "calls.jsonl";
    return {
      recording_id: state.recording_id,
      state_path: statePath,
      calls_path: path.join(path.dirname(statePath), callsRel),
      expires_at: state.expires_at,
      captured_call_count:
        typeof state.captured_call_count === "number" && Number.isInteger(state.captured_call_count)
          ? state.captured_call_count
          : 0,
    };
  } catch {
    return null;
  }
}

function safeReadDir(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function isExpired(expiresAt: string): boolean {
  const ts = Date.parse(expiresAt);
  return Number.isNaN(ts) || ts <= Date.now();
}

function markRecordingExpired(recording: ActiveRecording): void {
  updateRecordingState(recording, { status: "expired" });
}

function updateCapturedCallCount(recording: ActiveRecording): void {
  updateRecordingState(recording, { captured_call_count: recording.captured_call_count });
}

function updateRecordingState(recording: ActiveRecording, patch: Record<string, unknown>): void {
  const current = JSON.parse(fs.readFileSync(recording.state_path, "utf-8")) as Record<string, unknown>;
  fs.writeFileSync(recording.state_path, JSON.stringify({ ...current, ...patch }, null, 2) + "\n");
}

function sanitizeForRecording(value: unknown, depth = 0): unknown {
  if (depth > MAX_REDACTION_DEPTH) return "[max-depth]";
  if (value == null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return sanitizeStringForRecording(value);
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY_ITEMS).map((item) => sanitizeForRecording(item, depth + 1));
    if (value.length > MAX_ARRAY_ITEMS) {
      items.push(`[truncated ${value.length - MAX_ARRAY_ITEMS} items]`);
    }
    return items;
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    const entries = Object.entries(value as Record<string, unknown>).slice(0, MAX_OBJECT_KEYS);
    for (const [key, child] of entries) {
      out[key] = SENSITIVE_KEY_RE.test(key) ? "[redacted]" : sanitizeForRecording(child, depth + 1);
    }
    const total = Object.keys(value as Record<string, unknown>).length;
    if (total > MAX_OBJECT_KEYS) {
      out.__truncated_keys = total - MAX_OBJECT_KEYS;
    }
    return out;
  }
  return String(value);
}

function sanitizeStringForRecording(value: string): string {
  const withoutUrlCredentials = redactUrlCredentials(value);
  if (withoutUrlCredentials.length <= MAX_STRING_LENGTH) return withoutUrlCredentials;
  return `${withoutUrlCredentials.slice(0, MAX_STRING_LENGTH)}...[truncated ${
    withoutUrlCredentials.length - MAX_STRING_LENGTH
  } chars]`;
}

function redactUrlCredentials(value: string): string {
  try {
    const parsed = new URL(value);
    if (!parsed.username && !parsed.password) return value;
    parsed.username = "[redacted]";
    parsed.password = "[redacted]";
    return parsed.toString();
  } catch {
    return value;
  }
}

function sanitizeErrorForRecording(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: sanitizeStringForRecording(error.message),
    };
  }
  return {
    message: sanitizeForRecording(error),
  };
}
