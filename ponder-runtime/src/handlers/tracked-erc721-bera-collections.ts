// ponder-runtime/src/handlers/tracked-erc721-bera-collections.ts
//
// Pure (runtime-free) collection-key resolution + burn classification for the
// 12 TrackedErc721Bera contracts (Berachain 80094) registered at
// ponder.config.mibera.ts:75-87. Extracted from the handler so the
// contract→collectionKey map AND the multi-collection burn predicate are
// unit-testable WITHOUT the Ponder runtime (mirrors the pure-helper convention
// of token-projection/shared.ts — a handler can't be imported in a test because
// it calls ponder.on() at module load).
//
// PARITY: the human keys are a VERBATIM Berachain-only subset of envio's
// TRACKED_ERC721_COLLECTION_KEYS (src/handlers/tracked-erc721/constants.ts:20-59)
// — restricted to exactly the 12 addresses TrackedErc721Bera is registered for,
// the same "registered-subset" discipline general-mints.ts uses for
// MINT_COLLECTION_KEYS. The 7 Optimism `lore_*` keys + the mibera-main note in
// the envio map are intentionally EXCLUDED (those contracts are not in this
// Berachain registration; mibera-main has its own dedicated handler).
//
// BURN SINK (B1): envio's twin tracked-erc721.ts imports isBurnAddress() from
// src/lib/mint-detection.ts (the sink set {0x0, 0x…dead}) and applies it to
// THESE SAME 12 collections (tracked-erc721.ts:17,72,96). Parity ⇒ reuse that
// exact sink set here. NO chain RPC was configured (no .env; only .env.example)
// to spot-check an out-of-sink burn pattern on-chain, so the sink set rests on
// envio-twin parity, NOT an on-chain probe. The set matches mibera-collection.ts
// BURN_ADDRESSES (the bd-jyn/mibera reuse) byte-for-byte.

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
export const DEAD_ADDRESS = "0x000000000000000000000000000000000000dead";
const ZERO = ZERO_ADDRESS.toLowerCase();

/**
 * The collections' REAL burn sinks. Both compared lowercased. Identical to
 * mibera-collection.ts BURN_ADDRESSES and to what envio's isBurnAddress covers.
 */
export const BURN_ADDRESSES = new Set<string>([ZERO_ADDRESS, DEAD_ADDRESS]);

/** from == 0x0 — a mint. */
export function isMintFromZero(from: string): boolean {
  return from.toLowerCase() === ZERO;
}

/** `addr` is one of the collections' real burn sinks ({0x0, 0x…dead}) — NOT a
 * hardcoded `== 0x0` check (B1). */
export function isBurnAddress(addr: string): boolean {
  return BURN_ADDRESSES.has(addr.toLowerCase());
}

/** A burn: a NON-mint transfer landing in a real burn sink. */
export function isBurnTransfer(from: string, to: string): boolean {
  return !isMintFromZero(from) && isBurnAddress(to);
}

/**
 * contract (lowercased) → human collectionKey. The 12 Berachain addresses from
 * ponder.config.mibera.ts:75-87; keys VERBATIM from envio's
 * TRACKED_ERC721_COLLECTION_KEYS (Berachain subset). Keys are stored lowercased
 * so lookup is checksum-stable (the handler lowercases event.log.address first).
 */
export const TRACKED_ERC721_BERA_COLLECTION_KEYS: Record<string, string> = {
  // mibera_tarot (aka "Mibera Quiz")
  "0x4b08a069381efbb9f08c73d6b2e975c9be3c4684": "mibera_tarot",
  // Fractures (10-piece SBFT set)
  "0x86db98cf1b81e833447b12a077ac28c36b75c8e1": "miparcels", // fracture #1
  "0x8d4972bd5d2df474e71da6676a365fb549853991": "miladies", // fracture #2
  "0x144b27b1a267ee71989664b3907030da84cc4754": "mireveal_1_1", // fracture #3
  "0x72db992e18a1bf38111b1936dd723e82d0d96313": "mireveal_2_2", // fracture #4
  "0x3a00301b713be83ec54b7b4fb0f86397d087e6d3": "mireveal_3_3", // fracture #5
  "0x419f25c4f9a9c730aacf58b8401b5b3e566fe886": "mireveal_4_20", // fracture #6
  "0x81a27117bd894942ba6737402fb9e57e942c6058": "mireveal_5_5", // fracture #7
  "0xaab7b4502251ae393d0590bab3e208e2d58f4813": "mireveal_6_6", // fracture #8
  "0xc64126ea8dc7626c16daa2a29d375c33fcaa4c7c": "mireveal_7_7", // fracture #9
  "0x24f4047d372139de8dacbe79e2fc576291ec3ffc": "mireveal_8_8", // fracture #10
  // ApiologyDAO seat (governance membership NFT)
  "0xfc2d7ebfeb2714fce13caf234a95db129ecc43da": "apdao_seat",
};

/**
 * Resolve the human collectionKey for an emitting contract. Defensive fallback
 * to the lowercased contract address for an unregistered emitter — mirrors envio
 * `?? contractAddress` (tracked-erc721.ts:28) and general-mints `?? contractAddress`.
 * Should never fire: ponder only delivers events from the 12 registered addresses.
 */
export function resolveTrackedCollectionKey(contractLower: string): string {
  return TRACKED_ERC721_BERA_COLLECTION_KEYS[contractLower] ?? contractLower;
}
