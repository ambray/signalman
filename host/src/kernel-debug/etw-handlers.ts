/**
 * ETW tool-block handlers for driver telemetry assertions.
 *
 * Sprint 60.11 left the ETW provider + event emission landed but
 * offered no scenario-level way to assert events actually fired.
 * `kernel_etw_start` + `kernel_etw_stop` close that gap:
 *
 *   1. `kernel_etw_start`: creates + starts a named ETW trace session
 *      via `logman create trace <name> -p "{GUID}" <keywords_hex>
 *      <level> -ets -o <etl_path>`. The `-ets` flag creates the
 *      session through the kernel ETW API directly (no persistent
 *      data-collector registration needed). Returns once logman
 *      confirms the session is live.
 *
 *   2. Other tool blocks execute — driver_load, vm_run_command that
 *      triggers enforcement events, etc.
 *
 *   3. `kernel_etw_stop`: `logman stop <name> -ets`, parses the ETL
 *      via `Get-WinEvent -Path <etl> -Oldest | Where-Object ProviderId
 *      ... | ConvertTo-Json`, filters to the caller's provider GUID,
 *      returns per-event-name counts + the first few events'
 *      properties. Scenarios assert via `stdout_contains` on the
 *      returned JSON.
 *
 * Why logman and not WPR?
 *
 *   * WPR's .wprp profile XML has opaque provider-resolution rules
 *     for non-manifest (TraceLogging) providers. Even with the
 *     `Name="{GUID}" NonPagedMemory="true"` form, `wpr -start`
 *     returns exit 0 but silently fails to attach the provider;
 *     `wpr -stop` then errors with WPR_E_NO_PROVIDERS_IN_PROFILE
 *     (0xC5580612). Empirically verified on Win11 24H2.
 *
 *   * logman bypasses the profile abstraction entirely — it hands
 *     the raw (GUID, keyword, level) triple to EtwSessionEnable.
 *     That's what we need: we're testing a specific TraceLogging
 *     provider we own. No name resolution, no session coordination,
 *     no XML schema quirks.
 *
 *   * `buildWprProfile` is kept exported for diagnostic callers
 *     that may want the XML for manual wpr experiments; the handler
 *     itself no longer uses it.
 *
 * Design constraints worth noting here:
 *
 *   * No shared handler state. `kernel_etw_start` and `_stop` are
 *     fully independent; they synchronize via the guest's ETW
 *     session registry (keyed by session name), not via `this.*`
 *     in TypeScript. Multiple scenarios racing on the same VM would
 *     collide, but signalman already assumes one scenario per VM at
 *     a time.
 *
 *   * Parse on the guest, not on the host. `Get-WinEvent -Path`
 *     works host-side only if the .etl is accessible; pulling
 *     the ETL to the host first costs a round-trip per scenario.
 *     Doing `Get-WinEvent | ConvertTo-Json` on the guest and
 *     reading the JSON from stdout is cheaper and keeps the host
 *     stateless.
 */

import type { GuestAgentClient } from "../guest/client.js";

/**
 * Dependencies every ETW handler needs. Constructed per tool-block
 * invocation by the orchestrator via {@link tools.ts}.
 */
export interface EtwHandlerContext {
  readonly guestClient: GuestAgentClient;
  readonly vmName: string;
}

// ── kernel_etw_start ─────────────────────────────────────────────────

