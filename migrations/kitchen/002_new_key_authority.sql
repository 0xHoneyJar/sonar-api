BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM kitchen_job_identity_migration_state
    WHERE singleton = true AND phase = 'canonical' AND divergence = false
  ) THEN
    RAISE EXCEPTION 'Kitchen authority flip refused: parity proof is absent';
  END IF;
  IF EXISTS (SELECT 1 FROM kitchen_ingest_jobs WHERE physical_job_id IS NULL) THEN
    RAISE EXCEPTION 'Kitchen authority flip refused: legacy rows remain unbackfilled';
  END IF;
END $$;

-- Apply only after every legacy writer has been disabled. Expansion already
-- removes the exact legacy composite PK. Defensively repeat the catalog-checked
-- transition without ever touching a canonical physical_job_id PK.
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
DROP INDEX IF EXISTS kitchen_ingest_jobs_legacy_key_uq;
CREATE INDEX IF NOT EXISTS kitchen_ingest_jobs_legacy_lookup_idx
  ON kitchen_ingest_jobs (chain_id, lower(contract), created_at DESC)
  WHERE chain_id IS NOT NULL AND contract IS NOT NULL;

COMMIT;
