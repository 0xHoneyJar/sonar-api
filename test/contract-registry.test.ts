import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { parse } from "yaml";
import {
  CONTRACTS,
  findContract,
  addressesByChain,
  erc721CollectionKeys,
} from "../src/registry/contracts";

/**
 * The registry invariant (bd-dwq5.1): src/registry/contracts.ts is THE list of
 * tracked contracts, and it agrees exactly with what the belt binds.
 *
 * `schema: "failsafe"` keeps every scalar a string — an unquoted 0x… scalar is a
 * valid YAML 1.1 hex integer and the default schema destroys the address.
 */
type Declared = { chain: number; address: string; startBlock: number };

function declaredInConfig(configText: string): Declared[] {
  const doc = parse(configText, { schema: "failsafe" }) as {
    chains?: Array<{
      id?: string;
      start_block?: string;
      contracts?: Array<{ address?: unknown; start_block?: string }>;
    }>;
  } | null;

  const out: Declared[] = [];
  for (const chain of doc?.chains ?? []) {
    const chainId = Number(chain?.id);
    if (!Number.isFinite(chainId)) continue;
    for (const contract of chain?.contracts ?? []) {
      const raw = contract?.address;
      const values = Array.isArray(raw) ? raw : raw == null ? [] : [raw];
      const startBlock = Number(contract?.start_block ?? chain?.start_block);
      for (const v of values) {
        const address = String(v).trim().toLowerCase();
        if (/^0x[0-9a-f]{40}$/.test(address))
          out.push({ chain: chainId, address, startBlock });
      }
    }
  }
  return out;
}

const declared = declaredInConfig(readFileSync("config.yaml", "utf8"));

describe("contracts registry ↔ config.yaml", () => {
  it("finds contracts to check (guards against a silently empty parse)", () => {
    expect(declared.length).toBeGreaterThan(100);
    expect(CONTRACTS.length).toBeGreaterThan(100);
  });

  it("resolves every contract declared in config.yaml", () => {
    const missing = declared
      .filter((d) => !findContract(d.chain, d.address))
      .map((d) => `${d.chain}:${d.address}`);
    expect(missing).toEqual([]);
  });

  it("carries the same startBlock as config.yaml for every contract", () => {
    const drift = declared
      .filter((d) => findContract(d.chain, d.address)?.startBlock !== d.startBlock)
      .map(
        (d) =>
          `${d.chain}:${d.address} config=${d.startBlock} registry=${findContract(d.chain, d.address)?.startBlock}`,
      );
    expect(drift).toEqual([]);
  });

  it("has no entry that config.yaml does not declare (one list, both ways)", () => {
    const declaredKeys = new Set(declared.map((d) => `${d.chain}:${d.address}`));
    const extra = CONTRACTS.map((c) => `${c.chain}:${c.address}`).filter(
      (k) => !declaredKeys.has(k),
    );
    expect(extra).toEqual([]);
  });

  it("keys entries uniquely by (chain, address)", () => {
    const keys = CONTRACTS.map((c) => `${c.chain}:${c.address}`);
    expect(keys.length).toBe(new Set(keys).size);
  });

  it("stores addresses lowercased", () => {
    expect(CONTRACTS.filter((c) => c.address !== c.address.toLowerCase())).toEqual([]);
  });

  it("assigns one community per ERC-721 address across chains", () => {
    // erc721CollectionKeys() flattens away `chain`; that is only lossless if an
    // address bound on two chains carries the same community key on both.
    const seen = new Map<string, string>();
    const conflicts: string[] = [];
    for (const c of CONTRACTS) {
      if (c.standard !== "erc721") continue;
      const prior = seen.get(c.address);
      if (prior && prior !== c.community)
        conflicts.push(`${c.address}: ${prior} vs ${c.community}`);
      seen.set(c.address, c.community);
    }
    expect(conflicts).toEqual([]);
  });

  it("covers the in-scope MVP communities on Base", () => {
    const mvp = [
      ["warplets", "0x699727f9e01a822efdcf7333073f0461e5914b4e"],
      ["kemonokaki", "0xee7d1b184be8185adc7052635329152a4d0cdefa"],
      ["based_onchain_punks", "0x9e7a06c281355f60570e47a12650c89fe1d36ff3"],
      ["based_punks", "0xcb28749c24af4797808364d71d71539bc01e76d4"],
      ["lil_bangers", "0x1260f90e0b1c482b38b88f26dee17c57615d670b"],
      ["nodes_by_hunter", "0x95bc4c2e01c2e2d9e537e7a9fe58187e88dd8019"],
      ["veecon_2024_tickets", "0x20fd75eccd7bb9c4eb9e3bb4c09c6b382e15d63e"],
    ] as const;
    for (const [community, address] of mvp) {
      const entry = findContract(8453, address);
      expect(entry, `${community} missing from registry`).toBeDefined();
      expect(entry?.community).toBe(community);
      expect(entry?.standard).toBe("erc721");
    }
    // azuki is the chain-1 in-scope community
    expect(findContract(1, "0xed5af388653567af2f388e6224dc7c4b3241c544")?.community).toBe(
      "azuki",
    );
  });
});

describe("registry-derived views", () => {
  it("exposes every declared address under its chain", () => {
    const byChain = addressesByChain();
    const missing = declared.filter((d) => !byChain.get(d.chain)?.has(d.address));
    expect(missing).toEqual([]);
  });

  it("maps every ERC-721 address to a non-empty community key", () => {
    const keys = erc721CollectionKeys();
    const erc721 = CONTRACTS.filter((c) => c.standard === "erc721");
    expect(erc721.length).toBeGreaterThan(0);
    for (const c of erc721) expect(keys[c.address]).toBe(c.community);
    expect(Object.values(keys).filter((v) => !v)).toEqual([]);
  });
});
