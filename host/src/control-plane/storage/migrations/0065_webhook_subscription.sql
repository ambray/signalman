-- v0.4.0-2 (Epic 2, WS3): outbound webhooks + notifications.
--
-- Operators register subscribers that receive events on release /
-- deployment / health / promotion state changes. The dispatcher (in
-- control-plane/events/dispatcher.ts) walks subscriptions and routes
-- to a driver per `kind`:
--
--   * generic — POST JSON body to `url`, signed with HMAC-SHA256
--     over the body using `secret_hmac_key`. Signature is carried in
--     the `X-Signalman-Signature` header.
--   * slack   — same `url` (incoming-webhook URL), payload formatted
--     as Slack blocks. `secret_hmac_key` ignored.
--   * email   — `url` is an `mailto:` address; SMTP transport is
--     resolved from `SIGNALMAN_SMTP_URL`. Disabled when the env var
--     is absent.
--
-- `event_kinds_json` is a JSON array of event kinds the subscription
-- wants. An empty array means "all events" — matches the principle
-- of least surprise for a freshly-added webhook.
--
-- Soft-delete via `deleted_at` mirrors the rest of the schema.

CREATE TABLE webhook_subscription (
  id                TEXT PRIMARY KEY,
  org_id            TEXT NOT NULL REFERENCES org (id),
  kind              TEXT NOT NULL CHECK (kind IN ('generic', 'slack', 'email')),
  url               TEXT NOT NULL,
  secret_hmac_key   TEXT,                       -- nullable: slack + email don't sign
  event_kinds_json  TEXT NOT NULL DEFAULT '[]', -- JSON array; [] = all events
  active            INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  description       TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  deleted_at        TEXT
);
CREATE INDEX webhook_subscription_org_idx
  ON webhook_subscription (org_id)
  WHERE deleted_at IS NULL;
CREATE INDEX webhook_subscription_active_idx
  ON webhook_subscription (active)
  WHERE deleted_at IS NULL AND active = 1;
