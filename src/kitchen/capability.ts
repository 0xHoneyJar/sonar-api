import { Effect } from "effect";

import { digestVersioned, type NetworkRef } from "../collection-resolver/protocol.js";
import type { PreparationCapability, TokenStandard } from "./types.js";

const EVM_CAPABILITIES: Record<
  string,
  { sourceSequence: string; finalityPolicyVersion: string; adapter: "belt.eth-erc721" | "belt.evm-erc721" }
> = {
  "1": { sourceSequence: "2", finalityPolicyVersion: "ethereum-finalized.v1", adapter: "belt.eth-erc721" },
  "10": { sourceSequence: "21", finalityPolicyVersion: "optimism-finalized.v1", adapter: "belt.evm-erc721" },
  "8453": { sourceSequence: "11", finalityPolicyVersion: "base-finalized.v1", adapter: "belt.evm-erc721" },
  "42161": { sourceSequence: "31", finalityPolicyVersion: "arbitrum-finalized.v1", adapter: "belt.evm-erc721" },
  "80094": { sourceSequence: "41", finalityPolicyVersion: "berachain-finalized.v1", adapter: "belt.evm-erc721" },
  "7777777": { sourceSequence: "51", finalityPolicyVersion: "zora-finalized.v1", adapter: "belt.evm-erc721" },
};

const CAPABILITY_ID = "ownership_index.v1" as const;
const ADAPTER_VERSION = "belt-config-erc721.v1";

async function versionFor(args: {
  network: NetworkRef;
  standard: TokenStandard;
  sourceSequence: string;
  finalityPolicyVersion: string;
  adapterId: string;
}): Promise<string> {
  const digest = await Effect.runPromise(
    digestVersioned("kitchen.ownership-index-capability", 1, {
      capability_id: CAPABILITY_ID,
      network: args.network,
      token_standard: args.standard,
      source_sequence: args.sourceSequence,
      finality_policy_version: args.finalityPolicyVersion,
      prepare_adapter_id: args.adapterId,
      prepare_adapter_version: ADAPTER_VERSION,
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

  if (network.network_reference === "4663") {
    return {
      capabilityId: CAPABILITY_ID,
      capabilityVersion: await versionFor({
        network,
        standard: tokenStandard,
        sourceSequence: "201",
        finalityPolicyVersion: "robinhood-unproven.v1",
        adapterId: "unsupported",
      }),
      health: "disabled",
      enabled: false,
      reasonClass: "kill_switch",
      reason: "Robinhood Chain preparation is disabled until CR-401 capability proof",
      sourceSequence: "201",
      finalityPolicyVersion: "robinhood-unproven.v1",
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

  if (tokenStandard !== "erc721") {
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

  return {
    capabilityId: CAPABILITY_ID,
    capabilityVersion: await versionFor({
      network,
      standard: tokenStandard,
      sourceSequence: configured.sourceSequence,
      finalityPolicyVersion: configured.finalityPolicyVersion,
      adapterId: configured.adapter,
    }),
    health: "available",
    enabled: true,
    reasonClass: "healthy",
    reason: "preparation adapter available",
    sourceSequence: configured.sourceSequence,
    finalityPolicyVersion: configured.finalityPolicyVersion,
    prepareAdapterId: configured.adapter,
    prepareAdapterVersion: ADAPTER_VERSION,
  };
}
