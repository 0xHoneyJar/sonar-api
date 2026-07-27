/*
 * sale-coverage.ts — what sonar's sale attribution DOES and DOES NOT see, as data.
 *
 * The question this exists to answer, for a consumer that finds no sale row against a
 * transfer: is that a fact ("this NFT was moved, not sold") or a gap ("it may well have
 * sold, on a venue we don't decode")? Before this file that answer lived in a findings
 * document and in people's heads, which meant score-api's `conviction` score silently
 * treated every gap as a confirmed non-sale.
 *
 * Two layers, deliberately separated:
 *
 *   CAPABILITY (structural) — which venues are decoded on which chain. Changes only when
 *     a decoder lands. `absentSaleMeans` is derived from it and is the load-bearing field.
 *   MEASURED (indicative)   — a census taken at a moment in time. Useful for sizing a gap,
 *     NOT a contract. Always carries the timestamp it was taken at.
 *
 * The collection index is derived from config.yaml at build time rather than listed here,
 * so it cannot drift from what the belt actually indexes (the defect class this whole
 * cycle exists to kill). `sale-coverage.json` is the generated artifact; regenerate with
 * `pnpm coverage:sale`; `test/sale-coverage.test.ts` fails if it is stale.
 */
import { deriveCollectionKeys } from "./handlers/marketplaces/tracked-nft-contracts";

export const SALE_COVERAGE_SCHEMA_VERSION = "1.0.0";

/** A marketplace, and whether this belt decodes its fills. */
export type Venue = {
  name: string;
  /** The event we decode, or would need to. */
  event: string;
  /** Contract addresses, where a single deployment identifies the venue. */
  addresses?: string[];
  /** Why it is not covered — omitted when it is. */
  reason?: string;
};

export type ChainCoverage = {
  chainId: number;
  name: string;
  /**
   * What a MISSING sale row means for a transfer on this chain.
   *   "no_sale" — every venue that trades here is decoded, so absence is a fact.
   *   "unknown" — at least one venue is undecoded, so absence proves nothing.
   *   "not_applicable" — no NFT collections are indexed on this chain at all.
   */
  absentSaleMeans: "no_sale" | "unknown" | "not_applicable";
  coveredVenues: Venue[];
  uncoveredVenues: Venue[];
  /**
   * Events that move an NFT but are NOT a disposal. A consumer scoring "did they sell
   * it" must not count these. Blur's Blend is the live example: 122 of 172 transfers
   * once flagged `viaMarketplace` on Ethereum were loan collateral, not sales.
   */
  notASale: Venue[];
  measured?: {
    at: string;
    transfers: number;
    saleRows: number;
    /** saleRows / transfers, rounded to 4dp. Indicative only — see the header. */
    ratio: number;
    note?: string;
  };
};

const SEAPORT_ADDRESSES = [
  "0x00000000006c3852cbef3e08e8df289169ede581", // v1.1
  "0x00000000000001ad428e4906ae43d8f9852d0dd6", // v1.4
  "0x00000000000000adc04c56bf30ac9d3c0aaf14dc", // v1.5
  "0x0000000000000068f116a894984e2db1123eb395", // v1.6
];

const SEAPORT: Venue = {
  name: "Seaport (OpenSea)",
  event:
    "OrderFulfilled(bytes32,address,address,address,(uint8,address,uint256,uint256)[],(uint8,address,uint256,uint256,address)[])",
  addresses: SEAPORT_ADDRESSES,
};

/**
 * Per-chain capability. Hand-curated from
 * grimoires/loa/context/2026-07-25-marketplace-sale-detection.md — this is measured
 * knowledge about the outside world, not something the codebase can derive.
 */
