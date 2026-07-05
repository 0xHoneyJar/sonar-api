/**
 * warehouse-loader.ts — the FR-1 warehouse supply lane: Dune decoded history → svm.collection_event
 * (SDD §2.3). Ingestion cost moves from O(mints × 100 Enhanced credits) to a fraction of a Dune
 * credit per window (measured 2026-07-05: 0.22cr date-bounded vs ~440k Helius credits per pythians
 * full walk — the #121 ramp's cost model rests on this lane).
 *
 * Converges with the webhook/Enhanced pipes on the content-addressed PK {tx}:{mint}:{index} — so the
 * ordinal MUST be the per-(tx,mint) occurrence rule the parser uses (collection-event-source.ts:124),
 * NOT the raw instruction index. Rows are UNTRUSTED input (SDD §3): malformed rows are rejected and
 * counted, never coerced.
 *
 * Kind policy (T-2 default): action → mint/transfer/burn 1:1. Marketplace kinds ship later behind the
 * SVM_EMIT_MARKETPLACE_KINDS precedent — a wrong kind is worse than a coarse one (#85 re-backfill
 * pattern exists for exactly this reclassification).
 *
 * CLI: tsx src/svm/warehouse-loader.ts --collection <key> [--from <iso>] [--to <iso>] [--dry]
 */
import { fileURLToPath } from "node:url";
import { DuneClient } from "./dune-client";
import { resolveCollection } from "./collection-registry";
import { upsertCollectionEvents } from "./collection-event-writer";
import type { CollectionEvent } from "./collection-event-source";
import { writeSyncStatus } from "./sync-status";

const HASURA = (process.env.SVM_HASURA_ENDPOINT ?? "").replace(/\/$/, "");
const SECRET = process.env.HASURA_GRAPHQL_ADMIN_SECRET ?? "";

/** Dune saved-query ids for src/svm/sql/*.sql — recorded in the rollout runbook when saved. */
export const WAREHOUSE_QUERY_IDS = {
  events: Number(process.env.DUNE_EVENTS_QUERY_ID ?? 0),
};

const WINDOW_DAYS = 30;
// FL SKP-004: optional per-run Dune credit budget. The loop stops CLEANLY between windows when
// cumulative credits exceed it; the DB cursor makes a re-run resume from the last ingested event,
// so an aborted load loses nothing (idempotent PK + windowed commits).
const CREDIT_BUDGET = Number(process.env.DUNE_CREDIT_BUDGET ?? 0) || null;
const GENESIS_FALLBACK = "2020-01-01T00:00:00Z"; // pre-dates all Solana NFT activity; real runs cursor forward

/** Raw row shape from warehouse-events.sql — validated field-by-field before mapping. */
export interface WarehouseRow {
  action?: unknown;
  block_slot?: unknown;
  block_time?: unknown;
  tx_id?: unknown;
  outer_instruction_index?: unknown;
  inner_instruction_index?: unknown;
  token_mint_address?: unknown;
  from_owner?: unknown;
  to_owner?: unknown;
  outer_executing_account?: unknown;
}

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const ACTIONS = new Set(["mint", "transfer", "burn"]);

interface ValidRow {
  action: "mint" | "transfer" | "burn";
  slot: number;
  blockTime: number; // unix seconds
  txId: string;
  outerIdx: number;
  innerIdx: number;
  mint: string;
  fromOwner: string | null;
  toOwner: string | null;
}

/** Validate one untrusted warehouse row. Returns null (rejected) rather than coercing. */
export function validateRow(r: WarehouseRow): ValidRow | null {
  if (typeof r.action !== "string" || !ACTIONS.has(r.action)) return null;
  if (typeof r.token_mint_address !== "string" || !BASE58.test(r.token_mint_address)) return null;
  if (typeof r.tx_id !== "string" || r.tx_id.length < 32) return null;
  const slot = Number(r.block_slot);
  if (!Number.isInteger(slot) || slot <= 0) return null;
  const t = Date.parse(String(r.block_time));
  if (!Number.isFinite(t)) return null;
  const outerIdx = Number(r.outer_instruction_index ?? 0);
  const innerIdx = Number(r.inner_instruction_index ?? 0);
  if (!Number.isFinite(outerIdx) || !Number.isFinite(innerIdx)) return null;
  const owner = (v: unknown): string | null => (typeof v === "string" && BASE58.test(v) ? v : null);
  return {
    action: r.action as ValidRow["action"],
    slot,
    blockTime: Math.floor(t / 1000),
    txId: r.tx_id,
    outerIdx,
    innerIdx,
    mint: r.token_mint_address,
    fromOwner: owner(r.from_owner),
    toOwner: owner(r.to_owner),
  };
}

