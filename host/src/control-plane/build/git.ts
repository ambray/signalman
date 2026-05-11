/**
 * Git helpers shared between the local-mode `release build` verb and
 * the remote-mode (PR 8b) runner-side build handler. Both need to
 * clone a product repo at a tag and resolve the resulting commit SHA;
 * keeping the implementation in one place avoids drift.
 *
 * No external git dependency — shells to the system `git` binary.
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
  const prefix = input.logPrefix ?? "release build";
  input.out.write(
    `[${prefix}] cloning ${input.repoUrl} @ ${input.tag} into ${input.destDir}\n`,
  );
  // --depth 1 + --branch <tag> is the cheapest checkout that still
  // lets `git rev-parse HEAD` work in the destination. We accept that
  // a follow-up build cannot inspect history beyond the tag.
  await spawnGit(
    [
      "clone",
      "--depth",
      "1",
      "--branch",
      input.tag,
      input.repoUrl,
      input.destDir,
    ],
    process.cwd(),
    input.out,
  );
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
