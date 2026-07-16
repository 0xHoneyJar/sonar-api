import pg from "pg";

import { resolvePreparationCapability } from "../src/kitchen/capability.js";
import { deploymentFromCollectionKey, physicalJobKey } from "../src/kitchen/normalize.js";

const connectionString = process.env.KITCHEN_DATABASE_URL?.trim();
if (!connectionString) throw new Error("KITCHEN_DATABASE_URL is required");
const pool = new pg.Pool({ connectionString });
const lockTimeoutMs = (() => {
  const raw = process.env.KITCHEN_BACKFILL_LOCK_TIMEOUT_MS?.trim() ?? "5000";
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 60_000) {
    throw new Error("KITCHEN_BACKFILL_LOCK_TIMEOUT_MS must be an integer from 1 to 60000");
  }
  return parsed;
})();

type CanonicalIdentityRow = {
  job_id: string | null;
  physical_job_id: string | null;
  deployment_id: string | null;
  capability_id: string | null;
  capability_version: string | null;
  token_standard: string | null;
  prepare_adapter_id: string | null;
  prepare_adapter_version: string | null;
  source_sequence: string | null;
  finality_policy_version: string | null;
  deployment_json_matches: boolean;
};

const CANONICAL_IDENTITY_COLUMNS = `
  job_id, physical_job_id, deployment_id, capability_id, capability_version,
  token_standard, prepare_adapter_id, prepare_adapter_version, source_sequence,
  finality_policy_version
`;

function matchesCanonicalIdentity(
  row: CanonicalIdentityRow,
  expected: CanonicalIdentityRow,
): boolean {
  return (
    row.job_id === expected.job_id &&
    row.physical_job_id === expected.physical_job_id &&
    row.deployment_id === expected.deployment_id &&
    row.capability_id === expected.capability_id &&
    row.capability_version === expected.capability_version &&
    row.token_standard === expected.token_standard &&
    row.prepare_adapter_id === expected.prepare_adapter_id &&
    row.prepare_adapter_version === expected.prepare_adapter_version &&
    row.source_sequence === expected.source_sequence &&
    row.finality_policy_version === expected.finality_policy_version &&
    row.deployment_json_matches
  );
}

