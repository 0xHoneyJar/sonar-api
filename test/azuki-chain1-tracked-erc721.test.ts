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
 *  Bound to the DEDICATED contract `EthTrackedErc721` (envio #120 / sprint-bug-192): a single-address
 *  entry in the shared multi-chain `TrackedErc721` is not fetched on chain 1; a dedicated contract
 *  closes the gap (Milady, a dedicated single-address ETH contract, indexes fine). */
const AZUKI = {
  chainId: 1,
  contract: "0xed5af388653567af2f388e6224dcc93746104133",
  startBlock: "14162194",
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

  it("sets an explicit start_block at Azuki deployment (not chain floor only)", () => {
    const ref = extractChainContractRef(
      monoText,
      AZUKI.chainId,
      AZUKI.contractName,
    );
    expect(ref!.startBlock).toBe(AZUKI.startBlock);
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
