import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { parse } from "yaml";
import { CONFIG_YAML } from "../scripts/gen-config";
import {
  CONTRACTS,
  findContract,
  addressesByChain,
  erc721CollectionKeys,
} from "../src/registry/contracts";

/**
 * The registry invariant (bd-dwq5.1, bd-dwq5.3): src/registry/contracts.ts is
 * THE list of tracked contracts, and config.yaml is generated from it.
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
    expect(declared.length).toBeGreaterThan(50);
    expect(CONTRACTS.length).toBeGreaterThan(50);
  });

  it("resolves every contract declared in config.yaml", () => {
    const missing = declared
      .filter((d) => !findContract(d.chain, d.address))
      .map((d) => `${d.chain}:${d.address}`);
    expect(missing).toEqual([]);
  });

  it("never starts a contract later than its registry startBlock", () => {
    // Envio's per-contract start_block covers a whole address list, so the
    // generator uses the earliest startBlock in the binding. Starting earlier
    // costs sync time; starting later would silently lose transfers.
    const late = declared
      .filter((d) => d.startBlock > (findContract(d.chain, d.address)?.startBlock ?? 0))
      .map(
        (d) =>
          `${d.chain}:${d.address} config=${d.startBlock} registry=${findContract(d.chain, d.address)?.startBlock}`,
      );
    expect(late).toEqual([]);
  });

  it("is byte-identical to what the registry generates (one declaration site)", () => {
    // The whole point of bd-dwq5.3: adding a contract is one registry entry
    // plus `pnpm gen:config`. If someone hand-edits config.yaml, this fails.
    expect(readFileSync("config.yaml", "utf8")).toBe(CONFIG_YAML);
  });

  it("binds exactly two contract names, one per handler", () => {
    const names = new Set(
      [...CONFIG_YAML.matchAll(/^\s+- name: (\w+)$/gm)].map((m) => m[1]),
    );
    expect([...names].sort()).toEqual(["Seaport", "TrackedErc721"]);
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
    // azuki is the chain-1 in-scope community; mibera is the Berachain one.
    expect(findContract(1, "0xed5af388653567af2f388e6224dc7c4b3241c544")?.community).toBe(
      "azuki",
    );
    expect(findContract(80094, "0x6666397dfe9a8c469bf65dc744cb1c733416c420")?.community).toBe(
      "mibera_collection",
    );
  });

  it("binds Seaport on every chain that tracks an ERC-721", () => {
    const erc721Chains = new Set(
      CONTRACTS.filter((c) => c.standard === "erc721").map((c) => c.chain),
    );
    const seaportChains = new Set(
      CONTRACTS.filter((c) => c.standard === "seaport").map((c) => c.chain),
    );
    // Arbitrum and Zora hold one HoneyJar each. Optimism holds the Mirror
    // WritingEditions lore articles + HoneyJar4. None has ever had a Seaport
    // binding here; that predates bd-dwq5.3 and is parked, not fixed in the
    // deletion step (PARKED.md).
    const noSales = new Set([42161, 7777777, 10]);
    const uncovered = [...erc721Chains].filter(
      (id) => !seaportChains.has(id) && !noSales.has(id),
    );
    expect(uncovered).toEqual([]);
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
