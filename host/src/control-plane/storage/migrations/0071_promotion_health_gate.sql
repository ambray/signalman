-- v0.4.x (WS6 M7): per-policy health gate for auto-promotion.
--
-- A promotion policy may declare a `health_gate` in its
-- `gate_config_json`:
--
--   { "health_gate": { "min_pass_count": 3, "window_minutes": 30 } }
--
-- When a tier-to-tier listener fires with such a policy AND the policy
-- has a non-null source_target_id, the approval row is created with
-- `requires_health_gate = 1` instead of auto-firing the deploy. The
-- promotion tick enumerates these rows, looks up the source-target's
-- active deployment for the release, counts recent health-check
-- passes, and fires the deploy once min_pass_count consecutive recent
-- passes have accrued within window_minutes of now.
--
-- Manual approvals override this gate: an operator-driven
-- signalman_promotion_approve fires the deploy regardless of health
-- state. The gate exists to defer AUTO promotion until verified, not
-- to block explicit operator action.
--
-- Default 0 preserves back-compat — every existing approval is
-- not-health-gated, matching the current behaviour. The partial index
-- below makes the tick-time scan cheap regardless of how many
-- post-deploy approvals accumulate over time.

ALTER TABLE approval
  ADD COLUMN requires_health_gate INTEGER NOT NULL DEFAULT 0;

CREATE INDEX approval_health_gate_idx
  ON approval (requires_health_gate, status)
  WHERE deleted_at IS NULL
    AND requires_health_gate = 1
    AND status = 'pending';
