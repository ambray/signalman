-- v0.4.0-1 (Epic 1, WS3): auto-promotion + approval gates.
--
-- A promotion policy says: "when a release of <product> lands at
-- <source_target> (or is freshly built when source_target_id IS NULL),
-- promote it onto <dest_target> using <gate_kind> semantics."
--
-- gate_kind values:
--   * auto       — the listener triggers deploy immediately (no
--                  approval row needed).
--   * manual     — the listener creates a `pending` approval; an
--                  operator must `signalman promotion approve <id>`
--                  before the deploy fires.
--   * time_delay — same as manual, but with an `auto_approve_at`
--                  timestamp on the approval row. The promotion tick
--                  flips matching pending rows to `approved` once
--                  `now >= auto_approve_at` and triggers the deploy.
--
-- `gate_config_json` is the kind-specific config blob — e.g.
-- `{ "delay_seconds": 600 }` for `time_delay`, or
-- `{ "approvers": ["alice@example"] }` for `manual` (audit-trail use
-- today; v0.5+ may gate by approver list).
--
-- `approval` is the operator-decision ledger. One row per attempted
-- promotion. Status transitions:
--    pending → approved → (deploy triggered)
--            → rejected
-- After deploy_attempted_at is set the row is terminal; subsequent
-- listener fires on the same (release_id, dest_target_id) skip.

CREATE TABLE promotion_policy (
  id                 TEXT PRIMARY KEY,
  org_id             TEXT NOT NULL REFERENCES org (id),
  product_id         TEXT NOT NULL REFERENCES product (id),
  source_target_id   TEXT REFERENCES target (id),
  dest_target_id     TEXT NOT NULL REFERENCES target (id),
  gate_kind          TEXT NOT NULL CHECK (gate_kind IN ('auto', 'manual', 'time_delay')),
  gate_config_json   TEXT NOT NULL DEFAULT '{}',
  active             INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  description        TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  deleted_at         TEXT
);
CREATE INDEX promotion_policy_product_idx
  ON promotion_policy (product_id)
  WHERE deleted_at IS NULL;
CREATE INDEX promotion_policy_source_idx
  ON promotion_policy (source_target_id)
  WHERE deleted_at IS NULL;
CREATE INDEX promotion_policy_active_idx
  ON promotion_policy (active)
  WHERE deleted_at IS NULL AND active = 1;

CREATE TABLE approval (
  id                    TEXT PRIMARY KEY,
  org_id                TEXT NOT NULL REFERENCES org (id),
  policy_id             TEXT NOT NULL REFERENCES promotion_policy (id),
  release_id            TEXT NOT NULL REFERENCES release (id),
  dest_target_id        TEXT NOT NULL REFERENCES target (id),
  status                TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'auto_approved')),
  auto_approve_at       TEXT,       -- set for time_delay gates; null otherwise
  decided_by            TEXT,
  decided_at            TEXT,
  reason                TEXT,
  deploy_attempted_at   TEXT,
  deploy_outcome        TEXT,       -- 'success' / 'failed' / null
  deploy_deployment_id  TEXT,   -- historical pointer; not FK so a soft-deleted deployment doesn't break the audit trail
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  deleted_at            TEXT
);
CREATE INDEX approval_org_idx ON approval (org_id) WHERE deleted_at IS NULL;
CREATE INDEX approval_policy_idx ON approval (policy_id) WHERE deleted_at IS NULL;
CREATE INDEX approval_release_idx ON approval (release_id) WHERE deleted_at IS NULL;
CREATE INDEX approval_status_idx
  ON approval (status)
  WHERE deleted_at IS NULL AND status = 'pending';
-- One in-flight approval per (release, dest_target) — a second listener
-- fire for the same release shouldn't queue a duplicate row.
CREATE UNIQUE INDEX approval_release_dest_unique
  ON approval (release_id, dest_target_id)
  WHERE deleted_at IS NULL AND (status = 'pending' OR deploy_attempted_at IS NOT NULL);
