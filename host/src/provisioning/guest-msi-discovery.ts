/**
 * Guest MSI discovery (P9.1).
 *
 * The MSI for the Windows guest agent can come from one of three
 * sources, in priority order:
 *
 *   1. `--guest-msi <PATH>` - explicit override from CLI / MCP input.
 *   2. `dist/guest/*.msi` - bundled with the installed host package.
 *   3. GitHub Releases matching `signalman --version` - fetched on demand.
 *
 * If none of the three sources yields an MSI, the function HARD-FAILS
 * with a multi-line error message that names every location searched
 * and gives concrete remediation steps. The error is intentionally
 * verbose so that an LLM agent calling `vm_provision` through MCP can
 * read the message and tell the user exactly what to do.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_RELEASE_REPO = "ambray/signalman";

// Types

export interface GuestMsiSource {
  /** How the MSI was located. */
  kind: "explicit" | "bundled" | "github_release";
  /** Absolute path to the MSI on disk. */
  path: string;
}

export interface DiscoverGuestMsiOptions {
  /**
   * GitHub owner/repo used for release lookup. Defaults to the canonical
   * repository; tests may override this to keep URLs stable.
   */
  releaseRepo?: string;
  /** Release tag to resolve. Defaults to `v<host package version>`. */
  releaseTag?: string;
  /** Cache root for downloaded release assets. */
  cacheDir?: string;
  /** Fetch implementation. Injectable so unit tests never touch the network. */
  fetchImpl?: typeof fetch;
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

// Discovery

/**
 * Find the bundled MSI dir relative to the installed host package.
 *
 * Layout assumption: when the host package is installed via npm, the
 * compiled CLI lives at `<pkg>/dist/cli.js`. We resolve `dist/guest/`
 * relative to that. In dev (running from source) the path resolves
 * to `host/dist/guest/` which usually doesn't exist - discovery falls
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

function hostPackageVersion(): string {
  const here = fileURLToPath(import.meta.url);
  const packageJsonPath = path.resolve(path.dirname(here), "..", "..", "package.json");
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as {
    version?: unknown;
  };
  if (typeof packageJson.version !== "string" || packageJson.version.length === 0) {
    throw new Error(`host package.json is missing a string version`);
  }
  return packageJson.version;
}

function defaultCacheDir(): string {
  const localAppData = process.env.LOCALAPPDATA;
  if (process.platform === "win32" && localAppData) {
    return path.join(localAppData, "Signalman", "guest-msi");
  }
  return path.join(os.homedir(), ".cache", "signalman", "guest-msi");
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

interface GithubReleaseAsset {
  name?: unknown;
  browser_download_url?: unknown;
}

interface GithubReleaseResponse {
  assets?: unknown;
}

function safeAssetFileName(name: string): string {
  const base = path.basename(name);
  if (!base.toLowerCase().endsWith(".msi")) {
    throw new Error(`release asset does not end in .msi: ${name}`);
  }
  return base;
}

function selectGuestMsiAsset(assets: GithubReleaseAsset[]): GithubReleaseAsset | null {
  const namedGuestMsi = assets.find(
    (asset) =>
      typeof asset.name === "string" &&
      /^signalman-guest.*\.msi$/i.test(asset.name) &&
      typeof asset.browser_download_url === "string",
  );
  if (namedGuestMsi) return namedGuestMsi;

  return (
    assets.find(
      (asset) =>
        typeof asset.name === "string" &&
        asset.name.toLowerCase().endsWith(".msi") &&
        typeof asset.browser_download_url === "string",
    ) ?? null
  );
}

async function discoverGithubReleaseMsi(opts: {
  releaseRepo: string;
  releaseTag: string;
  cacheDir: string;
  fetchImpl: typeof fetch;
}): Promise<GuestMsiSource> {
  const cacheTagDir = path.join(opts.cacheDir, opts.releaseTag);
  const cached = findFirstMsiInDir(cacheTagDir);
  if (cached) {
    return { kind: "github_release", path: cached };
  }

  const releaseUrl = `https://api.github.com/repos/${opts.releaseRepo}/releases/tags/${encodeURIComponent(
    opts.releaseTag,
  )}`;
  const releaseResponse = await opts.fetchImpl(releaseUrl, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "signalman-host",
    },
  });
  if (!releaseResponse.ok) {
    throw new Error(
      `GitHub API returned ${releaseResponse.status} ${releaseResponse.statusText}`.trim(),
    );
  }

  const release = (await releaseResponse.json()) as GithubReleaseResponse;
  const assets = Array.isArray(release.assets)
    ? (release.assets as GithubReleaseAsset[])
    : [];
  const asset = selectGuestMsiAsset(assets);
  if (!asset || typeof asset.name !== "string" || typeof asset.browser_download_url !== "string") {
    throw new Error(`release ${opts.releaseTag} has no signalman guest MSI asset`);
  }

  const fileName = safeAssetFileName(asset.name);
  const downloadResponse = await opts.fetchImpl(asset.browser_download_url, {
    headers: {
      Accept: "application/octet-stream",
      "User-Agent": "signalman-host",
    },
  });
  if (!downloadResponse.ok) {
    throw new Error(
      `GitHub asset download returned ${downloadResponse.status} ${downloadResponse.statusText}`.trim(),
    );
  }

  fs.mkdirSync(cacheTagDir, { recursive: true });
  const dest = path.join(cacheTagDir, fileName);
  const bytes = Buffer.from(await downloadResponse.arrayBuffer());
  fs.writeFileSync(dest, bytes);
  return { kind: "github_release", path: dest };
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
  options: DiscoverGuestMsiOptions = {},
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

  // Source 3: GitHub Releases for the matching host package version.
  const releaseRepo = options.releaseRepo ?? DEFAULT_RELEASE_REPO;
  const releaseTag = options.releaseTag ?? `v${hostPackageVersion()}`;
  const cacheDir = options.cacheDir ?? defaultCacheDir();
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const releasePageUrl = `https://github.com/${releaseRepo}/releases/tag/${encodeURIComponent(
    releaseTag,
  )}`;
  searched.push(`github_release: ${releasePageUrl}`);
  searched.push(`github_release_cache: ${path.join(cacheDir, releaseTag)}`);

  try {
    return await discoverGithubReleaseMsi({
      releaseRepo,
      releaseTag,
      cacheDir,
      fetchImpl,
    });
  } catch (err) {
    searched.push(
      `github_release error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

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
        `Or publish \`signalman-guest-*.msi\` on the matching GitHub Release (${releaseTag}) so Signalman can download and cache it automatically.`,
      ],
    },
  );
}
