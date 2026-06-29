// ponder-runtime/src/lib/checkpoint-block.test.ts
//
// bd-3nh (S2) — pins the `scripts/chain-metadata-view.sql` substring offset to
// Ponder's checkpoint encoding. If Ponder ever re-orders / re-widths checkpoint
// fields, these assertions break loudly instead of the view silently extracting
// the wrong block number into inventory's ACVP `as_of_block`.

import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CHECKPOINT_LENGTH,
  BLOCK_NUMBER_SQL_FROM,
  BLOCK_NUMBER_SQL_FOR,
  BLOCK_TIMESTAMP_DIGITS,
  CHAIN_ID_DIGITS,
  extractLatestProcessedBlock,
} from "./checkpoint-block";

/**
 * Independent re-implementation of Ponder's encodeCheckpoint
 * (ponder/dist/esm/utils/checkpoint.js) — `ponder` does not export it publicly,
 * so the test builds the 75-char string itself. If this local encoder and the
 * module's offsets ever disagree about where the block number lives, the
 * round-trip assertions below fail.
 */
function encodeCheckpoint(c: {
  blockTimestamp: bigint;
  chainId: bigint;
  blockNumber: bigint;
  transactionIndex: bigint;
  eventType: number;
  eventIndex: bigint;
}): string {
  const pad = (v: bigint | number, n: number) => v.toString().padStart(n, "0");
  return (
    pad(c.blockTimestamp, 10) +
    pad(c.chainId, 16) +
    pad(c.blockNumber, 16) +
    pad(c.transactionIndex, 16) +
    c.eventType.toString() +
    pad(c.eventIndex, 16)
  );
}

const base = {
  blockTimestamp: 1_716_000_000n,
  chainId: 80094n, // Berachain
  blockNumber: 0n,
  transactionIndex: 3n,
  eventType: 5, // blocks
  eventIndex: 7n,
};

describe("checkpoint-block contract (bd-3nh freshness view)", () => {
  it("matches Ponder's 75-char checkpoint width", () => {
    expect(CHECKPOINT_LENGTH).toBe(75);
    expect(encodeCheckpoint(base).length).toBe(75);
  });

  it("pins the SQL substring offset to FROM=27 FOR=16 (1-indexed)", () => {
    // The view hardcodes `substring(latest_checkpoint FROM 27 FOR 16)`. Anyone
    // editing either side must keep them equal.
    expect(BLOCK_NUMBER_SQL_FROM).toBe(27);
    expect(BLOCK_NUMBER_SQL_FOR).toBe(16);
    // 27 must equal (timestamp + chainId widths) + 1.
    expect(BLOCK_NUMBER_SQL_FROM).toBe(BLOCK_TIMESTAMP_DIGITS + CHAIN_ID_DIGITS + 1);
  });

  it("extracts a realistic Berachain block number", () => {
    const cp = encodeCheckpoint({ ...base, blockNumber: 21_700_000n });
    expect(extractLatestProcessedBlock(cp)).toBe(21_700_000);
  });

  it("extracts the highest live chain block (Arbitrum ~227M, < int4 max)", () => {
    const cp = encodeCheckpoint({ ...base, chainId: 42161n, blockNumber: 227_909_621n });
    expect(extractLatestProcessedBlock(cp)).toBe(227_909_621);
    // The view casts to int4; assert we are still comfortably under its ceiling.
    expect(227_909_621).toBeLessThan(2_147_483_647);
  });

  it("extracts 0 from the zero checkpoint (chain not yet advanced)", () => {
    const cp = encodeCheckpoint({
      blockTimestamp: 0n,
      chainId: 0n,
      blockNumber: 0n,
      transactionIndex: 0n,
      eventType: 0,
      eventIndex: 0n,
    });
    expect(extractLatestProcessedBlock(cp)).toBe(0);
  });

  it("does not let the chainId slice bleed into the block number", () => {
    // A large chainId must NOT shift or contaminate the block-number window.
    const cp = encodeCheckpoint({ ...base, chainId: 7_777_777n, blockNumber: 46_395_369n });
    expect(extractLatestProcessedBlock(cp)).toBe(46_395_369);
  });

  it("throws on a malformed (wrong-length) checkpoint", () => {
    expect(() => extractLatestProcessedBlock("123")).toThrow(/malformed checkpoint/);
  });
});

