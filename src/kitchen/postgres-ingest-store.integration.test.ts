import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import pg from "pg";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolvePreparationCapability } from "./capability.js";
import { deploymentFromCollectionKey, physicalJobKey } from "./normalize.js";
import { PostgresIngestJobStore } from "./postgres-ingest-store.js";
import { ensureKitchenIngestTable } from "./postgres-ingest-store.js";

const databaseUrl = process.env.KITCHEN_TEST_DATABASE_URL?.trim();
const describePostgres = databaseUrl ? describe : describe.skip;
const pool = databaseUrl ? new pg.Pool({ connectionString: databaseUrl }) : undefined;
const expandSql = readFileSync(
  resolve(process.cwd(), "migrations/kitchen/001_expand_physical_job_identity.sql"),
  "utf8",
);
const key = {
  chainId: 80094,
  contract: "0x4b08a069381efbb9f08c73d6b2e975c9be3c4684" as const,
};
const activeBackfills = new Set<BackfillRun>();

type BackfillResult = {
  code: number | null;
  stdout: string;
  stderr: string;
};

type BackfillRun = {
  child: ChildProcess;
  result: Promise<BackfillResult>;
};

async function admissionRequest(correlationId: string) {
  const deployment = await deploymentFromCollectionKey(key);
  const capability = await resolvePreparationCapability({
    network: deployment.network,
    tokenStandard: "erc721",
  });
  return {
    deployment,
    tokenStandard: "erc721" as const,
    capability,
    correlation: { source: "ordering-service", correlationId },
  };
}

async function waitForAdvisoryWaiter(
  applicationName: string,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const waiter = await pool!.query<{ waiting: boolean }>(
      `SELECT EXISTS (
         SELECT 1
         FROM pg_stat_activity activity
         JOIN pg_locks lock ON lock.pid = activity.pid
         WHERE activity.datname = current_database()
           AND activity.application_name = $1
           AND lock.locktype = 'advisory'
           AND NOT lock.granted
       ) AS waiting`,
      [applicationName],
    );
    if (waiter.rows[0]?.waiting) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  throw new Error(`timed out waiting for advisory lock waiter ${applicationName}`);
}

function runBackfillScript(
  applicationName: string,
  env: Readonly<Record<string, string>> = {},
): BackfillRun {
  const child = spawn(
    "pnpm",
    ["exec", "tsx", "scripts/kitchen-backfill-job-identity.ts"],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        KITCHEN_DATABASE_URL: databaseUrl,
        PGAPPNAME: applicationName,
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr?.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  const result = new Promise<BackfillResult>((resolveRun, rejectRun) => {
    child.once("error", rejectRun);
    child.once("close", (code) => resolveRun({ code, stdout, stderr }));
  });
  const run = { child, result };
  activeBackfills.add(run);
  result.then(
    () => activeBackfills.delete(run),
    () => activeBackfills.delete(run),
  );
  return run;
}

function terminateProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.exitCode !== null || child.pid === undefined) return;
  try {
    if (process.platform === "win32") {
      child.kill(signal);
    } else {
      process.kill(-child.pid, signal);
    }
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : undefined;
    if (code !== "ESRCH") throw error;
  }
}

async function cleanupBackfillProcesses(): Promise<void> {
  const runs = [...activeBackfills];
  for (const run of runs) terminateProcessGroup(run.child, "SIGTERM");
  await Promise.all(runs.map(async (run) => {
    const closed = await Promise.race([
      run.result.then(() => true, () => true),
      new Promise<false>((resolveTimeout) => setTimeout(() => resolveTimeout(false), 2_000)),
    ]);
    if (!closed) {
      terminateProcessGroup(run.child, "SIGKILL");
      await Promise.race([
        run.result.catch(() => undefined),
        new Promise<void>((resolveTimeout) => setTimeout(resolveTimeout, 2_000)),
      ]);
    }
    activeBackfills.delete(run);
  }));
}

