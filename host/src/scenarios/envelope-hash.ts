/**
 * Hermetic envelope hash helpers (v0.3.0-3).
 *
 * Pure modules that compute the content-addressed identity fields on
 * `ScenarioResult`:
 *
 *   - `computeScenarioHash` — hashes the three scenario artifacts
 *     (setup.yaml + assertions.yaml + workflow.md) into a stable
 *     64-char hex string.
 *   - `aggregateVmLineageHashes` — combines per-VM `vm_lineage_hash`
 *     values from v0.3.0-2 into a single envelope-level hash for
 *     multi-VM scenarios.
 *   - `classifyNetwork` — derives a single `network_class` label
 *     from a VM's network config.
 *   - `aggregateAgentVersions` — combines per-VM agent versions
 *     into a single envelope-level string.
 *
 * # Locked design (do not re-litigate)
 *
 * - **Hash the parsed form of YAML, not raw bytes.** Comments and
 *   whitespace don't change the hash; semantic changes do.
 * - **Hash the unresolved form** — `${param:NAME}` references stay
 *   literal. The downstream cache layer keys on
 *   `(scenario_hash, params_hash, vm_lineage_hash, agent_version)`
 *   so parameterised runs cache separately per parameter set.
 * - **LF-normalised workflow content.** CRLF vs LF and BOM
 *   stripped. Editor-write differences don't invalidate caches.
 * - **Canonical JSON, then SHA-256.** Same pattern as v0.3.0-2's
 *   `vm_lineage_hash`. Keys sorted lexicographically at every level.
 * - **Lowercase hex output.** Matches the project's existing
 *   convention (template-fetch.ts, vm-lineage-hash.ts).
 *
 * # Output stability promise
 *
 * Once v0.3.0-3 ships, the canonical-JSON shape and the resulting
 * hashes are frozen. A change to the canonicalisation rules is a
 * wire-breaking change because every cached scenario result is
 * keyed on the hash.
 */

import * as crypto from "node:crypto";

// ── Types ──────────────────────────────────────────────────────────

/**
 * Inputs to {@link computeScenarioHash}.
 *
 * Pass the parsed forms (not raw bytes) for the YAML files so
 * comments and whitespace differences don't perturb the hash.
 * Pass the raw markdown for workflow content; we LF-normalise it
 * internally.
 */
export interface ScenarioHashInputs {
  /**
   * Parsed `setup.yaml` content. Any JSON-serialisable shape; the
   * canonical-JSON pass sorts keys at every level. Typically the
   * return of `yaml.parse(...)`.
   */
  setup: unknown;
  /**
   * Parsed `assertions.yaml` content. Same shape rules as `setup`.
   * Pass `{ assertions: [] }` for scenarios without an assertions
   * file so the hash is stable across the "no file" / "empty file"
   * distinction.
   */
  assertions: unknown;
  /**
   * Raw `workflow.md` content. LF-normalised internally; CRLF and
   * BOM are stripped before hashing. Pass `""` for scenarios
   * without a workflow file.
   */
  workflow: string;
}

/** Network-config inputs for {@link classifyNetwork}. */
export interface NetworkClassInputs {
  /** From `VmConfig.network`. */
  network?: { switch?: string; static_ip?: string } | undefined;
  /** `true` when the VM is operator-managed (no orchestrator control). */
  pre_started?: boolean;
  /** `true` when the VM is provisioned ephemerally (v0.3.0-2). */
  ephemeral?: boolean;
}

// ── Errors ─────────────────────────────────────────────────────────

/**
 * Structured error for envelope-hash inputs. Stable `code` for
 * programmatic dispatch.
 */
export class EnvelopeHashError extends Error {
  constructor(
    public readonly code: "non_string_workflow" | "unhashable_value",
    message: string,
  ) {
    super(message);
    this.name = "EnvelopeHashError";
  }
}

// ── Canonical-JSON helper ─────────────────────────────────────────

/**
 * Produce canonical JSON of an arbitrary JSON-serialisable value.
 *
 * Rules:
 *   - Object keys sorted lexicographically at every level.
 *   - Arrays preserve their declared order (different orderings
 *     have semantic meaning in scenario YAML; callers sort
 *     beforehand if they want order-independent hashing).
 *   - `undefined` fields are omitted.
 *   - No whitespace, no trailing newline.
 *
 * @throws {@link EnvelopeHashError} with code `unhashable_value`
 *         when a non-serialisable value (function, symbol, circular
 *         reference) is encountered.
 */
export function canonicalJson(value: unknown): string {
  try {
    return canonicalize(value);
  } catch (err) {
    throw new EnvelopeHashError(
      "unhashable_value",
      `cannot canonicalize value: ${(err as Error).message ?? String(err)}`,
    );
  }
}

function canonicalize(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`non-finite number is not JSON-representable: ${value}`);
    }
    return String(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return "[" + value.map((v) => canonicalize(v ?? null)).join(",") + "]";
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const out: string[] = [];
    for (const k of keys) {
      const v = obj[k];
      if (v === undefined) continue; // omit undefined
      out.push(JSON.stringify(k) + ":" + canonicalize(v));
    }
    return "{" + out.join(",") + "}";
  }
  throw new Error(`unsupported value type: ${typeof value}`);
}

