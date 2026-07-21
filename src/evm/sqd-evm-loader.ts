/**
 * sqd-evm-loader.ts — EVM SQD Portal history → raw.evm_log (Sprint 3 Track B, SDD §2.4).
 *
 * Port of src/svm/sqd-loader.ts to the EVM lane. Orchestration is domain-agnostic and
 * verbatim-ported where possible; the only EVM-specific surface is:
 *   1. EvmSqdClientLike / buildEvmQuery / resolveDataset — owned by T1 (./sqd-evm-client);
 *      injected into deps so T2 declares NO SQD API assumptions of its own.
 *   2. raw.evm_log row shape — four discrete topic columns, validated as hex, never coerced.
 *
 * CLI: tsx src/evm/sqd-evm-loader.ts --chain <id> [--address <hex>] [--topic0 <hex>] \
 *          [--from-block N] [--dry]
 *
 * DISS-001 cursor discipline (sprint-bug-173) preserved verbatim:
 *   - Per-chain durable cursor in evm.sync_status.cursor_block is the resume authority,
 *     not MAX(block_number) of ingested rows.
 *   - completedChunkBlocks[] records a lastBlock snapshot ONLY when a chunk actually yielded;
 *     a chunk that yielded nothing made no progress and must not contribute to the min().
 *   - cappedBeforeAllChunks holds the cursor at the pre-window `from` when the request cap
 *     fires before all chunks produced coverage (DISS-001-residual).
 *   - An EVM-specific exemption: if no chunks yield AND the run was not capped, the block
 *     range had no matching events — cursor advances to window.to (legitimate empty range).
 *     SVM throws here because a non-empty mint list with zero yields implies stream failure;
 *     EVM contracts routinely have event-free block spans.
 *   - 2-attempt cursor write with strict === true check; throws on failure (never silent drop).
 *
 * Memory discipline: [fromBlock, head] is partitioned into bounded EVM_WINDOW_BLOCKS windows
 * (default 100k blocks ≈ ~1.5 days on mainnet). Each window commits before the next loads,
 * bounding RSS analogous to the SVM 153MB precedent.
 *
 * ── T1 boundary ──────────────────────────────────────────────────────────────────────────────
 * EvmSqdClientLike, EvmBlock, EvmSqdStreamStats, and ResolveDataset are STUB INTERFACES here.
 * When T1 (./sqd-evm-client.ts) is merged, replace the "T1 boundary stub" block below with:
 *   import type { EvmSqdClientLike, EvmBlock, EvmSqdStreamStats } from "./sqd-evm-client.js";
 *   import { resolveDataset } from "./sqd-evm-client.js";
 * The deps.resolveDataset injection pattern remains the same — the DI surface is stable.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 */
import { fileURLToPath } from "node:url";

// ── T1 boundary stub ─────────────────────────────────────────────────────────
// Remove this block and replace with imports from "./sqd-evm-client.js" when T1 lands.

/** One raw log row as the EVM SQD Portal JSONL stream returns it (subset T2 reads).
 *  Defined locally as a stub; T1 owns the authoritative shape + [LIVE-GATE] field names. */
export interface EvmBlock {
  header?: { number?: unknown; timestamp?: unknown };
  logs?: EvmRawLogRow[];
}

/** Raw log row from one JSONL block line — all fields unknown (UNTRUSTED network input). */
export interface EvmRawLogRow {
  address?: unknown;
  topics?: unknown;   // T1 [LIVE-GATE]: array or separate fields — T2 accepts either via validation
  data?: unknown;
  transactionHash?: unknown;
  logIndex?: unknown;
}

/** Stream stats accumulated across all requests — analogous to SVM SqdStreamStats. */
export interface EvmSqdStreamStats {
  requests: number;
  blocks: number;
  logRows: number;        // analogous to SVM balanceRows
  stoppedAtCap: boolean;
  lastBlock: number;
}

