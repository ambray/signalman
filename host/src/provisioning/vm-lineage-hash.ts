/**
 * vm_lineage_hash — canonical hash of an ephemeral VM's provenance
 * (v0.3.0-2 / v0.3.0-3).
 *
 * Identifies "what disk and what software" produced this VM, so the
 * scenario-run envelope can short-circuit identical inputs and the
 * downstream cloud-provider work (v0.3.0-5) has a stable identity
 * to map onto AMI IDs / Azure managed-image IDs / OCI image digests
 * without conflating them.
 *
 * # Locked design (do not re-litigate)
 *
 * - **Canonical JSON, then SHA-256.** Keys sorted lexicographically,
 *   `installed[]` sorted by `name` (stable secondary sort by
 *   `version`), no whitespace, UTF-8 bytes hashed. Two callers
 *   passing the same logical inputs in different orders must
 *   produce identical hashes.
 * - **Optional `template_version` is omitted when absent.** Not
 *   `null`, not `""`. The canonical JSON only contains keys the
 *   caller supplied so adding fields later is non-breaking.
 * - **No dedup of `installed[]`.** Caller decides. If the same
 *   bundle is recorded twice (e.g. two install actions installed
 *   it), that's the caller's truth; hashing it twice surfaces the
 *   duplicate to a downstream consumer rather than silently
 *   collapsing.
 * - **Snake-case wire shape.** The canonical JSON uses snake_case
 *   keys (`template_name`, `template_version`, `installed`) to
 *   match the rest of the YAML-shaped surface in this codebase
 *   (`base_image_path`, `base_image_sha256`). The TS interface
 *   mirrors this so there's no translation layer.
 * - **Lowercase hex output.** Matches the project's existing
 *   SHA-256 convention (template-fetch.ts `expectedSha256`,
 *   manifest signing key fingerprints).
 *
 * # Output stability promise
 *
 * Once we ship v0.3.0-2, the canonical-JSON shape and the hash for
 * any given input are frozen. Adding a new field requires shipping
 * it as `template_version`-style optional so older callers continue
 * to produce the old hash. Changing the canonicalisation rules
 * would re-key every cached scenario result; treat that as a
 * wire-breaking change.
 */

import * as crypto from "node:crypto";

// ── Types ──────────────────────────────────────────────────────────

/**
 * One installed software entry contributing to a VM's lineage.
 *
 * `name` is the bundle identifier (e.g. "powershell-7", "go-1.22");
 * `version` is whatever the bundle reports as its release tag /
 * semver / commit SHA. Both are opaque to this module — the contract
 * is "the same name+version produces the same lineage contribution".
 */
export interface InstalledEntry {
  /** Bundle / package identifier. Non-empty. */
  name: string;
  /** Bundle version string. Non-empty. */
  version: string;
}

/**
 * Inputs to {@link computeVmLineageHash} (and the JSON shape stored
 * in the result envelope).
 *
 * `templateVersion` is optional: a hand-built BYO VHDX may not have
 * a meaningful version, and we don't want to lock the schema to
 * "must supply a version even if it's a placeholder". When absent
 * the canonical JSON omits the key entirely (not `null`, not `""`).
 */
export interface VmLineageInput {
  /**
   * Template name from the resolved `VmTemplate`. Non-empty.
   * Example: `"win11-base"`, `"windows-11-eval"`.
   */
  template_name: string;
  /**
   * Template version when known. Omitted from canonical JSON when
   * absent. Example: `"22H2.2024-04"`, `"sha256:abc..."`.
   */
  template_version?: string;
  /**
   * Operating-system label. Non-empty. Example: `"windows-11"`,
   * `"ubuntu-22.04"`. Free-form string — semantic taxonomy is the
   * caller's concern. Two scenarios labelling the same OS
   * differently get different hashes.
   */
  os: string;
  /**
   * Software installed on top of the base template, in the order
   * the caller chose to record them. This module re-sorts before
   * hashing so the input order does not affect output.
   */
  installed: InstalledEntry[];
}

// ── Errors ─────────────────────────────────────────────────────────

