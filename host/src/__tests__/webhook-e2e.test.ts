/**
 * End-to-end webhook delivery: dispatcher against an in-memory
 * `http.Server` receiver. Verifies the wire-level shape — POST
 * method, content-type, HMAC signature header — as Slack / GitHub
 * Actions / etc. would see it.
 */

import * as http from "node:http";
import { AddressInfo } from "node:net";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ControlPlane } from "../control-plane/index.js";
import {
  EventDispatcher,
  verifySignature,
  type SignalmanEvent,
} from "../control-plane/events/index.js";
import type { Org } from "../control-plane/types.js";
import { runWebhookTest } from "../verbs/control-plane.js";

let dataDir: string;
let cp: ControlPlane;
let org: Org;

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "signalman-wh-e2e-"));
  cp = ControlPlane.create({
    storage: { driver: "sqlite", url: path.join(dataDir, "signalman.db") },
    blobs: { driver: "local", root: path.join(dataDir, "blobs") },
  });
  const init = await cp.init();
  org = init.defaultOrg;
});

afterEach(async () => {
  await cp.close();
  await fs.rm(dataDir, { recursive: true, force: true });
});

interface Recv {
  method: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function startReceiver(): Promise<{
  url: string;
  received: Recv[];
  close: () => Promise<void>;
}> {
  return new Promise((resolve) => {
    const received: Recv[] = [];
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk: Buffer) => {
        body += chunk.toString("utf-8");
      });
      req.on("end", () => {
        received.push({ method: req.method ?? "?", headers: req.headers, body });
        res.statusCode = 200;
        res.setHeader("content-type", "text/plain");
        res.end("ok");
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${port}/hook`,
        received,
        close: () =>
          new Promise<void>((res) => {
            server.close(() => res());
          }),
      });
    });
  });
}

const sample: SignalmanEvent = {
  kind: "release-built",
  orgId: "placeholder",
  at: "2026-05-14T12:00:00.000Z",
  releaseId: "rel-1",
  productName: "p",
  tag: "v1.0.0",
  manifestSha256: "abc",
};

describe("webhook E2E — generic against in-memory http.Server", () => {
  it("delivers a POST with the HMAC signature header verifiable by the receiver", async () => {
    const recv = await startReceiver();
    try {
      const sub = await cp.webhookSubscriptions.create({
        orgId: org.id,
        kind: "generic",
        url: recv.url,
        secretHmacKey: "topsecret",
      });
      const dispatcher = new EventDispatcher({
        controlPlane: cp,
        email: null,
      });
      const ev: SignalmanEvent = { ...sample, orgId: org.id };
      const result = await dispatcher.dispatch(ev);
      expect(result.outcomes[0].delivered).toBe(true);
      expect(recv.received).toHaveLength(1);
      const r = recv.received[0];
      expect(r.method).toBe("POST");
      expect(r.headers["content-type"]).toContain("application/json");
      const sig = r.headers["x-signalman-signature"];
      expect(typeof sig).toBe("string");
      expect(verifySignature("topsecret", r.body, sig as string)).toBe(true);
      // Re-parsed event matches what we dispatched.
      expect(JSON.parse(r.body)).toMatchObject({
        kind: "release-built",
        releaseId: ev.releaseId,
      });
      // Used for downstream void check of the unused `sub` ref:
      void sub;
    } finally {
      await recv.close();
    }
  });

  it("`webhook test` verb path also delivers to a real receiver", async () => {
    const recv = await startReceiver();
    try {
      const sub = await cp.webhookSubscriptions.create({
        orgId: org.id,
        kind: "generic",
        url: recv.url,
        secretHmacKey: "k",
      });
      const result = await runWebhookTest(cp, { id: sub.id });
      expect(result.outcome.delivered).toBe(true);
      expect(recv.received).toHaveLength(1);
    } finally {
      await recv.close();
    }
  });

  it("non-2xx response surfaces as a failed outcome with the status code", async () => {
    const server = http.createServer((_req, res) => {
      res.statusCode = 500;
      res.end("boom");
    });
    await new Promise<void>((res) => server.listen(0, "127.0.0.1", () => res()));
    const port = (server.address() as AddressInfo).port;
    const url = `http://127.0.0.1:${port}/hook`;
    try {
      const sub = await cp.webhookSubscriptions.create({
        orgId: org.id,
        kind: "generic",
        url,
      });
      const result = await runWebhookTest(cp, { id: sub.id });
      expect(result.outcome.delivered).toBe(false);
      expect(result.outcome.status).toBe(500);
    } finally {
      await new Promise<void>((res) => server.close(() => res()));
    }
  });
});

describe("webhook E2E — verb-level CRUD", () => {
  it("add → list → remove round trip persists state", async () => {
    const {
      runWebhookAdd,
      runWebhookList,
      runWebhookRemove,
    } = await import("../verbs/control-plane.js");
    const recv = await startReceiver();
    try {
      const sub = await runWebhookAdd(cp, {
        kind: "generic",
        url: recv.url,
        secretHmacKey: "k",
        eventKinds: ["release-built"],
      });
      let list = await runWebhookList(cp);
      expect(list).toHaveLength(1);
      expect(list[0].url).toBe(recv.url);
      await runWebhookRemove(cp, { id: sub.id });
      list = await runWebhookList(cp);
      expect(list).toEqual([]);
    } finally {
      await recv.close();
    }
  });

  it("verb-layer add rejects http URL for kind=email", async () => {
    const { runWebhookAdd } = await import("../verbs/control-plane.js");
    await expect(
      runWebhookAdd(cp, { kind: "email", url: "http://nope" }),
    ).rejects.toThrow(/email kind requires a mailto/);
  });

  it("verb-layer add rejects mailto URL for kind=generic", async () => {
    const { runWebhookAdd } = await import("../verbs/control-plane.js");
    await expect(
      runWebhookAdd(cp, { kind: "generic", url: "mailto:x@y" }),
    ).rejects.toThrow(/generic\/slack kinds require an http/);
  });
});
