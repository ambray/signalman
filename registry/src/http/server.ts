/**
 * Boot a `node:http` server hosting the registry HTTP app.
 *
 * The CLI `serve` verb uses this; tests instantiate the same
 * factory bound to ephemeral ports so suites don't need port-
 * coordination logic.
 */

import * as http from "node:http";
import { AddressInfo } from "node:net";
import { buildApp, type AppHandles, type AppOptions } from "./app.js";
import type { Router } from "./router.js";

export interface CreateServerOptions extends AppOptions {
  /** Bind host. Defaults to "127.0.0.1". */
  host?: string;
  /** Bind port. `0` lets the kernel pick — used by tests. */
  port?: number;
}

export interface ServerHandle {
  /** The underlying `http.Server` for low-level adjustment. */
  server: http.Server;
  /** Resolved bind port (useful when `port: 0` was requested). */
  port: number;
  /** Resolved bind host. */
  host: string;
  /** Convenience base URL: `http://${host}:${port}`. */
  baseUrl: string;
  /** Stop the server. Resolves once `close()` has fully shut down. */
  close(): Promise<void>;
  /**
   * App-level handles for background tasks (WS10 reaper, etc.).
   * Optional — only present when the underlying app spawned them.
   */
  handles?: AppHandles;
}

export async function createServer(
  opts: CreateServerOptions,
): Promise<ServerHandle> {
  const router = buildApp(opts);
  const server = http.createServer(router.listener());
  const host = opts.host ?? "127.0.0.1";
  const port = opts.port ?? 0;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const addr = server.address() as AddressInfo;
  const boundPort = addr.port;
  const appHandles = (router as Router & { handles?: AppHandles }).handles;
  return {
    server,
    port: boundPort,
    host,
    baseUrl: `http://${host}:${boundPort}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        appHandles?.stopBackgroundTasks();
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      }),
    ...(appHandles ? { handles: appHandles } : {}),
  };
}
