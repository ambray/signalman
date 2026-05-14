/**
 * Minimal HTTP router built on `node:http`. Same shape as
 * host/src/http/router.ts but simplified — the v0.4.0 surface has
 * only the registry routes, so per-route stream + raw-response
 * options are kept (needed for blob upload/download) but the
 * elaborate query-param array handling is collapsed.
 *
 * Routes register a path pattern (`/v1/manifests/:name/:version`)
 * with a method + handler. Handlers receive parsed path params and
 * optional parsed JSON body (when `streamBody` is not set). Cap on
 * JSON bodies is 1 MiB; blob uploads bypass this via `streamBody`.
 */

import * as http from "node:http";
import { PassThrough, type Readable } from "node:stream";
import { URL } from "node:url";
import { mapError } from "./errors.js";

const MAX_JSON_BODY_BYTES = 1024 * 1024;
const DEFAULT_STREAM_BODY_MAX = 1024 * 1024 * 1024;

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/**
 * Auth context attached to every authenticated request. `tokenPrefix`
 * is the `sk_<prefix>` segment of the bearer token; future RBAC
 * lookups key off it.
 */
export interface AuthContext {
  tokenPrefix: string | null;
  /**
   * Reserved for v0.4.x RBAC: the role / scope set the token grants.
   * Bootstrap servers report ["admin"] for any valid token.
   */
  scopes: readonly string[];
}

export interface RequestContext {
  method: HttpMethod;
  path: string;
  params: Record<string, string>;
  query: Record<string, string | undefined>;
  body: unknown;
  bodyStream?: Readable;
  res?: http.ServerResponse;
  headers: http.IncomingHttpHeaders;
  remoteAddress: string | undefined;
  auth: AuthContext;
}

export type RouteHandler = (ctx: RequestContext) => Promise<unknown> | unknown;

export interface RouteOptions {
  streamBody?: boolean;
  maxBodyBytes?: number;
  rawResponse?: boolean;
}

export type Authenticator = (
  pre: Omit<RequestContext, "auth">,
) => Promise<AuthContext> | AuthContext;

export interface RouterOptions {
  authenticate?: Authenticator;
  publicPaths?: Set<string>;
}

interface RouteDefinition {
  method: HttpMethod;
  pattern: RegExp;
  paramNames: string[];
  handler: RouteHandler;
  options: RouteOptions;
}

export class Router {
  private readonly routes: RouteDefinition[] = [];
  private readonly authenticate?: Authenticator;
  private readonly publicPaths: Set<string>;

  constructor(opts: RouterOptions = {}) {
    this.authenticate = opts.authenticate;
    this.publicPaths = opts.publicPaths ?? new Set();
  }

  route(
    method: HttpMethod,
    path: string,
    handler: RouteHandler,
    options: RouteOptions = {},
  ): void {
    const paramNames: string[] = [];
    const escaped = path.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(
      "^" +
        escaped.replace(/:([a-z_][a-z0-9_]*)/gi, (_match, name: string) => {
          paramNames.push(name);
          return "([^/]+)";
        }) +
        "$",
    );
    this.routes.push({ method, pattern, paramNames, handler, options });
  }

  get(path: string, handler: RouteHandler, options?: RouteOptions): void {
    this.route("GET", path, handler, options);
  }
  post(path: string, handler: RouteHandler, options?: RouteOptions): void {
    this.route("POST", path, handler, options);
  }
  put(path: string, handler: RouteHandler, options?: RouteOptions): void {
    this.route("PUT", path, handler, options);
  }
  delete(path: string, handler: RouteHandler, options?: RouteOptions): void {
    this.route("DELETE", path, handler, options);
  }

  listener(): http.RequestListener {
    return async (req, res) => {
      try {
        await this.handle(req, res);
      } catch (err) {
        if (!res.headersSent) {
          const { status, body } = mapError(err);
          writeJson(res, status, body);
        }
      }
    };
  }

