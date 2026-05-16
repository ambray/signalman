-- migration 0091_signing_nonce.sql (WS9 v0.5.0)
--
-- Replay-protection ledger. The audit log already records every
-- `signing.requested` row, but querying audit-log JSON-blob fields by
-- index is slow on SQLite (no functional indexes on the detail
-- column); this table denormalizes (org_id, actor_cn, nonce) for
-- O(1) replay detection at the sign hot path.
--
-- Rows are written when the provider validates a SignRequest and
-- about to sign; the provider rejects (signing.failed: nonce-replay)
-- if (org_id, actor_cn, nonce) already exists for a row that is
-- still within the freshness window.
--
-- TTL: rows older than 24h (max-allowed skew × buffer) are swept by
-- a periodic janitor — kept tiny + fast. The skew tolerance in the
-- provider's policy is 60s by default; 24h is 1440x the skew which
-- gives operators plenty of margin to investigate audit-log
-- correlations against a denormalized nonce row.

CREATE TABLE signing_nonce (
  org_id        TEXT NOT NULL,
  actor_cn      TEXT NOT NULL,
  nonce         TEXT NOT NULL,
  requested_at  TEXT NOT NULL,
  fingerprint   TEXT,                  -- the key fingerprint this nonce was used to sign with (debug)
  PRIMARY KEY (org_id, actor_cn, nonce)
);

CREATE INDEX signing_nonce_ttl_idx
  ON signing_nonce (requested_at);     -- for the GC sweeper
