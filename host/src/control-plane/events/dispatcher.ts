/**
 * Event dispatcher (v0.4.0-2 / Epic 2, WS3).
 *
 * Verb-layer code fires events through `EventDispatcher.dispatch(ev)`.
 * The dispatcher loads every active webhook subscription matching the
 * event's org and kind, and routes each through a driver:
 *
 *   * generic — POST JSON to the subscription URL with an
 *     `X-Signalman-Signature: sha256=<hex>` HMAC of the body.
 *   * slack   — same URL is treated as a Slack incoming-webhook;
 *     payload is formatted as Slack blocks.
 *   * email   — `url` is a `mailto:` recipient; SMTP transport is
 *     resolved from `SIGNALMAN_SMTP_URL`. When the env var is absent
 *     the driver no-ops silently (matches the spec: "absent =
 *     silently skip").
 *
 * Failures in any one driver MUST NOT poison the others — each
 * driver invocation is wrapped in try/catch and logged through the
 * audit log + an optional `onError` hook. The dispatcher returns a
 * `DispatchResult` so callers (and tests) can introspect outcomes.
 *
 * The HTTP fetcher is injected so tests can stub it without
 * mocking the global `fetch`.
 */

import type { ControlPlane } from "../index.js";
import type { WebhookSubscription } from "../types.js";
import { SIGNALMAN_SIGNATURE_HEADER, signBody } from "./hmac.js";
import { formatEventForSlack, type SlackPayload } from "./slack.js";
import type { SignalmanEvent } from "./types.js";

export interface DispatchOutcome {
  subscriptionId: string;
  kind: WebhookSubscription["kind"];
  delivered: boolean;
  /** HTTP status on a delivered generic/slack POST; absent for email. */
  status?: number;
  error?: string;
}

export interface DispatchResult {
  event: SignalmanEvent;
  outcomes: DispatchOutcome[];
}

/**
 * Pluggable HTTP transport. Defaults to the global `fetch` so the
 * production path is just `fetch(url, init)`. Tests inject a stub that
 * resolves to a stable response without touching the network.
 */
export type HttpFetcher = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ status: number; text: () => Promise<string> }>;

export type EmailSender = (input: {
  to: string;
  subject: string;
  body: string;
}) => Promise<void>;

export interface DispatcherOptions {
  controlPlane: ControlPlane;
  /** Override the HTTP transport (tests). Defaults to `globalThis.fetch`. */
  fetch?: HttpFetcher;
  /**
   * Override the email transport (tests). Defaults to a nodemailer-
   * backed sender that respects `SIGNALMAN_SMTP_URL`. Set this to a
   * stub in tests; set to `null` to silently drop email events.
   */
  email?: EmailSender | null;
  /**
   * Optional sink for transient delivery errors. Defaults to a stderr
   * JSON log line. Audit-log entries are written unconditionally.
   */
  onError?: (outcome: DispatchOutcome, event: SignalmanEvent) => void;
}

/**
 * Resolve whether a subscription wants this event. An empty
 * `eventKinds` list means "all events" (matches the schema default).
 */
export function subscriptionWantsEvent(
  subscription: WebhookSubscription,
  event: SignalmanEvent,
): boolean {
  if (subscription.eventKinds.length === 0) return true;
  return subscription.eventKinds.includes(event.kind);
}

const DEFAULT_HEADERS: Record<string, string> = {
  "content-type": "application/json; charset=utf-8",
};

/** Resolved nodemailer transport (or null when SMTP isn't configured). */
let smtpTransport: { sendMail: (msg: { from?: string; to: string; subject: string; text: string }) => Promise<unknown> } | null | undefined;

/** Lazy SMTP transport. Returns null when SIGNALMAN_SMTP_URL is absent. */
async function getSmtpTransport(): Promise<{
  sendMail: (msg: { from?: string; to: string; subject: string; text: string }) => Promise<unknown>;
} | null> {
  if (smtpTransport !== undefined) return smtpTransport;
  const url = process.env.SIGNALMAN_SMTP_URL;
  if (!url) {
    smtpTransport = null;
    return null;
  }
  const nodemailer = await import("nodemailer");
  smtpTransport = nodemailer.createTransport(url);
  return smtpTransport;
}

/** For tests — reset the cached SMTP transport. */
export function resetSmtpTransportForTests(): void {
  smtpTransport = undefined;
}

function defaultEmailSender(): EmailSender {
  return async ({ to, subject, body }) => {
    const transport = await getSmtpTransport();
    if (!transport) return; // SIGNALMAN_SMTP_URL absent — silent skip.
    await transport.sendMail({
      from: process.env.SIGNALMAN_SMTP_FROM ?? "signalman@localhost",
      to,
      subject,
      text: body,
    });
  };
}

export class EventDispatcher {
  private readonly fetcher: HttpFetcher;
  private readonly email: EmailSender | null;
  private readonly onError: (
    outcome: DispatchOutcome,
    event: SignalmanEvent,
  ) => void;

  constructor(private readonly opts: DispatcherOptions) {
    this.fetcher = opts.fetch ?? defaultFetcher();
    this.email =
      opts.email === null
        ? null
        : opts.email !== undefined
          ? opts.email
          : defaultEmailSender();
    this.onError = opts.onError ?? defaultOnError;
  }

