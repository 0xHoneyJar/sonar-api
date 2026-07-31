/*
 * marketplaces.ts — THE marketplace registry.
 *
 * A marketplace is a VENUE we decode sales from, not a community we track
 * holders for, so it lives here rather than in contracts.ts. The split matters:
 * sale eligibility asks "is this NFT one of ours" against CONTRACTS, and a
 * marketplace address must never answer yes to that.
 *
 * Coverage is per (marketplace, chain). Every NFT contract on a chain is
 * automatically covered by every marketplace registered on that chain — there
 * is no per-collection wiring, so adding a community to Base immediately gets
 * Base's marketplaces, and adding a marketplace to Base immediately covers
 * every community already there.
 *
 * Adding a deployment of a marketplace we already decode is ONE entry here.
 * Adding a NEW marketplace is an entry in `Marketplace`, a decoder under
 * src/handlers/marketplaces/, and a lane in scripts/gen-config.ts.
 */

export type Marketplace = "seaport" | "blur" | "blur_v2";

export interface MarketplaceDeployment {
  /** Which decoder handles this address. */
  readonly marketplace: Marketplace;
  /** Human label — version and venue, e.g. "Seaport v1.5". */
  readonly label: string;
  /** Lowercased 0x address. */
  readonly address: string;
  readonly chain: number;
  /** Block the belt starts decoding sales from on this chain. */
  readonly startBlock: number;
}

/*
 * SEAPORT — deterministic deployment: each version has the SAME address on
 * every chain (verified against the entries below, which predate this file).
 * That is why extending Seaport to a new chain needs no address research —
 * copy the version rows and set the chain's start block.
 *
 * BLUR — Ethereum only; Blur never deployed to an L2. TWO lanes, because the two
 * exchange versions emit completely different events:
 *   blur     = BlurExchange v1, `OrdersMatched` with full Order structs. Now
 *              near-dormant (1 log in 135k blocks measured 2026-07-31) but it
 *              carried Blur's 2022-23 volume, so a full re-index needs it.
 *   blur_v2  = BlurExchangeV2, `Execution721Packed` — bit-packed fields and only
 *              ONE party per log. This is where all current Blur volume is.
 *
 * A third address labelled "Blur Marketplace 2" (0x39da4174…) was registered and
 * REMOVED on verification: it emits 0x73c40079…, not OrdersMatched, so it would
 * have decoded nothing. Addresses here are confirmed against live logs.
 */
// prettier-ignore
export const MARKETPLACES: readonly MarketplaceDeployment[] = [
  // ---- Ethereum ----
  { marketplace: "seaport", label: "Seaport v1.1", address: "0x00000000006c3852cbef3e08e8df289169ede581", chain: 1, startBlock: 14162194 },
  { marketplace: "seaport", label: "Seaport v1.4", address: "0x00000000000001ad428e4906ae43d8f9852d0dd6", chain: 1, startBlock: 14162194 },
  { marketplace: "seaport", label: "Seaport v1.5", address: "0x00000000000000adc04c56bf30ac9d3c0aaf14dc", chain: 1, startBlock: 14162194 },
  { marketplace: "seaport", label: "Seaport v1.6", address: "0x0000000000000068f116a894984e2db1123eb395", chain: 1, startBlock: 14162194 },
  { marketplace: "blur",    label: "BlurExchange v1",   address: "0x000000000000ad05ccc4f10045630fb830b95127", chain: 1, startBlock: 15779200 },
  { marketplace: "blur_v2", label: "BlurExchangeV2",    address: "0xb2ecfe4e4d61f8790bbb9de2d1259b9e2410cea5", chain: 1, startBlock: 17603892 },

  // ---- Optimism ----
  { marketplace: "seaport", label: "Seaport v1.1", address: "0x00000000006c3852cbef3e08e8df289169ede581", chain: 10, startBlock: 107558369 },
  { marketplace: "seaport", label: "Seaport v1.4", address: "0x00000000000001ad428e4906ae43d8f9852d0dd6", chain: 10, startBlock: 107558369 },
  { marketplace: "seaport", label: "Seaport v1.5", address: "0x00000000000000adc04c56bf30ac9d3c0aaf14dc", chain: 10, startBlock: 107558369 },
  { marketplace: "seaport", label: "Seaport v1.6", address: "0x0000000000000068f116a894984e2db1123eb395", chain: 10, startBlock: 107558369 },

  // ---- Base ----
  { marketplace: "seaport", label: "Seaport v1.1", address: "0x00000000006c3852cbef3e08e8df289169ede581", chain: 8453, startBlock: 2883449 },
  { marketplace: "seaport", label: "Seaport v1.4", address: "0x00000000000001ad428e4906ae43d8f9852d0dd6", chain: 8453, startBlock: 2883449 },
  { marketplace: "seaport", label: "Seaport v1.5", address: "0x00000000000000adc04c56bf30ac9d3c0aaf14dc", chain: 8453, startBlock: 2883449 },
  { marketplace: "seaport", label: "Seaport v1.6", address: "0x0000000000000068f116a894984e2db1123eb395", chain: 8453, startBlock: 2883449 },

  // ---- Arbitrum ----
  { marketplace: "seaport", label: "Seaport v1.1", address: "0x00000000006c3852cbef3e08e8df289169ede581", chain: 42161, startBlock: 102894033 },
  { marketplace: "seaport", label: "Seaport v1.4", address: "0x00000000000001ad428e4906ae43d8f9852d0dd6", chain: 42161, startBlock: 102894033 },
  { marketplace: "seaport", label: "Seaport v1.5", address: "0x00000000000000adc04c56bf30ac9d3c0aaf14dc", chain: 42161, startBlock: 102894033 },
  { marketplace: "seaport", label: "Seaport v1.6", address: "0x0000000000000068f116a894984e2db1123eb395", chain: 42161, startBlock: 102894033 },

  // ---- Zora ----
  { marketplace: "seaport", label: "Seaport v1.5", address: "0x00000000000000adc04c56bf30ac9d3c0aaf14dc", chain: 7777777, startBlock: 18071873 },
  { marketplace: "seaport", label: "Seaport v1.6", address: "0x0000000000000068f116a894984e2db1123eb395", chain: 7777777, startBlock: 18071873 },

  // ---- Berachain ----
  { marketplace: "seaport", label: "Seaport v1.6", address: "0x0000000000000068f116a894984e2db1123eb395", chain: 80094, startBlock: 3837808 },
];

/** Deployments of one marketplace, in registry order. */
export function deploymentsOf(marketplace: Marketplace): MarketplaceDeployment[] {
  return MARKETPLACES.filter((m) => m.marketplace === marketplace);
}

/** Chains that have at least one deployment of `marketplace`. */
export function chainsWith(marketplace: Marketplace): number[] {
  return [...new Set(deploymentsOf(marketplace).map((m) => m.chain))].sort((a, b) => a - b);
}
