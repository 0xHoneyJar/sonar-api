/**
 * sqd-client.ts — SQD Portal stream consumer (cycle svm-sqd-substrate, SDD §2.1).
 *
 * Portal semantics [MEASURED 2026-07-05, T-1 spike]:
 *  - POST /datasets/solana-mainnet/finalized-stream returns application/jsonl: one JSON block
 *    object per line; a request covers a BOUNDED slot range chosen by the server — the client
 *    drives continuation by re-requesting from lastBlock+1 until the finalized head
 *    (x-sqd-finalized-head-number header).
 *  - Filter body ceiling: "Query is too large" ≈ 345KB; 187KB (2,000 mints × pre+post) passes →
 *    MINT_CHUNK = 1,500 with margin.
 *  - Access is open/unauthenticated today; SQD_API_KEY env is honored if set (grant-not-right:
 *    PRD NFR). Politeness: sequential requests only, request counting surfaced to the caller,
 *    SQD_MAX_REQUESTS hard cap with clean between-request stop (DUNE_CREDIT_BUDGET precedent).
 */
import type { SqdBlock } from "./sqd-collection-event-source";

const PORTAL_BASE = (process.env.SQD_PORTAL_BASE ?? "https://portal.sqd.dev").replace(/\/$/, "");
const DATASET = "solana-mainnet";
export const MINT_CHUNK = 1_500; // measured ceiling ~2,000 (187KB ok, 345KB rejected) — margin below
export const PAYLOAD_SOFT_CEILING = 330_000; // 90% of 345KB — headroom for future field growth
const MAX_RETRIES = 5;
const RETRY_CAP_MS = 30_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Thrown immediately on 401/403 at any bootstrap or poll call. NOT caught by the retry loop.
 * Contains the block height + timestamp for operator re-quote context (PRD §7 FR-6).
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

export interface SqdStreamStats {
  requests: number;
  blocks: number;
  balanceRows: number;
  stoppedAtCap: boolean;
  lastSlot: number;
}

export function buildQuery(mintChunk: readonly string[], fromBlock: number): string {
  return JSON.stringify({
    type: "solana",
    fromBlock,
    fields: {
      tokenBalance: { account: true, preMint: true, postMint: true, preOwner: true, postOwner: true, preAmount: true, postAmount: true, transactionIndex: true },
      block: { number: true, timestamp: true },
      transaction: { signatures: true, transactionIndex: true },
    },
    // `transaction: true` is the RELATION JOIN flag — it pulls the parent transaction
    // (shaped by fields.transaction) for every matched balance row. The old shape
    // (`transactions: []`, an EMPTY selector = select nothing) returned blocks with NO
    // transactions, so the sig join failed and EVERY group decoded as ambiguous — the
    // live-Portal zero-decode found by the first real §4.5 run (sprint-bug-190; test
    // fixtures always included transactions, so the suite never caught it).
    tokenBalances: [
      { postMint: mintChunk, transaction: true },
      { preMint: mintChunk, transaction: true },
    ],
  });
}

export class SqdClient {
  /** Unix ms timestamp of the last block received from the stream. Read by SqdLivenessMonitor. */
  lastBlockReceivedAt: number = 0;

  constructor(
    private readonly apiKey: string | undefined = process.env.SQD_API_KEY,
    private readonly maxRequests: number = Number(process.env.SQD_MAX_REQUESTS ?? 20_000) || 20_000,
  ) {}

  /**
   * Finalized head slot (SQD Portal's reported height).
   * returns SQD's internal height — not a reference chain tip; use an independent RPC for lag
   * comparison (see SqdLivenessMonitor). Comparing this to itself cannot detect SQD lagging.
   */
  async currentHeight(): Promise<number> {
    const url = `${PORTAL_BASE}/datasets/${DATASET}/finalized-stream/height`;
    const res = await fetch(url, { headers: this.headers() });
    if (res.status === 401 || res.status === 403) {
      throw new SqdAuthRequiredError({ blockHeight: 0, timestamp: new Date().toISOString(), status: res.status, url });
    }
    if (!res.ok) throw new Error(`sqd head: HTTP ${res.status}`);
    return Number((await res.text()).trim());
  }

