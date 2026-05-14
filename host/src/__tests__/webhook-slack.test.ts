/**
 * Unit tests for the Slack-payload formatter (Epic 2 / WS3).
 */

import { describe, expect, it } from "vitest";
import {
  formatEventForSlack,
  type SignalmanEvent,
} from "../control-plane/events/index.js";

const BASE_AT = "2026-05-14T12:00:00.000Z";

describe("formatEventForSlack", () => {
  it("renders release-built with header + section + context blocks", () => {
    const ev: SignalmanEvent = {
      kind: "release-built",
      orgId: "org-1",
      at: BASE_AT,
      releaseId: "rel-1",
      productName: "p",
      tag: "v1.0.0",
      manifestSha256: "abc123",
    };
    const payload = formatEventForSlack(ev);
    expect(payload.text).toContain("Release built");
    expect(payload.blocks[0].type).toBe("header");
    expect(payload.blocks[1].type).toBe("section");
    expect(payload.blocks[2].type).toBe("context");
    // The section fields include the manifest sha
    expect(JSON.stringify(payload)).toContain("abc123");
  });

  it("renders release-deployed and reflects the health summary", () => {
    const payload = formatEventForSlack({
      kind: "release-deployed",
      orgId: "org-1",
      at: BASE_AT,
      deploymentId: "dep",
      releaseId: "rel",
      targetName: "demo",
      status: "active",
      healthSummary: { total: 5, pass: 5, fail: 0 },
    });
    expect(payload.text).toContain("→ demo");
    expect(JSON.stringify(payload)).toContain("5/5 probes passed");
  });

  it("renders deployment-rolled-back", () => {
    const payload = formatEventForSlack({
      kind: "deployment-rolled-back",
      orgId: "org-1",
      at: BASE_AT,
      deploymentId: "dep",
      releaseId: "rel",
      targetName: "demo",
    });
    expect(payload.text).toContain("rolled back on demo");
  });

  it("renders health-failed with failed probe names", () => {
    const payload = formatEventForSlack({
      kind: "health-failed",
      orgId: "org-1",
      at: BASE_AT,
      scheduleId: "sched-1",
      targetId: "tgt-1",
      deploymentId: "dep-1",
      reachable: true,
      probes: [
        { name: "smoke", status: "pass" },
        { name: "canary", status: "fail" },
      ],
    });
    expect(payload.text).toContain("Health failed on tgt-1");
    expect(JSON.stringify(payload)).toContain("canary");
  });

  it("renders health-failed with reachable=false as 'unreachable'", () => {
    const payload = formatEventForSlack({
      kind: "health-failed",
      orgId: "org-1",
      at: BASE_AT,
      scheduleId: null,
      targetId: "tgt-1",
      deploymentId: null,
      reachable: false,
      probes: [],
    });
    expect(payload.text).toContain("unreachable");
  });

  it("renders promotion-approved (auto vs manual approval id)", () => {
    const auto = formatEventForSlack({
      kind: "promotion-approved",
      orgId: "org-1",
      at: BASE_AT,
      promotionId: "p1",
      approvalId: null,
      policyId: "pol",
      releaseId: "r",
      targetName: "demo",
    });
    expect(JSON.stringify(auto)).toContain("(auto)");

    const manual = formatEventForSlack({
      kind: "promotion-approved",
      orgId: "org-1",
      at: BASE_AT,
      promotionId: "p1",
      approvalId: "appr-1",
      policyId: "pol",
      releaseId: "r",
      targetName: "demo",
    });
    expect(JSON.stringify(manual)).toContain("appr-1");
  });

  it("renders promotion-rejected with reason", () => {
    const payload = formatEventForSlack({
      kind: "promotion-rejected",
      orgId: "org-1",
      at: BASE_AT,
      promotionId: "p1",
      approvalId: "appr-1",
      policyId: "pol",
      releaseId: "r",
      targetName: "demo",
      reason: "manual veto",
    });
    expect(payload.text).toContain("Promotion rejected");
    expect(JSON.stringify(payload)).toContain("manual veto");
  });

  it("renders promotion-rejected without reason as '(no reason given)'", () => {
    const payload = formatEventForSlack({
      kind: "promotion-rejected",
      orgId: "org-1",
      at: BASE_AT,
      promotionId: "p1",
      approvalId: "appr-1",
      policyId: "pol",
      releaseId: "r",
      targetName: "demo",
      reason: null,
    });
    expect(JSON.stringify(payload)).toContain("no reason given");
  });
});