/** Minimal client interface T2 consumes — implemented by T1's EvmSqdClient. */
export interface EvmSqdClientLike {
  stream(
    addressChunk: readonly string[],
    topics: readonly string[][],
    from: number,
    to: number,
    stats: EvmSqdStreamStats,
    log?: (m: string) => void,
  ): AsyncGenerator<EvmBlock[]>;
  currentHeight(): Promise<number>;
  readonly lastBlockReceivedAt: number;
}

/** Maps a chain ID string to an SQD Portal dataset slug. Owned by T1 — inject via deps. */
export type ResolveDataset = (chainId: string) => string;

// ── end T1 boundary stub ─────────────────────────────────────────────────────

// ── Environment ──────────────────────────────────────────────────────────────
const HASURA = (process.env.EVM_HASURA_ENDPOINT ?? process.env.SVM_HASURA_ENDPOINT ?? "").replace(/\/$/, "");
const SECRET = process.env.HASURA_GRAPHQL_ADMIN_SECRET ?? "";

/** Block-range window size; 100k blocks ≈ 1.5 mainnet days — keeps RSS bounded (153MB precedent). */
const EVM_WINDOW_BLOCKS = Number(process.env.EVM_WINDOW_BLOCKS ?? 100_000) || 100_000;

// ── Row types ─────────────────────────────────────────────────────────────────

/** UNTRUSTED raw log row received from the stream — all fields unknown.
 *  Structured to match the expected SQD Portal EVM response shape (T1 confirms field names
 *  via [LIVE-GATE]; T2 validates them, never assumes them). */
export interface EvmLogRow {
  chain_id?: unknown;
  block_number?: unknown;
  block_time?: unknown;
  tx_hash?: unknown;
  log_index?: unknown;
  address?: unknown;
  topic0?: unknown;
  topic1?: unknown;
  topic2?: unknown;
  topic3?: unknown;
  data?: unknown;
}

/** Typed row after full validation — safe for DB upsert. */
export interface ValidEvmLogRow {
  chain_id: string;
  block_number: number;
  block_time: string;   // ISO-8601 timestamptz
  tx_hash: string;      // 0x-prefixed hex
  log_index: number;
  address: string;      // 0x-prefixed hex, lowercased
  topic0: string | null;
  topic1: string | null;
  topic2: string | null;
  topic3: string | null;
  data: string;         // 0x-prefixed hex
}

// ── Validation helpers ────────────────────────────────────────────────────────

const HEX_RE = /^0x[0-9a-fA-F]*$/;

/** Returns true for 0x-prefixed hex strings of any length (including "0x"). */
function isHex(v: unknown): v is string {
  return typeof v === "string" && HEX_RE.test(v);
}

/** Returns true for 32-byte (66-char) 0x-prefixed hex — topic / tx_hash shape. */
function is32ByteHex(v: unknown): v is string {
  return typeof v === "string" && v.length === 66 && HEX_RE.test(v);
}

/** Returns true for 20-byte (42-char) 0x-prefixed hex — address shape. */
function isAddress(v: unknown): v is string {
  return typeof v === "string" && v.length === 42 && HEX_RE.test(v);
}

/**
 * Validate one UNTRUSTED EVM log row. Returns null (rejected) rather than coercing.
 * Field checks mirror warehouse-loader.validateRow discipline: type checks, format
 * checks, integer checks — never Number() coercion on unknown topology fields.
 */