// ── scenario_hash ──────────────────────────────────────────────────

/**
 * Normalise workflow markdown for hashing: strip leading BOM,
 * convert CRLF to LF, leave content otherwise untouched.
 *
 * Exported so the orchestrator (or future consumers) can re-derive
 * the exact bytes that fed the scenario_hash for audit purposes.
 */
export function normalizeWorkflow(content: string): string {
  if (typeof content !== "string") {
    throw new EnvelopeHashError(
      "non_string_workflow",
      `workflow content must be a string, got ${typeof content}`,
    );
  }
  // Strip a leading UTF-8 BOM. Various editors add it on Windows;
  // it's semantically irrelevant.
  let normalized = content.replace(/^﻿/, "");
  // Normalise line endings.
  normalized = normalized.replace(/\r\n/g, "\n");
  return normalized;
}

/**
 * Compute the 64-char lowercase-hex SHA-256 over the three
 * scenario artifacts (setup + assertions + workflow). See module
 * doc for the locked rules.
 */
export function computeScenarioHash(inputs: ScenarioHashInputs): string {
  const setupHash = sha256Hex(canonicalJson(inputs.setup));
  const assertionsHash = sha256Hex(canonicalJson(inputs.assertions));
  const workflowHash = sha256Hex(normalizeWorkflow(inputs.workflow));

  const combined = canonicalJson({
    assertions: assertionsHash,
    setup: setupHash,
    workflow: workflowHash,
  });
  return sha256Hex(combined);
}

// ── network_class ──────────────────────────────────────────────────

/**
 * Sanitise a switch name into a stable, hyphenated label.
 *
 * Internal to {@link classifyNetwork} but exported because tests
 * exercise the sanitisation contract directly.
 */
export function sanitizeSwitchName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Classify a VM's network config into a single stable string.
 *
 * Output values (locked):
 *   - `"pre-started"` — operator-managed VM
 *   - `"default"` — no network block declared
 *   - `<sanitised-switch-name>` — switch declared (e.g.
 *     `"default-switch"`, `"isolated-lab-switch"`)
 *
 * Future versions may add richer classification (NAT detection,
 * reachability probes); the contract stays "single stable label".
 */
export function classifyNetwork(input: NetworkClassInputs): string {
  if (input.pre_started) return "pre-started";
  const sw = input.network?.switch;
  if (sw && sw.length > 0) {
    const sanitised = sanitizeSwitchName(sw);
    if (sanitised.length > 0) return sanitised;
  }
  return "default";
}

// ── vm_lineage_hash aggregation ───────────────────────────────────

/**
 * Combine per-VM `vm_lineage_hash` values into a single envelope-
 * level hash for multi-VM scenarios.
 *
 * Behaviour:
 *   - Empty input → empty string. Caller's choice whether to
 *     populate the envelope field at all.
 *   - One input → that hash verbatim.
 *   - Multiple inputs → SHA-256 of canonical JSON of the sorted
 *     array of hashes. Sorting is intentional so per-VM ordering
 *     in the scenario YAML doesn't affect the envelope hash.
 */
export function aggregateVmLineageHashes(hashes: readonly string[]): string {
  if (hashes.length === 0) return "";
  if (hashes.length === 1) return hashes[0];
  const sorted = hashes.slice().sort();
  return sha256Hex(canonicalJson(sorted));
}

// ── Sorted-unique-comma-join aggregation ──────────────────────────

/**
 * Combine an array of string labels into a single envelope-level
 * string. Generic primitive used for `agent_version`, `network_class`,
 * and future per-VM-label envelope fields that follow the same
 * "stable label set → one envelope string" pattern.
 *
 * Behaviour:
 *   - Empty / all-undefined / all-empty-string input → `undefined`.
 *     Caller leaves the envelope field undefined.
 *   - One unique label → that label verbatim.
 *   - Multiple unique labels → comma-joined sorted-unique list
 *     (e.g. `"0.1.5,0.2.1"` for agent versions; `"default,isolated-lab"`
 *     for network classes).
 *
 * `undefined`/empty entries are filtered before aggregation so a
 * single failed VM (e.g. no health response) doesn't pollute the
 * envelope with falsy values.
 */
export function aggregateUniqueStrings(
  labels: ReadonlyArray<string | undefined>,
): string | undefined {
  const real = labels.filter(
    (v): v is string => typeof v === "string" && v.length > 0,
  );
  if (real.length === 0) return undefined;
  const unique = Array.from(new Set(real)).sort();
  return unique.join(",");
}

/**
 * Combine per-VM agent-version strings into a single envelope-level
 * string. Thin wrapper over {@link aggregateUniqueStrings} preserved
 * for API clarity — the call site reads more clearly than the
 * generic name. Identical semantics.
 */
export function aggregateAgentVersions(
  versions: ReadonlyArray<string | undefined>,
): string | undefined {
  return aggregateUniqueStrings(versions);
}

// ── Internal SHA-256 helper ────────────────────────────────────────

function sha256Hex(input: string): string {
  return crypto.createHash("sha256").update(input, "utf8").digest("hex");
}
