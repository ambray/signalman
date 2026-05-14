/**
 * `signalman-registry` BlobDriver — federates @signalman/host's
 * blob storage with a remote @signalman/registry HTTP API.
 *
 * Drop-in replacement for the S3 driver: when an operator runs the
 * standalone registry product (separate process, possibly behind a
 * CDN), point this driver at it and the host stops caring about
 * the underlying object store. The registry's HTTP boundary
 * (`PUT /v1/blobs/:sha256`, `GET /v1/blobs/:sha256`) is what we
 * speak.
 *
 * Key differences from the S3 driver:
 *   * The URI scheme is `registry://<sha256>` rather than `s3://...`.
 *     This is opaque outside the driver — `cp.artifacts.blob_uri`
 *     round-trips it through put/get/presignGet/delete.
 *   * Org scoping happens at the registry's auth layer (federated
 *     bearer token). At v0.4.0 the registry stores blobs in a
 *     single namespace; future RBAC narrows reads / writes per
 *     token, but the URI shape stays stable.
 *   * `presignGet` returns a registry-anchored URL the operator can
 *     paste into a browser. The registry does not currently sign
 *     URLs — bearer auth is the gating mechanism. When the
 *     registry adds short-lived URL signing in v0.4.x, that
 *     upgrade is invisible to BlobDriver callers.
 *
 * Streaming: upload uses `fetch` with the body as a Node stream
 * (Node 22.5+ supports passing a Readable directly via the
 * `duplex: "half"` extension). Download streams the response body
 * back via `response.body` ReadableStream → Node.Readable.
 */

import * as crypto from "node:crypto";
import { Readable } from "node:stream";
import { buffer as readToBuffer } from "node:stream/consumers";
import type { BlobDriver, BlobMetadata } from "./driver.js";
import { BlobNotFoundError } from "./driver.js";

export interface SignalmanRegistryBlobOptions {
  /** Registry base URL — e.g. `https://registry.example.com`. */
  baseUrl: string;
  /**
   * Bearer token presented in the Authorization header. Must match
   * the federated `sk_<prefix>_<secret>` shape the registry expects.
   * Optional — operators behind an authn proxy can leave this
   * empty and the proxy injects the header instead.
   */
  bearerToken?: string;
  /**
   * Inject the fetch implementation so tests can drive the driver
   * against a local server without committing to globalThis.fetch.
   * Defaults to globalThis.fetch.
   */
  fetch?: typeof fetch;
}

const URI_PREFIX = "registry://";

