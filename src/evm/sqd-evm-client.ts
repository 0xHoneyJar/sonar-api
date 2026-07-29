/**
 * sqd-evm-client.ts — SQD Portal stream consumer for EVM chains (Sprint 3 / FR-A1).
 *
 * Skeleton ported verbatim from src/svm/sqd-client.ts:
 *  - SqdAuthRequiredError (401/403 immediate throw, NOT retry-caught) — unchanged
 *  - Exp-backoff retry on 429/5xx, capped at RETRY_CAP_MS=30_000, MAX_RETRIES=5
 *  - Request cap via SQD_MAX_REQUESTS with clean between-request stop (stats.stoppedAtCap)
 *  - PAYLOAD_SOFT_CEILING split-recurse guard (never silently drops addresses)
 *  - Progress guard: if (last <= frm) return
 *
 * SEAM BOUNDARY — ALL unverified SQD Portal EVM API surface is confined to three
 * pure exported functions at the bottom of this file, each tagged [LIVE-GATE]:
 *   buildEvmQuery()   — EVM query body JSON shape (type, fields, logs filter)
 *   resolveDataset()  — per-chain dataset slug mapping
 *   parseEvmBlock()   — JSONL response line → EvmBlockRaw (shape assumptions isolated here)
 *
 * Acceptance invariant: grep -n "LIVE-GATE" should produce hits ONLY inside these three
 * functions and their JSDoc. The retry/cap/ceiling/cursor skeleton in stream() carries no
 * [LIVE-GATE] tags — it is domain-agnostic and does not contain API-shape assumptions.
 *
 * A GATE-1 probe (T4, src/evm/sqd-evm-gate1-probe.ts) validates every [LIVE-GATE]
 * assumption against the live Portal before this module propagates into the loader (T2).
 *
 * Native fetch only (Node >=22). No node-fetch dependency.
 */

const PORTAL_BASE = (process.env.SQD_PORTAL_BASE ?? "https://portal.sqd.dev").replace(/\/$/, "");

// ADDRESS_CHUNK: SVM used 1500 (measured ~345KB ceiling with 2000 mints × pre+post).
// EVM log filters are smaller per address (one filter entry), so the ceiling may be
// higher — but the PAYLOAD_SOFT_CEILING split-recurse guard is the runtime safety net.
// This constant is the soft suggestion; the ceiling guard does the actual enforcement.
// Raise after a T4 payload-profile probe confirms a safe higher value.
export const ADDRESS_CHUNK = 500;

// Ported verbatim from src/svm/sqd-client.ts (measured 90% of 345KB rejection threshold).
export const PAYLOAD_SOFT_CEILING = 330_000;

const MAX_RETRIES = 5;
const RETRY_CAP_MS = 30_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// SqdAuthRequiredError — carried over UNCHANGED from src/svm/sqd-client.ts
// ---------------------------------------------------------------------------

/**
 * Thrown immediately on 401/403 at any bootstrap or poll call. NOT caught by the retry loop.
 * Contains the block height + timestamp for operator re-quote context.
 */
export class SqdAuthRequiredError extends Error {
  readonly blockHeight: number;
  readonly timestamp: string; // ISO-8601
  readonly status: number; // 401 or 403
  readonly url: string;
  constructor(opts: { blockHeight: number; timestamp: string; status: number; url: string }) {
    super(`SQD auth required: HTTP ${opts.status} at ${opts.url} (block ${opts.blockHeight})`);
    this.name = "SqdAuthRequiredError";
    this.blockHeight = opts.blockHeight;
    this.timestamp = opts.timestamp;
    this.status = opts.status;
    this.url = opts.url;
  }
}

// ---------------------------------------------------------------------------
// Stats + raw block shape interfaces
// ---------------------------------------------------------------------------

/** Accumulates stats across stream() calls; passed by reference so the cap check is shared. */
export interface SqdStreamStats {
  requests: number;
  blocks: number;
  /** Renamed from balanceRows (SVM) — counts raw EVM log rows received per stream run. */
  logRows: number;
  stoppedAtCap: boolean;
  /** Renamed from lastSlot (SVM) — last EVM block number seen across all yielded batches. */
  lastBlock: number;
}

