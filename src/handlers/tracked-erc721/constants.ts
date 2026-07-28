/*
 * Collection keys for the ERC-721 handler — derived from THE registry
 * (src/registry/contracts.ts), not hand-maintained here.
 *
 * The hardcoded map this replaces (bd-dwq5.1) held 28 addresses while config.yaml
 * bound 51 under the same handlers: 23 collections indexed holders under their raw
 * contract address because the second declaration site was never updated. There is
 * now one declaration site, and test/contract-registry.test.ts holds it to
 * config.yaml in both directions.
 *
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
 * miparcels, miladies (Miladies on Berachain), then mireveal_1_1 … mireveal_8_8.
 *
 * The mibera main collection (0x6666397…) is handled by MiberaCollection, and the
 * ERC-1155 collections by their own handlers — those routes are unchanged.
 * ============================================================
 */
import { erc721CollectionKeys } from "../../registry/contracts";

export const TRACKED_ERC721_COLLECTION_KEYS: Record<string, string> =
  erc721CollectionKeys();

// TRANSFER_TRACKED_COLLECTIONS was removed in bug-20260725-224d57 (F1).
//
// It gated which collections recorded transfer Actions, but Kitchen patches
// config.yaml on onboarding and never touched this list — so every onboarded
// collection indexed holders and emitted no transfer history. Measured
// 2026-07-25: chain 1 had 9 bound ERC-721 collections and emitted transfers for
// exactly one ("azuki").
//
// The gate was also redundant: indexer.onEvent only delivers events for
// addresses bound in config.yaml, so arrival already proves the collection is
// tracked.
