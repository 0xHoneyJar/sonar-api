import { Effect } from "effect";

import { digestVersioned, type NetworkRef } from "../collection-resolver/protocol.js";
import type { PreparationCapability, TokenStandard } from "./types.js";

type PrepareAdapterId = PreparationCapability["prepareAdapterId"];

/**
 * Per-network preparation adapters, keyed by observed token standard. A standard
 * absent from `adapters` genuinely has no worker on that network and must refuse
 * — the map is the only place a new belt worker becomes admissible.
 */
const EVM_CAPABILITIES: Record<
  string,
  {
    sourceSequence: string;
    finalityPolicyVersion: string;
    adapters: Partial<Record<TokenStandard, PrepareAdapterId>>;
  }
> = {
  // Chain 1 uses dedicated Eth* belt contracts (envio #120: a single-address
  // entry in a shared multi-chain contract is not fetched on chain 1).
  "1": {
    sourceSequence: "2",
    finalityPolicyVersion: "ethereum-finalized.v1",
    adapters: { erc721: "belt.eth-erc721", erc1155: "belt.eth-erc1155" },
  },
  "10": {
    sourceSequence: "21",
    finalityPolicyVersion: "optimism-finalized.v1",
    adapters: { erc721: "belt.evm-erc721", erc1155: "belt.evm-erc1155" },
  },
  "8453": {
    sourceSequence: "11",
    finalityPolicyVersion: "base-finalized.v1",
    adapters: { erc721: "belt.evm-erc721", erc1155: "belt.evm-erc1155" },
  },
  "42161": {
    sourceSequence: "31",
    finalityPolicyVersion: "arbitrum-finalized.v1",
    adapters: { erc721: "belt.evm-erc721", erc1155: "belt.evm-erc1155" },
  },
  "80094": {
    sourceSequence: "41",
    finalityPolicyVersion: "berachain-finalized.v1",
    adapters: { erc721: "belt.evm-erc721", erc1155: "belt.evm-erc1155" },
  },
  "7777777": {
    sourceSequence: "51",
    finalityPolicyVersion: "zora-finalized.v1",
    adapters: { erc721: "belt.evm-erc721", erc1155: "belt.evm-erc1155" },
  },
  // Robinhood reads through the HyperIndex sidecar, which has an ERC-721
  // worker only — 1155 there stays an honest refusal.
  "4663": {
    sourceSequence: "222",
    finalityPolicyVersion: "robinhood-finalized.v1",
    adapters: { erc721: "belt.evm-erc721.robinhood-sidecar" },
  },
};

const CAPABILITY_ID = "ownership_index.v1" as const;

/**
 * Adapter version is per-adapter, not global: the belt config shape an ERC-1155
 * worker emits is not the ERC-721 one, and the capability digest must say so.
 */
const ADAPTER_VERSIONS: Record<PrepareAdapterId, string> = {
  "belt.eth-erc721": "belt-config-erc721.v1",
  "belt.evm-erc721": "belt-config-erc721.v1",
  "belt.evm-erc721.robinhood-sidecar": "rh-hyperindex-sidecar.v1",
  "belt.eth-erc1155": "belt-config-erc1155.v1",
  "belt.evm-erc1155": "belt-config-erc1155.v1",
  // Refusals create no job; kept at the historical literal so existing
  // unsupported-path capability digests do not shift.
  unsupported: "belt-config-erc721.v1",
};

const ADAPTER_VERSION = ADAPTER_VERSIONS.unsupported;

/**
 * Supply lane ready when Kitchen can route 4663 reads to the RH sidecar
 * (`ROBINHOOD_BELT_GRAPHQL_URL`), or when explicitly forced with
 * `ROBINHOOD_OWNERSHIP_SUPPLY_LANE=1`. Emergency off: `=0`.
 */
function robinhoodOwnershipSupplyLaneReady(): boolean {
  const flag = process.env.ROBINHOOD_OWNERSHIP_SUPPLY_LANE?.trim();
  if (flag === "0") return false;
  if (flag === "1") return true;
  return Boolean(process.env.ROBINHOOD_BELT_GRAPHQL_URL?.trim());
}