/**
 * Map validated rows → CollectionEvents with the parser's per-(tx,mint) occurrence ordinal:
 * rows are ordered within a tx by (outer, inner) instruction index, and each mint's legs number
 * 0..n in that order — byte-identical PKs with the Enhanced/webhook path for the same tx.
 */
export function mapRows(rows: ValidRow[]): CollectionEvent[] {
  const sorted = [...rows].sort(
    (a, b) => a.slot - b.slot || a.txId.localeCompare(b.txId) || a.outerIdx - b.outerIdx || a.innerIdx - b.innerIdx,
  );
  const seen = new Map<string, number>(); // `${txId}:${mint}` → next ordinal
  return sorted.map((r) => {
    const k = `${r.txId}:${r.mint}`;
    const ordinal = seen.get(k) ?? 0;
    seen.set(k, ordinal + 1);
    return {
      nftMint: r.mint,
      kind: r.action,
      from: r.action === "mint" ? null : r.fromOwner,
      to: r.action === "burn" ? null : r.toOwner,
      instructionIndex: ordinal,
      price: null,
      marketplace: null,
      slot: r.slot,
      blockTime: r.blockTime,
      txSignature: r.txId,
    };
  });
}

/** [from, to) windows of WINDOW_DAYS between two instants — bounded queries are the cost model. */
export function windowsBetween(fromIso: string, toIso: string, windowDays = WINDOW_DAYS): Array<{ from: string; to: string }> {
  const from = Date.parse(fromIso);
  const to = Date.parse(toIso);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) return [];
  const out: Array<{ from: string; to: string }> = [];
  const step = windowDays * 86_400_000;
  for (let a = from; a < to; a += step) {
    out.push({ from: new Date(a).toISOString(), to: new Date(Math.min(a + step, to)).toISOString() });
  }
  return out;
}

/** Resume cursor: latest ingested block_time for the collection (loader is idempotent, so overlap is safe). */
async function fetchCursor(collectionKey: string): Promise<string | null> {
  if (!HASURA || !SECRET) return null;
  const res = await fetch(`${HASURA}/v1/graphql`, {
    method: "POST",
    headers: { "x-hasura-admin-secret": SECRET, "Content-Type": "application/json" },
    body: JSON.stringify({
      query: `query Cursor($k: String!) { svm_collection_event(where: {collection_key: {_eq: $k}, source: {_eq: "dune-warehouse"}}, order_by: {block_time: desc}, limit: 1) { block_time } }`, // warehouse rows ONLY — a webhook row must not make a first load skip history (Codex P1)
      variables: { k: collectionKey },
    }),
  });
  const d = (await res.json()) as { data?: { svm_collection_event?: Array<{ block_time: string }> } };
  return d.data?.svm_collection_event?.[0]?.block_time ?? null;
}

export interface LoaderDeps {
  dune: Pick<DuneClient, "runQuery">;
  upsert: typeof upsertCollectionEvents;
  syncStatus: typeof writeSyncStatus;
  log: (m: string) => void;
}

export interface LoaderResult {
  windows: number;
  rowsFetched: number;
  rowsRejected: number;
  eventsUpserted: number;
  duneCredits: number;
}

