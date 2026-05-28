// scripts/migration/scratch/validate.ts
//
// End-to-end SCRATCH validation of the T-M2 transform. Stands up nothing itself
// (containers are started by the operator / driver script); it connects to a
// scratch SOURCE and TARGET Postgres via SRC_DATABASE_URL / DST_DATABASE_URL,
// builds the synthetic envio source schema + the ponder-shaped target schema
// (with ponder-like USER triggers), seeds synthetic rows, runs the transform
// IN-PROCESS, and ASSERTS the invariants:
//
//   1. snake_case rename correct (target columns populated from camelCase src).
//   2. the 4 type-drifts produce the RIGHT text:
//        - badge_holder.holdings: jsonb serialized to a JSON string.
//        - *_ids: JSON.stringify(ids.map(String))  →  ["1","2"]  NOT  {1,2}.
//   3. UPSERT idempotency: a 2nd run yields identical rows, no dupes.
//   4. batching works (the `action` table > batch size loads completely).
//   5. trigger DISABLE/ENABLE cycle is clean (load succeeds despite the
//      live_query trigger that RAISES on external INSERT; triggers re-enabled
//      after).
//
// SCRATCH-ONLY. Refuses to run against prod-looking URLs.

import { Pool } from "../pg";
import { subsetEntities, buildSourceDDL, buildTargetDDL, SCRATCH_SUBSET } from "./ddl";
import { seedSource } from "./seed";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TRANSFORM = resolve(__dirname, "../transform.ts");
const TSX = resolve(
  __dirname,
  "../../../node_modules/.pnpm/tsx@4.21.0/node_modules/tsx/dist/cli.mjs",
);

const ACTION_ROWS = 12_345; // > default batch (5000) → forces ≥3 batches

let passed = 0;
let failed = 0;
function assert(name: string, cond: boolean, detail = "") {
  if (cond) {
    passed++;
    console.log(`  PASS  ${name}${detail ? "  — " + detail : ""}`);
  } else {
    failed++;
    console.error(`  FAIL  ${name}${detail ? "  — " + detail : ""}`);
  }
}

function runTransform(args: string[]): { code: number; out: string } {
  const r = spawnSync(process.execPath, [TSX, TRANSFORM, ...args], {
    env: process.env,
    encoding: "utf8",
  });
  const out = (r.stdout ?? "") + (r.stderr ?? "");
  return { code: r.status ?? -1, out };
}

async function execSqlScript(pool: Pool, sql: string) {
  // run as a single multi-statement batch
  await pool.query(sql);
}

