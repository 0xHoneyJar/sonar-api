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
 *   - R-12: a WETH-settled mainnet Azuki sale yields amountPaid > 0 (RED if a
 *     settlement-token comparison regresses to checksummed — every address lookup
 *     compares lowercased).
 *   - R-9 / OQ-5: the SALE/PURCHASE rows carry chainId:1.
 *   - FR-6c: a non-ETH ERC-20-settled sale is RECORDED with its exact amount and an
 *     explicit paymentToken. This assertion was INVERTED in bug-20260725-224d57 —
 *     it previously asserted the sale was skipped, which was the defect itself. The
 *     "~71% coverage v1 baseline" it used to pin is superseded; see the block comment
 *     above that describe() for the full rationale.
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

const AZUKI = "0xed5af388653567af2f388e6224dc7c4b3241c544"; // canonical Azuki (matches TRACKED_COLLECTIONS + main config + #115)
// Checksummed on purpose — proves the handler lowercases the consideration token
// before comparing against the (lowercased) configured wrappedNativeToken.
const WETH_CHECKSUMMED = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"; // non-ETH ERC-20
const SELLER = "0x1111111111111111111111111111111111111111";
const BUYER = "0x2222222222222222222222222222222222222222";
const ZERO = "0x0000000000000000000000000000000000000000";

/** Seaport 1.6 — the contract that emits the fill, and therefore the `operator`. */
const SEAPORT_16 = "0x0000000000000068f116a894984e2db1123eb395";

/** Build an OrderFulfilled event: offerer sells an Azuki NFT (Scenario 1).
 *
 * `chainId` and `srcAddress` became load-bearing in bug-20260725-224d57: collection
 * eligibility is now resolved per (chain, contract) from the active belt config, and
 * `operator` is the emitting marketplace. Previously both were implied by the
 * hardcoded TRACKED_COLLECTIONS entry, so the fixtures could omit them. */
function azukiSaleEvent(considerationItems: unknown[][]) {
  return {
    srcAddress: SEAPORT_16,
    chainId: 1,
    logIndex: 3,
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
  await import("../src/handlers/marketplaces/seaport");
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

/*
 * DELIBERATE CONTRACT CHANGE (bug-20260725-224d57 F2).
 *
 * This block previously asserted the opposite: that a non-ETH ERC-20 settlement
 * produced NO row, because amountPaid summed to 0n and the `amountPaid > 0n` guard
 * dropped it. That behaviour WAS the defect — a real, priced sale vanished because
 * of the currency it settled in, and score-api could not distinguish "never sold"
 * from "sold in a currency we declined to read".
 *
 * The sale is now recorded with its exact amount and an explicit `paymentToken`.
 * The "~71% coverage v1 baseline" this block used to pin is superseded.
 */
describe("FR-6c non-ETH ERC-20 settlement is recorded, not dropped", () => {
  it("emits a priced sale settled in USDC, tagged with its payment token", async () => {
    const price = 4_200_000_000n; // 4,200 USDC (6dp)
    const ctx = await runHandler(
      azukiSaleEvent([[ITEM_TYPE_ERC20, USDC, 0n, price, SELLER]]),
    );

    const sale = ctx.MintActivity.set.mock.calls
      .map((c) => c[0])
      .find((r) => r.activityType === "SALE");
    expect(sale).toBeDefined();
    expect(sale.amountPaid).toBe(price);
    expect(sale.paymentToken).toBe(USDC);
    // Denomination is explicit — 4,200 USDC must never be read as 4,200 wei.
    expect(sale.paymentToken).not.toBe(
      "0x0000000000000000000000000000000000000000",
    );
  });
});
