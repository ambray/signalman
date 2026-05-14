/**
 * Per-org cloud-spend budget gate (v0.3.0-5 sub-task 5, control 2 of 3).
 *
 * Sits in front of `CloudBackend.provisionInstance` calls.
 * Two gates per design §13.5:
 *   - **Soft warning at `soft_warn_pct`** (default 80) — the gate
 *     returns `{ allowed: true, warned: true }` so callers can
 *     surface a heads-up to operators without blocking the
 *     provision.
 *   - **Hard refusal at 100%** — the gate throws
 *     `CloudBackendError("budget_exceeded", ...)` so the
 *     provision aborts before any vendor API call.
 *
 * # Locked design
 *
 * - **Absence of a budget row = unlimited.** Back-compat for orgs
 *   that haven't opted in. The gate returns `allowed: true, warned:
 *   false` and does not query usage. Operators who want budget
 *   enforcement explicitly create a `cloud_org_budget` row.
 * - **Billing month = calendar month UTC.** Simpler than aligning
 *   to AWS / Azure billing cycles (which differ from each other
 *   and from the operator's fiscal month anyway). Operators that
 *   need fiscal-month accounting roll their own dashboards over
 *   the audit log; this gate is the protect-the-bill knob.
 * - **Estimated cost from {@link estimateInstanceCostCents}.**
 *   Static SKU × region × hours. See `cost.ts` for design notes.
 * - **Module-level singleton for the wired-in gate.** AWS + Azure
 *   provision paths call `getBudgetGate()?.check()` lazily.
 *   `setBudgetGate(gate?)` sets / clears the singleton at host
 *   startup (or in tests). When unset, provisions proceed
 *   without checking — back-compat with operators that haven't
 *   wired storage yet.
 */

import {
  CloudBackendError,
  DEFAULT_INSTANCE_TTL_MINUTES,
  type CloudInstanceConfig,
} from "./types.js";
import type {
  CloudBudgetRepo,
  CloudUsageRepo,
} from "../control-plane/storage/driver.js";
import { estimateInstanceCostCents } from "./cost.js";

// ── Result shape ──────────────────────────────────────────────────

export interface BudgetCheckResult {
  /** Whether the provision can proceed. False ⇒ the gate threw. */
  allowed: true;
  /** True when usage has crossed the org's soft warn percentage. */
  warned: boolean;
  /** Usage in cents (sum of estimated_cents for current month). */
  usageCents: number;
  /** Configured monthly limit in cents (Infinity when no budget). */
  limitCents: number;
  /** Estimated cost in cents added by this provision. */
  estimatedCents: number;
  /** Percentage of limit consumed AFTER adding estimatedCents. */
  pctAfter: number;
}

// ── Helpers ────────────────────────────────────────────────────────

/**
 * Return the [start, end) UTC bounds for the calendar month
 * containing `at`. Used by the gate's usage-sum query.
 */
export function monthBoundsUtc(at: Date): {
  startedAtFrom: string;
  startedAtTo: string;
} {
  const start = new Date(
    Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1, 0, 0, 0, 0),
  );
  const end = new Date(
    Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1, 0, 0, 0, 0),
  );
  return {
    startedAtFrom: start.toISOString(),
    startedAtTo: end.toISOString(),
  };
}

// ── Gate class ─────────────────────────────────────────────────────

export interface BudgetGateOptions {
  budgets: CloudBudgetRepo;
  usage: CloudUsageRepo;
  /** Injectable clock. Defaults to `() => new Date()`. */
  now?: () => Date;
}

export class CloudBudgetGate {
  private readonly budgets: CloudBudgetRepo;
  private readonly usage: CloudUsageRepo;
  private readonly now: () => Date;

  constructor(opts: BudgetGateOptions) {
    this.budgets = opts.budgets;
    this.usage = opts.usage;
    this.now = opts.now ?? (() => new Date());
  }

