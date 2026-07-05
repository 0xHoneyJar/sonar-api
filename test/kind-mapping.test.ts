import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { mapRows, validateRow } from "../src/svm/warehouse-loader";

/**
 * T-2 adjudication record. The full precision measurement vs Helius-classified labels needs live
 * DB access (runbook step 5.3, post-topup); what CI pins is (1) the measured program-ID map
 * fixture stays well-formed, and (2) the batch-1 kind policy — coarse, never wrong — actually
 * holds in the loader: marketplace custody legs arrive as `transfer`, never as invented kinds.
 */
const fixture = JSON.parse(readFileSync("test/fixtures/svm-warehouse/pythians-program-distribution.json", "utf8"));

describe("T-2 kind-mapping decision (batch-1 = option c)", () => {
  it("fixture carries the measured program map + an explicit decision", () => {
    expect(Object.keys(fixture.marketplace_program_candidates).length).toBeGreaterThanOrEqual(4);
    expect(fixture.mint_program["Guard1JwRhJkVH6XZhzoYxeBVQe872VH6QggF4BWmS9g"].mints).toBe(3683); // = member count (cross-confirmation)
    expect(fixture.decision).toMatch(/option c/);
  });

  it("loader emits ONLY mint/transfer/burn — a marketplace custody leg maps to transfer, never a guessed sale/list", () => {
    const v = validateRow({
      action: "transfer",
      block_slot: 428886218,
      block_time: "2026-06-25T21:24:42Z",
      tx_id: "5qiEtJtRBzd6b49mcJdzCYHUtqsXqGC5FUX5SixxgVWErpsbqnabYLLQzSXQcqPr3KjeaXWXZ6GMrxvb1xn3Gqkn",
      outer_instruction_index: 0,
      inner_instruction_index: 0,
      token_mint_address: "J1S9H3QjnRtBbbuD4HjPV6RpRhwuk4zKbxsnCHuTgh9w",
      from_owner: "BUjZjAS2vbbb65g7Z1Ca9ZRVYoJscURG5L3AkVvHP9ac",
      to_owner: "M2mx93ekt1fmXSVkTrUL9xVFHkmME8HTUi5Cyc5aF7K", // ME-v2 escrow — still a transfer in batch-1 policy
    })!;
    const [e] = mapRows([v]);
    expect(e.kind).toBe("transfer");
    expect(e.price).toBeNull();
    expect(e.marketplace).toBeNull();
  });
});