export class SignalmanRegistryBlobDriver implements BlobDriver {
  private readonly baseUrl: string;
  private readonly bearerToken: string | undefined;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: SignalmanRegistryBlobOptions) {
    if (!opts.baseUrl) {
      throw new Error("SignalmanRegistryBlobDriver: baseUrl is required");
    }
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.bearerToken = opts.bearerToken;
    this.fetchImpl = opts.fetch ?? fetch;
  }

  async put(input: {
    orgId: string;
    body: Buffer | Readable;
    contentType?: string;
  }): Promise<BlobMetadata> {
    this.validateOrgId(input.orgId);
    // The registry routes by sha, so we must know the sha before
    // calling PUT. v0.4.0 mirrors the S3 driver's buffer-then-PUT
    // shape; a streaming-PUT path that pre-hashes a temp blob is
    // a v0.4.x upgrade. Typical CI artifacts fit in RAM.
    const buf = Buffer.isBuffer(input.body)
      ? input.body
      : await readToBuffer(input.body);
    const sha256 = crypto.createHash("sha256").update(buf).digest("hex");
    const url = `${this.baseUrl}/v1/blobs/${sha256}`;
    const headers: Record<string, string> = {
      "content-type": input.contentType ?? "application/octet-stream",
      "content-length": String(buf.length),
    };
    if (this.bearerToken) headers.authorization = `Bearer ${this.bearerToken}`;
    const res = await this.fetchImpl(url, {
      method: "PUT",
      headers,
      // BodyInit (lib.dom) accepts only narrow types; Node's Buffer
      // / Uint8Array<ArrayBufferLike> typings collide with the dom
      // overload. Runtime accepts a Buffer just fine — cast through
      // unknown to satisfy the type checker without copying bytes.
      body: buf as unknown as BodyInit,
    });
    if (res.status !== 201) {
      const reason = await readErrorBody(res);
      throw new Error(
        `registry PUT /v1/blobs/${sha256} failed: ${res.status} ${reason}`,
      );
    }
    return {
      uri: `${URI_PREFIX}${sha256}`,
      sha256,
      size: buf.length,
    };
  }

  async get(uri: string): Promise<Readable> {
    const sha = parseSha(uri);
    const url = `${this.baseUrl}/v1/blobs/${sha}`;
    const headers: Record<string, string> = {};
    if (this.bearerToken) headers.authorization = `Bearer ${this.bearerToken}`;
    const res = await this.fetchImpl(url, { headers });
    if (res.status === 404) {
      throw new BlobNotFoundError(uri);
    }
    if (!res.ok) {
      const reason = await readErrorBody(res);
      throw new Error(
        `registry GET /v1/blobs/${sha} failed: ${res.status} ${reason}`,
      );
    }
    if (!res.body) {
      throw new Error(`registry GET /v1/blobs/${sha} returned no body`);
    }
    // WHATWG ReadableStream → Node Readable.
    return Readable.fromWeb(res.body as never);
  }

  async presignGet(uri: string, _ttlSeconds: number): Promise<string> {
    const sha = parseSha(uri);
    // v0.4.0 registry doesn't sign URLs; bearer auth is the gate.
    // Return the canonical URL so operators can verify-by-eyeball
    // and embed in pipeline outputs.
    return `${this.baseUrl}/v1/blobs/${sha}`;
  }

  async delete(uri: string): Promise<void> {
    // v0.4.0 registry does not expose a blob DELETE endpoint —
    // retention / GC is a v0.4.x feature. We deliberately make
    // this a no-op rather than throwing so the host control-plane
    // soft-delete path (which best-effort calls `delete()`) does
    // not break when wired against the registry.
    parseSha(uri);
    return;
  }

  async exists(uri: string): Promise<boolean> {
    const sha = parseSha(uri);
    const url = `${this.baseUrl}/v1/blobs/${sha}`;
    const headers: Record<string, string> = {};
    if (this.bearerToken) headers.authorization = `Bearer ${this.bearerToken}`;
    const res = await this.fetchImpl(url, { method: "GET", headers });
    if (res.status === 404) return false;
    // Drain the body to release the connection; we don't care about
    // the bytes, only the status code.
    if (res.body) {
      const reader = res.body.getReader();
      try {
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const { done } = await reader.read();
          if (done) break;
        }
      } finally {
        reader.releaseLock();
      }
    }
    return res.ok;
  }

  resolveBySha(orgId: string, sha256: string): string {
    if (!/^[a-f0-9]{64}$/.test(sha256)) {
      throw new Error(`invalid sha256: ${sha256}`);
    }
    this.validateOrgId(orgId);
    // Org is enforced at the registry auth layer; the URI doesn't
    // encode it (the registry namespaces by token, not by path).
    return `${URI_PREFIX}${sha256}`;
  }

  private validateOrgId(orgId: string): void {
    // Defense-in-depth — the registry already auth-scopes, but a
    // malformed orgId from the host control plane usually means a
    // bug elsewhere. Mirrors the local-fs driver's rules.
    if (orgId.includes("..") || orgId.includes("/") || orgId.includes("\\")) {
      throw new Error(`invalid org id: ${orgId}`);
    }
  }
}

function parseSha(uri: string): string {
  if (!uri.startsWith(URI_PREFIX)) {
    throw new BlobNotFoundError(uri);
  }
  const sha = uri.slice(URI_PREFIX.length);
  if (!/^[a-f0-9]{64}$/.test(sha)) {
    throw new BlobNotFoundError(uri);
  }
  return sha;
}

async function readErrorBody(res: Response): Promise<string> {
  try {
    const text = await res.text();
    return text.slice(0, 256);
  } catch {
    return "";
  }
}
