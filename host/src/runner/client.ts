/**
 * Thin HTTP client for the control-plane API. Used by:
 *   * `signalman runner start` — polls /v1/jobs/claim, posts results
 *   * `signalman release build --remote` — submits jobs + follows them
 *   * Future v0.3.x: the HTTP-backed ControlPlane subset for remote
 *     build execution
 *
 * Intentionally narrow: just the calls the v0.3.0 runner + submit-mode
 * CLI need. Errors map { error: { code, message } } responses to a
 * thrown HttpClientError; non-JSON or network failures surface raw.
 */

import type { Readable } from "node:stream";
import type {
  Job,
  JobStatus,
  Product,
  Release,
  Runner,
} from "../control-plane/types.js";

export class HttpClientError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "HttpClientError";
  }
}

export interface HttpClientOptions {
  baseUrl: string;
  token?: string;
}

export class HttpClient {
  private readonly baseUrl: string;
  private readonly token: string | undefined;

  constructor(opts: HttpClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.token = opts.token;
  }

  // ── Generic verbs ─────────────────────────────────────────────────

  async get<T>(path: string): Promise<T> {
    return this.request<T>("GET", path);
  }

  async post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("POST", path, body);
  }

  async patch<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("PATCH", path, body);
  }

  async delete<T>(path: string): Promise<T> {
    return this.request<T>("DELETE", path);
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    let serialized: string | undefined;
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      serialized = JSON.stringify(body);
    }
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: serialized,
    });
    if (res.status === 204) {
      return undefined as T;
    }
    const text = await res.text();
    let parsed: unknown;
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new HttpClientError(
          res.status,
          "non_json_response",
          `non-JSON response: ${text.slice(0, 200)}`,
        );
      }
    }
    if (!res.ok) {
      const err = parsed as { error?: { code?: string; message?: string } };
      throw new HttpClientError(
        res.status,
        err?.error?.code ?? "http_error",
        err?.error?.message ?? `HTTP ${res.status}`,
      );
    }
    return parsed as T;
  }

  // ── Convenience helpers used by runner + submit-mode CLI ──────────

  async productByName(name: string): Promise<Product> {
    const { product } = await this.get<{ product: Product }>(
      `/v1/products/by-name/${encodeURIComponent(name)}`,
    );
    return product;
  }

  async submitJob(kind: string, input: Record<string, unknown>): Promise<Job> {
    const { job } = await this.post<{ job: Job }>("/v1/jobs", { kind, input });
    return job;
  }

  async getJob(id: string): Promise<Job> {
    const { job } = await this.get<{ job: Job }>(`/v1/jobs/${id}`);
    return job;
  }

  async claimJob(claimedBy: string): Promise<Job | null> {
    const r = await this.post<{ job: Job | null }>("/v1/jobs/claim", {
      claimed_by: claimedBy,
    });
    return r.job;
  }

  async completeJob(
    id: string,
    result?: Record<string, unknown>,
  ): Promise<Job> {
    const { job } = await this.post<{ job: Job }>(`/v1/jobs/${id}/complete`, {
      result,
    });
    return job;
  }

  async failJob(id: string, error: string): Promise<Job> {
    const { job } = await this.post<{ job: Job }>(`/v1/jobs/${id}/fail`, {
      error,
    });
    return job;
  }

  async setJobRunning(id: string): Promise<Job> {
    const { job } = await this.patch<{ job: Job }>(`/v1/jobs/${id}`, {
      status: "running",
      started_at: new Date().toISOString(),
    });
    return job;
  }

  /**
   * WS6 M3 — post a heartbeat for this worker. Idempotent: the
   * server upserts by (org_id, name). Optional `meta` carries
   * diagnostic data (hostname, version) that surfaces in
   * `signalman runner list`.
   */
  async postRunnerHeartbeat(
    name: string,
    meta?: Record<string, unknown>,
  ): Promise<Runner> {
    const { runner } = await this.post<{ runner: Runner }>(
      "/v1/runners/heartbeat",
      meta === undefined ? { name } : { name, meta },
    );
    return runner;
  }

  /**
   * Stream a blob to the control plane. Used by the runner-side build
   * executor when uploading artifacts. Body may be a Buffer or a
   * Readable; bytes are sent as application/octet-stream and bypass
   * the JSON 1 MiB body cap on the server (POST /v1/blobs is
   * registered with streamBody: true).
   */
  async uploadBlob(
    body: Buffer | Readable,
    contentType?: string,
  ): Promise<{ uri: string; sha256: string; size: number }> {
    const headers: Record<string, string> = {
      accept: "application/json",
      "content-type": contentType ?? "application/octet-stream",
    };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    const res = await fetch(`${this.baseUrl}/v1/blobs`, {
      method: "POST",
      headers,
      body: body as unknown as BodyInit,
      // Node's fetch requires `duplex: "half"` for streaming request
      // bodies; safe to set unconditionally.
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = text.length > 0 ? JSON.parse(text) : undefined;
    } catch {
      throw new HttpClientError(
        res.status,
        "non_json_response",
        `non-JSON response from POST /v1/blobs: ${text.slice(0, 200)}`,
      );
    }
    if (!res.ok) {
      const err = parsed as { error?: { code?: string; message?: string } };
      throw new HttpClientError(
        res.status,
        err?.error?.code ?? "http_error",
        err?.error?.message ?? `HTTP ${res.status}`,
      );
    }
    return parsed as { uri: string; sha256: string; size: number };
  }
}

export type { Job, JobStatus, Release };
