// ponder-runtime/tests/candies-balance.test.ts
//
// Unit tests for the per-holder Candies (mibera_drugs) balance arithmetic +
// upsert helper (src/handlers/candies-balance.ts). Mirrors the repo's posture
// of testing extracted handler helpers without the Ponder runtime
// (mibera-liquid-backing.test.ts).
//
// Coverage:
//   - computeNextBalance: credit adds; debit subtracts; debit clamps at 0.
//   - makeCandiesBalanceId: deterministic, lowercased.
//   - applyCandiesBalance against an in-memory context.db mock:
//       * mint   → credits `to`, no `from` row
//       * trade  → debits `from`, credits `to`
//       * burn   → debits `from`, no `to` row
//       * never negative on over-debit

import { describe, expect, it } from "vitest";
import {
  computeNextBalance,
  makeCandiesBalanceId,
  applyCandiesBalance,
  applyTransferBalances,
  isCandiesContract,
  CANONICAL_CANDIES_CONTRACT,
  ZERO_ADDRESS,
} from "../src/handlers/candies-balance";

// ── pure arithmetic ─────────────────────────────────────────────────────────
describe("computeNextBalance", () => {
  it("credit adds quantity", () => {
    expect(computeNextBalance(5n, 3n, "credit")).toBe(8n);
  });

  it("credit from zero", () => {
    expect(computeNextBalance(0n, 10n, "credit")).toBe(10n);
  });

  it("debit subtracts quantity", () => {
    expect(computeNextBalance(10n, 4n, "debit")).toBe(6n);
  });

  it("debit clamps at 0 (never negative)", () => {
    expect(computeNextBalance(3n, 10n, "debit")).toBe(0n);
  });

  it("debit to exactly zero", () => {
    expect(computeNextBalance(7n, 7n, "debit")).toBe(0n);
  });

  it("preserves uint256 fidelity", () => {
    const huge = 2n ** 200n;
    expect(computeNextBalance(huge, 1n, "credit")).toBe(huge + 1n);
    expect(computeNextBalance(huge, 1n, "debit")).toBe(huge - 1n);
  });

  it("treats a negative quantity defensively as no-op delta", () => {
    expect(computeNextBalance(5n, -3n, "credit")).toBe(5n);
    expect(computeNextBalance(5n, -3n, "debit")).toBe(5n);
  });
});

describe("makeCandiesBalanceId", () => {
  it("composes contract-chainId-tokenId-holder, lowercased", () => {
    const id = makeCandiesBalanceId(
      "0xABC",
      80094,
      42n,
      "0xDEF",
    );
    expect(id).toBe("0xabc-80094-42-0xdef");
  });
});

// ── in-memory context.db mock mirroring the ponder surface used by the helper ─
function makeMockDb() {
  const tables = new Map<string, Map<string, any>>();

  const keyFor = (table: any) =>
    typeof table === "string" ? table : (table?.name ?? "candies_holder_balance");

  const getTable = (table: any) => {
    const k = keyFor(table);
    if (!tables.has(k)) tables.set(k, new Map());
    return tables.get(k)!;
  };

  const db = {
    async find(table: any, where: { id: string }) {
      return getTable(table).get(where.id) ?? null;
    },
    insert(table: any) {
      return {
        values(row: any) {
          return {
            onConflictDoNothing() {
              const t = getTable(table);
              if (!t.has(row.id)) t.set(row.id, { ...row });
            },
            // Mirror Ponder's atomic INSERT … ON CONFLICT DO UPDATE: insert the
            // row if absent, else apply the callback's patch to the stored row.
            // The callback receives the EXISTING row (selectModel), matching the
            // runtime API (node_modules/ponder/.../db.d.ts onConflictDoUpdate).
            onConflictDoUpdate(updater: any) {
              const t = getTable(table);
              const existing = t.get(row.id);
              if (!existing) {
                t.set(row.id, { ...row });
                return;
              }
              const patch =
                typeof updater === "function" ? updater(existing) : updater;
              t.set(row.id, { ...existing, ...patch });
            },
          };
        },
      };
    },
    update(table: any, where: { id: string }) {
      return {
        set(patch: any) {
          const t = getTable(table);
          const existing = t.get(where.id) ?? { id: where.id };
          t.set(where.id, { ...existing, ...patch });
        },
      };
    },
  };

  // helper handles `candiesHolderBalance` (the onchainTable object). We only
  // ever read `.amount`, so we expose rows under a single logical table.
  return { context: { db }, tables };
}

