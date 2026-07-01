-- Kitchen upstream ingest queue (ordering-service coordination).
-- Apply on belt Postgres (public schema). Contract addresses are stored lowercase.

CREATE TABLE IF NOT EXISTS kitchen_ingest_jobs (
  chain_id int NOT NULL,
  contract text NOT NULL,
  job_id text NOT NULL,
  order_id text NOT NULL,
  source text NOT NULL,
  status text NOT NULL DEFAULT 'queued',
  contact_email text,
  community_name text,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chain_id, contract)
);

ALTER TABLE kitchen_ingest_jobs ADD COLUMN IF NOT EXISTS error_message text;