/**
 * Raw EVM log as returned by a SQD Portal JSONL block line.
 * All fields typed unknown — assumptions are documented in parseEvmBlock() below.
 */
export interface EvmLogRaw {
  address?: unknown;
  topics?: unknown;
  data?: unknown;
  transactionHash?: unknown;
  logIndex?: unknown;
}

/**
 * Raw EVM block as returned by a single JSONL line from the Portal stream.
 * All fields typed unknown — field-name assumptions live in parseEvmBlock().
 */
export interface EvmBlockRaw {
  header?: {
    number?: unknown;
    timestamp?: unknown;
  };
  logs?: EvmLogRaw[];
}

// ---------------------------------------------------------------------------
// SqdEvmClient — retry/cap/ceiling/cursor skeleton (no [LIVE-GATE] tags here)
// ---------------------------------------------------------------------------

export class SqdEvmClient {
  /** Unix ms timestamp of the last block received from the stream. */
  lastBlockReceivedAt: number = 0;

  private readonly dataset: string;

  constructor(
    chainId: string,
    private readonly apiKey: string | undefined = process.env.SQD_API_KEY,
    private readonly maxRequests: number = Number(process.env.SQD_MAX_REQUESTS ?? 20_000) || 20_000,
  ) {
    const r = resolveDataset(chainId);
    this.dataset = r.dataset;
    if (!r.certain) {
      console.warn(
        `[sqd-evm] WARNING: dataset slug "${r.dataset}" for chain "${chainId}" is a candidate slug — ` +
          `run T4 GATE-1 probe to confirm before production use`,
      );
    }
  }

