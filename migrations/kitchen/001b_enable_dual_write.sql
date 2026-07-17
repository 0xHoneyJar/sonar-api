BEGIN;

-- Run only after the dual-write service version is deployed everywhere.
UPDATE kitchen_job_identity_migration_state
SET phase = 'dual_write', divergence = false, reason = NULL, updated_at = now()
WHERE singleton = true AND phase = 'legacy' AND divergence = false;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM kitchen_job_identity_migration_state
    WHERE singleton = true AND phase = 'dual_write' AND divergence = false
  ) THEN
    RAISE EXCEPTION 'Kitchen dual-write activation refused';
  END IF;
END $$;

COMMIT;
