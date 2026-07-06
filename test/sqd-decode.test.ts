import { describe, expect, it } from "vitest";
import { decodeSqdBlocks, validateBalRow, type SqdBlock } from "../src/svm/sqd-collection-event-source";
import { parseHeliusTx } from "../src/svm/collection-event-source";
import { eventId } from "../src/svm/collection-event-writer";

const MINT = "J1S9H3QjnRtBbbuD4HjPV6RpRhwuk4zKbxsnCHuTgh9w";
const ALICE = "BUjZjAS2vbbb65g7Z1Ca9ZRVYoJscURG5L3AkVvHP9ac";
const BOB = "4mKSoDDqApmF1DqXvVTSL6tu2zixrSSNjqMxUnwvVzy2";
const ACC1 = "2gxanuBRcWieT3Y6ko5dYkFE3LsJK7XzX9EdJDGtYrCj";
const ACC2 = "9QcQnXF9AtixPDzQQvgt7NmWNgqjY6JttstqADzfcASW";
const SIG = "5qiEtJtRBzd6b49mcJdzCYHUtqsXqGC5FUX5SixxgVWErpsbqnabYLLQzSXQcqPr3KjeaXWXZ6GMrxvb1xn3Gqkn";
const MEMBERS = new Set([MINT]);

const block = (tokenBalances: SqdBlock["tokenBalances"], over: Partial<SqdBlock> = {}): SqdBlock => ({
  header: { number: 428886218, timestamp: 1782422682 },
  transactions: [{ transactionIndex: 5, signatures: [SIG] }],
  tokenBalances,
  ...over,
});

const losing = { transactionIndex: 5, account: ACC1, preMint: MINT, postMint: MINT, preOwner: ALICE, postOwner: ALICE, preAmount: "1", postAmount: "0" };
const gaining = { transactionIndex: 5, account: ACC2, preMint: MINT, postMint: MINT, preOwner: BOB, postOwner: BOB, preAmount: "0", postAmount: "1" };

describe("decodeSqdBlocks — kinds", () => {
  it("losing+gaining in one tx = transfer with owner-level from/to", () => {
    const { events, ambiguousGroups } = decodeSqdBlocks([block([losing, gaining])], MEMBERS, new Set([MINT]));
    expect(ambiguousGroups).toBe(0);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "transfer", from: ALICE, to: BOB, nftMint: MINT, slot: 428886218 });
  });

  it("gaining-only on a NEVER-seen mint = mint (from=null)", () => {
    const { events } = decodeSqdBlocks([block([gaining])], MEMBERS, new Set());
    expect(events[0]).toMatchObject({ kind: "mint", from: null, to: BOB });
  });

  it("gaining-only on an already-seen mint = AMBIGUOUS (custody arrival we can't source), never a fake mint", () => {
    const { events, ambiguousGroups } = decodeSqdBlocks([block([gaining])], MEMBERS, new Set([MINT]));
    expect(events).toHaveLength(0);
    expect(ambiguousGroups).toBe(1);
  });

  it("losing-only = burn (to=null)", () => {
    const { events } = decodeSqdBlocks([block([losing])], MEMBERS, new Set([MINT]));
    expect(events[0]).toMatchObject({ kind: "burn", to: null, from: ALICE });
  });

  it("multi-hop same-tx nets first-loser → last-gainer", () => {
    const mid = "SMBtHCCC6RYRutFEPb4gZqeBLUZbMNhRKaMKZZLHi7W"; // escrow hop owner
    const hop1lose = { ...losing };
    const hop1gain = { ...gaining, account: ACC2, preOwner: mid, postOwner: mid };
    const hop2lose = { ...losing, account: ACC2, preOwner: mid, postOwner: mid };
    const hop2gain = { ...gaining, account: ACC1, preOwner: BOB, postOwner: BOB };
    const { events } = decodeSqdBlocks([block([hop1lose, hop1gain, hop2lose, hop2gain])], MEMBERS, new Set([MINT]));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "transfer", from: ALICE, to: BOB });
  });

  it("balance rows with no resolvable tx signature are ambiguous, not PK-less events", () => {
    const b = block([losing, gaining], { transactions: [] });
    const { events, ambiguousGroups } = decodeSqdBlocks([b], MEMBERS, new Set([MINT]));
    expect(events).toHaveLength(0);
    expect(ambiguousGroups).toBe(1);
  });
});

describe("PK convergence — the cross-lane contract", () => {
  it("same tx through SQD decode and parseHeliusTx yields the identical eventId", () => {
    const [sqdEvent] = decodeSqdBlocks([block([losing, gaining])], MEMBERS, new Set([MINT])).events;
    const [heliusEvent] = parseHeliusTx(
      { signature: SIG, slot: 428886218, timestamp: 1782422682, type: "TRANSFER",
        tokenTransfers: [{ mint: MINT, fromUserAccount: ALICE, toUserAccount: BOB, tokenStandard: "NonFungible" }] },
      (m) => m === MINT,
    );
    expect(eventId(sqdEvent)).toBe(eventId(heliusEvent));
    expect(sqdEvent.kind).toBe(heliusEvent.kind);
  });
});

describe("validateBalRow — untrusted input", () => {
  it("rejects non-member and malformed rows; nulls bad owners on member rows", () => {
    expect(validateBalRow({ ...losing, preMint: "0xevil", postMint: "0xevil" }, MEMBERS)).toBeNull();
    expect(validateBalRow({ ...losing, account: "not-base58!" }, MEMBERS)).toBeNull();
    expect(validateBalRow({ ...losing, preAmount: "1.5" }, MEMBERS)).toBeNull();
    const v = validateBalRow({ ...losing, preOwner: "??" }, MEMBERS);
    expect(v).not.toBeNull();
    expect(v!.preOwner).toBeNull();
  });
});

