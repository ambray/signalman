/**
 * Git helpers shared between the local-mode `release build` verb and
 * the remote-mode (PR 8b) runner-side build handler. Both need to
 * clone a product repo at a tag and resolve the resulting commit SHA;
 * keeping the implementation in one place avoids drift.
 *
 * No external git dependency — shells to the system `git` binary.
 *
 * Security note: `git clone` arguments are passed via `spawn` with
 * `shell: false`, so shell metacharacters are inert. But git itself
 * treats any leading-`-` positional arg as an option (e.g.
 * `--upload-pack=evil` — see CVE-2017-1000117 family). We defend in
 * two layers:
 *   1. Operator-supplied values are validated at intake (HTTP layer)
 *      via `validateRepoUrl` / `validateGitRef` below.
 *   2. Every git invocation here passes `--` before positional args
 *      so leading-`-` values are unambiguously positional, not
 *      options.
 */

import * as cp from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(cp.exec);

export interface CloneInput {
  repoUrl: string;
  tag: string;
  destDir: string;
  out: NodeJS.WritableStream;
  /** Label for log lines (e.g. "release build" vs "release build --remote"). */
  logPrefix?: string;
}

export async function cloneProductAtTag(input: CloneInput): Promise<void> {
  // Defense-in-depth: the HTTP intake layer already validates these,
  // but local-mode callers (the `release build` verb) skip that path,
  // so we re-validate at every git-spawn site.
  validateRepoUrl(input.repoUrl);
  validateGitRef(input.tag);
  const prefix = input.logPrefix ?? "release build";
  input.out.write(
    `[${prefix}] cloning ${input.repoUrl} @ ${input.tag} into ${input.destDir}\n`,
  );
  // --depth 1 + --branch <tag> is the cheapest checkout that still
  // lets `git rev-parse HEAD` work in the destination. The `--`
  // separator guarantees `repoUrl` and `destDir` can never be parsed
  // as options even if validation is bypassed upstream.
  await spawnGit(
    [
      "clone",
      "--depth",
      "1",
      "--branch",
      input.tag,
      "--",
      input.repoUrl,
      input.destDir,
    ],
    process.cwd(),
    input.out,
  );
}

/**
 * Validate a product `repo_url`. Accepts the common transports:
 *   - `https://host/path...`
 *   - `http://host/path...` (operator's choice; allowed for local registries)
 *   - `git@host:path...` (SCP-style SSH)
 *   - `ssh://[user@]host[:port]/path...`
 *   - `git://host/path...`
 *   - `file:///abs/path`
 *   - bare absolute local paths (`/abs/path` on POSIX, `C:\path` /
 *     `\\server\share\path` on Windows) — git accepts these natively
 *     as clone sources and they're useful for tests + offline mirrors.
 *
 * Rejects: leading `-` (option injection), control characters, NUL,
 * and anything that doesn't match one of the recognized shapes above.
 * The goal is "no leading-`-` and no obviously-bogus input", not
 * RFC-3986 strict parsing.
 *
 * Throws `RepoUrlValidationError` on rejection.
 */
export function validateRepoUrl(repoUrl: string): void {
  if (typeof repoUrl !== "string" || repoUrl.length === 0) {
    throw new RepoUrlValidationError("repo_url must be a non-empty string");
  }
  if (repoUrl.length > 2048) {
    throw new RepoUrlValidationError("repo_url too long (max 2048 chars)");
  }
  if (repoUrl.startsWith("-")) {
    throw new RepoUrlValidationError(
      "repo_url may not start with '-' (option-injection guard)",
    );
  }
  // Reject control characters and embedded whitespace that could end
  // up confusing downstream tooling (logs, scripts, git itself).
  // eslint-disable-next-line no-control-regex -- intentional: rejecting these
  if (/[\x00-\x1f\x7f]/.test(repoUrl)) {
    throw new RepoUrlValidationError(
      "repo_url contains control characters",
    );
  }
  // Pin to a known set of transports + local-path shapes. If the
  // operator needs a custom protocol they can adjust this list; it's
  // not security-critical beyond the leading-`-` check, but a closed
  // allowlist limits the blast radius of future git CVEs in obscure
  // transports.
  const ok =
    /^https?:\/\//i.test(repoUrl) ||
    /^ssh:\/\//i.test(repoUrl) ||
    /^git:\/\//i.test(repoUrl) ||
    /^file:\/\//i.test(repoUrl) ||
    // SCP-style: user@host:path (no `://`).
    /^[\w.+-]+@[\w.-]+:[^\s]+$/.test(repoUrl) ||
    // POSIX absolute path: `/abs/path`.
    /^\/[^\s]*$/.test(repoUrl) ||
    // Windows drive-letter path: `C:\path` or `C:/path`.
    /^[A-Za-z]:[\\/][^\s]*$/.test(repoUrl) ||
    // Windows UNC path: `\\server\share\path`.
    /^\\\\[^\s\\]+\\[^\s]+$/.test(repoUrl);
  if (!ok) {
    throw new RepoUrlValidationError(
      `repo_url must be http(s)://, ssh://, git://, file://, user@host:path, or an absolute local path; got '${repoUrl}'`,
    );
  }
}

/**
 * Validate a git ref (branch / tag) for use as a `--branch <ref>`
 * argument. Pulled from `git check-ref-format` rules (see git docs);
 * we don't implement every rule — just enough to refuse option
 * injection and the most common malformed-ref cases.
 *
 * Throws `GitRefValidationError` on rejection.
 */
export function validateGitRef(ref: string): void {
  if (typeof ref !== "string" || ref.length === 0) {
    throw new GitRefValidationError("git ref must be a non-empty string");
  }
  if (ref.length > 255) {
    throw new GitRefValidationError("git ref too long (max 255 chars)");
  }
  if (ref.startsWith("-")) {
    throw new GitRefValidationError(
      "git ref may not start with '-' (option-injection guard)",
    );
  }
  // git check-ref-format forbids these patterns:
  //   * `..` anywhere
  //   * control chars, space, `~`, `^`, `:`, `?`, `*`, `[`, `\`
  //   * leading or trailing `/`, `.lock` suffix, `@{`
  if (
    ref.includes("..") ||
    // eslint-disable-next-line no-control-regex -- intentional: rejecting these
    /[\x00-\x20~^:?*[\\\x7f]/.test(ref) ||
    ref.startsWith("/") ||
    ref.endsWith("/") ||
    ref.endsWith(".lock") ||
    ref.includes("@{")
  ) {
    throw new GitRefValidationError(
      `git ref contains forbidden character/sequence: '${ref}'`,
    );
  }
}

export class RepoUrlValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RepoUrlValidationError";
  }
}

export class GitRefValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitRefValidationError";
  }
}

export async function resolveCommitSha(workDir: string): Promise<string> {
  const { stdout } = await exec("git rev-parse HEAD", { cwd: workDir });
  return stdout.trim();
}

function spawnGit(
  args: string[],
  cwd: string,
  out: NodeJS.WritableStream,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = cp.spawn("git", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
    child.stdout.on("data", (chunk) => out.write(chunk));
    child.stderr.on("data", (chunk) => out.write(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`git ${args.join(" ")} exited with code ${code}`));
    });
  });
}
