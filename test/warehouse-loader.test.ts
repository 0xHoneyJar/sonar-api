import { describe, expect, it, vi } from "vitest";
import { mapRows, runLoader, validateRow, windowsBetween, WAREHOUSE_QUERY_IDS, type WarehouseRow } from "../src/svm/warehouse-loader";
import { parseHeliusTx } from "../src/svm/collection-event-source";
import { eventId } from "../src/svm/collection-event-writer";

const MINT_A = "J1S9H3QjnRtBbbuD4HjPV6RpRhwuk4zKbxsnCHuTgh9w";
const MINT_B = "6mszaj17KSfVqADrQj3o4W3zoLMTykgmV37W4QadCczK";
const OWNER_1 = "BUjZjAS2vbbb65g7Z1Ca9ZRVYoJscURG5L3AkVvHP9ac";
const OWNER_2 = "4mKSoDDqApmF1DqXvVTSL6tu2zixrSSNjqMxUnwvVzy2";
const TX = "5qiEtJtRBzd6b49mcJdzCYHUtqsXqGC5FUX5SixxgVWErpsbqnabYLLQzSXQcqPr3KjeaXWXZ6GMrxvb1xn3Gqkn";

const row = (over: Partial<WarehouseRow> = {}): WarehouseRow => ({
  action: "transfer",
  block_slot: 428886218,
  block_time: "2026-06-25T21:24:42Z",
  tx_id: TX,
  outer_instruction_index: 2,
  inner_instruction_index: 0,
  token_mint_address: MINT_A,
  from_owner: OWNER_1,
  to_owner: OWNER_2,
  ...over,
});

describe("validateRow (untrusted input)", () => {
  it("accepts a well-formed row", () => expect(validateRow(row())).not.toBeNull());
  it.each([
    ["unknown action", { action: "sale" }], // warehouse never emits sale in batch-1 policy — reject, don't guess
    ["bad mint", { token_mint_address: "0xdeadbeef" }],
    ["short tx", { tx_id: "abc" }],
    ["bad slot", { block_slot: "not-a-slot" }],
    ["bad time", { block_time: "yesterday-ish" }],
  ])("rejects %s rather than coercing", (_n, over) => {
    expect(validateRow(row(over as Partial<WarehouseRow>))).toBeNull();
  });
  it("nulls a malformed owner instead of rejecting the row (owner-level fields are nullable)", () => {
    const v = validateRow(row({ from_owner: "escrow??" }));
    expect(v).not.toBeNull();
    expect(v!.fromOwner).toBeNull();
  });
});

describe("mapRows — PK convergence with the Enhanced/webhook path", () => {
  it("produces the SAME event id as parseHeliusTx for the same tx (the content-addressed contract)", () => {
    // Warehouse view of a tx moving MINT_A from OWNER_1 to OWNER_2:
    const [we] = mapRows([validateRow(row())!]);
    // Enhanced view of the SAME tx through the existing parser:
    const [he] = parseHeliusTx(
      {
        signature: TX,
        slot: 428886218,
        timestamp: 1782422682,
        type: "TRANSFER",
        tokenTransfers: [{ mint: MINT_A, fromUserAccount: OWNER_1, toUserAccount: OWNER_2, tokenStandard: "NonFungible" }],
      },
      (m) => m === MINT_A,
    );
    expect(eventId(we)).toBe(eventId(he));
    expect(we.kind).toBe(he.kind);
  });

  it("numbers per-(tx,mint) ordinals 0..n in instruction order — two mints in one tx get independent ordinals", () => {
    const rows = [
      validateRow(row({ token_mint_address: MINT_B, outer_instruction_index: 1 }))!,
      validateRow(row({ outer_instruction_index: 3 }))!, // MINT_A leg 2
      validateRow(row({ outer_instruction_index: 0 }))!, // MINT_A leg 1
    ];
    const events = mapRows(rows);
    const aOrdinals = events.filter((e) => e.nftMint === MINT_A).map((e) => e.instructionIndex);
    const bOrdinals = events.filter((e) => e.nftMint === MINT_B).map((e) => e.instructionIndex);
    expect(aOrdinals).toEqual([0, 1]); // ordered by instruction index, ordinal per mint
    expect(bOrdinals).toEqual([0]);
  });

  it("mint→from=null, burn→to=null (action semantics win over row fields)", () => {
    const [m] = mapRows([validateRow(row({ action: "mint" }))!]);
    expect(m.from).toBeNull();
    const [b] = mapRows([validateRow(row({ action: "burn" }))!]);
    expect(b.to).toBeNull();
  });
});

