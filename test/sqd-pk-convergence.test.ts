/**
 * T-1: PK Convergence Test — asserts that decodeSqdBlocks + eventId() produces byte-identical
 * PKs to parseHeliusTx and warehouse mapRows for the same on-chain event.
 *
 * Lane pairs:
 *   SQD ↔ Warehouse: shapes S-1 (transfer), S-2 (mint), S-3 (burn), S-4 (multi-hop)
 *   SQD ↔ Helius: shapes S-1, S-2, S-3
 *
 * instructionIndex algorithm (canonical form): per-(tx,mint) occurrence ordinal in
 * (slot asc, txIndex asc, balanceDiff order) order, starting from 0.
 * Zero external dependencies — runs unconditionally in CI.
 */
import { describe, expect, it } from "vitest";
import { decodeSqdBlocks, type SqdBlock } from "../src/svm/sqd-collection-event-source";
import { eventId } from "../src/svm/collection-event-writer";
import { parseHeliusTx, type HeliusParsedTx } from "../src/svm/collection-event-source";
import { validateRow, mapRows, type WarehouseRow } from "../src/svm/warehouse-loader";

// ── Stable base58 addresses ──────────────────────────────────────────────────
const MINT_S1 = "J1S9H3QjnRtBbbuD4HjPV6RpRhwuk4zKbxsnCHuTgh9w"; // transfer shape
const MINT_S2 = "6mszaj17KSfVqADrQj3o4W3zoLMTykgmV37W4QadCczK"; // mint shape
const MINT_S3 = "SMBtHCCC6RYRutFEPb4gZqeBLUZbMNhRKaMKZZLHi7W"; // burn shape
const MINT_S4 = "6XxjKYFbcndh2gDcsUrmZgVEsoDxXMnfsaGY6fpTJzNr"; // multi-hop shape

const ALICE = "BUjZjAS2vbbb65g7Z1Ca9ZRVYoJscURG5L3AkVvHP9ac";
const BOB   = "4mKSoDDqApmF1DqXvVTSL6tu2zixrSSNjqMxUnwvVzy2";
const CAROL = "HF6SFg5RkWNQrEhmnXV7H8EmLPxg3jDaggEni1SMVAi6";

const ACC1 = "2gxanuBRcWieT3Y6ko5dYkFE3LsJK7XzX9EdJDGtYrCj";
const ACC2 = "9QcQnXF9AtixPDzQQvgt7NmWNgqjY6JttstqADzfcASW";

// Signatures — tx_id just needs length >= 32 for warehouse; SQD uses as-is
const SIG_S1 = "sig-s1-transfer-000000000000000000000000000001";
const SIG_S2 = "sig-s2-mint-0000000000000000000000000000000002";
const SIG_S3 = "sig-s3-burn-000000000000000000000000000000003";
const SIG_S4 = "sig-s4-multihop-00000000000000000000000000004";

// ── SQD block fixtures ────────────────────────────────────────────────────────

const SQD_S1: SqdBlock = {
  header: { number: 100, timestamp: 1000000 },
  transactions: [{ transactionIndex: 0, signatures: [SIG_S1] }],
  tokenBalances: [
    // losing leg: ALICE gives up MINT_S1
    { transactionIndex: 0, account: ACC1, preMint: MINT_S1, postMint: MINT_S1, preOwner: ALICE, postOwner: ALICE, preAmount: "1", postAmount: "0" },
    // gaining leg: BOB receives MINT_S1
    { transactionIndex: 0, account: ACC2, preMint: MINT_S1, postMint: MINT_S1, preOwner: BOB, postOwner: BOB, preAmount: "0", postAmount: "1" },
  ],
};

const SQD_S2: SqdBlock = {
  header: { number: 200, timestamp: 2000000 },
  transactions: [{ transactionIndex: 0, signatures: [SIG_S2] }],
  tokenBalances: [
    // gaining only — mint absent from seenMints → classified as mint
    { transactionIndex: 0, account: ACC1, preMint: MINT_S2, postMint: MINT_S2, preOwner: BOB, postOwner: BOB, preAmount: "0", postAmount: "1" },
  ],
};

