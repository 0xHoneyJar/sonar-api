/*
 * seaport-mainnet-sale.test.ts — FR-6 mainnet Azuki priced-sale decode (Sprint 1.5).
 *
 * seaport.ts self-registers its OrderFulfilled handler as a module-load side effect
 * via `indexer.onEvent(...)` (no named export). This test replaces the `envio`
 * `indexer` with a spy that CAPTURES the registered callback, imports the handler
 * so it registers, then invokes the callback with synthetic OrderFulfilled fixtures
 * and asserts the emitted MintActivity rows. (Mirrors the indexer-spy pattern in
 * test/registration-coverage.test.ts.)
 *
 * Guards:
 *   - R-12: a WETH-settled mainnet Azuki sale yields amountPaid > 0 (RED if the
 *     TRACKED_COLLECTIONS WETH/key regresses to checksummed — the lookup at
 *     seaport.ts:110 compares .toLowerCase()).
 *   - R-9 / OQ-5: the SALE/PURCHASE rows carry chainId:1.
 *   - FR-6c: a non-ETH ERC-20-settled sale sums to amountPaid=0n and is SKIPPED
 *     (not emitted as a zero-priced sale) — the ~71%-coverage v1 baseline.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Capture the OrderFulfilled callback registered by seaport.ts at module load.
const { captured } = vi.hoisted(() => {
  return { captured: { handler: null as null | ((arg: unknown) => Promise<void>) } };
});

vi.mock("envio", () => ({
  indexer: {
    onEvent: (
      id: { contract?: string; event?: string },
      cb: (arg: unknown) => Promise<void>,
    ) => {
      if (id?.contract === "Seaport" && id?.event === "OrderFulfilled") {
        captured.handler = cb;
      }
    },
    contractRegister: () => {},
    onBlock: () => {},
    onSlot: () => {},
  },
  // Type-only exports (MintActivity) are erased at compile time — no runtime binding.
}));

// Seaport item types (mirror seaport.ts).
const ITEM_TYPE_NATIVE = 0;
const ITEM_TYPE_ERC20 = 1;
const ITEM_TYPE_ERC721 = 2;

const AZUKI = "0xed5af388653567af2f388e6224dcc93746104133";
// Checksummed on purpose — proves the handler lowercases the consideration token
// before comparing against the (lowercased) configured wrappedNativeToken.
const WETH_CHECKSUMMED = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"; // non-ETH ERC-20
const SELLER = "0x1111111111111111111111111111111111111111";
const BUYER = "0x2222222222222222222222222222222222222222";
const ZERO = "0x0000000000000000000000000000000000000000";

/** Build an OrderFulfilled event: offerer sells an Azuki NFT (Scenario 1). */
function azukiSaleEvent(considerationItems: unknown[][]) {
  return {
    params: {
      offerer: SELLER,
      recipient: BUYER,
      // offer[0] = [itemType, token, identifier, amount]
      offer: [[ITEM_TYPE_ERC721, AZUKI, 1234n, 1n]],
      // consideration[i] = [itemType, token, identifier, amount, recipient]
      consideration: considerationItems,
    },
    block: { timestamp: 1_700_000_000, number: 18_500_000 },
    transaction: { hash: "0xdeadbeef" },
  };
}

function mockContext() {
  return { MintActivity: { set: vi.fn() } };
}

async function runHandler(event: unknown) {
  const ctx = mockContext();
  expect(captured.handler, "seaport.ts did not register a Seaport.OrderFulfilled handler").not.toBeNull();
  await captured.handler!({ event, context: ctx });
  return ctx;
}

beforeEach(async () => {
  captured.handler = null;
  vi.resetModules();
  await import("../src/handlers/seaport");
});

describe("FR-6 mainnet Azuki priced sale — WETH settlement (R-12 lowercasing guard)", () => {
  it("emits a priced SALE with amountPaid > 0 for a WETH-settled Azuki sale", async () => {
    const price = 5_000_000_000_000_000_000n; // 5 WETH
    const ctx = await runHandler(
      azukiSaleEvent([
        [ITEM_TYPE_ERC20, WETH_CHECKSUMMED, 0n, price, SELLER],
      ]),
    );

    // Two rows: SALE (seller) + PURCHASE (buyer).
    expect(ctx.MintActivity.set).toHaveBeenCalledTimes(2);
    const sale = ctx.MintActivity.set.mock.calls
      .map((c) => c[0])
      .find((r) => r.activityType === "SALE");
    expect(sale).toBeDefined();
    // RED if WETH is stored checksummed in TRACKED_COLLECTIONS (would sum to 0 → dropped).
    expect(sale.amountPaid).toBe(price);
    expect(sale.amountPaid > 0n).toBe(true);
  });

  it("carries chainId:1 on the SALE and PURCHASE rows (R-9 / OQ-5)", async () => {
    const ctx = await runHandler(
      azukiSaleEvent([
        [ITEM_TYPE_ERC20, WETH_CHECKSUMMED, 0n, 1_000_000_000_000_000_000n, SELLER],
      ]),
    );
    const rows = ctx.MintActivity.set.mock.calls.map((c) => c[0]);
    expect(rows.map((r) => r.activityType).sort()).toEqual(["PURCHASE", "SALE"]);
    for (const r of rows) expect(r.chainId).toBe(1);
  });

  it("sums native ETH consideration too", async () => {
    const price = 3_000_000_000_000_000_000n;
    const ctx = await runHandler(
      azukiSaleEvent([[ITEM_TYPE_NATIVE, ZERO, 0n, price, SELLER]]),
    );
    const sale = ctx.MintActivity.set.mock.calls
      .map((c) => c[0])
      .find((r) => r.activityType === "SALE");
    expect(sale.amountPaid).toBe(price);
  });
});

describe("FR-6c ETH/WETH-only v1 — non-ETH ERC-20 settlement is skipped", () => {
  it("does NOT emit a sale when settled purely in a non-ETH ERC-20 (amountPaid=0n)", async () => {
    const ctx = await runHandler(
      azukiSaleEvent([
        [ITEM_TYPE_ERC20, USDC, 0n, 4_200_000_000n, SELLER], // 4,200 USDC, not summed
      ]),
    );
    // amountPaid stays 0n → fails the amountPaid > 0n guard → no rows emitted.
    expect(ctx.MintActivity.set).not.toHaveBeenCalled();
  });
});
