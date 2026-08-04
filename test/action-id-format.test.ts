/*
 * action-id-format.test.ts — `Action.id` is a WIRE CONTRACT, not an opaque key.
 *
 * score-api does not read a `logIndex` column, because there isn't one. It parses
 * the log index out of the id:
 *
 *     score-api/src/bronze/belt-gateway-source.ts
 *     export function parseLogIndex(id: string): number | null {
 *       const parts = id.split("_");
 *       if (parts.length < 2) return null;
 *       const n = Number(parts[1]);
 *       return Number.isInteger(n) ? n : null;   // <- silent null
 *     }
 *
 * That makes the id's SHAPE — `<txHash>_<logIndex>[_<suffix>...]` — load-bearing,
 * and nothing else in this repo guards it:
 *
 *   • the 83 other tests assert ids are UNIQUE, never that they are PARSEABLE;
 *   • scripts/verify-belt-contract.mjs introspects the live schema, so it sees
 *     types, not values — an id format change is invisible to it;
 *   • parseLogIndex fails to `null`, not to an exception.
 *
 * So reordering a segment (`<txHash>_<direction>_<logIndex>`) or inserting one
 * ahead of the log index leaves all tests green, CI green, and the daily contract
 * guard green — while score-api silently loses intra-block ordering and falls back
 * to ordering by timestamp alone. That is a MEASURED failure, not a hypothetical:
 * with tied timestamps and no tiebreak, azuki's summed supply came to 12,636
 * against a true 10,000 (see score-api/src/gold/holder-ledger.ts).
 *
 * This file drives the real handlers of all three Action-emitting lanes and runs
 * the CONSUMER'S OWN PARSER over every id they produce. The marketplace lanes are
 * absent on purpose — they write MintActivity only and never call recordAction.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { captured } = vi.hoisted(() => ({
  captured: {
    erc20: null as any,
    erc1155Single: null as any,
    erc1155Batch: null as any,
  },
}));

vi.mock("envio", () => ({
  indexer: {
    onEvent: (id: { contract?: string; event?: string }, cb: any) => {
      if (id?.contract === "TrackedErc20" && id?.event === "Transfer") captured.erc20 = cb;
      if (id?.contract === "TrackedErc1155") {
        if (id.event === "TransferSingle") captured.erc1155Single = cb;
        if (id.event === "TransferBatch") captured.erc1155Batch = cb;
      }
    },
    contractRegister: () => {},
    onBlock: () => {},
    onSlot: () => {},
  },
}));

/**
 * VERBATIM COPY of score-api's parser (src/bronze/belt-gateway-source.ts).
 *
 * Copied rather than imported: the two repos deploy independently, so the point
 * is to pin the shape sonar PROMISES, and a copy makes a drift in either side
 * show up here. If score-api changes this function, change it here in lockstep.
 */
function parseLogIndex(id: string): number | null {
  const parts = id.split("_");
  if (parts.length < 2) return null;
  const n = Number(parts[1]);
  return Number.isInteger(n) ? n : null;
}

/**
 * The assertion every lane below funnels into.
 *
 * Checks all three things the consumer relies on, since any one of them alone
 * can be satisfied by an id that still breaks: the txHash must occupy segment 0
 * whole (it is hex, so it never contains `_` to split on), the log index must be
 * recoverable, and it must be the RIGHT log index — not merely some integer.
 */
function expectParseable(actions: readonly any[], txHash: string, logIndex: number) {
  expect(actions.length, "lane emitted no Action to check").toBeGreaterThan(0);
  for (const a of actions) {
    expect(a.id.startsWith(`${txHash}_`), `id ${a.id} must lead with the txHash`).toBe(true);
    expect(parseLogIndex(a.id), `score-api cannot parse a logIndex out of ${a.id}`).not.toBeNull();
    expect(parseLogIndex(a.id), `id ${a.id} carries the wrong logIndex`).toBe(logIndex);
  }
}

const ZERO = "0x0000000000000000000000000000000000000000";
const DEAD = "0x000000000000000000000000000000000000dead";
const ALICE = "0x000000000000000000000000000000000000a11ce";
const BOB = "0x0000000000000000000000000000000000000b0b0";

