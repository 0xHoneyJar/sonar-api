import { Effect, Schema } from "effect";

import {
  DecimalUint64,
  Sha256Digest,
  TruthIdentifier,
  TruthIsoTimestamp,
  decodeStrict,
} from "./schemas/common.js";
import { TruthProviderHeadObservationV1 } from "./schemas/readiness.js";
import { TruthIntegrityError, TruthTransportError } from "./errors.js";
import type { IdentityBindingV1 } from "./schemas/normative.js";

const EvmIdentityObservationV1 = Schema.Struct({
  chain_id: DecimalUint64,
  canonical_address: TruthIdentifier,
  observed_height: DecimalUint64,
  observed_hash: Sha256Digest,
  observed_at: TruthIsoTimestamp,
  finality_policy_version: TruthIdentifier,
  providers: Schema.Array(TruthProviderHeadObservationV1).pipe(
    Schema.minItems(2),
    Schema.maxItems(16),
  ),
  deployed_identity_hash: Sha256Digest,
  deployed_code_hash: Sha256Digest,
  proxy_kind: Schema.Literal(
    "NONE",
    "EIP1967",
    "BEACON",
    "MINIMAL",
    "UNRESOLVABLE",
  ),
  implementation_address: Schema.NullOr(TruthIdentifier),
  implementation_code_hash: Schema.NullOr(Sha256Digest),
  upgrade_mechanism: Schema.Literal(
    "IMMUTABLE",
    "ADMIN",
    "BEACON",
    "METAMORPHIC",
    "UNRESOLVABLE",
  ),
  code_evidence_id: TruthIdentifier,
  code_evidence_sha256: Sha256Digest,
});
type EvmIdentityObservationV1 = Schema.Schema.Type<typeof EvmIdentityObservationV1>;

const EvmIdentityCompilationRequestV1 = Schema.Struct({
  canonicalCollectionId: TruthIdentifier,
  chainId: DecimalUint64,
  canonicalAddress: Schema.String.pipe(
    Schema.pattern(/^0x[0-9a-f]{40}$/),
  ),
  aliases: Schema.Array(TruthIdentifier).pipe(Schema.maxItems(128)),
  configDigest: Sha256Digest,
  configSource: TruthIdentifier,
  expectedFinalityPolicyVersion: TruthIdentifier,
  validFrom: TruthIsoTimestamp,
  validUntil: TruthIsoTimestamp,
  statusExpiresAt: TruthIsoTimestamp,
});

export interface EvmIdentityCompilationRequest {
  readonly canonicalCollectionId: string;
  readonly chainId: string;
  readonly canonicalAddress: string;
  readonly aliases: ReadonlyArray<string>;
  readonly configDigest: string;
  readonly configSource: string;
  readonly expectedFinalityPolicyVersion: string;
  readonly validFrom: string;
  readonly validUntil: string;
  readonly statusExpiresAt: string;
}

export interface EvmIdentityObservationPort {
  readonly resolve: (
    request: EvmIdentityCompilationRequest,
  ) => Effect.Effect<unknown, TruthTransportError>;
}

export type CompiledEvmIdentityResult =
  | {
      readonly _tag: "VERIFIED";
      readonly binding: IdentityBindingV1;
    }
  | {
      readonly _tag: "UNRESOLVED";
      readonly reason:
        | "SOURCE_FAILURE"
        | "OBSERVATION_INVALID"
        | "FINALITY_UNPROVEN"
        | "PROVIDER_CORRELATED"
        | "PROXY_INCOMPLETE"
        | "IDENTITY_MISMATCH";
    };

const unresolved = (
  reason: Extract<CompiledEvmIdentityResult, { _tag: "UNRESOLVED" }>["reason"],
): CompiledEvmIdentityResult => ({ _tag: "UNRESOLVED", reason });

