/*
 * contracts.ts — THE contracts registry.
 *
 * One entry per tracked contract. `chain` and `standard` are fields, not
 * structure, so the indexing flow never differs per chain or per standard.
 * Modeled on 0xHoneyJar/ecosystem-squid's `CONTRACTS` map.
 *
 * Adding a community is one entry here. Nothing else.
 *
 * Identity is (chain, address) — the same address on two chains is two entries,
 * and `community` may legitimately repeat (one collection deployed on several
 * chains, or several contracts that belong to one community).
 *
 * This file GENERATES config.yaml (`pnpm gen:config`, scripts/gen-config.ts).
 * There is no second declaration site, and no `binding` field: the Envio
 * contract name follows from `standard`, one binding per handler.
 *
 * Invariant, enforced by test/contract-registry.test.ts: the checked-in
 * config.yaml is byte-identical to what this file generates.
 */

/**
 * One generic lane per token standard. A standard is a FIELD, so adding a
 * contract of any of these is one registry entry and `pnpm gen:config` — no
 * handler code, no per-community case.
 *
 * Marketplaces are NOT here — they are venues, not communities, and live in
 * ./marketplaces.ts. Keeping them out is what lets `isTrackedContract` mean
 * "is this one of our NFTs", which is exactly the question sale eligibility asks.
 *
 * NOTE on erc20 vs erc721: both emit `Transfer(address,address,uint256)`, so
 * they share a topic0. They differ only in whether the third arg is indexed,
 * which means a contract registered under the WRONG standard decodes into
 * garbage rather than failing loudly. test/contract-registry.test.ts asserts no
 * address is registered under two standards on the same chain.
 */
export type TokenStandard = "erc721" | "erc1155" | "erc20";

export interface ContractEntry {
  /** Stable collection/community key. Not unique on its own. */
  readonly community: string;
  /** Lowercased 0x address. Lookups always compare lowercased. */
  readonly address: string;
  /** EVM chain id. */
  readonly chain: number;
  readonly standard: TokenStandard;
  /** Block the belt starts indexing this contract from. */
  readonly startBlock: number;
  /**
   * True for a custody address — a staking vault or escrow that holds tokens on
   * a user's behalf. A custodial entry is NOT indexed (it is excluded from
   * config.yaml and from every tracked-contract view); it exists so the ERC-721
   * handler can recognize the counterparty and leave holder credit with the
   * user who deposited. `community` records which community it custodies for,
   * `standard` the standard of the tokens it holds.
   *
   * Custody is a field, not a branch: any community that stakes gets an entry
   * here and nothing else changes.
   */
  readonly custodial?: boolean;
}