  private async handle(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const method = (req.method ?? "GET") as HttpMethod;
    const url = new URL(req.url ?? "/", "http://localhost");
    for (const r of this.routes) {
      if (r.method !== method) continue;
      const m = r.pattern.exec(url.pathname);
      if (!m) continue;
      const params: Record<string, string> = {};
      r.paramNames.forEach((name, i) => {
        params[name] = decodeURIComponent(m[i + 1]);
      });
      const query: Record<string, string | undefined> = {};
      for (const [k, v] of url.searchParams) {
        query[k] = v;
      }
      const body = r.options.streamBody ? undefined : await readJsonBody(req);
      const bodyStream = r.options.streamBody
        ? capStreamBody(
            req,
            res,
            r.options.maxBodyBytes ?? DEFAULT_STREAM_BODY_MAX,
          )
        : undefined;
      const preAuth: Omit<RequestContext, "auth"> = {
        method,
        path: url.pathname,
        params,
        query,
        body,
        ...(bodyStream ? { bodyStream } : {}),
        ...(r.options.rawResponse ? { res } : {}),
        headers: req.headers,
        remoteAddress: req.socket?.remoteAddress,
      };

      let auth: AuthContext;
      if (this.publicPaths.has(url.pathname) || !this.authenticate) {
        auth = { tokenPrefix: null, scopes: [] };
      } else {
        auth = await this.authenticate(preAuth);
      }

      const result = await r.handler({ ...preAuth, auth });

      if (r.options.rawResponse) {
        if (!res.headersSent) {
          writeJson(res, 500, {
            error: {
              code: "internal_error",
              message: "raw-response handler did not write a response",
            },
          });
        }
        return;
      }

      if (
        result &&
        typeof result === "object" &&
        "status" in (result as Record<string, unknown>) &&
        "body" in (result as Record<string, unknown>) &&
        typeof (result as { status?: unknown }).status === "number"
      ) {
        const r2 = result as { status: number; body: unknown };
        writeJson(res, r2.status, r2.body);
      } else {
        writeJson(res, 200, result);
      }
      return;
    }
    writeJson(res, 404, {
      error: { code: "not_found", message: `no route for ${method} ${url.pathname}` },
    });
  }
}

function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let received = 0;
    req.on("data", (chunk: Buffer) => {
      received += chunk.length;
      if (received > MAX_JSON_BODY_BYTES) {
        req.destroy();
        reject(new Error("request body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (chunks.length === 0) {
        resolve(undefined);
        return;
      }
      const raw = Buffer.concat(chunks).toString("utf-8");
      const contentType = (req.headers["content-type"] ?? "").toLowerCase();
      if (!contentType.includes("application/json")) {
        resolve(raw);
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(new Error(`invalid JSON body: ${(err as Error).message}`));
      }
    });
    req.on("error", reject);
  });
}

function capStreamBody(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  cap: number,
): Readable {
  const out = new PassThrough();
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > cap) {
    if (!res.headersSent) {
      writeJson(res, 413, {
        error: {
          code: "request_too_large",
          message: `request body too large (max ${cap} bytes, declared ${declared})`,
        },
      });
    }
    out.destroy(new Error("request body too large"));
    req.destroy();
    return out;
  }
  let received = 0;
  let tripped = false;
  req.on("data", (chunk: Buffer) => {
    if (tripped) return;
    received += chunk.length;
    if (received > cap) {
      tripped = true;
      if (!res.headersSent) {
        writeJson(res, 413, {
          error: {
            code: "request_too_large",
            message: `request body exceeded max ${cap} bytes`,
          },
        });
      }
      out.destroy(new Error("request body too large"));
      req.destroy();
      return;
    }
    out.write(chunk);
  });
  req.on("end", () => {
    if (!tripped) out.end();
  });
  req.on("error", (err) => {
    if (!tripped) out.destroy(err);
  });
  return out;
}

function writeJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("content-length", Buffer.byteLength(payload).toString());
  res.end(payload);
}
