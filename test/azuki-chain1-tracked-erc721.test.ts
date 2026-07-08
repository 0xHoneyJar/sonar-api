import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import {
  BELT_CONTRACTS,
  extractChainContractRef,
  extractContractDefinition,
  verifyBeltConfig,
} from "../scripts/verify-belt-config.js";
import { TRACKED_ERC721_COLLECTION_KEYS } from "../src/handlers/tracked-erc721/constants";

/** Azuki on Ethereum mainnet — a REAL community (promoted from kitchen E2E; #382 key decision).
 *  Uses the CANONICAL Azuki contract (verified Etherscan). Regression guard: the #382 order
 *  fixture carried a corrupted address (0x…dcc93746104133) that indexed 0 events forever; the
 *  "#120 fetch gap" was that bug, not envio. Bound to the dedicated `EthTrackedErc721` contract
 *  (structurally mirrors Milady, a working dedicated single-address ETH contract). */
const AZUKI = {
  chainId: 1,
  contract: "0xed5af388653567af2f388e6224dc7c4b3241c544",
  collectionKey: "azuki",
  contractName: "EthTrackedErc721",
} as const;

const monoText = readFileSync("config.yaml", "utf8");
const beltText = readFileSync("config.mibera.yaml", "utf8");

describe("chain-1 Azuki EthTrackedErc721 (#120 / sprint-bug-192; real community)", () => {
  it("registers Azuki on chain 1 under EthTrackedErc721 (dedicated, NOT the shared TrackedErc721)", () => {
    const ref = extractChainContractRef(
      monoText,
      AZUKI.chainId,
      AZUKI.contractName,
    );
    expect(ref).not.toBeNull();
    expect(ref!.address.map((a) => a.toLowerCase())).toContain(AZUKI.contract);
    // Regression: the shared multi-chain contract must NOT carry Azuki on chain 1.
    expect(
      extractChainContractRef(monoText, AZUKI.chainId, "TrackedErc721"),
    ).toBeNull();
  });

  it("defines EthTrackedErc721 as a top-level contract with the Transfer ABI", () => {
    const def = extractContractDefinition(monoText, "EthTrackedErc721");
    expect(def).not.toBeNull();
    expect(def).toContain(
      "Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
    );
  });

  it("maps the Azuki address to the clean collectionKey `azuki` (real community, #382)", () => {
    expect(TRACKED_ERC721_COLLECTION_KEYS[AZUKI.contract]).toBe("azuki");
  });

  it("inherits the chain-1 floor start_block — no per-contract start_block (mirrors Milady; envio #120)", () => {
    const ref = extractChainContractRef(
      monoText,
      AZUKI.chainId,
      AZUKI.contractName,
    );
    // envio #120 refinement: a single-address contract with a per-contract start_block ABOVE
    // the chain floor is not fetched on chain 1. Milady — the working dedicated single-address
    // control — has none; Azuki now mirrors it exactly. Chain floor 13090020 < Azuki deploy
    // 14162194, so no history is lost.
    expect(ref!.startBlock).toBeNull();
  });

  it("gates EthTrackedErc721 on chain 1 in BELT_CONTRACTS; shared TrackedErc721 stays on OP/Base/Bera", () => {
    expect(
      BELT_CONTRACTS.filter((c) => c.name === "EthTrackedErc721").map(
        (c) => c.chainId,
      ),
    ).toEqual([1]);
    expect(
      BELT_CONTRACTS.filter((c) => c.name === "TrackedErc721")
        .map((c) => c.chainId)
        .sort((a, b) => a - b),
    ).toEqual([10, 8453, 80094]);
  });

  it("keeps config.mibera.yaml field-identical for the chain-1 Azuki binding", () => {
    const beltRef = extractChainContractRef(
      beltText,
      AZUKI.chainId,
      AZUKI.contractName,
    );
    const monoRef = extractChainContractRef(
      monoText,
      AZUKI.chainId,
      AZUKI.contractName,
    );
    expect(beltRef).toEqual(monoRef);
  });

  it("passes verify-belt-config (monolith + mibera parity)", () => {
    const result = verifyBeltConfig({
      beltConfigPath: "config.mibera.yaml",
      monolithConfigPath: "config.yaml",
    });
    expect(result.mismatches).toEqual([]);
    expect(result.ok).toBe(true);
  });
});

/**
 * Chain-1 Seaport binding for mainnet Azuki priced sales (FR-6a / R-10).
 * All four Seaport versions with real Azuki volume must be bound so a reindex
 * prices Azuki's full Seaport-era sale history (2022→present). The OrderFulfilled
 * ABI is stable across versions, so the single Seaport handler catches all.
 * Addresses verified against the Seaport GitHub deployment table + Etherscan.
 */
const SEAPORT_CHAIN1 = {
  chainId: 1,
  addresses: [
    "0x00000000006c3852cbEf3e08E8dF289169EdE581", // Seaport v1.1
    "0x00000000000001ad428e4906aE43D8F9852d0dD6", // Seaport v1.4
    "0x00000000000000ADc04C56Bf30aC9d3c0aAF14dC", // Seaport v1.5
    "0x0000000000000068F116a894984e2DB1123eB395", // Seaport v1.6
  ],
  startBlock: "14162194", // Azuki deployment
} as const;

describe("chain-1 Seaport binding (FR-6a mainnet Azuki priced sale)", () => {
  it("registers all Seaport versions (v1.1/v1.4/v1.5/v1.6) on chain 1 in config.yaml", () => {
    const ref = extractChainContractRef(monoText, SEAPORT_CHAIN1.chainId, "Seaport");
    expect(ref).not.toBeNull();
    // config quotes the Seaport address; strip quotes before comparing.
    const bound = ref!.address.map((a) => a.replace(/"/g, "").toLowerCase());
    for (const version of SEAPORT_CHAIN1.addresses) {
      expect(bound).toContain(version.toLowerCase());
    }
    expect(bound).toHaveLength(SEAPORT_CHAIN1.addresses.length);
  });

  it("sets an explicit start_block at Azuki deployment (not chain floor only)", () => {
    const ref = extractChainContractRef(monoText, SEAPORT_CHAIN1.chainId, "Seaport");
    expect(ref!.startBlock).toBe(SEAPORT_CHAIN1.startBlock);
  });

  it("includes chain-1 Seaport in BELT_CONTRACTS so verify:belt-config catches drift", () => {
    const seaportChains = BELT_CONTRACTS.filter((c) => c.name === "Seaport").map(
      (c) => c.chainId,
    );
    expect(seaportChains.sort((a, b) => a - b)).toEqual([1, 80094]);
  });

  it("keeps config.mibera.yaml field-identical for the chain-1 Seaport binding", () => {
    const beltRef = extractChainContractRef(beltText, SEAPORT_CHAIN1.chainId, "Seaport");
    const monoRef = extractChainContractRef(monoText, SEAPORT_CHAIN1.chainId, "Seaport");
    expect(beltRef).toEqual(monoRef);
  });
});
