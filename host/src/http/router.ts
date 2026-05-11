/**
 * Minimal HTTP router built on `node:http`. The control-plane API has
 * ~15 endpoints in v0.3.0; adding express adds 30KB and ESM friction
 * with no offsetting benefit at this size. If we cross ~30 routes or
 * need middleware (CORS, compression, file uploads) we can swap to
 * fastify/express then.
 *
 * Routes register a path pattern (`/v1/releases/:id`) with a method
 * and a handler. The handler receives parsed path params, the parsed
 * JSON body (if any), and the parsed query string. It returns a JSON-
 * serializable value (defaults to 200) or throws — `mapError` resolves
 * thrown errors to status codes.
 *
 * Bodies cap at 1 MiB; v0.3+ artifact uploads will need a streaming
 * codepath that bypasses this router.
 */

import * as http from "node:http";
import { URL } from "node:url";
import { mapError } from "./errors.js";

const MAX_BODY_BYTES = 1024 * 1024;

export type HttpMethod = "GET" | "POST" | "PATCH" | "DELETE";

/**
 * Auth context attached to every authenticated request. PR 7 derives
 * `orgId` from the bearer token (or the default org when the request
 * is from loopback). `apiKeyId` is null for loopback-bypass requests.
 */
export interface AuthContext {
  orgId: string;
  apiKeyId: string | null;
}

export interface RequestContext {
  method: HttpMethod;
  path: string;
  params: Record<string, string>;
  query: Record<string, string | string[]>;
  body: unknown;
  headers: http.IncomingHttpHeaders;
  /** Remote socket address (`req.socket.remoteAddress`). Used for the loopback bypass. */
  remoteAddress: string | undefined;
  /** Populated by the authenticate hook before the handler runs. */
  auth: AuthContext;
}

export type RouteHandler = (ctx: RequestContext) => Promise<unknown> | unknown;

/** Authenticate a request. Throw an HttpError to deny. */
export type Authenticator = (
  pre: PreAuthContext,
) => Promise<AuthContext> | AuthContext;

/** Context fields available before auth (no `auth` yet). */
export type PreAuthContext = Omit<RequestContext, "auth">;

export interface RouterOptions {
  /** Called for every non-public route before the handler. */
  authenticate?: Authenticator;
  /** Paths that skip the authenticate hook (anonymous OK). */
  publicPaths?: Set<string>;
}

export interface RouteDefinition {
  method: HttpMethod;
  pattern: RegExp;
  paramNames: string[];
  handler: RouteHandler;
}

export class Router {
  private readonly routes: RouteDefinition[] = [];
  private readonly authenticate?: Authenticator;
  private readonly publicPaths: Set<string>;

  constructor(opts: RouterOptions = {}) {
    this.authenticate = opts.authenticate;
    this.publicPaths = opts.publicPaths ?? new Set();
  }

  route(method: HttpMethod, path: string, handler: RouteHandler): void {
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
    this.routes.push({ method, pattern, paramNames, handler });
  }

  get(path: string, handler: RouteHandler): void {
    this.route("GET", path, handler);
  }
  post(path: string, handler: RouteHandler): void {
    this.route("POST", path, handler);
  }
  patch(path: string, handler: RouteHandler): void {
    this.route("PATCH", path, handler);
  }
  delete(path: string, handler: RouteHandler): void {
    this.route("DELETE", path, handler);
  }

  /** node:http listener that dispatches into the route table. */
  listener(): http.RequestListener {
    return async (req, res) => {
      try {
        const result = await this.dispatch(req);
        writeJson(res, result.status, result.body);
      } catch (err) {
        const { status, body } = mapError(err);
        writeJson(res, status, body);
      }
    };
  }

  async dispatch(req: http.IncomingMessage): Promise<{ status: number; body: unknown }> {
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
      const query: Record<string, string | string[]> = {};
      for (const [k, v] of url.searchParams) {
        const existing = query[k];
        if (existing === undefined) {
          query[k] = v;
        } else if (Array.isArray(existing)) {
          existing.push(v);
        } else {
          query[k] = [existing, v];
        }
      }
      const body = await readBody(req);
      const preAuth: PreAuthContext = {
        method,
        path: url.pathname,
        params,
        query,
        body,
        headers: req.headers,
        remoteAddress: req.socket?.remoteAddress,
      };

      // Authenticate unless this is a public route.
      let auth: AuthContext;
      if (this.publicPaths.has(url.pathname) || !this.authenticate) {
        // Public route: no real org. Handlers on public routes must
        // not touch ctx.auth.orgId.
        auth = { orgId: "", apiKeyId: null };
      } else {
        auth = await this.authenticate(preAuth);
      }

      const result = await r.handler({ ...preAuth, auth });
      // Handler can return `{ status, body }` to override defaults.
      if (
        result &&
        typeof result === "object" &&
        "status" in (result as Record<string, unknown>) &&
        "body" in (result as Record<string, unknown>) &&
        typeof (result as { status?: unknown }).status === "number"
      ) {
        const r2 = result as { status: number; body: unknown };
        return { status: r2.status, body: r2.body };
      }
      return { status: 200, body: result };
    }
    return {
      status: 404,
      body: { error: { code: "not_found", message: `no route for ${method} ${url.pathname}` } },
    };
  }
}

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let received = 0;
    req.on("data", (chunk: Buffer) => {
      received += chunk.length;
      if (received > MAX_BODY_BYTES) {
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

function writeJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("content-length", Buffer.byteLength(payload).toString());
  res.end(payload);
}