/* Multi-digit and non-zero on purpose: `0` and `1` are the values a broken
 * implementation is most likely to produce by accident. */
const LOG_INDEX = 47;
const TX = "0xfeedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedface";

describe("Action.id keeps the logIndex where score-api looks for it", () => {
  beforeEach(() => {
    captured.erc20 = null;
    captured.erc1155Single = null;
    captured.erc1155Batch = null;
    vi.resetModules();
    vi.clearAllMocks();
  });

  describe("the ERC-721 lane", () => {
    /* A real registry entry, so the handler takes its tracked path rather than
     * the unknown-contract fallback. */
    const MIBERA = "0x6666397dfe9a8c469bf65dc744cb1c733416c420";
    const BERACHAIN = 80094;

    function ctx() {
      const holders = new Map<string, any>();
      const tokens = new Map<string, any>();
      const actions: any[] = [];
      return {
        isPreload: false,
        actions,
        Action: { set: (a: any) => actions.push(a) },
        TrackedHolder: {
          get: async (id: string) => holders.get(id),
          set: (h: any) => holders.set(h.id, h),
          deleteUnsafe: (id: string) => holders.delete(id),
        },
        Token: {
          get: async (id: string) => tokens.get(id),
          set: (t: any) => tokens.set(t.id, t),
        },
        MintActivity: { set: () => {} },
      };
    }

    const ev = (from: string, to: string, tokenId: bigint) => ({
      srcAddress: MIBERA,
      chainId: BERACHAIN,
      logIndex: LOG_INDEX,
      params: { from, to, tokenId },
      transaction: { hash: TX, transactionIndex: 4 },
      block: { timestamp: 1_750_000_000, number: 5_000_000 },
    });

    /* Each case exercises a different id-building path: mint/burn/transfer take
     * recordAction's DEFAULT id (`<txHash>_<logIndex>`), while the hold721 rows
     * build an explicit `<txHash>_<logIndex>_<direction>`. */
    it.each([
      ["a mint", ZERO, ALICE],
      ["a wallet-to-wallet transfer", ALICE, BOB],
      ["a burn", ALICE, DEAD],
    ])("stays parseable through %s", async (_label, from, to) => {
      const { handleTrackedErc721Transfer } = await import("../src/handlers/tracked-erc721");
      const c = ctx();
      await handleTrackedErc721Transfer(ev(from, to, 42n) as any, c as any);
      expectParseable(c.actions, TX, LOG_INDEX);
    });

    it("emits both a default-id row and an explicit hold721 id from one event", async () => {
      // Guards the assumption that BOTH id-building paths are actually covered
      // above — if the lane stopped emitting one, the cases would still pass.
      const { handleTrackedErc721Transfer } = await import("../src/handlers/tracked-erc721");
      const c = ctx();
      await handleTrackedErc721Transfer(ev(ZERO, ALICE, 42n) as any, c as any);
      const ids = c.actions.map((a) => a.id);
      expect(ids).toContain(`${TX}_${LOG_INDEX}`);
      expect(ids.some((id: string) => id === `${TX}_${LOG_INDEX}_in`)).toBe(true);
    });
  });

  describe("the ERC-1155 lane", () => {
    const CONTRACT = "0x00000000000000000000000000000000000c1155";

    function ctx() {
      const store = new Map<string, any>();
      const actions: any[] = [];
      return {
        isPreload: false,
        actions,
        TrackedHolder1155: {
          get: async (id: string) => store.get(id),
          set: (r: any) => store.set(r.id, r),
          deleteUnsafe: (id: string) => store.delete(id),
        },
        Action: { set: (a: any) => actions.push(a) },
      };
    }

    const base = {
      srcAddress: CONTRACT,
      chainId: 8453,
      logIndex: LOG_INDEX,
      transaction: { hash: TX, transactionIndex: 3 },
      block: { timestamp: 1_750_000_000, number: 1_000_000 },
    };

    it("stays parseable through a TransferSingle", async () => {
      await import("../src/handlers/tracked-erc1155");
      const c = ctx();
      await captured.erc1155Single({
        event: { ...base, params: { operator: ZERO, from: ZERO, to: ALICE, id: 7n, value: 3n } },
        context: c,
      });
      expectParseable(c.actions, TX, LOG_INDEX);
    });

    it("stays parseable through a multi-token TransferBatch", async () => {
      // The batch path appends a per-token `seq` segment. That segment sits
      // AFTER the log index and must stay there — a fold that put `seq` first
      // would make every batch row parse as the sequence number instead.
      await import("../src/handlers/tracked-erc1155");
      const c = ctx();
      await captured.erc1155Batch({
        event: {
          ...base,
          params: { operator: ZERO, from: ZERO, to: ALICE, ids: [7n, 8n, 9n], values: [1n, 2n, 3n] },
        },
        context: c,
      });
      expect(c.actions.length).toBeGreaterThan(3);
      expectParseable(c.actions, TX, LOG_INDEX);
    });
  });

  describe("the ERC-20 lane", () => {
    const TOKEN = "0x0000000000000000000000000000000000erc020";

    function ctx() {
      const store = new Map<string, any>();
      const actions: any[] = [];
      return {
        isPreload: false,
        actions,
        TrackedTokenBalance: {
          get: async (id: string) => store.get(id),
          set: (r: any) => store.set(r.id, r),
          deleteUnsafe: (id: string) => store.delete(id),
        },
        Action: { set: (a: any) => actions.push(a) },
      };
    }

    const ev = (from: string, to: string, value: bigint) => ({
      srcAddress: TOKEN,
      chainId: 1,
      logIndex: LOG_INDEX,
      params: { from, to, value },
      block: { timestamp: 1_750_000_000, number: 2_000_000 },
      transaction: { hash: TX, transactionIndex: 9 },
    });

    it.each([
      ["a mint", ZERO, ALICE],
      ["a transfer", ALICE, BOB],
      ["a burn", ALICE, DEAD],
    ])("stays parseable through %s", async (_label, from, to) => {
      await import("../src/handlers/tracked-erc20");
      const c = ctx();
      await captured.erc20({ event: ev(from, to, 1000n), context: c });
      expectParseable(c.actions, TX, LOG_INDEX);
    });
  });
});

