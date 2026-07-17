import pg from "pg";

const connectionString = process.env.KITCHEN_DATABASE_URL?.trim();
if (!connectionString) throw new Error("KITCHEN_DATABASE_URL is required");
const pool = new pg.Pool({ connectionString });

try {
  const authority = await pool.query<{ phase: string; divergence: boolean }>(
    `SELECT phase, divergence FROM kitchen_job_identity_migration_state WHERE singleton = true`,
  );
  if (
    authority.rows[0]?.phase !== "dual_write" ||
    authority.rows[0]?.divergence !== false
  ) {
    throw new Error(
      "parity verification refused: clean dual_write authority is required",
    );
  }
  const gaps = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM kitchen_ingest_jobs
     WHERE physical_job_id IS NULL OR deployment_id IS NULL OR deployment_json IS NULL
        OR capability_id IS NULL OR capability_version IS NULL`,
  );
  const collisions = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM (
       SELECT deployment_id, capability_id, capability_version
       FROM kitchen_ingest_jobs WHERE deployment_id IS NOT NULL
       GROUP BY deployment_id, capability_id, capability_version HAVING count(*) <> 1
     ) collisions`,
  );
  const lifecycleParity = await pool.query<{ count: string }>(
    `WITH legacy_projection AS (
       SELECT ctid::text AS row_ref, chain_id, lower(contract) AS address,
              job_id AS job_reference, status AS lifecycle_status
       FROM kitchen_ingest_jobs
       WHERE chain_id IS NOT NULL
     ),
     canonical_projection AS (
       SELECT ctid::text AS row_ref,
              (deployment_json->'network'->>'network_reference')::int AS chain_id,
              deployment_json->>'normalized_address' AS address,
              physical_job_id AS job_reference,
              status AS lifecycle_status
       FROM kitchen_ingest_jobs
       WHERE deployment_json->'network'->>'network_namespace' = 'eip155'
     )
     SELECT count(*)::text AS count
     FROM legacy_projection legacy
     FULL OUTER JOIN canonical_projection canonical USING (row_ref)
     WHERE legacy.row_ref IS NULL OR canonical.row_ref IS NULL
        OR legacy.chain_id IS DISTINCT FROM canonical.chain_id
        OR legacy.address IS DISTINCT FROM canonical.address
        OR legacy.job_reference IS DISTINCT FROM canonical.job_reference
        OR legacy.lifecycle_status IS DISTINCT FROM canonical.lifecycle_status
        OR legacy.lifecycle_status NOT IN ('queued', 'indexing', 'completed', 'failed')`,
  );
  const reason = `gaps=${gaps.rows[0]?.count ?? "unknown"} collisions=${collisions.rows[0]?.count ?? "unknown"} lifecycle_parity=${lifecycleParity.rows[0]?.count ?? "unknown"}`;
  const divergence =
    gaps.rows[0]?.count !== "0" ||
    collisions.rows[0]?.count !== "0" ||
    lifecycleParity.rows[0]?.count !== "0";
  await pool.query(
    `UPDATE kitchen_job_identity_migration_state
     SET phase = $1, divergence = $2, reason = $3, updated_at = now()
     WHERE singleton = true`,
    [divergence ? "parity" : "canonical", divergence, divergence ? reason : null],
  );
  if (divergence) throw new Error(`Kitchen identity parity failed: ${reason}`);
  console.log("Kitchen identity parity verified; canonical key is authoritative");
} catch (error) {
  await pool.query(
    `UPDATE kitchen_job_identity_migration_state
     SET phase = 'parity', divergence = true, reason = $1, updated_at = now()
     WHERE singleton = true`,
    [error instanceof Error ? error.message : String(error)],
  ).catch(() => undefined);
  throw error;
} finally {
  await pool.end();
}
