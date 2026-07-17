import { Effect } from "effect";

import {
  COLLECTION_PROTOCOL_SCHEMA_VERSION,
  makeCollectionDeploymentRef,
  type CollectionDeploymentRef,
} from "../collection-resolver/protocol.js";
import type { CollectionKey } from "./types.js";

const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

export function parseChainId(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const chainId = Number(raw);
  if (!Number.isSafeInteger(chainId) || chainId <= 0) return null;
  return chainId;
}

export function normalizeContractAddress(raw: string): `0x${string}` | null {
  const trimmed = raw.trim();
  if (!EVM_ADDRESS_RE.test(trimmed)) return null;
  return trimmed.toLowerCase() as `0x${string}`;
}

export function collectionKeyFromParams(
  chainIdRaw: string,
  contractRaw: string,
): CollectionKey | null {
  const chainId = parseChainId(chainIdRaw);
  const contract = normalizeContractAddress(contractRaw);
  if (chainId === null || contract === null) return null;
  return { chainId, contract };
}

export function collectionKeyId(key: CollectionKey): string {
  return `${key.chainId}:${key.contract}`;
}

export async function deploymentFromCollectionKey(key: CollectionKey): Promise<CollectionDeploymentRef> {
  return Effect.runPromise(
    makeCollectionDeploymentRef({
      schema_version: COLLECTION_PROTOCOL_SCHEMA_VERSION,
      network: {
        schema_version: COLLECTION_PROTOCOL_SCHEMA_VERSION,
        network_namespace: "eip155",
        network_reference: String(key.chainId),
      },
      address: key.contract,
    }),
  );
}

export function deploymentIdentityKey(deployment: CollectionDeploymentRef): string {
  return deployment.deployment_id.digest;
}

export function physicalJobKey(args: {
  deployment: CollectionDeploymentRef;
  capabilityId: string;
  capabilityVersion: string;
}): string {
  return `${deploymentIdentityKey(args.deployment)}:${args.capabilityId}:${args.capabilityVersion}`;
}

export function makePhysicalJobId(args: {
  deployment: CollectionDeploymentRef;
  capabilityVersion: string;
}): string {
  return `ingest_${args.deployment.deployment_id.digest.slice(0, 32)}_${args.capabilityVersion.slice(0, 16)}`;
}

/** Historical helper retained for exact legacy response stability. */
export function makeIngestJobId(key: CollectionKey): string {
  return `ingest_${key.chainId}_${key.contract.slice(2)}`;
}

export function collectionKeyFromDeployment(
  deployment: CollectionDeploymentRef,
): CollectionKey | undefined {
  if (deployment.network.network_namespace !== "eip155") return undefined;
  const chainId = parseChainId(deployment.network.network_reference);
  const contract = normalizeContractAddress(deployment.normalized_address);
  return chainId === null || contract === null ? undefined : { chainId, contract };
}
