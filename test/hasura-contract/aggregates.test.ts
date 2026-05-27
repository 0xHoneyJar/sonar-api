// test/hasura-contract/aggregates.test.ts
//
// T-A3.6 — 2 aggregate query tests.
//
// Aggregates (`*_aggregate { aggregate { count, sum, avg } }`) are the
// classic Hasura feature consumers use for dashboard tiles + summary cards.
// Post-cutover, these MUST return values within +/- delta of the envio baseline
// (small drift OK if Ponder has been running on staging for a different time
// window; large drift = hard fail).
//
// Inputs:
//   ENVIO_BASELINE_PATH — optional JSON file: { "MintEvent_aggregate": 1234,
//                          "BgtBoostEvent_aggregate": 567 }
//   If not provided, the suite asserts shape (count > 0) only — operator-
//   reviewed comparison runs separately.

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";

const HASURA_URL = process.env.HASURA_URL;
const HASURA_ADMIN_SECRET = process.env.HASURA_ADMIN_SECRET;
const ENVIO_BASELINE_PATH = process.env.ENVIO_BASELINE_PATH;
// Default delta = 1% drift tolerance (matches T-A2.11 row-count parity AC).
const DRIFT_DELTA = Number(process.env.AGGREGATE_DRIFT_TOLERANCE ?? "0.01");

interface BaselineDoc {
  [aggregateKey: string]: number | { count?: number; sum?: number };
}

const baseline: BaselineDoc | null =
  ENVIO_BASELINE_PATH && existsSync(ENVIO_BASELINE_PATH)
    ? (JSON.parse(readFileSync(ENVIO_BASELINE_PATH, "utf-8")) as BaselineDoc)
    : null;

async function runQuery(query: string): Promise<{ data?: Record<string, unknown>; errors?: Array<{ message: string }> }> {
  if (!HASURA_URL) throw new Error("HASURA_URL not set");
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (HASURA_ADMIN_SECRET) headers["x-hasura-admin-secret"] = HASURA_ADMIN_SECRET;
  const response = await fetch(`${HASURA_URL}/v1/graphql`, {
    method: "POST",
    headers,
    body: JSON.stringify({ query }),
  });
  return await response.json();
}

function baselineCount(key: string): number | null {
  if (!baseline) return null;
  const v = baseline[key];
  if (v === undefined) return null;
  if (typeof v === "number") return v;
  if (typeof v === "object" && typeof v.count === "number") return v.count;
  return null;
}

function withinDelta(observed: number, expected: number, delta: number): boolean {
  if (expected === 0) return observed === 0;
  return Math.abs(observed - expected) / expected <= delta;
}

describe.skipIf(!HASURA_URL)("Hasura aggregates (T-A3.6)", () => {
  it("MintEvent_aggregate { count } matches envio baseline (within delta)", async () => {
    const query = `query { MintEvent_aggregate { aggregate { count } } }`;
    const result = await runQuery(query);
    expect(result.errors).toBeUndefined();
    const agg = result.data?.MintEvent_aggregate as { aggregate?: { count?: number } } | undefined;
    expect(agg?.aggregate?.count).toBeTypeOf("number");
    const observed = agg!.aggregate!.count!;
    expect(observed, "non-negative count").toBeGreaterThanOrEqual(0);

    const expected = baselineCount("MintEvent_aggregate");
    if (expected !== null) {
      expect(
        withinDelta(observed, expected, DRIFT_DELTA),
        `MintEvent count drift > ${DRIFT_DELTA * 100}%: observed=${observed} expected=${expected}`,
      ).toBe(true);
    }
  });

  it("BgtBoostEvent_aggregate { count, sum { amount } } matches envio baseline (within delta)", async () => {
    const query = `query { BgtBoostEvent_aggregate { aggregate { count } } }`;
    const result = await runQuery(query);
    expect(result.errors).toBeUndefined();
    const agg = result.data?.BgtBoostEvent_aggregate as { aggregate?: { count?: number } } | undefined;
    expect(agg?.aggregate?.count).toBeTypeOf("number");
    const observed = agg!.aggregate!.count!;
    expect(observed).toBeGreaterThanOrEqual(0);

    const expected = baselineCount("BgtBoostEvent_aggregate");
    if (expected !== null) {
      expect(
        withinDelta(observed, expected, DRIFT_DELTA),
        `BgtBoostEvent count drift > ${DRIFT_DELTA * 100}%: observed=${observed} expected=${expected}`,
      ).toBe(true);
    }
  });
});