try {
  const authority = await pool.query<{ phase: string; divergence: boolean }>(
    `SELECT phase, divergence FROM kitchen_job_identity_migration_state WHERE singleton = true`,
  );
  if (authority.rows[0]?.phase !== "dual_write" || authority.rows[0]?.divergence) {
    throw new Error("backfill refused: healthy dual_write phase is required");
  }
  for (;;) {
    const batch = await pool.query<{
      chain_id: number;
      contract: `0x${string}`;
      job_id: string;
      order_id: string | null;
      source: string | null;
    }>(
      `SELECT chain_id, lower(contract) AS contract, job_id, order_id, source
       FROM kitchen_ingest_jobs WHERE physical_job_id IS NULL
       ORDER BY created_at LIMIT 100`,
    );
    if (batch.rowCount === 0) break;

    for (const legacy of batch.rows) {
      const deployment = await deploymentFromCollectionKey({
        chainId: legacy.chain_id,
        contract: legacy.contract,
      });
      const capability = await resolvePreparationCapability({
        network: deployment.network,
        tokenStandard: "erc721",
      });
      if (!capability.enabled) {
        throw new Error(`backfill unsupported for ${legacy.chain_id}:${legacy.contract}: ${capability.reason}`);
      }
      const physicalJobId = legacy.job_id;
      const canonicalLockKey = physicalJobKey({
        deployment,
        capabilityId: capability.capabilityId,
        capabilityVersion: capability.capabilityVersion,
      });
      const expectedIdentity: CanonicalIdentityRow = {
        job_id: physicalJobId,
        physical_job_id: physicalJobId,
        deployment_id: deployment.deployment_id.digest,
        capability_id: capability.capabilityId,
        capability_version: capability.capabilityVersion,
        token_standard: "erc721",
        prepare_adapter_id: capability.prepareAdapterId,
        prepare_adapter_version: capability.prepareAdapterVersion,
        source_sequence: capability.sourceSequence,
        finality_policy_version: capability.finalityPolicyVersion,
        deployment_json_matches: true,
      };
      const expectedDeploymentJson = JSON.stringify(deployment);
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT set_config('lock_timeout', $1, true)", [`${lockTimeoutMs}ms`]);
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [canonicalLockKey]);
        const locked = await client.query<CanonicalIdentityRow>(
          `SELECT ${CANONICAL_IDENTITY_COLUMNS},
                  deployment_json = $3::jsonb AS deployment_json_matches
           FROM kitchen_ingest_jobs
           WHERE chain_id = $1 AND lower(contract) = lower($2)
           ORDER BY created_at ASC LIMIT 1 FOR UPDATE`,
          [legacy.chain_id, legacy.contract, expectedDeploymentJson],
        );
        let canonicalRow = locked.rows[0];
        if (!canonicalRow) {
          throw new Error(`backfill lost row ${legacy.chain_id}:${legacy.contract}`);
        }

        if (canonicalRow.physical_job_id === null) {
          if (canonicalRow.job_id !== physicalJobId) {
            throw new Error(`backfill identity mismatch ${legacy.chain_id}:${legacy.contract}`);
          }
          const updated = await client.query<CanonicalIdentityRow>(
            `UPDATE kitchen_ingest_jobs SET
               physical_job_id = $3, deployment_id = $4, deployment_json = $5::jsonb,
               capability_id = $6, capability_version = $7, token_standard = 'erc721',
               prepare_adapter_id = $8, prepare_adapter_version = $9,
               source_sequence = $10, finality_policy_version = $11
             WHERE chain_id = $1 AND lower(contract) = lower($2) AND physical_job_id IS NULL
             RETURNING ${CANONICAL_IDENTITY_COLUMNS},
                       deployment_json = $5::jsonb AS deployment_json_matches`,
            [
              legacy.chain_id,
              legacy.contract,
              physicalJobId,
              deployment.deployment_id.digest,
              expectedDeploymentJson,
              capability.capabilityId,
              capability.capabilityVersion,
              capability.prepareAdapterId,
              capability.prepareAdapterVersion,
              capability.sourceSequence,
              capability.finalityPolicyVersion,
            ],
          );
          canonicalRow = updated.rows[0];
          if (!canonicalRow) {
            const reread = await client.query<CanonicalIdentityRow>(
              `SELECT ${CANONICAL_IDENTITY_COLUMNS},
                      deployment_json = $3::jsonb AS deployment_json_matches
               FROM kitchen_ingest_jobs
               WHERE chain_id = $1 AND lower(contract) = lower($2)
               ORDER BY created_at ASC LIMIT 1 FOR UPDATE`,
              [legacy.chain_id, legacy.contract, expectedDeploymentJson],
            );
            canonicalRow = reread.rows[0];
          }
        }

        if (!canonicalRow || !matchesCanonicalIdentity(canonicalRow, expectedIdentity)) {
          throw new Error(`backfill identity mismatch ${legacy.chain_id}:${legacy.contract}`);
        }
        if (legacy.order_id && legacy.source) {
          await client.query(
            `INSERT INTO kitchen_job_correlations (physical_job_id, source, correlation_id)
             VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
            [physicalJobId, legacy.source, legacy.order_id],
          );
        }
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        await pool.query(
          `UPDATE kitchen_job_identity_migration_state
           SET phase = 'parity', divergence = true, reason = $1, updated_at = now()
           WHERE singleton = true`,
          [error instanceof Error ? error.message : String(error)],
        );
        throw error;
      } finally {
        client.release();
      }
    }
  }
} catch (error) {
  await pool.query(
    `UPDATE kitchen_job_identity_migration_state
     SET phase = 'parity', divergence = true, reason = $1, updated_at = now()
     WHERE singleton = true`,
    [error instanceof Error ? error.message : String(error)],
  );
  throw error;
} finally {
  await pool.end();
}
