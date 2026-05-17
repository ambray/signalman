/**
 * Per-upstream authorization adapters. Each adapter encapsulates one
 * flavor's token-acquisition state machine and emits an
 * `Authorization` header value the proxy fetcher attaches to upstream
 * /v2/ calls.
 *
 * Three flavors at v0.5 (operator-locked Q2):
 *   - dockerhub  — anonymous bearer (auth.docker.io/token)
 *   - ghcr       — operator-supplied static bearer (PAT or workload-identity)
 *   - ecr        — AWS SigV4 + GetAuthorizationToken (decodes to Basic Auth)
 *
 * Adapters share a single interface so the virtual-upstream layer
 * is flavor-agnostic. New flavors (quay.io, Harbor) slot in by
 * implementing the same shape.
 *
 * All adapters take an injectable `fetch` to keep tests offline.
 * The production default uses `globalThis.fetch`.
 */

import type { UpstreamFetch, UpstreamFetchResult } from "../cargo/index.js";
import { signSigV4Request } from "./sigv4.js";

export type UpstreamFlavor = "dockerhub" | "ghcr" | "ecr";

export interface UpstreamAuthorizationScope {
  /** Upstream repository path, e.g. `library/alpine` or `my-org/my-repo`. */
  repository: string;
  /** Action set, e.g. `pull` (we don't push to upstreams at v0.5). */
  action: "pull";
}

export interface UpstreamAuthHeader {
  /** Value to attach as the `Authorization` request header. */
  authorization: string;
}

export interface UpstreamAuthAdapter {
  readonly kind: UpstreamFlavor;
  authorize(scope: UpstreamAuthorizationScope): Promise<UpstreamAuthHeader>;
}

// ── Docker Hub ─────────────────────────────────────────────────────

export interface DockerHubAdapterOptions {
  /** Token endpoint. Default `https://auth.docker.io/token`. */
  tokenEndpoint?: string;
  /** Service claim the token endpoint expects. Default `registry.docker.io`. */
  service?: string;
  /** Optional Basic auth (sk_-shape) for private Hub repos. */
  basicAuth?: { username: string; password: string };
  fetch?: UpstreamFetch;
}

export function dockerHubAuthAdapter(
  opts: DockerHubAdapterOptions = {},
): UpstreamAuthAdapter {
  const tokenEndpoint = opts.tokenEndpoint ?? "https://auth.docker.io/token";
  const service = opts.service ?? "registry.docker.io";
  const fetcher = opts.fetch ?? defaultFetch;
  return {
    kind: "dockerhub",
    async authorize(scope) {
      const params = new URLSearchParams({
        service,
        scope: `repository:${scope.repository}:${scope.action}`,
      });
      const url = `${tokenEndpoint}?${params.toString()}`;
      const headers: Record<string, string> = {};
      if (opts.basicAuth) {
        headers.authorization = `Basic ${Buffer.from(
          `${opts.basicAuth.username}:${opts.basicAuth.password}`,
        ).toString("base64")}`;
      }
      const resp = await fetcher(url, { headers });
      if (resp.status !== 200) {
        throw new Error(
          `dockerhub token endpoint returned ${resp.status} for scope ${scope.repository}:${scope.action}`,
        );
      }
      let parsed: { token?: string; access_token?: string };
      try {
        parsed = JSON.parse(resp.body.toString("utf-8"));
      } catch (err) {
        throw new Error(
          `dockerhub token endpoint returned non-JSON body: ${(err as Error).message}`,
        );
      }
      const token = parsed.token ?? parsed.access_token;
      if (!token) {
        throw new Error(`dockerhub token endpoint returned no token field`);
      }
      return { authorization: `Bearer ${token}` };
    },
  };
}

// ── GHCR ───────────────────────────────────────────────────────────

export interface GhcrAdapterOptions {
  /**
   * Operator-supplied bearer. GitHub PAT (`ghp_...`) or a workload-
   * identity-minted token. Anonymous pulls of public images work
   * without this (caller passes the resulting Authorization unchanged).
   */
  bearerToken?: string;
}

export function ghcrAuthAdapter(
  opts: GhcrAdapterOptions = {},
): UpstreamAuthAdapter {
  return {
    kind: "ghcr",
    async authorize() {
      if (!opts.bearerToken) {
        // Anonymous flow. GHCR accepts unauthenticated pulls for
        // public packages; we return an empty Bearer to satisfy
        // the interface contract without injecting credentials.
        return { authorization: "" };
      }
      return { authorization: `Bearer ${opts.bearerToken}` };
    },
  };
}

// ── ECR ────────────────────────────────────────────────────────────

export interface EcrAdapterOptions {
  /** AWS account region. Required — ECR is per-region. */
  region: string;
  /** Static AWS credentials. Pulled from env when omitted. */
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
  /** Override the ECR API endpoint (default derived from region). */
  apiEndpoint?: string;
  fetch?: UpstreamFetch;
  /** Injectable clock for SigV4 amz-date (tests). */
  now?: () => Date;
}

