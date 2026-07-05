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

async function fetchCursorSlot(collectionKey: string): Promise<number | null> {
  if (!HASURA || !SECRET) return null;
  const d = await hasura<{ svm_collection_event: Array<{ slot: number }> }>(
    `query C($k: String!) { svm_collection_event(where: {collection_key: {_eq: $k}, source: {_eq: "sqd-stream"}}, order_by: {slot: desc}, limit: 1) { slot } }`,
    { k: collectionKey },
  );
  return d.svm_collection_event?.[0]?.slot ?? null;
}

async function fetchKnownMints(collectionKey: string): Promise<string[]> {
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

export async function runSqdLoader(
  opts: { collectionKey: string; fromSlot?: number; dry?: boolean },
  deps: SqdLoaderDeps,
): Promise<SqdLoaderResult> {
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

  deps.log(`[sqd-loader] ${cfg.collectionKey}: ${mints.length} members, ${chunks.length} chunk(s), slots ${from.toLocaleString()}→${head.toLocaleString()}${opts.dry ? " [DRY]" : ""}`);
  for (const [ci, chunk] of chunks.entries()) {
    for await (const blocks of deps.client.stream(chunk, from, head, stats, deps.log)) {
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
    deps.log(`[sqd-loader] chunk ${ci + 1}/${chunks.length} done · ${stats.requests} reqs · ${result.eventsUpserted} events`);
    if (stats.stoppedAtCap) break;
  }

  Object.assign(result, stats);
  if (!opts.dry && latestBlockTime > 0) {
    await deps.syncStatus({ collectionKey: cfg.collectionKey, lastEventAt: new Date(latestBlockTime * 1000).toISOString(), lastEventSource: "sqd-stream" });
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
