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
  { community: "honeyjar1", address: "0xa20cf9b0874c3e46b344deaeea9c2e0c3e1db37d", chain: 1, standard: "erc721", startBlock: 17085858 }, // HoneyJar1
  { community: "honeyjar6", address: "0x98dc31a9648f04e23e4e36b0456d1951531c2a05", chain: 1, standard: "erc721", startBlock: 17085858 }, // HoneyJar6
  { community: "honeycomb", address: "0xcb0477d1af5b8b05795d89d59f4667b59eae9244", chain: 1, standard: "erc721", startBlock: 16751283 },
  { community: "honeyjar2_l0_remint", address: "0x3f4dd25ba6fb6441bfd1a869cbda6a511966456d", chain: 1, standard: "erc721", startBlock: 17516342 }, // HoneyJar2 L0 remint
  { community: "honeyjar3_l0_remint", address: "0x49f3915a52e137e597d6bf11c73e78c68b082297", chain: 1, standard: "erc721", startBlock: 20463444 }, // HoneyJar3 L0 remint (was missing!)
  { community: "honeyjar4_l0_remint", address: "0x0b820623485dcfb1c40a70c55755160f6a42186d", chain: 1, standard: "erc721", startBlock: 20814248 }, // HoneyJar4 L0 remint (was missing!)
  { community: "honeyjar5_l0_remint", address: "0x39eb35a84752b4bd3459083834af1267d276a54c", chain: 1, standard: "erc721", startBlock: 21327296 }, // HoneyJar5 L0 remint (was missing!)
  { community: "milady_maker", address: "0x5af0d9827e0c53e4799bb226655a1de152a425a5", chain: 1, standard: "erc721", startBlock: 12287507 }, // Milady Maker
  { community: "azuki", address: "0xed5af388653567af2f388e6224dc7c4b3241c544", chain: 1, standard: "erc721", startBlock: 12287507 }, // azuki (canonical, verified on Etherscan)
  { community: "azuki_beanz_official", address: "0x306b1ea3ecdf94ab739f1910bbda052ed4a9f949", chain: 1, standard: "erc721", startBlock: 12287507 }, // azuki BEANZ Official
  { community: "azuki_elementals", address: "0xb6a37b5d14d502c3ab0ae6f3a0e058bc9517786e", chain: 1, standard: "erc721", startBlock: 12287507 }, // azuki Elementals
  { community: "azuki_bobu_the_bean_farmer", address: "0x2079812353e2c9409a788fbf5f383fa62ad85be8", chain: 1, standard: "erc721", startBlock: 12287507 }, // azuki Bobu the Bean Farmer
  { community: "yuga_bored_ape_yacht_club", address: "0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d", chain: 1, standard: "erc721", startBlock: 12287507 }, // yuga Bored Ape Yacht Club
  { community: "yuga_mutant_ape_yacht_club", address: "0x60e4d786628fea6478f785a6d7e704777c86a7c6", chain: 1, standard: "erc721", startBlock: 12287507 }, // yuga Mutant Ape Yacht Club
  { community: "yuga_bored_ape_kennel_club", address: "0xba30e5f9bb24c19c9002c35c7098ad4a0f7ff53b", chain: 1, standard: "erc721", startBlock: 12287507 }, // yuga Bored Ape Kennel Club
  { community: "pudgy_penguins_pudgy_penguins", address: "0xbd3531da5cf5857e7cfaa92426877b022e612cf8", chain: 1, standard: "erc721", startBlock: 12287507 }, // pudgy-penguins Pudgy Penguins
  { community: "pudgy_penguins_lil_pudgys", address: "0x524cab2ec69124574082676e6f654a18df49a048", chain: 1, standard: "erc721", startBlock: 12287507 }, // pudgy-penguins Lil Pudgys
  { community: "remilia_redacted_remilio_babies", address: "0xd3d9ddd0cf0a5f0bfb8f7fceae075df687eaebab", chain: 1, standard: "erc721", startBlock: 12287507 }, // remilia Redacted Remilio Babies
  { community: "doodles_doodles", address: "0x8a90cab2b38dba80c64b7734e58ee1db38b8992e", chain: 1, standard: "erc721", startBlock: 12287507 }, // doodles Doodles
  { community: "moonbirds_moonbirds", address: "0x23581767a106ae21c074b2276d25e5c3e136a68b", chain: 1, standard: "erc721", startBlock: 12287507 }, // moonbirds Moonbirds
  { community: "nouns_nouns", address: "0x9c8ff314c9bc7f6e59a9d9225fb22946427edc03", chain: 1, standard: "erc721", startBlock: 12287507 }, // nouns Nouns
  { community: "mfers", address: "0x79fcdef22feed20eddacbb2587640e45491b757f", chain: 1, standard: "erc721", startBlock: 12287507 }, // mfers
  { community: "kitchen_just_t00ns", address: "0x902d94ba5bfc0cb408d1a6ca4b8f255d845e50e9", chain: 1, standard: "erc721", startBlock: 12287507 }, // kitchen_just_t00ns (eip155:1; physical_job ingest_8782378e4d8efdc03716488212ee7552_8153d3ff68e8a8e4)
  { community: "honeyjar2", address: "0x1b2751328f41d1a0b91f3710edcd33e996591b72", chain: 42161, standard: "erc721", startBlock: 102894033 }, // HoneyJar2
  { community: "honeyjar3", address: "0xe798c4d40bc050bc93c7f3b149a0dfe5cfc49fb0", chain: 7777777, standard: "erc721", startBlock: 18071873 }, // HoneyJar3
  { community: "honeyjar4", address: "0xe1d16cc75c9f39a2e0f5131eb39d4b634b23f301", chain: 10, standard: "erc721", startBlock: 125752663 }, // HoneyJar4
  { community: "mirrorobservability", address: "0x4c2393aae4f0ad55dfd4ddcfa192f817d1b28d1f", chain: 10, standard: "erc721", startBlock: 107558369 },
  { community: "lore_1_introducing_mibera", address: "0x6b31859e5e32a5212f1ba4d7b377604b9d4c7a60", chain: 10, standard: "erc721", startBlock: 107558369 }, // lore_1_introducing_mibera
  { community: "lore_2_honey_online_offline", address: "0x9247edf18518c4dccfa7f8b2345a1e8a4738204f", chain: 10, standard: "erc721", startBlock: 107558369 }, // lore_2_honey_online_offline
  { community: "lore_3_bera_kali_acc", address: "0xb2c7f411aa425d3fce42751e576a01b1ff150385", chain: 10, standard: "erc721", startBlock: 107558369 }, // lore_3_bera_kali_acc
  { community: "lore_4_bgt_network_spirituality", address: "0xa12064e3b1f6102435e77aa68569e79955070357", chain: 10, standard: "erc721", startBlock: 107558369 }, // lore_4_bgt_network_spirituality
  { community: "lore_5_initiation_ritual", address: "0x6ca29eed22f04c1ec6126c59922844811dcbcdfa", chain: 10, standard: "erc721", startBlock: 107558369 }, // lore_5_initiation_ritual
  { community: "lore_6_miberamaker_design", address: "0x7988434e1469d35fa5f442e649de45d47c3df23c", chain: 10, standard: "erc721", startBlock: 107558369 }, // lore_6_miberamaker_design
  { community: "lore_7_miberamaker_design", address: "0x96c200ec4cca0bc57444cfee888cfba78a1ddbd8", chain: 10, standard: "erc721", startBlock: 107558369 }, // lore_7_miberamaker_design
  { community: "honeyjar5", address: "0xbad7b49d985bbfd3a22706c447fb625a28f048b4", chain: 8453, standard: "erc721", startBlock: 23252723 }, // HoneyJar5
  { community: "based_punks", address: "0xcb28749c24af4797808364d71d71539bc01e76d4", chain: 8453, standard: "erc721", startBlock: 2883449 }, // based_punks (deploy 12774442)
  { community: "hypio", address: "0x3319197b0d0f8ccd1087f2d2e47a8fb7c0710171", chain: 8453, standard: "erc721", startBlock: 2883449 }, // hypio (deploy 24834458)
  { community: "kemonokaki", address: "0xee7d1b184be8185adc7052635329152a4d0cdefa", chain: 8453, standard: "erc721", startBlock: 2883449 }, // kemonokaki (deploy 16046941)
  { community: "warplets", address: "0x699727f9e01a822efdcf7333073f0461e5914b4e", chain: 8453, standard: "erc721", startBlock: 2883449 }, // warplets (deploy 37366750)
  { community: "lil_bangers", address: "0x1260f90e0b1c482b38b88f26dee17c57615d670b", chain: 8453, standard: "erc721", startBlock: 2883449 }, // lil_bangers (deploy 33642811)
  { community: "based_onchain_punks", address: "0x9e7a06c281355f60570e47a12650c89fe1d36ff3", chain: 8453, standard: "erc721", startBlock: 2883449 }, // based_onchain_punks (deploy 2883449)
  { community: "nodes_by_hunter", address: "0x95bc4c2e01c2e2d9e537e7a9fe58187e88dd8019", chain: 8453, standard: "erc721", startBlock: 2883449 }, // nodes_by_hunter (deploy 33916538)
  { community: "veecon_2024_tickets", address: "0x20fd75eccd7bb9c4eb9e3bb4c09c6b382e15d63e", chain: 8453, standard: "erc721", startBlock: 2883449 }, // veecon_2024_tickets (deploy 14459222)
  { community: "honeyjar1_bera", address: "0xedc5dfd6f37464cc91bbce572b6fe2c97f1bc7b3", chain: 80094, standard: "erc721", startBlock: 2863795 }, // HoneyJar1 Bera
  { community: "honeyjar2_bera", address: "0x1c6c24cac266c791c4ba789c3ec91f04331725bd", chain: 80094, standard: "erc721", startBlock: 2863795 }, // HoneyJar2 Bera
  { community: "honeyjar3_bera", address: "0xf1e4a550772fabfc35b28b51eb8d0b6fcd1c4878", chain: 80094, standard: "erc721", startBlock: 2863795 }, // HoneyJar3 Bera
  { community: "honeyjar4_bera", address: "0xdb602ab4d6bd71c8d11542a9c8c936877a9a4f45", chain: 80094, standard: "erc721", startBlock: 2863795 }, // HoneyJar4 Bera
  { community: "honeyjar5_bera", address: "0x0263728e7f59f315c17d3c180aeade027a375f17", chain: 80094, standard: "erc721", startBlock: 2863795 }, // HoneyJar5 Bera
  { community: "honeyjar6_bera", address: "0xb62a9a21d98478f477e134e175fd2003c15cb83a", chain: 80094, standard: "erc721", startBlock: 2863795 }, // HoneyJar6 Bera
  { community: "honeycomb_bera", address: "0x886d2176d899796cd1affa07eff07b9b2b80f1be", chain: 80094, standard: "erc721", startBlock: 887123 }, // Honeycomb Bera
  { community: "mibera_tarot", address: "0x4b08a069381efbb9f08c73d6b2e975c9be3c4684", chain: 80094, standard: "erc721", startBlock: 4029732 }, // mibera_tarot / mibera_quiz
  { community: "miparcels", address: "0x86db98cf1b81e833447b12a077ac28c36b75c8e1", chain: 80094, standard: "erc721", startBlock: 4029732 }, // fracture #1: miparcels
  { community: "miladies", address: "0x8d4972bd5d2df474e71da6676a365fb549853991", chain: 80094, standard: "erc721", startBlock: 4029732 }, // fracture #2: miladies (Miladies on Berachain)
  { community: "mireveal_1_1", address: "0x144b27b1a267ee71989664b3907030da84cc4754", chain: 80094, standard: "erc721", startBlock: 4029732 }, // fracture #3: mireveal_1_1
  { community: "mireveal_2_2", address: "0x72db992e18a1bf38111b1936dd723e82d0d96313", chain: 80094, standard: "erc721", startBlock: 4029732 }, // fracture #4: mireveal_2_2
  { community: "mireveal_3_3", address: "0x3a00301b713be83ec54b7b4fb0f86397d087e6d3", chain: 80094, standard: "erc721", startBlock: 4029732 }, // fracture #5: mireveal_3_3
  { community: "mireveal_4_20", address: "0x419f25c4f9a9c730aacf58b8401b5b3e566fe886", chain: 80094, standard: "erc721", startBlock: 4029732 }, // fracture #6: mireveal_4_20
  { community: "mireveal_5_5", address: "0x81a27117bd894942ba6737402fb9e57e942c6058", chain: 80094, standard: "erc721", startBlock: 4029732 }, // fracture #7: mireveal_5_5
  { community: "mireveal_6_6", address: "0xaab7b4502251ae393d0590bab3e208e2d58f4813", chain: 80094, standard: "erc721", startBlock: 4029732 }, // fracture #8: mireveal_6_6
  { community: "mireveal_7_7", address: "0xc64126ea8dc7626c16daa2a29d375c33fcaa4c7c", chain: 80094, standard: "erc721", startBlock: 4029732 }, // fracture #9: mireveal_7_7
  { community: "mireveal_8_8", address: "0x24f4047d372139de8dacbe79e2fc576291ec3ffc", chain: 80094, standard: "erc721", startBlock: 4029732 }, // fracture #10: mireveal_8_8
  { community: "fractured_mibera_1", address: "0x6956dae88c00372b1a0b2dfbfe5eed19f85b0d4b", chain: 80094, standard: "erc721", startBlock: 4029732 }, // Fractured Mibera 1
  { community: "fractured_mibera_3", address: "0x77ec6b83495974a5b2c5bef943b0f2e5acd8fc26", chain: 80094, standard: "erc721", startBlock: 4029732 }, // Fractured Mibera 3
  { community: "fractured_mibera_4", address: "0xc557bf6c7d21ba98a40ddfe2beaba682c49d17a9", chain: 80094, standard: "erc721", startBlock: 4029732 }, // Fractured Mibera 4
  { community: "fractured_mibera_5", address: "0xbcb082bb41e892f29d9c600eaadea698d5f712ef", chain: 80094, standard: "erc721", startBlock: 4029732 }, // Fractured Mibera 5
  { community: "fractured_mibera_6", address: "0x2030f226bf9a0c88687e83accdcefb7dae260094", chain: 80094, standard: "erc721", startBlock: 4029732 }, // Fractured Mibera 6
  { community: "fractured_mibera_7", address: "0xcc426f9375c5edcef5ca6bdb0449c07113348cf7", chain: 80094, standard: "erc721", startBlock: 4029732 }, // Fractured Mibera 7
  { community: "fractured_mibera_8", address: "0xf68f40230e39067ee7c98fe9a8641fc124c5be60", chain: 80094, standard: "erc721", startBlock: 4029732 }, // Fractured Mibera 8
  { community: "fractured_mibera_9", address: "0xfc79b1bcca172ff5a8f74205c82f5cbb0125dd10", chain: 80094, standard: "erc721", startBlock: 4029732 }, // Fractured Mibera 9
  { community: "fractured_mibera_10", address: "0xa3d3ef45712631a6fb50c677762b8653f932cf71", chain: 80094, standard: "erc721", startBlock: 4029732 }, // Fractured Mibera 10
  { community: "apdao_seat", address: "0xfc2d7ebfeb2714fce13caf234a95db129ecc43da", chain: 80094, standard: "erc721", startBlock: 4029732 }, // apdao_seat
  { community: "mibera_vm_mibera_shadows", address: "0x048327a187b944ddac61c6e202bfccd20d17c008", chain: 80094, standard: "erc721", startBlock: 4130866 }, // mibera_vm / mibera_shadows
  { community: "mibera_gif", address: "0x230945e0ed56ef4de871a6c0695de265de23d8d8", chain: 80094, standard: "erc721", startBlock: 4130866 }, // mibera_gif
  { community: "mibera_collection", address: "0x6666397dfe9a8c469bf65dc744cb1c733416c420", chain: 80094, standard: "erc721", startBlock: 3837808 }, // Mibera Collection

  // Custody addresses — not indexed. A vault or escrow holds tokens on a user's
  // behalf, so crediting it as the holder strips the depositor.
  //
  // Blur Blend is Blur's NFT lending protocol: a BNPL/loan purchase parks the NFT
  // in Blend while the loan is open. Measured 2026-07-31 over 55k blocks it took
  // custody of 382 tokens from THIS registry's collections (Pudgy 80, MAYC 63,
  // Azuki 62, Lil Pudgys 51, BAYC 51) and released 343 — so without this entry
  // Blend would rank as a top holder of five tracked collections and every
  // borrower would silently lose credit for the duration of their loan. Same
  // class as the Mibera staking bug below, found while replaying real Blur fills.
  { community: "blur_blend", address: "0x29469395eaf6f95920e59f858042f0e28d98a20b", chain: 1, standard: "erc721", startBlock: 17603892, custodial: true }, // Blur: Blend (cross-collection escrow)

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