export interface KernelEtwStartParams {
  /**
   * Provider GUID (hex, with or without braces). Operator-supplied;
   * the scenario knows the GUID of the driver it's tracing.
   */
  provider_guid: string;
  /**
   * u64 keyword mask. Expressed as a hex string (TypeScript numbers
   * don't reliably hold u64) — e.g. `"0x10"` for just ENFORCEMENT,
   * or `"0xFFFFFFFFFFFFFFFF"` for all keywords. Lowercase or
   * uppercase hex both OK.
   */
  keywords: string;
  /**
   * TraceLogging level gate. Default 5 (Verbose) captures everything;
   * 4 = Information, 3 = Warning, 2 = Error, 1 = Critical.
   */
  level?: number;
  /**
   * Optional session name override. Default is a stable name
   * `SignalmanScenarioEtw` so cleanup after a crashed scenario is
   * predictable. Changing this per scenario would fragment leftover-
   * session cleanup. Whatever name `_start` uses MUST be passed
   * verbatim to `_stop`.
   */
  session_name?: string;
  /**
   * Guest path for the output ETL. Default lands it under
   * `C:\Signalman\logs\` (which scenarios may need to create in setup).
   * MUST end in `.etl`; logman refuses other extensions.
   */
  etl_path?: string;
  /**
   * Deprecated — WPR profile XML path. Retained for API shape
   * compatibility with the pre-logman handler. Ignored by the
   * current implementation.
   *
   * @deprecated Ignored; logman does not use a profile XML.
   */
  profile_path?: string;
  /**
   * Start-command timeout (default 90 s). Covers the idempotent
   * leftover-session cleanup, ETL dir prep, and `logman create
   * trace -ets`. The default needs to tolerate slow cold-boot
   * settle on Hyper-V guests — logman itself completes in under
   * 1 s, but the first PowerShell invocation after a fresh boot
   * can queue behind Guest Services startup.
   */
  timeout_ms?: number;
}

export interface KernelEtwStartResult {
  /** Exit code from `logman create trace -ets`. 0 = session live. */
  status: number;
  /** Where the ETL will be written on `_stop`. Caller passes this
   *  verbatim to `kernel_etw_stop`'s `etl_path`. */
  etl_path: string;
  /** Raw stdout from `logman create trace` (diagnostics on failure). */
  stdout: string;
  /** Raw stderr from `logman create trace`. */
  stderr: string;
}

const DEFAULT_SESSION_NAME = "SignalmanScenarioEtw";
const DEFAULT_ETL_PATH = "C:\\Signalman\\logs\\etw-capture.etl";

/**
 * Start an ETW recording session targeting the given provider.
 *
 * Flow: normalize GUID → idempotent `logman stop -ets` (clears any
 * leftover session from a crashed prior run) → ensure ETL dir exists
 * + scrub stale ETL → `logman create trace <session> -p "{GUID}"
 * <kw_hex> <level> -ets -o <etl>`. Returns once logman confirms the
 * session is live.
 */