// prettier-ignore
export const CONTRACTS: readonly ContractEntry[] = [
  // MVP belt (2026-08-05): Berachain only. Everything else — 4 chains, the
  // Ethereum blue chips, the HoneyJar gens, the Mibera satellites, the Base
  // fleet — was cut deliberately to keep the belt lean and cheap while there
  // are no consumers for it; git history at feat/mvp-berachain-only^ is the
  // archive, and any of it comes back as one line here + pnpm gen:config +
  // a re-index.
  { community: "mibera_collection", address: "0x6666397dfe9a8c469bf65dc744cb1c733416c420", chain: 80094, standard: "erc721", startBlock: 3837808 }, // Mibera Collection

  // Bera DeFi communities (2026-08-05). Every address verified on-chain against
  // rpc.berachain.com (name/symbol/ERC-165) and startBlock = exact deploy block
  // found by binary search on eth_getCode. Escrow tokens (xKDK, sNECT) are
  // tracked so stakers keep membership credit — the wallet swaps KDK→xKDK /
  // NECT→sNECT, and without the wrapper the most committed holders vanish.
  { community: "kodiak", address: "0xc0d1ac00a30fa4e30e44afc7313d6312c87e21df", chain: 80094, standard: "erc20", startBlock: 14478505 }, // Kodiak token (KDK)
  { community: "kodiak", address: "0x040ea7d4b559357425407fdfc3c774c5dfc04677", chain: 80094, standard: "erc20", startBlock: 14698332 }, // Kodiak escrowed token (xKDK, non-transferable)
  { community: "goldilocks", address: "0xb7e448e5677d212b8c8da7d6312e8afc49800466", chain: 80094, standard: "erc20", startBlock: 801948 }, // Locks (LOCKS)
  { community: "goldilocks", address: "0xbf2e152f460090ace91a456e3dee5acf703f27ad", chain: 80094, standard: "erc20", startBlock: 801948 }, // Porridge (PRG)
  { community: "beraborrow", address: "0x1ce0a25d13ce4d52071ae7e02cf1f6606f4c79d3", chain: 80094, standard: "erc20", startBlock: 233064 }, // Nectar (NECT)
  { community: "beraborrow", address: "0x597877ccf65be938bd214c4c46907669e3e62128", chain: 80094, standard: "erc20", startBlock: 1134927 }, // Staked Nectar (sNECT, LSP share)
  { community: "beraborrow", address: "0xc99e948e9d183848a6c4f5e6c1d225f02f171d79", chain: 80094, standard: "erc20", startBlock: 3040689 }, // POLLEN
  { community: "beraborrow", address: "0x1790b94e9394f817b3161d8f883317fcca233dfa", chain: 80094, standard: "erc721", startBlock: 811704 }, // Big Fat Beras (BFB, genesis NFT)
  { community: "dolomite", address: "0x0f81001ef0a83ecce5ccebf63eb302c70a39a654", chain: 80094, standard: "erc20", startBlock: 2925727 }, // Dolomite (DOLO)
  { community: "dolomite", address: "0xcb86b75ee6133d179a12d550b09fb3cdb1e141d4", chain: 80094, standard: "erc721", startBlock: 2926448 }, // veDOLO (locked-DOLO position NFTs)
  { community: "infrared", address: "0xac03caba51e17c86c921e1f6cbfbdc91f8bb2e6b", chain: 80094, standard: "erc20", startBlock: 562093 }, // Infrared BGT (iBGT)
  { community: "infrared", address: "0x9b6761bf2397bb5a6624a856cc84a3a14dcd3fe5", chain: 80094, standard: "erc20", startBlock: 562092 }, // Infrared BERA (iBERA)
  { community: "infrared", address: "0xa1b644aec990ad6023811ced36e6a2d6d128c7c9", chain: 80094, standard: "erc20", startBlock: 13058310 }, // Infrared Governance Token (IR)

  // Custody addresses — not indexed. A vault or escrow holds tokens on a user's
  // behalf, so crediting it as the holder strips the depositor.
  //
  // Mibera staking: 462 tokens sat in these two on 2026-07-28 (paddlefi 455,
  // jiko 7, balanceOf against 0x6666…). Without them the vault indexes as the
  // #1 mibera holder and 462 stakers lose credit.
  { community: "mibera_collection", address: "0x242b7126f3c4e4f8cbd7f62571293e63e9b0a4e1", chain: 80094, standard: "erc721", startBlock: 3837808, custodial: true }, // paddlefi vault
  { community: "mibera_collection", address: "0x8778ca41cf0b5cd2f9967ae06b691daff11db246", chain: 80094, standard: "erc721", startBlock: 3837808, custodial: true }, // jiko staking
];

/**
 * The entries that are actually indexed — everything except custody addresses.
 * config.yaml and every address view below derive from this, so a custodial
 * entry can never become a bound contract.
 */
export const TRACKED_CONTRACTS: readonly ContractEntry[] = CONTRACTS.filter(
  (c) => !c.custodial,
);

const byKey: ReadonlyMap<string, ContractEntry> = new Map(
  TRACKED_CONTRACTS.map((c) => [`${c.chain}:${c.address}`, c]),
);

const custodialKeys: ReadonlySet<string> = new Set(
  CONTRACTS.filter((c) => c.custodial).map((c) => `${c.chain}:${c.address}`),
);

/**
 * True when `address` custodies tokens for a user on `chain` (staking vault,
 * escrow). Transfers to and from such an address move custody, not ownership.
 */
export function isCustodialAddress(chain: number, address: string): boolean {
  return custodialKeys.has(`${chain}:${address.toLowerCase()}`);
}

/** The entry for `address` on `chain`, or undefined if it is not tracked. */
export function findContract(
  chain: number,
  address: string,
): ContractEntry | undefined {
  return byKey.get(`${chain}:${address.toLowerCase()}`);
}

/** True when `address` is tracked on `chain`. */
export function isTrackedContract(chain: number, address: string): boolean {
  return byKey.has(`${chain}:${address.toLowerCase()}`);
}

/**
 * address → community key, for every ERC-721 entry.
 *
 * Chain-agnostic by design: this is the collectionKey the ERC-721 handler
 * stamps on holder rows, and those keys are global. The only ERC-721 addresses
 * bound on more than one chain carry the same community key on each, so the
 * flattening is lossless (asserted in test/contract-registry.test.ts).
 */
export function collectionKeys(standard: TokenStandard): Record<string, string> {
  const out: Record<string, string> = {};
  for (const c of TRACKED_CONTRACTS) {
    if (c.standard === standard) out[c.address] = c.community;
  }
  return out;
}

/** `collectionKeys("erc721")`. Kept as a name because the invariant above is about ERC-721. */
export function erc721CollectionKeys(): Record<string, string> {
  return collectionKeys("erc721");
}