  /**
   * Check whether an upcoming provision fits within the org's
   * budget. Returns the result on success; throws
   * `CloudBackendError("budget_exceeded", ...)` on hard refusal.
   *
   * Computing the estimate is the caller's responsibility (so
   * the gate stays storage-only and the cost-table logic stays
   * in `cost.ts`). The convenience method
   * {@link checkForConfig} wraps `estimateInstanceCostCents` for
   * the common provision path.
   */
  async check(orgId: string, estimatedCents: number): Promise<BudgetCheckResult> {
    const budget = await this.budgets.get(orgId);
    if (!budget) {
      // No budget configured = unlimited.
      return {
        allowed: true,
        warned: false,
        usageCents: 0,
        limitCents: Number.POSITIVE_INFINITY,
        estimatedCents,
        pctAfter: 0,
      };
    }
    const { startedAtFrom, startedAtTo } = monthBoundsUtc(this.now());
    const usageCents = await this.usage.sumForRange({
      orgId,
      startedAtFrom,
      startedAtTo,
    });
    const projected = usageCents + estimatedCents;
    const pctAfter = (projected / budget.monthlyCentsLimit) * 100;
    if (projected > budget.monthlyCentsLimit) {
      throw new CloudBackendError(
        "budget_exceeded",
        `org '${orgId}' would exceed budget: usage=${usageCents}¢ + ` +
          `estimate=${estimatedCents}¢ = ${projected}¢ > ` +
          `limit=${budget.monthlyCentsLimit}¢ ` +
          `(${pctAfter.toFixed(1)}% of monthly budget).`,
      );
    }
    return {
      allowed: true,
      warned: pctAfter >= budget.softWarnPct,
      usageCents,
      limitCents: budget.monthlyCentsLimit,
      estimatedCents,
      pctAfter,
    };
  }

  /**
   * Convenience wrapper: derive the estimate from
   * `CloudInstanceConfig` (using the static cost table) and call
   * {@link check}. Equivalent to the path the AWS / Azure
   * `provisionInstance` flows use.
   */
  async checkForConfig(config: CloudInstanceConfig): Promise<BudgetCheckResult> {
    const orgId = config.org_id ?? "default";
    const ttlMinutes = config.ttl_minutes ?? DEFAULT_INSTANCE_TTL_MINUTES;
    const estimatedCents = estimateInstanceCostCents(
      config.instance_type,
      config.region,
      ttlMinutes,
    );
    return this.check(orgId, estimatedCents);
  }

  /**
   * Record a successful provision in the usage table. Called by
   * the backend's provisionInstance after the vendor API returns
   * a running handle.
   */
  async recordStart(input: {
    orgId: string;
    backend: string;
    instanceId: string;
    instanceType: string;
    region: string;
    ttlMinutes: number;
  }): Promise<void> {
    const estimatedCents = estimateInstanceCostCents(
      input.instanceType,
      input.region,
      input.ttlMinutes,
    );
    await this.usage.recordStart({
      orgId: input.orgId,
      backend: input.backend,
      instanceId: input.instanceId,
      instanceType: input.instanceType,
      region: input.region,
      startedAt: this.now().toISOString(),
      estimatedCents,
    });
  }

  /**
   * Record a terminate in the usage table. Idempotent (the repo
   * silently no-ops on unknown rows) — matches the backend's
   * terminateInstance contract.
   */
  async recordTerminate(input: {
    orgId: string;
    instanceId: string;
  }): Promise<void> {
    await this.usage.recordTerminate({
      orgId: input.orgId,
      instanceId: input.instanceId,
      terminatedAt: this.now().toISOString(),
    });
  }
}

// ── Module-level singleton ────────────────────────────────────────

let singleton: CloudBudgetGate | null = null;

/**
 * Set (or clear) the process-wide gate. Called once at host
 * startup once storage is wired; cleared by tests between cases.
 *
 * Pass `null` to disable the gate (provisions proceed without
 * checking — the v0.2.0 back-compat path).
 */
export function setBudgetGate(gate: CloudBudgetGate | null): void {
  singleton = gate;
}

/**
 * Return the wired gate, or `null` if none is set. AWS + Azure
 * backends call this lazily on provisionInstance. When null,
 * provisions proceed without a budget check (back-compat).
 */
export function getBudgetGate(): CloudBudgetGate | null {
  return singleton;
}
