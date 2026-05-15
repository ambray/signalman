/**
 * Small helpers used by host/src/server.ts that benefit from direct
 * unit testing.
 *
 * server.ts itself is excluded from the coverage denominator (per
 * vitest.config.ts). Anything in server.ts that carries non-trivial
 * logic — input mutual exclusion, envelope shaping, etc. — gets
 * factored here so the test suite can exercise it directly.
 */

import * as fsp from "node:fs/promises";
import * as path from "node:path";

/**
 * Resolve a public-key input where the caller may supply EXACTLY one
 * of:
 *   - `pathInput` — filesystem path to a PEM (resolved relative to
 *     process.cwd()), or
 *   - `pemInput` — the PEM text inline.
 *
 * Used by `signalman_release_verify` and `signalman_key_fingerprint`
 * (and any future MCP tool that accepts a public key from either
 * surface). The two surfaces correspond to "local/self-hosted host"
 * (path) vs. "hosted/remote agent" (inline PEM).
 *
 * @throws if both inputs are provided, or if neither is.
 * @throws if `pathInput` resolves to a file the host can't read.
 */
export async function resolvePemInput(
  pathInput: string | undefined,
  pemInput: string | undefined,
  fieldNameForError: string,
): Promise<string> {
  if (pathInput && pemInput) {
    throw new Error(
      `${fieldNameForError}: provide exactly one of public_key_path or public_key_pem (got both)`,
    );
  }
  if (!pathInput && !pemInput) {
    throw new Error(
      `${fieldNameForError}: provide exactly one of public_key_path or public_key_pem (got neither)`,
    );
  }
  if (pemInput) return pemInput;
  return await fsp.readFile(path.resolve(pathInput!), "utf-8");
}