export async function handleKernelEtwStart(
  ctx: EtwHandlerContext,
  params: KernelEtwStartParams,
): Promise<KernelEtwStartResult> {
  const level = params.level ?? 5;
  const sessionName = params.session_name ?? DEFAULT_SESSION_NAME;
  const etlPath = params.etl_path ?? DEFAULT_ETL_PATH;
  const timeoutMs = params.timeout_ms ?? 90_000;

  // Split the outer budget across 3 sub-commands. Cleanup + prep are
  // fast (under 1s on a warm guest), so a sixth each is plenty. The
  // real work is `logman create trace`, which on a fresh-booted VM
  // has to materialize the ETW session, allocate buffers, and wait
  // for the first event flush. Two-thirds for create trace keeps the
  // total bounded by the outer budget even if all three hit their
  // allotted cap.
  const cleanupTimeout = Math.min(30_000, Math.floor(timeoutMs / 6));
  const prepTimeout = Math.min(30_000, Math.floor(timeoutMs / 6));
  const createTimeout = Math.max(30_000, Math.floor((timeoutMs * 2) / 3));

  const guid = normalizeGuid(params.provider_guid);
  const keywordHex = normalizeKeywordHex(params.keywords);

  // We use `logman create trace ... -ets` (not WPR). WPR's profile XML
  // has brittle provider resolution for non-manifest TraceLogging
  // providers — `wpr -start` returns exit 0 but silently fails to
  // attach the provider, and `wpr -stop` then errors out with
  // WPR_E_NO_PROVIDERS_IN_PROFILE (0xC5580612). logman goes directly
  // through the EtwSessionEnable syscall with the raw GUID + keyword +
  // level triple, which is exactly what we want.
  //
  // Flow:
  //   1. logman stop <session> -ets (idempotent cleanup of a leftover
  //      session from a crashed prior run — ignore exit code)
  //   2. ensure the ETL dir exists + delete any stale ETL at the target
  //      path (logman refuses to overwrite an existing .etl)
  //   3. logman create trace <session> -p "{GUID}" <keywords_hex>
  //      <level> -ets -o <etl_path> -rt  (the -ets flag creates AND
  //      starts the session in one shot; -rt would be real-time, we
  //      skip it since we want the ETL file)

  // 1. Idempotent stop of any leftover session. logman returns non-zero
  //    if the session doesn't exist; we ignore that outcome. The call
  //    itself may also time out on a cold guest whose agent is still
  //    warming up — that's fine too, cleanup is belt-and-suspenders.
  //    Anything not cleaned up now will make `logman create trace` fail
  //    below, which we do report.
  try {
    await ctx.guestClient.runCommand(
      "logman.exe",
      ["stop", sessionName, "-ets"],
      { timeoutMs: cleanupTimeout, runAs: "SYSTEM" },
    );
  } catch {
    // Intentional swallow: best-effort cleanup.
  }

  // 2. Ensure the directory exists + scrub any stale ETL.
  const prepScript =
    `$dir = Split-Path -Parent '${etlPath}'; ` +
    `if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }; ` +
    `if (Test-Path '${etlPath}') { Remove-Item -Force -LiteralPath '${etlPath}' }`;
  const prep = await ctx.guestClient.runCommand(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", prepScript],
    { timeoutMs: prepTimeout, runAs: "SYSTEM" },
  );
  if (prep.exitCode !== 0) {
    throw new Error(
      `kernel_etw_start: ETL dir prep failed (exit ${prep.exitCode}): ` +
        prep.stderr.slice(0, 300),
    );
  }

  // 3. Create + start trace. Note: logman's `-p` flag takes the GUID
  //    in curly braces, a keyword hex (0xHH... form), and a level int.
  //    The `-ets` flag creates the session via the ETW API directly,
  //    bypassing logman's persistent data collector abstraction.
  const start = await ctx.guestClient.runCommand(
    "logman.exe",
    [
      "create", "trace", sessionName,
      "-p", `{${guid}}`, keywordHex, String(level),
      "-ets",
      "-o", etlPath,
    ],
    { timeoutMs: createTimeout, runAs: "SYSTEM" },
  );

  if (start.exitCode !== 0) {
    throw new Error(
      `kernel_etw_start: logman create trace exited ${start.exitCode}: ` +
        `stdout=${start.stdout.slice(0, 200)} stderr=${start.stderr.slice(0, 200)}`,
    );
  }

  return {
    status: start.exitCode,
    etl_path: etlPath,
    stdout: start.stdout,
    stderr: start.stderr,
  };
}

// ── kernel_etw_stop ──────────────────────────────────────────────────

export interface KernelEtwStopParams {
  /** GUID-hex filter. Usually same as the `_start` param — events
   *  from OTHER providers the ETW session happened to pick up (ETW
   *  sessions sometimes see bootstrap events even when the session
   *  was opened for a specific provider) get filtered out by this. */
  provider_guid: string;
  /** ETW session name. Must match what `_start` used (defaults to
   *  `SignalmanScenarioEtw`). */
  session_name?: string;
  /** Guest path to write the ETL to. Should match `_start`'s
   *  `etl_path` return field verbatim. */
  etl_path?: string;
  /**
   * How many events' full properties to return in `events[]`. Rest
   * are counted only. Default 50 balances TypeScript-side memory vs.
   * diagnostic visibility.
   */
  max_events_returned?: number;
  /** Stop-command timeout (default 60 s). Covers `logman stop` (fast)
   *  + Get-WinEvent parse (slow on first post-boot invocation as the
   *  TDH cache warms). */
  timeout_ms?: number;
}

