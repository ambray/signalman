/**
 * v0.5 Win11 M2 — IANA -> Microsoft TimeZone display-name lookup.
 *
 * Microsoft's Unattended.xml `<TimeZone>` element expects the
 * display-name form ("Pacific Standard Time"), NOT IANA
 * ("America/Los_Angeles"). Operators are accustomed to IANA; we
 * accept both forms on the CLI and translate IANA -> MS via a
 * static lookup table.
 *
 * M0 Q8 locked default (2026-05-17): static lookup table covering
 * the ~30 most-common zones plus pass-through for any already-
 * Microsoft display name. Unmapped IANA names raise an explicit
 * error with the list of supported aliases.
 *
 * Coverage choice: the table covers the IANA names every CI mirror
 * cares about (UTC, Etc/UTC, all North-America zones, all Europe
 * majors, all Asia/Pacific majors). If you need a zone we don't
 * cover, either:
 *   1. Pass the Microsoft display name directly on `--timezone`.
 *   2. Add a row to {@link IANA_TO_MS_TIMEZONE} in this file +
 *      bump the test.
 *
 * The MS display-name form is stable across Windows releases; the
 * mapping below is from the Windows Time Zone Index Values table
 * (Microsoft KB 4093601, current as of Win11 23H2).
 */

/**
 * IANA timezone name -> Microsoft display-name form. Lookup is
 * case-sensitive — IANA names are mixed-case canonical.
 */
export const IANA_TO_MS_TIMEZONE: Readonly<Record<string, string>> = {
  // UTC family.
  UTC: "UTC",
  "Etc/UTC": "UTC",
  "Etc/GMT": "UTC",

  // North America.
  "America/Adak": "Aleutian Standard Time",
  "America/Anchorage": "Alaskan Standard Time",
  "America/Los_Angeles": "Pacific Standard Time",
  "America/Vancouver": "Pacific Standard Time",
  "America/Tijuana": "Pacific Standard Time (Mexico)",
  "America/Phoenix": "US Mountain Standard Time",
  "America/Denver": "Mountain Standard Time",
  "America/Edmonton": "Mountain Standard Time",
  "America/Chicago": "Central Standard Time",
  "America/Mexico_City": "Central Standard Time (Mexico)",
  "America/Winnipeg": "Central Standard Time",
  "America/New_York": "Eastern Standard Time",
  "America/Toronto": "Eastern Standard Time",
  "America/Halifax": "Atlantic Standard Time",
  "America/St_Johns": "Newfoundland Standard Time",
  "America/Sao_Paulo": "E. South America Standard Time",

  // Europe.
  "Europe/London": "GMT Standard Time",
  "Europe/Dublin": "GMT Standard Time",
  "Europe/Lisbon": "GMT Standard Time",
  "Europe/Paris": "Romance Standard Time",
  "Europe/Madrid": "Romance Standard Time",
  "Europe/Berlin": "W. Europe Standard Time",
  "Europe/Zurich": "W. Europe Standard Time",
  "Europe/Amsterdam": "W. Europe Standard Time",
  "Europe/Rome": "W. Europe Standard Time",
  "Europe/Vienna": "W. Europe Standard Time",
  "Europe/Warsaw": "Central European Standard Time",
  "Europe/Prague": "Central Europe Standard Time",
  "Europe/Athens": "GTB Standard Time",
  "Europe/Helsinki": "FLE Standard Time",
  "Europe/Istanbul": "Turkey Standard Time",
  "Europe/Moscow": "Russian Standard Time",
  "Europe/Kiev": "FLE Standard Time",

  // Asia / Pacific.
  "Asia/Dubai": "Arabian Standard Time",
  "Asia/Karachi": "Pakistan Standard Time",
  "Asia/Kolkata": "India Standard Time",
  "Asia/Calcutta": "India Standard Time",
  "Asia/Bangkok": "SE Asia Standard Time",
  "Asia/Shanghai": "China Standard Time",
  "Asia/Hong_Kong": "China Standard Time",
  "Asia/Singapore": "Singapore Standard Time",
  "Asia/Tokyo": "Tokyo Standard Time",
  "Asia/Seoul": "Korea Standard Time",
  "Australia/Sydney": "AUS Eastern Standard Time",
  "Australia/Melbourne": "AUS Eastern Standard Time",
  "Australia/Perth": "W. Australia Standard Time",
  "Pacific/Auckland": "New Zealand Standard Time",
};

/**
 * Known set of Microsoft display-name values. Pass-through (i.e.
 * the operator supplied a MS display name directly) is allowed iff
 * the value is one of these. We don't fuzzy-match — typos go to
 * the unsupported-error path so the operator hears about them.
 *
 * Derived from {@link IANA_TO_MS_TIMEZONE}'s values (deduped).
 */
export const MS_TIMEZONE_NAMES: ReadonlySet<string> = new Set(
  Object.values(IANA_TO_MS_TIMEZONE),
);

/**
 * Translate an IANA or Microsoft display-name timezone to the
 * Microsoft display-name form required by Unattended.xml.
 *
 * Throws an explicit error (with the closest known aliases hinted)
 * if the input matches neither table.
 */
export function resolveTimeZoneForUnattended(name: string): string {
  if (typeof name !== "string" || name.length === 0) {
    throw new Error(
      `resolveTimeZoneForUnattended: timezone must be a non-empty string`,
    );
  }
  // Fast path: already an MS display name.
  if (MS_TIMEZONE_NAMES.has(name)) return name;
  // Translate IANA -> MS.
  const mapped = IANA_TO_MS_TIMEZONE[name];
  if (mapped !== undefined) return mapped;
  // Unmapped — surface a helpful error.
  const sampleIana = [
    "UTC",
    "America/Los_Angeles",
    "America/New_York",
    "Europe/London",
    "Europe/Berlin",
    "Asia/Tokyo",
    "Australia/Sydney",
  ].join(", ");
  throw new Error(
    `Unsupported timezone '${name}'. Pass either a Microsoft display ` +
      `name (e.g. 'Pacific Standard Time', 'UTC') or one of the ` +
      `supported IANA names. Common IANA examples: ${sampleIana}. ` +
      `If you need an unmapped zone, add it to ` +
      `host/src/provisioning/unattended-timezone.ts and re-run.`,
  );
}
