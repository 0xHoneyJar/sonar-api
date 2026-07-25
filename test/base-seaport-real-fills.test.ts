/*
 * base-seaport-real-fills.test.ts — the decoder against REAL Base chain data.
 *
 * Every other seaport test uses synthetic fixtures I wrote, which proves the handler
 * does what I think Seaport emits. This one replays 40 genuine OrderFulfilled logs
 * pulled from Base mainnet receipts (2026-07-25) for collections the belt actually
 * tracks, and asserts against expectations computed INDEPENDENTLY from the raw ABI
 * data — not from the handler's own logic.
 *
 * It exists because sprint-bug-190 shipped a decoder that passed every synthetic test
 * and then produced zero rows in production. Synthetic tests cannot catch a decoder
 * that disagrees with the chain; only real logs can.
 *
 * Fixture: test/fixtures/base-seaport-fills.json — captured via
 * eth_getTransactionReceipt against Base mainnet, filtered to single-NFT,
 * single-currency fills for tracked collections. Regenerate with the method in
 * grimoires/loa/context/2026-07-25-marketplace-sale-detection.md §7.
 */
import { readFileSync } from "node:fs";
import { describe, it, expect, vi, beforeEach } from "vitest";

const { captured } = vi.hoisted(() => ({
  captured: { handler: null as null | ((arg: unknown) => Promise<void>) },
}));

vi.mock("envio", () => ({
  indexer: {
    onEvent: (id: { contract?: string; event?: string }, cb: (arg: unknown) => Promise<void>) => {
      if (id?.contract === "Seaport" && id?.event === "OrderFulfilled") captured.handler = cb;
    },
    contractRegister: () => {},
    onBlock: () => {},
    onSlot: () => {},
  },
}));

interface Fill {
  txHash: string;
  logIndex: number;
  srcAddress: string;
  offerer: string;
  recipient: string;
  offer: [number, string, string, string][];
  consideration: [number, string, string, string, string][];
  blockNumber: number;
  expect: {
    collection: string;
    contract: string;
    tokenId: string;
    amountPaid: string;
    paymentToken: string;
  };
}

const FILLS: Fill[] = JSON.parse(
  readFileSync("test/fixtures/base-seaport-fills.json", "utf8"),
);

/** Rebuild the event exactly as envio delivers it: numeric fields as BigInt. */
function toEvent(f: Fill) {
  return {
    srcAddress: f.srcAddress,
    chainId: 8453,
    logIndex: f.logIndex,
    params: {
      offerer: f.offerer,
      recipient: f.recipient,
      offer: f.offer.map(([t, tok, id, amt]) => [t, tok, BigInt(id), BigInt(amt)]),
      consideration: f.consideration.map(([t, tok, id, amt, r]) => [
        t,
        tok,
        BigInt(id),
        BigInt(amt),
        r,
      ]),
    },
    block: { timestamp: 1_750_000_000, number: f.blockNumber },
    transaction: { hash: f.txHash },
  };
}

async function run(f: Fill) {
  const ctx = { MintActivity: { set: vi.fn() } };
  await captured.handler!({ event: toEvent(f), context: ctx });
  return ctx.MintActivity.set.mock.calls.map((c) => c[0] as Record<string, unknown>);
}

beforeEach(async () => {
  captured.handler = null;
  vi.resetModules();
  await import("../src/handlers/seaport");
});

describe("Base Seaport decoder — replayed against real mainnet fills", () => {
  it("has a non-trivial corpus of real fills", () => {
    expect(FILLS.length).toBeGreaterThanOrEqual(20);
  });

  it("emits a SALE + PURCHASE pair for every real fill", async () => {
    for (const f of FILLS) {
      const rows = await run(f);
      expect(
        rows.map((r) => r.activityType).sort(),
        `no rows for real fill ${f.txHash} (${f.expect.collection} #${f.expect.tokenId})`,
      ).toEqual(["PURCHASE", "SALE"]);
    }
  });

  it("recovers contract, tokenId, price and currency matching the chain", async () => {
    for (const f of FILLS) {
      const sale = (await run(f)).find((r) => r.activityType === "SALE")!;
      const where = `${f.expect.collection} #${f.expect.tokenId} (${f.txHash})`;
      expect(sale.contract, `contract mismatch on ${where}`).toBe(f.expect.contract);
      expect(String(sale.tokenId), `tokenId mismatch on ${where}`).toBe(f.expect.tokenId);
      expect(String(sale.amountPaid), `price mismatch on ${where}`).toBe(f.expect.amountPaid);
      expect(sale.paymentToken, `currency mismatch on ${where}`).toBe(f.expect.paymentToken);
    }
  });

  it("attributes the operator to the emitting Seaport contract", async () => {
    for (const f of FILLS) {
      const sale = (await run(f)).find((r) => r.activityType === "SALE")!;
      expect(sale.operator).toBe(f.srcAddress);
      expect(sale.chainId).toBe(8453);
    }
  });

  it("gives every emitted row a unique id across the whole corpus", async () => {
    const ids: string[] = [];
    for (const f of FILLS) ids.push(...(await run(f)).map((r) => String(r.id)));
    expect(new Set(ids).size, "id collision across real fills").toBe(ids.length);
  });

  it("never mistakes buyer for seller — they are always distinct", async () => {
    for (const f of FILLS) {
      const rows = await run(f);
      const sale = rows.find((r) => r.activityType === "SALE")!;
      const buy = rows.find((r) => r.activityType === "PURCHASE")!;
      expect(sale.user).not.toBe(buy.user);
    }
  });
});
