/**
 * Hermetic DAS sample fixtures for CR-104 Solana adapter proofs.
 */
import type { DasAsset } from "../../../svm/nft-collection-source.js";
import { PYTHIANS_COLLECTION_MINT } from "../../hermetic-fixtures.js";
import type { DasSampleOutcome } from "./das-port.js";

const owner = "Owner1111111111111111111111111111111111111";

export const FIXTURE_CLASSIC_ITEMS: ReadonlyArray<DasAsset> = [
  {
    id: "ClassicNftMint1111111111111111111111111111111",
    interface: "V1_NFT",
    ownership: { owner },
    content: {
      metadata: { name: "Classic #1" },
      links: { image: "https://cdn.example.test/classic1.png" },
    },
    compression: { compressed: false },
  },
  {
    id: "ClassicNftMint2222222222222222222222222222222",
    interface: "V1_NFT",
    ownership: { owner },
    content: { metadata: { name: "Classic #2" } },
    compression: { compressed: false },
  },
];

export const FIXTURE_PROGRAMMABLE_ITEMS: ReadonlyArray<DasAsset> = [
  {
    id: "PnftMint111111111111111111111111111111111111",
    interface: "ProgrammableNFT",
    ownership: { owner },
    content: {
      metadata: { name: "Pythian #1" },
      links: { image: "https://ipfs.pythenians.xyz/nft/1.png" },
    },
    compression: { compressed: false },
  },
  {
    id: "PnftMint222222222222222222222222222222222222",
    interface: "ProgrammableNFT",
    ownership: { owner },
    content: { metadata: { name: "Pythian #2" } },
    compression: { compressed: false },
  },
];

export const FIXTURE_COMPRESSED_ITEMS: ReadonlyArray<DasAsset> = [
  {
    id: "CnftMint1111111111111111111111111111111111111",
    interface: "V1_NFT",
    ownership: { owner },
    compression: { compressed: true },
  },
  {
    id: "CnftMint2222222222222222222222222222222222222",
    interface: "V1_NFT",
    ownership: { owner },
    compression: { compressed: true },
  },
];

export const FIXTURE_MIXED_ITEMS: ReadonlyArray<DasAsset> = [
  {
    id: "MixedA11111111111111111111111111111111111111",
    interface: "ProgrammableNFT",
    ownership: { owner },
    compression: { compressed: false },
  },
  {
    id: "MixedB11111111111111111111111111111111111111",
    interface: "V1_NFT",
    ownership: { owner },
    compression: { compressed: true },
  },
];

export const FIXTURE_UNKNOWN_ITEMS: ReadonlyArray<DasAsset> = [
  {
    id: "UnknownMint111111111111111111111111111111111",
    interface: "Custom",
    ownership: { owner },
    compression: { compressed: false },
  },
];

/**
 * Non-empty raw DAS page where every asset fails shared `parseAsset`
 * (missing owner) — must be typed unavailable, never conclusive miss.
 */
export const FIXTURE_UNVERIFIED_ITEMS: ReadonlyArray<DasAsset> = [
  {
    id: "UnverifiedMint11111111111111111111111111111",
    interface: "ProgrammableNFT",
    ownership: {},
    compression: { compressed: false },
  },
  {
    id: "UnverifiedMint22222222222222222222222222222",
    interface: "V1_NFT",
    // no ownership — parseAsset returns null
    compression: { compressed: false },
  },
];

export const sampleOutcome = (
  collection_mint: string,
  items: ReadonlyArray<DasAsset>,
  limit = items.length,
): DasSampleOutcome => ({
  kind: "sample",
  collection_mint,
  items,
  page: 1,
  limit,
});

/** Registered enrichment uses the exact Pythenians mint from the SVM registry. */
export const REGISTERED_COLLECTION_MINT = PYTHIANS_COLLECTION_MINT;

/** Wrong-case variant of the Pythenians mint — must not enrich or fold. */
export const WRONG_CASE_PYTHIANS_MINT = PYTHIANS_COLLECTION_MINT.toLowerCase();