export interface EtwEventSummary {
  /** Event name from TraceLogging (what was passed as the first arg
   *  to `TraceLoggingWrite` in the driver). */
  name: string;
  /** ETW Opcode — usually 0 for TraceLogging events. */
  opcode: number;
  /** Event level (1-5, matches TRACE_LEVEL_*). */
  level: number;
  /** Keywords bitmask (hex string). */
  keywords: string;
  /** ISO-8601 timestamp from the event. */
  time_created?: string;
  /** Per-event field values as a flat JSON object. */
  properties?: Record<string, unknown>;
}

export interface KernelEtwStopResult {
  /** Exit code from `logman stop`. */
  status: number;
  /** Where the ETL was written. */
  etl_path: string;
  /** Per-event-name counts, e.g. `{"RuleMatched": 2, "ScopeCreated": 1}`. */
  event_counts: Record<string, number>;
  /** Total events seen from the target provider. */
  total_events: number;
  /** First N events' full detail. Later events truncated per
   *  `max_events_returned`. */
  events: EtwEventSummary[];
  /** Raw stderr from `logman stop` (diagnostics on truncated ETLs). */
  stderr: string;
}

/**
 * Stop the recording session, pull the events, summarize.
 *
 * Flow: `logman stop <session> -ets` → PowerShell `Get-WinEvent -Path
 * <etl>` → filter to provider by GUID → group by TaskDisplayName
 * (TraceLogging's event-name slot) → return counts + first N full
 * events.
 */