describe("windowsBetween", () => {
  it("splits a range into bounded windows and clamps the tail", () => {
    const w = windowsBetween("2026-01-01T00:00:00Z", "2026-03-15T00:00:00Z", 30);
    expect(w).toHaveLength(3);
    expect(w[2].to).toBe("2026-03-15T00:00:00.000Z");
  });
  it("returns [] for inverted or unparseable ranges", () => {
    expect(windowsBetween("2026-02-01T00:00:00Z", "2026-01-01T00:00:00Z")).toEqual([]);
    expect(windowsBetween("garbage", "2026-01-01T00:00:00Z")).toEqual([]);
  });
});

describe("runLoader", () => {
  const deps = () => ({
    dune: { runQuery: vi.fn().mockResolvedValue({ rows: [row(), row({ token_mint_address: "bad!" })], executionCostCredits: 0.2 }) },
    upsert: vi.fn().mockResolvedValue(1),
    syncStatus: vi.fn().mockResolvedValue(true),
    log: vi.fn(),
  });

  it("dry mode: fetches + maps but never upserts or writes sync status", async () => {
    WAREHOUSE_QUERY_IDS.events = 999;
    const d = deps();
    const r = await runLoader({ collectionKey: "pythians", from: "2026-06-01T00:00:00Z", to: "2026-06-20T00:00:00Z", dry: true }, d);
    expect(r.rowsFetched).toBe(2);
    expect(r.rowsRejected).toBe(1);
    expect(r.eventsUpserted).toBe(0);
    expect(d.upsert).not.toHaveBeenCalled();
    expect(d.syncStatus).not.toHaveBeenCalled();
    expect(r.duneCredits).toBeCloseTo(0.2);
  });

  it("live mode: upserts with dune-warehouse provenance and stamps freshness", async () => {
    WAREHOUSE_QUERY_IDS.events = 999;
    const d = deps();
    await runLoader({ collectionKey: "pythians", from: "2026-06-01T00:00:00Z", to: "2026-06-20T00:00:00Z" }, d);
    expect(d.upsert).toHaveBeenCalledWith(expect.any(Array), "pythians", expect.any(String), "dune-warehouse");
    expect(d.syncStatus).toHaveBeenCalledWith(expect.objectContaining({ collectionKey: "pythians", lastEventSource: "dune-warehouse" }));
  });

  it("refuses to run without a saved events query id", async () => {
    WAREHOUSE_QUERY_IDS.events = 0;
    await expect(runLoader({ collectionKey: "pythians", from: "2026-06-01T00:00:00Z", to: "2026-06-02T00:00:00Z" }, deps())).rejects.toThrow(/DUNE_EVENTS_QUERY_ID/);
  });
});

describe("FL SKP-004 — credit budget", () => {
  it("stops cleanly between windows when DUNE_CREDIT_BUDGET is exceeded", async () => {
    process.env.DUNE_CREDIT_BUDGET = "0.1"; // read at module load — this test documents the env contract...
    // (module-level constant → budget behavior is exercised via a fresh import)
    const { runLoader: freshRun, WAREHOUSE_QUERY_IDS: ids } = await import("../src/svm/warehouse-loader?budget=" + Date.now());
    ids.events = 999;
    const dune = { runQuery: vi.fn().mockResolvedValue({ rows: [], executionCostCredits: 5 }) };
    const r = await freshRun(
      { collectionKey: "pythians", from: "2026-01-01T00:00:00Z", to: "2026-04-01T00:00:00Z", dry: true },
      { dune, upsert: vi.fn(), syncStatus: vi.fn(), log: vi.fn() },
    );
    expect(dune.runQuery).toHaveBeenCalledTimes(1); // 3 windows planned, stopped after the first
    expect(r.duneCredits).toBe(5);
    delete process.env.DUNE_CREDIT_BUDGET;
  });
});