  /**
   * Finalized head block number (SQD Portal's reported height for this chain's dataset).
   * Throws SqdAuthRequiredError on 401/403 — not caught by any retry loop.
   */
  async currentHeight(): Promise<number> {
    const url = `${PORTAL_BASE}/datasets/${this.dataset}/finalized-stream/height`;
    const res = await fetch(url, { headers: this.headers() });
    if (res.status === 401 || res.status === 403) {
      throw new SqdAuthRequiredError({ blockHeight: 0, timestamp: new Date().toISOString(), status: res.status, url });
    }
    if (!res.ok) throw new Error(`sqd-evm head: HTTP ${res.status}`);
    return Number((await res.text()).trim());
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey) h["Authorization"] = `Bearer ${this.apiKey}`;
    return h;
  }

  /**
   * Stream all blocks for one address chunk over [fromBlock, toBlock), yielding parsed
   * block batches per request. Caller composes chunks and owns decode state.
   * Stats accumulate across calls when the same object is passed in (whole-run request cap).
   *
   * Ceiling guard: if query payload exceeds PAYLOAD_SOFT_CEILING bytes, the chunk is split
   * in half recursively. Never silently drops addresses.
   *
   * Auth guard: 401/403 throws SqdAuthRequiredError immediately — NOT caught by retry loop.
   *
   * Skeleton ported verbatim from src/svm/sqd-client.ts lines 120-202.
   * JSONL parsing is routed through parseEvmBlock() to contain shape assumptions there.
   */
  async *stream(
    addressChunk: readonly string[],
    topics: readonly string[][],
    fromBlock: number,
    toBlock: number,
    stats: SqdStreamStats,
    log: (m: string) => void = () => {},
  ): AsyncGenerator<EvmBlockRaw[]> {
    // An empty addressChunk is VALID for EVM = topic-only mode (match all addresses). The SVM
    // verbatim early-return here silently ingested nothing, letting the caller false-advance the
    // cursor over an unscanned range (verify:s3 MEDIUM, data-loss) — removed. buildEvmQuery omits
    // the address filter when the chunk is empty so the stream actually runs.
    if (addressChunk.length > ADDRESS_CHUNK) {
      throw new Error(`address chunk ${addressChunk.length} exceeds ceiling ${ADDRESS_CHUNK}`);
    }
    const streamUrl = `${PORTAL_BASE}/datasets/${this.dataset}/finalized-stream`;

    let frm = fromBlock;
    while (frm < toBlock) {
      // Request cap check — clean stop, not an error; cursor holds at pre-run position
      if (stats.requests >= this.maxRequests) {
        stats.stoppedAtCap = true;
        log(
          `[sqd-evm] STOP: request cap ${this.maxRequests} reached at block ${frm} — re-run resumes from cursor`,
        );
        return;
      }

      const body = buildEvmQuery(addressChunk, topics, frm);

      // Ceiling guard: split-recurse rather than truncate — never silently drops addresses
      const payloadBytes = Buffer.byteLength(body, "utf8");
      if (payloadBytes > PAYLOAD_SOFT_CEILING) {
        log(`[sqd-evm WARN] filter payload ${Math.round(payloadBytes / 1024)}KiB exceeds soft ceiling — rechunking`);
        if (addressChunk.length <= 1) {
          throw new Error(
            `[sqd-evm] filter payload ${Math.round(payloadBytes / 1024)}KiB cannot be reduced below ceiling for single-address chunk — abort`,
          );
        }
        const half = Math.ceil(addressChunk.length / 2);
        for (const sub of [addressChunk.slice(0, half), addressChunk.slice(half)] as const) {
          if (sub.length > 0) yield* this.stream(sub, topics, frm, toBlock, stats, log);
        }
        return; // sub-streams own continuation
      }

      // Retry loop — exp backoff on 429/5xx; auth error escapes immediately
      let res: Response | null = null;
      for (let attempt = 0; ; attempt++) {
        res = await fetch(streamUrl, { method: "POST", headers: this.headers(), body });
        // Auth guard: 401/403 thrown immediately, NOT caught by retry loop
        if (res.status === 401 || res.status === 403) {
          throw new SqdAuthRequiredError({
            blockHeight: frm,
            timestamp: new Date().toISOString(),
            status: res.status,
            url: streamUrl,
          });
        }
        if (res.status === 429 || res.status >= 500) {
          if (attempt >= MAX_RETRIES) {
            throw new Error(`sqd-evm stream: HTTP ${res.status} after ${attempt} retries at block ${frm}`);
          }
          const retryAfter = Number(res.headers.get("retry-after")) || 0;
          await sleep(Math.min(retryAfter * 1000 || 2 ** attempt * 1000, RETRY_CAP_MS));
          continue;
        }
        break;
      }
      if (!res!.ok) {
        const text = await res!.text().catch(() => "");
        throw new Error(`sqd-evm stream: HTTP ${res!.status} ${text.slice(0, 160)}`);
      }

      // JSONL parse — one block object per line; shape assumptions live in parseEvmBlock()
      stats.requests++;
      const blocks: EvmBlockRaw[] = [];
      let last = frm;
      for (const line of (await res!.text()).split("\n")) {
        if (!line.trim()) continue;
        try {
          const b = parseEvmBlock(line);
          if (b === null) continue;
          const n = Number(b.header?.number);
          if (Number.isInteger(n)) last = Math.max(last, n);
          blocks.push(b);
          stats.logRows += b.logs?.length ?? 0;
        } catch {
          /* torn line at stream end — server terminates cleanly; ignore non-JSON remnants */
        }
      }
      stats.blocks += blocks.length;
      stats.lastBlock = last;
      if (blocks.length > 0) {
        this.lastBlockReceivedAt = Date.now();
        yield blocks;
      }
      // Progress guard (ported from src/svm/sqd-client.ts:199): no progress = range exhausted
      if (last <= frm) return;
      frm = last + 1;
    }
  }
}

// ---------------------------------------------------------------------------
// SEAM FUNCTIONS
// ALL [LIVE-GATE] tags in this file are confined to these three functions.
// Do NOT add [LIVE-GATE] annotations outside this block.
// ---------------------------------------------------------------------------