const CHAIN_COVERAGE: ChainCoverage[] = [
  {
    chainId: 1,
    name: "Ethereum",
    absentSaleMeans: "unknown",
    coveredVenues: [SEAPORT],
    uncoveredVenues: [
      {
        name: "Blur v1",
        event: "OrdersMatched(...)",
        reason:
          "~60% of Azuki's secondary market. Deferred: coverage, not architecture.",
      },
      {
        name: "Blur v2",
        event:
          "Execution721Packed / Execution721MakerFeePacked / Execution721TakerFeePacked",
        reason:
          "Price is bit-packed into a uint256; unpacking is unvalidated (evidence doc §9).",
      },
      {
        name: "Wyvern (legacy OpenSea)",
        event: "OrdersMatched(bytes32,bytes32,address,address,uint256,bytes32)",
        reason: "~27% legacy tail predating Seaport.",
      },
      { name: "X2Y2", event: "EvInventory(...)", reason: "Long tail." },
      { name: "LooksRare", event: "TakerBid / TakerAsk", reason: "Long tail." },
    ],
    notASale: [
      {
        name: "Blur Blend",
        event: "LoanOfferTaken / Repay",
        reason:
          "NFT-backed lending. Blur takes custody, so the collateral move looks like a " +
          "marketplace transfer. Borrowing against an NFT is not selling it.",
      },
    ],
    measured: {
      at: "2026-07-26",
      transfers: 2654292,
      saleRows: 311381,
      ratio: 0.1173,
      note:
        "Seaport-only. Sampling (409 txs) put Seaport at ~7% of observed Azuki sales, " +
        "so most of the remainder is undecoded venues, not non-sales. Modern " +
        "collections fare far better than legacy ones (just_t00ns ~75.6% vs azuki ~4.6%).",
    },
  },
  {
    chainId: 8453,
    name: "Base",
    absentSaleMeans: "unknown",
    coveredVenues: [SEAPORT],
    uncoveredVenues: [
      {
        name: "Element",
        event:
          "ERC721SellOrderFilled(bytes32,address,address,uint256,address,uint256,(address,uint256)[],address,uint256)",
        addresses: ["0xa39a5f160a1952ddf38781bd76e402b0006912a9"],
        reason:
          "Confirmed live on Base and decodes to the same shape as Seaport, but not yet " +
          "implemented. Deferred from sprint-bug-190; the contract is a 415-byte proxy " +
          "whose implementation should be pinned first.",
      },
    ],
    notASale: [
      {
        name: "LayerZero V2 omnichain bridge",
        event: "(bridge legs appear as plain Transfers)",
        addresses: ["0x1a44076050125825900e736c501f859c50fe728c"],
        reason:
          "Accounts for hypio's entire ~67% non-Seaport remainder. A bridge leg is a move, not a sale.",
      },
      {
        name: "Direct contract calls",
        event: "(tx.to == the NFT contract, only Transfer logs)",
        reason:
          "100% of based_punks' non-Seaport remainder. A plain transferFrom is not a sale.",
      },
    ],
    measured: {
      at: "2026-07-26",
      transfers: 945148,
      saleRows: 883116,
      ratio: 0.9344,
      note:
        "The 6.6% remainder is dominated by bridge legs and direct calls (both genuinely " +
        "not sales) rather than by the undecoded Element venue.",
    },
  },
  {
    chainId: 80094,
    name: "Berachain",
    absentSaleMeans: "no_sale",
    coveredVenues: [
      { ...SEAPORT, addresses: ["0x0000000000000068f116a894984e2db1123eb395"] },
    ],
    uncoveredVenues: [],
    notASale: [
      {
        name: "Direct wallet-to-wallet transfers",
        event: "(tx.to == the NFT contract, only Transfer logs)",
        reason:
          "46 of the 67 sampled non-Seaport transfers. Berachain launched after Seaport " +
          "v1.6 shipped and no other venue was observed across 138 sampled txs.",
      },
    ],
    measured: {
      at: "2026-07-26",
      transfers: 38182,
      saleRows: 12433,
      ratio: 0.3256,
      note:
        "Low ratio, full coverage: most Berachain NFT movement is genuinely not trading. " +
        "This is the one EVM chain where absence is a fact rather than a gap.",
    },
  },
  {
    chainId: 10,
    name: "Optimism",
    absentSaleMeans: "unknown",
    coveredVenues: [],
    uncoveredVenues: [
      {
        name: "(no marketplace bound)",
        event: "—",
        reason:
          "config.yaml binds no marketplace contract on chain 10, so no fill event is " +
          "ever fetched. The 7 Mibera lore collections indexed here have transfer and " +
          "holder data but structurally cannot have sale data.",
      },
    ],
    notASale: [],
    measured: {
      at: "2026-07-26",
      transfers: 345,
      saleRows: 0,
      ratio: 0,
      note: "Zero is structural, not empirical. Do not read it as 'these never sold'.",
    },
  },
  {
    chainId: 42161,
    name: "Arbitrum",
    absentSaleMeans: "not_applicable",
    coveredVenues: [],
    uncoveredVenues: [],
    notASale: [],
    measured: { at: "2026-07-26", transfers: 0, saleRows: 0, ratio: 0 },
  },
  {
    chainId: 7777777,
    name: "Zora",
    absentSaleMeans: "not_applicable",
    coveredVenues: [],
    uncoveredVenues: [],
    notASale: [],
    measured: { at: "2026-07-26", transfers: 0, saleRows: 0, ratio: 0 },
  },
];