export function ecrAuthAdapter(
  opts: EcrAdapterOptions,
): UpstreamAuthAdapter {
  const accessKeyId = opts.accessKeyId ?? process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey =
    opts.secretAccessKey ?? process.env.AWS_SECRET_ACCESS_KEY;
  const sessionToken = opts.sessionToken ?? process.env.AWS_SESSION_TOKEN;
  if (!accessKeyId || !secretAccessKey) {
    throw new Error(
      `ECR adapter requires AWS credentials (provide accessKeyId+secretAccessKey ` +
        `or AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY env vars)`,
    );
  }
  const region = opts.region;
  const apiEndpoint =
    opts.apiEndpoint ?? `https://api.ecr.${region}.amazonaws.com/`;
  const fetcher = opts.fetch ?? defaultFetch;
  const now = opts.now ?? (() => new Date());

  return {
    kind: "ecr",
    async authorize() {
      const signed = signSigV4Request({
        accessKeyId,
        secretAccessKey,
        ...(sessionToken ? { sessionToken } : {}),
        region,
        service: "ecr",
        url: apiEndpoint,
        body: "{}",
        amzTarget:
          "AmazonEC2ContainerRegistry_V20150921.GetAuthorizationToken",
        now,
      });
      const resp = await fetcher(signed.url, {
        method: "POST",
        headers: signed.headers,
        body: signed.body,
      });
      if (resp.status !== 200) {
        throw new Error(
          `ECR GetAuthorizationToken returned ${resp.status}`,
        );
      }
      let parsed: { authorizationData?: Array<{ authorizationToken?: string }> };
      try {
        parsed = JSON.parse(resp.body.toString("utf-8"));
      } catch (err) {
        throw new Error(
          `ECR GetAuthorizationToken returned non-JSON body: ${(err as Error).message}`,
        );
      }
      const token = parsed.authorizationData?.[0]?.authorizationToken;
      if (!token) {
        throw new Error(
          `ECR GetAuthorizationToken: authorizationData[0].authorizationToken missing`,
        );
      }
      // ECR's authorizationToken is already base64-encoded
      // "AWS:<token>" — pass it through as a Basic auth header.
      return { authorization: `Basic ${token}` };
    },
  };
}

// ── Factory ─────────────────────────────────────────────────────────

export interface AdapterFactoryOptions {
  flavor: UpstreamFlavor;
  /** Free-form config passed in by `virtual_upstream.config_json`. */
  config?: Record<string, unknown>;
  /** Operator-supplied bearer / PAT, threaded from auth_header_template. */
  bearerToken?: string;
  fetch?: UpstreamFetch;
  now?: () => Date;
}

/**
 * Compose an adapter from an `upstream_flavor` discriminator + the
 * free-form `virtual_upstream.config_json`. Throws when the config
 * is insufficient (e.g. ECR with no region).
 */
export function createUpstreamAuthAdapter(
  opts: AdapterFactoryOptions,
): UpstreamAuthAdapter {
  switch (opts.flavor) {
    case "dockerhub": {
      const cfg = opts.config ?? {};
      const tokenEndpoint =
        typeof cfg.token_endpoint === "string"
          ? cfg.token_endpoint
          : undefined;
      const service =
        typeof cfg.token_service === "string" ? cfg.token_service : undefined;
      return dockerHubAuthAdapter({
        ...(tokenEndpoint ? { tokenEndpoint } : {}),
        ...(service ? { service } : {}),
        ...(opts.fetch ? { fetch: opts.fetch } : {}),
      });
    }
    case "ghcr": {
      return ghcrAuthAdapter({
        ...(opts.bearerToken ? { bearerToken: opts.bearerToken } : {}),
      });
    }
    case "ecr": {
      const cfg = opts.config ?? {};
      const region = typeof cfg.aws_region === "string" ? cfg.aws_region : "";
      if (!region) {
        throw new Error(
          `ECR upstream requires config.aws_region to be set`,
        );
      }
      const accessKeyId =
        typeof cfg.aws_access_key_id === "string"
          ? cfg.aws_access_key_id
          : undefined;
      const secretAccessKey =
        typeof cfg.aws_secret_access_key === "string"
          ? cfg.aws_secret_access_key
          : undefined;
      const sessionToken =
        typeof cfg.aws_session_token === "string"
          ? cfg.aws_session_token
          : undefined;
      const apiEndpoint =
        typeof cfg.api_endpoint === "string" ? cfg.api_endpoint : undefined;
      return ecrAuthAdapter({
        region,
        ...(accessKeyId ? { accessKeyId } : {}),
        ...(secretAccessKey ? { secretAccessKey } : {}),
        ...(sessionToken ? { sessionToken } : {}),
        ...(apiEndpoint ? { apiEndpoint } : {}),
        ...(opts.fetch ? { fetch: opts.fetch } : {}),
        ...(opts.now ? { now: opts.now } : {}),
      });
    }
  }
}

// ── Default fetcher ────────────────────────────────────────────────

const defaultFetch: UpstreamFetch = async (url, init) => {
  const resp = await globalThis.fetch(url, {
    method: (init as { method?: string } | undefined)?.method ?? "GET",
    headers: init?.headers ?? {},
    ...(init as { body?: string } | undefined)?.body !== undefined
      ? { body: (init as { body?: string }).body }
      : {},
  });
  const bytes = Buffer.from(await resp.arrayBuffer());
  const headers: Record<string, string> = {};
  resp.headers.forEach((v, k) => {
    headers[k] = v;
  });
  return { status: resp.status, headers, body: bytes };
};

export type { UpstreamFetch, UpstreamFetchResult };