/**
 * Builds the SQD Portal EVM finalized-stream POST body for a set of contract addresses
 * and topic0 event signatures, starting at fromBlock.
 *
 * Pure function — no network calls, safe to unit-test without a live Portal.
 *
 * [LIVE-GATE] Every field name, nesting structure, and value in this function body is a
 * CANDIDATE based on SQD Portal EVM API conventions — NOT confirmed offline. The T4 GATE-1
 * probe must verify each assumption against a live endpoint before this query propagates
 * into the loader (T2). Specifically:
 *
 *   type: "evm"
 *     [LIVE-GATE] SQD Portal EVM type discriminant — confirm vs "ethereum" or other string
 *
 *   fields.log.address
 *     [LIVE-GATE] field projection key — confirm "address" is valid (vs "contractAddress")
 *
 *   fields.log.topics
 *     [LIVE-GATE] field projection key — confirm "topics" returns array (vs "topic0"/"topic1")
 *
 *   fields.log.data
 *     [LIVE-GATE] field projection key — confirm "data" is present in EVM Portal schema
 *
 *   fields.log.transactionHash
 *     [LIVE-GATE] field projection key — confirm "transactionHash" (vs "txHash" / "tx_hash")
 *
 *   fields.log.logIndex
 *     [LIVE-GATE] field projection key — confirm "logIndex" (vs "index" / "log_index")
 *
 *   fields.block.number
 *     [LIVE-GATE] block header projection key — confirm "number" (vs "blockNumber")
 *
 *   fields.block.timestamp
 *     [LIVE-GATE] block header projection key — confirm unix seconds unit (not ms)
 *
 *   logs[].address (filter)
 *     [LIVE-GATE] filter key for contract address array — confirm "address" (vs "addresses")
 *
 *   logs[].topics [[topic0,...]] (filter)
 *     [LIVE-GATE] filter shape — confirm outer-array=AND-conditions, inner-array=OR-per-position
 *     (i.e. [[topic0a, topic0b]] means topic0 must match either; verify the double-nesting)
 */
export function buildEvmQuery(
  addresses: readonly string[],
  topics: readonly string[][],
  fromBlock: number,
): string {
  return JSON.stringify({
    type: "evm", // [LIVE-GATE] discriminant string — confirm exact value
    fromBlock,
    fields: {
      log: {
        address: true,          // [LIVE-GATE] confirm field projection key spelling
        topics: true,           // [LIVE-GATE] confirm field projection key + return shape (array vs flat)
        data: true,             // [LIVE-GATE] confirm field projection key present in EVM schema
        transactionHash: true,  // [LIVE-GATE] confirm exact camelCase key ("transactionHash")
        logIndex: true,         // [LIVE-GATE] confirm exact camelCase key ("logIndex")
      },
      block: {
        number: true,           // [LIVE-GATE] confirm block header field key ("number")
        timestamp: true,        // [LIVE-GATE] confirm field key + unit (unix seconds, not ms)
      },
    },
    logs: [
      {
        // Omit `address` entirely when empty → topic-only "match all addresses" (verify:s3 MEDIUM fix);
        // never emit an empty address list (which some backends treat as "match none").
        ...(addresses.length > 0 ? { address: addresses } : {}), // [LIVE-GATE] confirm filter key ("address" not "addresses")
        // `topics` is ALREADY per-position OR-arrays from the caller (topics[0]=topic0 OR-values, …).
        // Pass it through — do NOT re-wrap (the old `[topics]` triple-nested loader input). [LIVE-GATE]
        // confirm SQD Portal EVM topic-filter shape (topics: string[][] vs discrete topic0/topic1 keys).
        ...(topics.length > 0 ? { topics } : {}),
      },
    ],
  });
}

/**
 * Maps a chain identifier to the SQD Portal EVM dataset slug.
 * `certain: false` means the slug is a best-effort candidate; the T4 GATE-1 probe must
 * confirm availability via GET /datasets/<slug>/finalized-stream/height before use.
 *
 * Accepts both chain name strings ("ethereum", "base") and numeric chain IDs ("1", "8453").
 *
 * Pure function — no network calls, safe to unit-test without a live Portal.
 *
 * [LIVE-GATE] ALL dataset slugs are CANDIDATES derived from SQD Portal naming conventions.
 * None are confirmed offline. Every case below requires a GATE-1 height probe.
 * Zora and Berachain are additionally flagged UNCERTAIN per SDD R-8 — if the probe
 * returns 404, route to Goldsky/Covalent fallback as specified in the SDD.
 */
