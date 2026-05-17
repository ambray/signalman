/**
 * Single source of truth for the host package version.
 *
 * Reads `host/package.json` once at module init. Both
 * `host/src/cli.ts` (`signalman --version`) and
 * `host/src/http/app.ts` (`/v1/healthz` `version` field) consume
 * this so a release pipeline only has to bump `package.json` for
 * both surfaces to update in lockstep.
 *
 * Resolution path: `package.json` is at the host package root, one
 * level above this module whether it's executed from `src/` (dev)
 * or `dist/` (built). `new URL("../package.json", import.meta.url)`
 * works from both.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

function readVersionFromPackageJson(): string {
  const pkgPath = fileURLToPath(new URL("../package.json", import.meta.url));
  const raw = readFileSync(pkgPath, "utf8");
  const parsed = JSON.parse(raw) as { version?: unknown };
  if (typeof parsed.version !== "string" || parsed.version.length === 0) {
    throw new Error(
      `host/package.json missing or empty "version" field (path: ${pkgPath})`,
    );
  }
  return parsed.version;
}

/** Host package version, loaded once at module init. */
export const VERSION: string = readVersionFromPackageJson();

/**
 * Compose the line printed by `signalman --version`.
 *
 * Exported so unit tests can pin the exact shape without
 * invoking the CLI. The format is intentionally plain
 * (`signalman <version>\n`) — most tooling that parses
 * `--version` output expects `<name> <version>` on one line.
 */
export function versionLine(version: string = VERSION): string {
  return `signalman ${version}\n`;
}