async function versionFor(args: {
  network: NetworkRef;
  standard: TokenStandard;
  sourceSequence: string;
  finalityPolicyVersion: string;
  adapterId: string;
  adapterVersion?: string;
}): Promise<string> {
  const digest = await Effect.runPromise(
    digestVersioned("kitchen.ownership-index-capability", 1, {
      capability_id: CAPABILITY_ID,
      network: args.network,
      token_standard: args.standard,
      source_sequence: args.sourceSequence,
      finality_policy_version: args.finalityPolicyVersion,
      prepare_adapter_id: args.adapterId,
      prepare_adapter_version: args.adapterVersion ?? ADAPTER_VERSION,
    }),
  );
  return digest.digest;
}

export async function resolvePreparationCapability(args: {
  network: NetworkRef;
  tokenStandard: TokenStandard;
}): Promise<PreparationCapability> {
  const { network, tokenStandard } = args;

  if (network.network_namespace === "solana") {
    return {
      capabilityId: CAPABILITY_ID,
      capabilityVersion: await versionFor({
        network,
        standard: tokenStandard,
        sourceSequence: "101",
        finalityPolicyVersion: "solana-finalized.v1",
        adapterId: "unsupported",
      }),
      health: "disabled",
      enabled: false,
      reasonClass: "capability_unsupported",
      reason: "Solana ownership_index preparation is unsupported until CR-402",
      sourceSequence: "101",
      finalityPolicyVersion: "solana-finalized.v1",
      prepareAdapterId: "unsupported",
      prepareAdapterVersion: ADAPTER_VERSION,
    };
  }

  const configured = EVM_CAPABILITIES[network.network_reference];
  if (!configured) {
    return {
      capabilityId: CAPABILITY_ID,
      capabilityVersion: await versionFor({
        network,
        standard: tokenStandard,
        sourceSequence: "0",
        finalityPolicyVersion: "unsupported.v1",
        adapterId: "unsupported",
      }),
      health: "disabled",
      enabled: false,
      reasonClass: "capability_unsupported",
      reason: `network eip155:${network.network_reference} has no proven preparation adapter`,
      sourceSequence: "0",
      finalityPolicyVersion: "unsupported.v1",
      prepareAdapterId: "unsupported",
      prepareAdapterVersion: ADAPTER_VERSION,
    };
  }

  const adapter = configured.adapters[tokenStandard];
  if (adapter === undefined) {
    return {
      capabilityId: CAPABILITY_ID,
      capabilityVersion: await versionFor({
        network,
        standard: tokenStandard,
        sourceSequence: configured.sourceSequence,
        finalityPolicyVersion: configured.finalityPolicyVersion,
        adapterId: "unsupported",
      }),
      health: "disabled",
      enabled: false,
      reasonClass: "capability_unsupported",
      reason: `${tokenStandard} has no generic Kitchen preparation worker`,
      sourceSequence: configured.sourceSequence,
      finalityPolicyVersion: configured.finalityPolicyVersion,
      prepareAdapterId: "unsupported",
      prepareAdapterVersion: ADAPTER_VERSION,
    };
  }

  const adapterVersion = ADAPTER_VERSIONS[adapter];

  // Contract truth: recognize is live; ownership supply lane is the sidecar canary.
  if (
    network.network_reference === "4663" &&
    !robinhoodOwnershipSupplyLaneReady()
  ) {
    return {
      capabilityId: CAPABILITY_ID,
      capabilityVersion: await versionFor({
        network,
        standard: tokenStandard,
        sourceSequence: configured.sourceSequence,
        finalityPolicyVersion: configured.finalityPolicyVersion,
        adapterId: adapter,
        adapterVersion,
      }),
      health: "disabled",
      enabled: false,
      reasonClass: "supply_lane_pending",
      reason:
        "Robinhood ownership_index awaits HyperIndex sidecar canary (config.robinhood-sidecar.yaml); recognize remains live",
      sourceSequence: configured.sourceSequence,
      finalityPolicyVersion: configured.finalityPolicyVersion,
      prepareAdapterId: adapter,
      prepareAdapterVersion: adapterVersion,
    };
  }

  return {
    capabilityId: CAPABILITY_ID,
    capabilityVersion: await versionFor({
      network,
      standard: tokenStandard,
      sourceSequence: configured.sourceSequence,
      finalityPolicyVersion: configured.finalityPolicyVersion,
      adapterId: adapter,
      adapterVersion,
    }),
    health: "available",
    enabled: true,
    reasonClass: "healthy",
    reason: "preparation adapter available",
    sourceSequence: configured.sourceSequence,
    finalityPolicyVersion: configured.finalityPolicyVersion,
    prepareAdapterId: adapter,
    prepareAdapterVersion: adapterVersion,
  };
}
