/**
 * Cloud cost estimation table (v0.3.0-5 sub-task 5, control 2 of 3).
 *
 * Static SKU × region → cents-per-hour lookup, used by the budget
 * gate at provision time and by the pre-flight stack-plan cost
 * estimate at deploy time. Design §13.5 acknowledges this as
 * "naive at first" — accurate enough to catch obvious budget
 * exhaustion, not accurate enough to bill against. The numbers
 * here come from AWS + Azure list prices (Linux on-demand,
 * us-east-1 / eastus benchmarks) as of 2026-Q1; precision-mode
 * pricing lands as a v0.3.x follow-up via a real vendor pricing
 * API integration.
 *
 * # Locked design
 *
 * - **Static table, not API call.** Real pricing APIs (AWS Price
 *   List, Azure RateCard) take seconds per query, require their
 *   own auth, and add a network dependency to a hot path that
 *   already gates every provision. Static estimates fail safe
 *   toward "the operator's bill" — high estimates over-protect
 *   and under-estimates only matter when actual usage is at the
 *   budget edge, which is when the operator wants the API price
 *   integration anyway.
 * - **Unknown SKU falls back to {@link UNKNOWN_SKU_FALLBACK_CENTS_PER_HOUR}.**
 *   Returns a relatively high default so that an instance type
 *   we haven't priced still consumes meaningful budget — better
 *   to over-charge an experimental SKU than have it slip past
 *   the gate.
 * - **Region multiplier is applied separately.** The base SKU
 *   rate is one column; region-multiplier (premium regions cost
 *   slightly more) is another. Keeps the table small while
 *   capturing the real-world spread.
 */

// ── Constants ──────────────────────────────────────────────────────

/**
 * Fallback rate used when a SKU is not in the table. Chosen high
 * enough that an unpriced SKU still consumes meaningful budget —
 * see locked design note above.
 */
export const UNKNOWN_SKU_FALLBACK_CENTS_PER_HOUR = 50;

/**
 * Default region multiplier when the region is absent from the
 * table. 1.0 (no premium / discount).
 */
export const DEFAULT_REGION_MULTIPLIER = 1.0;

// ── Tables ─────────────────────────────────────────────────────────

/**
 * Base cents/hour rate per SKU on the cheapest region. Region
 * multipliers (see {@link REGION_MULTIPLIERS}) tweak this for
 * premium regions.
 *
 * Spot prices and reserved-instance pricing are explicitly out of
 * scope — the static table represents on-demand only.
 */
export const SKU_CENTS_PER_HOUR: Readonly<Record<string, number>> = Object.freeze({
  // ── AWS EC2 Linux on-demand (cents/hour rounded to integer) ──
  "t3.micro": 1,
  "t3.small": 2,
  "t3.medium": 4,
  "t3.large": 8,
  "t3.xlarge": 17,
  "t3.2xlarge": 33,
  "m5.large": 10,
  "m5.xlarge": 19,
  "m5.2xlarge": 38,
  "m5.4xlarge": 77,
  "c5.large": 9,
  "c5.xlarge": 17,
  "c5.2xlarge": 34,
  "r5.large": 13,
  "r5.xlarge": 25,
  // ── Azure VM Linux pay-as-you-go (cents/hour rounded to integer) ──
  "Standard_B1s": 1,
  "Standard_B2s": 4,
  "Standard_B2ms": 8,
  "Standard_D2s_v3": 10,
  "Standard_D4s_v3": 19,
  "Standard_D8s_v3": 38,
  "Standard_D2as_v5": 9,
  "Standard_D4as_v5": 18,
  "Standard_F2s_v2": 9,
  "Standard_F4s_v2": 17,
  "Standard_E2s_v3": 13,
  "Standard_E4s_v3": 25,
});

/**
 * Per-region multiplier applied to the base SKU rate. Premium
 * regions (most of Asia-Pacific) cost slightly more. Numbers are
 * approximate; precision pricing is a v0.3.x followup.
 */
export const REGION_MULTIPLIERS: Readonly<Record<string, number>> = Object.freeze({
  // ── AWS ──
  "us-east-1": 1.0,
  "us-east-2": 1.0,
  "us-west-1": 1.05,
  "us-west-2": 1.0,
  "eu-west-1": 1.05,
  "eu-central-1": 1.1,
  "ap-southeast-1": 1.15,
  "ap-northeast-1": 1.2,
  // ── Azure ──
  eastus: 1.0,
  eastus2: 1.0,
  westus2: 1.0,
  northeurope: 1.05,
  westeurope: 1.1,
  southeastasia: 1.15,
  japaneast: 1.2,
});

// ── Lookup ─────────────────────────────────────────────────────────

/**
 * Compute the estimated cost in **cents** for an instance with
 * the given SKU + region + lifetime. Falls back gracefully to
 * {@link UNKNOWN_SKU_FALLBACK_CENTS_PER_HOUR} +
 * {@link DEFAULT_REGION_MULTIPLIER} when the table is missing
 * the SKU / region.
 *
 * The result is always a non-negative integer (cents rounded
 * up). Hours are computed from `ttlMinutes / 60` with no minimum
 * — short-lived ephemeral VMs that finish before an hour still
 * accrue prorated cost.
 *
 * @param sku            Instance type / VM size (AWS "t3.medium",
 *                       Azure "Standard_D2s_v3", etc).
 * @param region         Provider region.
 * @param ttlMinutes     Lifetime in minutes. Must be > 0.
 * @returns              Estimated cost in cents (integer, rounded up).
 */
export function estimateInstanceCostCents(
  sku: string,
  region: string,
  ttlMinutes: number,
): number {
  if (!Number.isFinite(ttlMinutes) || ttlMinutes <= 0) return 0;
  const rate =
    SKU_CENTS_PER_HOUR[sku] ?? UNKNOWN_SKU_FALLBACK_CENTS_PER_HOUR;
  const multiplier =
    REGION_MULTIPLIERS[region] ?? DEFAULT_REGION_MULTIPLIER;
  const hours = ttlMinutes / 60;
  // Round up so partial-hour usage doesn't slip under the gate.
  return Math.ceil(rate * multiplier * hours);
}

/**
 * Return the per-hour rate (in cents) for a SKU + region, useful
 * for pre-flight cost estimates over indefinite-lifetime resources
 * (e.g. an OpenTofu stack that will stay applied for a month).
 */
export function hourlyRateCents(sku: string, region: string): number {
  const rate =
    SKU_CENTS_PER_HOUR[sku] ?? UNKNOWN_SKU_FALLBACK_CENTS_PER_HOUR;
  const multiplier =
    REGION_MULTIPLIERS[region] ?? DEFAULT_REGION_MULTIPLIER;
  return Math.ceil(rate * multiplier);
}

/**
 * Return monthly-cost estimate (in cents) for indefinite-lifetime
 * resources. 730 hours = average month length used by AWS in
 * their billing docs.
 */
export function monthlyRateCents(sku: string, region: string): number {
  return Math.ceil(hourlyRateCents(sku, region) * 730);
}
