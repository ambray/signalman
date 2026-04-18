/**
 * Parser for `kd.exe` / `windbg.exe` console output.
 *
 * Keeping the parser as a set of pure functions (no I/O, no state beyond
 * the input string) makes it cheap to unit-test against recorded output
 * fixtures and lets us iterate on parser edge cases without touching the
 * stateful session code.
 *
 * The parser recognizes a handful of line-level signals that the session
 * wrapper in `kd-session.ts` reacts to:
 *
 * - **Command sentinels** — we bracket every command we send with
 *   `; .echo SIGNALMAN-<uuid>-END` so we know when the kd engine has
 *   finished processing it. This is the only reliable way to know that
 *   kd is done producing output for a given command, because kd does not
 *   expose a machine-readable prompt.
 *
 * - **Bugchecks** — lines of the form `*** Fatal System Error: 0x<hex>`
 *   (the classic form) or the `BUGCHECK_CODE:` line emitted inside
 *   `!analyze -v` output. Either is evidence that the VM has bugchecked
 *   and kd is now sitting broken-in at the fault.
 *
 * - **Module loads** — lines of the form `ModLoad: <range>   <path>`.
 *   Used in combination with `sxe ld <module>` to break when a specific
 *   module (e.g. `example.sys`) loads, so we can set breakpoints inside
 *   `DriverEntry` before any driver code runs.
 *
 * - **Break instruction** — `Break instruction exception`, typically
 *   generated when `DbgBreakPoint` is hit or when a user hits `Ctrl+Break`.
 *
 * - **Disconnect** — connection-loss markers that signalman maps to a
 *   lifecycle `disconnect` event. Rare in healthy runs; almost always a
 *   VM reset or a hung serial link.
 *
 * The parser is case-sensitive and anchored on strings Microsoft has been
 * emitting consistently across at least a decade of Windows Debugging
 * Tools releases. If Microsoft changes the wording, the fixtures in
 * `__tests__/kd-parser.test.ts` will fail first — faster detection than
 * a broken scenario would give us.
 */

/**
 * A single semantically-meaningful signal extracted from a line of kd
 * output. `none` means "plain text, no special handling" — the session
 * may still choose to forward it to a log sink.
 */
export type KdSignal =
  | { kind: "none" }
  | { kind: "command-sentinel"; uuid: string }
  | { kind: "bugcheck"; code: string; parameters?: string[] }
  | { kind: "module-load"; module: string; range?: string }
  | { kind: "break-instruction"; detail?: string }
  | { kind: "disconnect"; reason: string };

/**
 * Sentinel emitted around every command so we know when kd has finished
 * processing it. Format: `SIGNALMAN-<uuid>-END` where `<uuid>` is the
 * session-chosen opaque identifier. The regex matches on the full line
 * to avoid false positives in user-controlled output (e.g. a log line
 * that happens to contain the word SIGNALMAN).
 */
const COMMAND_SENTINEL_RE =
  /^SIGNALMAN-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-END\s*$/i;

/**
 * Classic bugcheck line: `*** Fatal System Error: 0xNN` or `*** Fatal
 * System Error: 0xNN (p1,p2,p3,p4)` on the next line. We match only the
 * header here; parameter extraction is best-effort in
 * `extractBugcheckParameters`.
 */
const BUGCHECK_FATAL_ERROR_RE =
  /^\s*\*\*\*\s*Fatal System Error:\s*(0x[0-9a-fA-F]+)/;

/**
 * `!analyze -v` emits a `BUGCHECK_CODE:` field. Different format, same
 * underlying event; normalize to the same signal.
 */
const BUGCHECK_ANALYZE_RE =
  /^\s*BUGCHECK_CODE:\s*([0-9a-fA-F]+)/;

/**
 * Module-load line emitted during kernel debugging. Example:
 *
 *     ModLoad: fffff807`b3a00000 fffff807`b3a16000   example.sys
 *
 * The range is optional — some kd builds omit the addresses when symbols
 * are unavailable.
 */
const MODULE_LOAD_RE =
  /^\s*ModLoad:\s+(?:([0-9a-fA-F`]+)\s+([0-9a-fA-F`]+)\s+)?(.+?)\s*$/;

/**
 * `Break instruction exception - code 80000003 (first chance)` — typical
 * output when the VM breaks into the debugger via `DbgBreakPoint` or a
 * user `.break`.
 */
const BREAK_INSTRUCTION_RE = /^\s*Break instruction exception/i;

/**
 * Common disconnect markers. kd logs these in different forms depending
 * on whether the serial pipe closed, the target was power-cycled, or a
 * kernel panic took down the debug thread itself.
 */
const DISCONNECT_MARKERS = [
  "Debuggee is not connected",
  "Connection closed",
  "The target is not connected",
  "WARNING: .reload failed, Win32 error 0n2", // symptom of target gone
];

/**
 * Parse a single line of kd output into a `KdSignal`.
 *
 * The input is a single line with no trailing newline. Lines are matched
 * in priority order — the first matching pattern wins. This keeps the
 * parser's behavior deterministic when a single line happens to match
 * multiple patterns (which rarely happens in practice, but is possible
 * for malformed output).
 */
