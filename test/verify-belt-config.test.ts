import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  verifyBeltConfig,
  extractContractDefinition,
  extractChainContractRef,
  BELT_CONTRACTS,
  ADDRESS_SUBSET_CONTRACTS,
  BELT_CHAIN_ID,
} from "../scripts/verify-belt-config.js";
import { TRACKED_ERC721_COLLECTION_KEYS } from "../src/handlers/tracked-erc721/constants.js";

// Real configs, loaded once. Mismatch cases mutate copies in memory — no temp
// files, no disk writes.
const beltText = readFileSync("config.mibera.yaml", "utf8");
const monoText = readFileSync("config.yaml", "utf8");

const ACTIVE_FRACTURES = {
  "0x86db98cf1b81e833447b12a077ac28c36b75c8e1": "miparcels",
  "0x8d4972bd5d2df474e71da6676a365fb549853991": "miladies",
  "0x144b27b1a267ee71989664b3907030da84cc4754": "mireveal_1_1",
  "0x72db992e18a1bf38111b1936dd723e82d0d96313": "mireveal_2_2",
  "0x3a00301b713be83ec54b7b4fb0f86397d087e6d3": "mireveal_3_3",
  "0x419f25c4f9a9c730aacf58b8401b5b3e566fe886": "mireveal_4_20",
  "0x81a27117bd894942ba6737402fb9e57e942c6058": "mireveal_5_5",
  "0xaab7b4502251ae393d0590bab3e208e2d58f4813": "mireveal_6_6",
  "0xc64126ea8dc7626c16daa2a29d375c33fcaa4c7c": "mireveal_7_7",
  "0x24f4047d372139de8dacbe79e2fc576291ec3ffc": "mireveal_8_8",
} as const;

const SUPERSEDED_FRACTURES = [
  "0x6956dae88c00372b1a0b2dfbfe5eed19f85b0d4b",
  "0x77ec6b83495974a5b2c5bef943b0f2e5acd8fc26",
  "0xc557bf6c7d21ba98a40ddfe2beaba682c49d17a9",
  "0xbcb082bb41e892f29d9c600eaadea698d5f712ef",
  "0x2030f226bf9a0c88687e83accdcefb7dae260094",
  "0xcc426f9375c5edcef5ca6bdb0449c07113348cf7",
  "0xf68f40230e39067ee7c98fe9a8641fc124c5be60",
  "0xfc79b1bcca172ff5a8f74205c82f5cbb0125dd10",
  "0xa3d3ef45712631a6fb50c677762b8653f932cf71",
] as const;

