/**
 * Guest MSI discovery (P9.1).
 *
 * The MSI for the Windows guest agent can come from one of three
 * sources, in priority order:
 *
 *   1. `--guest-msi <PATH>` — explicit override from CLI / MCP input.
 *   2. `dist/guest/*.msi` — bundled with the installed host package.
 *   3. GitHub Releases matching `signalman --version` — fetched on demand.
 *
 * If none of the three sources yields an MSI, the function HARD-FAILS
 * with a multi-line error message that names every location searched
 * and gives concrete remediation steps. The error is intentionally
 * verbose so that an LLM agent calling `vm_provision` through MCP can
 * read the message and tell the user exactly what to do.
 *
 * Source 3 (GitHub fetch) is implemented as a stub here — the actual
 * HTTP fetch lands as P9.5 (agent C). When invoked, it raises a
 * recognizable `GuestMsiDiscoveryError` with `kind = "needs_p9_5"`.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// ── Types ─────────────────────────────────────────────────────────

export interface GuestMsiSource {
  /** How the MSI was located. */
  kind: "explicit" | "bundled" | "github_release";
  /** Absolute path to the MSI on disk. */
  path: string;
}

/**
 * Hard-fail error class for discovery misses. Includes structured
 * context so MCP tool wrappers can build a useful error envelope
 * without re-parsing the multi-line message.
 */
export class GuestMsiDiscoveryError extends Error {
  override readonly name = "GuestMsiDiscoveryError";
  /** Where we looked, in order. Always populated. */
  readonly searched: string[];
  /** Suggested remediation steps, one per line. */
  readonly remediation: string[];

  constructor(message: string, opts: { searched: string[]; remediation: string[] }) {
    super(message);
    this.searched = opts.searched;
    this.remediation = opts.remediation;
  }
}

// ── Discovery ────────────────────────────────────────────────────

/**
 * Find the bundled MSI dir relative to the installed host package.
 *
 * Layout assumption: when the host package is installed via npm, the
 * compiled CLI lives at `<pkg>/dist/cli.js`. We resolve `dist/guest/`
 * relative to that. In dev (running from source) the path resolves
 * to `host/dist/guest/` which usually doesn't exist — discovery falls
 * through to source 3.
 */
function bundledMsiDir(): string {
  // import.meta.url points at this module's compiled location at
  // runtime: typically `<pkg>/dist/provisioning/guest-msi-discovery.js`.
  // Walk up two levels to reach `<pkg>/dist/`, then into `guest/`.
  const here = fileURLToPath(import.meta.url);
  const distDir = path.resolve(path.dirname(here), "..");
  return path.join(distDir, "guest");
}

function findFirstMsiInDir(dir: string): string | null {
  if (!fs.existsSync(dir)) return null;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) {
    if (e.isFile() && e.name.toLowerCase().endsWith(".msi")) {
      return path.join(dir, e.name);
    }
  }
  return null;
}

/**
 * Discover the guest MSI to install on a freshly-provisioned VM.
 *
 * @param explicitPath - When provided, an absolute or relative path to
 *   an MSI file. The function validates that the file exists and ends
 *   in `.msi`; otherwise it throws GuestMsiDiscoveryError immediately
 *   (with `kind = "explicit"` in the searched list).
 *
 * @returns The discovered source.
 * @throws {GuestMsiDiscoveryError} when no source yields an MSI.
 */
export async function discoverGuestMsi(
  explicitPath?: string,
): Promise<GuestMsiSource> {
  const searched: string[] = [];

  // Source 1: explicit override.
  if (explicitPath !== undefined && explicitPath !== "") {
    const abs = path.resolve(explicitPath);
    searched.push(`--guest-msi: ${abs}`);
    if (!fs.existsSync(abs)) {
      throw new GuestMsiDiscoveryError(
        `Guest MSI not found at the path supplied via --guest-msi.`,
        {
          searched,
          remediation: [
            `Verify the path exists and points to a .msi file.`,
            `Run \`signalman vm provision <name> --guest-msi <ABSOLUTE_PATH>\` again with a corrected path.`,
            `Or omit --guest-msi to fall through to bundled / GitHub Release discovery.`,
          ],
        },
      );
    }
    if (!abs.toLowerCase().endsWith(".msi")) {
      throw new GuestMsiDiscoveryError(
        `--guest-msi path does not end in .msi: ${abs}`,
        {
          searched,
          remediation: [
            `Pass a path to a Windows Installer (.msi) file.`,
            `Common build output: \`guest/target/wix/signalman-guest-*.msi\` after \`cargo wix --package signalman-guest\`.`,
          ],
        },
      );
    }
    return { kind: "explicit", path: abs };
  }

  // Source 2: bundled with the host package.
  const distDir = bundledMsiDir();
  searched.push(`bundled: ${distDir}`);
  const bundled = findFirstMsiInDir(distDir);
  if (bundled) {
    return { kind: "bundled", path: bundled };
  }

  // Source 3: GitHub Releases — deferred to P9.5 (agent C). We
  // intentionally do NOT swallow this as a soft miss; the caller asked
  // for the MSI, we know we don't have it locally, and the remediation
  // depends on whether the user has network + can wait for a download.
  searched.push(
    `github_release: https://github.com/nickthecook/signalman/releases (not yet implemented; landing in P9.5)`,
  );

  throw new GuestMsiDiscoveryError(
    [
      `No Signalman guest MSI could be located.`,
      ``,
      `Searched (in order):`,
      ...searched.map((s) => `  - ${s}`),
    ].join("\n"),
    {
      searched,
      remediation: [
        `Build the MSI from source: \`cd guest && cargo wix --package signalman-guest\`. The output lands in \`guest/target/wix/signalman-guest-*.msi\`.`,
        `Then re-run with \`signalman vm provision <name> --guest-msi <PATH>\`.`,
        `Or wait for GitHub Release fetch (P9.5) which will auto-download the matching version.`,
      ],
    },
  );
}
