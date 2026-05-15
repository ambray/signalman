/**
 * Worker loop for `signalman runner start`. Polls the control plane
 * for jobs, dispatches by kind, posts results back.
 *
 * v0.3.0 ships two job kinds:
 *   * `noop` — sleeps `input.duration_ms` (default 10ms) and reports
 *     success. Useful for smoke-testing the queue end-to-end.
 *   * `release.build` — PR 8b: clones the product repo at the tag,
 *     runs the build executor against an HTTP-backed ControlPlane
 *     (artifacts upload via POST /v1/blobs, release/artifact rows
 *     mutate via the REST API), reports the resulting release/manifest
 *     summary.
 *
 * The loop is stoppable via a `signal` (AbortSignal). Test harnesses
 * use this; the CLI maps SIGINT/SIGTERM into the abort.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { HttpClient, HttpClientError } from "./client.js";
import { HttpControlPlane } from "./http-control-plane.js";
import {
  cloneProductAtTag,
  resolveCommitSha,
} from "../control-plane/build/git.js";
import { runBuild } from "../control-plane/build/executor.js";
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
  /**
   * WS6 M3 — heartbeat cadence in ms. Default 30000 (30s). Set to 0
   * to disable heartbeats (legacy tests, single-shot CLI flows). The
   * control plane's `runner list` flags rows as stale at
   * `last_seen_at + 90s` by default; cadences above ~60s will flap
   * the staleness indicator under operator observation.
   */
  heartbeatIntervalMs?: number;
  /**
   * WS6 M3 — optional diagnostic metadata posted with each heartbeat
   * (hostname, version, etc). Surfaces in `signalman runner list`.
   */
  heartbeatMeta?: Record<string, unknown>;
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
  const heartbeatInterval = opts.heartbeatIntervalMs ?? 30_000;
  const handlers =
    opts.handlers ??
    defaultHandlers({
      client: opts.client,
      out: opts.out,
      runnerId: opts.workerName,
    });
  out.write(`[runner] starting worker '${opts.workerName}' against ${opts.client["baseUrl" as keyof HttpClient] ?? "<base>"}\n`);

  // WS6 M3 — heartbeat loop. Runs in parallel with the job-claim
  // loop so a long-running job (release.build clones + builds; can
  // exceed the staleness threshold) doesn't make the worker appear
  // dead to `signalman runner list`. Both loops respect the same
  // AbortSignal.
  const heartbeatPromise =
    heartbeatInterval > 0
      ? runHeartbeatLoop({
          client: opts.client,
          workerName: opts.workerName,
          intervalMs: heartbeatInterval,
          meta: opts.heartbeatMeta,
          signal: opts.signal,
          out,
        })
      : Promise.resolve();

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

  // Wait for the heartbeat loop to finish unwinding before declaring
  // the worker stopped. Aborting the signal triggers both loops to
  // exit; the await here just makes sure we don't leak a pending
  // timer past the function's return.
  await heartbeatPromise;

  out.write(`[runner] worker '${opts.workerName}' stopped\n`);
}

interface HeartbeatLoopOptions {
  client: HttpClient;
  workerName: string;
  intervalMs: number;
  meta?: Record<string, unknown>;
  signal: AbortSignal;
  out: NodeJS.WritableStream;
}

async function runHeartbeatLoop(opts: HeartbeatLoopOptions): Promise<void> {
  // Fire one heartbeat immediately on startup so the worker appears
  // in `runner list` without waiting `intervalMs` for the first
  // tick. Subsequent ticks fire on the configured interval until
  // the signal aborts.
  while (!opts.signal.aborted) {
    try {
      await opts.client.postRunnerHeartbeat(opts.workerName, opts.meta);
    } catch (err) {
      // Heartbeat failures are surfaced but don't kill the loop —
      // they're typically transient (network glitch, control-plane
      // restart). The next tick retries.
      opts.out.write(
        `[runner] heartbeat failed: ${(err as Error).message}\n`,
      );
    }
    if (opts.signal.aborted) break;
    await sleep(opts.intervalMs, opts.signal);
  }
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

export interface DefaultHandlersOptions {
  /** HTTP client backing the HttpControlPlane for release.build jobs. */
  client: HttpClient;
  /** Logging sink for build progress. Default: process.stderr. */
  out?: NodeJS.WritableStream;
  /** Audit-log actor. Default: 'remote-runner'. */
  actor?: string;
  /** Runner identity stamped on the release row. Default: workerName. */
  runnerId?: string;
}

export function defaultHandlers(
  opts?: DefaultHandlersOptions,
): Record<string, JobHandler> {
  return {
    noop: async (job) => {
      const duration =
        typeof job.input.duration_ms === "number" && job.input.duration_ms > 0
          ? job.input.duration_ms
          : 10;
      await new Promise((r) => setTimeout(r, duration));
      return { result: { ok: true, slept_ms: duration } };
    },
    "release.build": async (job) => {
      if (!opts) {
        // Callers that construct defaultHandlers() with no arguments
        // (legacy tests, mostly) get a fail-fast for release.build
        // since we can't reach the control plane.
        throw new JobFailedError(
          "release.build handler requires defaultHandlers({ client, ... }) — register the runner first",
        );
      }
      return executeReleaseBuild(job, opts);
    },
  };
}

/**
 * Run a `release.build` job end-to-end against the remote control
 * plane: resolve product → clone repo → resolveCommitSha → runBuild
 * against an HttpControlPlane. The release executor takes care of
 * the entire build/manifest/artifact-upload flow; on this side we
 * just translate inputs and clean up the working tree.
 */
async function executeReleaseBuild(
  job: Job,
  opts: DefaultHandlersOptions,
): Promise<{ result?: Record<string, unknown> }> {
  const productId =
    typeof job.input.product_id === "string" ? job.input.product_id : null;
  const tag = typeof job.input.tag === "string" ? job.input.tag : null;
  if (!productId || !tag) {
    throw new JobFailedError(
      `release.build job ${job.id} missing required input.product_id / input.tag`,
    );
  }
  const out = opts.out ?? process.stderr;
  const httpCp = new HttpControlPlane(opts.client);

  const product = await httpCp.products.get(productId);
  if (!product) {
    throw new JobFailedError(
      `release.build: product ${productId} not found on control plane`,
    );
  }

  const tmp = await fs.mkdtemp(
    path.join(os.tmpdir(), "signalman-remote-build-"),
  );
  try {
    await cloneProductAtTag({
      repoUrl: product.repoUrl,
      tag,
      destDir: tmp,
      out,
      logPrefix: "release build --remote",
    });
    const commitSha = await resolveCommitSha(tmp);

    const result = await runBuild({
      controlPlane: httpCp,
      orgId: product.orgId,
      productId: product.id,
      tag,
      commitSha,
      workDir: tmp,
      runnerId: opts.runnerId,
      actor: opts.actor ?? "remote-runner",
      out,
    });

    return {
      result: {
        release_id: result.release.id,
        tag: result.release.tag,
        manifest_sha256: result.manifestSha256,
        artifact_count: result.artifacts.length,
      },
    };
  } finally {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  }
}

// Re-export for downstream callers (tests, CLI).
export { HttpClient, HttpClientError };