export function resolveDataset(chainId: string): { dataset: string; certain: boolean } {
  switch (chainId) {
    case "ethereum":
    case "1":
      // [LIVE-GATE] slug "ethereum-mainnet" — candidate; confirm via GET /datasets/ethereum-mainnet/finalized-stream/height
      return { dataset: "ethereum-mainnet", certain: false };

    case "base":
    case "8453":
      // [LIVE-GATE] slug "base-mainnet" — candidate; confirm via GATE-1 probe
      return { dataset: "base-mainnet", certain: false };

    case "arbitrum":
    case "arbitrum-one":
    case "42161":
      // [LIVE-GATE] slug "arbitrum-one" — candidate; confirm via GATE-1 probe
      return { dataset: "arbitrum-one", certain: false };

    case "optimism":
    case "10":
      // [LIVE-GATE] slug "optimism-mainnet" — candidate; confirm via GATE-1 probe
      return { dataset: "optimism-mainnet", certain: false };

    case "zora":
    case "7777777":
      // [LIVE-GATE] slug "zora-mainnet" — UNCERTAIN (SDD R-8: SQD EVM Zora coverage unconfirmed)
      // If GATE-1 probe returns 404, fall back to Goldsky/Covalent per SDD R-8 characterization plan
      return { dataset: "zora-mainnet", certain: false };

    case "berachain":
    case "80094":
      // [LIVE-GATE] slug "berachain-mainnet" — UNCERTAIN (SDD R-8: SQD EVM Berachain coverage unconfirmed)
      // If GATE-1 probe returns 404, fall back to Goldsky/Covalent per SDD R-8 characterization plan
      return { dataset: "berachain-mainnet", certain: false };

    default:
      throw new Error(
        `resolveDataset: unknown chainId "${chainId}" — add slug mapping + GATE-1 probe before use`,
      );
  }
}

/**
 * Parses one JSONL line from a SQD Portal EVM finalized-stream response into a typed
 * EvmBlockRaw object. Returns null on JSON parse failure (torn line at stream end is normal).
 *
 * This function is the sole JSONL-response seam: all assumptions about the Portal's EVM
 * response shape are documented here so they cannot leak into the loader (T2) or the
 * retry/cap/cursor skeleton in stream().
 *
 * [LIVE-GATE] The GATE-1 probe must confirm the following before this parser is trusted:
 *
 *   header.number
 *     [LIVE-GATE] top-level key is "header", sub-key is "number" — confirm both exist
 *
 *   header.timestamp
 *     [LIVE-GATE] "header.timestamp" is unix seconds (number, not ms, not ISO string)
 *
 *   logs (array)
 *     [LIVE-GATE] top-level key is "logs" (not "events" / "logEntries") and is an array
 *
 *   logs[].address
 *     [LIVE-GATE] each log element has key "address" (lowercase hex string)
 *
 *   logs[].topics
 *     [LIVE-GATE] each log element has key "topics" as an array of hex strings
 *     (e.g. ["0xddf252...", "0x000...sender", "0x000...receiver"])
 *
 *   logs[].data
 *     [LIVE-GATE] each log element has key "data" as a hex string
 *
 *   logs[].transactionHash
 *     [LIVE-GATE] each log element has key "transactionHash" (full 0x-prefixed hex)
 *
 *   logs[].logIndex
 *     [LIVE-GATE] each log element has key "logIndex" as a number (not string)
 */
export function parseEvmBlock(line: string): EvmBlockRaw | null {
  // [LIVE-GATE] The cast below assumes the JSONL line conforms to EvmBlockRaw — shape
  // confirmed only once a GATE-1 probe validates the Portal's actual response format.
  try {
    return JSON.parse(line) as EvmBlockRaw;
  } catch {
    return null; // torn line at stream boundary — expected; caller skips null
  }
}
