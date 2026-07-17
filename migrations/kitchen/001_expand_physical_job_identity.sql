BEGIN;

CREATE TABLE IF NOT EXISTS kitchen_ingest_jobs (
  chain_id int,
  contract text,
  job_id text,
  order_id text,
  source text,
  status text NOT NULL DEFAULT 'queued',
  contact_email text,
  community_name text,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE kitchen_ingest_jobs ADD COLUMN IF NOT EXISTS physical_job_id text;
ALTER TABLE kitchen_ingest_jobs ADD COLUMN IF NOT EXISTS deployment_id text;
ALTER TABLE kitchen_ingest_jobs ADD COLUMN IF NOT EXISTS deployment_json jsonb;
ALTER TABLE kitchen_ingest_jobs ADD COLUMN IF NOT EXISTS capability_id text;
ALTER TABLE kitchen_ingest_jobs ADD COLUMN IF NOT EXISTS capability_version text;
ALTER TABLE kitchen_ingest_jobs ADD COLUMN IF NOT EXISTS token_standard text;
ALTER TABLE kitchen_ingest_jobs ADD COLUMN IF NOT EXISTS prepare_adapter_id text;
ALTER TABLE kitchen_ingest_jobs ADD COLUMN IF NOT EXISTS prepare_adapter_version text;
ALTER TABLE kitchen_ingest_jobs ADD COLUMN IF NOT EXISTS source_sequence text;
ALTER TABLE kitchen_ingest_jobs ADD COLUMN IF NOT EXISTS finality_policy_version text;
ALTER TABLE kitchen_ingest_jobs ADD COLUMN IF NOT EXISTS attempt int NOT NULL DEFAULT 1;
ALTER TABLE kitchen_ingest_jobs ADD COLUMN IF NOT EXISTS error_code text;
ALTER TABLE kitchen_ingest_jobs ADD COLUMN IF NOT EXISTS lease_owner text;
ALTER TABLE kitchen_ingest_jobs ADD COLUMN IF NOT EXISTS lease_until timestamptz;
ALTER TABLE kitchen_ingest_jobs ADD COLUMN IF NOT EXISTS lease_epoch bigint NOT NULL DEFAULT 0;

-- Preserve the legacy key only while legacy/dual-write authority still owns
-- identity. A rerun after canonical authority must not recreate this index.
DO $$
BEGIN
  IF to_regclass('kitchen_job_identity_migration_state') IS NULL THEN
    CREATE UNIQUE INDEX IF NOT EXISTS kitchen_ingest_jobs_legacy_key_uq
      ON kitchen_ingest_jobs (chain_id, contract)
      WHERE chain_id IS NOT NULL AND contract IS NOT NULL;
  ELSIF EXISTS (
    SELECT 1 FROM kitchen_job_identity_migration_state
    WHERE singleton = true AND phase IN ('legacy', 'dual_write', 'parity')
  ) THEN
    CREATE UNIQUE INDEX IF NOT EXISTS kitchen_ingest_jobs_legacy_key_uq
      ON kitchen_ingest_jobs (chain_id, contract)
      WHERE chain_id IS NOT NULL AND contract IS NOT NULL;
  END IF;
END $$;
-- Remove only the exact legacy composite PK. A rerun against a constrained
-- canonical table must never drop its physical_job_id primary key.
DO $$
DECLARE
  legacy_pk name;
BEGIN
  SELECT constraint_name INTO legacy_pk
  FROM (
    SELECT c.conname AS constraint_name,
           array_agg(a.attname ORDER BY key_columns.ordinality) AS columns
    FROM pg_constraint c
    JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS key_columns(attnum, ordinality)
      ON true
    JOIN pg_attribute a
      ON a.attrelid = c.conrelid AND a.attnum = key_columns.attnum
    WHERE c.conrelid = 'kitchen_ingest_jobs'::regclass AND c.contype = 'p'
    GROUP BY c.conname
  ) primary_keys
  WHERE columns = ARRAY['chain_id', 'contract']::name[];

  IF legacy_pk IS NOT NULL THEN
    EXECUTE format('ALTER TABLE kitchen_ingest_jobs DROP CONSTRAINT %I', legacy_pk);
  END IF;
END $$;

ALTER TABLE kitchen_ingest_jobs ALTER COLUMN chain_id DROP NOT NULL;
ALTER TABLE kitchen_ingest_jobs ALTER COLUMN contract DROP NOT NULL;
ALTER TABLE kitchen_ingest_jobs ALTER COLUMN order_id DROP NOT NULL;
ALTER TABLE kitchen_ingest_jobs ALTER COLUMN source DROP NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS kitchen_ingest_jobs_physical_identity_uq
  ON kitchen_ingest_jobs (deployment_id, capability_id, capability_version)
  WHERE deployment_id IS NOT NULL AND capability_id IS NOT NULL AND capability_version IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS kitchen_ingest_jobs_physical_job_id_uq
  ON kitchen_ingest_jobs (physical_job_id) WHERE physical_job_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS kitchen_ingest_jobs_legacy_evm_idx
  ON kitchen_ingest_jobs (chain_id, lower(contract))
  WHERE chain_id IS NOT NULL AND contract IS NOT NULL;

CREATE TABLE IF NOT EXISTS kitchen_job_correlations (
  physical_job_id text NOT NULL,
  source text NOT NULL,
  correlation_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (physical_job_id, source, correlation_id)
);
CREATE TABLE IF NOT EXISTS kitchen_job_identity_migration_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  phase text NOT NULL CHECK (phase IN ('legacy', 'dual_write', 'parity', 'canonical', 'constrained')),
  divergence boolean NOT NULL DEFAULT false,
  reason text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO kitchen_job_identity_migration_state (singleton, phase, divergence)
VALUES (true, 'legacy', false) ON CONFLICT (singleton) DO NOTHING;

COMMIT;