describe("verify-belt-config", () => {
  it("passes against the real config.mibera.yaml (AC-2 / AC-11)", () => {
    const result = verifyBeltConfig({
      beltConfigPath: "config.mibera.yaml",
      monolithConfigPath: "config.yaml",
    });
    expect(result.mismatches).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("covers all belt contracts across 4 chains (multi-chain footprint)", () => {
    const names = new Set(BELT_CONTRACTS.map((c) => c.name));
    const chains = new Set(BELT_CONTRACTS.map((c) => c.chainId));
    expect(names.size).toBe(16); // EthTrackedErc721 (chain-1 Azuki, #120); Seaport already present on chain 80094
    expect(BELT_CONTRACTS.length).toBe(19); // 18 (EthTrackedErc721 rename) +Seaport@1 (FR-6a mainnet Azuki secondary sales)
    expect([...chains].sort((a, b) => a - b)).toEqual([1, 10, 8453, 80094]);
    // Shared TrackedErc721 spans OP(lore) + Base(#124 batch) + Berachain(fractures); chain-1 Azuki is the
    // dedicated EthTrackedErc721 (envio #120 single-address fetch gap).
    expect(
      BELT_CONTRACTS.filter((c) => c.name === "TrackedErc721")
        .map((c) => c.chainId)
        .sort((a, b) => a - b),
    ).toEqual([10, 8453, 80094]);
    expect(
      BELT_CONTRACTS.filter((c) => c.name === "EthTrackedErc721").map(
        (c) => c.chainId,
      ),
    ).toEqual([1]);
    expect(BELT_CHAIN_ID).toBe(80094); // back-compat export
  });

  it("fails when a field_selection field is removed — the silent-data-loss case (SDD §5.1)", () => {
    // Drop `value` from MiberaCollection.Transfer — the field mibera-collection.ts
    // reads for MintActivity.amountPaid. Omitting it silently writes 0n, no crash.
    const broken = beltText.replace("            - value\n", "");
    expect(broken).not.toBe(beltText); // injection landed
    const result = verifyBeltConfig({
      beltConfigText: broken,
      monolithConfigText: monoText,
    });
    expect(result.ok).toBe(false);
    expect(result.mismatches.join("\n")).toMatch(/MiberaCollection/);
  });

  it("fails when a MiberaLiquidBacking field_selection field is removed", () => {
    // Drop the first `- from` (LoanReceived needs transaction.from for loan user).
    const broken = beltText.replace("            - from\n", "");
    expect(broken).not.toBe(beltText);
    const result = verifyBeltConfig({
      beltConfigText: broken,
      monolithConfigText: monoText,
    });
    expect(result.ok).toBe(false);
    expect(result.mismatches.join("\n")).toMatch(/MiberaLiquidBacking/);
  });

  it("fails when a start_block is wrong", () => {
    const broken = beltText.replace(
      "start_block: 3971122",
      "start_block: 9999999",
    );
    expect(broken).not.toBe(beltText);
    const result = verifyBeltConfig({
      beltConfigText: broken,
      monolithConfigText: monoText,
    });
    expect(result.ok).toBe(false);
    expect(result.mismatches.join("\n")).toMatch(/start_block/);
  });

  it("fails when an address is wrong", () => {
    const broken = beltText.replace(
      "0xaa04F13994A7fCd86F3BbbF4054d239b88F2744d",
      "0xaa04F13994A7fCd86F3BbbF4054d239b88F2744e",
    );
    expect(broken).not.toBe(beltText);
    const result = verifyBeltConfig({
      beltConfigText: broken,
      monolithConfigText: monoText,
    });
    expect(result.ok).toBe(false);
    expect(result.mismatches.join("\n")).toMatch(/address/);
  });

  it("allows config.yaml to add addresses outside the scoped belt footprint", () => {
    const expanded = monoText.replace(
      "          - 0x86Db98cf1b81E833447b12a077ac28c36b75c8E1",
      [
        "          - 0x86Db98cf1b81E833447b12a077ac28c36b75c8E1",
        "          - 0x0000000000000000000000000000000000000042",
      ].join("\n"),
    );
    expect(expanded).not.toBe(monoText);
    const result = verifyBeltConfig({
      beltConfigText: beltText,
      monolithConfigText: expanded,
    });
    expect(result.mismatches).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("rejects an additive address on a critical Score contract", () => {
    const expanded = monoText.replace(
      "          - 0x242b7126F3c4E4F8CbD7f62571293e63E9b0a4E1",
      [
        "          - 0x242b7126F3c4E4F8CbD7f62571293e63E9b0a4E1",
        "          - 0x0000000000000000000000000000000000000042",
      ].join("\n"),
    );
    expect(expanded).not.toBe(monoText);
    const result = verifyBeltConfig({
      beltConfigText: beltText,
      monolithConfigText: expanded,
    });
    expect(result.ok).toBe(false);
    expect(result.mismatches.join("\n")).toMatch(/PaddleFi.*address differs/);
  });

  it("rejects an empty belt address list instead of accepting a vacuous subset", () => {
    const broken = beltText.replace(
      "          - 0xaa04F13994A7fCd86F3BbbF4054d239b88F2744d # Mibera Liquid Backing\n",
      "",
    );
    expect(broken).not.toBe(beltText);
    const result = verifyBeltConfig({
      beltConfigText: broken,
      monolithConfigText: monoText,
    });
    expect(result.ok).toBe(false);
    expect(result.mismatches.join("\n")).toMatch(
      /MiberaLiquidBacking.*address list is empty/,
    );
  });

  it("preserves the active Fractures footprint in both configs and Score-compatible keys", () => {
    const monolithTracked = extractChainContractRef(
      monoText,
      80094,
      "TrackedErc721",
    );
    const beltTracked = extractChainContractRef(
      beltText,
      80094,
      "TrackedErc721",
    );
    expect(monolithTracked).not.toBeNull();
    expect(beltTracked).not.toBeNull();
    const monolithAddresses = new Set(
      monolithTracked!.address.map((address) => address.toLowerCase()),
    );
    const beltAddresses = new Set(
      beltTracked!.address.map((address) => address.toLowerCase()),
    );

    for (const [address, key] of Object.entries(ACTIVE_FRACTURES)) {
      expect(
        monolithAddresses.has(address),
        `${key} active address configured in monolith`,
      ).toBe(true);
      expect(
        beltAddresses.has(address),
        `${key} active address preserved in Score belt`,
      ).toBe(true);
      expect(TRACKED_ERC721_COLLECTION_KEYS[address]).toBe(key);
    }
    for (const address of SUPERSEDED_FRACTURES) {
      expect(
        monolithAddresses.has(address),
        `${address} first-batch address reintroduced to monolith`,
      ).toBe(false);
      expect(
        beltAddresses.has(address),
        `${address} first-batch address reintroduced to Score belt`,
      ).toBe(false);
      expect(TRACKED_ERC721_COLLECTION_KEYS[address]).toBeUndefined();
    }
  });

  it("tolerates a differing handlers: dir (SDD §5.3 — field_selection fidelity, not handler path)", () => {
    // Envio 3.2.1 dropped per-contract `handler:` lines in favour of a single
    // top-level `handlers:` directory that the runtime auto-globs. config.mibera.yaml
    // points `handlers:` at the belt dir (src/belts/mibera) while config.yaml points it
    // at the monolith dir (src/handlers). They differ BY DESIGN — the gate must not flag
    // that difference (SDD §5.3 scopes fidelity to field_selection / address / start_block,
    // not handler-path identity). Pre-3.2.1 this asserted the same tolerance on the
    // per-contract `handler:` line; the assertion moved to `handlers:` with the port.
    const rehandlered = beltText.replace(
      /^handlers:\s+\S+/m,
      "handlers: src/belts/someother",
    );
    expect(rehandlered).not.toBe(beltText);
    const result = verifyBeltConfig({
      beltConfigText: rehandlered,
      monolithConfigText: monoText,
    });
    expect(result.mismatches).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("fails when a belt contract is missing entirely", () => {
    const result = verifyBeltConfig({
      beltConfigText: "name: empty\n",
      monolithConfigText: monoText,
    });
    expect(result.ok).toBe(false);
    expect(result.mismatches.length).toBeGreaterThan(0);
  });

  it("extracts identical contract definitions from belt and monolith", () => {
    for (const { name } of BELT_CONTRACTS) {
      const beltDef = extractContractDefinition(beltText, name);
      const monoDef = extractContractDefinition(monoText, name);
      expect(beltDef, `${name} present in belt config`).not.toBeNull();
      expect(monoDef, `${name} present in monolith`).not.toBeNull();
      expect(beltDef).toBe(monoDef);
    }
  });

  it("enforces exact critical addresses and scoped generic-tracker subsets", () => {
    for (const { name, chainId } of BELT_CONTRACTS) {
      const beltRef = extractChainContractRef(beltText, chainId, name);
      const monoRef = extractChainContractRef(monoText, chainId, name);
      expect(beltRef, `${name} ref on chain ${chainId} in belt`).not.toBeNull();
      expect(
        monoRef,
        `${name} ref on chain ${chainId} in monolith`,
      ).not.toBeNull();
      expect(beltRef!.startBlock).toBe(monoRef!.startBlock);
      if (ADDRESS_SUBSET_CONTRACTS.has(name)) {
        const monoAddresses = new Set(
          monoRef!.address.map((address) => address.toLowerCase()),
        );
        expect(beltRef!.address.length).toBeGreaterThan(0);
        expect(
          beltRef!.address.every((address) =>
            monoAddresses.has(address.toLowerCase()),
          ),
          `${name} belt addresses remain covered on chain ${chainId}`,
        ).toBe(true);
      } else {
        expect(beltRef!.address).toEqual(monoRef!.address);
      }
    }
  });
});
