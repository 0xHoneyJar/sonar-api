/**
 * sqd-parallel-loader.ts — range-partitioned PARALLEL SQD backfill (GATE-3 escape).
 * Cycle: svm-deep-history-spike (bead bd-73td). SDD §8.1 batch-lane, refined by the GATE-3 measurement.
 *
 * WHY (measured, grimoires/loa/context/2026-07-06-lake-decision-record.md GATE-3):
 * the naive sequential loader hits a density wall — ~713k (pythians, 3 chunks) to ~1.44M (smb_gen2,
 * 4 chunks) SQD Portal requests for a full-genesis sync (~558 slots/request, block-batch-bound),
 * i.e. ~5-10 days sequential at ~0.58s/req. Strategy B (unfiltered full-block scan) was REFUTED
 * (same slots/req + 261 MiB/req + ~59 TB). The MEASURED escape is parallelism: SQD Portal serves
 * >=20 concurrent unauth requests (all 200, ~10x speedup) -> ~6-12h/collection.
 *
 * DESIGN — two-phase, to preserve `decodeSqdBlocks`' ordered first-appearance rule (DO-NOT-CHANGE:
 * "mint = gaining only AND the mint has never been seen before by this decode pass",
 * sqd-collection-event-source.ts:13-14,92). Parallelising the DECODE would reorder the seenMints
 * stream and misclassify mints -> §4.5 failure. So we parallelise only the network-bound FETCH:
 *
 *   Phase 1 (PARALLEL — the bottleneck): partition [from, head) into N disjoint slot ranges; fetch
 *     filtered block batches for each (member-chunk × range) via SqdClient.stream, concurrently
 *     through a bounded pool of `concurrency`. Filtered blocks carry only member rows -> small ->
 *     cheap to buffer.
 *   Phase 2 (SEQUENTIAL — fast, CPU-bound): decode buffered batches in the SAME order the sequential
 *     loader uses (chunk-major, then range/slot order) with ONE accumulating seenMints set, then
 *     upsert (insert-if-absent). Feeding decodeSqdBlocks the identical batches in the identical
 *     per-mint slot order makes decode output byte-identical to the sequential loader ->
 *     §4.5 parity preserved BY CONSTRUCTION.
 *
 * `decodeSqdBlocks` and `SqdClient` are UNCHANGED. `concurrency <= 1` delegates to the proven
 * `runSqdLoader`. Cursor is conservative (DISS-001): advance to head only if no range hit the request
 * cap; otherwise hold at `from` (resume re-fetches — upserts are insert-if-absent, so rerun-safe).
 *
 * Run: SVM_HASURA_ENDPOINT=<h> HASURA_GRAPHQL_ADMIN_SECRET=<s> HELIUS_API_KEY=<k> \
 *      npx tsx src/svm/sqd-parallel-loader.ts --collection pythians --from-slot 0 --concurrency 20 [--dry]
 */
import { fileURLToPath } from "node:url";
import { SqdClient, MINT_CHUNK, type SqdStreamStats } from "./sqd-client";
import { decodeSqdBlocks, type SqdBlock } from "./sqd-collection-event-source";
import { DasNftCollectionSource } from "./nft-collection-source";
import { resolveCollection } from "./collection-registry";
import { upsertCollectionEvents } from "./collection-event-writer";
import { writeSyncStatus } from "./sync-status";
import {
  runSqdLoader,
  isLiveTailEnabled,
  fetchCursorSlot,
  fetchKnownMints,
  type SqdLoaderDeps,
  type SqdLoaderResult,
} from "./sqd-loader";

const HASURA = (process.env.SVM_HASURA_ENDPOINT ?? "").replace(/\/$/, "");
const SECRET = process.env.HASURA_GRAPHQL_ADMIN_SECRET ?? "";
const RPC = process.env.SOLANA_RPC_URL ?? (process.env.HELIUS_API_KEY ? `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}` : "");

/**
 * Split [from, to) into <= n disjoint, contiguous, gap-free slot ranges ([start, end) half-open),
 * ascending. Returns [] when the span is empty. Pure — the unit under test.
 */
export function partitionSlotRange(from: number, to: number, n: number): Array<[number, number]> {
  if (!Number.isInteger(from) || !Number.isInteger(to)) throw new Error("partitionSlotRange: from/to must be integers");
  if (n < 1) throw new Error("partitionSlotRange: n must be >= 1");
  if (to <= from) return [];
  const parts = Math.min(n, to - from); // never more ranges than slots
  const size = Math.ceil((to - from) / parts);
  const ranges: Array<[number, number]> = [];
  for (let start = from; start < to; start += size) ranges.push([start, Math.min(start + size, to)]);
  return ranges;
}

