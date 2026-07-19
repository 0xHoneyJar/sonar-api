#!/usr/bin/env node
/**
 * Canary: independent HyperSync Transfer stream vs RH sidecar Token ownership.
 *
 * Env:
 *   ENVIO_API_TOKEN          required
 *   RH_DATABASE_URL          Postgres public/private URL for sidecar DB
 *   RH_CONTRACT              default StonkBrokers
 *   RH_START_BLOCK           default 12493793
 *   RH_HYPERSYNC_URL         default https://4663.hypersync.xyz
 *
 * Exit 0 on owner-map match; 1 on mismatch / probe failure.
 */
import { createHash } from "node:crypto";
import pg from "pg";

const TRANSFER_TOPIC0 =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const ZERO = "0x0000000000000000000000000000000000000000";
const ADDR = (process.env.RH_CONTRACT || "0x539cdd042c2f3d93ebc5be7dfff0c79f3b4fabf0").toLowerCase();
const START = Number(process.env.RH_START_BLOCK || 12_493_793);
const HS_URL = (process.env.RH_HYPERSYNC_URL || "https://4663.hypersync.xyz").replace(/\/$/, "");
const TOKEN = process.env.ENVIO_API_TOKEN?.trim();
const DB = process.env.RH_DATABASE_URL?.trim();

if (!TOKEN || !DB) {
  console.error("ENVIO_API_TOKEN and RH_DATABASE_URL required");
  process.exit(1);
}

function topicAddress(topic) {
  if (!topic) return ZERO;
  return (`0x${String(topic).slice(-40)}`).toLowerCase();
}

function topicUint(topic) {
  return BigInt(topic || "0x0").toString();
}

async function queryHypersync(from, to) {
  const res = await fetch(`${HS_URL}/query`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify({
      from_block: from,
      to_block: to,
      logs: [{ address: [ADDR], topics: [[TRANSFER_TOPIC0]] }],
      field_selection: {
        log: [
          "block_number",
          "log_index",
          "transaction_index",
          "address",
          "topic0",
          "topic1",
          "topic2",
          "topic3",
          "data",
        ],
      },
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`hypersync HTTP ${res.status}: ${await res.text()}`);
  return res.json();
}

function extractLogs(payload) {
  const data = payload.data;
  if (!data) return [];
  if (Array.isArray(data)) {
    return data.flatMap((batch) => batch.logs ?? []);
  }
  if (Array.isArray(data.logs)) return data.logs;
  return [];
}

async function main() {
  const client = new pg.Client({
    connectionString: DB,
    ssl: DB.includes("localhost") ? undefined : { rejectUnauthorized: false },
  });
  await client.connect();
  const cm = await client.query(
    `SELECT latest_processed_block, block_height, is_hyper_sync, num_events_processed
     FROM chain_metadata WHERE chain_id=4663`,
  );
  if (!cm.rows[0]) throw new Error("no chain_metadata for 4663");
  const H0 = Number(cm.rows[0].latest_processed_block);
  if (!Number.isFinite(H0) || H0 < START) throw new Error(`bad H0 ${H0}`);

  const tokens = await client.query(
    `SELECT "tokenId"::text AS token_id, lower(owner) AS owner, "isBurned" AS burned
     FROM "Token"
     WHERE "chainId"=4663 AND lower(collection)=$1
     ORDER BY "tokenId"`,
    [ADDR],
  );

  const owners = new Map();
  let from = START;
  let pages = 0;
  let events = 0;
  while (from <= H0) {
    const to = Math.min(from + 100_000, H0 + 1);
    const payload = await queryHypersync(from, to);
    for (const log of extractLogs(payload)) {
      const toAddr = topicAddress(log.topic2);
      const tokenId = topicUint(log.topic3);
      owners.set(tokenId, toAddr);
      events += 1;
    }
    const next = Number(payload.next_block ?? to);
    pages += 1;
    if (next <= from) break;
    from = next;
    if (pages > 10_000) throw new Error("page cap");
  }

  // Alive owner maps (exclude burned / zero current owner)
  const hsAlive = new Map([...owners.entries()].filter(([, o]) => o !== ZERO));
  const sideAlive = new Map(
    tokens.rows.filter((r) => !r.burned && r.owner !== ZERO).map((r) => [r.token_id, r.owner]),
  );

  const serialize = (m) =>
    [...m.entries()]
      .sort((a, b) => (BigInt(a[0]) < BigInt(b[0]) ? -1 : BigInt(a[0]) > BigInt(b[0]) ? 1 : 0))
      .map(([t, o]) => `${t}:${o}`)
      .join("\n");

  const hsDigest = createHash("sha256").update(serialize(hsAlive)).digest("hex");
  const sideDigest = createHash("sha256").update(serialize(sideAlive)).digest("hex");

  let missingSidecar = 0;
  let missingHs = 0;
  let ownerMismatch = 0;
  for (const [tid, owner] of hsAlive) {
    const s = sideAlive.get(tid);
    if (!s) missingSidecar += 1;
    else if (s !== owner) ownerMismatch += 1;
  }
  for (const tid of sideAlive.keys()) {
    if (!hsAlive.has(tid)) missingHs += 1;
  }

  const ok =
    hsDigest === sideDigest &&
    missingSidecar === 0 &&
    missingHs === 0 &&
    ownerMismatch === 0 &&
    Boolean(cm.rows[0].is_hyper_sync);

  const report = {
    schema_version: 1,
    ok,
    contract: ADDR,
    start_block: START,
    H0,
    sidecar: {
      is_hyper_sync: cm.rows[0].is_hyper_sync,
      num_events_processed: Number(cm.rows[0].num_events_processed),
      token_rows: tokens.rows.length,
      alive: sideAlive.size,
    },
    hypersync: { pages, events, alive: hsAlive.size },
    digests: { hs: hsDigest, sidecar: sideDigest, match: hsDigest === sideDigest },
    diffs: { missingSidecar, missingHs, ownerMismatch },
  };
  console.log(JSON.stringify(report, null, 2));
  await client.end();
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
