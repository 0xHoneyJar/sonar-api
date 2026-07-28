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
 * `binding` is the Envio contract name this address is bound to in config.yaml.
 * It exists so the registry can be checked against — and eventually generate —
 * the belt config; it is not an identity field.
 *
 * Invariant, enforced by test/contract-registry.test.ts: every (chain, address)
 * declared in config.yaml resolves from this file, with the same startBlock.
 */

export type TokenStandard =
  | "erc721"
  | "erc1155"
  | "erc20"
  | "seaport"
  | "other";

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
  /** Envio contract name in config.yaml. */
  readonly binding: string;
}

// prettier-ignore
export const CONTRACTS: readonly ContractEntry[] = [
  { community: "honeyjar1", address: "0xa20cf9b0874c3e46b344deaeea9c2e0c3e1db37d", chain: 1, standard: "erc721", startBlock: 17085858, binding: "HoneyJar" }, // HoneyJar1
  { community: "honeyjar6", address: "0x98dc31a9648f04e23e4e36b0456d1951531c2a05", chain: 1, standard: "erc721", startBlock: 17085858, binding: "HoneyJar" }, // HoneyJar6
  { community: "honeycomb", address: "0xcb0477d1af5b8b05795d89d59f4667b59eae9244", chain: 1, standard: "erc721", startBlock: 16751283, binding: "Honeycomb" },
  { community: "honeyjar2_l0_remint", address: "0x3f4dd25ba6fb6441bfd1a869cbda6a511966456d", chain: 1, standard: "erc721", startBlock: 17516342, binding: "HoneyJar2Eth" }, // HoneyJar2 L0 remint
  { community: "honeyjar3_l0_remint", address: "0x49f3915a52e137e597d6bf11c73e78c68b082297", chain: 1, standard: "erc721", startBlock: 20463444, binding: "HoneyJar3Eth" }, // HoneyJar3 L0 remint (was missing!)
  { community: "honeyjar4_l0_remint", address: "0x0b820623485dcfb1c40a70c55755160f6a42186d", chain: 1, standard: "erc721", startBlock: 20814248, binding: "HoneyJar4Eth" }, // HoneyJar4 L0 remint (was missing!)
  { community: "honeyjar5_l0_remint", address: "0x39eb35a84752b4bd3459083834af1267d276a54c", chain: 1, standard: "erc721", startBlock: 21327296, binding: "HoneyJar5Eth" }, // HoneyJar5 L0 remint (was missing!)
  { community: "milady_maker", address: "0x5af0d9827e0c53e4799bb226655a1de152a425a5", chain: 1, standard: "erc721", startBlock: 12287507, binding: "MiladyCollection" }, // Milady Maker
  { community: "azuki", address: "0xed5af388653567af2f388e6224dc7c4b3241c544", chain: 1, standard: "erc721", startBlock: 12287507, binding: "EthTrackedErc721" }, // azuki (canonical, verified on Etherscan)
  { community: "azuki_beanz_official", address: "0x306b1ea3ecdf94ab739f1910bbda052ed4a9f949", chain: 1, standard: "erc721", startBlock: 12287507, binding: "EthTrackedErc721" }, // azuki BEANZ Official
  { community: "azuki_elementals", address: "0xb6a37b5d14d502c3ab0ae6f3a0e058bc9517786e", chain: 1, standard: "erc721", startBlock: 12287507, binding: "EthTrackedErc721" }, // azuki Elementals
  { community: "azuki_bobu_the_bean_farmer", address: "0x2079812353e2c9409a788fbf5f383fa62ad85be8", chain: 1, standard: "erc721", startBlock: 12287507, binding: "EthTrackedErc721" }, // azuki Bobu the Bean Farmer
  { community: "yuga_bored_ape_yacht_club", address: "0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d", chain: 1, standard: "erc721", startBlock: 12287507, binding: "EthTrackedErc721" }, // yuga Bored Ape Yacht Club
  { community: "yuga_mutant_ape_yacht_club", address: "0x60e4d786628fea6478f785a6d7e704777c86a7c6", chain: 1, standard: "erc721", startBlock: 12287507, binding: "EthTrackedErc721" }, // yuga Mutant Ape Yacht Club
  { community: "yuga_bored_ape_kennel_club", address: "0xba30e5f9bb24c19c9002c35c7098ad4a0f7ff53b", chain: 1, standard: "erc721", startBlock: 12287507, binding: "EthTrackedErc721" }, // yuga Bored Ape Kennel Club
  { community: "pudgy_penguins_pudgy_penguins", address: "0xbd3531da5cf5857e7cfaa92426877b022e612cf8", chain: 1, standard: "erc721", startBlock: 12287507, binding: "EthTrackedErc721" }, // pudgy-penguins Pudgy Penguins
  { community: "pudgy_penguins_lil_pudgys", address: "0x524cab2ec69124574082676e6f654a18df49a048", chain: 1, standard: "erc721", startBlock: 12287507, binding: "EthTrackedErc721" }, // pudgy-penguins Lil Pudgys
  { community: "remilia_redacted_remilio_babies", address: "0xd3d9ddd0cf0a5f0bfb8f7fceae075df687eaebab", chain: 1, standard: "erc721", startBlock: 12287507, binding: "EthTrackedErc721" }, // remilia Redacted Remilio Babies
  { community: "doodles_doodles", address: "0x8a90cab2b38dba80c64b7734e58ee1db38b8992e", chain: 1, standard: "erc721", startBlock: 12287507, binding: "EthTrackedErc721" }, // doodles Doodles
  { community: "moonbirds_moonbirds", address: "0x23581767a106ae21c074b2276d25e5c3e136a68b", chain: 1, standard: "erc721", startBlock: 12287507, binding: "EthTrackedErc721" }, // moonbirds Moonbirds
  { community: "nouns_nouns", address: "0x9c8ff314c9bc7f6e59a9d9225fb22946427edc03", chain: 1, standard: "erc721", startBlock: 12287507, binding: "EthTrackedErc721" }, // nouns Nouns
  { community: "mfers", address: "0x79fcdef22feed20eddacbb2587640e45491b757f", chain: 1, standard: "erc721", startBlock: 12287507, binding: "EthTrackedErc721" }, // mfers
  { community: "kitchen_just_t00ns", address: "0x902d94ba5bfc0cb408d1a6ca4b8f255d845e50e9", chain: 1, standard: "erc721", startBlock: 12287507, binding: "EthTrackedErc721" }, // kitchen_just_t00ns (eip155:1; physical_job ingest_8782378e4d8efdc03716488212ee7552_8153d3ff68e8a8e4)
  { community: "seaport_v1_1", address: "0x00000000006c3852cbef3e08e8df289169ede581", chain: 1, standard: "seaport", startBlock: 14162194, binding: "Seaport" }, // Seaport v1.1
  { community: "seaport_v1_4", address: "0x00000000000001ad428e4906ae43d8f9852d0dd6", chain: 1, standard: "seaport", startBlock: 14162194, binding: "Seaport" }, // Seaport v1.4
  { community: "seaport_v1_5", address: "0x00000000000000adc04c56bf30ac9d3c0aaf14dc", chain: 1, standard: "seaport", startBlock: 14162194, binding: "Seaport" }, // Seaport v1.5
  { community: "seaport_v1_6", address: "0x0000000000000068f116a894984e2db1123eb395", chain: 1, standard: "seaport", startBlock: 14162194, binding: "Seaport" }, // Seaport v1.6
  { community: "honeyjar2", address: "0x1b2751328f41d1a0b91f3710edcd33e996591b72", chain: 42161, standard: "erc721", startBlock: 102894033, binding: "HoneyJar" }, // HoneyJar2
  { community: "honeyjar3", address: "0xe798c4d40bc050bc93c7f3b149a0dfe5cfc49fb0", chain: 7777777, standard: "erc721", startBlock: 18071873, binding: "HoneyJar" }, // HoneyJar3
  { community: "honeyjar4", address: "0xe1d16cc75c9f39a2e0f5131eb39d4b634b23f301", chain: 10, standard: "erc721", startBlock: 125752663, binding: "HoneyJar" }, // HoneyJar4
  { community: "honeycomb_bera", address: "0x886d2176d899796cd1affa07eff07b9b2b80f1be", chain: 10, standard: "erc1155", startBlock: 125031052, binding: "MiberaSets" }, // Honeycomb Bera
  { community: "mibera_zora", address: "0x427a8f2e608e185eece69aca15e535cd6c36aad8", chain: 10, standard: "erc1155", startBlock: 112614910, binding: "MiberaZora1155" }, // mibera_zora
  { community: "mirrorobservability", address: "0x4c2393aae4f0ad55dfd4ddcfa192f817d1b28d1f", chain: 10, standard: "erc721", startBlock: 107558369, binding: "MirrorObservability" },
  { community: "lore_1_introducing_mibera", address: "0x6b31859e5e32a5212f1ba4d7b377604b9d4c7a60", chain: 10, standard: "erc721", startBlock: 107558369, binding: "TrackedErc721" }, // lore_1_introducing_mibera
  { community: "lore_2_honey_online_offline", address: "0x9247edf18518c4dccfa7f8b2345a1e8a4738204f", chain: 10, standard: "erc721", startBlock: 107558369, binding: "TrackedErc721" }, // lore_2_honey_online_offline
  { community: "lore_3_bera_kali_acc", address: "0xb2c7f411aa425d3fce42751e576a01b1ff150385", chain: 10, standard: "erc721", startBlock: 107558369, binding: "TrackedErc721" }, // lore_3_bera_kali_acc
  { community: "lore_4_bgt_network_spirituality", address: "0xa12064e3b1f6102435e77aa68569e79955070357", chain: 10, standard: "erc721", startBlock: 107558369, binding: "TrackedErc721" }, // lore_4_bgt_network_spirituality
  { community: "lore_5_initiation_ritual", address: "0x6ca29eed22f04c1ec6126c59922844811dcbcdfa", chain: 10, standard: "erc721", startBlock: 107558369, binding: "TrackedErc721" }, // lore_5_initiation_ritual
  { community: "lore_6_miberamaker_design", address: "0x7988434e1469d35fa5f442e649de45d47c3df23c", chain: 10, standard: "erc721", startBlock: 107558369, binding: "TrackedErc721" }, // lore_6_miberamaker_design
  { community: "lore_7_miberamaker_design", address: "0x96c200ec4cca0bc57444cfee888cfba78a1ddbd8", chain: 10, standard: "erc721", startBlock: 107558369, binding: "TrackedErc721" }, // lore_7_miberamaker_design
  { community: "honeyjar5", address: "0xbad7b49d985bbfd3a22706c447fb625a28f048b4", chain: 8453, standard: "erc721", startBlock: 23252723, binding: "HoneyJar" }, // HoneyJar5
  { community: "friendtechshares", address: "0xcf205808ed36593aa40a44f10c7f7c2f67d4a4d4", chain: 8453, standard: "other", startBlock: 2430439, binding: "FriendtechShares" },
  { community: "miberamaker333", address: "0x120756ccc6f0cefb43a753e1f2534377c2694bb4", chain: 8453, standard: "erc20", startBlock: 33657372, binding: "TrackedErc20" }, // MiberaMaker333
  { community: "apiculture_szn_0", address: "0x6cfb9280767a3596ee6af887d900014a755ffc75", chain: 8453, standard: "erc1155", startBlock: 13803165, binding: "PuruApiculture1155" }, // Apiculture Szn 0 (Zora, token ID 4 = Purupuru edition)
  { community: "puru_elemental_jani", address: "0xcd3ab1b6e95cdb40a19286d863690eb407335b21", chain: 8453, standard: "erc1155", startBlock: 13803165, binding: "PuruApiculture1155" }, // puru_elemental_jani
  { community: "puru_boarding_passes", address: "0x154a563ab6c037bd0f041ac91600ffa9fe2f5fa0", chain: 8453, standard: "erc1155", startBlock: 13803165, binding: "PuruApiculture1155" }, // puru_boarding_passes
  { community: "puru_introducing_kizuna", address: "0x85a72eee14dcaa1ccc5616df39acde212280dccb", chain: 8453, standard: "erc1155", startBlock: 13803165, binding: "PuruApiculture1155" }, // puru_introducing_kizuna
  { community: "based_punks", address: "0xcb28749c24af4797808364d71d71539bc01e76d4", chain: 8453, standard: "erc721", startBlock: 2883449, binding: "TrackedErc721" }, // based_punks (deploy 12774442)
  { community: "hypio", address: "0x3319197b0d0f8ccd1087f2d2e47a8fb7c0710171", chain: 8453, standard: "erc721", startBlock: 2883449, binding: "TrackedErc721" }, // hypio (deploy 24834458)
  { community: "kemonokaki", address: "0xee7d1b184be8185adc7052635329152a4d0cdefa", chain: 8453, standard: "erc721", startBlock: 2883449, binding: "TrackedErc721" }, // kemonokaki (deploy 16046941)
  { community: "warplets", address: "0x699727f9e01a822efdcf7333073f0461e5914b4e", chain: 8453, standard: "erc721", startBlock: 2883449, binding: "TrackedErc721" }, // warplets (deploy 37366750)
  { community: "lil_bangers", address: "0x1260f90e0b1c482b38b88f26dee17c57615d670b", chain: 8453, standard: "erc721", startBlock: 2883449, binding: "TrackedErc721" }, // lil_bangers (deploy 33642811)
  { community: "based_onchain_punks", address: "0x9e7a06c281355f60570e47a12650c89fe1d36ff3", chain: 8453, standard: "erc721", startBlock: 2883449, binding: "TrackedErc721" }, // based_onchain_punks (deploy 2883449)
  { community: "nodes_by_hunter", address: "0x95bc4c2e01c2e2d9e537e7a9fe58187e88dd8019", chain: 8453, standard: "erc721", startBlock: 2883449, binding: "TrackedErc721" }, // nodes_by_hunter (deploy 33916538)
  { community: "veecon_2024_tickets", address: "0x20fd75eccd7bb9c4eb9e3bb4c09c6b382e15d63e", chain: 8453, standard: "erc721", startBlock: 2883449, binding: "TrackedErc721" }, // veecon_2024_tickets (deploy 14459222)
  { community: "seaport_v1_1", address: "0x00000000006c3852cbef3e08e8df289169ede581", chain: 8453, standard: "seaport", startBlock: 2883449, binding: "Seaport" }, // Seaport v1.1
  { community: "seaport_v1_4", address: "0x00000000000001ad428e4906ae43d8f9852d0dd6", chain: 8453, standard: "seaport", startBlock: 2883449, binding: "Seaport" }, // Seaport v1.4
  { community: "seaport_v1_5", address: "0x00000000000000adc04c56bf30ac9d3c0aaf14dc", chain: 8453, standard: "seaport", startBlock: 2883449, binding: "Seaport" }, // Seaport v1.5
  { community: "seaport_v1_6", address: "0x0000000000000068f116a894984e2db1123eb395", chain: 8453, standard: "seaport", startBlock: 2883449, binding: "Seaport" }, // Seaport v1.6
  { community: "aquabera_forwarder", address: "0xc0c6d4178410849ec9765b4267a73f4f64241832", chain: 80094, standard: "other", startBlock: 784898, binding: "AquaberaVault" }, // Aquabera forwarder (user deposits through UI)
  { community: "aquabera_henlo_bera_vault", address: "0x04fd6a7b02e2e48caedad7135420604de5f834f8", chain: 80094, standard: "other", startBlock: 1871321, binding: "AquaberaVaultDirect" }, // Aquabera HENLO/BERA vault (direct deposits/withdrawals)
  { community: "honeyjar1_bera", address: "0xedc5dfd6f37464cc91bbce572b6fe2c97f1bc7b3", chain: 80094, standard: "erc721", startBlock: 2863795, binding: "HoneyJar" }, // HoneyJar1 Bera
  { community: "honeyjar2_bera", address: "0x1c6c24cac266c791c4ba789c3ec91f04331725bd", chain: 80094, standard: "erc721", startBlock: 2863795, binding: "HoneyJar" }, // HoneyJar2 Bera
  { community: "honeyjar3_bera", address: "0xf1e4a550772fabfc35b28b51eb8d0b6fcd1c4878", chain: 80094, standard: "erc721", startBlock: 2863795, binding: "HoneyJar" }, // HoneyJar3 Bera
  { community: "honeyjar4_bera", address: "0xdb602ab4d6bd71c8d11542a9c8c936877a9a4f45", chain: 80094, standard: "erc721", startBlock: 2863795, binding: "HoneyJar" }, // HoneyJar4 Bera
  { community: "honeyjar5_bera", address: "0x0263728e7f59f315c17d3c180aeade027a375f17", chain: 80094, standard: "erc721", startBlock: 2863795, binding: "HoneyJar" }, // HoneyJar5 Bera
  { community: "honeyjar6_bera", address: "0xb62a9a21d98478f477e134e175fd2003c15cb83a", chain: 80094, standard: "erc721", startBlock: 2863795, binding: "HoneyJar" }, // HoneyJar6 Bera
  { community: "honeycomb_bera", address: "0x886d2176d899796cd1affa07eff07b9b2b80f1be", chain: 80094, standard: "erc721", startBlock: 887123, binding: "Honeycomb" }, // Honeycomb Bera
  { community: "moneycombvault", address: "0x9279b2227b57f349a0ce552b25af341e735f6309", chain: 80094, standard: "other", startBlock: 6954915, binding: "MoneycombVault" },
  { community: "crayonsfactory", address: "0xf1c7d49b39a5aca29ead398ad9a7024ed6837f87", chain: 80094, standard: "other", startBlock: 8702687, binding: "CrayonsFactory" },
  { community: "mibera_tarot", address: "0x4b08a069381efbb9f08c73d6b2e975c9be3c4684", chain: 80094, standard: "erc721", startBlock: 4029732, binding: "TrackedErc721" }, // mibera_tarot / mibera_quiz
  { community: "miparcels", address: "0x86db98cf1b81e833447b12a077ac28c36b75c8e1", chain: 80094, standard: "erc721", startBlock: 4029732, binding: "TrackedErc721" }, // fracture #1: miparcels
  { community: "miladies", address: "0x8d4972bd5d2df474e71da6676a365fb549853991", chain: 80094, standard: "erc721", startBlock: 4029732, binding: "TrackedErc721" }, // fracture #2: miladies (Miladies on Berachain)
  { community: "mireveal_1_1", address: "0x144b27b1a267ee71989664b3907030da84cc4754", chain: 80094, standard: "erc721", startBlock: 4029732, binding: "TrackedErc721" }, // fracture #3: mireveal_1_1
  { community: "mireveal_2_2", address: "0x72db992e18a1bf38111b1936dd723e82d0d96313", chain: 80094, standard: "erc721", startBlock: 4029732, binding: "TrackedErc721" }, // fracture #4: mireveal_2_2
  { community: "mireveal_3_3", address: "0x3a00301b713be83ec54b7b4fb0f86397d087e6d3", chain: 80094, standard: "erc721", startBlock: 4029732, binding: "TrackedErc721" }, // fracture #5: mireveal_3_3
  { community: "mireveal_4_20", address: "0x419f25c4f9a9c730aacf58b8401b5b3e566fe886", chain: 80094, standard: "erc721", startBlock: 4029732, binding: "TrackedErc721" }, // fracture #6: mireveal_4_20
  { community: "mireveal_5_5", address: "0x81a27117bd894942ba6737402fb9e57e942c6058", chain: 80094, standard: "erc721", startBlock: 4029732, binding: "TrackedErc721" }, // fracture #7: mireveal_5_5
  { community: "mireveal_6_6", address: "0xaab7b4502251ae393d0590bab3e208e2d58f4813", chain: 80094, standard: "erc721", startBlock: 4029732, binding: "TrackedErc721" }, // fracture #8: mireveal_6_6
  { community: "mireveal_7_7", address: "0xc64126ea8dc7626c16daa2a29d375c33fcaa4c7c", chain: 80094, standard: "erc721", startBlock: 4029732, binding: "TrackedErc721" }, // fracture #9: mireveal_7_7
  { community: "mireveal_8_8", address: "0x24f4047d372139de8dacbe79e2fc576291ec3ffc", chain: 80094, standard: "erc721", startBlock: 4029732, binding: "TrackedErc721" }, // fracture #10: mireveal_8_8
  { community: "fractured_mibera_1", address: "0x6956dae88c00372b1a0b2dfbfe5eed19f85b0d4b", chain: 80094, standard: "erc721", startBlock: 4029732, binding: "TrackedErc721" }, // Fractured Mibera 1
  { community: "fractured_mibera_3", address: "0x77ec6b83495974a5b2c5bef943b0f2e5acd8fc26", chain: 80094, standard: "erc721", startBlock: 4029732, binding: "TrackedErc721" }, // Fractured Mibera 3
  { community: "fractured_mibera_4", address: "0xc557bf6c7d21ba98a40ddfe2beaba682c49d17a9", chain: 80094, standard: "erc721", startBlock: 4029732, binding: "TrackedErc721" }, // Fractured Mibera 4
  { community: "fractured_mibera_5", address: "0xbcb082bb41e892f29d9c600eaadea698d5f712ef", chain: 80094, standard: "erc721", startBlock: 4029732, binding: "TrackedErc721" }, // Fractured Mibera 5
  { community: "fractured_mibera_6", address: "0x2030f226bf9a0c88687e83accdcefb7dae260094", chain: 80094, standard: "erc721", startBlock: 4029732, binding: "TrackedErc721" }, // Fractured Mibera 6
  { community: "fractured_mibera_7", address: "0xcc426f9375c5edcef5ca6bdb0449c07113348cf7", chain: 80094, standard: "erc721", startBlock: 4029732, binding: "TrackedErc721" }, // Fractured Mibera 7
  { community: "fractured_mibera_8", address: "0xf68f40230e39067ee7c98fe9a8641fc124c5be60", chain: 80094, standard: "erc721", startBlock: 4029732, binding: "TrackedErc721" }, // Fractured Mibera 8
  { community: "fractured_mibera_9", address: "0xfc79b1bcca172ff5a8f74205c82f5cbb0125dd10", chain: 80094, standard: "erc721", startBlock: 4029732, binding: "TrackedErc721" }, // Fractured Mibera 9
  { community: "fractured_mibera_10", address: "0xa3d3ef45712631a6fb50c677762b8653f932cf71", chain: 80094, standard: "erc721", startBlock: 4029732, binding: "TrackedErc721" }, // Fractured Mibera 10
  { community: "apdao_seat", address: "0xfc2d7ebfeb2714fce13caf234a95db129ecc43da", chain: 80094, standard: "erc721", startBlock: 4029732, binding: "TrackedErc721" }, // apdao_seat
  { community: "mibera_vm_mibera_shadows", address: "0x048327a187b944ddac61c6e202bfccd20d17c008", chain: 80094, standard: "erc721", startBlock: 4130866, binding: "GeneralMints" }, // mibera_vm / mibera_shadows
  { community: "mibera_gif", address: "0x230945e0ed56ef4de871a6c0695de265de23d8d8", chain: 80094, standard: "erc721", startBlock: 4130866, binding: "GeneralMints" }, // mibera_gif
  { community: "paddlefi_mibera_wbera_vault", address: "0x242b7126f3c4e4f8cbd7f62571293e63e9b0a4e1", chain: 80094, standard: "other", startBlock: 5604652, binding: "PaddleFi" }, // PaddleFi MIBERA-WBERA vault
  { community: "mibera_drugs_mibera_candies", address: "0x80283fbf2b8e50f6ddf9bfc4a90a8336bc90e38f", chain: 80094, standard: "erc1155", startBlock: 3716959, binding: "CandiesMarket1155" }, // mibera_drugs / mibera_candies (SilkRoad marketplace)
  { community: "mibera_drugs_mibera_candies", address: "0xeca03517c5195f1edd634da6d690d6c72407c40c", chain: 80094, standard: "erc1155", startBlock: 3716959, binding: "CandiesMarket1155" }, // mibera_drugs / mibera_candies (secondary)
  { community: "cub_universal_badges", address: "0x574617ab9788e614b3eb3f7bd61334720d9e1aac", chain: 80094, standard: "erc1155", startBlock: 1080991, binding: "CubBadges1155" }, // Cub Universal Badges (mainnet)
  { community: "fatberadeposits", address: "0xbae11292a3e693af73651bda350d752ae4a391d4", chain: 80094, standard: "other", startBlock: 1066385, binding: "FatBeraDeposits" },
  { community: "beacondeposit", address: "0x4242424242424242424242424242424242424242", chain: 80094, standard: "other", startBlock: 1066385, binding: "BeaconDeposit" },
  { community: "blockrewardcontroller", address: "0x1ae7dd7ae06f6c58b4524d9c1f816094b1bccd8e", chain: 80094, standard: "other", startBlock: 1066385, binding: "BlockRewardController" },
  { community: "automatedstake", address: "0x8ba92925c156ea522cd80b4633bd0a9824c3bcdf", chain: 80094, standard: "other", startBlock: 1966971, binding: "AutomatedStake" },
  { community: "validatorwithdrawalmodule", address: "0x81da3e3e0c0c541038646ace201ea17c4274bbcb", chain: 80094, standard: "other", startBlock: 1066385, binding: "ValidatorWithdrawalModule" },
  { community: "validatorwithdrawalmodule", address: "0xe9f68a1cfe403f84c7bd37a590cfe390a3250324", chain: 80094, standard: "other", startBlock: 1066385, binding: "ValidatorWithdrawalModule" },
  { community: "validatorwithdrawalmodule", address: "0x56c70e5efba5f18b04d17bbc580b6d37b3afe5ed", chain: 80094, standard: "other", startBlock: 1066385, binding: "ValidatorWithdrawalModule" },
  { community: "validatordepositrouter", address: "0x989212d8227a8957b9247e1966046b47a7a63d64", chain: 80094, standard: "other", startBlock: 1966971, binding: "ValidatorDepositRouter" },
  { community: "bgttoken", address: "0x656b95e550c07a9ffe548bd4085c72418ceb1dba", chain: 80094, standard: "erc20", startBlock: 8221, binding: "BgtToken" },
  { community: "hlkd1b_vault", address: "0x3bec4140eda07911208d4fc06b2f5adb7b5237fb", chain: 80094, standard: "other", startBlock: 14937664, binding: "SFVaultERC4626" }, // HLKD1B Vault
  { community: "hlkd690m_vault", address: "0x335d150495f6c8483773abc0e4fa5780dd270e78", chain: 80094, standard: "other", startBlock: 14937664, binding: "SFVaultERC4626" }, // HLKD690M Vault
  { community: "hlkd420m_vault", address: "0x2e2bdfdd4b786703b374aeeaa44195698a699dd1", chain: 80094, standard: "other", startBlock: 14937664, binding: "SFVaultERC4626" }, // HLKD420M Vault
  { community: "hlkd330m_vault", address: "0x91f321a8791fb899c6b860b9f54940c68cb45aed", chain: 80094, standard: "other", startBlock: 14937664, binding: "SFVaultERC4626" }, // HLKD330M Vault
  { community: "hlkd100m_vault", address: "0xee1087ec5d6a0a673c046b9acb15c93b7adb95ca", chain: 80094, standard: "other", startBlock: 14937664, binding: "SFVaultERC4626" }, // HLKD100M Vault
  { community: "hlkd1b_strategy", address: "0x39748c56511c02eb7be22225c4699f59fbb55b8f", chain: 80094, standard: "other", startBlock: 14937670, binding: "SFVaultStrategyWrapper" }, // HLKD1B Strategy
  { community: "hlkd690m_strategy", address: "0x447d56af16a0cfaff96536c7fd54f46bf56e160e", chain: 80094, standard: "other", startBlock: 14937670, binding: "SFVaultStrategyWrapper" }, // HLKD690M Strategy
  { community: "hlkd420m_strategy", address: "0xffa9dbbff80f736cde9e41427c0335f866854a9a", chain: 80094, standard: "other", startBlock: 14937670, binding: "SFVaultStrategyWrapper" }, // HLKD420M Strategy
  { community: "hlkd330m_strategy", address: "0x3032a263c651d9237b74cd6d47baf1345bf0930e", chain: 80094, standard: "other", startBlock: 14937670, binding: "SFVaultStrategyWrapper" }, // HLKD330M Strategy
  { community: "hlkd100m_strategy", address: "0xaee9aea23783057cbc890684464570ad9723be01", chain: 80094, standard: "other", startBlock: 14937670, binding: "SFVaultStrategyWrapper" }, // HLKD100M Strategy
  { community: "hlkd1b_multirewards", address: "0x34b3668e2ad47ccfe3c53e24a0606b911d1f6a8f", chain: 80094, standard: "other", startBlock: 15407908, binding: "SFMultiRewards" }, // HLKD1B MultiRewards (new)
  { community: "hlkd690m_multirewards", address: "0xd1cbf8f7f310947a7993abbd7fd6113794e353da", chain: 80094, standard: "other", startBlock: 15407908, binding: "SFMultiRewards" }, // HLKD690M MultiRewards (new)
  { community: "hlkd420m_multirewards", address: "0x827b7ea9fdb4322dbc6f9bf72c04871be859f20c", chain: 80094, standard: "other", startBlock: 15407908, binding: "SFMultiRewards" }, // HLKD420M MultiRewards (new)
  { community: "hlkd330m_multirewards", address: "0xacd0177bfcbc3760b03c87808b5423945f6bfaec", chain: 80094, standard: "other", startBlock: 15407908, binding: "SFMultiRewards" }, // HLKD330M MultiRewards (new)
  { community: "hlkd100m_multirewards", address: "0xb5b312fbf7eb145485ece55b862db94d626efa0f", chain: 80094, standard: "other", startBlock: 15407908, binding: "SFMultiRewards" }, // HLKD100M MultiRewards (new)
  { community: "henlovault", address: "0x42069e3bf367c403b632cf9cd5a8d61e2c0c44fc", chain: 80094, standard: "other", startBlock: 2041392, binding: "HenloVault" }, // HenloVault
  { community: "henlo_token", address: "0xb2f776e9c1c926c4b2e54182fac058da9af0b6a5", chain: 80094, standard: "erc20", startBlock: 839945, binding: "TrackedErc20" }, // HENLO token
  { community: "hlkd1b", address: "0xf0edfc3e122db34773293e0e5b2c3a58492e7338", chain: 80094, standard: "erc20", startBlock: 839945, binding: "TrackedErc20" }, // HLKD1B
  { community: "hlkd690m", address: "0x8ab854dc0672d7a13a85399a56cb628fb22102d6", chain: 80094, standard: "erc20", startBlock: 839945, binding: "TrackedErc20" }, // HLKD690M
  { community: "hlkd420m", address: "0xf07fa3ece9741d408d643748ff85710bedef25ba", chain: 80094, standard: "erc20", startBlock: 839945, binding: "TrackedErc20" }, // HLKD420M
  { community: "hlkd330m", address: "0x37dd8850919ebdca911c383211a70839a94b0539", chain: 80094, standard: "erc20", startBlock: 839945, binding: "TrackedErc20" }, // HLKD330M
  { community: "hlkd100m", address: "0x7bdf98ddeed209cfa26bd2352b470ac8b5485ec5", chain: 80094, standard: "erc20", startBlock: 839945, binding: "TrackedErc20" }, // HLKD100M
  { community: "mibera_liquid_backing", address: "0xaa04f13994a7fcd86f3bbbf4054d239b88f2744d", chain: 80094, standard: "other", startBlock: 3971122, binding: "MiberaLiquidBacking" }, // Mibera Liquid Backing
  { community: "mibera_collection", address: "0x6666397dfe9a8c469bf65dc744cb1c733416c420", chain: 80094, standard: "erc721", startBlock: 3837808, binding: "MiberaCollection" }, // Mibera Collection
  { community: "mibera_premint", address: "0xdd5f6f41b250644e5678d77654309a5b6a5f4d55", chain: 80094, standard: "other", startBlock: 2731326, binding: "MiberaPremint" }, // Mibera Premint
  { community: "seaport_v1_6", address: "0x0000000000000068f116a894984e2db1123eb395", chain: 80094, standard: "seaport", startBlock: 3837808, binding: "Seaport" }, // Seaport v1.6
  { community: "apdao_auction_house_proxy", address: "0xe840929cd47c6a1cf0f5d9b6d0c6277075680a0b", chain: 80094, standard: "other", startBlock: 5206807, binding: "ApdaoAuctionHouse" }, // APDAO Auction House Proxy
];

const byKey: ReadonlyMap<string, ContractEntry> = new Map(
  CONTRACTS.map((c) => [`${c.chain}:${c.address}`, c]),
);

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

/** chainId → the set of lowercased addresses tracked on that chain. */
export function addressesByChain(): ReadonlyMap<number, ReadonlySet<string>> {
  const out = new Map<number, Set<string>>();
  for (const c of CONTRACTS) {
    const set = out.get(c.chain) ?? new Set<string>();
    set.add(c.address);
    out.set(c.chain, set);
  }
  return out;
}

/**
 * address → community key, for every ERC-721 entry.
 *
 * Chain-agnostic by design: this is the collectionKey the ERC-721 handler
 * stamps on holder rows, and those keys are global. The only ERC-721 addresses
 * bound on more than one chain carry the same community key on each, so the
 * flattening is lossless (asserted in test/contract-registry.test.ts).
 */
export function erc721CollectionKeys(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const c of CONTRACTS) {
    if (c.standard === "erc721") out[c.address] = c.community;
  }
  return out;
}
