import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  verifyBeltConfig,
  extractContractDefinition,
  extractChainContractRef,
  BELT_CONTRACTS,
  BELT_CHAIN_ID,
} from "../scripts/verify-belt-config.js";

// Real configs, loaded once. Mismatch cases mutate copies in memory — no temp
// files, no disk writes.
const beltText = readFileSync("config.mibera.yaml", "utf8");
const monoText = readFileSync("config.yaml", "utf8");

describe("verify-belt-config", () => {
  it("passes against the real config.mibera.yaml (AC-2 / AC-11)", () => {
    const result = verifyBeltConfig({
      beltConfigPath: "config.mibera.yaml",
      monolithConfigPath: "config.yaml",
    });
    expect(result.mismatches).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("covers all 15 belt contracts across 4 chains (multi-chain footprint)", () => {
    const names = new Set(BELT_CONTRACTS.map((c) => c.name));
    const chains = new Set(BELT_CONTRACTS.map((c) => c.chainId));
    expect(names.size).toBe(15);
    expect([...chains].sort((a, b) => a - b)).toEqual([1, 10, 8453, 80094]);
    // TrackedErc721 is referenced on BOTH Berachain (80094) and Optimism (10).
    expect(
      BELT_CONTRACTS.filter((c) => c.name === "TrackedErc721")
        .map((c) => c.chainId)
        .sort((a, b) => a - b),
    ).toEqual([10, 80094]);
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
    const broken = beltText.replace("start_block: 3971122", "start_block: 9999999");
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

  it("extracts matching chain refs (address + start_block) per contract per chain", () => {
    for (const { name, chainId } of BELT_CONTRACTS) {
      const beltRef = extractChainContractRef(beltText, chainId, name);
      const monoRef = extractChainContractRef(monoText, chainId, name);
      expect(beltRef, `${name} ref on chain ${chainId} in belt`).not.toBeNull();
      expect(monoRef, `${name} ref on chain ${chainId} in monolith`).not.toBeNull();
      expect(beltRef).toEqual(monoRef);
    }
  });
});
