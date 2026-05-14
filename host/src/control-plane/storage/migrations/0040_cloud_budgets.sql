-- Cloud cost-guardrails — per-org budgets + usage tracking.
-- See docs/design/meta-build-system.md §13.5 control 2.
--
-- Two tables:
--   * cloud_org_budget  — one row per org with a configured limit.
--                         Absence = no budget = unlimited (back-compat).
--   * cloud_org_usage   — per-instance row recording the estimated
--                         cost. The budget gate sums rows for the
--                         current billing month at provision time.
--
-- The migration block 0040-0049 is reserved for sub-task 5 cloud
-- guardrails per docs/workstreams/PLAN.md. Other workstreams pick
-- from 0050+ to avoid collision when consolidating.
--
-- soft_warn_pct lets operators tune the warning threshold per org
-- (default 80% per §13.5). The gate emits a warning event when
-- usage crosses this boundary; refusal at 100% is hard-coded.

CREATE TABLE IF NOT EXISTS cloud_org_budget (
  org_id              TEXT PRIMARY KEY NOT NULL,
  monthly_cents_limit INTEGER NOT NULL CHECK (monthly_cents_limit > 0),
  soft_warn_pct       INTEGER NOT NULL DEFAULT 80
                      CHECK (soft_warn_pct BETWEEN 1 AND 100),
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cloud_org_usage (
  id              TEXT PRIMARY KEY NOT NULL,
  org_id          TEXT NOT NULL,
  backend         TEXT NOT NULL,
  instance_id     TEXT NOT NULL,
  instance_type   TEXT NOT NULL,
  region          TEXT NOT NULL,
  started_at      TEXT NOT NULL,
  terminated_at   TEXT,
  estimated_cents INTEGER NOT NULL CHECK (estimated_cents >= 0)
);

-- One usage row per (org, instance) — re-recording the same instance
-- is a programmer error, not a workflow.
CREATE UNIQUE INDEX IF NOT EXISTS cloud_org_usage_by_org_instance
  ON cloud_org_usage (org_id, instance_id);

-- The budget gate's hot query: sum(estimated_cents) WHERE org_id=?
-- AND started_at >= <month-start>. The (org_id, started_at) prefix
-- lets the planner range-scan only this month's rows.
CREATE INDEX IF NOT EXISTS cloud_org_usage_by_org_month
  ON cloud_org_usage (org_id, started_at);