/**
 * Solana is declared per collection, not per chain: the sale lane runs through the
 * Helius webhook for the one live collection and the imported collections were
 * backfilled for ownership only. Deep sale history costs ~3.87M Helius credits
 * (33,275 mints x 100 credits/call) and is deferred pending the free SQD Portal path,
 * which needs Magic Eden / Tensor instruction decoding of its own.
 */
const SOLANA_COVERAGE = {
  namespace: "solana",
  absentSaleMeans: "unknown" as const,
  note:
    "Only `pythians` has sale rows. The rest are ownership-only imports: their events " +
    "are mint/transfer records with zero `kind: sale`, so absence of a sale proves nothing.",
  collections: [
    { collectionKey: "pythians", sales: "covered" as const, measured: { at: "2026-07-26", events: 30226, saleRows: 5369 } },
    { collectionKey: "mad_lads", sales: "uncovered" as const, measured: { at: "2026-07-26", events: 225035, saleRows: 0 } },
    { collectionKey: "smb_gen2", sales: "uncovered" as const, measured: { at: "2026-07-26", events: 137538, saleRows: 0 } },
    { collectionKey: "degods", sales: "uncovered" as const, measured: { at: "2026-07-26", events: 126550, saleRows: 0 } },
    { collectionKey: "daa_higher_self", sales: "uncovered" as const, measured: { at: "2026-07-26", events: 48011, saleRows: 0 } },
    { collectionKey: "y00ts", sales: "uncovered" as const, measured: { at: "2026-07-26", events: 2308, saleRows: 0 } },
    { collectionKey: "claynosaurz", sales: "not_indexed" as const, measured: { at: "2026-07-26", events: 0, saleRows: 0 } },
    { collectionKey: "famous_fox", sales: "not_indexed" as const, measured: { at: "2026-07-26", events: 0, saleRows: 0 } },
    { collectionKey: "galactic_geckos", sales: "not_indexed" as const, measured: { at: "2026-07-26", events: 0, saleRows: 0 } },
  ],
};

export type SaleCoverageDocument = {
  schemaVersion: string;
  description: string;
  saleSignal: {
    entity: string;
    joinKey: string[];
    notes: string[];
  };
  chains: ChainCoverage[];
  solana: typeof SOLANA_COVERAGE;
  /** collectionKey → where it lives. Derived from config.yaml, never hand-listed. */
  collections: Array<{
    collectionKey: string;
    chainId: number;
    contract: string;
    absentSaleMeans: ChainCoverage["absentSaleMeans"];
  }>;
};

/**
 * Compose the capability declaration with the collection index derived from the belt
 * config. Pure — the caller supplies the config text.
 */
export function buildSaleCoverage(configText: string): SaleCoverageDocument {
  const byChain = new Map(CHAIN_COVERAGE.map((c) => [c.chainId, c]));
  const collections: SaleCoverageDocument["collections"] = [];

  for (const [chainId, perChain] of deriveCollectionKeys(configText).keys) {
    for (const [contract, collectionKey] of perChain) {
      collections.push({
        collectionKey,
        chainId,
        contract,
        // A collection on an undeclared chain is treated as uncovered, never as
        // "no sale" — the safe direction when the declaration is incomplete.
        absentSaleMeans: byChain.get(chainId)?.absentSaleMeans ?? "unknown",
      });
    }
  }
  collections.sort((a, b) => a.collectionKey.localeCompare(b.collectionKey));

  return {
    schemaVersion: SALE_COVERAGE_SCHEMA_VERSION,
    description:
      "Which marketplace venues sonar decodes, per chain. Read `absentSaleMeans` before " +
      "concluding anything from a transfer with no matching sale row.",
    saleSignal: {
      entity: "MintActivity",
      joinKey: ["chainId", "txHash", "contract", "tokenId"],
      notes: [
        "activityType == 'SALE' is the sale signal; the matching PURCHASE row is the buy leg.",
        "`amountPaid` is nullable — a sale whose price could not be recovered still gets a row.",
        "`paymentToken` must be grouped on for any floor or average price: the zero address " +
          "means native, and ~10% of Base and ~50% of Berachain sales settle in a wrapped token.",
        "Prices are attacker-influenceable (wash trading is not detectable on-chain). Use " +
          "median or trimmed statistics with outlier rejection, never a mean.",
        "`viaMarketplace` was removed in sprint-bug-190; it was ~29% precise and ~28% " +
          "sensitive on Ethereum. Do not resurrect it from any cached consumer schema.",
      ],
    },
    chains: CHAIN_COVERAGE,
    solana: SOLANA_COVERAGE,
    collections,
  };
}
