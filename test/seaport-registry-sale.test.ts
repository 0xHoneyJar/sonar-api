/*
 * seaport-registry-sale.test.ts — sprint-bug-190 RED suite.
 *
 * Proves the three defects triaged in
 * grimoires/loa/a2a/bug-20260725-224d57/triage.md, measured against live data in
 * grimoires/loa/context/2026-07-25-marketplace-sale-detection.md:
 *
 *   F1 — transfer Actions are gated on the hardcoded TRANSFER_TRACKED_COLLECTIONS
 *        set, so a config-bound collection Kitchen onboarded emits nothing
 *        (tracked-erc721.ts:130). Chain 1 returns only "azuki" from
 *        distinct_on:primaryCollection despite 9 bound collections.
 *   F2 — sales are gated on the hardcoded TRACKED_COLLECTIONS map
 *        (seaport.ts:37), `operator` is hardcoded undefined (:180,:199), the
 *        amountPaid > 0n guard drops non-native settlement (:156), and only
 *        offer[0] is read (:93) so a multi-NFT order yields one row.
 *   F3 — the decoder requires itemType === 2 (:106), so the three Base Puru
 *        ERC-1155 collections in TRACKED_COLLECTIONS can never produce a sale.
 *
 * Uses the indexer-spy pattern from test/seaport-mainnet-sale.test.ts: replace the
 * `envio` indexer with a spy that captures the registered callback, import the
 * handler so it self-registers, then drive the callback with synthetic fixtures.
 * No live belt, no network.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { captured } = vi.hoisted(() => ({
  captured: { handler: null as null | ((arg: unknown) => Promise<void>) },
}));

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
}));

// Seaport item types (mirror seaport.ts).
const ITEM_TYPE_NATIVE = 0;
const ITEM_TYPE_ERC20 = 1;
const ITEM_TYPE_ERC721 = 2;
const ITEM_TYPE_ERC1155 = 3;

const SEAPORT_16 = "0x0000000000000068f116a894984e2db1123eb395";
const WETH_BASE = "0x4200000000000000000000000000000000000006";
const USDC_BASE = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const ZERO = "0x0000000000000000000000000000000000000000";

const SELLER = "0x1111111111111111111111111111111111111111";
const BUYER = "0x2222222222222222222222222222222222222222";

/**
 * warplets (Base 8453) — bound in config.yaml and onboarded through Kitchen, but
 * absent from seaport.ts TRACKED_COLLECTIONS. 784,410 of Base's 945,062 secondary
 * transfers belong to it; 98.2% of a 600-tx sample carried a Seaport OrderFulfilled
 * log, so every one of these sales is decodable and none are recorded.
 */
const WARPLETS = "0x699727f9e01a822efdcf7333073f0461e5914b4e";

/** lil_bangers (Base 8453) — a second bound collection, for id-collision coverage. */
const LIL_BANGERS = "0x1260f90e0b1c482b38b88f26dee17c57615d670b";

/**
 * The ERC-1155 item-type path, exercised against a registered contract.
 *
 * It used to point at puru_boarding_passes, which left the registry at
 * bd-dwq5.3 with the rest of ERC-1155 (out of MVP scope). The decoder branch
 * under test is chosen by Seaport's itemType, not by the address, and Seaport
 * does not validate that an address really implements the declared standard —
 * so a registered address carries this coverage without a de-scoped entry.
 */
const ERC1155_ITEM = WARPLETS;

function orderFulfilled(opts: {
  offer: unknown[][];
  consideration: unknown[][];
  srcAddress?: string;
}) {
  return {
    srcAddress: opts.srcAddress ?? SEAPORT_16,
    chainId: 8453,
    logIndex: 7,
    params: {
      offerer: SELLER,
      recipient: BUYER,
      offer: opts.offer,
      consideration: opts.consideration,
    },
    block: { timestamp: 1_750_000_000, number: 30_000_000 },
    transaction: { hash: "0xfeedface" },
  };
}

