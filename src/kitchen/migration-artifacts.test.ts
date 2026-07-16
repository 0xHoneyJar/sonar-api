import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

describe("Kitchen physical-job migration artifacts", () => {
  it("encodes expand, authority, and constrain as separate ordered gates", () => {
    const expand = read("migrations/kitchen/001_expand_physical_job_identity.sql");
    const dualWrite = read("migrations/kitchen/001b_enable_dual_write.sql");
    const authority = read("migrations/kitchen/002_new_key_authority.sql");
    const constrain = read("migrations/kitchen/003_constrain_physical_job_identity.sql");

    expect(expand).toContain("kitchen_job_identity_migration_state");
    expect(expand).toContain("kitchen_job_correlations");
    expect(expand).toContain("kitchen_ingest_jobs_physical_identity_uq");
    expect(dualWrite).toContain("phase = 'dual_write'");
    expect(authority).toContain("parity proof is absent");
    expect(authority).toContain("ARRAY['chain_id', 'contract']");
    expect(authority).toContain("DROP CONSTRAINT %I");
    expect(constrain).toContain("canonical identity backfill has gaps");
    expect(constrain).toContain("IF NOT EXISTS");
    expect(constrain).toContain("phase = 'canonical' AND divergence = false");
    expect(constrain).toContain("ALTER COLUMN physical_job_id SET NOT NULL");
  });

  it("backfills with the shared deployment constructor and marks divergence fail closed", () => {
    const backfill = read("scripts/kitchen-backfill-job-identity.ts");
    const parity = read("scripts/kitchen-verify-job-parity.ts");

    expect(backfill).toContain("deploymentFromCollectionKey");
    expect(backfill).toContain("const physicalJobId = legacy.job_id");
    expect(backfill).toContain("physicalJobKey");
    expect(backfill).toContain("canonicalLockKey");
    expect(backfill).toContain("ON CONFLICT DO NOTHING");
    expect(backfill).toContain("divergence = true");
    expect(parity).toContain("legacy_projection");
    expect(parity).toContain("lifecycle_status");
    expect(parity).toContain("job_reference");
    expect(parity).toContain("phase = $1, divergence = $2");
  });
});