const CONTRACT = "0x80283fbf2b8e50f6ddf9bfc4a90a8336bc90e38f";
const ALICE = "0x1111111111111111111111111111111111111111";
const BOB = "0x2222222222222222222222222222222222222222";
const CHAIN = 80094;
const TOKEN = 1n;
const TS = 1000n;

function rowFor(tables: Map<string, Map<string, any>>, holder: string) {
  const id = makeCandiesBalanceId(CONTRACT, CHAIN, TOKEN, holder);
  // single logical table — find the first (only) table map.
  for (const t of tables.values()) {
    if (t.has(id)) return t.get(id);
  }
  return null;
}

describe("applyCandiesBalance — mint / trade / burn", () => {
  it("mint: credits `to`, no `from` (0x0) row", async () => {
    const { context, tables } = makeMockDb();
    // mint = transfer from ZERO_ADDRESS to ALICE
    await applyCandiesBalance({
      context,
      holder: ZERO_ADDRESS,
      contract: CONTRACT,
      tokenId: TOKEN,
      chainId: CHAIN,
      quantity: 5n,
      direction: "debit",
      timestamp: TS,
    });
    await applyCandiesBalance({
      context,
      holder: ALICE,
      contract: CONTRACT,
      tokenId: TOKEN,
      chainId: CHAIN,
      quantity: 5n,
      direction: "credit",
      timestamp: TS,
    });

    expect(rowFor(tables, ZERO_ADDRESS)).toBeNull();
    expect(rowFor(tables, ALICE)?.amount).toBe(5n);
    expect(rowFor(tables, ALICE)?.holder_id).toBe(ALICE.toLowerCase());
    expect(rowFor(tables, ALICE)?.updatedAt).toBe(TS);
  });

  it("trade: debits `from`, credits `to`", async () => {
    const { context, tables } = makeMockDb();
    // seed Alice with 5 (a prior mint)
    await applyCandiesBalance({
      context, holder: ALICE, contract: CONTRACT, tokenId: TOKEN,
      chainId: CHAIN, quantity: 5n, direction: "credit", timestamp: TS,
    });
    // Alice trades 2 to Bob
    await applyCandiesBalance({
      context, holder: ALICE, contract: CONTRACT, tokenId: TOKEN,
      chainId: CHAIN, quantity: 2n, direction: "debit", timestamp: TS + 1n,
    });
    await applyCandiesBalance({
      context, holder: BOB, contract: CONTRACT, tokenId: TOKEN,
      chainId: CHAIN, quantity: 2n, direction: "credit", timestamp: TS + 1n,
    });

    expect(rowFor(tables, ALICE)?.amount).toBe(3n);
    expect(rowFor(tables, BOB)?.amount).toBe(2n);
  });

  it("burn: debits `from`, no `to` (0x0) row", async () => {
    const { context, tables } = makeMockDb();
    await applyCandiesBalance({
      context, holder: ALICE, contract: CONTRACT, tokenId: TOKEN,
      chainId: CHAIN, quantity: 9n, direction: "credit", timestamp: TS,
    });
    // burn 4: from Alice to ZERO_ADDRESS
    await applyCandiesBalance({
      context, holder: ALICE, contract: CONTRACT, tokenId: TOKEN,
      chainId: CHAIN, quantity: 4n, direction: "debit", timestamp: TS + 2n,
    });
    await applyCandiesBalance({
      context, holder: ZERO_ADDRESS, contract: CONTRACT, tokenId: TOKEN,
      chainId: CHAIN, quantity: 4n, direction: "credit", timestamp: TS + 2n,
    });

    expect(rowFor(tables, ALICE)?.amount).toBe(5n);
    expect(rowFor(tables, ZERO_ADDRESS)).toBeNull();
  });

  it("never drives a balance negative on over-debit", async () => {
    const { context, tables } = makeMockDb();
    await applyCandiesBalance({
      context, holder: ALICE, contract: CONTRACT, tokenId: TOKEN,
      chainId: CHAIN, quantity: 1n, direction: "credit", timestamp: TS,
    });
    await applyCandiesBalance({
      context, holder: ALICE, contract: CONTRACT, tokenId: TOKEN,
      chainId: CHAIN, quantity: 100n, direction: "debit", timestamp: TS + 1n,
    });
    expect(rowFor(tables, ALICE)?.amount).toBe(0n);
  });

  it("zero-quantity transfer is a no-op", async () => {
    const { context, tables } = makeMockDb();
    await applyCandiesBalance({
      context, holder: ALICE, contract: CONTRACT, tokenId: TOKEN,
      chainId: CHAIN, quantity: 0n, direction: "credit", timestamp: TS,
    });
    expect(rowFor(tables, ALICE)).toBeNull();
  });
});

