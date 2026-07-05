import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import {
  BELT_CONTRACTS,
  extractChainContractRef,
} from "../scripts/verify-belt-config.js";
import {
  TRACKED_ERC721_COLLECTION_KEYS,
  TRANSFER_TRACKED_COLLECTIONS,
} from "../src/handlers/tracked-erc721/constants";

/**
 * Base community-onboarding batch 1 (top-10 ramp, #121). Deploy blocks verified
 * on-chain via eth_getCode binary search 2026-07-05 — the Azuki lesson (#118/#120):
 * an address without start_block + belt coverage is a silent zero-holder bug.
 */
const BATCH: ReadonlyArray<{ address: string; key: string; deployBlock: number }> = [
  { address: "0xcb28749c24af4797808364d71d71539bc01e76d4", key: "based_punks", deployBlock: 12774442 },
  { address: "0x3319197b0d0f8ccd1087f2d2e47a8fb7c0710171", key: "hypio", deployBlock: 24834458 },
  { address: "0xee7d1b184be8185adc7052635329152a4d0cdefa", key: "kemonokaki", deployBlock: 16046941 },
  { address: "0x699727f9e01a822efdcf7333073f0461e5914b4e", key: "warplets", deployBlock: 37366750 },
  { address: "0x1260f90e0b1c482b38b88f26dee17c57615d670b", key: "lil_bangers", deployBlock: 33642811 },
  { address: "0x9e7a06c281355f60570e47a12650c89fe1d36ff3", key: "based_onchain_punks", deployBlock: 2883449 },
  { address: "0x95bc4c2e01c2e2d9e537e7a9fe58187e88dd8019", key: "nodes_by_hunter", deployBlock: 33916538 },
  { address: "0x20fd75eccd7bb9c4eb9e3bb4c09c6b382e15d63e", key: "veecon_2024_tickets", deployBlock: 14459222 },
];
const EARLIEST_DEPLOY = Math.min(...BATCH.map((b) => b.deployBlock));

const monoText = readFileSync("config.yaml", "utf8");
const beltText = readFileSync("config.mibera.yaml", "utf8");

describe("Base TrackedErc721 batch 1 (community onboarding, #121)", () => {
  it("registers all 8 addresses on chain 8453 under TrackedErc721 in config.yaml", () => {
    const ref = extractChainContractRef(monoText, 8453, "TrackedErc721");
    expect(ref).not.toBeNull();
    const addrs = ref!.address.map((a: string) => a.toLowerCase());
    for (const { address } of BATCH) expect(addrs).toContain(address);
    expect(addrs).toHaveLength(BATCH.length);
  });

  it("sets start_block to the batch's earliest deploy block (full history, no chain-floor scan gap)", () => {
    const ref = extractChainContractRef(monoText, 8453, "TrackedErc721");
    expect(ref!.startBlock).toBe(String(EARLIEST_DEPLOY));
  });

  it("maps every address to a collectionKey in TRACKED_ERC721_COLLECTION_KEYS", () => {
    for (const { address, key } of BATCH) {
      expect(TRACKED_ERC721_COLLECTION_KEYS[address]).toBe(key);
    }
  });

  it("opts every batch collection into transfer tracking (scoring consumes activity)", () => {
    for (const { key } of BATCH) {
      expect(TRANSFER_TRACKED_COLLECTIONS.has(key)).toBe(true);
    }
  });

  it("covers chain-8453 TrackedErc721 in BELT_CONTRACTS so the belt gate catches drift", () => {
    expect(
      BELT_CONTRACTS.some((c) => c.name === "TrackedErc721" && c.chainId === 8453),
    ).toBe(true);
  });

  it("keeps config.mibera.yaml field-identical to config.yaml for the 8453 binding", () => {
    const beltRef = extractChainContractRef(beltText, 8453, "TrackedErc721");
    const monoRef = extractChainContractRef(monoText, 8453, "TrackedErc721");
    expect(beltRef).toEqual(monoRef);
  });
});