export async function handleKernelEtwStop(
  ctx: EtwHandlerContext,
  params: KernelEtwStopParams,
): Promise<KernelEtwStopResult> {
  const etlPath = params.etl_path ?? DEFAULT_ETL_PATH;
  const maxEvents = params.max_events_returned ?? 50;
  const timeoutMs = params.timeout_ms ?? 60_000;
  const sessionName = params.session_name ?? DEFAULT_SESSION_NAME;
  const guid = normalizeGuid(params.provider_guid);

  // 1. Stop via logman (symmetric with `_start`'s logman create). The
  //    session flushes its buffers to the ETL on stop; the ETL is then
  //    ready for Get-WinEvent.
  const stop = await ctx.guestClient.runCommand(
    "logman.exe",
    ["stop", sessionName, "-ets"],
    { timeoutMs, runAs: "SYSTEM" },
  );

  if (stop.exitCode !== 0) {
    throw new Error(
      `kernel_etw_stop: logman stop exited ${stop.exitCode}: ` +
        `stdout=${stop.stdout.slice(0, 200)} stderr=${stop.stderr.slice(0, 200)}`,
    );
  }

  // 2. Parse. Pipeline:
  //      Get-WinEvent -Path <etl> -Oldest
  //        — TraceLogging records the event name in the Message
  //        property's "EventName" field, NOT as the event ID.
  //        -Oldest is required for ETL files (live sessions default
  //        to newest-first).
  //      Where-Object ProviderId matches our GUID.
  //      Select relevant columns.
  //      ConvertTo-Json -Depth 4 -Compress.
  //
  //    We capture Properties[] verbatim. TraceLogging encodes each
  //    emitted field as one Property; the name comes from
  //    TraceLoggingString/UInt32/etc's optional name parameter, but
  //    Get-WinEvent doesn't expose those names — just values in
  //    positional order. For count assertions that's OK; for field-
  //    value assertions we'd need a richer parser (Phase 2 work).
  // TraceLogging event names are stored in the event's EVENT_METADATA
  // via the TraceLogging runtime. Get-WinEvent surfaces it on
  // `TaskDisplayName`, but only when TDH can locate the decoded
  // metadata. For self-describing providers (our case) this usually
  // works, but two fallbacks harden it:
  //
  //   1. If `TaskDisplayName` is null/empty, use the rendered task
  //      from the event's ToXml() — the `<Task>...</Task>` element
  //      contains the event name string for TraceLogging.
  //   2. If that also fails, label by numeric Id so at least event
  //      counts remain distinguishable (assertions would then key
  //      on "Id_123" rather than "RuleMatched").
  const parseScript =
    `$events = Get-WinEvent -Path '${etlPath}' -Oldest ` +
    `| Where-Object { $_.ProviderId -eq [Guid]'${guid}' } ` +
    `| ForEach-Object { ` +
    `    $n = $_.TaskDisplayName; ` +
    `    if ([string]::IsNullOrEmpty($n)) { ` +
    `      try { $xml = [xml]$_.ToXml(); $n = $xml.Event.RenderingInfo.Task } catch {} ` +
    `    }; ` +
    `    if ([string]::IsNullOrEmpty($n)) { $n = "Id_$($_.Id)" }; ` +
    `    [PSCustomObject]@{ ` +
    `      name = $n; ` +
    `      opcode = $_.Opcode; ` +
    `      level = $_.Level; ` +
    `      keywords = ('0x{0:X16}' -f [int64]$_.Keywords); ` +
    `      time = $_.TimeCreated.ToString('o'); ` +
    `      props = ($_.Properties | ForEach-Object { $_.Value }) ` +
    `    } ` +
    `  }; ` +
    `if ($null -eq $events) { $events = @() }; ` +
    `$events | ConvertTo-Json -Depth 4 -Compress`;

  // Get-WinEvent's parse time on a cold guest can be 30-60s just for
  // loading the ETW parser cache; subsequent invocations are fast.
  // Give the parse the full remaining budget rather than a fixed 30s
  // so short scenarios don't flake on first-run parser cold-start.
  const parse = await ctx.guestClient.runCommand(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", parseScript],
    { timeoutMs, runAs: "SYSTEM" },
  );

  const parsedEvents = parseEventJson(parse.stdout);
  const counts = countByName(parsedEvents);

  return {
    status: stop.exitCode,
    etl_path: etlPath,
    event_counts: counts,
    total_events: parsedEvents.length,
    events: parsedEvents.slice(0, maxEvents),
    stderr: stop.stderr,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Normalize a provider GUID to the all-lowercase dash-separated
 * no-braces form PowerShell's `[Guid]::new(...)` accepts. Rejects
 * obviously malformed input early rather than handing it to logman,
 * which emits opaque "invalid parameter" errors.
 */
export function normalizeGuid(raw: string): string {
  const stripped = raw.replace(/[{}\s]/g, "").toLowerCase();
  const re = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  if (!re.test(stripped)) {
    throw new Error(
      `kernel_etw: provider_guid '${raw}' is not a valid GUID ` +
        `(expected xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx form)`,
    );
  }
  return stripped;
}

/**
 * Normalize a keyword mask input (e.g. "0x10", "16", "0XFF") to the
 * `0x%X` hex-literal form logman's `-p` flag expects. Bigint parsing
 * so we don't lose bits above 2^53.
 */
export function normalizeKeywordHex(raw: string): string {
  const trimmed = raw.trim();
  let n: bigint;
  try {
    if (trimmed.startsWith("0x") || trimmed.startsWith("0X")) {
      n = BigInt(trimmed);
    } else if (/^[0-9]+$/.test(trimmed)) {
      n = BigInt(trimmed);
    } else if (/^[0-9a-fA-F]+$/.test(trimmed)) {
      // Bare hex digits with no 0x prefix.
      n = BigInt(`0x${trimmed}`);
    } else {
      throw new Error(`unrecognized format: ${trimmed}`);
    }
  } catch (e) {
    throw new Error(
      `kernel_etw: keywords '${raw}' is not a valid u64 hex/decimal: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (n < 0n || n > 0xFFFFFFFFFFFFFFFFn) {
    throw new Error(
      `kernel_etw: keywords '${raw}' is out of u64 range`,
    );
  }
  return `0x${n.toString(16).toUpperCase()}`;
}

/**
 * Build the WPR profile XML targeting one provider with one keyword
 * mask + level. WPR is picky about the schema — missing attributes
 * or out-of-order children produce opaque error 0xC5583001.
 */
export function buildWprProfile(opts: {
  sessionName: string;
  providerGuid: string;
  keywordHex: string;
  level: number;
}): string {
  const collectorId = `EC_${opts.sessionName}`;
  const providerId = `EP_${opts.sessionName}`;
  return `<?xml version="1.0" encoding="utf-8"?>
<WindowsPerformanceRecorder Version="1.0" Author="Signalman" Company="">
  <Profiles>
    <EventCollector Id="${collectorId}" Name="${opts.sessionName}">
      <BufferSize Value="64" />
      <Buffers Value="16" />
    </EventCollector>
    <EventProvider Id="${providerId}" Name="{${opts.providerGuid}}" NonPagedMemory="true" Level="${opts.level}">
      <Keywords>
        <Keyword Value="${opts.keywordHex}" />
      </Keywords>
    </EventProvider>
    <Profile Id="${opts.sessionName}.Verbose.File" Name="${opts.sessionName}" Description="Signalman scenario ETW capture" LoggingMode="File" DetailLevel="Verbose">
      <Collectors>
        <EventCollectorId Value="${collectorId}">
          <EventProviders>
            <EventProviderId Value="${providerId}" />
          </EventProviders>
        </EventCollectorId>
      </Collectors>
    </Profile>
  </Profiles>
</WindowsPerformanceRecorder>`;
}

/**
 * Parse the PowerShell `ConvertTo-Json -Compress` output from the
 * stop-side event collection. Two shapes to handle:
 *
 *   * zero events: `@()` produces empty stdout OR `null`.
 *   * one event: produces a single object, NOT an array (PowerShell
 *     unwraps single-element pipelines by default).
 *   * many events: produces a JSON array.
 *
 * The function normalizes all three to `EtwEventSummary[]`.
 */
export function parseEventJson(stdout: string): EtwEventSummary[] {
  const text = stdout.trim();
  if (text === "" || text === "null") {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error(
      `kernel_etw_stop: failed to parse PowerShell JSON output: ${e instanceof Error ? e.message : String(e)}. ` +
        `First 200 chars: ${text.slice(0, 200)}`,
    );
  }
  const rawArray: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
  return rawArray
    .filter((v): v is Record<string, unknown> => typeof v === "object" && v !== null)
    .map(toEtwEventSummary);
}

function toEtwEventSummary(raw: Record<string, unknown>): EtwEventSummary {
  const rawProps = Array.isArray(raw.props) ? (raw.props as unknown[]) : [];
  const props: Record<string, unknown> = {};
  // Positional indices until the driver exposes field names via
  // a richer ETW manifest. Named lookup is a Phase-2 followup.
  rawProps.forEach((v, i) => {
    props[`p${i}`] = v;
  });
  return {
    name: typeof raw.name === "string" ? raw.name : "<unknown>",
    opcode: typeof raw.opcode === "number" ? raw.opcode : 0,
    level: typeof raw.level === "number" ? raw.level : 0,
    keywords: typeof raw.keywords === "string" ? raw.keywords : "0x0",
    time_created: typeof raw.time === "string" ? raw.time : undefined,
    properties: props,
  };
}

function countByName(events: EtwEventSummary[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of events) {
    out[e.name] = (out[e.name] ?? 0) + 1;
  }
  return out;
}
