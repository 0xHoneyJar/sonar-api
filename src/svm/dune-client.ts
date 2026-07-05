/**
 * dune-client.ts — minimal Dune Analytics API client for the SVM warehouse lane (SDD §2.1).
 *
 * Deliberately NOT the Dune SDK: the lane's contract is three endpoints (execute / status /
 * results-with-pagination), and the repo idiom is raw fetch with explicit retry semantics
 * (mirrors addressHistory's 429/5xx handling in collection-event-source.ts). No streaming,
 * no websockets — history extraction is batch by nature.
 *
 * Cost discipline (PRD NFR-1): every completed execution's `execution_cost_credits` (Dune
 * result metadata) is surfaced to the caller and logged — no silent spend. This lane exists
 * because the previous one exhausted a quota invisibly (KF-018).
 *
 * Auth: DUNE_API_KEY env only — never argv, never logged (PRD NFR-4).
 */

const API_BASE = "https://api.dune.com/api/v1";
const MAX_RETRIES = 5;
const RETRY_CAP_MS = 30_000;
const POLL_INTERVAL_MS = 5_000;
const POLL_TIMEOUT_MS = 15 * 60_000; // medium-engine joins on tokens_solana.transfers ran ~4 min unbounded; 15 min is generous

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface DuneExecution {
  executionId: string;
}

export interface DuneResultPage<Row = Record<string, unknown>> {
  rows: Row[];
  totalRowCount: number;
  /** Dune-reported credits for the execution — surfaced for the per-run cost log. */
  executionCostCredits: number | null;
}

export type DuneParams = Record<string, string | number>;

export class DuneClient {
  constructor(private readonly apiKey: string = process.env.DUNE_API_KEY ?? "") {
    if (!this.apiKey) throw new Error("DUNE_API_KEY required");
  }

  private async request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(`${API_BASE}${path}`, {
        method,
        headers: { "X-Dune-API-Key": this.apiKey, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (res.status === 429 || res.status >= 500) {
        if (attempt >= MAX_RETRIES) {
          // NOTE: error message carries path only — never the key (it lives in a header, and
          // we never interpolate the URL's search params because there are none).
          throw new Error(`dune ${path}: HTTP ${res.status} after ${attempt} retries`);
        }
        const retryAfter = Number(res.headers.get("retry-after")) || 0;
        const backoff = Math.min(retryAfter * 1000 || 2 ** attempt * 1000, RETRY_CAP_MS);
        await sleep(backoff);
        continue;
      }
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`dune ${path}: HTTP ${res.status} ${text.slice(0, 200)}`);
      }
      return (await res.json()) as T;
    }
  }

  /** Execute a saved query with parameters. Returns the execution handle. */
  async executeQuery(queryId: number, params: DuneParams = {}, performance: "medium" | "large" = "medium"): Promise<DuneExecution> {
    const d = await this.request<{ execution_id: string }>("POST", `/query/${queryId}/execute`, {
      query_parameters: params,
      performance,
    });
    return { executionId: d.execution_id };
  }

  /** Poll an execution to a terminal state. Throws on FAILED / poll timeout. */
  async waitForCompletion(executionId: string): Promise<void> {
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    for (;;) {
      const d = await this.request<{ state: string; error?: unknown }>("GET", `/execution/${executionId}/status`);
      if (d.state === "QUERY_STATE_COMPLETED") return;
      if (d.state === "QUERY_STATE_FAILED" || d.state === "QUERY_STATE_CANCELLED") {
        throw new Error(`dune execution ${executionId}: ${d.state} ${JSON.stringify(d.error ?? "").slice(0, 200)}`);
      }
      if (Date.now() > deadline) throw new Error(`dune execution ${executionId}: poll timeout after ${POLL_TIMEOUT_MS}ms`);
      await sleep(POLL_INTERVAL_MS);
    }
  }

  /** Fetch one page of results. Caller drives offset pagination. */
  async fetchPage<Row = Record<string, unknown>>(executionId: string, limit: number, offset: number): Promise<DuneResultPage<Row>> {
    const d = await this.request<{
      result?: { rows?: Row[]; metadata?: { total_row_count?: number; execution_cost_credits?: number | string } };
    }>("GET", `/execution/${executionId}/results?limit=${limit}&offset=${offset}`);
    const meta = d.result?.metadata ?? {};
    const cost = meta.execution_cost_credits;
    return {
      rows: d.result?.rows ?? [],
      totalRowCount: meta.total_row_count ?? 0,
      executionCostCredits: cost === undefined || cost === null ? null : Number(cost),
    };
  }

  /**
   * Execute + wait + drain all pages. The page size stays under Dune's per-fetch caps;
   * callers bound total volume via query-side time windows (SDD §2.3), not here.
   */
  async runQuery<Row = Record<string, unknown>>(
    queryId: number,
    params: DuneParams = {},
    opts?: { pageSize?: number; log?: (msg: string) => void },
  ): Promise<{ rows: Row[]; executionCostCredits: number | null }> {
    const pageSize = opts?.pageSize ?? 5_000;
    const log = opts?.log ?? (() => {});
    const { executionId } = await this.executeQuery(queryId, params);
    await this.waitForCompletion(executionId);
    const rows: Row[] = [];
    let cost: number | null = null;
    for (let offset = 0; ; offset += pageSize) {
      const page = await this.fetchPage<Row>(executionId, pageSize, offset);
      rows.push(...page.rows);
      cost = page.executionCostCredits ?? cost;
      if (rows.length >= page.totalRowCount || page.rows.length === 0) break;
    }
    // REST results metadata carries no credits field (verified 2026-07-05) — Dune bills a FLAT
    // rate per execution by engine tier (medium 10 / large 20). Estimate honestly when absent.
    const est = cost ?? 10;
    log(`[dune] query ${queryId}: ${rows.length} rows · ${cost !== null ? `${cost} credits` : `≈${est} credits (medium-engine flat rate)`}`);
    return { rows, executionCostCredits: est };
  }
}