export function validateEvmLogRow(r: EvmLogRow): ValidEvmLogRow | null {
  if (typeof r.chain_id !== "string" || r.chain_id.length === 0) return null;
  if (!isAddress(r.address)) return null;
  if (!is32ByteHex(r.tx_hash)) return null;
  if (!isHex(r.data)) return null;

  const blockNumber = Number(r.block_number);
  if (!Number.isInteger(blockNumber) || blockNumber < 0) return null;

  const logIndex = Number(r.log_index);
  if (!Number.isInteger(logIndex) || logIndex < 0) return null;

  // block_time: accept unix-seconds integer or ISO string
  let blockTimeIso: string;
  const bt = r.block_time;
  if (typeof bt === "number" && Number.isInteger(bt) && bt > 0) {
    blockTimeIso = new Date(bt * 1000).toISOString();
  } else if (typeof bt === "string" && Number.isFinite(Date.parse(bt))) {
    blockTimeIso = new Date(Date.parse(bt)).toISOString();
  } else {
    return null;
  }

  // Topics: null/undefined = no topic at that index (valid for topic1..3)
  const topicAt = (v: unknown): string | null => {
    if (v === null || v === undefined) return null;
    if (!is32ByteHex(v)) return null; // non-null topic must be a 32-byte hex
    return v;
  };

  const topic0 = topicAt(r.topic0);
  const topic1 = topicAt(r.topic1);
  const topic2 = topicAt(r.topic2);
  const topic3 = topicAt(r.topic3);

  // topic0 absent is valid (anonymous event), but a present topic must be well-formed —
  // validated above via topicAt; a malformed non-null topic returns null from topicAt.
  // Reject the row if any non-null topic failed validation (null-on-malformed → propagated
  // as null here, but we can't distinguish "absent" from "malformed" after topicAt returns null).
  // Guard: if the raw value was non-null but topicAt returned null, reject.
  if (r.topic0 !== null && r.topic0 !== undefined && topic0 === null) return null;
  if (r.topic1 !== null && r.topic1 !== undefined && topic1 === null) return null;
  if (r.topic2 !== null && r.topic2 !== undefined && topic2 === null) return null;
  if (r.topic3 !== null && r.topic3 !== undefined && topic3 === null) return null;

  return {
    chain_id: r.chain_id,
    block_number: blockNumber,
    block_time: blockTimeIso,
    tx_hash: r.tx_hash,
    log_index: logIndex,
    address: r.address.toLowerCase(),
    topic0,
    topic1,
    topic2,
    topic3,
    data: r.data,
  };
}

// ── Block-range windowing ─────────────────────────────────────────────────────

/**
 * Partition [fromBlock, toBlock) into bounded windows of windowSize blocks.
 * Analogous to warehouse-loader.windowsBetween but block-indexed (not date).
 * Empty result when fromBlock >= toBlock.
 */
export function blockRangeBetween(
  fromBlock: number,
  toBlock: number,
  windowSize: number = EVM_WINDOW_BLOCKS,
): Array<{ from: number; to: number }> {
  if (fromBlock >= toBlock) return [];
  const out: Array<{ from: number; to: number }> = [];
  for (let a = fromBlock; a < toBlock; a += windowSize) {
    out.push({ from: a, to: Math.min(a + windowSize, toBlock) });
  }
  return out;
}

// ── EVM sync status (cursor store) ───────────────────────────────────────────

export interface EvmSyncStatusPatch {
  chainId: string;
  cursorBlock?: number;
  lastEventAt?: string; // ISO-8601 timestamptz
}

const UPSERT_SYNC_STATUS = `
mutation UpsertEvmSyncStatus($object: evm_sync_status_insert_input!, $columns: [evm_sync_status_update_column!]!) {
  insert_evm_sync_status_one(object: $object, on_conflict: {constraint: evm_sync_status_pkey, update_columns: $columns}) {
    chain_id
  }
}`;

/**
 * Upsert the EVM freshness row. Fail-soft (returns false, never throws) — caller enforces
 * the CORRECTNESS guard (2-attempt retry + throw on failure for cursor writes).
 */
