/**
 * Unit tests for the F5 fix in `host/src/http/router.ts`: streamBody
 * routes must enforce `maxBodyBytes` so an authenticated org member
 * can't DoS the host with a single multi-gigabyte upload.
 *
 * We test the router in isolation (no ControlPlane, no blob driver)
 * so the assertions are about the cap mechanism, not downstream
 * storage behavior.
 */

import * as http from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Router } from "../http/router.js";

let server: http.Server;
let baseUrl: string;

beforeEach(async () => {
  const router = new Router();
  router.post(
    "/upload-small",
    async (ctx) => {
      // Drain the stream so the cap has a chance to fire.
      let received = 0;
      for await (const chunk of ctx.bodyStream ?? []) {
        received += (chunk as Buffer).length;
      }
      return { status: 200, body: { received } };
    },
    { streamBody: true, maxBodyBytes: 100 },
  );
  router.post(
    "/upload-default",
    async (ctx) => {
      let received = 0;
      for await (const chunk of ctx.bodyStream ?? []) {
        received += (chunk as Buffer).length;
      }
      return { status: 200, body: { received } };
    },
    { streamBody: true },
  );
  server = http.createServer(router.listener());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr !== "object") throw new Error("no address");
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("Router streamBody maxBodyBytes cap", () => {
  it("accepts a body exactly at the cap", async () => {
    const body = Buffer.alloc(100, 0x41);
    const r = await fetch(`${baseUrl}/upload-small`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body,
    });
    expect(r.status).toBe(200);
    const j = (await r.json()) as { received: number };
    expect(j.received).toBe(100);
  });

  it("rejects a body above the cap with 413 (Content-Length declared)", async () => {
    const body = Buffer.alloc(200, 0x41);
    const r = await fetch(`${baseUrl}/upload-small`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body,
    });
    expect(r.status).toBe(413);
    const j = (await r.json()) as { error: { code: string } };
    expect(j.error.code).toBe("request_too_large");
  });

  it("rejects a chunked body above the cap (no Content-Length)", async () => {
    // Use the http module directly so we can send chunked transfer-
    // encoding without a Content-Length header; this exercises the
    // running-total cap path in `capStreamBody`.
    const url = new URL(baseUrl);
    await new Promise<void>((resolve, reject) => {
      const req = http.request(
        {
          hostname: url.hostname,
          port: Number(url.port),
          path: "/upload-small",
          method: "POST",
          headers: {
            "transfer-encoding": "chunked",
            "content-type": "application/octet-stream",
          },
        },
        (res) => {
          expect(res.statusCode).toBe(413);
          let raw = "";
          res.setEncoding("utf-8");
          res.on("data", (c: string) => (raw += c));
          res.on("end", () => {
            const j = JSON.parse(raw) as { error: { code: string } };
            expect(j.error.code).toBe("request_too_large");
            resolve();
          });
          res.on("error", reject);
        },
      );
      req.on("error", (err) => {
        // The server destroys the socket once the cap is tripped;
        // node may surface that as ECONNRESET *after* the response
        // headers go out. The response handler above will still
        // resolve in that case — only fail if we never saw a
        // response.
        if ((err as NodeJS.ErrnoException).code !== "ECONNRESET") {
          reject(err);
        }
      });
      // Write 200 bytes split into 4 chunks; the cap (100) should fire
      // mid-stream.
      for (let i = 0; i < 4; i++) {
        req.write(Buffer.alloc(50, 0x42));
      }
      req.end();
    });
  });

  it("default cap on streamBody routes is large but finite (1 GiB)", async () => {
    // We don't actually want to send 1 GiB in a unit test; just assert
    // that a 2 MiB body — the size that's used in http-blobs.test.ts —
    // passes the default cap without being rejected.
    const body = Buffer.alloc(2 * 1024 * 1024, 0x43);
    const r = await fetch(`${baseUrl}/upload-default`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body,
    });
    expect(r.status).toBe(200);
  });
});