/**
 * Structured error for invalid lineage inputs. Carries a stable
 * `code` so callers can distinguish "missing template_name" from
 * "an installed entry has an empty name" without string matching.
 */
export class VmLineageError extends Error {
  constructor(
    public readonly code:
      | "empty_template_name"
      | "empty_os"
      | "installed_empty_name"
      | "installed_empty_version",
    message: string,
  ) {
    super(message);
    this.name = "VmLineageError";
  }
}

// ── Canonicalisation ──────────────────────────────────────────────

/**
 * Produce the canonical JSON form of a `VmLineageInput`.
 *
 * Use this for debugging, audit logs, or wire transmission. For
 * hashing, prefer {@link computeVmLineageHash} which closes over
 * this function and the SHA-256 step.
 *
 * Rules (locked, see module doc):
 *   - Keys at every level are sorted lexicographically.
 *   - `installed[]` is sorted by `name` ascending, with stable
 *     secondary sort by `version` ascending.
 *   - Optional `template_version` is omitted when absent — not
 *     written as `null` or `""`.
 *   - No whitespace. No trailing newline.
 *
 * @throws {@link VmLineageError} when validation fails.
 */
export function canonicalizeVmLineage(input: VmLineageInput): string {
  validate(input);

  // Build the canonical record. We construct the object with keys
  // in alphabetical order explicitly rather than relying on
  // JSON.stringify with a sorter — explicit construction makes the
  // contract visible in the code.
  //
  // Sort `installed[]` by name (primary), then version (secondary).
  // Slice() so we don't mutate the caller's array.
  const sortedInstalled = input.installed
    .slice()
    .sort((a, b) => {
      const byName = a.name.localeCompare(b.name);
      if (byName !== 0) return byName;
      return a.version.localeCompare(b.version);
    })
    .map((e) => ({ name: e.name, version: e.version }));

  // Build canonical record with keys in alphabetical order.
  // Critically: only include `template_version` when present so
  // adding the field later doesn't change hashes for callers that
  // don't supply it.
  const canonical: Record<string, unknown> = {
    installed: sortedInstalled,
    os: input.os,
    template_name: input.template_name,
  };
  if (typeof input.template_version === "string" && input.template_version.length > 0) {
    canonical.template_version = input.template_version;
  }

  // Re-sort the top-level keys (insertion order matters in JSON
  // stringify on V8). The previous block inserted in alphabetical
  // order already, but `template_version` would land at the end if
  // present — fix that with a final sort.
  const orderedKeys = Object.keys(canonical).sort();
  const ordered: Record<string, unknown> = {};
  for (const k of orderedKeys) {
    ordered[k] = canonical[k];
  }

  return JSON.stringify(ordered);
}

/**
 * Compute the SHA-256 hash of a VM's lineage input. Returns a
 * 64-character lowercase hex string.
 *
 * Two callers passing the same logical inputs (different orderings
 * of `installed[]`, different field-declaration order, etc.) must
 * produce identical hashes. See the canonical-JSON rules in
 * {@link canonicalizeVmLineage}.
 *
 * @throws {@link VmLineageError} when validation fails.
 */
export function computeVmLineageHash(input: VmLineageInput): string {
  const canonical = canonicalizeVmLineage(input);
  return crypto
    .createHash("sha256")
    .update(canonical, "utf8")
    .digest("hex");
}

// ── Validation ─────────────────────────────────────────────────────

function validate(input: VmLineageInput): void {
  if (!input.template_name || input.template_name.length === 0) {
    throw new VmLineageError(
      "empty_template_name",
      "template_name must be a non-empty string",
    );
  }
  if (!input.os || input.os.length === 0) {
    throw new VmLineageError(
      "empty_os",
      "os must be a non-empty string",
    );
  }
  for (let i = 0; i < input.installed.length; i++) {
    const entry = input.installed[i];
    if (!entry.name || entry.name.length === 0) {
      throw new VmLineageError(
        "installed_empty_name",
        `installed[${i}].name must be a non-empty string`,
      );
    }
    if (!entry.version || entry.version.length === 0) {
      throw new VmLineageError(
        "installed_empty_version",
        `installed[${i}].version must be a non-empty string`,
      );
    }
  }
}