  /** @deprecated Use currentHeight() */
  async head(): Promise<number> {
    return this.currentHeight();
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey) h["Authorization"] = `Bearer ${this.apiKey}`;
    return h;
  }

  /**
   * Stream all blocks for one mint chunk over [fromSlot, toSlot], yielding parsed block batches
   * per request. Caller composes chunks and owns decode state. Stats accumulate across calls when
   * the same object is passed back in (whole-run request cap).
   *
   * Ceiling guard (FR-5): if a chunk's query payload exceeds PAYLOAD_SOFT_CEILING bytes, the chunk
   * is split in half and each half is streamed recursively. Never silently drops mints.
   *
   * Auth guard (FR-6): 401/403 throws SqdAuthRequiredError immediately — NOT caught by retry loop.
   */
  async *stream(
    mintChunk: readonly string[],
    fromSlot: number,
    toSlot: number,
    stats: SqdStreamStats,
    log: (m: string) => void = () => {},
  ): AsyncGenerator<SqdBlock[]> {
    if (mintChunk.length === 0) return;
    if (mintChunk.length > MINT_CHUNK) throw new Error(`mint chunk ${mintChunk.length} exceeds measured ceiling ${MINT_CHUNK}`);
    const streamUrl = `${PORTAL_BASE}/datasets/${DATASET}/finalized-stream`;

    let frm = fromSlot;
    while (frm < toSlot) {
      if (stats.requests >= this.maxRequests) {
        stats.stoppedAtCap = true;
        log(`[sqd] STOP: request cap ${this.maxRequests} reached at slot ${frm} — re-run resumes from cursor (grant-not-right guard)`);
        return;
      }
      const body = buildQuery(mintChunk, frm);

      // Ceiling guard (FR-5): if payload exceeds soft ceiling, rechunk and delegate to sub-streams
      const payloadBytes = Buffer.byteLength(body, "utf8");
      if (payloadBytes > PAYLOAD_SOFT_CEILING) {
        log(`[SQD WARN] filter payload ${Math.round(payloadBytes / 1024)}KiB exceeds soft ceiling — rechunking`);
        if (mintChunk.length <= 1) {
          throw new Error(`[SQD] filter payload ${Math.round(payloadBytes / 1024)}KiB cannot be reduced below ceiling for single-mint chunk — abort`);
        }
        const half = Math.ceil(mintChunk.length / 2);
        for (const sub of [mintChunk.slice(0, half), mintChunk.slice(half)] as const) {
          if (sub.length > 0) yield* this.stream(sub, frm, toSlot, stats, log);
        }
        return; // sub-streams own continuation
      }

      let res: Response | null = null;
      for (let attempt = 0; ; attempt++) {
        res = await fetch(streamUrl, { method: "POST", headers: this.headers(), body });
        // Auth guard (FR-6): 401/403 thrown immediately, NOT caught by retry loop
        if (res.status === 401 || res.status === 403) {
          throw new SqdAuthRequiredError({
            blockHeight: frm,
            timestamp: new Date().toISOString(),
            status: res.status,
            url: streamUrl,
          });
        }
        if (res.status === 429 || res.status >= 500) {
          if (attempt >= MAX_RETRIES) throw new Error(`sqd stream: HTTP ${res.status} after ${attempt} retries at slot ${frm}`);
          const retryAfter = Number(res.headers.get("retry-after")) || 0;
          await sleep(Math.min(retryAfter * 1000 || 2 ** attempt * 1000, RETRY_CAP_MS));
          continue;
        }
        break;
      }
      if (!res!.ok) {
        const text = await res!.text().catch(() => "");
        throw new Error(`sqd stream: HTTP ${res!.status} ${text.slice(0, 160)}`);
      }
      stats.requests++;
      const blocks: SqdBlock[] = [];
      let last = frm;
      for (const line of (await res!.text()).split("\n")) {
        if (!line.trim()) continue;
        try {
          const b = JSON.parse(line) as SqdBlock;
          const n = Number(b.header?.number);
          if (Number.isInteger(n)) last = Math.max(last, n);
          blocks.push(b);
          stats.balanceRows += b.tokenBalances?.length ?? 0;
        } catch {
          /* torn line at stream end — server terminates cleanly; ignore non-JSON remnants */
        }
      }
      stats.blocks += blocks.length;
      stats.lastSlot = last;
      if (blocks.length > 0) {
        this.lastBlockReceivedAt = Date.now();
        yield blocks;
      }
      if (last <= frm) return; // no progress = range exhausted
      frm = last + 1;
    }
  }
}
