import type { CollectionIdentifier } from "../protocol.js";
import type { CapabilitySnapshot, RecognizeCapability } from "../identifier.js";
import {
  isOperationEnabledAndHealthy,
  networkIdentityKey,
} from "./keys.js";
import type { CapabilityRegistrySnapshot } from "./snapshot.js";
import type { NetworkCapability } from "./schemas.js";

export interface DefaultSearchHit {
  readonly snapshot_identity: CapabilityRegistrySnapshot["version"];
  readonly network: NetworkCapability;
}

const sortHits = (
  hits: ReadonlyArray<DefaultSearchHit>,
): ReadonlyArray<DefaultSearchHit> =>
  hits
    .slice()
    .sort((left, right) => {
      if (left.network.network_priority !== right.network.network_priority) {
        return left.network.network_priority - right.network.network_priority;
      }
      const leftKey = networkIdentityKey(left.network.network);
      const rightKey = networkIdentityKey(right.network.network);
      if (leftKey < rightKey) return -1;
      if (leftKey > rightKey) return 1;
      return 0;
    });

const matchesIdentifier = (
  network: NetworkCapability,
  identifier?: CollectionIdentifier,
): boolean => {
  if (identifier === undefined) return true;
  if (
    identifier.format === "evm_address" &&
    network.network.network_namespace !== "eip155"
  ) {
    return false;
  }
  if (
    identifier.format === "solana_public_key" &&
    network.network.network_namespace !== "solana"
  ) {
    return false;
  }
  return true;
};

/**
 * Default search: enabled healthy (state=available) mainnet recognize capabilities.
 * Kill-switched, testnet, disabled, and degraded rows are excluded.
 * Degraded entries are available only via `selectDiagnosticRecognizeNetworks`.
 */
export const selectDefaultRecognizeNetworks = (
  snapshot: CapabilityRegistrySnapshot,
  identifier?: CollectionIdentifier,
): ReadonlyArray<DefaultSearchHit> => {
  const hits: DefaultSearchHit[] = [];

  for (const network of snapshot.networks) {
    if (network.environment !== "mainnet") continue;
    if (network.kill_switch) continue;

    const recognize = network.operations.recognize;
    if (!isOperationEnabledAndHealthy(recognize)) continue;
    if (!matchesIdentifier(network, identifier)) continue;

    hits.push({
      snapshot_identity: snapshot.version,
      network,
    });
  }

  return sortHits(hits);
};

/**
 * Explicit diagnostic opt-in search. Includes degraded recognize rows that are
 * enabled and not kill-switched. Must not be confused with default resolvable
 * targets — callers must pass `include_degraded: true` deliberately.
 */
export const selectDiagnosticRecognizeNetworks = (
  snapshot: CapabilityRegistrySnapshot,
  options: {
    readonly include_degraded: true;
    readonly identifier?: CollectionIdentifier;
  },
): ReadonlyArray<DefaultSearchHit> => {
  const hits: DefaultSearchHit[] = [];

  for (const network of snapshot.networks) {
    if (network.environment !== "mainnet") continue;
    if (network.kill_switch) continue;

    const recognize = network.operations.recognize;
    if (!recognize.enabled) continue;
    if (recognize.state === "disabled") continue;
    if (!matchesIdentifier(network, options.identifier)) continue;

    hits.push({
      snapshot_identity: snapshot.version,
      network,
    });
  }

  return sortHits(hits);
};

/**
 * Project a full CR-101 registry snapshot into the CR-003 ResolveCapability
 * shape used by hermetic resolveProbe. Uses default healthy search only.
 */
export const toRecognizeCapabilitySnapshot = (
  snapshot: CapabilityRegistrySnapshot,
): CapabilitySnapshot => {
  const capabilities: RecognizeCapability[] = selectDefaultRecognizeNetworks(snapshot).map(
    ({ network }) => {
      const recognize = network.operations.recognize;
      return {
        network: network.network,
        display_name: network.display.display_name,
        environment: "mainnet",
        probe_adapter: network.probe_adapter.adapter_id,
        recognize: recognize.enabled && recognize.state === "available",
        index:
          network.index_support &&
          isOperationEnabledAndHealthy(network.operations.prepare),
        supported_standards: [...network.supported_standards],
        finality_policy_version: network.finality_policy.policy_version,
        health: "available",
      };
    },
  );

  return {
    version: snapshot.version,
    capabilities,
  };
};