/** Run `tasks` through a pool of at most `limit` concurrent workers; preserves input order in results. */
async function boundedPool<T>(tasks: ReadonlyArray<() => Promise<T>>, limit: number): Promise<T[]> {
  const results = new Array<T>(tasks.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < tasks.length) {
      const i = next++;
      results[i] = await tasks[i]();
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, tasks.length)) }, worker));
  return results;
}

const emptyResult = (lastSlot: number): SqdLoaderResult => ({
  requests: 0, blocks: 0, balanceRows: 0, stoppedAtCap: false, lastSlot,
  eventsUpserted: 0, rejectedRows: 0, ambiguousGroups: 0, chunks: 0,
});

/**
 * Parallel range-partitioned backfill. `concurrency <= 1` delegates to the proven sequential loader.
 * Otherwise runs the two-phase (parallel fetch -> ordered decode) design documented above.
 */
export async function runSqdParallelLoader(
  opts: { collectionKey: string; fromSlot?: number; concurrency?: number; dry?: boolean },
  deps: SqdLoaderDeps,
): Promise<SqdLoaderResult> {
  const concurrency = Math.max(1, Math.floor(opts.concurrency ?? 1));
  if (concurrency === 1) return runSqdLoader(opts, deps); // proven base case — no divergent code path

  if (!isLiveTailEnabled(deps.log)) return emptyResult(0);

  const cfg = resolveCollection(opts.collectionKey);
  const mints = await deps.members();
  if (mints.length === 0) throw new Error(`no members resolved for ${cfg.collectionKey} — refuse to walk nothing`);

  const head = await deps.client.head();
  const from = opts.fromSlot ?? (await deps.cursorSlot().catch(() => null)) ?? 0;
  if (from >= head) {
    deps.log(`[sqd-parallel] ${cfg.collectionKey}: from ${from.toLocaleString()} >= head ${head.toLocaleString()} — nothing to backfill`);
    return emptyResult(from);
  }

  const memberSet = new Set(mints);
  const chunks: string[][] = [];
  for (let i = 0; i < mints.length; i += MINT_CHUNK) chunks.push(mints.slice(i, i + MINT_CHUNK));
  const ranges = partitionSlotRange(from, head, concurrency);

  deps.log(
    `[sqd-parallel] ${cfg.collectionKey}: ${mints.length} members, ${chunks.length} chunk(s) × ${ranges.length} range(s), ` +
      `slots ${from.toLocaleString()}→${head.toLocaleString()}, concurrency ${concurrency}${opts.dry ? " [DRY]" : ""}`,
  );

  // ── Phase 1: PARALLEL fetch — one task per (chunk, range). Each buffers its filtered batches. ──
  interface Fetched { ci: number; ri: number; batches: SqdBlock[][]; stats: SqdStreamStats }
  const tasks: Array<() => Promise<Fetched>> = [];
  for (let ci = 0; ci < chunks.length; ci++) {
    for (let ri = 0; ri < ranges.length; ri++) {
      const [rStart, rEnd] = ranges[ri];
      tasks.push(async () => {
        const stats: SqdStreamStats = { requests: 0, blocks: 0, balanceRows: 0, stoppedAtCap: false, lastSlot: rStart };
        const batches: SqdBlock[][] = [];
        // stream() drives its own continuation over [rStart, rEnd); we only buffer (no decode here).
        for await (const blocks of deps.client.stream(chunks[ci], rStart, rEnd, stats, () => {})) batches.push(blocks);
        return { ci, ri, batches, stats };
      });
    }
  }
  const fetched = await boundedPool(tasks, concurrency);

  // Aggregate fetch stats; index buffers by (chunk, range) into a 2D grid (numeric indices, not a Map).
  const agg: SqdStreamStats = { requests: 0, blocks: 0, balanceRows: 0, stoppedAtCap: false, lastSlot: from };
  const grid: SqdBlock[][][][] = chunks.map(() => ranges.map(() => [] as SqdBlock[][]));
  for (const f of fetched) {
    agg.requests += f.stats.requests;
    agg.blocks += f.stats.blocks;
    agg.balanceRows += f.stats.balanceRows;
    if (f.stats.stoppedAtCap) agg.stoppedAtCap = true;
    grid[f.ci][f.ri] = f.batches;
  }
  deps.log(`[sqd-parallel] fetch done · ${agg.requests} reqs · ${agg.blocks} blocks${agg.stoppedAtCap ? " (CAP fired)" : ""}`);

  // ── Phase 2: SEQUENTIAL ordered decode — chunk-major, then range/slot order (mirrors runSqdLoader). ──
  // seenMints seeded from DB known-mints so resume does not fabricate first-appearances (unless from 0).
  const seen = new Set(from === 0 ? [] : await deps.knownMints().catch(() => []));
  const result: SqdLoaderResult = { ...agg, eventsUpserted: 0, rejectedRows: 0, ambiguousGroups: 0, chunks: chunks.length };
  let latestBlockTime = 0;
  for (let ci = 0; ci < chunks.length; ci++) {
    for (let ri = 0; ri < ranges.length; ri++) {
      for (const blocks of grid[ci][ri]) {
        const { events, rejectedRows, ambiguousGroups } = decodeSqdBlocks(blocks, memberSet, seen);
        result.rejectedRows += rejectedRows;
        result.ambiguousGroups += ambiguousGroups;
        if (events.length > 0) {
          latestBlockTime = Math.max(latestBlockTime, events[events.length - 1].blockTime);
          if (!opts.dry) {
            await deps.upsert(events, cfg.collectionKey, cfg.collectionMint, "sqd-stream", { ifAbsentOnly: true });
            result.eventsUpserted += events.length;
          }
        }
      }
    }
  }

  // Cursor (DISS-001 conservative): without a cap, every range's stream ran to exhaustion of its
  // [rStart, rEnd) — coverage is complete, advance to head. If ANY range capped, a hole exists —
  // hold at `from` (no advance) and say so; resume re-fetches (upserts are insert-if-absent).
  result.lastSlot = agg.stoppedAtCap ? from : head;
  if (!opts.dry) {
    const patch: Parameters<typeof deps.syncStatus>[0] = { collectionKey: cfg.collectionKey, sqdCursorSlot: result.lastSlot };
    if (latestBlockTime > 0) {
      patch.lastEventAt = new Date(latestBlockTime * 1000).toISOString();
      patch.lastEventSource = "sqd-stream";
    }
    let ok = (await deps.syncStatus(patch)) === true;
    if (!ok) ok = (await deps.syncStatus(patch)) === true;
    if (!ok) {
      const msg = `[sqd-parallel] CURSOR WRITE FAILED for ${cfg.collectionKey} (2 attempts) — refusing to report success: resume would fall back to MAX(slot) and skip capped ranges`;
      deps.log(msg);
      throw new Error(msg);
    }
  }

  deps.log(
    `[sqd-parallel] DONE ${cfg.collectionKey}: ${result.eventsUpserted} events · ${result.rejectedRows} rejected · ` +
      `${result.ambiguousGroups} ambiguous · ${result.requests} requests${agg.stoppedAtCap ? " (CAP — cursor held at from)" : ` · cursor→${result.lastSlot.toLocaleString()}`}`,
  );
  return result;
}

