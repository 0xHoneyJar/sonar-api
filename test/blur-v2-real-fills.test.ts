/*
 * blur-v2-real-fills.test.ts — the Blur v2 decoder against REAL mainnet data.
 *
 * This decoder has no named fields to trust: everything is bit-packed into two
 * uint256s, and only ONE party is on the log. A wrong shift produces a valid
 * address and a plausible price, so a synthetic fixture I wrote myself would
 * prove nothing — it would just assert my own arithmetic back at me.
 *
 * So every expectation here was derived INDEPENDENTLY of the handler: the fills
 * were pulled from Ethereum mainnet via HyperSync, and each one's seller/buyer
 * was confirmed against the ERC-721 Transfer emitted in the same transaction.
 * 16 of 16 agreed.
 *
 * Six of the sixteen settle through Blur Blend (0x29469395…), Blur's lending
 * escrow. There the Transfer shows seller→Blend rather than seller→buyer,
 * because the NFT is collateral for the duration of the loan. The economic
 * buyer is still the transaction sender, which is what this asserts — and it is
 * why Blend is registered `custodial: true` so the ERC-721 lane does not credit
 * it as a holder.
 *
 * Fixture: test/fixtures/blur-v2-fills.json (captured 2026-07-31, blocks
 * ~25.60M–25.61M). Regenerate by pulling Execution721Packed logs with their
 * transaction `from`, then cross-checking each against its ERC-721 Transfer.
 */
import { readFileSync } from "node:fs";
import { describe, it, expect, vi, beforeEach } from "vitest";

// The fixtures here are real captured fills for collections the lean MVP
// registry no longer tracks (2026-08-05 Berachain-only cut). These tests prove
// DECODE correctness against chain truth, not eligibility, so trackedness is
// stubbed true; eligibility is contract-registry.test.ts's job.
vi.mock("../src/registry/contracts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/registry/contracts")>();
  return { ...actual, isTrackedContract: () => true };
});


const { captured } = vi.hoisted(() => ({
  captured: { handler: null as null | ((arg: unknown) => Promise<void>) },
}));

vi.mock("envio", () => ({
  indexer: {
    onEvent: (id: { contract?: string; event?: string }, cb: (arg: unknown) => Promise<void>) => {
      if (id?.contract === "BlurV2" && id?.event === "Execution721Packed") captured.handler = cb;
    },
    contractRegister: () => {},
    onBlock: () => {},
    onSlot: () => {},
  },
}));

interface Fill {
  block_number: number;
  log_index: number;
  transaction_hash: string;
  src: string;
  tokenIdListingIndexTrader: string;
  collectionPriceSide: string;
  txFrom: string;
  expect: {
    seller: string;
    buyer: string;
    collection: string;
    tokenId: string;
    amountPaid: string;
    viaBlend: boolean;
  };
}

const FILLS: Fill[] = JSON.parse(readFileSync("test/fixtures/blur-v2-fills.json", "utf8"));

/** Rebuild the event exactly as envio delivers it. */
function toEvent(f: Fill) {
  return {
    srcAddress: f.src,
    chainId: 1,
    logIndex: f.log_index,
    params: {
      orderHash: "0x" + "0".repeat(64),
      tokenIdListingIndexTrader: BigInt(f.tokenIdListingIndexTrader),
      collectionPriceSide: BigInt(f.collectionPriceSide),
    },
    block: { timestamp: 1_750_000_000, number: f.block_number },
    transaction: { hash: f.transaction_hash, from: f.txFrom },
  };
}

function run(f: Fill) {
  const rows: Record<string, any>[] = [];
  const context = { MintActivity: { set: (r: Record<string, any>) => rows.push(r) } };
  return captured.handler!({ event: toEvent(f), context }).then(() => rows);
}

describe("Blur v2 decoder — replayed against real mainnet fills", () => {
  beforeEach(async () => {
    captured.handler = null;
    vi.resetModules();
    await import("../src/handlers/marketplaces/blur-v2");
    expect(captured.handler, "handler did not self-register").not.toBeNull();
  });

  it("has a non-trivial corpus covering both sides of the trade", () => {
    expect(FILLS.length).toBeGreaterThanOrEqual(10);
    const sides = new Set(FILLS.map((f) => BigInt(f.collectionPriceSide) >> 248n));
    expect(sides.size, "fixture must exercise side=0 AND side=1").toBe(2);
    expect(FILLS.some((f) => f.expect.viaBlend), "must cover Blend-mediated fills").toBe(true);
  });

  it("recovers the collection, tokenId and price the chain recorded", async () => {
    for (const f of FILLS) {
      const rows = await run(f);
      expect(rows.length, `no rows for ${f.transaction_hash}`).toBe(2);
      for (const r of rows) {
        expect(r.contract).toBe(f.expect.collection);
        expect(String(r.tokenId)).toBe(f.expect.tokenId);
        expect(String(r.amountPaid)).toBe(f.expect.amountPaid);
        expect(r.tokenStandard).toBe("ERC721");
        expect(String(r.quantity)).toBe("1");
      }
    }
  });

  it("names the seller and buyer the on-chain Transfer confirms", async () => {
    for (const f of FILLS) {
      const rows = await run(f);
      const sale = rows.find((r) => r.activityType === "SALE");
      const purchase = rows.find((r) => r.activityType === "PURCHASE");
      expect(sale!.user, `SALE user for ${f.transaction_hash}`).toBe(f.expect.seller);
      expect(purchase!.user, `PURCHASE user for ${f.transaction_hash}`).toBe(f.expect.buyer);
    }
  });

  it("reads the counterparty from the transaction sender, per side", async () => {
    // side 0 → the packed trader SOLD, so tx.from bought.
    // side 1 → the packed trader BOUGHT, so tx.from sold.
    for (const f of FILLS) {
      const side = BigInt(f.collectionPriceSide) >> 248n;
      const rows = await run(f);
      const sale = rows.find((r) => r.activityType === "SALE")!;
      const purchase = rows.find((r) => r.activityType === "PURCHASE")!;
      if (side === 0n) expect(purchase.user).toBe(f.txFrom.toLowerCase());
      else expect(sale.user).toBe(f.txFrom.toLowerCase());
    }
  });

  it("attributes the operator to the emitting exchange", async () => {
    for (const f of FILLS) {
      for (const r of await run(f)) expect(r.operator).toBe(f.src.toLowerCase());
    }
  });

  it("prices every fill in native ETH terms", async () => {
    // Blur v2 settles in ETH or Blur Pool (BETH, 1:1), and the packed log carries
    // no currency — so the zero address is recorded rather than a guess.
    for (const f of FILLS) {
      for (const r of await run(f)) {
        expect(r.paymentToken).toBe("0x0000000000000000000000000000000000000000");
        expect(BigInt(r.amountPaid)).toBeGreaterThan(0n);
      }
    }
  });

  it("gives every emitted row a unique id across the whole corpus", async () => {
    const ids = new Set<string>();
    let n = 0;
    for (const f of FILLS) {
      for (const r of await run(f)) {
        ids.add(r.id);
        n += 1;
      }
    }
    expect(ids.size).toBe(n);
  });

  it("never names the same wallet on both sides", async () => {
    for (const f of FILLS) {
      const rows = await run(f);
      expect(rows[0].user).not.toBe(rows[1].user);
    }
  });
});
