/**
 * ============================================================
 * MIBERA COLLECTION NAMING GLOSSARY
 * ============================================================
 *
 * NAMING ALIASES (same thing, different names):
 * - Mibera Shadows = Mibera VM (separate generative collection, NOT the main mibera)
 * - Mibera Tarot = Mibera Quiz (tarot cards from a quiz users took)
 * - Mibera Candies = Mibera Drugs (ERC1155 items, handled by mints1155.ts)
 *
 * FRACTURES (10-piece SBFT collection):
 * The Fractures are 10 SBFTs (soul bound fungible tokens) that form a complete set:
 * 1. miparcels
 * 2. miladies (Miladies on Berachain)
 * 3-10. mireveal_1_1 through mireveal_8_8
 *
 * ============================================================
 */

export const TRACKED_ERC721_COLLECTION_KEYS: Record<string, string> = {
  // NOTE: mibera main collection (0x6666397...) is handled by MiberaCollection handler
  // to avoid handler conflicts and enable full tracking (TrackedHolder + MiberaTransfer + MintActivity)

  // ===== MIBERA TAROT (aka "Mibera Quiz") =====
  // Tarot cards from a quiz users took - same thing, different names
  "0x4b08a069381efbb9f08c73d6b2e975c9be3c4684": "mibera_tarot",

  // ===== FRACTURES (10-piece SBFT collection) =====
  // All 10 contracts below are part of the "Fractures" set
  // These are SBFTs (soul bound fungible tokens) that form a complete collection
  "0x86db98cf1b81e833447b12a077ac28c36b75c8e1": "miparcels", // fracture #1
  "0x8d4972bd5d2df474e71da6676a365fb549853991": "miladies", // fracture #2: Miladies on Berachain
  "0x144b27b1a267ee71989664b3907030da84cc4754": "mireveal_1_1", // fracture #3
  "0x72db992e18a1bf38111b1936dd723e82d0d96313": "mireveal_2_2", // fracture #4
  "0x3a00301b713be83ec54b7b4fb0f86397d087e6d3": "mireveal_3_3", // fracture #5
  "0x419f25c4f9a9c730aacf58b8401b5b3e566fe886": "mireveal_4_20", // fracture #6
  "0x81a27117bd894942ba6737402fb9e57e942c6058": "mireveal_5_5", // fracture #7
  "0xaab7b4502251ae393d0590bab3e208e2d58f4813": "mireveal_6_6", // fracture #8
  "0xc64126ea8dc7626c16daa2a29d375c33fcaa4c7c": "mireveal_7_7", // fracture #9
  "0x24f4047d372139de8dacbe79e2fc576291ec3ffc": "mireveal_8_8", // fracture #10
  // NOTE: mibera_zora is ERC-1155 (Zora platform), handled by MiberaZora1155 handler
  // NOTE: puru collections are ERC-1155 (party.app), handled by PuruApiculture1155 handler

  // ===== COMMUNITY — Azuki (promoted from kitchen E2E to a real community 2026-07-07; #382 key decision) =====
  "0xed5af388653567af2f388e6224dcc93746104133": "azuki",

  // ===== BASE — COMMUNITY ONBOARDING BATCH 1 (top-10 ramp, #121) =====
  // 8 ERC-721s on Base (8453); the batch's 2 ERC-1155s (BasePaint, Parallel Planetfall)
  // are deferred to the 1155 lane. hypio's on-chain name is "Hypio" (marketplace label
  // "Wealthy Hypio Babies" — key follows on-chain truth).
  "0xcb28749c24af4797808364d71d71539bc01e76d4": "based_punks",
  "0x3319197b0d0f8ccd1087f2d2e47a8fb7c0710171": "hypio",
  "0xee7d1b184be8185adc7052635329152a4d0cdefa": "kemonokaki",
  "0x699727f9e01a822efdcf7333073f0461e5914b4e": "warplets",
  "0x1260f90e0b1c482b38b88f26dee17c57615d670b": "lil_bangers",
  "0x9e7a06c281355f60570e47a12650c89fe1d36ff3": "based_onchain_punks",
  "0x95bc4c2e01c2e2d9e537e7a9fe58187e88dd8019": "nodes_by_hunter",
  "0x20fd75eccd7bb9c4eb9e3bb4c09c6b382e15d63e": "veecon_2024_tickets",

  // ===== APIOLOGY DAO =====
  // ApiologyDAO seat NFT — governance membership token for apdao-auction-house
  // (paired with ApdaoAuctionHouse proxy at 0xE840929c…0A0b). Consumed via
  // TrackedHolder for governance snapshots + delegate-eligibility checks.
  "0xfc2d7ebfeb2714fce13caf234a95db129ecc43da": "apdao_seat",

  // ===== OPTIMISM - Mibera Lore Articles =====
  // Mirror WritingEditions ERC-721 collections
  "0x6b31859e5e32a5212f1ba4d7b377604b9d4c7a60": "lore_1_introducing_mibera",
  "0x9247edf18518c4dccfa7f8b2345a1e8a4738204f": "lore_2_honey_online_offline",
  "0xb2c7f411aa425d3fce42751e576a01b1ff150385": "lore_3_bera_kali_acc",
  "0xa12064e3b1f6102435e77aa68569e79955070357":
    "lore_4_bgt_network_spirituality",
  "0x6ca29eed22f04c1ec6126c59922844811dcbcdfa": "lore_5_initiation_ritual",
  "0x7988434e1469d35fa5f442e649de45d47c3df23c": "lore_6_miberamaker_design",
  "0x96c200ec4cca0bc57444cfee888cfba78a1ddbd8": "lore_7_miberamaker_design",
};

/**
 * Collections that should track all transfers (not just mints/burns)
 * Used for timeline/activity tracking
 */
export const TRANSFER_TRACKED_COLLECTIONS = new Set<string>([
  // NOTE: mibera main collection transfers are tracked by MiberaCollection handler
  // NOTE: mibera_zora is ERC-1155, transfers tracked by mibera-zora.ts handler
  // NOTE: puru collections are ERC-1155, transfers tracked by puru-apiculture1155.ts handler

  // Mibera Lore Articles + community collections - track all transfers for timeline
  // Base batch 1 + Azuki (ETH) — community scoring consumes transfer activity, not just holdings
  "azuki",
  "based_punks",
  "hypio",
  "kemonokaki",
  "warplets",
  "lil_bangers",
  "based_onchain_punks",
  "nodes_by_hunter",
  "veecon_2024_tickets",

  "lore_1_introducing_mibera",
  "lore_2_honey_online_offline",
  "lore_3_bera_kali_acc",
  "lore_4_bgt_network_spirituality",
  "lore_5_initiation_ritual",
  "lore_6_miberamaker_design",
  "lore_7_miberamaker_design",
]);
