#!/usr/bin/env node
import { createHash } from "node:crypto";
import pg from "pg";

const databaseUrl = process.env.BENCH_DATABASE_URL?.trim();
if (!databaseUrl) throw new Error("BENCH_DATABASE_URL is required");

const [command, ...args] = process.argv.slice(2);
const pool = new pg.Pool({
  connectionString: databaseUrl,
  ssl: { rejectUnauthorized: false },
  max: 2,
});

function identifier(value) {
  if (!/^bench_[a-z0-9_]+$/.test(value)) {
    throw new Error(`unsafe benchmark schema ${value}`);
  }
  return `"${value.replaceAll('"', '""')}"`;
}

try {
  if (command === "wal") {
    const result = await pool.query(
      "select pg_current_wal_lsn()::text as lsn",
    );
    console.log(JSON.stringify({ lsn: result.rows[0].lsn }));
  } else if (command === "wal-diff") {
    const [before] = args;
    if (!/^[0-9A-F]+\/[0-9A-F]+$/i.test(before ?? "")) {
      throw new Error("wal-diff requires a valid prior LSN");
    }
    const result = await pool.query(
      "select pg_current_wal_lsn()::text as lsn, pg_wal_lsn_diff(pg_current_wal_lsn(), $1)::text as bytes",
      [before],
    );
    console.log(JSON.stringify(result.rows[0]));
  } else if (command === "reset-schema") {
    const [schema] = args;
    if (process.env.BENCH_ALLOW_RESET !== "1") {
      throw new Error("BENCH_ALLOW_RESET=1 is required");
    }
    await pool.query(`drop schema if exists ${identifier(schema)} cascade`);
    console.log(JSON.stringify({ reset: schema }));
  } else if (command === "metrics") {
    const [schema] = args;
    const quoted = identifier(schema);
    const result = await pool.query(`
      select
        (select count(*)::bigint from ${quoted}."Token")::text as token_rows,
        (select count(*)::bigint from ${quoted}."TrackedHolder")::text as holder_rows,
        coalesce((
          select sum(pg_total_relation_size(format('%I.%I', schemaname, tablename)::regclass))::bigint
          from pg_tables where schemaname = $1
        ), 0)::text as relation_bytes
    `, [schema]);
    console.log(JSON.stringify(result.rows[0]));
  } else if (command === "progress") {
    const [schema] = args;
    const quoted = identifier(schema);
    const result = await pool.query(`
      select
        chain_id::text,
        start_block::text,
        block_height::text,
        latest_processed_block::text,
        latest_fetched_block_number::text,
        num_events_processed::text,
        timestamp_caught_up_to_head_or_endblock::text
      from ${quoted}.chain_metadata
      order by chain_id
    `);
    console.log(JSON.stringify(result.rows));
  } else if (command === "hash") {
    const [schema, chain, contract] = args;
    const quoted = identifier(schema);
    const tokens = await pool.query(
      `select "tokenId"::text as token_id, lower("owner") as owner,
              "isBurned"::text as burned
       from ${quoted}."Token"
       where "chainId" = $1 and lower("collection") = lower($2)
       order by "tokenId"`,
      [Number(chain), contract],
    );
    const holders = await pool.query(
      `select lower("address") as address, "tokenCount"::text as token_count
       from ${quoted}."TrackedHolder"
       where "chainId" = $1 and lower("contract") = lower($2)
       order by lower("address")`,
      [Number(chain), contract],
    );
    const tokenHash = createHash("sha256");
    for (const row of tokens.rows) {
      tokenHash.update(`${row.token_id},${row.owner},${row.burned}\n`);
    }
    const holderHash = createHash("sha256");
    for (const row of holders.rows) {
      holderHash.update(`${row.address},${row.token_count}\n`);
    }
    console.log(
      JSON.stringify({
        token_rows: tokens.rowCount,
        token_sha256: tokenHash.digest("hex"),
        holder_rows: holders.rowCount,
        holder_sha256: holderHash.digest("hex"),
      }),
    );
  } else {
    throw new Error(
      "usage: bench-postgres.mjs wal|wal-diff LSN|reset-schema SCHEMA|metrics SCHEMA|progress SCHEMA|hash SCHEMA CHAIN CONTRACT",
    );
  }
} finally {
  await pool.end();
}
