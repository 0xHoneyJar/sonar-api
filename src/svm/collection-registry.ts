/**
 * collection-registry.ts — the generic SVM NFT-collection registry (cycle svm-collection-events, Sprint 4).
 *
 * The schema / parser / writer are already collection_key-keyed (generic), so onboarding a new SVM NFT
 * collection to the event index is a CONFIG entry here + a backfill run (`--collection <key>`), NOT new
 * code. Pythenians is the first entry; the next collection is one line below.
 *
 * NOTE (per SDD §4.4 / FAGAN): the current backfill walks the mint's Enhanced address-history, which is
 * complete for ProgrammableNonFungible (pNFT) collections like Pythenians. Before adding a CLASSIC-SPL or
 * COMPRESSED collection, confirm coverage via the §4.5 reconciliation gate (compressed needs
 * getSignaturesForAsset + Bubblegum; classic-SPL with raw Transfers needs token-account tracing).
 */
import { PYTHIANS_COLLECTION } from "./pythians-collection-indexer";

export interface CollectionConfig {
  // ── INFRA ID layer (stable, opaque) — never rename; consumers (score-api) query by it ──
  readonly collectionKey: string; // the generic key written to svm.collection_event.collection_key
  readonly collectionMint: string; // the Metaplex collection mint (DAS getAssetsByGroup groupValue)
  // ── PRESENTATION layer (the single source of truth for naming) — derive ALL display from here ──
  readonly displayName: string; // canonical human name (on-chain Metaplex `name`); never re-type elsewhere
  readonly symbol: string; // on-chain symbol
  // ── OWNERSHIP — drives the attestation model ──
  // "external" = not owned by us (the scale case): labels come from CHAIN + RESEARCH only, no operator
  //   insider attestation. "registered" = a team registered + may operator-attest (sign) their own addresses.
  readonly ownership: "external" | "registered";
}

export const COLLECTIONS: Readonly<Record<string, CollectionConfig>> = {
  // Pythenians ($PTN) — first GTM collection. The KEY stays the stable opaque id "pythians"; the NAME is
  // "Pythenians" (chain-confirmed) and lives ONLY here. external = chain+research labels, no insider attestation.
  pythians: { collectionKey: "pythians", collectionMint: PYTHIANS_COLLECTION, displayName: "Pythenians", symbol: "$PTN", ownership: "external" },

  // ===== #121 RAMP — SOLANA BATCH 1 (classic certified-collection mints) =====
  // Mints verified on-chain 2026-07-04 (member-NFT verified `collection` field + collection account
  // name check — grimoires/loa/context/2026-07-04-top10-base-solana-onboarding-candidates.md).
  // symbol "" = not chain-verified (cosmetic only; displayName is the label). All external.
  mad_lads: { collectionKey: "mad_lads", collectionMint: "J1S9H3QjnRtBbbuD4HjPV6RpRhwuk4zKbxsnCHuTgh9w", displayName: "Mad Lads", symbol: "", ownership: "external" },
  claynosaurz: { collectionKey: "claynosaurz", collectionMint: "6mszaj17KSfVqADrQj3o4W3zoLMTykgmV37W4QadCczK", displayName: "Claynosaurz", symbol: "", ownership: "external" },
  smb_gen2: { collectionKey: "smb_gen2", collectionMint: "SMBtHCCC6RYRutFEPb4gZqeBLUZbMNhRKaMKZZLHi7W", displayName: "SMB Gen2", symbol: "", ownership: "external" },
  degods: { collectionKey: "degods", collectionMint: "6XxjKYFbcndh2gDcsUrmZgVEsoDxXMnfsaGY6fpTJzNr", displayName: "DeGods", symbol: "", ownership: "external" },
  daa_higher_self: { collectionKey: "daa_higher_self", collectionMint: "HF6SFg5RkWNQrEhmnXV7H8EmLPxg3jDaggEni1SMVAi6", displayName: "Degenerate Ape Academy: Higher Self", symbol: "", ownership: "external" },
  famous_fox: { collectionKey: "famous_fox", collectionMint: "BUjZjAS2vbbb65g7Z1Ca9ZRVYoJscURG5L3AkVvHP9ac", displayName: "Famous Fox Federation", symbol: "", ownership: "external" },
  y00ts: { collectionKey: "y00ts", collectionMint: "4mKSoDDqApmF1DqXvVTSL6tu2zixrSSNjqMxUnwvVzy2", displayName: "y00ts", symbol: "", ownership: "external" },
  galactic_geckos: { collectionKey: "galactic_geckos", collectionMint: "J6RJFQfLgBTcoAt3KoZFiTFW9AbufsztBNDgZ7Znrp1Q", displayName: "GGSG: Galactic Geckos", symbol: "", ownership: "external" },
  // Deferred (lane extensions, NOT loadable yet): Metaplex Core (DUMPSTR, ENTROPY), compressed
  // members (Tensorians), creator-keyed (Tomorrowland) — candidates doc + PRD §5 OUT. NOTE (header
  // caveat): batch-1 entries are CLASSIC SPL, not pNFT — history acquisition for them comes from the
  // warehouse loader (SDD §2.3), NOT the Enhanced mint-walk; the §4.5 gate stays the proof either way.
};

export const DEFAULT_COLLECTION_KEY = "pythians";

/** Resolve a collection by key (whitespace-trimmed); throws (listing known keys) on an unknown key. */
export function resolveCollection(key: string): CollectionConfig {
  const c = COLLECTIONS[key.trim()]; // trim — a trailing space in a YAML/Railway env is an easy footgun (FAGAN NIT)
  if (!c) {
    throw new Error(
      `unknown collection '${key}' — add it to COLLECTIONS in collection-registry.ts (known: ${Object.keys(COLLECTIONS).join(", ")})`,
    );
  }
  return c;
}