/** One NFT sold for `price` in `token` (native when token is ZERO). */
function singleSale(nft: string, tokenId: bigint, price: bigint, token = ZERO) {
  const itemType = token === ZERO ? ITEM_TYPE_NATIVE : ITEM_TYPE_ERC20;
  return orderFulfilled({
    offer: [[ITEM_TYPE_ERC721, nft, tokenId, 1n]],
    consideration: [[itemType, token, 0n, price, SELLER]],
  });
}

function mockContext() {
  return { MintActivity: { set: vi.fn() } };
}

async function runHandler(event: unknown) {
  const ctx = mockContext();
  expect(
    captured.handler,
    "seaport.ts did not register a Seaport.OrderFulfilled handler",
  ).not.toBeNull();
  await captured.handler!({ event, context: ctx });
  return ctx;
}

const rowsOf = (ctx: ReturnType<typeof mockContext>) =>
  ctx.MintActivity.set.mock.calls.map((c) => c[0] as Record<string, unknown>);

const saleOf = (ctx: ReturnType<typeof mockContext>) =>
  rowsOf(ctx).find((r) => r.activityType === "SALE");

beforeEach(async () => {
  captured.handler = null;
  vi.resetModules();
  await import("../src/handlers/seaport");
});

describe("F2 — sale attribution is gated on a hardcoded collection allowlist", () => {
  it("emits a SALE for a config-bound collection that is not in TRACKED_COLLECTIONS", async () => {
    // warplets is onboarded and indexed; its sales are simply never recorded.
    const ctx = await runHandler(
      singleSale(WARPLETS, 1_152_299n, 2_849_000_000_000_000n),
    );

    // RED: the hardcoded map has no warplets entry, so nothing is emitted.
    expect(rowsOf(ctx).length).toBeGreaterThan(0);
    expect(saleOf(ctx)).toBeDefined();
    expect(saleOf(ctx)!.contract).toBe(WARPLETS);
    expect(saleOf(ctx)!.tokenId).toBe(1_152_299n);
  });

  it("populates `operator` with the marketplace that executed the trade", async () => {
    // score-api's entire sale rule keys on operator; it is null on 100% of live rows.
    const ctx = await runHandler(
      singleSale(WARPLETS, 42n, 1_000_000_000_000_000n),
    );

    const sale = saleOf(ctx);
    expect(sale).toBeDefined();
    // RED: hardcoded `operator: undefined` at seaport.ts:180.
    expect(sale!.operator).toBe(SEAPORT_16);
  });
});

describe("F2 — settlement currency is dropped instead of recorded", () => {
  it("emits a SALE for a USDC-settled order and records the payment token", async () => {
    const price = 4_200_000_000n; // 4,200 USDC (6dp)
    const ctx = await runHandler(
      singleSale(WARPLETS, 7n, price, USDC_BASE),
    );

    // RED: USDC is neither native nor the configured wrappedNativeToken, so
    // amountPaid stays 0n and the `amountPaid > 0n` guard drops the row entirely.
    const sale = saleOf(ctx);
    expect(sale).toBeDefined();
    expect(sale!.amountPaid).toBe(price);
    expect(sale!.paymentToken).toBe(USDC_BASE);
  });

  it("marks a native-settled sale with the zero address as its payment token", async () => {
    // 89.6% of sampled Base sales settle in native ETH — the denomination must be
    // explicit, or floor/average price math silently mixes currencies.
    const ctx = await runHandler(
      singleSale(WARPLETS, 8n, 2_000_000_000_000_000n),
    );

    const sale = saleOf(ctx);
    expect(sale).toBeDefined();
    expect(sale!.paymentToken).toBe(ZERO);
  });

  it("still records a sale when the order carries no recoverable price", async () => {
    // An unpriced sale is still a disposal. Dropping it makes "sold" and
    // "we could not price it" indistinguishable downstream.
    const ctx = await runHandler(
      orderFulfilled({
        offer: [[ITEM_TYPE_ERC721, WARPLETS, 9n, 1n]],
        consideration: [],
      }),
    );

    const sale = saleOf(ctx);
    expect(sale).toBeDefined();
    expect(sale!.amountPaid ?? null).toBeNull();
  });
});

