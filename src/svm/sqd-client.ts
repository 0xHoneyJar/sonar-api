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
const MAX_RETRIES = 5;
const RETRY_CAP_MS = 30_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface SqdStreamStats {
  requests: number;
  blocks: number;
  balanceRows: number;
  stoppedAtCap: boolean;
  lastSlot: number;
}

function buildQuery(mintChunk: readonly string[], fromBlock: number): string {
  return JSON.stringify({
    type: "solana",
    fromBlock,
    fields: {
      tokenBalance: { account: true, preMint: true, postMint: true, preOwner: true, postOwner: true, preAmount: true, postAmount: true, transactionIndex: true },
      block: { number: true, timestamp: true },
      transaction: { signatures: true, transactionIndex: true },
    },
    tokenBalances: [{ postMint: mintChunk }, { preMint: mintChunk }],
    transactions: [],
  });
}

export class SqdClient {
  constructor(
    private readonly apiKey: string | undefined = process.env.SQD_API_KEY,
    private readonly maxRequests: number = Number(process.env.SQD_MAX_REQUESTS ?? 20_000) || 20_000,
  ) {}

  /** Finalized head slot (also arrives as a response header on every stream request). */
  async head(): Promise<number> {
    const res = await fetch(`${PORTAL_BASE}/datasets/${DATASET}/finalized-stream/height`, { headers: this.headers() });
    if (!res.ok) throw new Error(`sqd head: HTTP ${res.status}`);
    return Number((await res.text()).trim());
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
   */
  async *stream(
    mintChunk: readonly string[],
    fromSlot: number,
    toSlot: number,
    stats: SqdStreamStats,
    log: (m: string) => void = () => {},
  ): AsyncGenerator<SqdBlock[]> {
    if (mintChunk.length > MINT_CHUNK) throw new Error(`mint chunk ${mintChunk.length} exceeds measured ceiling ${MINT_CHUNK}`);
    let frm = fromSlot;
    while (frm < toSlot) {
      if (stats.requests >= this.maxRequests) {
        stats.stoppedAtCap = true;
        log(`[sqd] STOP: request cap ${this.maxRequests} reached at slot ${frm} — re-run resumes from cursor (grant-not-right guard)`);
        return;
      }
      const body = buildQuery(mintChunk, frm);
      let res: Response | null = null;
      for (let attempt = 0; ; attempt++) {
        res = await fetch(`${PORTAL_BASE}/datasets/${DATASET}/finalized-stream`, { method: "POST", headers: this.headers(), body });
        if (res.status === 429 || res.status >= 500) {
          if (attempt >= MAX_RETRIES) throw new Error(`sqd stream: HTTP ${res.status} after ${attempt} retries at slot ${frm}`);
          const retryAfter = Number(res.headers.get("retry-after")) || 0;
          await sleep(Math.min(retryAfter * 1000 || 2 ** attempt * 1000, RETRY_CAP_MS));
          continue;
        }
        break;
      }
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`sqd stream: HTTP ${res.status} ${text.slice(0, 160)}`);
      }
      stats.requests++;
      const blocks: SqdBlock[] = [];
      let last = frm;
      for (const line of (await res.text()).split("\n")) {
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
      if (blocks.length > 0) yield blocks;
      if (last <= frm) return; // no progress = range exhausted
      frm = last + 1;
    }
  }
}