/** The loader flow, dependency-injected for tests (main() is the thin CLI wrapper). */
export async function runLoader(
  opts: { collectionKey: string; from?: string; to?: string; dry?: boolean },
  deps: LoaderDeps,
): Promise<LoaderResult> {
  const cfg = resolveCollection(opts.collectionKey);
  const from = opts.from ?? (await fetchCursor(cfg.collectionKey).catch(() => null)) ?? GENESIS_FALLBACK;
  const to = opts.to ?? new Date().toISOString();
  const windows = windowsBetween(from, to);
  const result: LoaderResult = { windows: windows.length, rowsFetched: 0, rowsRejected: 0, eventsUpserted: 0, duneCredits: 0 };
  if (!WAREHOUSE_QUERY_IDS.events) throw new Error("DUNE_EVENTS_QUERY_ID required (saved warehouse-events.sql query id)");
  let latestIso: string | null = null;

  for (const w of windows) {
    const { rows, executionCostCredits } = await deps.dune.runQuery<WarehouseRow>(
      WAREHOUSE_QUERY_IDS.events,
      { collection_mint: cfg.collectionMint, from_time: w.from.replace("T", " ").replace(/\.\d+Z$/, ""), to_time: w.to.replace("T", " ").replace(/\.\d+Z$/, "") },
      { log: deps.log },
    );
    result.duneCredits += executionCostCredits ?? 0;
    result.rowsFetched += rows.length;
    const valid: ValidRow[] = [];
    for (const r of rows) {
      const v = validateRow(r);
      if (v) valid.push(v);
      else result.rowsRejected++;
    }
    const events = mapRows(valid);
    if (events.length > 0) {
      latestIso = new Date(Math.max(...events.map((e) => e.blockTime)) * 1000).toISOString();
      if (!opts.dry) {
        await deps.upsert(events, cfg.collectionKey, cfg.collectionMint, "dune-warehouse", { ifAbsentOnly: true }); // coarse source never clobbers classified rows (Codex P1)
        result.eventsUpserted += events.length;
      }
    }
    deps.log(`[loader] ${cfg.collectionKey} ${w.from}..${w.to}: ${rows.length} rows, ${events.length} events${opts.dry ? " [DRY]" : ""}`);
    if (CREDIT_BUDGET && result.duneCredits > CREDIT_BUDGET) {
      deps.log(`[loader] STOP: Dune credit budget ${CREDIT_BUDGET} exceeded (${result.duneCredits} spent) — window committed; re-run resumes from cursor (FL SKP-004)`);
      break;
    }
  }

  if (!opts.dry && latestIso) {
    await deps.syncStatus({ collectionKey: cfg.collectionKey, lastEventAt: latestIso, lastEventSource: "dune-warehouse" });
  }
  deps.log(
    `[loader] DONE ${cfg.collectionKey}: ${result.eventsUpserted} events from ${result.rowsFetched} rows (${result.rowsRejected} rejected) · ${result.duneCredits} Dune credits`,
  );
  return result;
}

function parseArgs(): { collection: string; from?: string; to?: string; dry: boolean } {
  const a = process.argv.slice(2);
  const get = (flag: string) => {
    const i = a.indexOf(flag);
    return i >= 0 ? a[i + 1] : undefined;
  };
  const collection = get("--collection") ?? "";
  if (!collection) throw new Error("--collection <key> required");
  return { collection, from: get("--from"), to: get("--to"), dry: a.includes("--dry") };
}

async function main(): Promise<void> {
  const { collection, from, to, dry } = parseArgs();
  if (!dry && (!process.env.SVM_HASURA_ENDPOINT || !process.env.HASURA_GRAPHQL_ADMIN_SECRET)) {
    throw new Error("SVM_HASURA_ENDPOINT + HASURA_GRAPHQL_ADMIN_SECRET required (or pass --dry)");
  }
  const r = await runLoader(
    { collectionKey: collection, from, to, dry },
    { dune: new DuneClient(), upsert: upsertCollectionEvents, syncStatus: writeSyncStatus, log: console.log },
  );
  if (r.rowsRejected > 0) console.warn(`[loader] WARNING: ${r.rowsRejected} malformed rows rejected — inspect before trusting completeness`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error(`[loader] FATAL: ${(e as Error).message}`);
    process.exit(1);
  });
}
