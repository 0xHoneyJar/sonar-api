// T-A0.3 + T-A0.4 verification — Postgres ON CONFLICT semantics
//
// Validates that the SQL Ponder generates under the hood (via Drizzle)
// for onConflictDoNothing / onConflictDoUpdate behaves as documented:
//   - duplicate insert with same PK is a no-op (DoNothing)
//   - duplicate insert with DoUpdate overwrites SPECIFIED columns ONLY
// Also validates SDD §3.3's deterministic-ID idempotency property.
//
// Run: pnpm exec tsx scripts/verify-onconflict.ts
import { Client } from "pg";

async function main() {
  const client = new Client({
    connectionString:
      process.env.DATABASE_URL ??
      "postgresql://ponder:ponder@127.0.0.1:5444/ponder",
  });
  await client.connect();

  await client.query(`DROP SCHEMA IF EXISTS spike_a0_34 CASCADE;`);
  await client.query(`CREATE SCHEMA spike_a0_34;`);
  await client.query(`
    CREATE TABLE spike_a0_34.token (
      id text PRIMARY KEY,
      owner text NOT NULL,
      block_number bigint NOT NULL,
      timestamp bigint NOT NULL
    );
  `);

  // 1. Initial insert
  await client.query(
    `INSERT INTO spike_a0_34.token (id, owner, block_number, timestamp) VALUES ($1,$2,$3,$4);`,
    ["t1", "0xalice", 100, 1000],
  );

  // 2. onConflictDoNothing — duplicate id with different owner should NOT update
  const doNothingRes = await client.query(
    `INSERT INTO spike_a0_34.token (id, owner, block_number, timestamp)
     VALUES ($1,$2,$3,$4) ON CONFLICT (id) DO NOTHING RETURNING *;`,
    ["t1", "0xeve", 999, 9999],
  );
  console.log(`[T-A0.4] DoNothing returned ${doNothingRes.rowCount} row(s) (expected 0)`);
  const after1 = await client.query(`SELECT * FROM spike_a0_34.token WHERE id='t1';`);
  console.log(`[T-A0.4] after DoNothing: owner=${after1.rows[0].owner} (expected 0xalice)`);
  if (after1.rows[0].owner !== "0xalice") {
    throw new Error(`DoNothing semantics failed`);
  }

  // 3. onConflictDoUpdate — update only `owner`, NOT block_number or timestamp
  await client.query(
    `INSERT INTO spike_a0_34.token (id, owner, block_number, timestamp)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (id) DO UPDATE SET owner = EXCLUDED.owner;`,
    ["t1", "0xbob", 200, 2000],
  );
  const after2 = await client.query(`SELECT * FROM spike_a0_34.token WHERE id='t1';`);
  console.log(
    `[T-A0.4] after DoUpdate: owner=${after2.rows[0].owner} block_number=${after2.rows[0].block_number} timestamp=${after2.rows[0].timestamp}`,
  );
  if (after2.rows[0].owner !== "0xbob") {
    throw new Error(`DoUpdate did not set owner`);
  }
  if (String(after2.rows[0].block_number) !== "100" || String(after2.rows[0].timestamp) !== "1000") {
    throw new Error(`DoUpdate clobbered unspecified columns — expected block_number=100, timestamp=1000`);
  }
  console.log(`[T-A0.4] PASS — DoUpdate updates only specified columns`);

  // 4. Deterministic ID idempotency (T-A0.9)
  await client.query(`
    CREATE TABLE spike_a0_34.pending_emits (
      id text PRIMARY KEY,
      chain_id integer NOT NULL,
      tx_hash text NOT NULL,
      log_index integer NOT NULL,
      envelope_type text NOT NULL,
      published_at bigint,
      attempt_count integer DEFAULT 0
    );
  `);
  // Same canonical input → same deterministic_id → DoNothing absorbs replay
  for (let i = 0; i < 5; i++) {
    await client.query(
      `INSERT INTO spike_a0_34.pending_emits (id, chain_id, tx_hash, log_index, envelope_type)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT (id) DO NOTHING;`,
      [
        "0xdeadbeef-deterministic",
        1,
        "0xabc",
        0,
        "transfer",
      ],
    );
  }
  const dedupCount = await client.query(
    `SELECT COUNT(*)::int AS c FROM spike_a0_34.pending_emits WHERE id='0xdeadbeef-deterministic';`,
  );
  console.log(`[T-A0.9] deterministic-id replay: rowcount=${dedupCount.rows[0].c} (expected 1)`);
  if (dedupCount.rows[0].c !== 1) {
    throw new Error(`deterministic ID idempotency failed`);
  }
  console.log(`[T-A0.9] PASS — 5x duplicate insert produced 1 row`);

  await client.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
