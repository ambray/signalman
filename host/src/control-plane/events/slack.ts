/**
 * Slack-payload formatter for the v0.4.0-2 webhook dispatcher.
 *
 * Renders a `SignalmanEvent` into Slack's "incoming webhook" payload
 * shape — a top-level `text` (used as the notification fallback) plus
 * a `blocks` array for the rich-formatted message body. The Slack
 * docs call this Block Kit; the inner shapes are intentionally
 * permissive (Slack adds new block kinds over time) so we stop at
 * `section`/`header`/`context`, which renders well in every Slack
 * client we care about.
 *
 * Receivers don't sign Slack messages — Slack incoming webhooks
 * authenticate the SENDER via the webhook URL itself, not via a
 * shared HMAC.
 */

import type { SignalmanEvent } from "./types.js";

export interface SlackBlock {
  type: string;
  [key: string]: unknown;
}

export interface SlackPayload {
  text: string;
  blocks: SlackBlock[];
}

export function formatEventForSlack(event: SignalmanEvent): SlackPayload {
  switch (event.kind) {
    case "release-built": {
      const text = `Release built: ${event.productName}@${event.tag}`;
      return {
        text,
        blocks: [
          headerBlock(text),
          sectionBlock([
            mdField("Product", event.productName),
            mdField("Tag", event.tag),
            mdField("Release id", event.releaseId),
            mdField(
              "Manifest sha256",
              event.manifestSha256 ?? "(unsigned)",
            ),
          ]),
          contextBlock(`at ${event.at}`),
        ],
      };
    }
    case "release-deployed": {
      const summary = event.healthSummary
        ? `${event.healthSummary.pass}/${event.healthSummary.total} probes passed`
        : "(no health summary)";
      const text = `Release deployed → ${event.targetName} (${event.status})`;
      return {
        text,
        blocks: [
          headerBlock(text),
          sectionBlock([
            mdField("Target", event.targetName),
            mdField("Release id", event.releaseId),
            mdField("Deployment id", event.deploymentId),
            mdField("Status", event.status),
            mdField("Health", summary),
          ]),
          contextBlock(`at ${event.at}`),
        ],
      };
    }
    case "deployment-rolled-back": {
      const text = `Deployment rolled back on ${event.targetName}`;
      return {
        text,
        blocks: [
          headerBlock(text),
          sectionBlock([
            mdField("Target", event.targetName),
            mdField("Deployment id", event.deploymentId),
            mdField("Release id", event.releaseId),
          ]),
          contextBlock(`at ${event.at}`),
        ],
      };
    }
    case "health-failed": {
      const failed = event.probes
        .filter((p) => p.status === "fail")
        .map((p) => p.name)
        .join(", ");
      const text = event.reachable
        ? `Health failed on ${event.targetId}: ${failed || "(no failed probes — see detail)"}`
        : `Target unreachable: ${event.targetId}`;
      return {
        text,
        blocks: [
          headerBlock(text),
          sectionBlock([
            mdField("Target id", event.targetId),
            mdField(
              "Deployment id",
              event.deploymentId ?? "(none — schedule has no active deployment)",
            ),
            mdField("Reachable", event.reachable ? "yes" : "no"),
            mdField("Failed probes", failed || "(none)"),
          ]),
          contextBlock(`at ${event.at}`),
        ],
      };
    }
    case "promotion-approved": {
      const text = `Promotion approved → ${event.targetName}`;
      return {
        text,
        blocks: [
          headerBlock(text),
          sectionBlock([
            mdField("Target", event.targetName),
            mdField("Promotion id", event.promotionId),
            mdField("Release id", event.releaseId),
            mdField("Policy id", event.policyId),
            mdField("Approval id", event.approvalId ?? "(auto)"),
          ]),
          contextBlock(`at ${event.at}`),
        ],
      };
    }
    case "promotion-rejected": {
      const text = `Promotion rejected: ${event.targetName}`;
      return {
        text,
        blocks: [
          headerBlock(text),
          sectionBlock([
            mdField("Target", event.targetName),
            mdField("Promotion id", event.promotionId),
            mdField("Release id", event.releaseId),
            mdField("Approval id", event.approvalId),
            mdField("Reason", event.reason ?? "(no reason given)"),
          ]),
          contextBlock(`at ${event.at}`),
        ],
      };
    }
    default: {
      const exhaustive: never = event;
      throw new Error(`unhandled event kind: ${JSON.stringify(exhaustive)}`);
    }
  }
}

function headerBlock(text: string): SlackBlock {
  return {
    type: "header",
    text: { type: "plain_text", text, emoji: false },
  };
}

function sectionBlock(fields: Array<{ type: "mrkdwn"; text: string }>): SlackBlock {
  return { type: "section", fields };
}

function contextBlock(text: string): SlackBlock {
  return { type: "context", elements: [{ type: "mrkdwn", text }] };
}

function mdField(label: string, value: string): { type: "mrkdwn"; text: string } {
  return { type: "mrkdwn", text: `*${label}*\n${value}` };
}
