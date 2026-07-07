/**
 * sqd-loader.ts — CLI: SQD Portal history → svm.collection_event (cycle svm-sqd-substrate, SDD §2.3).
 *
 * The $0 supply lane: members from DAS (metadata-era-agnostic — works for Clay/FFF/GG where
 * Dune's tokens_solana.nft has 4/2/0 members), history from Portal balance diffs, decode via
 * sqd-collection-event-source, writes through the SAME writer with the SAME invariants
 * (insert-if-absent: coarse source never clobbers classified rows; §4.5 gate stays the trust root).
 *
 * Resume: cursor = max slot already ingested for (collection, source='sqd-stream'); `seenMints`
 * pre-seeded from ALL existing mints for the collection so post-resume first-appearances don't
 * masquerade as mints (decode contract — see decodeSqdBlocks doc).
 *
 * CLI: tsx src/svm/sqd-loader.ts --collection <key> [--from-slot N] [--dry]
 */
import { fileURLToPath } from "node:url";
import { SqdClient, MINT_CHUNK, type SqdStreamStats } from "./sqd-client";
import { decodeSqdBlocks } from "./sqd-collection-event-source";
import { DasNftCollectionSource } from "./nft-collection-source";
import { resolveCollection } from "./collection-registry";
import { upsertCollectionEvents } from "./collection-event-writer";
import { writeSyncStatus } from "./sync-status";

const HASURA = (process.env.SVM_HASURA_ENDPOINT ?? "").replace(/\/$/, "");
const SECRET = process.env.HASURA_GRAPHQL_ADMIN_SECRET ?? "";
const RPC = process.env.SOLANA_RPC_URL ?? (process.env.HELIUS_API_KEY ? `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}` : "");

