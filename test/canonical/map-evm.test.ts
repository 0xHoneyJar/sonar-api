import { describe, it, expect } from "vitest";
import { Either } from "effect";
import {
  mapEvmLeg,
  mapEvmLegs,
  findOrphanSales,
  type EvmTransferLeg,
  type EvmSaleRow,
  type EvmCollectionContext,
} from "../../src/canonical/map-evm";

const ZERO = "0x0000000000000000000000000000000000000000";
const ALICE = "0x1111111111111111111111111111111111111111";
const BOB = "0x2222222222222222222222222222222222222222";
const SELLER = "0x3333333333333333333333333333333333333333";
const BUYER = "0x4444444444444444444444444444444444444444";

const ctx: EvmCollectionContext = {
  collectionKey: "mibera",
  chainId: 80094, // Berachain
  contract: "0xBBBBbbbbBbBbBbbBBBBbbBbbBbBbBBbBbbbBBbBB", // checksum-cased on purpose
};

function leg(overrides: Partial<EvmTransferLeg> = {}): EvmTransferLeg {
  return {
    txHash: "0x" + "a".repeat(64),
    tokenId: "123",
    from: ALICE,
    to: BOB,
    logIndex: 0,
    blockNumber: 100,
    timestamp: "2025-01-01T00:00:00Z",
    ...overrides,
  };
}

function right(e: Either.Either<unknown, { reason: string }>) {
  if (Either.isLeft(e)) throw new Error(`expected Right, got Left: ${e.left.reason}`);
  return e.right;
}

describe("mapEvmLeg — verb derivation", () => {
  it("mint = transfer from the zero address (from=null)", () => {
    const a = right(mapEvmLeg(leg({ from: ZERO }), ctx)) as any;
    expect(a.verb).toBe("mint");
    expect(a.chain).toBe("evm");
    expect(a.from).toBeNull();
    expect(a.to).toBe(BOB); // lowercased
    expect(a.value).toBeNull();
    expect(a.metadata.chain).toBe("evm");
    expect(a.metadata.chain_id).toBe(80094);
    expect(a.metadata.contract).toBe(ctx.contract.toLowerCase()); // checksum → lowercase
    expect(a.metadata.token_id).toBe("123");
  });

  it("burn = transfer to the zero address (to=null)", () => {
    const a = right(mapEvmLeg(leg({ to: ZERO }), ctx)) as any;
    expect(a.verb).toBe("burn");
    expect(a.to).toBeNull();
    expect(a.from).toBe(ALICE);
  });

  it("transfer = non-mint, non-burn leg with NO matching sale", () => {
    const a = right(mapEvmLeg(leg(), ctx, null)) as any;
    expect(a.verb).toBe("transfer");
    expect(a.from).toBe(ALICE);
    expect(a.to).toBe(BOB);
    expect(a.value).toBeNull();
  });

  it("sale = a matched leg → resolved seller/buyer + wei-string value + decimals=18", () => {
    const sale: EvmSaleRow = { txHash: leg().txHash, tokenId: "123", seller: SELLER, buyer: BUYER, priceWei: "1500000000000000000" };
    const a = right(mapEvmLeg(leg(), ctx, sale)) as any;
    expect(a.verb).toBe("sale");
    expect(a.from).toBe(SELLER); // resolved, not the raw transfer.from
    expect(a.to).toBe(BUYER);
    expect(a.value).toBe("1500000000000000000"); // 1.5 ETH in wei — decimal string
    expect(a.decimals).toBe(18);
  });

  it("preserves a uint256 wei value beyond 2^53 with no precision loss (string in → string out)", () => {
    const huge = "1000000000000000000000000"; // 1,000,000 ETH in wei, >> 2^53
    const sale: EvmSaleRow = { txHash: leg().txHash, tokenId: "123", seller: SELLER, buyer: BUYER, priceWei: huge };
    const a = right(mapEvmLeg(leg(), ctx, sale)) as any;
    expect(a.value).toBe(huge);
  });
});

describe("mapEvmLeg — typed-error rejections", () => {
  it("rejects a transfer from AND to the zero address", () => {
    const e = mapEvmLeg(leg({ from: ZERO, to: ZERO }), ctx);
    expect(Either.isLeft(e)).toBe(true);
    if (Either.isLeft(e)) expect(e.left.reason).toContain("zero address");
  });

  it("rejects a collection_key that isn't a legal topic segment", () => {
    const e = mapEvmLeg(leg({ from: ZERO }), { ...ctx, collectionKey: "Mibera_EVM" });
    expect(Either.isLeft(e)).toBe(true);
    if (Either.isLeft(e)) {
      expect(e.left._tag).toBe("SchemaInvalid");
      expect(e.left.reason).toContain("decode failed");
    }
  });

  it("rejects a non-decimal tokenId (schema token_id /^\\d+$/)", () => {
    const e = mapEvmLeg(leg({ from: ZERO, tokenId: "0xabc" }), ctx);
    expect(Either.isLeft(e)).toBe(true);
  });
});