const SQD_S3: SqdBlock = {
  header: { number: 300, timestamp: 3000000 },
  transactions: [{ transactionIndex: 0, signatures: [SIG_S3] }],
  tokenBalances: [
    // losing only — burn
    { transactionIndex: 0, account: ACC1, preMint: MINT_S3, postMint: MINT_S3, preOwner: ALICE, postOwner: ALICE, preAmount: "1", postAmount: "0" },
  ],
};

// S-4: 2 losing + 2 gaining in row order → multi-hop net custody: ALICE → BOB via CAROL
const SQD_S4: SqdBlock = {
  header: { number: 400, timestamp: 4000000 },
  transactions: [{ transactionIndex: 0, signatures: [SIG_S4] }],
  tokenBalances: [
    // losing[0] = ALICE → netFrom = ALICE
    { transactionIndex: 0, account: ACC1,  preMint: MINT_S4, postMint: MINT_S4, preOwner: ALICE, postOwner: ALICE, preAmount: "1", postAmount: "0" },
    // gaining[0] = CAROL (intermediate)
    { transactionIndex: 0, account: ACC2,  preMint: MINT_S4, postMint: MINT_S4, preOwner: CAROL, postOwner: CAROL, preAmount: "0", postAmount: "1" },
    // losing[1] = CAROL (intermediate)
    { transactionIndex: 0, account: CAROL, preMint: MINT_S4, postMint: MINT_S4, preOwner: CAROL, postOwner: CAROL, preAmount: "1", postAmount: "0" },
    // gaining[last] = BOB → netTo = BOB
    { transactionIndex: 0, account: BOB,   preMint: MINT_S4, postMint: MINT_S4, preOwner: BOB,   postOwner: BOB,   preAmount: "0", postAmount: "1" },
  ],
};

// ── Warehouse row fixtures ────────────────────────────────────────────────────

const WH_S1: WarehouseRow = {
  action: "transfer", block_slot: 100, block_time: "2026-01-01T00:00:00.000Z",
  tx_id: SIG_S1, outer_instruction_index: 0, inner_instruction_index: 0,
  token_mint_address: MINT_S1, from_owner: ALICE, to_owner: BOB,
};

const WH_S2: WarehouseRow = {
  action: "mint", block_slot: 200, block_time: "2026-01-02T00:00:00.000Z",
  tx_id: SIG_S2, outer_instruction_index: 0, inner_instruction_index: 0,
  token_mint_address: MINT_S2, to_owner: BOB,
};

const WH_S3: WarehouseRow = {
  action: "burn", block_slot: 300, block_time: "2026-01-03T00:00:00.000Z",
  tx_id: SIG_S3, outer_instruction_index: 0, inner_instruction_index: 0,
  token_mint_address: MINT_S3, from_owner: ALICE,
};

const WH_S4: WarehouseRow = {
  action: "transfer", block_slot: 400, block_time: "2026-01-04T00:00:00.000Z",
  tx_id: SIG_S4, outer_instruction_index: 0, inner_instruction_index: 0,
  token_mint_address: MINT_S4, from_owner: ALICE, to_owner: BOB,
};

// ── Helius tx fixtures ────────────────────────────────────────────────────────

const HELIUS_S1: HeliusParsedTx = {
  signature: SIG_S1, slot: 100, timestamp: 1000000, type: "TRANSFER",
  tokenTransfers: [{ mint: MINT_S1, fromUserAccount: ALICE, toUserAccount: BOB, tokenStandard: "NonFungible" }],
};

const HELIUS_S2: HeliusParsedTx = {
  signature: SIG_S2, slot: 200, timestamp: 2000000, type: "NFT_MINT",
  tokenTransfers: [{ mint: MINT_S2, toUserAccount: BOB, tokenStandard: "NonFungible" }],
};

