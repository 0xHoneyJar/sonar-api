-- Sonar kitchen transactional outbox (sonar-api#238 / coordination fabric T4).
-- Safe on constrained identity phase — does not touch kitchen_ingest_jobs authority.

CREATE TABLE IF NOT EXISTS kitchen_outbox (
  event_id text PRIMARY KEY,
  event_type text NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  aggregate_id text NOT NULL,
  payload jsonb NOT NULL,
  publish_state text NOT NULL CHECK (
    publish_state IN ('pending', 'publishing', 'published', 'failed_terminal')
  ),
  attempt integer NOT NULL DEFAULT 0,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz
);

CREATE INDEX IF NOT EXISTS kitchen_outbox_publish_state_updated_idx
  ON kitchen_outbox (publish_state, updated_at);
