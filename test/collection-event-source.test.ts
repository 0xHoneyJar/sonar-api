/*
 * collection-event-source.test.ts — unit coverage for the SVM collection-EVENT pipe (Sprint 1).
 *
 * Pure decode (parseHeliusTx: mint / transfer / burn / sale-behind-escrow / batch / non-member filter /
 * malformed) + the writer's row mapping, PK shape, and batch de-dupe. No live RPC/Hasura.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  parseHeliusTx,
  HeliusCollectionEventSource,
  type HeliusParsedTx,
  type CollectionEvent,
} from "../src/svm/collection-event-source";
import { toRows, dedupeById, eventId } from "../src/svm/collection-event-writer";
import { deriveLatestOwners } from "../src/svm/collection-event-indexer";
import { decodeWebhookPayload } from "../src/svm/collection-event-webhook";

afterEach(() => vi.unstubAllGlobals());

const M1 = "MINT_MEMBER_1";
const M2 = "MINT_MEMBER_2";
const NON = "MINT_NOT_IN_COLLECTION";
const members = new Set([M1, M2]);
const isMember = (m: string) => members.has(m);

const base = (over: Partial<HeliusParsedTx>): HeliusParsedTx => ({
  signature: "SIG1",
  slot: 100,
  timestamp: 1_700_000_000,
  ...over,
});

describe("parseHeliusTx", () => {
  it("decodes a MINT (from null, kind mint) keyed off type NFT_MINT", () => {
    const evs = parseHeliusTx(
      base({ type: "NFT_MINT", tokenTransfers: [{ mint: M1, fromUserAccount: null, toUserAccount: "WALLET" }] }),
      isMember,
    );
    expect(evs).toEqual([
      { nftMint: M1, kind: "mint", from: null, to: "WALLET", instructionIndex: 0, price: null, marketplace: null, slot: 100, blockTime: 1_700_000_000, txSignature: "SIG1" },
    ]);
  });

  it("decodes a TRANSFER (owner-level from/to)", () => {
    const evs = parseHeliusTx(
      base({ type: "TRANSFER", tokenTransfers: [{ mint: M1, fromUserAccount: "ALICE", toUserAccount: "BOB" }] }),
      isMember,
    );
    expect(evs).toMatchObject([{ nftMint: M1, kind: "transfer", from: "ALICE", to: "BOB" }]);
  });

  it("decodes a BURN (to null) keyed off type BURN", () => {
    const evs = parseHeliusTx(
      base({ type: "BURN", tokenTransfers: [{ mint: M1, fromUserAccount: "ALICE", toUserAccount: "INCINERATOR" }] }),
      isMember,
    );
    expect(evs).toMatchObject([{ nftMint: M1, kind: "burn", from: "ALICE", to: null }]);
  });

  it("decodes a SALE from events.nft — resolved seller/buyer/price, NOT the escrow transfer, no double-count", () => {
    const evs = parseHeliusTx(
      base({
        type: "NFT_SALE",
        // raw on-chain leg is escrow→buyer; must NOT be emitted as a transfer
        tokenTransfers: [{ mint: M1, fromUserAccount: "ESCROW_PDA", toUserAccount: "BUYER" }],
        events: { nft: { type: "NFT_SALE", source: "TENSOR", amount: 1_500_000, seller: "SELLER", buyer: "BUYER", nfts: [{ mint: M1 }] } },
      }),
      isMember,
    );
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({
      nftMint: M1,
      kind: "sale",
      from: "SELLER", // resolved, not ESCROW_PDA
      to: "BUYER",
      price: 1_500_000,
      marketplace: "TENSOR",
    });
  });

  it("gives batch-tx legs a PER-MINT index (each first leg = 0) → distinct PKs via distinct mints, filters non-members", () => {
    const evs = parseHeliusTx(
      base({
        type: "TRANSFER",
        tokenTransfers: [
          { mint: M1, fromUserAccount: "A", toUserAccount: "B" },
          { mint: NON, fromUserAccount: "X", toUserAccount: "Y" }, // dropped — not a member
          { mint: M2, fromUserAccount: "C", toUserAccount: "D" },
        ],
      }),
      isMember,
    );
    expect(evs.map((e) => [e.nftMint, e.instructionIndex])).toEqual([
      [M1, 0],
      [M2, 0], // per-mint occurrence (NOT a global ordinal — the C1 fix)
    ]);
    expect(new Set(evs.map(eventId)).size).toBe(2); // distinct PKs (different mints)
  });

  it("C1: PK is intrinsic — a shifted member set / reordered transfers yield IDENTICAL PKs (backfill↔webhook convergence)", () => {
    const tt = [
      { mint: M1, fromUserAccount: "A", toUserAccount: "B" },
      { mint: M2, fromUserAccount: "C", toUserAccount: "D" },
    ];
    // run A: both members; run B: M1 later dropped from the set (e.g. burnt → DAS drops it) + transfers reordered
    const a = parseHeliusTx(base({ type: "TRANSFER", tokenTransfers: tt }), isMember);
    const b = parseHeliusTx(base({ type: "TRANSFER", tokenTransfers: [tt[1], tt[0]] }), (m) => m === M2);
    const pkA = a.find((e) => e.nftMint === M2) && eventId(a.find((e) => e.nftMint === M2)!);
    const pkB = b.find((e) => e.nftMint === M2) && eventId(b.find((e) => e.nftMint === M2)!);
    expect(pkA).toBe("SIG1:MINT_MEMBER_2:0");
    expect(pkB).toBe("SIG1:MINT_MEMBER_2:0"); // unchanged despite M1 dropping out + reorder
  });

  it("H1: a sale bundled with a co-moved member transfer keeps BOTH legs (no early-return drop)", () => {
    const evs = parseHeliusTx(
      base({
        type: "NFT_SALE",
        tokenTransfers: [
          { mint: M1, fromUserAccount: "ESCROW", toUserAccount: "BUYER" }, // the sold NFT's escrow leg → skipped
          { mint: M2, fromUserAccount: "C", toUserAccount: "D" }, // co-moved member → MUST survive
        ],
        events: { nft: { type: "NFT_SALE", source: "TENSOR", amount: 1000, seller: "SELLER", buyer: "BUYER", nfts: [{ mint: M1 }] } },
      }),
      isMember,
    );
    expect(evs).toHaveLength(2);
    expect(evs.find((e) => e.nftMint === M1)).toMatchObject({ kind: "sale", from: "SELLER" });
    expect(evs.find((e) => e.nftMint === M2)).toMatchObject({ kind: "transfer", from: "C", to: "D" }); // survived
  });

  it("H2: a missing/zero block time or slot is SKIPPED, never written as 1970", () => {
    const tt = [{ mint: M1, fromUserAccount: "A", toUserAccount: "B" }];
    expect(parseHeliusTx({ signature: "S", slot: 100, type: "TRANSFER", tokenTransfers: tt }, isMember)).toEqual([]); // timestamp missing
    expect(parseHeliusTx({ signature: "S", slot: 100, timestamp: 0, type: "TRANSFER", tokenTransfers: tt }, isMember)).toEqual([]); // timestamp 0
    expect(parseHeliusTx({ signature: "S", timestamp: 1_700_000_000, type: "TRANSFER", tokenTransfers: tt }, isMember)).toEqual([]); // slot missing
  });

  it("L1: NFT_SALE with no events.nft falls through to a (lossy) transfer leg — preserved, not silently dropped", () => {
    const evs = parseHeliusTx(
      base({ type: "NFT_SALE", tokenTransfers: [{ mint: M1, fromUserAccount: "ESCROW", toUserAccount: "BUYER" }] }),
      isMember,
    );
    expect(evs).toMatchObject([{ nftMint: M1, kind: "transfer", from: "ESCROW", to: "BUYER", price: null }]);
  });

  it("M1: a string-serialized lamport amount is coerced, not nulled", () => {
    const evs = parseHeliusTx(
      base({ type: "NFT_SALE", tokenTransfers: [], events: { nft: { type: "NFT_SALE", source: "ME", amount: "1500000" as unknown as number, seller: "S", buyer: "B", nfts: [{ mint: M1 }] } } }),
      isMember,
    );
    expect(evs[0]).toMatchObject({ kind: "sale", price: 1500000 });
  });

  it("treats an unknown type with a token movement as a plain transfer (safe default)", () => {
    const evs = parseHeliusTx(
      base({ type: "SOME_FUTURE_TYPE", tokenTransfers: [{ mint: M1, fromUserAccount: "A", toUserAccount: "B" }] }),
      isMember,
    );
    expect(evs).toMatchObject([{ nftMint: M1, kind: "transfer" }]);
  });

  it("returns [] for a tx touching no member NFTs", () => {
    expect(parseHeliusTx(base({ type: "TRANSFER", tokenTransfers: [{ mint: NON, fromUserAccount: "X", toUserAccount: "Y" }] }), isMember)).toEqual([]);
  });

  it("returns [] (never throws) on malformed / signature-less input", () => {
    expect(parseHeliusTx(undefined, isMember)).toEqual([]);
    expect(parseHeliusTx({ type: "TRANSFER", tokenTransfers: [{ mint: M1 }] }, isMember)).toEqual([]); // no signature
    expect(parseHeliusTx(base({ type: "TRANSFER" }), isMember)).toEqual([]); // no tokenTransfers
  });
});

describe("collection-event-writer", () => {
  const ev = (over: Partial<CollectionEvent>): CollectionEvent => ({
    nftMint: M1, kind: "transfer", from: "A", to: "B", instructionIndex: 0,
    price: null, marketplace: null, slot: 100, blockTime: 1_700_000_000, txSignature: "SIG1", ...over,
  });

  it("maps an event to a row with the content-addressed PK and ISO block_time", () => {
    const [row] = toRows([ev({})], "pythians", "pyTh", "helius-backfill");
    expect(row).toEqual({
      id: "SIG1:MINT_MEMBER_1:0",
      collection_key: "pythians",
      collection_mint: "pyTh",
      nft_mint: M1,
      kind: "transfer",
      from: "A",
      to: "B",
      instruction_index: 0,
      price: null,
      marketplace: null,
      slot: 100,
      block_time: "2023-11-14T22:13:20.000Z", // 1_700_000_000s → ISO
      tx_signature: "SIG1",
      source: "helius-backfill",
    });
  });

  it("de-dupes a batch by PK id (last write wins) so ON CONFLICT cannot touch a row twice", () => {
    const rows = toRows(
      [ev({ to: "B" }), ev({ to: "B_LATER" }), ev({ instructionIndex: 1, to: "C" })],
      "pythians",
      "pyTh",
    );
    const deduped = dedupeById(rows);
    expect(deduped).toHaveLength(2); // two distinct ids (instr 0 collapses, instr 1 stays)
    expect(deduped.find((r) => r.id === "SIG1:MINT_MEMBER_1:0")?.to).toBe("B_LATER");
  });
});

describe("deriveLatestOwners (reconciliation gate)", () => {
  const e = (over: Partial<CollectionEvent>): CollectionEvent => ({
    nftMint: M1, kind: "transfer", from: null, to: null, instructionIndex: 0,
    price: null, marketplace: null, slot: 0, blockTime: 0, txSignature: "S", ...over,
  });
  it("takes the latest (by slot, then leg) event's `to` as the current owner — out-of-order safe", () => {
    const owners = deriveLatestOwners([
      e({ kind: "mint", slot: 10, to: "W1" }),
      e({ kind: "transfer", slot: 30, from: "W2", to: "W3" }),
      e({ kind: "transfer", slot: 20, from: "W1", to: "W2" }), // arrives out of slot order
    ]);
    expect(owners.get(M1)).toBe("W3");
  });
  it("a burn as the latest event yields a null owner", () => {
    const owners = deriveLatestOwners([
      e({ kind: "mint", slot: 10, to: "W1" }),
      e({ kind: "burn", slot: 20, from: "W1", to: null }),
    ]);
    expect(owners.get(M1)).toBeNull();
  });
  it("F1: two txs in the SAME slot — newest-first stream order wins (not the older tx)", () => {
    // runner streams newest-first per mint: txC (newer) before txB (older), both slot 50.
    const owners = deriveLatestOwners([
      e({ kind: "transfer", slot: 50, txSignature: "txC", from: "B", to: "C" }), // newest
      e({ kind: "transfer", slot: 50, txSignature: "txB", from: "A", to: "B" }), // older, same slot
    ]);
    expect(owners.get(M1)).toBe("C"); // NOT "B" — the pre-fix bug picked the older tx
  });
});

describe("HeliusCollectionEventSource.mintHistory", () => {
  const txPage = (sigs: string[]): HeliusParsedTx[] =>
    sigs.map((signature, i) => ({
      signature, slot: 100 + i, timestamp: 1_700_000_000 + i, type: "TRANSFER",
      tokenTransfers: [{ mint: M1, fromUserAccount: "A", toUserAccount: "B" }],
    }));
  const resp = (status: number, body: unknown, retryAfter?: string) => ({
    ok: status >= 200 && status < 300, status,
    headers: { get: (h: string) => (h.toLowerCase() === "retry-after" ? retryAfter ?? null : null) },
    json: async () => body, text: async () => JSON.stringify(body),
  });

  it("paginates via `before` until a short page, decoding each tx", async () => {
    const full = txPage(Array.from({ length: 100 }, (_, i) => `S${i}`)); // full page → fetch again
    const short = txPage(["LAST"]);
    const fetchMock = vi.fn().mockResolvedValueOnce(resp(200, full)).mockResolvedValueOnce(resp(200, short));
    vi.stubGlobal("fetch", fetchMock);

    const src = new HeliusCollectionEventSource("KEY", "COLL", { paceMs: 0 });
    const evs: CollectionEvent[] = [];
    for await (const ev of src.mintHistory(M1)) evs.push(ev);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(evs).toHaveLength(101); // 100 + 1 transfers
    expect(new URL(fetchMock.mock.calls[1][0] as string).searchParams.get("before")).toBe("S99"); // cursor = last sig
  });

  it("retries on 429 then succeeds (rate-limit backoff, honors Retry-After)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(resp(429, { error: "rate" }, "0.001")) // tiny Retry-After → fast test
      .mockResolvedValueOnce(resp(200, txPage(["ONLY"])));
    vi.stubGlobal("fetch", fetchMock);

    const src = new HeliusCollectionEventSource("KEY", "COLL", { paceMs: 0 });
    const evs: CollectionEvent[] = [];
    for await (const ev of src.mintHistory(M1)) evs.push(ev);

    expect(fetchMock).toHaveBeenCalledTimes(2); // 429 retried, then 200
    expect(evs).toHaveLength(1);
  });

  it("throws immediately on a fatal 4xx (no retry)", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(resp(401, { error: "bad key" }));
    vi.stubGlobal("fetch", fetchMock);
    const src = new HeliusCollectionEventSource("KEY", "COLL", { paceMs: 0 });
    await expect(async () => {
      for await (const _ of src.mintHistory(M1)) void _;
    }).rejects.toThrow(/HTTP 401/);
    expect(fetchMock).toHaveBeenCalledTimes(1); // not retried
  });

  it("throws (fail-loud, not silent-empty) after exhausting retries on persistent 429", async () => {
    const fetchMock = vi.fn().mockResolvedValue(resp(429, { error: "rate" }, "0.001")); // always 429, tiny wait
    vi.stubGlobal("fetch", fetchMock);
    const src = new HeliusCollectionEventSource("KEY", "COLL", { paceMs: 0 });
    await expect(async () => {
      for await (const _ of src.mintHistory(M1)) void _;
    }).rejects.toThrow(/HTTP 429 after \d+ retries/);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1); // retried before giving up
  });
});

describe("decodeWebhookPayload (realtime)", () => {
  it("flat-maps a payload array into member events (mirrors backfill decode), filters non-members", () => {
    const payload = [
      { signature: "S1", slot: 100, timestamp: 1_700_000_000, type: "TRANSFER", tokenTransfers: [{ mint: M1, fromUserAccount: "A", toUserAccount: "B" }] },
      { signature: "S2", slot: 101, timestamp: 1_700_000_001, type: "TRANSFER", tokenTransfers: [{ mint: NON, fromUserAccount: "X", toUserAccount: "Y" }] },
    ];
    const evs = decodeWebhookPayload(payload, isMember);
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({ nftMint: M1, kind: "transfer", txSignature: "S1" });
  });
  it("returns [] for a non-array payload (never throws)", () => {
    expect(decodeWebhookPayload({ not: "an array" }, isMember)).toEqual([]);
    expect(decodeWebhookPayload(null, isMember)).toEqual([]);
  });
});
