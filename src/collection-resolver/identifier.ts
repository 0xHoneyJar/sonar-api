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
 * CAIP-10 account id for EIP-155: `eip155:<positive-decimal-chain-id>:0x…`.
 * Address validation is still delegated to CR-001 after the qualifier is stripped.
 */
const EIP155_CAIP10_PATTERN = /^eip155:([1-9][0-9]*):(0x[0-9a-fA-F]{40})$/;

/**
 * CAIP-10-style Solana account id: `solana:<cluster>:<base58-pubkey>`.
 * Cluster + key validation remain CR-001's responsibility after strip.
 */
const SOLANA_CAIP10_PATTERN = /^solana:([a-z0-9][a-z0-9-]{0,63}):([1-9A-HJ-NP-Za-km-z]{32,44})$/;

/**
 * Classified resolve identifier: CR-001 CollectionIdentifier plus optional
 * network qualifier when the input was chain-qualified (CAIP-10).
 */
export interface ClassifiedCollectionIdentifier {
  readonly identifier: CollectionIdentifier;
  /** When set, fanout probes only this network (honor the qualifier). */
  readonly network_qualifier?: NetworkRef;
}

const decodeBareIdentifier = (
  raw: string,
): Effect.Effect<CollectionIdentifier, InvalidCollectionIdentifierError> =>
  Effect.gen(function* () {
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

/**
 * Classify a trimmed identifier into the CR-001 CollectionIdentifier wire shape,
 * optionally with a CAIP-10 / chain-qualified network constraint.
 *
 * Bare addresses fan out across healthy mainnet recognize capabilities for the
 * identifier family. Chain-qualified inputs (`eip155:80094:0x…`) probe only that
 * network when it is in the recognize capability set.
 *
 * Classification of the address portion is delegated to CR-001's strict decoder —
 * Sonar does not duplicate EVM/Base58 structural validation.
 */
export const classifyCollectionIdentifier = (
  rawInput: string,
): Effect.Effect<ClassifiedCollectionIdentifier, InvalidCollectionIdentifierError> => {
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
    const eip155Caip = EIP155_CAIP10_PATTERN.exec(raw);
    if (eip155Caip !== null) {
      const chainId = eip155Caip[1]!;
      const address = eip155Caip[2]!;
      const identifier = yield* decodeBareIdentifier(address);
      if (identifier.format !== "evm_address") {
        return yield* Effect.fail(
          new InvalidCollectionIdentifierError({
            raw,
            reason: "eip155 CAIP-10 qualifier requires an EVM address account id",
          }),
        );
      }
      return {
        identifier,
        network_qualifier: {
          schema_version: COLLECTION_PROTOCOL_SCHEMA_VERSION,
          network_namespace: "eip155",
          network_reference: chainId,
        },
      };
    }

    const solanaCaip = SOLANA_CAIP10_PATTERN.exec(raw);
    if (solanaCaip !== null) {
      const cluster = solanaCaip[1]!;
      const pubkey = solanaCaip[2]!;
      const identifier = yield* decodeBareIdentifier(pubkey);
      if (identifier.format !== "solana_public_key") {
        return yield* Effect.fail(
          new InvalidCollectionIdentifierError({
            raw,
            reason: "solana CAIP-10 qualifier requires a Solana public key account id",
          }),
        );
      }
      return {
        identifier,
        network_qualifier: {
          schema_version: COLLECTION_PROTOCOL_SCHEMA_VERSION,
          network_namespace: "solana",
          network_reference: cluster,
        },
      };
    }

    const identifier = yield* decodeBareIdentifier(raw);
    return { identifier };
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
  classified: ClassifiedCollectionIdentifier,
): ReadonlyArray<RecognizeCapability> =>
  snapshot.capabilities.filter((capability) => {
    if (!capability.recognize) return false;
    if (capability.environment !== "mainnet") return false;
    if (capability.health === "disabled") return false;
    if (classified.network_qualifier !== undefined) {
      return networkKey(capability.network) === networkKey(classified.network_qualifier);
    }
    if (classified.identifier.format === "evm_address") {
      return capability.network.network_namespace === "eip155";
    }
    return capability.network.network_namespace === "solana";
  });
