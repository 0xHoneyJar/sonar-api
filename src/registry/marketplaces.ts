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
  // ---- Berachain ----
  // MVP belt (2026-08-05): Berachain is the only indexed chain, so this is the
  // only live deployment. The Ethereum (incl. Blur v1/v2), Optimism, Base,
  // Arbitrum and Zora rows were cut with their chains — git history is the
  // archive. start block covers the earliest tracked NFT (Big Fat Beras,
  // deploy 811704), not just mibera.
  { marketplace: "seaport", label: "Seaport v1.6", address: "0x0000000000000068f116a894984e2db1123eb395", chain: 80094, startBlock: 811704 },
];

/** Deployments of one marketplace, in registry order. */
export function deploymentsOf(marketplace: Marketplace): MarketplaceDeployment[] {
  return MARKETPLACES.filter((m) => m.marketplace === marketplace);
}

/** Chains that have at least one deployment of `marketplace`. */
export function chainsWith(marketplace: Marketplace): number[] {
  return [...new Set(deploymentsOf(marketplace).map((m) => m.chain))].sort((a, b) => a - b);
}
