/**
 * v0.3.0-5 sub-task 5 — cost-estimation table (cloud/cost.ts).
 *
 * Pure unit tests over the static SKU × region × hours lookup.
 * Integration + system layers exercise the budget gate that
 * consumes these estimates (cloud-budget.test.ts).
 */

import { describe, it, expect } from "vitest";
import {
  estimateInstanceCostCents,
  hourlyRateCents,
  monthlyRateCents,
  REGION_MULTIPLIERS,
  SKU_CENTS_PER_HOUR,
  UNKNOWN_SKU_FALLBACK_CENTS_PER_HOUR,
  DEFAULT_REGION_MULTIPLIER,
} from "../cloud/cost.js";

describe("estimateInstanceCostCents — pricing math", () => {
  it("computes a known SKU + region for a 60-minute lifetime", () => {
    // t3.medium = 4¢/hr at us-east-1 (multiplier 1.0).
    expect(estimateInstanceCostCents("t3.medium", "us-east-1", 60)).toBe(4);
  });

  it("applies the region multiplier", () => {
    // t3.medium = 4¢/hr; ap-northeast-1 multiplier = 1.2.
    // 4 * 1.2 * (60/60) = 4.8 → ceil = 5.
    expect(estimateInstanceCostCents("t3.medium", "ap-northeast-1", 60)).toBe(5);
  });

  it("prorates partial-hour usage", () => {
    // t3.medium = 4¢/hr; 30 minutes = 0.5h. 4 * 0.5 = 2¢.
    expect(estimateInstanceCostCents("t3.medium", "us-east-1", 30)).toBe(2);
  });

  it("rounds up partial-hour usage (operator-favouring)", () => {
    // t3.small = 2¢/hr; 15 minutes = 0.25h. 2 * 0.25 = 0.5 → ceil = 1.
    expect(estimateInstanceCostCents("t3.small", "us-east-1", 15)).toBe(1);
  });

  it("falls back to UNKNOWN_SKU rate when SKU is missing", () => {
    expect(
      estimateInstanceCostCents("unknown-sku-12345", "us-east-1", 60),
    ).toBe(UNKNOWN_SKU_FALLBACK_CENTS_PER_HOUR);
  });

  it("falls back to default multiplier when region is missing", () => {
    // t3.medium = 4¢/hr; unknown region uses 1.0 multiplier.
    expect(estimateInstanceCostCents("t3.medium", "mars-1", 60)).toBe(4);
  });

  it("returns 0 for non-positive ttlMinutes", () => {
    expect(estimateInstanceCostCents("t3.medium", "us-east-1", 0)).toBe(0);
    expect(estimateInstanceCostCents("t3.medium", "us-east-1", -5)).toBe(0);
    expect(estimateInstanceCostCents("t3.medium", "us-east-1", NaN)).toBe(0);
  });

  it("covers both AWS and Azure SKUs", () => {
    expect(SKU_CENTS_PER_HOUR["t3.medium"]).toBeDefined();
    expect(SKU_CENTS_PER_HOUR["Standard_D2s_v3"]).toBeDefined();
  });

  it("covers both AWS and Azure regions", () => {
    expect(REGION_MULTIPLIERS["us-east-1"]).toBeDefined();
    expect(REGION_MULTIPLIERS["eastus"]).toBeDefined();
  });

  it("DEFAULT_REGION_MULTIPLIER is 1.0 (no premium)", () => {
    expect(DEFAULT_REGION_MULTIPLIER).toBe(1.0);
  });
});

describe("hourlyRateCents + monthlyRateCents", () => {
  it("hourlyRateCents matches the SKU table for known entries", () => {
    expect(hourlyRateCents("t3.medium", "us-east-1")).toBe(4);
  });

  it("hourlyRateCents applies region multiplier", () => {
    expect(hourlyRateCents("t3.medium", "ap-northeast-1")).toBe(5);
  });

  it("monthlyRateCents is hourly × 730 (AWS-billing-month convention)", () => {
    expect(monthlyRateCents("t3.medium", "us-east-1")).toBe(4 * 730);
  });

  it("hourlyRateCents falls back to UNKNOWN_SKU for unpriced SKUs", () => {
    expect(hourlyRateCents("unpriced-sku", "us-east-1")).toBe(
      UNKNOWN_SKU_FALLBACK_CENTS_PER_HOUR,
    );
  });
});