// ── Real-source drift-guard (FAGAN finding 2) ───────────────────────────────
// `encodeCheckpoint` above is a faithful COPY of Ponder's encoder, so on its own
// it can't catch a Ponder layout change — it would drift in lockstep with the
// copy, not with the real source. Ponder's `exports` map blocks importing the
// real encoder (only "." and "./virtual" are exported; a deep subpath OR
// `./package.json` throws ERR_PACKAGE_PATH_NOT_EXPORTED), so we instead READ
// Ponder's real source file and pin our offsets to ITS field widths + concat
// order. If a Ponder bump re-widths or re-orders the checkpoint encoding, this
// block fails BEFORE the SQL view silently extracts the wrong slice.
function readPonderCheckpointSource(): string {
  // Walk up from this test file to the nearest node_modules/ponder (follows the
  // pnpm symlink to the real 0.16.6 source). No import / exports-map dependency.
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, "node_modules/ponder/dist/esm/utils/checkpoint.js");
    if (existsSync(candidate)) return readFileSync(candidate, "utf8");
    dir = dirname(dir);
  }
  throw new Error(
    "drift-guard cannot run: ponder/dist/esm/utils/checkpoint.js not found (ponder moved/upgraded?)",
  );
}

describe("ponder source-pin (real drift-guard — FAGAN finding 2)", () => {
  const src = readPonderCheckpointSource();

  const widthOf = (name: string): number => {
    const m = src.match(new RegExp(`${name}\\s*=\\s*(\\d+)`));
    if (!m) throw new Error(`Ponder source no longer defines ${name} — encoding drift`);
    return Number(m[1]);
  };

  it("reads Ponder's real checkpoint.js source (fails loud if it moved)", () => {
    expect(src).toMatch(/encodeCheckpoint/);
    expect(src).toMatch(/BLOCK_NUMBER_DIGITS/);
  });

  it("Ponder's REAL field widths still match this module's offset constants", () => {
    // The view's FROM=27 = BLOCK_TIMESTAMP_DIGITS + CHAIN_ID_DIGITS + 1; FOR=16 =
    // BLOCK_NUMBER_DIGITS. Pin all three to Ponder's real source, not the copy.
    expect(widthOf("BLOCK_TIMESTAMP_DIGITS")).toBe(BLOCK_TIMESTAMP_DIGITS);
    expect(widthOf("CHAIN_ID_DIGITS")).toBe(CHAIN_ID_DIGITS);
    expect(widthOf("BLOCK_NUMBER_DIGITS")).toBe(BLOCK_NUMBER_SQL_FOR);
    // Independent of the module: the offset's own arithmetic against real widths.
    expect(BLOCK_NUMBER_SQL_FROM).toBe(
      widthOf("BLOCK_TIMESTAMP_DIGITS") + widthOf("CHAIN_ID_DIGITS") + 1,
    );
  });

  it("Ponder still concatenates blockNumber AFTER blockTimestamp (the offset's premise)", () => {
    // FROM=27 assumes encode order timestamp → chainId → blockNumber. Pin that the
    // blockNumber pad appears after the blockTimestamp pad in the real encoder.
    const tsIdx = src.indexOf("blockTimestamp.toString().padStart");
    const blockIdx = src.indexOf("blockNumber.toString().padStart");
    expect(tsIdx).toBeGreaterThan(-1);
    expect(blockIdx).toBeGreaterThan(-1);
    expect(blockIdx).toBeGreaterThan(tsIdx);
  });
});
