/*
 * sale-attribution-bindings.test.ts — the binding invariant sale attribution depends on.
 *
 * WHY THIS EXISTS (sprint-bug-190 post-mortem): the sprint removed the hardcoded
 * collection allowlist in seaport.ts and every handler test passed, but Base still
 * produced ZERO sale rows after a full reindex — because `config.yaml` never bound the
 * Seaport contract on 8453 at all. No binding means no OrderFulfilled events are
 * fetched, so the decoder is never invoked and sale attribution is silently zero no
 * matter how correct it is.
 *
 * Every handler test drives the callback directly with synthetic events, so none of
 * them can observe this class of failure. Only a config-level assertion can. The cost
 * of the miss was a full production reindex (~2h) that could not satisfy its own
 * headline acceptance criterion.
 */
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { extractChainContractRef } from "../scripts/verify-belt-config.js";

const monoText = readFileSync("config.yaml", "utf8");

/** Canonical Seaport deployments — identical addresses on every EVM chain. */
const SEAPORT_V16 = "0x0000000000000068f116a894984e2db1123eb395";
const SEAPORT_V15 = "0x00000000000000adc04c56bf30ac9d3c0aaf14dc";

/**
 * Chains where a community's sales must be attributable. Each pairs the NFT-tracking
 * contract with the chain, so the assertion is "we index collections here, therefore
 * we must index the marketplace that sells them".
 */
const SALE_CHAINS: ReadonlyArray<{
  chainId: number;
  nftContract: string;
  label: string;
  /** Versions that must be bound. v1.6 is the live deployment everywhere; v1.5 is
   *  only required on chains with pre-1.6 trading history. Berachain mainnet
   *  launched after v1.6 shipped, so v1.5 there would bind a contract that never
   *  filled an order. */
  requiredVersions: readonly string[];
}> = [
  { chainId: 1, nftContract: "EthTrackedErc721", label: "Ethereum", requiredVersions: [SEAPORT_V16, SEAPORT_V15] },
  { chainId: 8453, nftContract: "TrackedErc721", label: "Base", requiredVersions: [SEAPORT_V16, SEAPORT_V15] },
  { chainId: 80094, nftContract: "MiberaCollection", label: "Berachain", requiredVersions: [SEAPORT_V16] },
];

describe("sale attribution — Seaport must be bound wherever we track collections", () => {
  it.each(SALE_CHAINS)(
    "binds Seaport on chain $chainId ($label)",
    ({ chainId, requiredVersions }) => {
      const ref = extractChainContractRef(monoText, chainId, "Seaport");
      expect(
        ref,
        `no Seaport binding on chain ${chainId} — OrderFulfilled events are never ` +
          `fetched there, so sale attribution is silently zero`,
      ).not.toBeNull();

      // Addresses are quoted in config.yaml (an unquoted 0x… scalar is a valid
      // YAML 1.1 hex integer), and the extractor returns the raw token, quotes and all.
      const addrs = ref!.address.map((a: string) =>
        a.replace(/^["']|["']$/g, "").toLowerCase(),
      );
      for (const version of requiredVersions) expect(addrs).toContain(version);
    },
  );

  it.each(SALE_CHAINS.filter((c) => c.nftContract.includes("TrackedErc721")))(
    "starts Seaport no later than the tracked collections on chain $chainId ($label)",
    ({ chainId, nftContract }) => {
      const seaport = extractChainContractRef(monoText, chainId, "Seaport");
      const nfts = extractChainContractRef(monoText, chainId, nftContract);
      expect(seaport).not.toBeNull();
      expect(nfts).not.toBeNull();

      // A Seaport start_block ABOVE the collection start_block loses every sale in
      // the gap while still indexing the transfers — the silent half-coverage case.
      // A null start_block means the binding inherits the chain floor (chain 1's
      // EthTrackedErc721 does this deliberately, per envio #120), so there is no
      // per-contract bound to compare against and the rule does not apply.
      if (nfts!.startBlock === null) return;

      const seaportStart = Number(seaport!.startBlock);
      const nftStart = Number(nfts!.startBlock);
      expect(
        seaportStart,
        `Seaport on chain ${chainId} starts at ${seaportStart} but collections are ` +
          `indexed from ${nftStart} — sales in that gap would be silently missing`,
      ).toBeLessThanOrEqual(nftStart);
    },
  );
});
