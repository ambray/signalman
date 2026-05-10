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

export class RecordValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecordValidationError";
  }
}

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