describe("F2 — a multi-token order collapses to a single row", () => {
  it("emits one SALE per NFT in the order, each with its own price", async () => {
    const unit = 1_500_000_000_000_000n;
    const ctx = await runHandler(
      orderFulfilled({
        offer: [
          [ITEM_TYPE_ERC721, WARPLETS, 100n, 1n],
          [ITEM_TYPE_ERC721, WARPLETS, 101n, 1n],
        ],
        consideration: [[ITEM_TYPE_NATIVE, ZERO, 0n, unit * 2n, SELLER]],
      }),
    );

    // RED: only offer[0] is read (seaport.ts:93) → one SALE, not two.
    const sales = rowsOf(ctx).filter((r) => r.activityType === "SALE");
    expect(sales).toHaveLength(2);
    expect(sales.map((s) => s.tokenId).sort()).toEqual([100n, 101n]);

    const total = sales.reduce((acc, s) => acc + (s.amountPaid as bigint), 0n);
    expect(total).toBe(unit * 2n);
  });
});

describe("review HIGH-1 — MintActivity.id must be unique across collections", () => {
  it("emits distinct ids for two collections sharing a tokenId in one order", async () => {
    // tokenIds are not unique across collections, and low ids are common. Without
    // the contract in the id both rows key identically and `.set` silently drops
    // one — a sale disappears with no error.
    const ctx = await runHandler(
      orderFulfilled({
        offer: [
          [ITEM_TYPE_ERC721, WARPLETS, 5n, 1n],
          [ITEM_TYPE_ERC721, LIL_BANGERS, 5n, 1n],
        ],
        consideration: [[ITEM_TYPE_NATIVE, ZERO, 0n, 4_000_000_000_000_000n, SELLER]],
      }),
    );

    const sales = rowsOf(ctx).filter((r) => r.activityType === "SALE");
    expect(sales).toHaveLength(2);
    expect(new Set(sales.map((s) => s.id)).size).toBe(2);

    // Same guarantee on the buyer side.
    const purchases = rowsOf(ctx).filter((r) => r.activityType === "PURCHASE");
    expect(new Set(purchases.map((p) => p.id)).size).toBe(2);
  });
});

describe("review MEDIUM-1 — Scenario 2: the offerer is the buyer (accepted bid)", () => {
  it("assigns seller and buyer correctly when payment is offered and the NFT is consideration", async () => {
    const price = 6_000_000_000_000_000n;
    const ctx = await runHandler(
      orderFulfilled({
        // Offerer puts up WETH; the fulfiller hands over the NFT.
        offer: [[ITEM_TYPE_ERC20, WETH_BASE, 0n, price]],
        consideration: [[ITEM_TYPE_ERC721, WARPLETS, 77n, 1n, SELLER]],
      }),
    );

    const sale = saleOf(ctx);
    expect(sale).toBeDefined();
    // The offerer paid, so the offerer is the BUYER and the recipient is the SELLER.
    expect(sale!.user).toBe(BUYER);
    const purchase = rowsOf(ctx).find((r) => r.activityType === "PURCHASE");
    expect(purchase!.user).toBe(SELLER);
    // Price comes from the offer side in this scenario.
    expect(sale!.amountPaid).toBe(price);
    expect(sale!.paymentToken).toBe(WETH_BASE);
  });
});

