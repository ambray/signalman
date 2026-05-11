/**
 * Worker loop for `signalman runner start`. Polls the control plane
 * for jobs, dispatches by kind, posts results back.
 *
 * v0.3.0 (PR 8a) ships two job kinds:
 *   * `noop` — sleeps `input.duration_ms` (default 10ms) and reports
 *     success. Useful for smoke-testing the queue end-to-end.
 *   * `release.build` — currently marked failed with "remote build
 *     execution lands in PR 8b". The runner-side build executor needs
 *     an HTTP-backed ControlPlane subset (blob upload, release row
 *     mutation) which is its own PR.
 *
 * The loop is stoppable via a `signal` (AbortSignal). Test harnesses
 * use this; the CLI maps SIGINT/SIGTERM into the abort.
 */

import { HttpClient, HttpClientError } from "./client.js";
import type { Job } from "../control-plane/types.js";

export interface WorkerOptions {
  client: HttpClient;
  workerName: string;
  /** Default 1000ms. */
  pollIntervalMs?: number;
  signal: AbortSignal;
  /** Optional progress sink. Default: process.stderr. */
  out?: NodeJS.WritableStream;
  /**
   * Optional custom handler map (tests). Default uses the built-in
   * `noop` + `release.build` handlers.
   */
  handlers?: Record<string, JobHandler>;
}

export interface JobHandler {
  (job: Job): Promise<{ result?: Record<string, unknown> }>;
}

export class JobFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JobFailedError";
  }
}

export async function runWorker(opts: WorkerOptions): Promise<void> {
  const out = opts.out ?? process.stderr;
  const pollInterval = opts.pollIntervalMs ?? 1_000;
  const handlers = opts.handlers ?? defaultHandlers();
  out.write(`[runner] starting worker '${opts.workerName}' against ${opts.client["baseUrl" as keyof HttpClient] ?? "<base>"}\n`);

  while (!opts.signal.aborted) {
    let job: Job | null = null;
    try {
      job = await opts.client.claimJob(opts.workerName);
    } catch (err) {
      out.write(`[runner] claim failed: ${(err as Error).message}\n`);
      await sleep(pollInterval, opts.signal);
      continue;
    }

    if (!job) {
      await sleep(pollInterval, opts.signal);
      continue;
    }

    out.write(`[runner] claimed job ${job.id} (kind=${job.kind})\n`);
    try {
      await opts.client.setJobRunning(job.id);
    } catch (err) {
      out.write(
        `[runner] failed to mark job ${job.id} running: ${(err as Error).message}\n`,
      );
      // Don't bother continuing — the control plane is unreachable.
      continue;
    }

    const handler = handlers[job.kind];
    if (!handler) {
      const msg = `no handler registered for job kind '${job.kind}'`;
      out.write(`[runner]   → ${msg}\n`);
      await safeFail(opts.client, job, msg, out);
      continue;
    }

    try {
      const { result } = await handler(job);
      await opts.client.completeJob(job.id, result);
      out.write(`[runner]   → completed ${job.id}\n`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      out.write(`[runner]   → failed ${job.id}: ${msg}\n`);
      await safeFail(opts.client, job, msg, out);
    }
  }

  out.write(`[runner] worker '${opts.workerName}' stopped\n`);
}

async function safeFail(
  client: HttpClient,
  job: Job,
  error: string,
  out: NodeJS.WritableStream,
): Promise<void> {
  try {
    await client.failJob(job.id, error);
  } catch (failErr) {
    out.write(
      `[runner] couldn't report failure for ${job.id}: ${(failErr as Error).message}\n`,
    );
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      signal.removeEventListener("abort", onAbort);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

// ── Built-in handlers ───────────────────────────────────────────────

export function defaultHandlers(): Record<string, JobHandler> {
  return {
    noop: async (job) => {
      const duration =
        typeof job.input.duration_ms === "number" && job.input.duration_ms > 0
          ? job.input.duration_ms
          : 10;
      await new Promise((r) => setTimeout(r, duration));
      return { result: { ok: true, slept_ms: duration } };
    },
    "release.build": async (_job) => {
      // PR 8b will land the HTTP-backed ControlPlane subset + the
      // remote build executor that clones, builds, and uploads
      // artifacts via the control-plane API. Until then, signal
      // intent clearly to the operator.
      throw new JobFailedError(
        "remote 'release.build' execution lands in PR 8b — for now run `signalman release build` without --remote",
      );
    },
  };
}

// Re-export for downstream callers (tests, CLI).
export { HttpClient, HttpClientError };