const HELIUS_S3: HeliusParsedTx = {
  signature: SIG_S3, slot: 300, timestamp: 3000000, type: "NFT_BURN",
  tokenTransfers: [{ mint: MINT_S3, fromUserAccount: ALICE, tokenStandard: "NonFungible" }],
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function warehouseEvents(rows: WarehouseRow[]) {
  const valid = rows.map(validateRow).filter((r): r is NonNullable<typeof r> => r !== null);
  return mapRows(valid);
}

function sqdEvents(block: SqdBlock, mint: string) {
  const { events } = decodeSqdBlocks([block], new Set([mint]), new Set<string>());
  return events;
}

// ── SQD ↔ Warehouse ───────────────────────────────────────────────────────────

describe("PK convergence: SQD ↔ Warehouse", () => {
  it("S-1 transfer: eventId byte-identical", () => {
    const sqd = sqdEvents(SQD_S1, MINT_S1);
    const wh = warehouseEvents([WH_S1]);
    expect(sqd).toHaveLength(1);
    expect(wh).toHaveLength(1);
    expect(eventId(sqd[0])).toBe(eventId(wh[0]));
  });

  it("S-2 mint: eventId byte-identical", () => {
    const sqd = sqdEvents(SQD_S2, MINT_S2);
    const wh = warehouseEvents([WH_S2]);
    expect(sqd).toHaveLength(1);
    expect(wh).toHaveLength(1);
    expect(eventId(sqd[0])).toBe(eventId(wh[0]));
  });

  it("S-3 burn: eventId byte-identical", () => {
    const sqd = sqdEvents(SQD_S3, MINT_S3);
    const wh = warehouseEvents([WH_S3]);
    expect(sqd).toHaveLength(1);
    expect(wh).toHaveLength(1);
    expect(eventId(sqd[0])).toBe(eventId(wh[0]));
  });

  it("S-4 multi-hop: eventId byte-identical with explicit instructionIndex equality", () => {
    const sqd = sqdEvents(SQD_S4, MINT_S4);
    const wh = warehouseEvents([WH_S4]);
    expect(sqd).toHaveLength(1);
    expect(wh).toHaveLength(1);
    // Explicit instructionIndex equality (not just full eventId)
    expect(sqd[0].instructionIndex).toBe(0);
    expect(wh[0].instructionIndex).toBe(0);
    expect(sqd[0].instructionIndex).toBe(wh[0].instructionIndex);
    // Full eventId equality
    expect(eventId(sqd[0])).toBe(eventId(wh[0]));
  });
});

// ── SQD ↔ Helius ──────────────────────────────────────────────────────────────

describe("PK convergence: SQD ↔ Helius", () => {
  it("S-1 transfer: eventId byte-identical", () => {
    const sqd = sqdEvents(SQD_S1, MINT_S1);
    const helius = parseHeliusTx(HELIUS_S1, (m) => m === MINT_S1);
    expect(sqd).toHaveLength(1);
    expect(helius).toHaveLength(1);
    expect(eventId(sqd[0])).toBe(eventId(helius[0]));
  });

  it("S-2 mint: eventId byte-identical", () => {
    const sqd = sqdEvents(SQD_S2, MINT_S2);
    const helius = parseHeliusTx(HELIUS_S2, (m) => m === MINT_S2);
    expect(sqd).toHaveLength(1);
    expect(helius).toHaveLength(1);
    expect(eventId(sqd[0])).toBe(eventId(helius[0]));
  });

  it("S-3 burn: eventId byte-identical", () => {
    const sqd = sqdEvents(SQD_S3, MINT_S3);
    const helius = parseHeliusTx(HELIUS_S3, (m) => m === MINT_S3);
    expect(sqd).toHaveLength(1);
    expect(helius).toHaveLength(1);
    expect(eventId(sqd[0])).toBe(eventId(helius[0]));
  });
});