describe("review MEDIUM-2 — a mixed-currency order has no honest single price", () => {
  it("records the sale with a null price rather than truncating to one currency", async () => {
    const ctx = await runHandler(
      orderFulfilled({
        offer: [[ITEM_TYPE_ERC721, WARPLETS, 12n, 1n]],
        consideration: [
          [ITEM_TYPE_NATIVE, ZERO, 0n, 3_000_000_000_000_000n, SELLER],
          [ITEM_TYPE_ERC20, USDC_BASE, 0n, 2_000_000n, SELLER],
        ],
      }),
    );

    const sale = saleOf(ctx);
    // The row still exists — the disposal happened.
    expect(sale).toBeDefined();
    // But no single currency expresses the price, so it must not enter floor math.
    expect(sale!.amountPaid ?? null).toBeNull();
    expect(sale!.paymentToken ?? null).toBeNull();
  });
});

describe("F3 — ERC-1155 orders are rejected by the item-type filter", () => {
  it("emits a SALE for an ERC-1155 order and carries the quantity", async () => {
    const price = 3_000_000_000_000_000n;
    const ctx = await runHandler(
      orderFulfilled({
        offer: [[ITEM_TYPE_ERC1155, ERC1155_ITEM, 4n, 3n]],
        consideration: [[ITEM_TYPE_ERC20, WETH_BASE, 0n, price, SELLER]],
      }),
    );

    // RED: seaport.ts:106 requires itemType === 2, so the three Base Puru
    // collections sitting in TRACKED_COLLECTIONS can never produce a sale.
    const sale = saleOf(ctx);
    expect(sale).toBeDefined();
    expect(sale!.tokenStandard).toBe("ERC1155");
    expect(sale!.quantity).toBe(3n);
    expect(sale!.amountPaid).toBe(price);
  });
});

describe("BB SEA-001 — ids must be unique for every emitted row", () => {
  it("emits distinct ids when one order lists the same tokenId twice", async () => {
    // Observed once in 1,482 sampled real orders: an ERC-1155 order can list the
    // same (contract, tokenId) twice. contract+tokenId in the id is not enough —
    // the item index is what makes each row addressable.
    const ctx = await runHandler(
      orderFulfilled({
        offer: [
          [ITEM_TYPE_ERC1155, ERC1155_ITEM, 4n, 2n],
          [ITEM_TYPE_ERC1155, ERC1155_ITEM, 4n, 1n],
        ],
        consideration: [[ITEM_TYPE_NATIVE, ZERO, 0n, 6_000_000_000_000_000n, SELLER]],
      }),
    );

    const sales = rowsOf(ctx).filter((r) => r.activityType === "SALE");
    expect(sales).toHaveLength(2);
    expect(new Set(sales.map((s) => s.id)).size).toBe(2);
  });
});

describe("BB SEA-002 — never attribute a trade to the zero address", () => {
  it("skips a matchOrders-style fill whose recipient is the zero address", async () => {
    const ctx = await runHandler({
      ...singleSale(WARPLETS, 1n, 1_000_000_000_000_000n),
      params: {
        offerer: SELLER,
        recipient: ZERO,
        offer: [[ITEM_TYPE_ERC721, WARPLETS, 1n, 1n]],
        consideration: [[ITEM_TYPE_NATIVE, ZERO, 0n, 1_000_000_000_000_000n, SELLER]],
      },
    });
    expect(ctx.MintActivity.set).not.toHaveBeenCalled();
  });
});

describe("BB SEA-006 — a zero price is a known price, not an unknown one", () => {
  it("records amountPaid 0 rather than null for a zero-value settlement", async () => {
    const ctx = await runHandler(
      orderFulfilled({
        offer: [[ITEM_TYPE_ERC721, WARPLETS, 3n, 1n]],
        consideration: [[ITEM_TYPE_NATIVE, ZERO, 0n, 0n, SELLER]],
      }),
    );
    const sale = saleOf(ctx);
    expect(sale).toBeDefined();
    expect(sale!.amountPaid).toBe(0n);
    expect(sale!.paymentToken).toBe(ZERO);
  });
});
