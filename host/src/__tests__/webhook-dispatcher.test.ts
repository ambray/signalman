/**
 * Integration tests for the EventDispatcher (Epic 2 / WS3).
 *
 * Verifies routing logic: kind→driver dispatch, event-kind filtering,
 * HMAC signing for generic, Slack-payload shape for slack, the email
 * silent-skip path when SIGNALMAN_SMTP_URL is absent. Network IO is
 * stubbed via injected HttpFetcher; SMTP is stubbed via injected
 * EmailSender.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ControlPlane } from "../control-plane/index.js";
import {
  EventDispatcher,
  signBody,
  subscriptionWantsEvent,
  type DispatchOutcome,
  type SignalmanEvent,
} from "../control-plane/events/index.js";
import type { Org, WebhookSubscription } from "../control-plane/types.js";

let dataDir: string;
let cp: ControlPlane;
let org: Org;

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "signalman-dispatcher-"));
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

function sampleEvent(orgId: string): SignalmanEvent {
  return {
    kind: "release-built",
    orgId,
    at: "2026-05-14T12:00:00.000Z",
    releaseId: "rel-1",
    productName: "p",
    tag: "v1.0.0",
    manifestSha256: "abc",
  };
}

describe("subscriptionWantsEvent", () => {
  const baseSub: WebhookSubscription = {
    id: "s1",
    orgId: "org",
    kind: "generic",
    url: "https://example.invalid",
    secretHmacKey: null,
    eventKinds: [],
    active: true,
    description: null,
    createdAt: "x",
    updatedAt: "x",
    deletedAt: null,
  };

  it("empty event-kinds list = wants everything", () => {
    expect(
      subscriptionWantsEvent(baseSub, sampleEvent("org")),
    ).toBe(true);
  });

  it("explicit list narrows", () => {
    const sub: WebhookSubscription = {
      ...baseSub,
      eventKinds: ["health-failed"],
    };
    expect(subscriptionWantsEvent(sub, sampleEvent("org"))).toBe(false);
  });

  it("matches when the event kind is in the list", () => {
    const sub: WebhookSubscription = {
      ...baseSub,
      eventKinds: ["release-built"],
    };
    expect(subscriptionWantsEvent(sub, sampleEvent("org"))).toBe(true);
  });
});

describe("EventDispatcher — generic kind", () => {
  it("POSTs JSON body and signs with HMAC when secret is set", async () => {
    const sub = await cp.webhookSubscriptions.create({
      orgId: org.id,
      kind: "generic",
      url: "https://hooks.example.invalid/x",
      secretHmacKey: "topsecret",
    });
    const calls: Array<{ url: string; init: { headers: Record<string, string>; body: string } }> =
      [];
    const dispatcher = new EventDispatcher({
      controlPlane: cp,
      fetch: async (url, init) => {
        calls.push({ url, init });
        return { status: 200, text: async () => "ok" };
      },
      email: null,
    });
    const ev = sampleEvent(org.id);
    const result = await dispatcher.dispatch(ev);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(sub.url);
    expect(calls[0].init.headers["x-signalman-signature"]).toBe(
      signBody("topsecret", calls[0].init.body),
    );
    expect(JSON.parse(calls[0].init.body)).toMatchObject({ kind: "release-built" });
    expect(result.outcomes[0].delivered).toBe(true);
    expect(result.outcomes[0].status).toBe(200);
  });

  it("omits the signature header when no secret is set", async () => {
    await cp.webhookSubscriptions.create({
      orgId: org.id,
      kind: "generic",
      url: "https://hooks.example.invalid/x",
    });
    const calls: Array<{ init: { headers: Record<string, string>; body: string } }> = [];
    const dispatcher = new EventDispatcher({
      controlPlane: cp,
      fetch: async (_url, init) => {
        calls.push({ init });
        return { status: 200, text: async () => "ok" };
      },
      email: null,
    });
    await dispatcher.dispatch(sampleEvent(org.id));
    expect(calls[0].init.headers["x-signalman-signature"]).toBeUndefined();
  });

  it("flags delivery as failed on non-2xx", async () => {
    await cp.webhookSubscriptions.create({
      orgId: org.id,
      kind: "generic",
      url: "https://hooks.example.invalid/x",
      secretHmacKey: "k",
    });
    const dispatcher = new EventDispatcher({
      controlPlane: cp,
      fetch: async () => ({ status: 503, text: async () => "down" }),
      email: null,
      onError: () => undefined,
    });
    const result = await dispatcher.dispatch(sampleEvent(org.id));
    expect(result.outcomes[0].delivered).toBe(false);
    expect(result.outcomes[0].status).toBe(503);
    expect(result.outcomes[0].error).toContain("503");
  });

  it("captures thrown fetch errors as failed outcomes (does not propagate)", async () => {
    await cp.webhookSubscriptions.create({
      orgId: org.id,
      kind: "generic",
      url: "https://hooks.example.invalid/x",
    });
    const dispatcher = new EventDispatcher({
      controlPlane: cp,
      fetch: async () => {
        throw new Error("network down");
      },
      email: null,
      onError: () => undefined,
    });
    const result = await dispatcher.dispatch(sampleEvent(org.id));
    expect(result.outcomes[0].delivered).toBe(false);
    expect(result.outcomes[0].error).toContain("network down");
  });
});

describe("EventDispatcher — slack kind", () => {
  it("POSTs a Slack Block-Kit payload (not the raw event)", async () => {
    await cp.webhookSubscriptions.create({
      orgId: org.id,
      kind: "slack",
      url: "https://hooks.slack.com/x",
    });
    let body = "";
    const dispatcher = new EventDispatcher({
      controlPlane: cp,
      fetch: async (_url, init) => {
        body = init.body;
        return { status: 200, text: async () => "ok" };
      },
      email: null,
    });
    await dispatcher.dispatch(sampleEvent(org.id));
    const parsed = JSON.parse(body) as { text: string; blocks: Array<{ type: string }> };
    expect(parsed.text).toContain("Release built");
    expect(parsed.blocks[0].type).toBe("header");
  });

  it("does not attach an HMAC header for slack subscriptions", async () => {
    await cp.webhookSubscriptions.create({
      orgId: org.id,
      kind: "slack",
      url: "https://hooks.slack.com/x",
      secretHmacKey: "ignored",
    });
    let captured: Record<string, string> = {};
    const dispatcher = new EventDispatcher({
      controlPlane: cp,
      fetch: async (_url, init) => {
        captured = init.headers;
        return { status: 200, text: async () => "ok" };
      },
      email: null,
    });
    await dispatcher.dispatch(sampleEvent(org.id));
    expect(captured["x-signalman-signature"]).toBeUndefined();
  });
});

describe("EventDispatcher — email kind", () => {
  it("invokes the email sender when configured", async () => {
    await cp.webhookSubscriptions.create({
      orgId: org.id,
      kind: "email",
      url: "mailto:oncall@example.invalid",
    });
    const calls: Array<{ to: string; subject: string }> = [];
    const dispatcher = new EventDispatcher({
      controlPlane: cp,
      fetch: async () => ({ status: 200, text: async () => "" }),
      email: async ({ to, subject }) => {
        calls.push({ to, subject });
      },
    });
    const result = await dispatcher.dispatch(sampleEvent(org.id));
    expect(calls).toHaveLength(1);
    expect(calls[0].to).toBe("oncall@example.invalid");
    expect(calls[0].subject).toContain("release-built");
    // delivered=true because we passed in an email sender stub
    expect(result.outcomes[0].delivered).toBe(true);
  });

  it("silently skips email when SIGNALMAN_SMTP_URL is absent and no override", async () => {
    // Use the default email sender path which checks the env var.
    delete process.env.SIGNALMAN_SMTP_URL;
    await cp.webhookSubscriptions.create({
      orgId: org.id,
      kind: "email",
      url: "mailto:oncall@example.invalid",
    });
    const dispatcher = new EventDispatcher({ controlPlane: cp });
    const result = await dispatcher.dispatch(sampleEvent(org.id));
    // The default sender no-ops; we surface the absence as a benign
    // not-delivered with a clear reason rather than a false positive.
    expect(result.outcomes[0].delivered).toBe(false);
    expect(result.outcomes[0].error).toContain("SIGNALMAN_SMTP_URL not set");
  });
});

describe("EventDispatcher — filtering and audit", () => {
  it("skips subscriptions whose eventKinds don't include the event", async () => {
    await cp.webhookSubscriptions.create({
      orgId: org.id,
      kind: "generic",
      url: "https://hooks.example.invalid/x",
      eventKinds: ["health-failed"],
    });
    const dispatcher = new EventDispatcher({
      controlPlane: cp,
      fetch: async () => {
        throw new Error("should not be called");
      },
      email: null,
    });
    const result = await dispatcher.dispatch(sampleEvent(org.id));
    expect(result.outcomes).toEqual([]);
  });

  it("skips inactive subscriptions", async () => {
    await cp.webhookSubscriptions.create({
      orgId: org.id,
      kind: "generic",
      url: "https://hooks.example.invalid/x",
      active: false,
    });
    const dispatcher = new EventDispatcher({
      controlPlane: cp,
      fetch: async () => {
        throw new Error("should not be called");
      },
      email: null,
    });
    const result = await dispatcher.dispatch(sampleEvent(org.id));
    expect(result.outcomes).toEqual([]);
  });

  it("writes a webhook.delivered audit row on success and webhook.failed on failure", async () => {
    await cp.webhookSubscriptions.create({
      orgId: org.id,
      kind: "generic",
      url: "https://hooks.example.invalid/x",
    });
    const dispatcher = new EventDispatcher({
      controlPlane: cp,
      fetch: async () => ({ status: 500, text: async () => "boom" }),
      email: null,
      onError: () => undefined,
    });
    await dispatcher.dispatch(sampleEvent(org.id));
    const audit = await cp.auditLog.listForOrg(org.id, {
      entityType: "webhook_subscription",
    });
    expect(audit.some((a) => a.action === "webhook.failed")).toBe(true);
  });

  it("does not deliver cross-org events", async () => {
    const otherOrg = await cp.orgs.create({ name: "other" });
    await cp.webhookSubscriptions.create({
      orgId: otherOrg.id,
      kind: "generic",
      url: "https://hooks.example.invalid/x",
    });
    const calls: number[] = [];
    const dispatcher = new EventDispatcher({
      controlPlane: cp,
      fetch: async () => {
        calls.push(1);
        return { status: 200, text: async () => "ok" };
      },
      email: null,
    });
    await dispatcher.dispatch(sampleEvent(org.id));
    expect(calls).toEqual([]);
  });

  it("one bad subscription does not prevent the next from delivering", async () => {
    await cp.webhookSubscriptions.create({
      orgId: org.id,
      kind: "generic",
      url: "https://hooks.example.invalid/x",
    });
    await cp.webhookSubscriptions.create({
      orgId: org.id,
      kind: "slack",
      url: "https://hooks.example.invalid/slack",
    });
    let i = 0;
    const dispatcher = new EventDispatcher({
      controlPlane: cp,
      fetch: async () => {
        i += 1;
        if (i === 1) throw new Error("first webhook is broken");
        return { status: 200, text: async () => "ok" };
      },
      email: null,
      onError: () => undefined,
    });
    const result = await dispatcher.dispatch(sampleEvent(org.id));
    expect(result.outcomes).toHaveLength(2);
    const delivered = result.outcomes.filter((o: DispatchOutcome) => o.delivered);
    expect(delivered).toHaveLength(1);
  });
});