export async function writeEvmSyncStatus(
  patch: EvmSyncStatusPatch,
  deps?: { fetchImpl?: typeof fetch },
): Promise<boolean> {
  const f = deps?.fetchImpl ?? fetch;
  if (!HASURA || !SECRET) {
    console.warn(`[evm-sync-status] skipped (${patch.chainId}): EVM_HASURA_ENDPOINT/HASURA_GRAPHQL_ADMIN_SECRET unset`);
    return false;
  }
  const object: Record<string, unknown> = { chain_id: patch.chainId, updated_at: new Date().toISOString() };
  const columns: string[] = ["updated_at"];
  if (patch.cursorBlock !== undefined) { object.cursor_block = patch.cursorBlock; columns.push("cursor_block"); }
  if (patch.lastEventAt !== undefined) { object.last_event_at = patch.lastEventAt; columns.push("last_event_at"); }
  try {
    const res = await f(`${HASURA}/v1/graphql`, {
      method: "POST",
      headers: { "x-hasura-admin-secret": SECRET, "Content-Type": "application/json" },
      body: JSON.stringify({ query: UPSERT_SYNC_STATUS, variables: { object, columns } }),
    });
    const d = (await res.json()) as { errors?: unknown };
    if (!res.ok || d.errors) {
      console.warn(`[evm-sync-status] write failed (${patch.chainId}): ${JSON.stringify(d.errors ?? res.status).slice(0, 200)}`);
      return false;
    }
    return true;
  } catch (e) {
    console.warn(`[evm-sync-status] write failed (${patch.chainId}): ${(e as Error).message}`);
    return false;
  }
}

// ── Hasura upsert for raw.evm_log ─────────────────────────────────────────────

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

const UPSERT_EVM_LOG = `
mutation UpsertEvmLog($objects: [raw_evm_log_insert_input!]!) {
  insert_raw_evm_log(
    objects: $objects,
    on_conflict: { constraint: evm_log_pkey, update_columns: [] }
  ) { affected_rows }
}`;

/** Upsert raw.evm_log rows. ifAbsentOnly:true → write-once lake, never overwrites. */
async function upsertEvmLogs(
  rows: ValidEvmLogRow[],
  opts: { ifAbsentOnly: boolean },
): Promise<number> {
  if (rows.length === 0) return 0;
  if (!opts.ifAbsentOnly) throw new Error("upsertEvmLogs: ifAbsentOnly must be true — raw lake is append-only");
  const result = await hasura<{ insert_raw_evm_log: { affected_rows: number } }>(
    UPSERT_EVM_LOG,
    { objects: rows },
  );
  return result.insert_raw_evm_log.affected_rows;
}

// ── Cursor fetch ──────────────────────────────────────────────────────────────

/**
 * Fetch the durable cursor block for a chain from evm.sync_status.
 * DISS-001: this is the coverage-safe resume authority; MAX(block_number) of ingested rows
 * is NOT safe (a capped run can leave gaps that MAX would permanently skip).
 */
async function fetchCursorBlock(chainId: string): Promise<number | null> {
  if (!HASURA || !SECRET) return null;
  const d = await hasura<{ evm_sync_status: Array<{ cursor_block: number | null }> }>(
    `query CursorBlock($c: String!) { evm_sync_status(where: {chain_id: {_eq: $c}}) { cursor_block } }`,
    { c: chainId },
  ).catch(() => null);
  return d?.evm_sync_status?.[0]?.cursor_block ?? null;
}

// ── DI types ──────────────────────────────────────────────────────────────────

export interface EvmSqdLoaderDeps {
  /** EVM SQD stream client — configured for a specific chain/dataset (T1's EvmSqdClient). */
  client: EvmSqdClientLike;
  /**
   * Maps chainId → SQD Portal dataset slug. Owned by T1 (resolveDataset from sqd-evm-client).
   * Injected here so T2 holds zero SQD API assumptions and T1 is the single seam owner.
   */
  resolveDataset: ResolveDataset;
  /** Returns the durable cursor block for the chain, or null (start from 0). */
  cursorBlock: () => Promise<number | null>;
  /** Write-once upsert to raw.evm_log — must be called with ifAbsentOnly:true. */
  upsert: typeof upsertEvmLogs;
  /** Persist the EVM sync status cursor (fail-soft boolean return). */
  syncStatus: typeof writeEvmSyncStatus;
  log: (m: string) => void;
}

export interface EvmSqdLoaderResult extends EvmSqdStreamStats {
  logsUpserted: number;
  rejectedRows: number;
  windows: number;
  addressChunks: number;
}

// ── Address chunking constant ─────────────────────────────────────────────────
// EVM addresses are 42-char hex strings. Chunk size is conservative; T1 may tune once
// portal payload ceiling is measured for EVM (the SVM ceiling was 1500 mints × 187KB).
// This default is 500 — adjust via EVM_ADDRESS_CHUNK env if portal ceiling differs.
export const ADDRESS_CHUNK = Number(process.env.EVM_ADDRESS_CHUNK ?? 500) || 500;

