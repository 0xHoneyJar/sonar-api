// T-A0.6 verification — uint256 roundtrip of 2^256-1 in Postgres numeric(78,0)
//
// This script is db-driver-only — it does NOT exercise Ponder's handler path
// (Ponder requires onchain events to fire handlers; we don't have a way to
// inject synthetic chain data deterministically in a 1-day spike). Instead
// it proves the SHAPE: Postgres numeric(78,0) accepts and round-trips
// 2^256-1 byte-identically.
//
// Run: pnpm exec tsx scripts/verify-uint256.ts
import { Client } from "pg";

const TWO_256_MINUS_1 =
  115792089237316195423570985008687907853269984665640564039457584007913129639935n;

async function main() {
  const client = new Client({
    connectionString:
      process.env.DATABASE_URL ??
      "postgresql://ponder:ponder@127.0.0.1:5444/ponder",
  });
  await client.connect();

  // Fresh schema for this verification
  await client.query(`DROP SCHEMA IF EXISTS spike_a0_6 CASCADE;`);
  await client.query(`CREATE SCHEMA spike_a0_6;`);
  await client.query(`
    CREATE TABLE spike_a0_6.token (
      id text PRIMARY KEY,
      token_id numeric(78, 0) NOT NULL
    );
  `);

  // Write — pass the literal as string (the same way drizzle string-mode
  // sends it, which is what Ponder 0.16.6 + numeric does without mode:bigint).
  const literal = TWO_256_MINUS_1.toString();
  await client.query(
    `INSERT INTO spike_a0_6.token (id, token_id) VALUES ($1, $2);`,
    ["max-uint256", literal],
  );

  // Read
  const { rows } = await client.query<{ id: string; token_id: string }>(
    `SELECT id, token_id::text AS token_id FROM spike_a0_6.token WHERE id = $1;`,
    ["max-uint256"],
  );

  if (rows.length !== 1) {
    throw new Error(`expected 1 row, got ${rows.length}`);
  }
  const roundtrip = BigInt(rows[0].token_id);

  console.log(`[T-A0.6] inserted: ${literal}`);
  console.log(`[T-A0.6] read    : ${rows[0].token_id}`);
  console.log(`[T-A0.6] bigint  : ${roundtrip}`);
  console.log(`[T-A0.6] equal   : ${roundtrip === TWO_256_MINUS_1}`);

  if (roundtrip !== TWO_256_MINUS_1) {
    throw new Error(
      `MISMATCH: roundtrip(${roundtrip}) !== expected(${TWO_256_MINUS_1})`,
    );
  }

  // Also exercise a smaller value + an explicit overflow attempt (79 digits)
  const tooBig = "1" + "0".repeat(78); // 10^78 — exceeds numeric(78,0)
  let overflowRejected = false;
  try {
    await client.query(
      `INSERT INTO spike_a0_6.token (id, token_id) VALUES ($1, $2);`,
      ["too-big", tooBig],
    );
  } catch (err) {
    overflowRejected = true;
    console.log(
      `[T-A0.6] 79-digit literal correctly rejected: ${String(err).split("\n")[0]}`,
    );
  }
  if (!overflowRejected) {
    throw new Error(
      `numeric(78,0) accepted a 79-digit value — precision invariant broken`,
    );
  }

  await client.end();
  console.log(`[T-A0.6] PASS`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