async function hasura<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${HASURA}/v1/graphql`, {
    method: "POST",
    headers: { "x-hasura-admin-secret": SECRET, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const d = (await res.json()) as { data?: T; errors?: unknown };
  if (!res.ok || d.errors) throw new Error(`hasura: ${JSON.stringify(d.errors ?? res.status).slice(0, 200)}`);
  return d.data as T;
}

export async function fetchCursorSlot(collectionKey: string): Promise<number | null> {
  if (!HASURA || !SECRET) return null;
  // Durable cursor first (sprint-bug-173 DISS-001): MAX(slot) of ingested rows is NOT
  // coverage-safe — a capped run upserts chunk-0 events at high slots while later chunks
  // never ran, so resuming from MAX permanently skips their range. The loader persists
  // its coverage-safe cursor to svm.sync_status.sqd_cursor_slot (migration 004); MAX is
  // only the legacy fallback for collections that predate the column.
  const c = await hasura<{ svm_sync_status: Array<{ sqd_cursor_slot: number | null }> }>(
    `query CU($k: String!) { svm_sync_status(where: {collection_key: {_eq: $k}}) { sqd_cursor_slot } }`,
    { k: collectionKey },
  ).catch(() => null);
  // Hasura returns BIGINT columns as strings when HASURA_GRAPHQL_STRINGIFY_NUMERIC_TYPES
  // is set (belt has it on), so both cursor sources arrive as strings — coerce to Number
  // or the loader's from-slot is a string and partitionSlotRange throws "must be integers".
  const durable = c?.svm_sync_status?.[0]?.sqd_cursor_slot;
  if (durable !== null && durable !== undefined) return Number(durable);
  const d = await hasura<{ svm_collection_event: Array<{ slot: number }> }>(
    `query C($k: String!) { svm_collection_event(where: {collection_key: {_eq: $k}, source: {_eq: "sqd-stream"}}, order_by: {slot: desc}, limit: 1) { slot } }`,
    { k: collectionKey },
  );
  const maxSlot = d.svm_collection_event?.[0]?.slot;
  return maxSlot !== null && maxSlot !== undefined ? Number(maxSlot) : null;
}

export async function fetchKnownMints(collectionKey: string): Promise<string[]> {
  if (!HASURA || !SECRET) return [];
  const d = await hasura<{ svm_collection_event: Array<{ nft_mint: string }> }>(
    `query M($k: String!) { svm_collection_event(where: {collection_key: {_eq: $k}}, distinct_on: nft_mint) { nft_mint } }`,
    { k: collectionKey },
  );
  return (d.svm_collection_event ?? []).map((r) => r.nft_mint);
}

export interface SqdLoaderResult extends SqdStreamStats {
  eventsUpserted: number;
  rejectedRows: number;
  ambiguousGroups: number;
  chunks: number;
}

export interface SqdLoaderDeps {
  client: SqdClient;
  members: () => Promise<string[]>;
  cursorSlot: () => Promise<number | null>;
  knownMints: () => Promise<string[]>;
  upsert: typeof upsertCollectionEvents;
  syncStatus: typeof writeSyncStatus;
  log: (m: string) => void;
}

/**
 * Kill switch (T-7 / SDD §7.1): SQD_LIVE_TAIL_ENABLED=false halts the live-tail lane.
 * Returns true when the lane should run. Defaults to true (enabled) when unset.
 */
export function isLiveTailEnabled(log?: (m: string) => void): boolean {
  if (process.env.SQD_LIVE_TAIL_ENABLED === "false") {
    (log ?? console.log)("[SQD] Live-tail disabled via SQD_LIVE_TAIL_ENABLED=false");
    return false;
  }
  return true;
}

export async function runSqdLoader(
  opts: { collectionKey: string; fromSlot?: number; dry?: boolean },
  deps: SqdLoaderDeps,
): Promise<SqdLoaderResult> {
  // Kill switch (SDD §7.1): bail early with empty result if disabled
  if (!isLiveTailEnabled(deps.log)) {
    return { requests: 0, blocks: 0, balanceRows: 0, stoppedAtCap: false, lastSlot: 0, eventsUpserted: 0, rejectedRows: 0, ambiguousGroups: 0, chunks: 0 };
  }
  const cfg = resolveCollection(opts.collectionKey);
  const mints = await deps.members();
  if (mints.length === 0) throw new Error(`no members resolved for ${cfg.collectionKey} — refuse to walk nothing`);
  const head = await deps.client.head();
  const from = opts.fromSlot ?? (await deps.cursorSlot().catch(() => null)) ?? 0;
  // decode first-appearance state seeded from DB — resume must not fabricate mints
  const seen = new Set(opts.fromSlot === 0 || from === 0 ? [] : await deps.knownMints().catch(() => []));
  const chunks: string[][] = [];
  for (let i = 0; i < mints.length; i += MINT_CHUNK) chunks.push(mints.slice(i, i + MINT_CHUNK));

  const stats: SqdStreamStats = { requests: 0, blocks: 0, balanceRows: 0, stoppedAtCap: false, lastSlot: from };
  const result: SqdLoaderResult = { ...stats, eventsUpserted: 0, rejectedRows: 0, ambiguousGroups: 0, chunks: chunks.length };
  const memberSet = new Set(mints);
  let latestBlockTime = 0;
  // DISS-001 fix: track the lastSlot snapshot after each chunk completes so we can
  // derive safeSlot = min(completedChunkSlots) — the highest slot all completed chunks
  // have reached. Using stats.lastSlot (shared MAX) would let a chunk that advanced
  // further inflate the cursor past what earlier chunks covered.
  const completedChunkSlots: number[] = [];
  let chunksRun = 0;
  let capChunkYielded = true;

  deps.log(`[sqd-loader] ${cfg.collectionKey}: ${mints.length} members, ${chunks.length} chunk(s), slots ${from.toLocaleString()}→${head.toLocaleString()}${opts.dry ? " [DRY]" : ""}`);
  for (const [ci, chunk] of chunks.entries()) {
    let chunkYielded = false;
    for await (const blocks of deps.client.stream(chunk, from, head, stats, deps.log)) {
      chunkYielded = true;
      const { events, rejectedRows, ambiguousGroups } = decodeSqdBlocks(blocks, memberSet, seen);
      result.rejectedRows += rejectedRows;
      result.ambiguousGroups += ambiguousGroups;
      if (events.length > 0) {
        latestBlockTime = Math.max(latestBlockTime, ...events.map((e) => e.blockTime).slice(0, 1), events[events.length - 1].blockTime);
        if (!opts.dry) {
          await deps.upsert(events, cfg.collectionKey, cfg.collectionMint, "sqd-stream", { ifAbsentOnly: true });
          result.eventsUpserted += events.length;
        }
      }
    }
    // Only record a slot snapshot when the stream actually yielded blocks. A chunk that
    // yielded nothing made no slot progress and must not contribute a stale/zero slot to
    // the min() — that would hold the cursor back incorrectly.
    if (chunkYielded) completedChunkSlots.push(stats.lastSlot);
    chunksRun = ci + 1;
    deps.log(`[sqd-loader] chunk ${ci + 1}/${chunks.length} done · ${stats.requests} reqs · ${result.eventsUpserted} events`);
    if (stats.stoppedAtCap) {
      // Review iter-1 DISS-002: the breaking chunk only counts as covered if it YIELDED.
      // A cap that fires before the chunk's first yield means zero coverage for it.
      capChunkYielded = chunkYielded;
      break;
    }
  }

  // DISS-001-residual (sprint-bug-173): if the cap fired before ALL chunks produced
  // coverage, min(completedChunkSlots) only covers the chunks that yielded — uncovered
  // chunks have processed nothing past `from`, so ANY advance would permanently skip
  // their slots. Hold the cursor at the pre-run `from` (no advance) and say so loudly.
  // Covers both holes: cap before a later chunk ran (chunksRun < length) AND cap on the
  // final chunk before its first yield (capChunkYielded === false).
  const cappedBeforeAllChunks = stats.stoppedAtCap && (chunksRun < chunks.length || !capChunkYielded);

  // Invariant: at least one chunk must have completed to derive a safe cursor.
  // If nothing ran (stream yielded nothing for any chunk), abort rather than silently
  // returning slot 0 or the pre-run cursor — both would be wrong. A capped-early run
  // is exempt: holding at `from` is the correct (non-fabricated) cursor there.
  if (completedChunkSlots.length === 0 && !cappedBeforeAllChunks) {
    const msg = "[sqd-loader] INVARIANT VIOLATION: no chunks completed — cannot derive safe cursor";
    deps.log(msg);
    throw new Error(msg);
  }

  Object.assign(result, stats);
  if (cappedBeforeAllChunks) {
    deps.log(
      `[sqd-loader] CAP fired after ${chunksRun}/${chunks.length} chunks — holding cursor at ${from.toLocaleString()} (no advance; DISS-001-residual)`,
    );
    result.lastSlot = from;
  } else {
    // safeSlot = min across all chunks that ran. This is the highest slot every completed
    // chunk has covered; resuming from safeSlot+1 on the next run is safe for all chunks.
    // Override lastSlot with safeSlot (DISS-001 fix — do not use the shared MAX).
    result.lastSlot = Math.min(...completedChunkSlots);
  }
  if (!opts.dry) {
    // Persist the coverage-safe cursor EVERY non-dry run (DISS-001 root fix): the durable
    // cursor is the resume authority; without this write, fetchCursorSlot falls back to
    // MAX(slot) of upserted rows, which re-opens the capped-run skip. Freshness fields
    // only when events actually landed (lastEventAt must not fabricate recency).
    const patch: Parameters<typeof deps.syncStatus>[0] = { collectionKey: cfg.collectionKey, sqdCursorSlot: result.lastSlot };
    if (latestBlockTime > 0) {
      patch.lastEventAt = new Date(latestBlockTime * 1000).toISOString();
      patch.lastEventSource = "sqd-stream";
    }
    // Review iter-2 DISS-003: the cursor is a CORRECTNESS write, not telemetry —
    // writeSyncStatus is fail-soft (returns false, never throws), and a silently
    // dropped cursor makes the next run fall back to the poison MAX(slot). One
    // retry, then fail the run loudly (upserts are insert-if-absent → rerun-safe).
    // Strict === true (BB HIGH on #140): writeSyncStatus returns Promise<boolean>;
    // anything else (void from a future signature drift, undefined from a stale mock)
    // must count as FAILURE, not silently dead-code the guard.
    let cursorWritten = (await deps.syncStatus(patch)) === true;
    if (!cursorWritten) cursorWritten = (await deps.syncStatus(patch)) === true;
    if (!cursorWritten) {
      const msg = `[sqd-loader] CURSOR WRITE FAILED for ${cfg.collectionKey} (2 attempts) — refusing to report success: resume would fall back to MAX(slot) and skip capped ranges`;
      deps.log(msg);
      throw new Error(msg);
    }
  }
  deps.log(
    `[sqd-loader] DONE ${cfg.collectionKey}: ${result.eventsUpserted} events · ${result.rejectedRows} rejected rows · ${result.ambiguousGroups} ambiguous groups · ${stats.requests} requests${stats.stoppedAtCap ? " (CAP)" : ""}`,
  );
  return result;
}

function parseArgs(): { collection: string; fromSlot?: number; dry: boolean } {
  const a = process.argv.slice(2);
  const get = (f: string) => { const i = a.indexOf(f); return i >= 0 ? a[i + 1] : undefined; };
  const collection = get("--collection") ?? "";
  if (!collection) throw new Error("--collection <key> required");
  const fs = get("--from-slot");
  return { collection, fromSlot: fs !== undefined ? Number(fs) : undefined, dry: a.includes("--dry") };
}

async function main(): Promise<void> {
  const { collection, fromSlot, dry } = parseArgs();
  if (!dry && (!HASURA || !SECRET)) throw new Error("SVM_HASURA_ENDPOINT + HASURA_GRAPHQL_ADMIN_SECRET required (or --dry)");
  if (!RPC) throw new Error("SOLANA_RPC_URL or HELIUS_API_KEY required (DAS member resolution)");
  const cfg = resolveCollection(collection);
  const das = new DasNftCollectionSource(RPC, cfg.collectionMint);
  const r = await runSqdLoader(
    { collectionKey: collection, fromSlot, dry },
    {
      client: new SqdClient(),
      members: async () => (await das.snapshot()).members.map((m) => m.nftMint),
      cursorSlot: () => fetchCursorSlot(cfg.collectionKey),
      knownMints: () => fetchKnownMints(cfg.collectionKey),
      upsert: upsertCollectionEvents,
      syncStatus: writeSyncStatus,
      log: console.log,
    },
  );
  if (r.ambiguousGroups > 0) console.warn(`[sqd-loader] NOTE: ${r.ambiguousGroups} ambiguous groups rejected — §4.5 gate + G1 recall bound the impact; inspect if recall dips`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => { console.error(`[sqd-loader] FATAL: ${(e as Error).message}`); process.exit(1); });
}