// ── Core orchestration ────────────────────────────────────────────────────────

/**
 * runEvmSqdLoader — port of runSqdLoader with DISS-001 cursor discipline preserved verbatim.
 *
 * Structure: resolveDataset → currentHeight → blockRangeBetween → per-window chunk loop →
 *   validate raw log rows → ifAbsentOnly upsert → 2-attempt cursor write.
 *
 * EVM divergence from SVM:
 *   - Outer block-range window loop (memory discipline — SVM 153MB precedent).
 *   - Empty-window exemption: no chunks yielding in a window is legitimate (no events
 *     in that block range); cursor advances to window.to rather than throwing INVARIANT.
 *   - No seenMints/first-appearance decode (EVM events carry full context in each log).
 *   - chunks = address slices (analogous to SVM mint slices).
 */
export async function runEvmSqdLoader(
  opts: {
    chainId: string;
    addresses: readonly string[];
    topics: readonly string[][];
    fromBlock?: number;
    dry?: boolean;
  },
  deps: EvmSqdLoaderDeps,
): Promise<EvmSqdLoaderResult> {
  const { chainId, addresses, topics, dry } = opts;

  // resolveDataset is called for logging/validation only — the client is pre-configured.
  const dataset = deps.resolveDataset(chainId);

  const head = await deps.client.currentHeight();
  const from = opts.fromBlock ?? (await deps.cursorBlock().catch(() => null)) ?? 0;

  // Chunk the address list — analogous to SVM mint chunking.
  const chunks: string[][] = [];
  for (let i = 0; i < addresses.length; i += ADDRESS_CHUNK) {
    chunks.push(addresses.slice(i, i + ADDRESS_CHUNK) as string[]);
  }
  // Guard: at least one chunk required (even "watch all" = one empty-address chunk).
  // An empty address filter is valid for EVM (stream all logs matching topic0 only).
  if (chunks.length === 0) chunks.push([]);

  const windows = blockRangeBetween(from, head);

  const stats: EvmSqdStreamStats = { requests: 0, blocks: 0, logRows: 0, stoppedAtCap: false, lastBlock: from };
  const result: EvmSqdLoaderResult = {
    ...stats,
    logsUpserted: 0,
    rejectedRows: 0,
    windows: windows.length,
    addressChunks: chunks.length,
  };

  deps.log(
    `[evm-loader] chain=${chainId} dataset=${dataset}: ${addresses.length} addresses, ` +
    `${chunks.length} chunk(s), ${windows.length} window(s), blocks ${from.toLocaleString()}→${head.toLocaleString()}` +
    `${dry ? " [DRY]" : ""}`,
  );

  if (windows.length === 0) {
    deps.log(`[evm-loader] chain=${chainId}: no blocks to ingest (from=${from} >= head=${head})`);
    return result;
  }

  let latestBlockTime: string | null = null;

  for (const [wi, window] of windows.entries()) {
    // DISS-001: per-window completedChunkBlocks — records lastBlock snapshot when chunk yielded.
    const completedChunkBlocks: number[] = [];
    let chunksRun = 0;
    let capChunkYielded = true;
    const windowFrom = window.from;

    deps.log(`[evm-loader] window ${wi + 1}/${windows.length}: blocks ${window.from.toLocaleString()}..${window.to.toLocaleString()}`);

    for (const [ci, chunk] of chunks.entries()) {
      let chunkYielded = false;
      for await (const blocks of deps.client.stream(chunk, topics, window.from, window.to, stats, deps.log)) {
        chunkYielded = true;
        for (const block of blocks) {
          const blockNum = Number(block.header?.number);
          const blockTs = block.header?.timestamp;
          const rawLogs = block.logs ?? [];
          for (const rawLog of rawLogs) {
            stats.logRows++;
            // Map raw SQD log row → EvmLogRow, injecting block-level fields
            const candidate: EvmLogRow = {
              chain_id: chainId,
              block_number: blockNum,
              block_time: blockTs,
              tx_hash: rawLog.transactionHash,
              log_index: rawLog.logIndex,
              address: rawLog.address,
              // topics: SQD Portal EVM returns topics as an array; T1 [LIVE-GATE] confirms
              // the exact field name + array shape. We read positionally from rawLog.topics
              // if it is an array, else fall back to rawLog.topic0..3 discrete fields.
              // Both shapes are handled so T2 survives either T1 resolution.
              ...(Array.isArray(rawLog.topics)
                ? {
                    topic0: (rawLog.topics as unknown[])[0] ?? null,
                    topic1: (rawLog.topics as unknown[])[1] ?? null,
                    topic2: (rawLog.topics as unknown[])[2] ?? null,
                    topic3: (rawLog.topics as unknown[])[3] ?? null,
                  }
                : {
                    topic0: (rawLog as Record<string, unknown>)["topic0"] ?? null,
                    topic1: (rawLog as Record<string, unknown>)["topic1"] ?? null,
                    topic2: (rawLog as Record<string, unknown>)["topic2"] ?? null,
                    topic3: (rawLog as Record<string, unknown>)["topic3"] ?? null,
                  }),
              data: rawLog.data,
            };
            const valid = validateEvmLogRow(candidate);
            if (!valid) {
              result.rejectedRows++;
              continue;
            }
            if (!dry) {
              // Batch-collect within block; flush per-block to bound in-flight memory.
              // (Single-row flush is intentional for now; batch aggregation is a T4+ perf opt.)
              await deps.upsert([valid], { ifAbsentOnly: true });
              result.logsUpserted++;
            }
            // Track latest event timestamp for freshness update
            if (!latestBlockTime || valid.block_time > latestBlockTime) {
              latestBlockTime = valid.block_time;
            }
          }
        }
      }

      // DISS-001: only snapshot lastBlock when the chunk actually yielded blocks.
      if (chunkYielded) completedChunkBlocks.push(stats.lastBlock);
      chunksRun = ci + 1;
      deps.log(`[evm-loader] chunk ${ci + 1}/${chunks.length} done · ${stats.requests} reqs · ${result.logsUpserted} logs`);

      if (stats.stoppedAtCap) {
        // DISS-002: cap chunk only counts as covered if it yielded.
        capChunkYielded = chunkYielded;
        break;
      }
    }

    // DISS-001-residual: if cap fired before all chunks covered, hold cursor at windowFrom.
    const cappedBeforeAllChunks = stats.stoppedAtCap && (chunksRun < chunks.length || !capChunkYielded);

    // Derive safeBlock for this window.
    let windowSafeBlock: number;
    if (cappedBeforeAllChunks) {
      deps.log(
        `[evm-loader] CAP fired after ${chunksRun}/${chunks.length} chunks in window ${wi + 1} — ` +
        `holding cursor at ${windowFrom.toLocaleString()} (no advance; DISS-001-residual)`,
      );
      windowSafeBlock = windowFrom;
    } else if (completedChunkBlocks.length === 0) {
      // EVM-specific: legitimate empty block range — no events for this filter.
      // Advance cursor to window.to so future runs skip this scanned range.
      deps.log(`[evm-loader] window ${wi + 1}: no events found — advancing cursor to ${window.to.toLocaleString()}`);
      windowSafeBlock = window.to;
    } else {
      // safeBlock = min across completed chunks (DISS-001 fix).
      windowSafeBlock = Math.min(...completedChunkBlocks);
    }

    result.lastBlock = windowSafeBlock;
    Object.assign(result, { requests: stats.requests, blocks: stats.blocks, logRows: stats.logRows, stoppedAtCap: stats.stoppedAtCap });

    // Persist cursor after each window (DISS-001 root fix — durable cursor is the resume authority).
    if (!dry) {
      const patch: EvmSyncStatusPatch = { chainId, cursorBlock: windowSafeBlock };
      if (latestBlockTime) patch.lastEventAt = latestBlockTime;

      // 2-attempt strict === true cursor write (DISS-003 verbatim from SVM).
      // Anything other than === true (void, undefined, future drift) counts as FAILURE.
      let cursorWritten = (await deps.syncStatus(patch)) === true;
      if (!cursorWritten) cursorWritten = (await deps.syncStatus(patch)) === true;
      if (!cursorWritten) {
        const msg =
          `[evm-loader] CURSOR WRITE FAILED for chain=${chainId} at block ${windowSafeBlock} (2 attempts) — ` +
          `refusing to report success: resume would skip unscanned ranges`;
        deps.log(msg);
        throw new Error(msg);
      }
    }

    if (stats.stoppedAtCap) {
      deps.log(`[evm-loader] request cap reached — stopping after window ${wi + 1}/${windows.length}`);
      break;
    }
  }

  deps.log(
    `[evm-loader] DONE chain=${chainId}: ${result.logsUpserted} logs upserted · ` +
    `${result.rejectedRows} rejected · ${stats.requests} requests · lastBlock=${result.lastBlock}` +
    `${stats.stoppedAtCap ? " (CAP)" : ""}`,
  );
  return result;
}

