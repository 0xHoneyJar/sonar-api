/**
 * mp-reclassify.mjs — ONE-OFF interim historical reclassify of marketplace escrow transfers →
 * list/delist, IN-PLACE on the existing svm.collection_event rows (the Helius credit quota is
 * exhausted, so the authoritative re-walk can't run now). Sound for the ME/Tensor escrows:
 *   kind='transfer' AND to=<escrow>   → list   (owner→escrow listing)
 *   kind='transfer' AND from=<escrow> → delist (escrow→owner cancel)
 * Sales decode to kind='sale' (escrow→buyer leg skipped), so they're untouched — EXCEPT the bounded
 * lossy case: an aggregator/bundle NFT_SALE with `events.nft` absent falls through to tokenTransfers and
 * records both legs as kind='transfer' (collection-event-source.ts:191-193), so this pass mislabels that
 * sale's legs as list+delist. Bounded by the same ~1% the reconcile gate tolerates, one-off, and the
 * eventual Helius backfill overwrites it via the authoritative NFT_LISTING decode. Acceptable (FAGAN MINOR-3).
 * The interim pass sets kind + marketplace only — which the #85 issue said is enough; the ask `price`
 * lands with the Helius backfill.
 * READ-ONLY by default; pass --apply to write. Admin secret comes from the injected env (railway run).
 */
const ENDPOINT = (process.env.SVM_HASURA_ENDPOINT || "").replace(/\/$/, "");
const SECRET = process.env.HASURA_GRAPHQL_ADMIN_SECRET || "";
const APPLY = process.argv.includes("--apply");

// escrow → marketplace. ME confirmed earlier; others filled from the identify step below before --apply.
const ESCROWS = {
  "1BWutmTvYPwDtmw9abTkS4Ssr8no61spGAvW1X6NDix": "MAGIC_EDEN", // confirmed: 5,720 events, matches issue table
  "4zdNGgAtFsW1cQgHqkiWyRsxaAgxrSRRynnuunxzjxue": "TENSOR", // confirmed: 4,514 events, exactly matches issue table
};

async function runSql(sql, write = false) {
  const r = await fetch(`${ENDPOINT}/v2/query`, {
    method: "POST",
    headers: { "x-hasura-admin-secret": SECRET, "content-type": "application/json" },
    body: JSON.stringify({ type: "run_sql", args: { source: "default", sql, read_only: !write } }),
  });
  if (!r.ok) throw new Error(`run_sql ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const d = await r.json();
  if (d.error) throw new Error(JSON.stringify(d).slice(0, 200));
  return d.result || [];
}
const cell = (res) => (res && res[1] ? res[1][0] : "?");

(async () => {
  // 1. IDENTIFY escrows by frequency (read-only) so we don't assume the set.
  const topTo = await runSql(`SELECT "to", count(*) c FROM svm.collection_event WHERE kind='transfer' AND "to" IS NOT NULL GROUP BY "to" ORDER BY c DESC LIMIT 10;`);
  const topFrom = await runSql(`SELECT "from", count(*) c FROM svm.collection_event WHERE kind='transfer' AND "from" IS NOT NULL GROUP BY "from" ORDER BY c DESC LIMIT 10;`);
  console.log("TOP transfer `to` (escrows = high count):");
  for (const row of topTo.slice(1)) console.log(`   ${row[0]}  ${row[1]}`);
  console.log("TOP transfer `from`:");
  for (const row of topFrom.slice(1)) console.log(`   ${row[0]}  ${row[1]}`);

  // 2. preview / apply per known escrow
  for (const [escrow, mp] of Object.entries(ESCROWS)) {
    const listN = cell(await runSql(`SELECT count(*) FROM svm.collection_event WHERE kind='transfer' AND "to"='${escrow}';`));
    const delistN = cell(await runSql(`SELECT count(*) FROM svm.collection_event WHERE kind='transfer' AND "from"='${escrow}';`));
    console.log(`${APPLY ? "[APPLY]" : "[dry]"} ${mp} ${escrow.slice(0, 8)}…: → list ${listN}, → delist ${delistN}`);
    if (APPLY) {
      await runSql(`UPDATE svm.collection_event SET kind='list', marketplace='${mp}' WHERE kind='transfer' AND "to"='${escrow}';`, true);
      await runSql(`UPDATE svm.collection_event SET kind='delist', marketplace='${mp}' WHERE kind='transfer' AND "from"='${escrow}';`, true);
    }
  }
  if (APPLY) {
    const tot = await runSql(`SELECT kind, count(*) c FROM svm.collection_event GROUP BY kind ORDER BY c DESC;`);
    console.log("post-apply kind distribution:");
    for (const row of tot.slice(1)) console.log(`   ${row[0]}  ${row[1]}`);
  }
})().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