function parseArgs(): { collection: string; fromSlot?: number; concurrency: number; dry: boolean } {
  const a = process.argv.slice(2);
  const get = (f: string) => { const i = a.indexOf(f); return i >= 0 ? a[i + 1] : undefined; };
  const collection = get("--collection") ?? "";
  if (!collection) throw new Error("--collection <key> required");
  const fs = get("--from-slot");
  const cc = get("--concurrency");
  return { collection, fromSlot: fs !== undefined ? Number(fs) : undefined, concurrency: cc !== undefined ? Number(cc) : 1, dry: a.includes("--dry") };
}

async function main(): Promise<void> {
  const { collection, fromSlot, concurrency, dry } = parseArgs();
  if (!dry && (!HASURA || !SECRET)) throw new Error("SVM_HASURA_ENDPOINT + HASURA_GRAPHQL_ADMIN_SECRET required (or --dry)");
  if (!RPC) throw new Error("SOLANA_RPC_URL or HELIUS_API_KEY required (DAS member resolution)");
  const cfg = resolveCollection(collection);
  const das = new DasNftCollectionSource(RPC, cfg.collectionMint);
  const r = await runSqdParallelLoader(
    { collectionKey: collection, fromSlot, concurrency, dry },
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
  if (r.ambiguousGroups > 0) console.warn(`[sqd-parallel] NOTE: ${r.ambiguousGroups} ambiguous groups rejected — §4.5 gate + G1 recall bound the impact; inspect if recall dips`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => { console.error(`[sqd-parallel] FATAL: ${(e as Error).message}`); process.exit(1); });
}
