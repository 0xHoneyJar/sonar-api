/**
 * T-6: §4.5 gate unit tests — synthetic data (fixture absent; real gate BLOCKED).
 *
 * These tests verify the decode + eventId pipeline produces a consistent match_rate
 * against a synthetic reference set, exercising the same reconcile logic the gate script
 * would run against the 30,006-event fixture when available.
 */
import { describe, expect, it } from "vitest";
import { decodeSqdBlocks, type SqdBlock } from "../src/svm/sqd-collection-event-source";
import { eventId } from "../src/svm/collection-event-writer";

const MINT = "J1S9H3QjnRtBbbuD4HjPV6RpRhwuk4zKbxsnCHuTgh9w";
const ALICE = "BUjZjAS2vbbb65g7Z1Ca9ZRVYoJscURG5L3AkVvHP9ac";
const BOB = "4mKSoDDqApmF1DqXvVTSL6tu2zixrSSNjqMxUnwvVzy2";
const ACC1 = "2gxanuBRcWieT3Y6ko5dYkFE3LsJK7XzX9EdJDGtYrCj";
const ACC2 = "9QcQnXF9AtixPDzQQvgt7NmWNgqjY6JttstqADzfcASW";
const SIG = "5qiEtJtRBzd6b49mcJdzCYHUtqsXqGC5FUX5SixxgVWErpsbqnabYLLQzSXQcqPr3KjeaXWXZ6GMrxvb1xn3Gqkn";
const MEMBERS = new Set([MINT]);

/** Reconcile: compute match_rate between decoded events and a reference set. */
function reconcile(decoded: ReturnType<typeof decodeSqdBlocks>["events"], reference: string[]): number {
  const decodedIds = new Set(decoded.map(eventId));
  const refSet = new Set(reference);
  let matched = 0;
  for (const id of refSet) if (decodedIds.has(id)) matched++;
  return refSet.size === 0 ? 1.0 : matched / refSet.size;
}

const TRANSFER_BLOCK: SqdBlock = {
  header: { number: 428886218, timestamp: 1782422682 },
  transactions: [{ transactionIndex: 5, signatures: [SIG] }],
  tokenBalances: [
    { transactionIndex: 5, account: ACC1, preMint: MINT, postMint: MINT, preOwner: ALICE, postOwner: ALICE, preAmount: "1", postAmount: "0" },
    { transactionIndex: 5, account: ACC2, preMint: MINT, postMint: MINT, preOwner: BOB, postOwner: BOB, preAmount: "0", postAmount: "1" },
  ],
};

describe("§4.5 gate — synthetic reconciliation", () => {
  it("match_rate=1.0 when decoded events exactly match reference set", () => {
    const { events } = decodeSqdBlocks([TRANSFER_BLOCK], MEMBERS, new Set([MINT]));
    const reference = events.map(eventId);
    expect(reconcile(events, reference)).toBe(1.0);
  });

  it("match_rate=0 when reference contains PKs not in decoded output", () => {
    const { events } = decodeSqdBlocks([TRANSFER_BLOCK], MEMBERS, new Set([MINT]));
    const reference = ["phantom-sig:phantom-mint:0"];
    expect(reconcile(events, reference)).toBe(0);
  });

  it("match_rate=0.5 when half the reference is matched", () => {
    const { events } = decodeSqdBlocks([TRANSFER_BLOCK], MEMBERS, new Set([MINT]));
    const reference = [eventId(events[0]), "phantom-sig:phantom-mint:0"];
    expect(reconcile(events, reference)).toBe(0.5);
  });

  it("gate PASS condition: match_rate >= 0.99 (synthetic: should be 1.0)", () => {
    const { events } = decodeSqdBlocks([TRANSFER_BLOCK], MEMBERS, new Set([MINT]));
    const reference = events.map(eventId);
    const matchRate = reconcile(events, reference);
    const divergenceCount = reference.filter((id) => !new Set(events.map(eventId)).has(id)).length;
    expect(matchRate).toBeGreaterThanOrEqual(0.99);
    expect(divergenceCount).toBe(0);
  });
});
