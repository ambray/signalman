/**
 * Public surface of the HTTP control-plane server.
 *
 * `startServer({ port, host, controlPlane })` is the entry point used
 * by the `signalman serve` CLI verb and by the integration tests. It
 * returns a `ServerHandle` with the bound address and a `stop()` to
 * tear the listener down cleanly.
 */

import * as http from "node:http";
import { buildApp } from "./app.js";
import type { ControlPlane } from "../control-plane/index.js";

export { Router } from "./router.js";
export type {
  RequestContext,
  RouteHandler,
  HttpMethod,
} from "./router.js";
export { HttpError, mapError } from "./errors.js";
export { buildApp } from "./app.js";

export interface StartServerOptions {
  controlPlane: ControlPlane;
  /** Default: 8765. */
  port?: number;
  /** Default: "127.0.0.1" (loopback-only by default). */
  host?: string;
  /** Force every request to carry a Bearer token (no loopback bypass). */
  disableLoopbackBypass?: boolean;
}

export interface ServerHandle {
  port: number;
  host: string;
  url: string;
  stop(): Promise<void>;
}

export async function startServer(opts: StartServerOptions): Promise<ServerHandle> {
  const host = opts.host ?? "127.0.0.1";
  const port = opts.port ?? 8765;

  const router = buildApp({
    controlPlane: opts.controlPlane,
    auth: { disableLoopbackBypass: opts.disableLoopbackBypass },
  });
  const server = http.createServer(router.listener());

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => {
      server.off("listening", onListen);
      reject(err);
    };
    const onListen = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListen);
    server.listen(port, host);
  });

  const address = server.address();
  const boundPort =
    address && typeof address === "object" ? address.port : port;

  return {
    port: boundPort,
    host,
    url: `http://${host}:${boundPort}`,
    stop: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