describe("recordAction's default id is the shape the consumer parses", () => {
  /*
   * The lanes above cover the ids that exist today. This covers the id a lane
   * written TOMORROW gets for free — recordAction's fallback when no explicit id
   * is passed. A new lane that omits `id` must land on the contract by default,
   * not by its author having read this file.
   */
  it("builds `<txHash>_<logIndex>` when no explicit id is given", async () => {
    vi.resetModules();
    const { recordAction } = await import("../src/lib/actions");
    const actions: any[] = [];
    recordAction({ Action: { set: (a: any) => actions.push(a) } } as any, {
      actionType: "hypothetical",
      actor: ALICE,
      timestamp: 1_750_000_000n,
      chainId: 1,
      txHash: TX,
      logIndex: LOG_INDEX,
    });
    expect(actions[0].id).toBe(`${TX}_${LOG_INDEX}`);
    expect(parseLogIndex(actions[0].id)).toBe(LOG_INDEX);
  });

  it("refuses to build an id it cannot make parseable", async () => {
    // No id and no logIndex must THROW rather than silently emit a row score-api
    // will read as unordered. Failing loud at write time is the whole guard.
    vi.resetModules();
    const { recordAction } = await import("../src/lib/actions");
    expect(() =>
      recordAction({ Action: { set: () => {} } } as any, {
        actionType: "hypothetical",
        actor: ALICE,
        timestamp: 1_750_000_000n,
        chainId: 1,
        txHash: TX,
      }),
    ).toThrow(/logIndex/);
  });
});

describe("the parser's failure mode is silent, which is why the above matters", () => {
  /*
   * Not testing our code — pinning the CONSUMER'S behaviour, so the cost of
   * breaking the format is legible right here rather than in a score-api
   * incident. Every one of these is a plausible refactor output.
   */
  it.each([
    ["direction moved ahead of the log index", `${TX}_in_${LOG_INDEX}`],
    ["action type moved ahead of the log index", `${TX}_hold721_${LOG_INDEX}`],
    ["the log index dropped entirely", `${TX}_in`],
    ["the id reduced to the txHash", TX],
  ])("returns null (never throws) when %s", (_label, id) => {
    expect(parseLogIndex(id)).toBeNull();
  });
});
