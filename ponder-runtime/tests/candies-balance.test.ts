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