// ── HANDLER-WIRING tests (applyTransferBalances) ─────────────────────────────
//
// These prove the two FAGAN-convergence repairs at the handler-wiring level —
// the bug was NOT in the helper arithmetic (covered above) but in how the
// handler called it:
//   Finding 1 — a TRADE (from != 0, to != 0) must DEBIT `from` AND CREDIT `to`.
//               (the original TransferSingle ran the debit only on mints.)
//   Finding 2 — a non-candies (non-mibera_drugs) event must write NO row, and
//               candies rows must carry the canonical contract the consumer
//               (inventory-api) filters on — regardless of which market address
//               emitted the event.
//
// The two CandiesMarket1155 market addresses (both mibera_drugs):
const CANDIES_PRIMARY = "0x80283fbf2b8e50f6ddf9bfc4a90a8336bc90e38f"; // SilkRoad
const CANDIES_SECONDARY = "0xeca03517c5195f1edd634da6d690d6c72407c40c";
// A non-candies contract (e.g. some other 1155 the handler must NOT pollute the
// table with). Deliberately not in CANDIES_MARKET_ADDRESSES.
const NON_CANDIES = "0x9999999999999999999999999999999999999999";

// Row lookup keyed on the CANONICAL contract (what applyTransferBalances writes),
// not the emitting market address.
function canonicalRowFor(
  tables: Map<string, Map<string, any>>,
  holder: string,
  tokenId = TOKEN,
) {
  const id = makeCandiesBalanceId(CANONICAL_CANDIES_CONTRACT, CHAIN, tokenId, holder);
  for (const t of tables.values()) {
    if (t.has(id)) return t.get(id);
  }
  return null;
}

describe("isCandiesContract — the Finding-2 gate signal", () => {
  it("recognises BOTH candies market addresses (case-insensitive)", () => {
    expect(isCandiesContract(CANDIES_PRIMARY)).toBe(true);
    expect(isCandiesContract(CANDIES_SECONDARY)).toBe(true);
    expect(isCandiesContract(CANDIES_PRIMARY.toUpperCase())).toBe(true);
  });
  it("rejects a non-candies contract", () => {
    expect(isCandiesContract(NON_CANDIES)).toBe(false);
  });
});