export function parseLine(line: string): KdSignal {
  const sentinelMatch = COMMAND_SENTINEL_RE.exec(line);
  if (sentinelMatch) {
    return { kind: "command-sentinel", uuid: sentinelMatch[1] };
  }

  const fatalMatch = BUGCHECK_FATAL_ERROR_RE.exec(line);
  if (fatalMatch) {
    return { kind: "bugcheck", code: normalizeBugcheckCode(fatalMatch[1]) };
  }

  const analyzeMatch = BUGCHECK_ANALYZE_RE.exec(line);
  if (analyzeMatch) {
    return { kind: "bugcheck", code: normalizeBugcheckCode(analyzeMatch[1]) };
  }

  const moduleMatch = MODULE_LOAD_RE.exec(line);
  if (moduleMatch) {
    const range = moduleMatch[1] && moduleMatch[2]
      ? `${moduleMatch[1]}-${moduleMatch[2]}`
      : undefined;
    return { kind: "module-load", module: moduleMatch[3], range };
  }

  if (BREAK_INSTRUCTION_RE.test(line)) {
    return { kind: "break-instruction", detail: line.trim() };
  }

  for (const marker of DISCONNECT_MARKERS) {
    if (line.includes(marker)) {
      return { kind: "disconnect", reason: marker };
    }
  }

  return { kind: "none" };
}

/**
 * Normalize a bugcheck code to `0xNN` lowercase-hex form.
 *
 * kd emits bugcheck codes in several formats:
 * - `0xd1` / `0xD1` — the `*** Fatal System Error` path
 * - `d1` / `D1` — the `BUGCHECK_CODE:` field in `!analyze -v`
 * - `0x000000D1` — long-form in some `!analyze` reports
 *
 * Callers that want to compare against an expected value shouldn't have
 * to worry about which of those kd happened to emit. Normalize to
 * lowercase `0xd1`.
 */
export function normalizeBugcheckCode(raw: string): string {
  let cleaned = raw.trim().toLowerCase();
  if (cleaned.startsWith("0x")) {
    cleaned = cleaned.slice(2);
  }
  // Strip leading zeros but keep at least one digit.
  cleaned = cleaned.replace(/^0+/, "") || "0";
  return `0x${cleaned}`;
}

/**
 * Attempt to extract bugcheck parameters from the parenthesised tuple
 * that `*** Fatal System Error` sometimes prints on the next line, e.g.:
 *
 *     (0xffffffff00000000,0x0000000000000002,0x0000000000000001,0xfffff807f3d9abcd)
 *
 * Returns `undefined` if the line doesn't match. Separated from
 * `parseLine` because the parameters appear on a different line than
 * the header, so the session has to correlate them.
 */
export function extractBugcheckParameters(line: string): string[] | undefined {
  const match = /^\s*\(([^)]+)\)\s*$/.exec(line);
  if (!match) return undefined;
  const parts = match[1].split(",").map((p) => p.trim());
  if (parts.length === 0) return undefined;
  // Reject anything that doesn't look like a hex tuple.
  if (!parts.every((p) => /^0x[0-9a-fA-F]+$/.test(p))) return undefined;
  return parts;
}

/**
 * Split a raw chunk of kd output (which may contain multiple lines and
 * may end mid-line) into complete lines plus a residual tail.
 *
 * This is the classic "tail-buffer" splitter that stateful stream
 * consumers need. The session holds the `residual` between calls and
 * passes it back in on the next chunk.
 *
 * @returns `{ complete, residual }` — `complete` is an array of lines
 *   with no trailing newline; `residual` is any trailing partial line
 *   that should be prepended to the next chunk.
 */
export function splitLines(
  chunk: string,
  previousResidual = "",
): { complete: string[]; residual: string } {
  const joined = previousResidual + chunk;
  const parts = joined.split(/\r\n|\n|\r/);
  // The last element is either a complete line (if chunk ended with \n)
  // or a partial line we need to hold onto.
  const residual = parts.pop() ?? "";
  return { complete: parts, residual };
}

/**
 * Build the command-sentinel suffix we append to every user command.
 *
 * Returns both the string to send to kd and the UUID the session should
 * watch for. Separating the string from the UUID avoids the caller
 * having to re-parse the sentinel to know what to match.
 */
export function buildCommandWithSentinel(
  userCommand: string,
  uuid: string,
): { fullCommand: string; sentinelUuid: string } {
  const trimmed = userCommand.replace(/;\s*$/, "").trim();
  return {
    fullCommand: `${trimmed}; .echo SIGNALMAN-${uuid}-END`,
    sentinelUuid: uuid,
  };
}

/**
 * Extract the human-readable bugcheck name from a `!analyze -v` line
 * of the form `BUGCHECK_CODE:  d1 (DRIVER_IRQL_NOT_LESS_OR_EQUAL)`.
 *
 * Many `!analyze` outputs don't include the symbolic name (only the
 * numeric code), so this returns `undefined` when no name is present.
 */
export function extractBugcheckName(analyzeOutput: string): string | undefined {
  const match = /BUGCHECK_CODE:\s*[0-9a-fA-F]+\s*\(([A-Z_0-9]+)\)/.exec(
    analyzeOutput,
  );
  return match ? match[1] : undefined;
}