/**
 * sprint-bug-189 (bd-k5fh + bd-zyli, BB findings on #140).
 *
 * bd-k5fh: multi-hop net custody picked losing[0]/gaining[last] BY ROW ORDER — Portal
 * row order within a (txIndex,mint) group is not contractually stable, so the same
 * on-chain transfer could decode to different from/to across fetches. Fix: owner-level
 * cancellation (owners that lost minus owners that gained) — intermediaries cancel,
 * order-independent; anything without a unique net pair is honestly ambiguous.
 *
 * bd-zyli: ambiguous groups skipped seenMints.add(mint), so the mint's NEXT appearance
 * could masquerade as a first-appearance "mint" event in a later window.
 */
describe("sprint-bug-189 — order-independent net custody + seenMints on ambiguous", () => {
  const mid = "SMBtHCCC6RYRutFEPb4gZqeBLUZbMNhRKaMKZZLHi7W";
  const hop1lose = { ...losing };
  const hop1gain = { ...gaining, account: ACC2, preOwner: mid, postOwner: mid };
  const hop2lose = { ...losing, account: ACC2, preOwner: mid, postOwner: mid };
  const hop2gain = { ...gaining, account: ACC1, preOwner: BOB, postOwner: BOB };

  it("multi-hop decode is invariant under row order (pre-fix: red)", () => {
    const orders = [
      [hop1lose, hop1gain, hop2lose, hop2gain],
      [hop2gain, hop2lose, hop1gain, hop1lose], // reversed
      [hop2lose, hop1lose, hop2gain, hop1gain], // losers first, mid-loser leading
    ];
    for (const rows of orders) {
      const { events, ambiguousGroups } = decodeSqdBlocks([block(rows)], MEMBERS, new Set([MINT]));
      expect(ambiguousGroups).toBe(0);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ kind: "transfer", from: ALICE, to: BOB });
    }
  });

  it("two net losers → honestly ambiguous (no arbitrary pick)", () => {
    const CAROL = "7Y7yCFtvE4kogLDrrx8bZypqRvA9DkPXFqCK1D8mkE3S";
    const lose2 = { ...losing, account: ACC2, preOwner: CAROL, postOwner: CAROL };
    const { events, ambiguousGroups } = decodeSqdBlocks([block([losing, lose2, gaining])], MEMBERS, new Set([MINT]));
    expect(events).toHaveLength(0);
    expect(ambiguousGroups).toBe(1);
  });

  it("ambiguous group marks the mint SEEN — later gaining-only cannot fake a mint (pre-fix: red)", () => {
    const CAROL = "7Y7yCFtvE4kogLDrrx8bZypqRvA9DkPXFqCK1D8mkE3S";
    const lose2 = { ...losing, account: ACC2, preOwner: CAROL, postOwner: CAROL };
    const ambiguousBlock = block([losing, lose2, gaining]); // 2 net losers → ambiguous
    const laterGainingOnly = block([{ ...gaining, transactionIndex: 7 }], {
      header: { number: 428886300, timestamp: 1782422999 },
      transactions: [{ transactionIndex: 7, signatures: ["3rk9DhbDLQoLDrrx8bZypqRvA9DkPXFqCK1D8mkE3S7Y7yCFtvE4kogqwv55tJj9eFHTxxWEJ7NvKMHM4GnUdX2b"] }],
    });
    const { events, ambiguousGroups } = decodeSqdBlocks([ambiguousBlock, laterGainingOnly], MEMBERS, new Set());
    // pre-fix: the later gaining-only decodes as kind:"mint" (fake first-appearance)
    expect(events.filter((e) => e.kind === "mint")).toHaveLength(0);
    expect(ambiguousGroups).toBe(2);
  });

  it("null-owner rows contribute no custody endpoint — never a transfer with from:null (dissent iter-1)", () => {
    // one losing row with preOwner null + one real gainer + a second gainer (forces multi-hop branch)
    const nullLose = { ...losing, preOwner: null };
    const gain2 = { ...gaining, account: ACC1, preOwner: ALICE, postOwner: ALICE };
    const { events, ambiguousGroups } = decodeSqdBlocks([block([nullLose, gaining, gain2])], MEMBERS, new Set([MINT]));
    expect(events.filter((e) => e.kind === "transfer" && e.from === null)).toHaveLength(0);
    expect(ambiguousGroups).toBe(1);
  });

  it("1:1 transfer with null preOwner endpoint → ambiguous, not from:null (dissent iter-2)", () => {
    const nullLose = { ...losing, preOwner: null };
    const { events, ambiguousGroups } = decodeSqdBlocks([block([nullLose, gaining])], MEMBERS, new Set([MINT]));
    expect(events).toHaveLength(0);
    expect(ambiguousGroups).toBe(1);
  });

  it("1:1 transfer with null postOwner endpoint → ambiguous, not to:null (dissent iter-2)", () => {
    const nullGain = { ...gaining, postOwner: null };
    const { events, ambiguousGroups } = decodeSqdBlocks([block([losing, nullGain])], MEMBERS, new Set([MINT]));
    expect(events).toHaveLength(0);
    expect(ambiguousGroups).toBe(1);
  });
});