  /**
   * Walk active subscriptions for this event's org, dispatch each,
   * and return per-subscription outcomes. Never throws — every
   * driver failure becomes a per-outcome `error` so callers can
   * decide whether to surface it (e.g. via `webhook test` CLI) or
   * just keep moving (e.g. the release-build path).
   */
  async dispatch(event: SignalmanEvent): Promise<DispatchResult> {
    const subscriptions =
      await this.opts.controlPlane.webhookSubscriptions.listActive(event.orgId);
    const outcomes: DispatchOutcome[] = [];
    for (const sub of subscriptions) {
      if (!subscriptionWantsEvent(sub, event)) continue;
      const outcome = await this.deliver(sub, event);
      outcomes.push(outcome);
      if (!outcome.delivered) this.onError(outcome, event);
      // Audit every delivery attempt; the dispatcher is the operator's
      // primary surface for "did my webhook fire and did it work".
      try {
        await this.opts.controlPlane.auditLog.append({
          orgId: event.orgId,
          actor: "dispatcher",
          action: outcome.delivered
            ? "webhook.delivered"
            : "webhook.failed",
          entityType: "webhook_subscription",
          entityId: sub.id,
          detail: {
            event: event.kind,
            status: outcome.status,
            error: outcome.error,
          },
        });
      } catch {
        // Audit-log write failed (closed DB during shutdown?). Don't
        // crash the dispatcher — the per-outcome record is still
        // returned to the caller.
      }
    }
    return { event, outcomes };
  }

  /** Send a single subscription. Exposed for `webhook test`. */
  async deliver(
    sub: WebhookSubscription,
    event: SignalmanEvent,
  ): Promise<DispatchOutcome> {
    try {
      switch (sub.kind) {
        case "generic":
          return await this.deliverGeneric(sub, event);
        case "slack":
          return await this.deliverSlack(sub, event);
        case "email":
          return await this.deliverEmail(sub, event);
        default: {
          const exhaustive: never = sub.kind;
          throw new Error(`unknown webhook kind: ${exhaustive as string}`);
        }
      }
    } catch (err) {
      return {
        subscriptionId: sub.id,
        kind: sub.kind,
        delivered: false,
        error: (err as Error).message,
      };
    }
  }

  private async deliverGeneric(
    sub: WebhookSubscription,
    event: SignalmanEvent,
  ): Promise<DispatchOutcome> {
    const body = JSON.stringify(event);
    const headers: Record<string, string> = { ...DEFAULT_HEADERS };
    if (sub.secretHmacKey && sub.secretHmacKey.length > 0) {
      headers[SIGNALMAN_SIGNATURE_HEADER] = signBody(sub.secretHmacKey, body);
    }
    const resp = await this.fetcher(sub.url, {
      method: "POST",
      headers,
      body,
    });
    const ok = resp.status >= 200 && resp.status < 300;
    return {
      subscriptionId: sub.id,
      kind: sub.kind,
      delivered: ok,
      status: resp.status,
      error: ok ? undefined : `non-2xx response: ${resp.status}`,
    };
  }

  private async deliverSlack(
    sub: WebhookSubscription,
    event: SignalmanEvent,
  ): Promise<DispatchOutcome> {
    const payload: SlackPayload = formatEventForSlack(event);
    const body = JSON.stringify(payload);
    const resp = await this.fetcher(sub.url, {
      method: "POST",
      headers: { ...DEFAULT_HEADERS },
      body,
    });
    const ok = resp.status >= 200 && resp.status < 300;
    return {
      subscriptionId: sub.id,
      kind: sub.kind,
      delivered: ok,
      status: resp.status,
      error: ok ? undefined : `slack non-2xx: ${resp.status}`,
    };
  }

  private async deliverEmail(
    sub: WebhookSubscription,
    event: SignalmanEvent,
  ): Promise<DispatchOutcome> {
    if (this.email === null) {
      // Tests opted into "no email at all" by passing email: null.
      return {
        subscriptionId: sub.id,
        kind: sub.kind,
        delivered: false,
        error: "email transport disabled",
      };
    }
    const to = sub.url.startsWith("mailto:") ? sub.url.slice("mailto:".length) : sub.url;
    const subject = `[signalman] ${event.kind}`;
    const body = JSON.stringify(event, null, 2);
    await this.email({ to, subject, body });
    // The email sender is fire-and-forget at the transport level
    // (nodemailer resolves once the message is queued / accepted).
    // If SIGNALMAN_SMTP_URL is absent the default sender no-ops,
    // which we surface as `delivered: false` with a benign reason so
    // the operator-facing audit log isn't misleading.
    const smtpConfigured =
      Boolean(process.env.SIGNALMAN_SMTP_URL) || this.opts.email !== undefined;
    return {
      subscriptionId: sub.id,
      kind: sub.kind,
      delivered: smtpConfigured,
      error: smtpConfigured ? undefined : "SIGNALMAN_SMTP_URL not set",
    };
  }
}

function defaultFetcher(): HttpFetcher {
  return async (url, init) => {
    const resp = await fetch(url, {
      method: init.method,
      headers: init.headers,
      body: init.body,
    });
    return {
      status: resp.status,
      text: () => resp.text(),
    };
  };
}

function defaultOnError(outcome: DispatchOutcome, event: SignalmanEvent): void {
  process.stderr.write(
    JSON.stringify({
      source: "signalman-dispatcher",
      kind: "delivery-failed",
      event: event.kind,
      subscriptionId: outcome.subscriptionId,
      driver: outcome.kind,
      status: outcome.status,
      error: outcome.error,
    }) + "\n",
  );
}
