/**
 * v0.5 Win11 M2 — NetBIOS-15 ComputerName transliteration.
 *
 * Windows ComputerName has a hard limit of 15 NetBIOS characters
 * (ASCII alphanumerics + `-`; case-insensitive). VM names supplied
 * on the CLI may exceed that or contain disallowed characters
 * (dots, underscores, unicode); this helper transliterates them.
 *
 * M0 Q6 locked default (2026-05-17): transliterate silently —
 * truncate to 15 characters, replace any non-alphanumeric character
 * with `-`, and uppercase. The caller is responsible for logging
 * when source != result so the operator sees the rewrite.
 */

/** Hard NetBIOS ComputerName length cap. */
export const NETBIOS_MAX_LENGTH = 15;

/** Result of {@link toNetbiosComputerName}. */
export interface NetbiosComputerNameResult {
  /** The original input string (verbatim). */
  source: string;
  /** The NetBIOS-friendly result (1..15 ASCII chars). */
  result: string;
  /** True iff `source !== result` — caller should log the rewrite. */
  rewritten: boolean;
}

/**
 * Transliterate `source` to a NetBIOS-15 friendly ComputerName.
 *
 * Algorithm:
 *  1. Replace any character outside `[A-Za-z0-9]` with `-`.
 *  2. Collapse runs of consecutive `-` into a single `-`.
 *  3. Truncate to 15 characters.
 *  4. Strip leading/trailing `-` (NetBIOS allows them but they look
 *     ugly and may confuse downstream DNS).
 *  5. Reject the empty / all-`-` result with a structured Error.
 *
 * The result is NOT uppercased — Windows ComputerName is case-
 * insensitive for NetBIOS lookup but the original casing is
 * preserved in the SAM database, so we keep mixed case for
 * operator-visible names. (`Win11-Demo` reads better than
 * `WIN11-DEMO` in logs.)
 */
export function toNetbiosComputerName(
  source: string,
): NetbiosComputerNameResult {
  if (typeof source !== "string") {
    throw new TypeError(
      `toNetbiosComputerName: source must be a string (got ${typeof source})`,
    );
  }
  // Step 1: replace disallowed chars.
  let mapped = "";
  for (const ch of source) {
    if (/^[A-Za-z0-9]$/.test(ch)) {
      mapped += ch;
    } else {
      mapped += "-";
    }
  }
  // Step 2: collapse runs of `-`.
  mapped = mapped.replace(/-+/g, "-");
  // Step 3: truncate.
  if (mapped.length > NETBIOS_MAX_LENGTH) {
    mapped = mapped.slice(0, NETBIOS_MAX_LENGTH);
  }
  // Step 4: strip leading/trailing `-`.
  mapped = mapped.replace(/^-+/, "").replace(/-+$/, "");
  // Step 5: empty result is fatal — the caller passed a name that
  // had no alphanumerics at all (e.g. all dots or only Unicode).
  if (mapped.length === 0) {
    throw new Error(
      `Cannot derive a NetBIOS ComputerName from '${source}': ` +
        `the input contains no ASCII alphanumerics. ` +
        `Pass a VM name containing at least one [A-Za-z0-9] character.`,
    );
  }
  return {
    source,
    result: mapped,
    rewritten: source !== mapped,
  };
}
