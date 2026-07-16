import { Data, Effect } from "effect";
import {
  COLLECTION_PROTOCOL_SCHEMA_VERSION,
  decodeCollectionIdentifier,
  type CollectionIdentifier,
  type NetworkRef,
} from "./protocol.js";

export class InvalidCollectionIdentifierError extends Data.TaggedError(
  "InvalidCollectionIdentifierError",
)<{
  readonly raw: string;
  readonly reason: string;
}> {}

const SUPPORTED_IDENTIFIER_FORMATS = ["evm_address", "solana_public_key"] as const;

/**
 * Classify a trimmed identifier into the CR-001 CollectionIdentifier wire shape.
 *
 * Classification is delegated to CR-001's strict decoder for each supported
 * format — Sonar does not duplicate EVM/Base58 structural validation.
 */
export const classifyCollectionIdentifier = (
  rawInput: string,
): Effect.Effect<CollectionIdentifier, InvalidCollectionIdentifierError> => {
  const raw = rawInput.trim();
  if (raw.length === 0) {
    return Effect.fail(
      new InvalidCollectionIdentifierError({
        raw: rawInput,
        reason: "identifier is empty",
      }),
    );
  }

  return Effect.gen(function* () {
    for (const format of SUPPORTED_IDENTIFIER_FORMATS) {
      const decoded = yield* Effect.either(
        decodeCollectionIdentifier({
          schema_version: COLLECTION_PROTOCOL_SCHEMA_VERSION,
          raw,
          format,
        }),
      );
      if (decoded._tag === "Right") {
        return decoded.right;
      }
    }

    return yield* Effect.fail(
      new InvalidCollectionIdentifierError({
        raw,
        reason:
          "identifier failed CR-001 strict decode for every supported format (evm_address, solana_public_key)",
      }),
    );
  });
};

export const networkKey = (network: NetworkRef): string =>
  `${network.network_namespace}:${network.network_reference}`;

export const compareNetworkRef = (left: NetworkRef, right: NetworkRef): number => {
  const leftKey = networkKey(left);
  const rightKey = networkKey(right);
  if (leftKey < rightKey) return -1;
  if (leftKey > rightKey) return 1;
  return 0;
};

export type CapabilityHealth = "available" | "degraded" | "disabled";

export interface RecognizeCapability {
  readonly network: NetworkRef;
  readonly display_name: string;
  readonly environment: "mainnet";
  readonly probe_adapter: "evm_rpc" | "solana_das";
  readonly recognize: boolean;
  readonly index: boolean;
  readonly supported_standards: ReadonlyArray<string>;
  readonly finality_policy_version: string;
  readonly health: CapabilityHealth;
}

export interface CapabilitySnapshot {
  readonly version: {
    readonly registry_epoch: string;
    readonly registry_sequence: string;
  };
  readonly capabilities: ReadonlyArray<RecognizeCapability>;
}

export const selectRecognizeCapabilities = (
  snapshot: CapabilitySnapshot,
  identifier: CollectionIdentifier,
): ReadonlyArray<RecognizeCapability> =>
  snapshot.capabilities.filter((capability) => {
    if (!capability.recognize) return false;
    if (capability.environment !== "mainnet") return false;
    if (capability.health === "disabled") return false;
    if (identifier.format === "evm_address") {
      return capability.network.network_namespace === "eip155";
    }
    return capability.network.network_namespace === "solana";
  });
