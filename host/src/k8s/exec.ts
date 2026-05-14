/**
 * Default exec for the kubectl + helm drivers (v0.3.0-6 sub-task 1).
 *
 * Mirrors `cloud/tofu.ts`'s defaultExec: wraps `node:child_process
 * .execFile`, returns the canned `{stdout, stderr, exitCode}` shape
 * the drivers expect, and re-throws `ENOENT` so callers can convert
 * it into the right structured error code (`kubectl_not_found` /
 * `helm_not_found`).
 *
 * Tests do not import this — they pass an injected `K8sExec`
 * directly into the driver constructor.
 */

import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";

import type { K8sExec, K8sExecResult } from "./types.js";

const execFile = promisify(execFileCb);

/**
 * Build a default exec that spawns `bin` (the kubectl / helm
 * binary), passes args + env, and translates execFile rejections
 * into the shared `{stdout, stderr, exitCode}` shape. `ENOENT` is
 * re-thrown so the driver can convert it into `*_not_found`.
 */
export function makeDefaultExec(): K8sExec {
  return async (bin, args, opts): Promise<K8sExecResult> => {
    try {
      const { stdout, stderr } = await execFile(bin, args, {
        cwd: opts.cwd,
        timeout: opts.timeoutMs,
        env: { ...process.env, ...opts.env },
        maxBuffer: 50 * 1024 * 1024,
      });
      return { stdout, stderr, exitCode: 0 };
    } catch (err) {
      const e = err as {
        code?: number | string;
        stdout?: string;
        stderr?: string;
      };
      if (typeof e.code === "string") {
        // ENOENT / spawn failures: re-throw so the driver's
        // *_not_found detection can match on the string code.
        throw err;
      }
      return {
        stdout: e.stdout ?? "",
        stderr: e.stderr ?? "",
        exitCode: typeof e.code === "number" ? e.code : 1,
      };
    }
  };
}
