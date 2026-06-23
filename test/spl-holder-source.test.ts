/*
 * spl-holder-source.test.ts — unit coverage for the SVM SPL/Token-2022 holder pipe decoders.
 *
 * Pure-function tests (no RPC): the token-account / mint decoders, holder aggregation, and the
 * snapshot→Hasura row mapping. The load-bearing case is parsing a Token-2022 account whose length
 * exceeds 165 bytes (extensions) — the Pythians mint (7C9…pump) is Token-2022 — proving the base
 * field offsets (mint@0, owner@32, amount@64) are length-agnostic.
 */
import { describe, it, expect } from "vitest";
import { PublicKey } from "@solana/web3.js";
import {
  parseTokenAccount,
  decodeMintDecimals,
  aggregateByOwner,
  type HolderSnapshot,
} from "../src/svm/spl-holder-source";
import { toRows } from "../src/svm/pump-fun-indexer";

const MINT = new PublicKey("So11111111111111111111111111111111111111112"); // wSOL (a valid 32-byte pubkey)
const OWNER = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");

function makeTokenAccount(len: number, amount: bigint): Buffer {
  const buf = Buffer.alloc(len); // extension bytes (if len>165) stay zero — ignored by the decoder
  MINT.toBuffer().copy(buf, 0); // mint @ [0,32)
  OWNER.toBuffer().copy(buf, 32); // owner @ [32,64)
  buf.writeBigUInt64LE(amount, 64); // amount u64 LE @ [64,72)
  return buf;
}

describe("parseTokenAccount", () => {
  it("decodes a classic 165-byte token account", () => {
    const out = parseTokenAccount(makeTokenAccount(165, 42n));
    expect(out.mint).toBe(MINT.toBase58());
    expect(out.owner).toBe(OWNER.toBase58());
    expect(out.amountRaw).toBe(42n);
  });

  it("decodes a Token-2022 account longer than 165 bytes (extensions ignored)", () => {
    const out = parseTokenAccount(makeTokenAccount(300, 18_446_744_073_709_551_615n)); // u64 max
    expect(out.mint).toBe(MINT.toBase58());
    expect(out.owner).toBe(OWNER.toBase58());
    expect(out.amountRaw).toBe(18_446_744_073_709_551_615n);
  });

  it("rejects a too-short buffer", () => {
    expect(() => parseTokenAccount(Buffer.alloc(60))).toThrow(/too short/);
  });
});

describe("decodeMintDecimals", () => {
  it("reads decimals from byte 44 (classic 82-byte mint)", () => {
    const mint = Buffer.alloc(82);
    mint[44] = 6;
    expect(decodeMintDecimals(mint)).toBe(6);
  });

  it("reads decimals from a Token-2022 mint with extensions (len 414)", () => {
    const mint = Buffer.alloc(414);
    mint[44] = 9;
    expect(decodeMintDecimals(mint)).toBe(9);
  });
});

describe("aggregateByOwner", () => {
  it("sums multiple accounts per owner, drops zero, sorts descending", () => {
    const out = aggregateByOwner([
      { owner: "A", amountRaw: 10n },
      { owner: "B", amountRaw: 5n },
      { owner: "A", amountRaw: 3n },
      { owner: "C", amountRaw: 0n }, // dropped
    ]);
    expect(out).toEqual([
      { owner: "A", amountRaw: 13n },
      { owner: "B", amountRaw: 5n },
    ]);
  });

  it("returns empty for no holders", () => {
    expect(aggregateByOwner([])).toEqual([]);
  });
});

describe("toRows", () => {
  it("maps a snapshot to Hasura rows keyed on <collection>:<owner>", () => {
    const snap: HolderSnapshot = {
      mint: MINT.toBase58(),
      program: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
      decimals: 6,
      slot: 100,
      source: "rpc",
      holders: [{ owner: "Alice", amountRaw: 18_446_744_073_709_551_615n }],
    };
    const rows = toRows(snap, "pythians", "2026-06-23T00:00:00.000Z");
    expect(rows).toEqual([
      {
        id: "pythians:Alice",
        collection_key: "pythians",
        mint: MINT.toBase58(),
        owner: "Alice",
        amount_raw: "18446744073709551615", // u64 max preserved as string (no float loss)
        decimals: 6,
        slot: 100,
        source: "rpc",
        updated_at: "2026-06-23T00:00:00.000Z",
      },
    ]);
  });
});
