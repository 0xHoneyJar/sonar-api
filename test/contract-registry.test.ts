import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { parse } from "yaml";
import { CONFIG_YAML } from "../scripts/gen-config";
import {
  CONTRACTS,
  TRACKED_CONTRACTS,
  isCustodialAddress,
  findContract,
  erc721CollectionKeys,
  collectionKeys,
} from "../src/registry/contracts";
import { MARKETPLACES } from "../src/registry/marketplaces";

/**
 * The registry invariant (bd-dwq5.1, bd-dwq5.3): src/registry/contracts.ts is
 * THE list of tracked contracts, and config.yaml is generated from it.
 *
 * `schema: "failsafe"` keeps every scalar a string — an unquoted 0x… scalar is a
 * valid YAML 1.1 hex integer and the default schema destroys the address.
 */
type Declared = { chain: number; address: string; startBlock: number; lane: string };

function declaredInConfig(configText: string): Declared[] {
  const doc = parse(configText, { schema: "failsafe" }) as {
    chains?: Array<{
      id?: string;
      start_block?: string;
      contracts?: Array<{ name?: string; address?: unknown; start_block?: string }>;
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
          out.push({ chain: chainId, address, startBlock, lane: String(contract?.name ?? "") });
      }
    }
  }
  return out;
}

const declaredAll = declaredInConfig(readFileSync("config.yaml", "utf8"));

/** Token-lane addresses only — marketplace lanes resolve against MARKETPLACES, not CONTRACTS. */
const declared = declaredAll.filter((d) => d.lane.startsWith("Tracked"));
const declaredVenues = declaredAll.filter((d) => !d.lane.startsWith("Tracked"));

