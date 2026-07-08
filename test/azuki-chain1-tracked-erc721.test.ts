import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import {
  BELT_CONTRACTS,
  extractChainContractRef,
  verifyBeltConfig,
} from "../scripts/verify-belt-config.js";

/** Kitchen E2E Azuki on Ethereum mainnet — must stay in sync with config.yaml. */
const AZUKI_KITCHEN_E2E = {
  chainId: 1,
  contract: "0xed5af388653567af2f388e6224dcc93746104133",
  startBlock: "14162194",
  collectionKey: "azuki_kitchen_e2e",
} as const;

const monoText = readFileSync("config.yaml", "utf8");
const beltText = readFileSync("config.mibera.yaml", "utf8");

describe("chain-1 Azuki TrackedErc721 subscription (bug 20260702-63f78a)", () => {
  it("registers Azuki on chain 1 under TrackedErc721 in config.yaml", () => {
    const ref = extractChainContractRef(
      monoText,
      AZUKI_KITCHEN_E2E.chainId,
      "TrackedErc721",
    );
    expect(ref).not.toBeNull();
    expect(ref!.address.map((a) => a.toLowerCase())).toContain(
      AZUKI_KITCHEN_E2E.contract,
    );
  });

  it("sets an explicit start_block at Azuki deployment (not chain floor only)", () => {
    const ref = extractChainContractRef(
      monoText,
      AZUKI_KITCHEN_E2E.chainId,
      "TrackedErc721",
    );
    expect(ref!.startBlock).toBe(AZUKI_KITCHEN_E2E.startBlock);
  });

  it("includes chain-1 TrackedErc721 in BELT_CONTRACTS so verify:belt-config catches drift", () => {
    const tracked = BELT_CONTRACTS.filter((c) => c.name === "TrackedErc721").map(
      (c) => c.chainId,
    );
    expect(tracked.sort((a, b) => a - b)).toEqual([1, 10, 8453, 80094]);
  });

  it("keeps config.mibera.yaml field-identical for chain-1 Azuki binding", () => {
    const beltRef = extractChainContractRef(
      beltText,
      AZUKI_KITCHEN_E2E.chainId,
      "TrackedErc721",
    );
    const monoRef = extractChainContractRef(
      monoText,
      AZUKI_KITCHEN_E2E.chainId,
      "TrackedErc721",
    );
    expect(beltRef).toEqual(monoRef);
  });

  it("passes verify-belt-config with Azuki on chain 1 (monolith + mibera parity)", () => {
    const result = verifyBeltConfig({
      beltConfigPath: "config.mibera.yaml",
      monolithConfigPath: "config.yaml",
    });
    expect(result.mismatches).toEqual([]);
    expect(result.ok).toBe(true);
  });
});

/** Chain-1 Seaport binding for mainnet Azuki priced sales (FR-6a / R-10). */
const SEAPORT_CHAIN1 = {
  chainId: 1,
  address: "0x0000000000000068F116a894984e2DB1123eB395", // Seaport v1.6
  startBlock: "14162194", // Azuki deployment
} as const;

describe("chain-1 Seaport binding (FR-6a mainnet Azuki priced sale)", () => {
  it("registers Seaport v1.6 on chain 1 in config.yaml", () => {
    const ref = extractChainContractRef(monoText, SEAPORT_CHAIN1.chainId, "Seaport");
    expect(ref).not.toBeNull();
    // config quotes the Seaport address; strip quotes before comparing.
    expect(ref!.address.map((a) => a.replace(/"/g, "").toLowerCase())).toContain(
      SEAPORT_CHAIN1.address.toLowerCase(),
    );
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
