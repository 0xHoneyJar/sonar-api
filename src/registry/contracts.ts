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
  /**
   * ERC-1155 only: the token IDs that belong to this community, for contracts
   * shared with other projects (a Zora editions contract carries every edition
   * the creator ever minted). A leg for any other token ID is ignored entirely —
   * no Action, no holder row. Omit for the common case where the whole contract
   * is the community's.
   */
  readonly tokenIds?: readonly bigint[];
  /**
   * ERC-721 only: index balances, skip the Action stream. TrackedHolder and
   * Token stay exact (every Transfer is still processed, custody rules
   * included) — only per-event row persistence is dropped, the same lever the
   * erc20 lane pulled wholesale in 4632be59. For a snapshot-served community
   * the Action rows have no consumer and are the storage cost driver; if
   * per-transfer history is ever needed, clear the flag and re-index — the
   * chain is the archive.
   */
  readonly balancesOnly?: boolean;
}

// prettier-ignore
export const CONTRACTS: readonly ContractEntry[] = [
  // MVP belt (2026-08-05): Berachain, plus the four Purupuru ERC-1155s on Base
  // (re-added 2026-08-08 for onboarding — the one Base exception). Everything
  // else — 4 chains, the Ethereum blue chips, the HoneyJar gens, the Mibera
  // satellites, the rest of the Base fleet — was cut deliberately to keep the
  // belt lean and cheap while there are no consumers for it; git history at
  // feat/mvp-berachain-only^ is the archive, and any of it comes back as one
  // line here + pnpm gen:config + a re-index.
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
  // infrared is IR only, DELIBERATELY. iBGT/iBERA are liquid-staking products
  // touched by half of Bera DeFi — measured 2026-08-06 at 24% of a full sync
  // their transfer churn was ~88% of a 44 GB Action table (the whole DB) and
  // blew the 50 GB volume. Weak membership signal, dominant storage cost.
  { community: "infrared", address: "0xa1b644aec990ad6023811ced36e6a2d6d128c7c9", chain: 80094, standard: "erc20", startBlock: 13058310 }, // Infrared Governance Token (IR)

  // Purupuru (THJ APAC) — four ERC-1155s, ALL on Base (Kizuna included: it has
  // code on 8453 and none on 80094, eth_getCode verified 2026-08-08). Every
  // address checked ERC-165 supportsInterface(0xd9b67a26) = true, and each
  // startBlock is the exact deploy block found by binary search on eth_getCode.
  //
  // Apiculture Szn 0 is a Zora editions contract shared across THJ APAC drops:
  // token 4 ("Edition Three: おはベラ！ oha-bera") is the ONLY Purupuru edition —
  // tokens 1-3 and 5-6 are other drops (verified against uri() metadata
  // 2026-08-08), hence the tokenIds allowlist. The party.app three are wholly
  // Purupuru's, so they track every token ID.
  { community: "apiculture_szn_0", address: "0x6cfb9280767a3596ee6af887d900014a755ffc75", chain: 8453, standard: "erc1155", startBlock: 13803165, tokenIds: [4n] }, // Apiculture Szn 0 (Zora)
  { community: "puru_elemental_jani", address: "0xcd3ab1b6e95cdb40a19286d863690eb407335b21", chain: 8453, standard: "erc1155", startBlock: 21538228 }, // Puru Elemental Jani (party.app)
  { community: "puru_boarding_passes", address: "0x154a563ab6c037bd0f041ac91600ffa9fe2f5fa0", chain: 8453, standard: "erc1155", startBlock: 20521993 }, // Puru Boarding Passes (party.app)
  { community: "puru_introducing_kizuna", address: "0x85a72eee14dcaa1ccc5616df39acde212280dccb", chain: 8453, standard: "erc1155", startBlock: 23800071 }, // Puru Introducing Kizuna (party.app)

  // Snapshot fleet (2026-08-09) — balancesOnly ERC-721s served from holder
  // snapshots. TrackedHolder + Token stay exact; no Action rows, so the belt
  // cost is O(holders + tokens), not O(transfers), and score-api ingests no
  // event bronze for them (the free-tier 500 MB cap rules there).
  // Community keys are chosen equal to the score-api community ids on purpose —
  // the category_key seam matches by construction.
  //
  // Round one (zerker-picked 2026-08-09): StonkBrokers only. The rest of the
  // showcase batch (Ethereum blue chips, Base fleet, other Robinhood
  // collections) is one line each from git show 74dc8ff5:src/registry/contracts.ts.
  //
  // Robinhood Chain (eip155:4663) — HyperSync-only (4663.hypersync.xyz, live,
  // probed 2026-08-09). The 2026-07-19 monobelt stall was the RPC source path
  // fataling on multi-filter; there was no HyperSync for 4663 then. There is
  // now, so it binds like any other chain — the sidecar is not coming back.
  //
  // Flipped off balancesOnly 2026-08-10 for the deep-tracking lane (score-api
  // docs/plans/2026-08-10-stonkbrokers-deep-tracking.md): full Transfer history
  // (9,027 events at recon) + the protocols.ts ring. Every broker also owns an
  // ERC-6551 wallet (WalletCreated ×4,444) — those TBAs hold stock tokens, are
  // NOT members, and are read by score-api's wealth sweep, not indexed here.
  { community: "stonk_brokers", address: "0x539cdd042c2f3d93ebc5be7dfff0c79f3b4fabf0", chain: 4663, standard: "erc721", startBlock: 12493793 }, // StonkBrokers

  // Custody addresses — not indexed. A vault or escrow holds tokens on a user's
  // behalf, so crediting it as the holder strips the depositor.
  //
  // Mibera staking: 462 tokens sat in these two on 2026-07-28 (paddlefi 455,
  // jiko 7, balanceOf against 0x6666…). Without them the vault indexes as the
  // #1 mibera holder and 462 stakers lose credit.
  { community: "mibera_collection", address: "0x242b7126f3c4e4f8cbd7f62571293e63e9b0a4e1", chain: 80094, standard: "erc721", startBlock: 3837808, custodial: true }, // paddlefi vault
  { community: "mibera_collection", address: "0x8778ca41cf0b5cd2f9967ae06b691daff11db246", chain: 80094, standard: "erc721", startBlock: 3837808, custodial: true }, // jiko staking

  // StonkBrokers custody (2026-08-10): the AMM vault holds the tradeable broker
  // inventory (nobody's tokens) and the LoanVault holds loan collateral (the
  // borrower's broker). Crediting either as a holder is wrong per construction.
  { community: "stonk_brokers", address: "0xe302733accf4800146e55fc45b46b4e4ffc032d2", chain: 4663, standard: "erc721", startBlock: 12493793, custodial: true }, // StonkNFTAMMVault
  { community: "stonk_brokers", address: "0xa7b9ac696b252b79568a5a01b2fd02177ef23664", chain: 4663, standard: "erc721", startBlock: 12493793, custodial: true }, // StonkLoanVault
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

const balancesOnlyKeys: ReadonlySet<string> = new Set(
  TRACKED_CONTRACTS.filter((c) => c.balancesOnly).map(
    (c) => `${c.chain}:${c.address}`,
  ),
);

/**
 * True when `address` on `chain` is indexed balances-only: TrackedHolder +
 * Token are maintained, no Action rows are written.
 */
export function isBalancesOnlyContract(chain: number, address: string): boolean {
  return balancesOnlyKeys.has(`${chain}:${address.toLowerCase()}`);
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

/**
 * `chain:address` → the token IDs tracked for that ERC-1155 contract, for the
 * entries that declare a `tokenIds` allowlist. A contract absent from this map
 * tracks every token ID.
 */
export function erc1155TokenAllowlists(): ReadonlyMap<string, ReadonlySet<bigint>> {
  const out = new Map<string, ReadonlySet<bigint>>();
  for (const c of TRACKED_CONTRACTS) {
    if (c.standard === "erc1155" && c.tokenIds) {
      out.set(`${c.chain}:${c.address}`, new Set(c.tokenIds));
    }
  }
  return out;
}
