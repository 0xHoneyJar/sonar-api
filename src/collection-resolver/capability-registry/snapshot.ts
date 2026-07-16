import { Effect, Schema } from "effect";
import type { ParseOptions } from "effect/SchemaAST";
import {
  CapabilityRegistryVersion,
  digestVersioned,
  type VersionedDigest,
} from "../protocol.js";
import {
  CapabilityRegistryDecodeError,
  CapabilityRegistryValidationError,
} from "./errors.js";
import { cloneFreeze } from "./immutable.js";
import {
  CAPABILITY_REGISTRY_DIGEST_DOMAIN,
  CAPABILITY_REGISTRY_SCHEMA_VERSION,
  CapabilityRegistrySnapshotInput,
  type NetworkCapability,
} from "./schemas.js";
import { validateNetworkSet } from "./validation.js";

const strictOptions: ParseOptions = {
  errors: "all",
  onExcessProperty: "error",
};

const decodeSnapshotInput = Schema.decodeUnknown(
  CapabilityRegistrySnapshotInput,
  strictOptions,
);

export interface CapabilityRegistrySnapshot {
  readonly schema_version: typeof CAPABILITY_REGISTRY_SCHEMA_VERSION;
  readonly version: CapabilityRegistryVersion;
  readonly networks: ReadonlyArray<NetworkCapability>;
  readonly snapshot_digest: VersionedDigest;
}

const snapshotDigestMaterial = (input: {
  readonly schema_version: number;
  readonly version: CapabilityRegistryVersion;
  readonly networks: ReadonlyArray<NetworkCapability>;
}): unknown => ({
  networks: input.networks,
  schema_version: input.schema_version,
  version: input.version,
});

const refuseUnknownMajor = (
  input: unknown,
): Effect.Effect<void, CapabilityRegistryDecodeError> => {
  if (
    typeof input === "object" &&
    input !== null &&
    "schema_version" in input &&
    (input as { schema_version: unknown }).schema_version !==
      CAPABILITY_REGISTRY_SCHEMA_VERSION
  ) {
    return Effect.fail(
      new CapabilityRegistryDecodeError({
        reason: `unknown capability registry schema major: ${String(
          (input as { schema_version: unknown }).schema_version,
        )}`,
        cause: undefined,
      }),
    );
  }
  return Effect.void;
};

/**
 * Strict-decode + validate + digest + freeze a capability registry snapshot.
 * Every resolution-facing lookup must return `version` (snapshot identity).
 */
export const decodeCapabilityRegistrySnapshot = (
  input: unknown,
): Effect.Effect<
  CapabilityRegistrySnapshot,
  CapabilityRegistryDecodeError | CapabilityRegistryValidationError
> =>
  Effect.gen(function* () {
    yield* refuseUnknownMajor(input);
    const decoded = yield* decodeSnapshotInput(input).pipe(
      Effect.mapError(
        (cause) =>
          new CapabilityRegistryDecodeError({
            reason: "capability registry snapshot failed strict Effect Schema decode",
            cause,
          }),
      ),
    );
    yield* validateNetworkSet(decoded.networks);
    const snapshot_digest = yield* digestVersioned(
      CAPABILITY_REGISTRY_DIGEST_DOMAIN,
      1,
      snapshotDigestMaterial(decoded),
    ).pipe(
      Effect.mapError(
        (cause) =>
          new CapabilityRegistryDecodeError({
            reason: "failed to compute capability registry snapshot digest",
            cause,
          }),
      ),
    );

    const frozen = cloneFreeze({
      schema_version: decoded.schema_version,
      version: decoded.version,
      networks: decoded.networks,
      snapshot_digest,
    });
    return frozen;
  });

export const getSnapshotIdentity = (
  snapshot: CapabilityRegistrySnapshot,
): CapabilityRegistryVersion => snapshot.version;

export const lookupNetwork = (
  snapshot: CapabilityRegistrySnapshot,
  networkKey: string,
): {
  readonly snapshot_identity: CapabilityRegistryVersion;
  readonly network: NetworkCapability | undefined;
} => {
  const network = snapshot.networks.find(
    (entry) =>
      `${entry.network.network_namespace}:${entry.network.network_reference}` ===
      networkKey,
  );
  return {
    snapshot_identity: snapshot.version,
    network,
  };
};