describe("contracts registry ↔ config.yaml", () => {
  it("finds contracts to check (guards against a silently empty parse)", () => {
    // Lean MVP belt (2026-08-05): 14 indexed + 2 custodial. The floor guards
    // against an empty parse, not a particular fleet size.
    expect(declared.length).toBeGreaterThan(10);
    expect(CONTRACTS.length).toBeGreaterThan(10);
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

  it("binds exactly the declared lanes, one per handler", () => {
    // A closed set: a name here with no handler file is a config pair nothing
    // handles (silent data gap), and a handler with no name here never fires.
    // scripts/check-onevent-bijection.mjs enforces the same thing at the
    // event level; this catches a stray binding without running the belt.
    const names = new Set(
      [...CONFIG_YAML.matchAll(/^\s+- name: (\w+)$/gm)].map((m) => m[1]),
    );
    expect([...names].sort()).toEqual([
      "Blur",
      "BlurV2",
      "Seaport",
      "TrackedErc1155",
      "TrackedErc20",
      "TrackedErc721",
    ]);
  });

  it("declares every lane in the top-level contracts block, even with no addresses", () => {
    // Lanes with no registered contract still need their config pair declared —
    // the handlers self-register unconditionally, and an onEvent call site with
    // no matching config pair is an orphan that silently never fires.
    const topLevel = CONFIG_YAML.slice(
      CONFIG_YAML.indexOf("contracts:"),
      CONFIG_YAML.indexOf("chains:"),
    );
    for (const lane of ["TrackedErc721", "TrackedErc1155", "TrackedErc20", "Seaport", "Blur", "BlurV2"]) {
      expect(topLevel).toContain(`- name: ${lane}`);
    }
  });

  it("resolves every marketplace address declared in config.yaml", () => {
    const known = new Set(MARKETPLACES.map((m) => `${m.chain}:${m.address}`));
    const missing = declaredVenues
      .filter((d) => !known.has(`${d.chain}:${d.address}`))
      .map((d) => `${d.chain}:${d.address}`);
    expect(declaredVenues.length).toBeGreaterThan(0);
    expect(missing).toEqual([]);
  });

  it("never lets a marketplace address into the tracked-NFT set", () => {
    // Sale eligibility asks isTrackedContract("is this one of our NFTs"). A venue
    // answering yes would emit a sale row for the marketplace itself.
    for (const m of MARKETPLACES) {
      expect(findContract(m.chain, m.address), `${m.address} is a venue, not an NFT`).toBeUndefined();
    }
  });

  it("has no entry that config.yaml does not declare (one list, both ways)", () => {
    const declaredKeys = new Set(declared.map((d) => `${d.chain}:${d.address}`));
    const extra = TRACKED_CONTRACTS.map((c) => `${c.chain}:${c.address}`).filter(
      (k) => !declaredKeys.has(k),
    );
    expect(extra).toEqual([]);
  });

  it("keeps custody addresses out of config.yaml", () => {
    // A custodial entry is a recognition rule, not a contract to index. If one
    // leaks into the generated config the vault's own Transfers get indexed.
    const declaredKeys = new Set(declared.map((d) => `${d.chain}:${d.address}`));
    const custodial = CONTRACTS.filter((c) => c.custodial);
    expect(custodial.length).toBeGreaterThan(0);
    for (const c of custodial) {
      expect(declaredKeys.has(`${c.chain}:${c.address}`)).toBe(false);
      expect(findContract(c.chain, c.address)).toBeUndefined();
      expect(isCustodialAddress(c.chain, c.address)).toBe(true);
    }
  });

  it("registers the mibera staking vaults as custodial", () => {
    // paddlefi + jiko held 462 miberas on 2026-07-28. Without these entries the
    // vault indexes as the #1 mibera holder and 462 stakers lose credit.
    // (Blur Blend served this role for the Ethereum fleet until the 2026-08-05
    // Berachain-only cut removed chain 1.)
    for (const addr of [
      "0x242b7126f3c4e4f8cbd7f62571293e63e9b0a4e1", // paddlefi vault
      "0x8778ca41cf0b5cd2f9967ae06b691daff11db246", // jiko staking
    ]) {
      const vault = CONTRACTS.find((c) => c.address === addr);
      expect(vault, `${addr} missing from registry`).toBeDefined();
      expect(vault?.custodial).toBe(true);
      expect(isCustodialAddress(80094, addr.toUpperCase().replace("0X", "0x"))).toBe(true);
    }
  });

  it("registers the Mibera staking vaults as custodial", () => {
    // 462 Mibera were held by these two on 2026-07-28 (paddlefi 455, jiko 7).
    for (const address of [
      "0x242b7126f3c4e4f8cbd7f62571293e63e9b0a4e1",
      "0x8778ca41cf0b5cd2f9967ae06b691daff11db246",
    ]) {
      const entry = CONTRACTS.find((c) => c.chain === 80094 && c.address === address);
      expect(entry, `${address} missing from registry`).toBeDefined();
      expect(entry?.custodial).toBe(true);
      expect(entry?.community).toBe("mibera_collection");
    }
  });

  it("treats a non-custodial address as non-custodial", () => {
    expect(isCustodialAddress(80094, "0x6666397dfe9a8c469bf65dc744cb1c733416c420")).toBe(
      false,
    );
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

  it("covers the in-scope MVP communities on Berachain", () => {
    // Lean MVP belt (2026-08-05): mibera + the five Bera DeFi communities,
    // one representative contract each. Every address verified on-chain
    // against rpc.berachain.com before registration.
    const mvp = [
      ["mibera_collection", "0x6666397dfe9a8c469bf65dc744cb1c733416c420", "erc721"],
      ["kodiak", "0xc0d1ac00a30fa4e30e44afc7313d6312c87e21df", "erc20"],
      ["goldilocks", "0xb7e448e5677d212b8c8da7d6312e8afc49800466", "erc20"],
      ["beraborrow", "0x1ce0a25d13ce4d52071ae7e02cf1f6606f4c79d3", "erc20"],
      ["beraborrow", "0x1790b94e9394f817b3161d8f883317fcca233dfa", "erc721"],
      ["dolomite", "0x0f81001ef0a83ecce5ccebf63eb302c70a39a654", "erc20"],
      ["dolomite", "0xcb86b75ee6133d179a12d550b09fb3cdb1e141d4", "erc721"],
      ["infrared", "0xac03caba51e17c86c921e1f6cbfbdc91f8bb2e6b", "erc20"],
    ] as const;
    for (const [community, address, standard] of mvp) {
      const entry = findContract(80094, address);
      expect(entry, `${community} missing from registry`).toBeDefined();
      expect(entry?.community).toBe(community);
      expect(entry?.standard).toBe(standard);
    }
    // The belt is deliberately single-chain: nothing outside Berachain.
    expect(CONTRACTS.filter((c) => c.chain !== 80094)).toEqual([]);
  });

  it("covers every NFT-bearing chain with at least one marketplace", () => {
    // The whole point of the marketplace registry: sale coverage is per-chain,
    // so a community added to any chain already has a venue decoding its sales.
    // Optimism, Arbitrum and Zora were uncovered until 2026-07-31 — 11 collections
    // produced holder data that could never produce a sale row.
    const nftChains = new Set(
      CONTRACTS.filter((c) => c.standard !== "erc20").map((c) => c.chain),
    );
    const covered = new Set(MARKETPLACES.map((m) => m.chain));
    const uncovered = [...nftChains].filter((id) => !covered.has(id)).sort((a, b) => a - b);
    expect(uncovered).toEqual([]);
  });
});

describe("registry-derived views", () => {
  it("maps every ERC-721 address to a non-empty community key", () => {
    const keys = erc721CollectionKeys();
    const erc721 = TRACKED_CONTRACTS.filter((c) => c.standard === "erc721");
    expect(erc721.length).toBeGreaterThan(0);
    for (const c of erc721) expect(keys[c.address]).toBe(c.community);
    expect(Object.values(keys).filter((v) => !v)).toEqual([]);
  });

  it("maps every address to a non-empty key in its own lane", () => {
    for (const standard of ["erc721", "erc1155", "erc20"] as const) {
      const keys = collectionKeys(standard);
      for (const c of TRACKED_CONTRACTS.filter((x) => x.standard === standard)) {
        expect(keys[c.address]).toBe(c.community);
      }
      expect(Object.values(keys).filter((v) => !v)).toEqual([]);
    }
  });

  // ERC-20 and ERC-721 both emit Transfer(address,address,uint256), so they share
  // a topic0 and differ only in whether the third arg is indexed. An address bound
  // under both standards on one chain would be decoded two ways from the same log
  // — silently producing garbage balances rather than failing. Nothing today does
  // this; the test exists so nothing ever does.
  it("never registers one address under two standards on the same chain", () => {
    const seen = new Map<string, string>();
    const collisions: string[] = [];
    for (const c of CONTRACTS) {
      const key = `${c.chain}:${c.address}`;
      const prior = seen.get(key);
      if (prior && prior !== c.standard) {
        collisions.push(`${key} is both '${prior}' and '${c.standard}'`);
      }
      seen.set(key, c.standard);
    }
    expect(collisions).toEqual([]);
  });
});