// ── CLI ───────────────────────────────────────────────────────────────────────

function parseArgs(): {
  chainId: string;
  addresses: string[];
  topics: string[][];
  fromBlock?: number;
  dry: boolean;
} {
  const a = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = a.indexOf(flag);
    return i >= 0 ? a[i + 1] : undefined;
  };
  const getAll = (flag: string): string[] => {
    const vals: string[] = [];
    for (let i = 0; i < a.length - 1; i++) {
      if (a[i] === flag) vals.push(a[i + 1]!);
    }
    return vals;
  };

  const chainId = get("--chain") ?? "";
  if (!chainId) throw new Error("--chain <id> required (e.g. --chain 1 for Ethereum mainnet)");

  const addresses = getAll("--address");
  const topic0 = get("--topic0");
  const topics: string[][] = topic0 ? [[topic0]] : [];

  const fb = get("--from-block");
  const dry = a.includes("--dry");

  return {
    chainId,
    addresses,
    topics,
    fromBlock: fb !== undefined ? Number(fb) : undefined,
    dry,
  };
}

async function main(): Promise<void> {
  const { chainId, addresses, topics, fromBlock, dry } = parseArgs();

  if (!dry && (!HASURA || !SECRET)) {
    throw new Error(
      "EVM_HASURA_ENDPOINT (or SVM_HASURA_ENDPOINT) + HASURA_GRAPHQL_ADMIN_SECRET required (or --dry)",
    );
  }

  // T1 wiring: import resolveDataset and EvmSqdClient from ./sqd-evm-client when T1 is merged.
  // Placeholder below throws at runtime; replace with the real import once T1 lands.
  // TODO(T1): import { resolveDataset, EvmSqdClient } from "./sqd-evm-client.js";
  const resolveDataset: ResolveDataset = (_chainId: string): string => {
    throw new Error(
      "[evm-loader] resolveDataset not wired: T1 (sqd-evm-client.ts) must be merged first. " +
      "Replace this stub in main() with: import { resolveDataset, EvmSqdClient } from './sqd-evm-client.js'",
    );
  };
  const makeClient = (_dataset: string): EvmSqdClientLike => {
    throw new Error("[evm-loader] EvmSqdClient not wired: T1 must be merged first.");
  };

  const dataset = resolveDataset(chainId);
  const client = makeClient(dataset);

  const r = await runEvmSqdLoader(
    { chainId, addresses, topics, fromBlock, dry },
    {
      client,
      resolveDataset,
      cursorBlock: () => fetchCursorBlock(chainId),
      upsert: upsertEvmLogs,
      syncStatus: writeEvmSyncStatus,
      log: console.log,
    },
  );

  if (r.rejectedRows > 0) {
    console.warn(`[evm-loader] WARNING: ${r.rejectedRows} malformed rows rejected — inspect before trusting completeness`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error(`[evm-loader] FATAL: ${(e as Error).message}`);
    process.exit(1);
  });
}