const compileObservation = (
  request: EvmIdentityCompilationRequest,
  observation: EvmIdentityObservationV1,
): Effect.Effect<CompiledEvmIdentityResult, TruthIntegrityError> =>
  Effect.gen(function* () {
    if (
      String(observation.chain_id) !== request.chainId ||
      String(observation.canonical_address).toLowerCase() !==
        request.canonicalAddress.toLowerCase()
    ) {
      return unresolved("IDENTITY_MISMATCH");
    }
    if (
      observation.finality_policy_version !==
        request.expectedFinalityPolicyVersion ||
      observation.providers.some(
        (provider) =>
          provider.source_error ||
          provider.finality_method !== "FINALIZED_TAG" ||
          provider.finalized_tag !== "finalized" ||
          provider.height !== observation.observed_height ||
          provider.block_hash !== observation.observed_hash ||
          provider.observed_at !== observation.observed_at,
      )
    ) {
      return unresolved("FINALITY_UNPROVEN");
    }
    const ids = observation.providers.map((provider) => String(provider.provider_id));
    const operators = observation.providers.map((provider) => String(provider.operator));
    const domains = observation.providers.map((provider) =>
      String(provider.control_domain),
    );
    if (
      new Set(ids).size !== ids.length ||
      new Set(operators).size < 2 ||
      new Set(domains).size < 2
    ) {
      return unresolved("PROVIDER_CORRELATED");
    }
    const hasImplementation =
      observation.implementation_address !== null &&
      observation.implementation_code_hash !== null;
    const proxyComplete =
      (observation.proxy_kind === "NONE" &&
        observation.implementation_address === null &&
        observation.implementation_code_hash === null &&
        observation.upgrade_mechanism === "IMMUTABLE") ||
      (observation.proxy_kind === "MINIMAL" &&
        hasImplementation &&
        observation.upgrade_mechanism === "IMMUTABLE") ||
      (observation.proxy_kind === "EIP1967" &&
        hasImplementation &&
        observation.upgrade_mechanism === "ADMIN") ||
      (observation.proxy_kind === "BEACON" &&
        hasImplementation &&
        observation.upgrade_mechanism === "BEACON");
    if (!proxyComplete) return unresolved("PROXY_INCOMPLETE");
    if (
      new Date(request.validUntil).getTime() <=
        new Date(request.validFrom).getTime() ||
      new Date(request.validFrom).getTime() >
        new Date(observation.observed_at).getTime() ||
      new Date(request.statusExpiresAt).getTime() <=
        new Date(observation.observed_at).getTime()
    ) {
      return yield* Effect.fail(
        new TruthIntegrityError({
          boundary: "truth.identity-compiler.validity",
          reason: "identity validity interval is invalid",
        }),
      );
    }
    const evidence = [
      {
        evidence_id: observation.code_evidence_id,
        sha256: observation.code_evidence_sha256,
      },
      ...observation.providers.map((provider) => provider.evidence),
    ].sort((left, right) =>
      `${left.evidence_id}\0${left.sha256}`.localeCompare(
        `${right.evidence_id}\0${right.sha256}`,
      ),
    );
    return {
      _tag: "VERIFIED",
      binding: {
        canonical_collection_id: request.canonicalCollectionId as never,
        chain_family: "EVM",
        chain_id: request.chainId as never,
        canonical_address: request.canonicalAddress.toLowerCase() as never,
        aliases: [...request.aliases].sort() as never,
        config_digest: request.configDigest as never,
        config_source: request.configSource as never,
        observed_height: observation.observed_height,
        observed_hash: observation.observed_hash,
        observed_at: observation.observed_at,
        finality_policy_version: observation.finality_policy_version,
        deployed_identity_hash: observation.deployed_identity_hash,
        deployed_code_hash: observation.deployed_code_hash,
        proxy_kind: observation.proxy_kind,
        implementation_address: observation.implementation_address,
        implementation_code_hash: observation.implementation_code_hash,
        upgrade_mechanism: observation.upgrade_mechanism,
        valid_from: request.validFrom as never,
        valid_until: request.validUntil as never,
        supersedes_snapshot: null,
        contest_state: "CLEAR",
        evidence,
        effective_status: {
          _tag: "READY",
          reasons: ["FIXTURE_IDENTITY_VERIFIED" as never],
          evidence: [
            {
              evidence_id: "mibera-identity-fixture" as never,
              sha256: observation.code_evidence_sha256,
            },
          ],
          evaluated_at: observation.observed_at,
          expires_at: request.statusExpiresAt as never,
          invalidation_epoch: "0" as never,
        },
      },
    };
  });

export const compileFinalizedEvmIdentity = (
  request: EvmIdentityCompilationRequest,
  port: EvmIdentityObservationPort,
): Effect.Effect<CompiledEvmIdentityResult, TruthIntegrityError> =>
  decodeStrict(
    EvmIdentityCompilationRequestV1,
    "truth.identity-compiler.request",
    request,
  ).pipe(
    Effect.flatMap((decodedRequest) => {
      const normalizedRequest: EvmIdentityCompilationRequest = {
        canonicalCollectionId: String(decodedRequest.canonicalCollectionId),
        chainId: String(decodedRequest.chainId),
        canonicalAddress: decodedRequest.canonicalAddress,
        aliases: decodedRequest.aliases.map(String),
        configDigest: String(decodedRequest.configDigest),
        configSource: String(decodedRequest.configSource),
        expectedFinalityPolicyVersion: String(
          decodedRequest.expectedFinalityPolicyVersion,
        ),
        validFrom: String(decodedRequest.validFrom),
        validUntil: String(decodedRequest.validUntil),
        statusExpiresAt: String(decodedRequest.statusExpiresAt),
      };
      return port.resolve(normalizedRequest).pipe(
        Effect.flatMap((rawObservation) =>
          decodeStrict(
            EvmIdentityObservationV1,
            "truth.identity-compiler.observation",
            rawObservation,
          ).pipe(
            Effect.flatMap((observation) =>
              compileObservation(normalizedRequest, observation),
            ),
            Effect.catchTag("TruthDecodeError", () =>
              Effect.succeed(unresolved("OBSERVATION_INVALID")),
            ),
          ),
        ),
        Effect.catchTag("TruthTransportError", () =>
          Effect.succeed(unresolved("SOURCE_FAILURE")),
        ),
      );
    }),
    Effect.catchTag("TruthDecodeError", () =>
      Effect.succeed(unresolved("OBSERVATION_INVALID")),
    ),
  );