async function main() {
  const SRC = process.env.SRC_DATABASE_URL;
  const DST = process.env.DST_DATABASE_URL;
  if (!SRC || !DST)
    throw new Error("SRC_DATABASE_URL and DST_DATABASE_URL required (scratch).");
  for (const url of [SRC, DST])
    if (/3vic|vrr1/i.test(url))
      throw new Error("Refusing: a DATABASE_URL points at prod (3vIC/vRR1).");

  const entities = subsetEntities(SCRATCH_SUBSET);
  console.log(
    `scratch validate — subset=${entities.map((e) => e.ponder_table).join(",")}`,
  );

  const src = new Pool({ connectionString: SRC });
  const dst = new Pool({ connectionString: DST });

  try {
    console.log("\n[1/4] build scratch source (envio public.*) + seed synthetic rows");
    await execSqlScript(src, buildSourceDDL(entities));
    await seedSource(src, entities, { actionRows: ACTION_ROWS });

    console.log("[2/4] build scratch target (ponder.* + ponder-shaped USER triggers)");
    await execSqlScript(dst, buildTargetDDL(entities));

    // Prove the live_query trigger actually blocks a naive external INSERT.
    try {
      await dst.query(
        `INSERT INTO ponder."mibera_transfer" (id, "from", "to", token_id, is_mint, "timestamp", block_number, transaction_hash, chain_id) VALUES ('probe','0x0','0x1',0,false,1,1,'0xp',80094)`,
      );
      assert("live_query trigger blocks naive external INSERT", false, "INSERT unexpectedly succeeded");
    } catch (e) {
      assert(
        "live_query trigger blocks naive external INSERT",
        /live_query/.test((e as Error).message),
        "trigger raised as expected",
      );
      // clean up: that failed insert left no row (statement aborted)
    }

    const only = SCRATCH_SUBSET.join(",");

    console.log("\n[3/4] run transform (real, batch=5000) — pass 1");
    const p1 = runTransform(["--only", only, "--batch", "5000"]);
    process.stdout.write(p1.out);
    assert("transform pass-1 exit 0", p1.code === 0, `exit=${p1.code}`);

    // ── assertions on pass-1 output ──
    // 1. rename + counts
    for (const e of entities) {
      const s = await src.query(`SELECT count(*)::int n FROM public."${e.envio_table}"`);
      const d = await dst.query(`SELECT count(*)::int n FROM ponder."${e.ponder_table}"`);
      assert(
        `count parity ${e.ponder_table}`,
        s.rows[0].n === d.rows[0].n,
        `src=${s.rows[0].n} dst=${d.rows[0].n}`,
      );
    }

    // 4. batching: action fully loaded
    {
      const d = await dst.query(`SELECT count(*)::int n FROM ponder."action"`);
      assert("batching: action fully loaded", d.rows[0].n === ACTION_ROWS, `dst=${d.rows[0].n} expected=${ACTION_ROWS}`);
    }

    // snake_case rename spot-checks (camelCase src col → snake_case dst col)
    {
      const d = await dst.query(
        `SELECT action_type, tx_hash, primary_collection FROM ponder."action" WHERE id='action-00000000'`,
      );
      assert(
        "rename action.actionType→action_type",
        d.rows[0].action_type === "MINT",
        `action_type=${d.rows[0].action_type}`,
      );
      assert(
        "rename action.txHash→tx_hash",
        d.rows[0].tx_hash === "0xactionhash0",
      );
    }
    {
      const d = await dst.query(
        `SELECT chain_id, token_count, collection_key FROM ponder."tracked_holder" WHERE id='th-0-80094'`,
      );
      assert("rename tracked_holder.chainId→chain_id", d.rows[0].chain_id === 80094);
      assert("rename tracked_holder.tokenCount→token_count", d.rows[0].token_count === 1);
    }

    // 2. type-drift — jsonb → text
    {
      const d = await dst.query(`SELECT holdings FROM ponder."badge_holder" WHERE id='0xaaa-80094'`);
      const h = d.rows[0].holdings;
      const isString = typeof h === "string";
      let parsedOk = false;
      try {
        const parsed = JSON.parse(h as string);
        parsedOk = parsed["1"] === "2" && parsed.big === "115792089237316195423570985008687907853269984665640564039457584007913129639935";
      } catch { /* */ }
      assert("type-drift jsonb→text: holdings is a string", isString, `typeof=${typeof h}`);
      assert("type-drift jsonb→text: holdings round-trips JSON.parse", parsedOk, `value=${h}`);
      const empty = await dst.query(`SELECT holdings FROM ponder."badge_holder" WHERE id='0xbbb-80094'`);
      assert("type-drift jsonb→text: empty array preserved", empty.rows[0].holdings === "[]", `value=${empty.rows[0].holdings}`);
    }

    // 2. type-drift — bigint[] → JSON text  (the CRITICAL ["1","2"] not {1,2} check)
    {
      const d = await dst.query(`SELECT token_ids FROM ponder."mibera_loan" WHERE id='loan-1'`);
      const v = d.rows[0].token_ids;
      const expected = JSON.stringify([
        "115792089237316195423570985008687907853269984665640564039457584007913129639935",
        "18446744073709551616",
        "1",
      ]);
      assert(
        "type-drift bigint[]→text: token_ids is JSON array form [\"..\"] NOT pg {..}",
        v === expected,
        `value=${v}`,
      );
      assert(
        "type-drift bigint[]→text: NOT a pg array literal (no leading '{')",
        typeof v === "string" && !v.startsWith("{"),
      );
      const empty = await dst.query(`SELECT token_ids FROM ponder."mibera_loan" WHERE id='loan-2'`);
      assert("type-drift bigint[]→text: empty array → []", empty.rows[0].token_ids === "[]", `value=${empty.rows[0].token_ids}`);
    }
    {
      const d = await dst.query(`SELECT nft_ids FROM ponder."paddle_pawn" WHERE id='pawn-1'`);
      assert(
        "type-drift bigint[]→text: paddle_pawn.nft_ids JSON array form",
        d.rows[0].nft_ids === JSON.stringify(["1", "2", "18446744073709551616"]),
        `value=${d.rows[0].nft_ids}`,
      );
    }
    {
      const d = await dst.query(`SELECT nft_ids FROM ponder."paddle_liquidation" WHERE id='liq-1'`);
      assert(
        "type-drift bigint[]→text: paddle_liquidation.nft_ids JSON array form",
        d.rows[0].nft_ids === JSON.stringify(["115792089237316195423570985008687907853269984665640564039457584007913129639935"]),
        `value=${d.rows[0].nft_ids}`,
      );
    }

    // uint256 numeric round-trip (no float coercion)
    {
      const d = await dst.query(`SELECT total_amount FROM ponder."badge_holder" WHERE id='0xaaa-80094'`);
      assert("uint256 numeric round-trip (total_amount)", String(d.rows[0].total_amount) === "1000000000000000000000", `value=${d.rows[0].total_amount}`);
    }

    // 5. trigger re-enabled after load
    {
      const t = await dst.query(
        `SELECT tgenabled FROM pg_trigger WHERE tgname='live_query' AND tgrelid='ponder.mibera_transfer'::regclass`,
      );
      assert("triggers re-enabled after load (live_query tgenabled='O')", t.rows[0]?.tgenabled === "O", `tgenabled=${t.rows[0]?.tgenabled}`);
    }

    // ── 3. idempotency: snapshot dst, run pass-2, compare ──
    console.log("\n[4/4] run transform — pass 2 (idempotency)");
    const snapBefore = await fingerprint(dst, entities);
    const p2 = runTransform(["--only", only, "--batch", "5000"]);
    process.stdout.write(p2.out);
    assert("transform pass-2 exit 0", p2.code === 0, `exit=${p2.code}`);
    const snapAfter = await fingerprint(dst, entities);

    let identical = true;
    const diffs: string[] = [];
    for (const e of entities) {
      if (snapBefore[e.ponder_table] !== snapAfter[e.ponder_table]) {
        identical = false;
        diffs.push(e.ponder_table);
      }
    }
    assert("idempotency: pass-2 produces identical rows (per-table md5)", identical, diffs.length ? `changed: ${diffs.join(",")}` : "all tables byte-identical");

    // no dupes (pk is id; count unchanged)
    for (const e of entities) {
      const before = snapBefore[e.ponder_table + "::count"];
      const after = snapAfter[e.ponder_table + "::count"];
      assert(`idempotency: no dupes ${e.ponder_table}`, before === after, `before=${before} after=${after}`);
    }
  } finally {
    await src.end();
    await dst.end();
  }

  console.log(`\n==== SCRATCH VALIDATION: ${passed} passed, ${failed} failed ====`);
  process.exit(failed === 0 ? 0 : 1);
}

// Per-table fingerprint: md5 over ordered rows + row count.
async function fingerprint(dst: Pool, entities: { ponder_table: string }[]) {
  const out: Record<string, string> = {};
  for (const e of entities) {
    const r = await dst.query<{ h: string; n: number }>(
      `SELECT md5(coalesce(string_agg(t::text, '|' ORDER BY id), '')) AS h, count(*)::int AS n
       FROM ponder."${e.ponder_table}" t`,
    );
    out[e.ponder_table] = r.rows[0].h;
    out[e.ponder_table + "::count"] = String(r.rows[0].n);
  }
  return out;
}

main().catch((err) => {
  console.error("FATAL:", err.message);
  process.exit(1);
});
