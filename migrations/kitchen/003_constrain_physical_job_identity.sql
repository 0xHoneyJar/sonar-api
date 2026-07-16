BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM kitchen_job_identity_migration_state
    WHERE singleton = true AND phase = 'canonical' AND divergence = false
  ) THEN
    RAISE EXCEPTION 'Kitchen constrain refused: canonical authority/parity proof is absent';
  END IF;
  IF EXISTS (
    SELECT 1 FROM kitchen_ingest_jobs
    WHERE physical_job_id IS NULL OR deployment_id IS NULL OR deployment_json IS NULL
       OR capability_id IS NULL OR capability_version IS NULL OR token_standard IS NULL
       OR prepare_adapter_id IS NULL OR prepare_adapter_version IS NULL
       OR source_sequence IS NULL OR finality_policy_version IS NULL
  ) THEN
    RAISE EXCEPTION 'Kitchen constrain refused: canonical identity backfill has gaps';
  END IF;
END $$;

ALTER TABLE kitchen_ingest_jobs ALTER COLUMN physical_job_id SET NOT NULL;
ALTER TABLE kitchen_ingest_jobs ALTER COLUMN deployment_id SET NOT NULL;
ALTER TABLE kitchen_ingest_jobs ALTER COLUMN deployment_json SET NOT NULL;
ALTER TABLE kitchen_ingest_jobs ALTER COLUMN capability_id SET NOT NULL;
ALTER TABLE kitchen_ingest_jobs ALTER COLUMN capability_version SET NOT NULL;
ALTER TABLE kitchen_ingest_jobs ALTER COLUMN token_standard SET NOT NULL;
ALTER TABLE kitchen_ingest_jobs ALTER COLUMN prepare_adapter_id SET NOT NULL;
ALTER TABLE kitchen_ingest_jobs ALTER COLUMN prepare_adapter_version SET NOT NULL;
ALTER TABLE kitchen_ingest_jobs ALTER COLUMN source_sequence SET NOT NULL;
ALTER TABLE kitchen_ingest_jobs ALTER COLUMN finality_policy_version SET NOT NULL;
DO $$
DECLARE
  primary_columns name[];
BEGIN
  SELECT array_agg(a.attname ORDER BY key_columns.ordinality) INTO primary_columns
  FROM pg_constraint c
  JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS key_columns(attnum, ordinality)
    ON true
  JOIN pg_attribute a
    ON a.attrelid = c.conrelid AND a.attnum = key_columns.attnum
  WHERE c.conrelid = 'kitchen_ingest_jobs'::regclass AND c.contype = 'p';

  IF primary_columns IS NULL THEN
    ALTER TABLE kitchen_ingest_jobs
      ADD CONSTRAINT kitchen_ingest_jobs_pkey PRIMARY KEY (physical_job_id);
  ELSIF primary_columns <> ARRAY['physical_job_id']::name[] THEN
    RAISE EXCEPTION 'Kitchen constrain refused: unexpected primary key %', primary_columns;
  END IF;
END $$;
DROP INDEX IF EXISTS kitchen_ingest_jobs_legacy_key_uq;
ALTER TABLE kitchen_ingest_jobs ADD CONSTRAINT kitchen_ingest_jobs_capability_check
  CHECK (capability_id = 'ownership_index.v1');
ALTER TABLE kitchen_ingest_jobs ADD CONSTRAINT kitchen_ingest_jobs_status_check
  CHECK (status IN ('queued', 'indexing', 'completed', 'failed'));
ALTER TABLE kitchen_ingest_jobs ADD CONSTRAINT kitchen_ingest_jobs_attempt_check CHECK (attempt > 0);

CREATE OR REPLACE VIEW kitchen_ingest_jobs_legacy_evm AS
SELECT chain_id, contract, physical_job_id AS job_id, status, error_message, created_at, updated_at
FROM kitchen_ingest_jobs WHERE chain_id IS NOT NULL AND contract IS NOT NULL;

UPDATE kitchen_job_identity_migration_state
SET phase = 'constrained', updated_at = now() WHERE singleton = true;

COMMIT;