describe("applyTransferBalances — handler wiring (Findings 1 & 2)", () => {
  it("Finding 1: a TRADE debits `from` AND credits `to` (the bug was no debit)", async () => {
    const { context, tables } = makeMockDb();
    // seed Alice with 5 via a prior mint (from ZERO → Alice).
    const mintWrote = await applyTransferBalances({
      context, from: ZERO_ADDRESS, to: ALICE, contractAddress: CANDIES_SECONDARY,
      tokenId: TOKEN, chainId: CHAIN, quantity: 5n, timestamp: TS,
    });
    expect(mintWrote).toBe(true);
    expect(canonicalRowFor(tables, ALICE)?.amount).toBe(5n);
    // mint has no `from` holder row.
    expect(canonicalRowFor(tables, ZERO_ADDRESS)).toBeNull();

    // TRADE: Alice → Bob, qty 2 (from != 0 AND to != 0).
    const tradeWrote = await applyTransferBalances({
      context, from: ALICE, to: BOB, contractAddress: CANDIES_SECONDARY,
      tokenId: TOKEN, chainId: CHAIN, quantity: 2n, timestamp: TS + 1n,
    });
    expect(tradeWrote).toBe(true);

    // The debit on `from` is the part the handler previously skipped on trades.
    expect(canonicalRowFor(tables, ALICE)?.amount).toBe(3n); // 5 - 2 debit
    expect(canonicalRowFor(tables, BOB)?.amount).toBe(2n);   // 0 + 2 credit
  });

  it("Finding 1: a BURN debits `from`, writes no `to` row", async () => {
    const { context, tables } = makeMockDb();
    await applyTransferBalances({
      context, from: ZERO_ADDRESS, to: ALICE, contractAddress: CANDIES_SECONDARY,
      tokenId: TOKEN, chainId: CHAIN, quantity: 9n, timestamp: TS,
    });
    // BURN: Alice → ZERO, qty 4.
    await applyTransferBalances({
      context, from: ALICE, to: ZERO_ADDRESS, contractAddress: CANDIES_SECONDARY,
      tokenId: TOKEN, chainId: CHAIN, quantity: 4n, timestamp: TS + 2n,
    });
    expect(canonicalRowFor(tables, ALICE)?.amount).toBe(5n);
    expect(canonicalRowFor(tables, ZERO_ADDRESS)).toBeNull();
  });

  it("Finding 2: a NON-mibera_drugs event writes NO balance row (gated out)", async () => {
    const { context, tables } = makeMockDb();
    const wrote = await applyTransferBalances({
      context, from: ALICE, to: BOB, contractAddress: NON_CANDIES,
      tokenId: TOKEN, chainId: CHAIN, quantity: 7n, timestamp: TS,
    });
    expect(wrote).toBe(false);
    // No rows at all — neither under the non-candies address nor the canonical.
    expect(canonicalRowFor(tables, ALICE)).toBeNull();
    expect(canonicalRowFor(tables, BOB)).toBeNull();
    let total = 0;
    for (const t of tables.values()) total += t.size;
    expect(total).toBe(0);
  });

  it("Finding 2: row `contract` is the CANONICAL value even from the primary market address", async () => {
    const { context, tables } = makeMockDb();
    // Event emitted from the PRIMARY (SilkRoad) market address — a trade.
    await applyTransferBalances({
      context, from: ZERO_ADDRESS, to: ALICE, contractAddress: CANDIES_PRIMARY,
      tokenId: TOKEN, chainId: CHAIN, quantity: 6n, timestamp: TS,
    });
    // The row MUST be findable under the canonical contract (what inventory-api
    // filters on) — NOT under the emitting primary address.
    const canonical = canonicalRowFor(tables, ALICE);
    expect(canonical?.amount).toBe(6n);
    expect(canonical?.contract).toBe(CANONICAL_CANDIES_CONTRACT);
    // And NOT under the raw emitting (primary) address.
    const wrongId = makeCandiesBalanceId(CANDIES_PRIMARY, CHAIN, TOKEN, ALICE);
    let underPrimary: any = null;
    for (const t of tables.values()) if (t.has(wrongId)) underPrimary = t.get(wrongId);
    expect(underPrimary).toBeNull();
  });

  it("Finding 2: primary + secondary market activity coalesce on one canonical row", async () => {
    const { context, tables } = makeMockDb();
    // Mint via secondary address.
    await applyTransferBalances({
      context, from: ZERO_ADDRESS, to: ALICE, contractAddress: CANDIES_SECONDARY,
      tokenId: TOKEN, chainId: CHAIN, quantity: 3n, timestamp: TS,
    });
    // Another credit to Alice via primary address — same canonical contract ⇒
    // same row id ⇒ amount accumulates (not split across two contract values).
    await applyTransferBalances({
      context, from: ZERO_ADDRESS, to: ALICE, contractAddress: CANDIES_PRIMARY,
      tokenId: TOKEN, chainId: CHAIN, quantity: 4n, timestamp: TS + 1n,
    });
    expect(canonicalRowFor(tables, ALICE)?.amount).toBe(7n);
  });

  it("Finding 2: canonical contract MUST match inventory-api CANDIES_CONTRACT (lowercased)", () => {
    // inventory-api src/inventory.ts:31 CANDIES_CONTRACT, lowercased.
    expect(CANONICAL_CANDIES_CONTRACT).toBe(
      "0xeca03517c5195f1edd634da6d690d6c72407c40c",
    );
  });

  // ── Conservation invariant ────────────────────────────────────────────────
  // After a transfer from A→B the SUM of A's and B's balances MUST equal the
  // sum before the transfer. A bug that clamps-debit-then-adds-full-credit
  // (the self-transfer inflation) or writes two credit rows would fail this.
  it("conservation: total balance (from + to) is unchanged by a transfer", async () => {
    const { context, tables } = makeMockDb();
    // Seed Alice=5, Bob=3 via mints.
    await applyTransferBalances({
      context, from: ZERO_ADDRESS, to: ALICE, contractAddress: CANDIES_SECONDARY,
      tokenId: TOKEN, chainId: CHAIN, quantity: 5n, timestamp: TS,
    });
    await applyTransferBalances({
      context, from: ZERO_ADDRESS, to: BOB, contractAddress: CANDIES_SECONDARY,
      tokenId: TOKEN, chainId: CHAIN, quantity: 3n, timestamp: TS,
    });
    const preSumAlice = canonicalRowFor(tables, ALICE)?.amount ?? 0n;
    const preSumBob = canonicalRowFor(tables, BOB)?.amount ?? 0n;
    const preTotal = preSumAlice + preSumBob; // 5n + 3n = 8n

    // Alice → Bob, qty 2.
    await applyTransferBalances({
      context, from: ALICE, to: BOB, contractAddress: CANDIES_SECONDARY,
      tokenId: TOKEN, chainId: CHAIN, quantity: 2n, timestamp: TS + 1n,
    });

    const postAlice = canonicalRowFor(tables, ALICE)?.amount ?? 0n;
    const postBob = canonicalRowFor(tables, BOB)?.amount ?? 0n;
    expect(postAlice + postBob).toBe(preTotal); // conservation holds
    expect(postAlice).toBe(3n);
    expect(postBob).toBe(5n);
  });

  // ── Self-transfer guard ───────────────────────────────────────────────────
  // ERC-1155 allows from == to. Issuing debit-then-credit on the same row when
  // stored < qty would clamp-debit to 0 then credit-add full qty (inflation).
  // When the row is absent, debit seeds 0 and credit fabricates qty from nothing.
  it("self-transfer of qty > held leaves the row unchanged (no inflation)", async () => {
    const { context, tables } = makeMockDb();
    // Seed Alice with 1.
    await applyTransferBalances({
      context, from: ZERO_ADDRESS, to: ALICE, contractAddress: CANDIES_SECONDARY,
      tokenId: TOKEN, chainId: CHAIN, quantity: 1n, timestamp: TS,
    });
    expect(canonicalRowFor(tables, ALICE)?.amount).toBe(1n);

    // Self-transfer qty=2 (qty > held=1 — the inflation scenario).
    const wrote = await applyTransferBalances({
      context, from: ALICE, to: ALICE, contractAddress: CANDIES_SECONDARY,
      tokenId: TOKEN, chainId: CHAIN, quantity: 2n, timestamp: TS + 1n,
    });
    expect(wrote).toBe(true); // still a candies event
    // Balance must be unchanged at 1, NOT inflated to 2.
    expect(canonicalRowFor(tables, ALICE)?.amount).toBe(1n);
  });

  it("self-transfer to an absent row creates no row (no supply fabrication)", async () => {
    const { context, tables } = makeMockDb();
    // ALICE has no row yet.
    const wrote = await applyTransferBalances({
      context, from: ALICE, to: ALICE, contractAddress: CANDIES_SECONDARY,
      tokenId: TOKEN, chainId: CHAIN, quantity: 3n, timestamp: TS,
    });
    expect(wrote).toBe(true);
    // No row should exist — self-transfer must not fabricate a balance.
    expect(canonicalRowFor(tables, ALICE)).toBeNull();
    let total = 0;
    for (const t of tables.values()) total += t.size;
    expect(total).toBe(0);
  });
});