async function withDeadline<A>(promise: Promise<A>, timeoutMs: number, message: string): Promise<A> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, rejectTimeout) => {
        timeout = setTimeout(() => rejectTimeout(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

describePostgres("Postgres physical-job mixed-version integration", () => {
  beforeEach(async () => {
    await cleanupBackfillProcesses();
    await pool!.query("DROP TABLE IF EXISTS kitchen_job_correlations CASCADE");
    await pool!.query("DROP TABLE IF EXISTS kitchen_job_identity_migration_state CASCADE");
    await pool!.query("DROP TABLE IF EXISTS kitchen_ingest_jobs CASCADE");
  }, 15_000);

  afterEach(async () => {
    await cleanupBackfillProcesses();
  }, 15_000);

  afterAll(async () => {
    await cleanupBackfillProcesses();
    await pool?.end();
  }, 15_000);

  it("keeps an expanded unbackfilled row queryable and transactionally upgrades it in place", async () => {
    await pool!.query(`
      CREATE TABLE kitchen_ingest_jobs (
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
      INSERT INTO kitchen_ingest_jobs
        (chain_id, contract, job_id, order_id, source, status)
      VALUES
        (80094, '${key.contract}', 'legacy-job-reference', 'legacy-order', 'legacy-ordering', 'indexing');
    `);
    await pool!.query(expandSql);
    const expandedKeys = await pool!.query<{
      primary_columns: string[] | null;
      legacy_unique_present: boolean;
    }>(`
      SELECT
        (
          SELECT array_agg(a.attname::text ORDER BY keys.ordinality)
          FROM pg_constraint c
          JOIN LATERAL unnest(c.conkey) WITH ORDINALITY keys(attnum, ordinality) ON true
          JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = keys.attnum
          WHERE c.conrelid = 'kitchen_ingest_jobs'::regclass AND c.contype = 'p'
        ) AS primary_columns,
        to_regclass('public.kitchen_ingest_jobs_legacy_key_uq') IS NOT NULL
          AS legacy_unique_present
    `);
    expect(expandedKeys.rows[0]).toEqual({
      primary_columns: null,
      legacy_unique_present: true,
    });
    await pool!.query(
      `UPDATE kitchen_job_identity_migration_state SET phase = 'dual_write' WHERE singleton = true`,
    );

    const store = new PostgresIngestJobStore(pool!);
    await expect(store.get(key)).resolves.toMatchObject({
      jobId: "legacy-job-reference",
      physicalJobId: "legacy-job-reference",
      status: "indexing",
    });

    const admitted = await store.admit(await admissionRequest("new-order"), 1_000);
    expect(admitted).toMatchObject({
      ok: true,
      created: false,
      job: {
        jobId: "legacy-job-reference",
        physicalJobId: "legacy-job-reference",
        status: "indexing",
      },
    });
    expect(await store.listCorrelations("legacy-job-reference")).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: "legacy-ordering", correlationId: "legacy-order" }),
      expect.objectContaining({ source: "ordering-service", correlationId: "new-order" }),
    ]));
    const row = await pool!.query(
      `SELECT count(*)::int AS count,
              bool_and(job_id = physical_job_id) AS reference_parity,
              bool_and(status = 'indexing') AS lifecycle_parity
       FROM kitchen_ingest_jobs`,
    );
    expect(row.rows[0]).toEqual({
      count: 1,
      reference_parity: true,
      lifecycle_parity: true,
    });
  });

  it("admits concurrent replay once and rejects stale lease publication", async () => {
    await pool!.query(expandSql);
    await pool!.query(
      `UPDATE kitchen_job_identity_migration_state SET phase = 'dual_write' WHERE singleton = true`,
    );
    const store = new PostgresIngestJobStore(pool!);
    const request = await admissionRequest("order");
    const results = await Promise.all(
      Array.from({ length: 20 }, () => store.admit(request, 100)),
    );
    expect(results.filter((result) => result.ok && result.created)).toHaveLength(1);
    const physicalIds = results.flatMap((result) => result.ok ? [result.job.physicalJobId] : []);
    expect(new Set(physicalIds).size).toBe(1);

    const [stale] = await store.claimQueued({
      workerId: "stale",
      nowMs: 100,
      leaseMs: 10,
    });
    const [current] = await store.claimQueued({
      workerId: "current",
      nowMs: 111,
      leaseMs: 1_000,
    });
    await expect(store.updateStatus(physicalIds[0], "failed", {
      nowMs: 112,
      expectedLease: { owner: "stale", epoch: stale.leaseEpoch },
      expectedStatus: "queued",
    })).resolves.toBeUndefined();
    await expect(store.updateStatus(physicalIds[0], "indexing", {
      nowMs: 112,
      expectedLease: { owner: "current", epoch: current.leaseEpoch },
      expectedStatus: "queued",
    })).resolves.toMatchObject({ status: "indexing" });
  });

  it("joins a same-capability row already upgraded by backfill", async () => {
    await pool!.query(expandSql);
    await pool!.query(
      `UPDATE kitchen_job_identity_migration_state SET phase = 'dual_write' WHERE singleton = true`,
    );
    const request = await admissionRequest("new-correlation");
    await pool!.query(
      `INSERT INTO kitchen_ingest_jobs (
         chain_id, contract, job_id, order_id, source, status,
         physical_job_id, deployment_id, deployment_json, capability_id,
         capability_version, token_standard, prepare_adapter_id,
         prepare_adapter_version, source_sequence, finality_policy_version
       ) VALUES (
         $1, $2, 'legacy-backfilled-job', 'legacy-correlation', 'legacy-source', 'indexing',
         'legacy-backfilled-job', $3, $4::jsonb, $5, $6, 'erc721', $7, $8, $9, $10
       )`,
      [
        key.chainId,
        key.contract,
        request.deployment.deployment_id.digest,
        JSON.stringify(request.deployment),
        request.capability.capabilityId,
        request.capability.capabilityVersion,
        request.capability.prepareAdapterId,
        request.capability.prepareAdapterVersion,
        request.capability.sourceSequence,
        request.capability.finalityPolicyVersion,
      ],
    );
    const store = new PostgresIngestJobStore(pool!);
    await expect(store.admit(request, 200)).resolves.toMatchObject({
      ok: true,
      created: false,
      job: {
        physicalJobId: "legacy-backfilled-job",
        status: "indexing",
      },
    });
    await expect(store.listCorrelations("legacy-backfilled-job")).resolves.toEqual([
      expect.objectContaining({
        source: "ordering-service",
        correlationId: "new-correlation",
      }),
    ]);
    const count = await pool!.query(
      `SELECT count(*)::int AS count FROM kitchen_ingest_jobs`,
    );
    expect(count.rows[0]?.count).toBe(1);
  });

  it("serializes admission behind the same canonical lock used by backfill", async () => {
    await pool!.query(`
      CREATE TABLE kitchen_ingest_jobs (
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
      INSERT INTO kitchen_ingest_jobs
        (chain_id, contract, job_id, order_id, source, status)
      VALUES
        (80094, '${key.contract}', 'race-job', 'legacy-order', 'legacy-source', 'indexing');
    `);
    await pool!.query(expandSql);
    await pool!.query(
      `UPDATE kitchen_job_identity_migration_state SET phase = 'dual_write' WHERE singleton = true`,
    );
    const request = await admissionRequest("new-order");
    const lockKey = physicalJobKey({
      deployment: request.deployment,
      capabilityId: request.capability.capabilityId,
      capabilityVersion: request.capability.capabilityVersion,
    });
    const admissionApplication = "cr203-admission-behind-backfill";
    const admissionPool = new pg.Pool({
      connectionString: databaseUrl,
      application_name: admissionApplication,
    });
    const backfill = await pool!.connect();
    let blockerOpen = false;
    try {
      await backfill.query("BEGIN");
      blockerOpen = true;
      await backfill.query("SELECT pg_advisory_xact_lock(hashtext($1))", [lockKey]);

      const store = new PostgresIngestJobStore(admissionPool);
      const admission = store.admit(request, 300);
      await waitForAdvisoryWaiter(admissionApplication);

      await backfill.query(
        `UPDATE kitchen_ingest_jobs SET
           physical_job_id = job_id, deployment_id = $3, deployment_json = $4::jsonb,
           capability_id = $5, capability_version = $6, token_standard = 'erc721',
           prepare_adapter_id = $7, prepare_adapter_version = $8,
           source_sequence = $9, finality_policy_version = $10
         WHERE chain_id = $1 AND lower(contract) = lower($2)`,
        [
          key.chainId,
          key.contract,
          request.deployment.deployment_id.digest,
          JSON.stringify(request.deployment),
          request.capability.capabilityId,
          request.capability.capabilityVersion,
          request.capability.prepareAdapterId,
          request.capability.prepareAdapterVersion,
          request.capability.sourceSequence,
          request.capability.finalityPolicyVersion,
        ],
      );
      await backfill.query(
        `INSERT INTO kitchen_job_correlations (physical_job_id, source, correlation_id)
         VALUES ('race-job', 'legacy-source', 'legacy-order')`,
      );
      await backfill.query("COMMIT");
      blockerOpen = false;

      await expect(admission).resolves.toMatchObject({
        ok: true,
        created: false,
        job: { physicalJobId: "race-job", status: "indexing" },
      });
      await expect(store.listCorrelations("race-job")).resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({ source: "legacy-source", correlationId: "legacy-order" }),
        expect.objectContaining({ source: "ordering-service", correlationId: "new-order" }),
      ]));
    } finally {
      if (blockerOpen) await backfill.query("ROLLBACK").catch(() => undefined);
      backfill.release();
      await admissionPool.end();
    }
  }, 30_000);

  it("lets backfill converge after admission upgrades its stale legacy batch row", async () => {
    await pool!.query(`
      CREATE TABLE kitchen_ingest_jobs (
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
      INSERT INTO kitchen_ingest_jobs
        (chain_id, contract, job_id, order_id, source, status)
      VALUES
        (80094, '${key.contract}', 'admission-first-job', 'legacy-order', 'legacy-source', 'indexing');
    `);
    await pool!.query(expandSql);
    await pool!.query(
      `UPDATE kitchen_job_identity_migration_state SET phase = 'dual_write' WHERE singleton = true`,
    );
    const request = await admissionRequest("new-order");
    const lockKey = physicalJobKey({
      deployment: request.deployment,
      capabilityId: request.capability.capabilityId,
      capabilityVersion: request.capability.capabilityVersion,
    });
    const admissionApplication = "cr203-admission-first";
    const backfillApplication = "cr203-backfill-second";
    const admissionPool = new pg.Pool({
      connectionString: databaseUrl,
      application_name: admissionApplication,
    });
    const blocker = await pool!.connect();
    let blockerOpen = false;
    try {
      await blocker.query("BEGIN");
      blockerOpen = true;
      await blocker.query("SELECT pg_advisory_xact_lock(hashtext($1))", [lockKey]);

      const store = new PostgresIngestJobStore(admissionPool);
      const admission = store.admit(request, 400);
      await waitForAdvisoryWaiter(admissionApplication);
      const backfill = runBackfillScript(backfillApplication);
      await waitForAdvisoryWaiter(backfillApplication);
      await blocker.query("COMMIT");
      blockerOpen = false;

      await expect(admission).resolves.toMatchObject({
        ok: true,
        created: false,
        job: { physicalJobId: "admission-first-job", status: "indexing" },
      });
      const backfillResult = await backfill.result;
      expect(backfillResult).toEqual({
        code: 0,
        stdout: "",
        stderr: "",
      });
      const authority = await pool!.query(
        `SELECT phase, divergence, reason
         FROM kitchen_job_identity_migration_state WHERE singleton = true`,
      );
      expect(authority.rows[0]).toEqual({
        phase: "dual_write",
        divergence: false,
        reason: null,
      });
      const rows = await pool!.query(
        `SELECT count(*)::int AS count FROM kitchen_ingest_jobs`,
      );
      expect(rows.rows[0]?.count).toBe(1);
      await expect(store.listCorrelations("admission-first-job")).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ source: "legacy-source", correlationId: "legacy-order" }),
          expect.objectContaining({ source: "ordering-service", correlationId: "new-order" }),
        ]),
      );
    } finally {
      if (blockerOpen) await blocker.query("ROLLBACK").catch(() => undefined);
      blocker.release();
      await admissionPool.end();
    }
  }, 45_000);

  it("fails closed within the configured timeout when a canonical lock is held", async () => {
    await pool!.query(`
      CREATE TABLE kitchen_ingest_jobs (
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
      INSERT INTO kitchen_ingest_jobs
        (chain_id, contract, job_id, order_id, source, status)
      VALUES
        (80094, '${key.contract}', 'lock-timeout-job', 'legacy-order', 'legacy-source', 'indexing');
    `);
    await pool!.query(expandSql);
    await pool!.query(
      `UPDATE kitchen_job_identity_migration_state SET phase = 'dual_write' WHERE singleton = true`,
    );
    const request = await admissionRequest("new-order");
    const lockKey = physicalJobKey({
      deployment: request.deployment,
      capabilityId: request.capability.capabilityId,
      capabilityVersion: request.capability.capabilityVersion,
    });
    const blocker = await pool!.connect();
    let blockerOpen = false;
    try {
      await blocker.query("BEGIN");
      blockerOpen = true;
      await blocker.query("SELECT pg_advisory_xact_lock(hashtext($1))", [lockKey]);

      const backfill = runBackfillScript("cr203-lock-timeout", {
        KITCHEN_BACKFILL_LOCK_TIMEOUT_MS: "100",
      });
      const result = await withDeadline(
        backfill.result,
        10_000,
        "backfill did not honor lock timeout",
      );
      expect(result.code).not.toBe(0);
      // PG may surface lock wait as lock timeout or statement timeout depending on
      // which GUC fires first; both prove the backfill aborted on contention.
      expect(
        result.stderr.includes("canceling statement due to lock timeout") ||
          result.stderr.includes("canceling statement due to statement timeout"),
      ).toBe(true);
      const authority = await pool!.query(
        `SELECT phase, divergence, reason
         FROM kitchen_job_identity_migration_state WHERE singleton = true`,
      );
      expect(authority.rows[0]).toMatchObject({
        phase: "parity",
        divergence: true,
        reason: expect.stringMatching(/lock timeout|statement timeout/),
      });
    } finally {
      if (blockerOpen) await blocker.query("ROLLBACK").catch(() => undefined);
      blocker.release();
    }
  }, 30_000);

  it("marks divergence when a concurrent upgrade preserves scalar identity but corrupts deployment JSON", async () => {
    await pool!.query(`
      CREATE TABLE kitchen_ingest_jobs (
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
      INSERT INTO kitchen_ingest_jobs
        (chain_id, contract, job_id, order_id, source, status)
      VALUES
        (80094, '${key.contract}', 'corrupt-deployment-job', 'legacy-order', 'legacy-source', 'indexing');
    `);
    await pool!.query(expandSql);
    await pool!.query(
      `UPDATE kitchen_job_identity_migration_state SET phase = 'dual_write' WHERE singleton = true`,
    );
    const request = await admissionRequest("unused");
    const lockKey = physicalJobKey({
      deployment: request.deployment,
      capabilityId: request.capability.capabilityId,
      capabilityVersion: request.capability.capabilityVersion,
    });
    const corruptedDeployment = {
      ...request.deployment,
      normalized_address: "0x0000000000000000000000000000000000000001",
    };
    const backfillApplication = "cr203-backfill-corrupt-json";
    const blocker = await pool!.connect();
    let blockerOpen = false;
    try {
      await blocker.query("BEGIN");
      blockerOpen = true;
      await blocker.query("SELECT pg_advisory_xact_lock(hashtext($1))", [lockKey]);

      const backfill = runBackfillScript(backfillApplication);
      await waitForAdvisoryWaiter(backfillApplication);
      await blocker.query(
        `UPDATE kitchen_ingest_jobs SET
           physical_job_id = job_id, deployment_id = $3, deployment_json = $4::jsonb,
           capability_id = $5, capability_version = $6, token_standard = 'erc721',
           prepare_adapter_id = $7, prepare_adapter_version = $8,
           source_sequence = $9, finality_policy_version = $10
         WHERE chain_id = $1 AND lower(contract) = lower($2)`,
        [
          key.chainId,
          key.contract,
          request.deployment.deployment_id.digest,
          JSON.stringify(corruptedDeployment),
          request.capability.capabilityId,
          request.capability.capabilityVersion,
          request.capability.prepareAdapterId,
          request.capability.prepareAdapterVersion,
          request.capability.sourceSequence,
          request.capability.finalityPolicyVersion,
        ],
      );
      await blocker.query("COMMIT");
      blockerOpen = false;

      const backfillResult = await backfill.result;
      expect(backfillResult.code).not.toBe(0);
      expect(backfillResult.stderr).toContain("backfill identity mismatch");
      const authority = await pool!.query(
        `SELECT phase, divergence, reason
         FROM kitchen_job_identity_migration_state WHERE singleton = true`,
      );
      expect(authority.rows[0]).toMatchObject({
        phase: "parity",
        divergence: true,
        reason: expect.stringContaining("backfill identity mismatch"),
      });
      const correlations = await pool!.query(
        `SELECT count(*)::int AS count FROM kitchen_job_correlations`,
      );
      expect(correlations.rows[0]?.count).toBe(0);
    } finally {
      if (blockerOpen) await blocker.query("ROLLBACK").catch(() => undefined);
      blocker.release();
    }
  }, 30_000);

  it("fails closed when the migration authority row is missing", async () => {
    await pool!.query(expandSql);
    const store = new PostgresIngestJobStore(pool!);
    await pool!.query("DELETE FROM kitchen_job_identity_migration_state");

    await expect(store.admit(await admissionRequest("order"))).resolves.toMatchObject({
      ok: false,
      code: "migration_divergence",
    });
    await expect(store.claimQueued({ workerId: "worker" })).resolves.toEqual([]);
  });

  it("runtime bootstrap does not recreate a deliberately missing authority row", async () => {
    await ensureKitchenIngestTable(pool!);
    await pool!.query("DELETE FROM kitchen_job_identity_migration_state");

    await ensureKitchenIngestTable(pool!);

    const authority = await pool!.query(
      "SELECT count(*)::int AS count FROM kitchen_job_identity_migration_state",
    );
    expect(authority.rows[0]?.count).toBe(0);
    const store = new PostgresIngestJobStore(pool!);
    await expect(store.admit(await admissionRequest("order"))).resolves.toMatchObject({
      ok: false,
      code: "migration_divergence",
    });
    await expect(store.claimQueued({ workerId: "worker" })).resolves.toEqual([]);
  });

  it("constrain migration refuses a missing authority singleton", async () => {
    await ensureKitchenIngestTable(pool!);
    await pool!.query("DELETE FROM kitchen_job_identity_migration_state");
    const constrainSql = readFileSync(
      resolve(process.cwd(), "migrations/kitchen/003_constrain_physical_job_identity.sql"),
      "utf8",
    );
    await expect(
      (async () => {
        try {
          await pool!.query(constrainSql);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await pool!.query("ROLLBACK").catch(() => undefined);
          throw new Error(message);
        }
      })(),
    ).rejects.toThrow("canonical authority/parity proof is absent");
  });

  it("ordered constrain installs and preserves only the canonical primary key", async () => {
    await pool!.query(expandSql);
    await pool!.query(
      `UPDATE kitchen_job_identity_migration_state SET phase = 'dual_write' WHERE singleton = true`,
    );
    const store = new PostgresIngestJobStore(pool!);
    const admitted = await store.admit(await admissionRequest("order"), 100);
    expect(admitted.ok).toBe(true);
    await pool!.query(
      `UPDATE kitchen_job_identity_migration_state
       SET phase = 'canonical', divergence = false WHERE singleton = true`,
    );
    const authoritySql = readFileSync(
      resolve(process.cwd(), "migrations/kitchen/002_new_key_authority.sql"),
      "utf8",
    );
    const constrainSql = readFileSync(
      resolve(process.cwd(), "migrations/kitchen/003_constrain_physical_job_identity.sql"),
      "utf8",
    );
    await pool!.query(authoritySql);
    const authorityIndexes = await pool!.query<{ legacy_unique_present: boolean }>(`
      SELECT to_regclass('public.kitchen_ingest_jobs_legacy_key_uq') IS NOT NULL
        AS legacy_unique_present
    `);
    expect(authorityIndexes.rows[0]?.legacy_unique_present).toBe(false);
    await pool!.query(constrainSql);
    await ensureKitchenIngestTable(pool!);

    const primary = await pool!.query<{ columns: string[] }>(`
      SELECT array_agg(a.attname::text ORDER BY keys.ordinality) AS columns
      FROM pg_constraint c
      JOIN LATERAL unnest(c.conkey) WITH ORDINALITY keys(attnum, ordinality) ON true
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = keys.attnum
      WHERE c.conrelid = 'kitchen_ingest_jobs'::regclass AND c.contype = 'p'
    `);
    expect(primary.rows[0]?.columns).toEqual(["physical_job_id"]);
    const constrainedIndexes = await pool!.query<{ legacy_unique_present: boolean }>(`
      SELECT to_regclass('public.kitchen_ingest_jobs_legacy_key_uq') IS NOT NULL
        AS legacy_unique_present
    `);
    expect(constrainedIndexes.rows[0]?.legacy_unique_present).toBe(false);
    await expect(store.getMigrationAuthority()).resolves.toMatchObject({
      phase: "constrained",
      divergence: false,
    });
  });
});