describe("mapEvmLegs — sale-EXCLUSIVE precedence (F4: one movement → ONE activity)", () => {
  it("a SALE leg yields exactly verb=sale, NOT also verb=transfer", () => {
    const saleLeg = leg({ tokenId: "123" });
    const plainLeg = leg({ tokenId: "456", logIndex: 1 });
    const sales: EvmSaleRow[] = [
      { txHash: saleLeg.txHash, tokenId: "123", seller: SELLER, buyer: BUYER, priceWei: "1000000000000000000" },
    ];
    const out = mapEvmLegs([saleLeg, plainLeg], sales, ctx).map((e) => right(e) as any);
    expect(out).toHaveLength(2); // one activity per leg — no extra transfer for the sale leg
    expect(out[0].verb).toBe("sale");
    expect(out[1].verb).toBe("transfer");
    // exactly one sale, exactly one transfer — no double-emit of the matched movement
    expect(out.filter((a) => a.verb === "sale")).toHaveLength(1);
    expect(out.filter((a) => a.verb === "transfer")).toHaveLength(1);
  });

  it("a market-routed sale (seller→market→buyer = 2 legs, one sale row): ONE sale (carrier) + the hop as transfer", () => {
    const txHash = "0x" + "c".repeat(64);
    const MARKET = "0x9999999999999999999999999999999999999999";
    const legSellerToMarket = leg({ txHash, tokenId: "777", from: SELLER, to: MARKET, logIndex: 0 });
    const legMarketToBuyer = leg({ txHash, tokenId: "777", from: MARKET, to: BUYER, logIndex: 1 });
    const sales: EvmSaleRow[] = [
      { txHash, tokenId: "777", seller: SELLER, buyer: BUYER, priceWei: "2000000000000000000" },
    ];
    const out = mapEvmLegs([legSellerToMarket, legMarketToBuyer], sales, ctx).map((e) => right(e) as any);
    expect(out).toHaveLength(2); // 1:1 legs→activities — no drop
    const saleActs = out.filter((a) => a.verb === "sale");
    expect(saleActs).toHaveLength(1); // exactly one sale (the carrier)
    expect(saleActs[0].from).toBe(SELLER); // resolved parties, not the market hop
    expect(saleActs[0].to).toBe(BUYER);
    expect(saleActs[0].metadata.log_index).toBe(0); // carrier = min logIndex
    const xfer = out.filter((a) => a.verb === "transfer");
    expect(xfer).toHaveLength(1);
    expect(xfer[0].from).toBe(MARKET.toLowerCase()); // the hop survives as a real transfer
    expect(xfer[0].to).toBe(BUYER);
  });

  it("carrier pick is order-INDEPENDENT (min logIndex), not first-encountered (F9 determinism — MAJOR-2)", () => {
    const txHash = "0x" + "d".repeat(64);
    const MARKET = "0x9999999999999999999999999999999999999999";
    const l0 = leg({ txHash, tokenId: "777", from: SELLER, to: MARKET, logIndex: 0 });
    const l1 = leg({ txHash, tokenId: "777", from: MARKET, to: BUYER, logIndex: 1 });
    const sales: EvmSaleRow[] = [{ txHash, tokenId: "777", seller: SELLER, buyer: BUYER, priceWei: "1" }];
    // feed in REVERSE log order — the sale carrier must still be logIndex 0
    const out = mapEvmLegs([l1, l0], sales, ctx).map((e) => right(e) as any);
    const sale = out.find((a) => a.verb === "sale");
    expect(sale.metadata.log_index).toBe(0);
  });

  it("a genuine sale-then-retransfer (seller→buyer, buyer→C) keeps BOTH, no silent loss (MAJOR-1)", () => {
    const txHash = "0x" + "e".repeat(64);
    const C = "0x5555555555555555555555555555555555555555";
    const saleLeg = leg({ txHash, tokenId: "888", from: SELLER, to: BUYER, logIndex: 0 });
    const retransfer = leg({ txHash, tokenId: "888", from: BUYER, to: C, logIndex: 1 });
    const sales: EvmSaleRow[] = [{ txHash, tokenId: "888", seller: SELLER, buyer: BUYER, priceWei: "1000000000000000000" }];
    const out = mapEvmLegs([saleLeg, retransfer], sales, ctx).map((e) => right(e) as any);
    expect(out).toHaveLength(2);
    expect(out[0].verb).toBe("sale");
    expect(out[1].verb).toBe("transfer"); // buyer→C survives (different verb — consumer dedup keeps it)
    expect(out[1].from).toBe(BUYER);
    expect(out[1].to).toBe(C);
  });

  it("MINOR-1: joins across leading-zero tokenId formatting (sale '0777' matches leg '777')", () => {
    const txHash = "0x" + "f".repeat(64);
    const saleLeg = leg({ txHash, tokenId: "777", from: SELLER, to: BUYER, logIndex: 0 });
    const sales: EvmSaleRow[] = [{ txHash, tokenId: "0777", seller: SELLER, buyer: BUYER, priceWei: "1" }];
    const [a] = mapEvmLegs([saleLeg], sales, ctx).map((e) => right(e) as any);
    expect(a.verb).toBe("sale"); // canonicalized join matched despite "0777" vs "777"
  });

  it("a mint leg with a (spurious) matching sale row stays a mint (mint/burn precede sale)", () => {
    const mintLeg = leg({ from: ZERO, tokenId: "123" });
    const sales: EvmSaleRow[] = [
      { txHash: mintLeg.txHash, tokenId: "123", seller: SELLER, buyer: BUYER, priceWei: "1" },
    ];
    const [a] = mapEvmLegs([mintLeg], sales, ctx).map((e) => right(e) as any);
    expect(a.verb).toBe("mint");
  });
});

describe("findOrphanSales — observability for sales with no matching leg (MINOR-3)", () => {
  it("returns sale rows that have no matching non-zero transfer leg", () => {
    const txHash = "0x" + "a".repeat(64);
    const present = leg({ txHash, tokenId: "1", from: SELLER, to: BUYER, logIndex: 0 });
    const sales: EvmSaleRow[] = [
      { txHash, tokenId: "1", seller: SELLER, buyer: BUYER, priceWei: "1" }, // has a leg
      { txHash, tokenId: "999", seller: SELLER, buyer: BUYER, priceWei: "1" }, // orphan
    ];
    const orphans = findOrphanSales([present], sales);
    expect(orphans).toHaveLength(1);
    expect(orphans[0].tokenId).toBe("999");
  });
});
