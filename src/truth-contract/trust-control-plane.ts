import { Effect, SynchronizedRef } from "effect";

import {
  jcsCanonicalize,
  sha256Hex,
  verifyEd25519Signature,
} from "../collection-resolver/trust-protocol.js";
import { canonicalizeTruthJson, hashCanonicalTruthJson } from "./canonical.js";
import { verifyTruthBundleRootWithSignatureService } from "./bundle-compiler.js";
import { TruthIntegrityError, TruthTrustError } from "./errors.js";
import {
  TRUTH_MAX_FUTURE_SKEW_MILLISECONDS,
  type TruthEnvironmentId,
  type TruthIsoTimestamp,
} from "./schemas/common.js";
import { decodeStrict } from "./schemas/common.js";
import {
  TrustBootstrapReceiptV1,
  TrustBootstrapUnsignedV1,
  TrustBootstrapV1,
  TrustRecoveryRequestV1,
  TrustRecoveryChallengeUnsignedV1,
  TruthQuorumApprovalV1,
  type TruthQuorumV1,
} from "./schemas/trust.js";
import {
  TruthGenerationActivationUnsignedV1,
  TruthGenerationActivationV1,
} from "./schemas/registry.js";
import type { DecimalUint64 } from "./schemas/common.js";
import type { TruthClockService, TruthSignerService } from "./services.js";
import type { TruthActivationVerifier } from "./registry-store.js";
import {
  applyAuthorizedTrustedGenerationAdvance,
  applyAuthorizedTrustedGenerationBootstrap,
  type RecoveryChallengeStoreService,
  type TrustedGenerationStoreService,
} from "./trust-state-store.js";
import { bootstrapIdentityBindingDigest } from "./bootstrap-equivocation-ledger.js";

const encoder = new TextEncoder();
const DAY_MS = 24 * 60 * 60 * 1_000;
const BOOTSTRAP_CEREMONY_MAX_AGE_MS = 5 * 60 * 1_000;

const trustFailure = (boundary: string, reason: string): TruthTrustError =>
  new TruthTrustError({ boundary, reason });

const unique = (values: ReadonlyArray<string>): boolean =>
  new Set(values).size === values.length;

export interface BootstrapEquivocation {
  readonly environment: TruthEnvironmentId;
  readonly identity_kind: "channel" | "operator" | "credential";
  readonly identity_id: string;
  readonly prior_digest: string;
  readonly conflicting_digest: string;
}

export interface BootstrapEquivocationAnchor {
  readonly sequence: DecimalUint64;
  readonly digest: string | null;
}

export interface BootstrapEquivocationLedger {
  readonly record: (
    receipt: TrustBootstrapReceiptV1,
    acceptedAt: TruthIsoTimestamp,
  ) => Effect.Effect<void, TruthTrustError>;
  readonly equivocations: Effect.Effect<
    ReadonlyArray<BootstrapEquivocation>,
    TruthTrustError
  >;
  readonly anchor: Effect.Effect<
    BootstrapEquivocationAnchor,
    TruthTrustError
  >;
}

interface BootstrapEquivocationState {
  readonly bindings: ReadonlyMap<string, string>;
  readonly equivocations: ReadonlyArray<BootstrapEquivocation>;
}

export const makeInMemoryBootstrapEquivocationLedger =
  (): BootstrapEquivocationLedger => {
    const state = SynchronizedRef.unsafeMake<BootstrapEquivocationState>({
      bindings: new Map(),
      equivocations: [],
    });
    return {
      record: (receipt) =>
        SynchronizedRef.modify(state, (current) => {
          const bindings = new Map(current.bindings);
          let conflict: BootstrapEquivocation | null = null;
          for (const observation of receipt.observations) {
            const identities = [
              ["channel", observation.channel_id],
              ["operator", observation.operator_id],
              ["credential", observation.credential_id],
            ] as const;
            for (const [kind, identity] of identities) {
              const key = `${receipt.environment}\0${kind}\0${identity}`;
              const prior = bindings.get(key);
              if (
                prior !== undefined &&
                prior !== observation.bundle_digest &&
                conflict === null
              ) {
                conflict = {
                  environment: receipt.environment,
                  identity_kind: kind,
                  identity_id: identity,
                  prior_digest: prior,
                  conflicting_digest: observation.bundle_digest,
                };
              } else if (prior === undefined) {
                bindings.set(key, observation.bundle_digest);
              }
            }
          }
          return [
            conflict,
            {
              bindings,
              equivocations:
                conflict === null
                  ? current.equivocations
                  : [...current.equivocations, conflict],
            },
          ] as const;
        }).pipe(
          Effect.flatMap((conflict) =>
            conflict === null
              ? Effect.void
              : Effect.fail(
                  trustFailure(
                    "truth.trust.bootstrap",
                    `bootstrap equivocation recorded for ${conflict.identity_kind} ${conflict.identity_id}`,
                  ),
                ),
          ),
        ),
      equivocations: SynchronizedRef.get(state).pipe(
        Effect.map((current) => [...current.equivocations]),
      ),
      anchor: SynchronizedRef.get(state).pipe(
        Effect.map((current) => {
          let digest: string | null = null;
          current.equivocations.forEach((conflict, index) => {
            digest = sha256Hex(
              jcsCanonicalize({
                sequence: String(index + 1),
                prior_digest: digest,
                conflict,
              }),
            );
          });
          return {
            sequence: String(current.equivocations.length) as DecimalUint64,
            digest,
          };
        }),
      ),
    };
  };

const validateQuorum = (
  name: string,
  quorum: TruthQuorumV1,
): Effect.Effect<void, TruthTrustError> => {
  const keyIds = quorum.keys.map((key) => String(key.key_id));
  const publicKeys = quorum.keys.map((key) => String(key.public_key_hex));
  if (
    !unique(keyIds) ||
    !unique(publicKeys) ||
    quorum.keys.length !== 2 ||
    quorum.threshold !== "2"
  ) {
    return Effect.fail(
      trustFailure(
        `truth.trust.${name}`,
        "normal v1 operation requires exactly two unique keys and a 2-of-2 threshold",
      ),
    );
  }
  return Effect.void;
};

const validateBootstrapPolicy = (
  unsigned: TrustBootstrapUnsignedV1,
): Effect.Effect<void, TruthTrustError> =>
  Effect.gen(function* () {
    yield* validateQuorum("governance_quorum", unsigned.governance_quorum);
    yield* validateQuorum("recovery_quorum", unsigned.recovery_quorum);
    const governance = unsigned.governance_quorum.keys.map((key) =>
      String(key.key_id),
    );
    const governancePublicKeys = unsigned.governance_quorum.keys.map((key) =>
      String(key.public_key_hex),
    );
    const recovery = new Set(
      unsigned.recovery_quorum.keys.map((key) => String(key.key_id)),
    );
    const recoveryPublicKeys = new Set(
      unsigned.recovery_quorum.keys.map((key) => String(key.public_key_hex)),
    );
    if (
      governance.some((key) => recovery.has(key)) ||
      governance.includes(unsigned.producer_root.key_id) ||
      recovery.has(unsigned.producer_root.key_id) ||
      governancePublicKeys.some((key) => recoveryPublicKeys.has(key)) ||
      governancePublicKeys.includes(unsigned.producer_root.public_key_hex) ||
      recoveryPublicKeys.has(unsigned.producer_root.public_key_hex)
    ) {
      return yield* Effect.fail(
        trustFailure(
          "truth.trust.bootstrap",
          "producer, governance, and recovery identities must be disjoint",
        ),
      );
    }
  });

export const compileTrustBootstrap = (
  input: unknown,
): Effect.Effect<TrustBootstrapV1, TruthTrustError | TruthIntegrityError> =>
  Effect.gen(function* () {
    const unsigned = yield* decodeStrict(
      TrustBootstrapUnsignedV1,
      "truth.trust.bootstrap",
      input,
    ).pipe(
      Effect.mapError(() =>
        trustFailure("truth.trust.bootstrap", "bootstrap schema is invalid"),
      ),
    );
    yield* validateBootstrapPolicy(unsigned);
    const bundleDigest = yield* hashCanonicalTruthJson(
      unsigned,
      "truth.trust.bootstrap.digest",
    );
    return yield* decodeStrict(TrustBootstrapV1, "truth.trust.bootstrap.bundle", {
      unsigned_bootstrap: unsigned,
      bundle_digest: bundleDigest,
    }).pipe(
      Effect.mapError(() =>
        trustFailure("truth.trust.bootstrap", "compiled bootstrap is invalid"),
      ),
    );
  });

export const verifyTrustBootstrapReceipt = (
  bundleInput: unknown,
  receiptInput: unknown,
  expectedEnvironment: TruthEnvironmentId,
  channelCredentials: ReadonlyMap<
    string,
    {
      readonly keyId: string;
      readonly publicKeyHex: string;
      readonly channelId: string;
      readonly operatorId: string;
    }
  >,
  equivocationLedger: BootstrapEquivocationLedger,
  acceptedAt: TruthIsoTimestamp,
): Effect.Effect<TrustBootstrapV1, TruthTrustError | TruthIntegrityError> =>
  Effect.gen(function* () {
    const bundle = yield* decodeStrict(
      TrustBootstrapV1,
      "truth.trust.bootstrap.bundle",
      bundleInput,
    ).pipe(
      Effect.mapError(() =>
        trustFailure("truth.trust.bootstrap", "bootstrap bundle is invalid"),
      ),
    );
    const receipt = yield* decodeStrict(
      TrustBootstrapReceiptV1,
      "truth.trust.bootstrap.receipt",
      receiptInput,
    ).pipe(
      Effect.mapError(() =>
        trustFailure("truth.trust.bootstrap", "bootstrap receipt is invalid"),
      ),
    );
    yield* validateBootstrapPolicy(bundle.unsigned_bootstrap);
    const acceptedAtMilliseconds = new Date(acceptedAt).getTime();
    const issuedAtMilliseconds = new Date(
      bundle.unsigned_bootstrap.issued_at,
    ).getTime();
    const observationTimes = receipt.observations.map((observation) =>
      new Date(observation.observed_at).getTime(),
    );
    const bootstrapKeys = [
      bundle.unsigned_bootstrap.producer_root,
      ...bundle.unsigned_bootstrap.governance_quorum.keys,
      ...bundle.unsigned_bootstrap.recovery_quorum.keys,
    ];
    if (
      !Number.isFinite(acceptedAtMilliseconds) ||
      !Number.isFinite(issuedAtMilliseconds) ||
      acceptedAtMilliseconds < issuedAtMilliseconds ||
      acceptedAtMilliseconds - issuedAtMilliseconds >
        BOOTSTRAP_CEREMONY_MAX_AGE_MS ||
      observationTimes.some(
        (observedAt) =>
          !Number.isFinite(observedAt) ||
          observedAt < issuedAtMilliseconds ||
          observedAt >
            acceptedAtMilliseconds + TRUTH_MAX_FUTURE_SKEW_MILLISECONDS ||
          acceptedAtMilliseconds - observedAt >
            BOOTSTRAP_CEREMONY_MAX_AGE_MS,
      ) ||
      bootstrapKeys.some((key) => {
        const validFrom = new Date(key.valid_from).getTime();
        const validUntil =
          key.valid_until === null
            ? null
            : new Date(key.valid_until).getTime();
        return (
          !Number.isFinite(validFrom) ||
          validFrom > acceptedAtMilliseconds ||
          (validUntil !== null &&
            (!Number.isFinite(validUntil) ||
              validUntil < acceptedAtMilliseconds))
        );
      })
    ) {
      return yield* Effect.fail(
        trustFailure(
          "truth.trust.bootstrap",
          "bootstrap ceremony timing or pinned key activation interval is untrusted",
        ),
      );
    }
    const actualDigest = yield* hashCanonicalTruthJson(
      bundle.unsigned_bootstrap,
      "truth.trust.bootstrap.verify",
    );
    const observations = receipt.observations;
    if (
      bundle.unsigned_bootstrap.environment !== expectedEnvironment ||
      receipt.environment !== expectedEnvironment ||
      actualDigest !== bundle.bundle_digest ||
      observations.some(
        (observation) => observation.bundle_digest !== bundle.bundle_digest,
      )
    ) {
      return yield* Effect.fail(
        trustFailure(
          "truth.trust.bootstrap",
          "environment or two-channel bootstrap digest mismatch",
        ),
      );
    }
    for (const field of ["channel_id", "operator_id", "credential_id"] as const) {
      if (!unique(observations.map((observation) => String(observation[field])))) {
        return yield* Effect.fail(
          trustFailure(
            "truth.trust.bootstrap",
            `bootstrap observations require independent ${field} values`,
          ),
        );
      }
    }
    const credentialKeyIds: string[] = [];
    const credentialPublicKeys: string[] = [];
    for (const observation of observations) {
      const credential = channelCredentials.get(observation.credential_id);
      if (
        credential === undefined ||
        credential.channelId !== observation.channel_id ||
        credential.operatorId !== observation.operator_id ||
        !verifyEd25519Signature(
          credential.publicKeyHex,
          bootstrapObservationSigningBytes(
            expectedEnvironment,
            observation,
          ),
          observation.signature,
        )
      ) {
        return yield* Effect.fail(
          trustFailure(
            "truth.trust.bootstrap",
            "bootstrap channel credential proof is invalid",
          ),
        );
      }
      credentialKeyIds.push(credential.keyId);
      credentialPublicKeys.push(credential.publicKeyHex);
    }
    if (
      !unique(credentialKeyIds) ||
      !unique(credentialPublicKeys)
    ) {
      return yield* Effect.fail(
        trustFailure(
          "truth.trust.bootstrap",
          "bootstrap channel credentials must resolve to distinct signing keys",
        ),
      );
    }
    yield* equivocationLedger.record(receipt, acceptedAt);
    return bundle;
  });

export const applyTrustBootstrapReceipt = (
  bundleInput: unknown,
  receiptInput: unknown,
  expectedEnvironment: TruthEnvironmentId,
  channelCredentials: Parameters<typeof verifyTrustBootstrapReceipt>[3],
  equivocationLedger: BootstrapEquivocationLedger,
  genesisActivationInput: unknown,
  clock: TruthClockService,
  store: TrustedGenerationStoreService,
) =>
  Effect.gen(function* () {
    const acceptedAt = yield* clock.now.pipe(
      Effect.mapError(() =>
        trustFailure(
          "truth.trust.bootstrap",
          "trusted bootstrap acceptance clock is unavailable",
        ),
      ),
    );
    const bundle = yield* verifyTrustBootstrapReceipt(
      bundleInput,
      receiptInput,
      expectedEnvironment,
      channelCredentials,
      equivocationLedger,
      acceptedAt,
    );
    const producerRoot = bundle.unsigned_bootstrap.producer_root;
    const producerVerifier: TruthSignerService = {
      keyId: producerRoot.key_id,
      sign: () =>
        Effect.fail(
          trustFailure(
            "truth.trust.bootstrap",
            "bootstrap producer verifier cannot sign",
          ),
        ),
      verify: (_environment, payload, signature) =>
        verifyEd25519Signature(
          producerRoot.public_key_hex,
          payload,
          signature,
        )
          ? Effect.void
          : Effect.fail(
              trustFailure(
                "truth.trust.bootstrap",
                "genesis activation is not signed by the pinned producer root",
              ),
            ),
    };
    const genesisActivation =
      yield* verifyTruthGenerationActivationForAdvance(
        genesisActivationInput,
        producerVerifier,
        expectedEnvironment,
        "0" as DecimalUint64,
        acceptedAt,
      );
    const verifiedReceipt = yield* decodeStrict(
      TrustBootstrapReceiptV1,
      "truth.trust.bootstrap.receipt",
      receiptInput,
    ).pipe(
      Effect.mapError(() =>
        trustFailure("truth.trust.bootstrap", "bootstrap receipt is invalid"),
      ),
    );
    const equivocationAnchor = yield* equivocationLedger.anchor;
    return yield* applyAuthorizedTrustedGenerationBootstrap(store, {
      environment: expectedEnvironment,
      generation: "1",
      recoveryNonce: "0",
      trustedRootHash:
        genesisActivation.unsigned_activation.root.root_hash,
      bootstrapDigest: bundle.bundle_digest,
      bootstrapBindingDigest:
        bootstrapIdentityBindingDigest(verifiedReceipt),
      bootstrapEquivocationSequence: equivocationAnchor.sequence,
      bootstrapEquivocationDigest: equivocationAnchor.digest,
      updatedAt: acceptedAt,
    });
  });

export const bootstrapObservationSigningBytes = (
  environment: TruthEnvironmentId,
  observation: Omit<
    TrustBootstrapReceiptV1["observations"][number],
    "signature"
  >,
): Uint8Array =>
  encoder.encode(
    `sonar.truth-bootstrap-observation.v1\0${jcsCanonicalize({
      environment,
      channel_id: observation.channel_id,
      operator_id: observation.operator_id,
      credential_id: observation.credential_id,
      bundle_digest: observation.bundle_digest,
      observed_at: observation.observed_at,
    })}`,
  );

export const quorumApprovalSigningBytes = (
  approval: TruthQuorumApprovalV1["unsigned_approval"],
): Effect.Effect<Uint8Array, TruthIntegrityError> =>
  canonicalizeTruthJson(approval, "truth.trust.quorum_approval").pipe(
    Effect.map(
      (canonical) =>
        encoder.encode(`sonar.truth-quorum-approval.v1\0${canonical}`),
    ),
  );

export const verifyQuorumApproval = (
  approvalInput: unknown,
  quorum: TruthQuorumV1,
  acceptedAt: TruthIsoTimestamp,
  compromisedKeyIds: ReadonlySet<string> = new Set(),
): Effect.Effect<TruthQuorumApprovalV1, TruthTrustError | TruthIntegrityError> =>
  Effect.gen(function* () {
    yield* validateQuorum("approval", quorum);
    const approval = yield* decodeStrict(
      TruthQuorumApprovalV1,
      "truth.trust.quorum_approval",
      approvalInput,
    ).pipe(
      Effect.mapError(() =>
        trustFailure("truth.trust.quorum_approval", "approval schema is invalid"),
      ),
    );
    const keyById = new Map(
      quorum.keys.map((key) => [String(key.key_id), key] as const),
    );
    const seen = new Set<string>();
    const bytes = yield* quorumApprovalSigningBytes(approval.unsigned_approval);
    const approvedAt = new Date(approval.unsigned_approval.approved_at).getTime();
    const trustedAcceptance = new Date(acceptedAt).getTime();
    if (
      !Number.isFinite(trustedAcceptance) ||
      Math.abs(trustedAcceptance - approvedAt) >
        TRUTH_MAX_FUTURE_SKEW_MILLISECONDS
    ) {
      return yield* Effect.fail(
        trustFailure(
          "truth.trust.quorum_approval",
          "approval time is not bound to trusted acceptance time",
        ),
      );
    }
    let valid = 0;
    for (const signature of approval.signatures) {
      const keyId = String(signature.key_id);
      const key = keyById.get(keyId);
      if (
        key === undefined ||
        seen.has(keyId) ||
        compromisedKeyIds.has(keyId) ||
        approvedAt < new Date(key.valid_from).getTime() ||
        (key.valid_until !== null &&
          approvedAt > new Date(key.valid_until).getTime()) ||
        !verifyEd25519Signature(key.public_key_hex, bytes, signature.signature)
      ) {
        return yield* Effect.fail(
          trustFailure(
            "truth.trust.quorum_approval",
            "unknown, duplicate, compromised, or invalid quorum signature",
          ),
        );
      }
      seen.add(keyId);
      valid += 1;
    }
    if (BigInt(valid) < BigInt(quorum.threshold)) {
      return yield* Effect.fail(
        trustFailure("truth.trust.quorum_approval", "partial quorum"),
      );
    }
    return approval;
  });

export const verifyRotationApproval = (
  approvalInput: unknown,
  bootstrap: TrustBootstrapV1,
  trustedState: {
    readonly generation: string;
    readonly nonce: string;
  },
  payloadHash: string,
  acceptedAt: TruthIsoTimestamp,
  compromisedKeyIds: ReadonlySet<string> = new Set(),
): Effect.Effect<TruthQuorumApprovalV1, TruthTrustError | TruthIntegrityError> =>
  Effect.gen(function* () {
    const approval = yield* decodeStrict(
      TruthQuorumApprovalV1,
      "truth.trust.rotation",
      approvalInput,
    ).pipe(
      Effect.mapError(() =>
        trustFailure("truth.trust.rotation", "rotation approval is invalid"),
      ),
    );
    if (
      approval.unsigned_approval.action !== "ROTATE" ||
      approval.unsigned_approval.environment !==
        bootstrap.unsigned_bootstrap.environment ||
      approval.unsigned_approval.generation !==
        (BigInt(trustedState.generation) + 1n).toString() ||
      BigInt(approval.unsigned_approval.nonce) <= BigInt(trustedState.nonce) ||
      approval.unsigned_approval.payload_hash !== payloadHash
    ) {
      return yield* Effect.fail(
        trustFailure(
          "truth.trust.rotation",
          "rotation is not bound to exact-next trusted state and payload",
        ),
      );
    }
    return yield* verifyQuorumApproval(
      approval,
      bootstrap.unsigned_bootstrap.governance_quorum,
      acceptedAt,
      compromisedKeyIds,
    );
  });

export const rotationTransitionPayloadHash = (input: {
  readonly environment: TruthEnvironmentId;
  readonly prior_generation: string;
  readonly generation: string;
  readonly current_root_hash: string;
  readonly next_root_hash: string;
}) =>
  hashCanonicalTruthJson(input, "truth.trust.rotation.transition");

export const applyTrustRotation = (
  approvalInput: unknown,
  bootstrap: TrustBootstrapV1,
  nextRootHash: string,
  acceptedAt: TruthIsoTimestamp,
  store: TrustedGenerationStoreService,
  compromisedKeyIds: ReadonlySet<string> = new Set(),
) =>
  Effect.gen(function* () {
    const environment = bootstrap.unsigned_bootstrap.environment;
    const current = yield* store.read(environment);
    if (current.unsigned_record.bootstrap_digest !== bootstrap.bundle_digest) {
      return yield* Effect.fail(
        trustFailure(
          "truth.trust.rotation",
          "rotation bootstrap does not match trusted state",
        ),
      );
    }
    const nextGeneration = (
      BigInt(current.unsigned_record.generation) + 1n
    ).toString();
    const payloadHash = yield* rotationTransitionPayloadHash({
      environment,
      prior_generation: current.unsigned_record.generation,
      generation: nextGeneration,
      current_root_hash: current.unsigned_record.trusted_root_hash,
      next_root_hash: nextRootHash,
    });
    const approval = yield* verifyRotationApproval(
      approvalInput,
      bootstrap,
      {
        generation: current.unsigned_record.generation,
        nonce: current.unsigned_record.recovery_nonce,
      },
      payloadHash,
      acceptedAt,
      compromisedKeyIds,
    );
    return yield* applyAuthorizedTrustedGenerationAdvance(store, {
      environment,
      expectedGeneration: current.unsigned_record.generation,
      nextGeneration,
      expectedRecoveryNonce: current.unsigned_record.recovery_nonce,
      nextRecoveryNonce: approval.unsigned_approval.nonce,
      expectedRootHash: current.unsigned_record.trusted_root_hash,
      nextRootHash,
      bootstrapDigest: current.unsigned_record.bootstrap_digest,
      bootstrapBindingDigest:
        current.unsigned_record.bootstrap_binding_digest,
      bootstrapEquivocationSequence:
        current.unsigned_record.bootstrap_equivocation_sequence,
      bootstrapEquivocationDigest:
        current.unsigned_record.bootstrap_equivocation_digest,
      updatedAt: acceptedAt,
    });
  });

export const recoveryChallengePayloadHash = (
  challenge: Pick<
    TrustRecoveryChallengeUnsignedV1,
    | "schema_version"
    | "challenge_id"
    | "environment"
    | "prior_generation"
    | "generation"
    | "prior_nonce"
    | "nonce"
    | "current_root_hash"
    | "next_root_hash"
    | "evidence_hash"
    | "challenge_started_at"
    | "challenge_ends_at"
  >,
) =>
  hashCanonicalTruthJson(
    {
      schema_version: challenge.schema_version,
      challenge_id: challenge.challenge_id,
      environment: challenge.environment,
      prior_generation: challenge.prior_generation,
      generation: challenge.generation,
      prior_nonce: challenge.prior_nonce,
      nonce: challenge.nonce,
      current_root_hash: challenge.current_root_hash,
      next_root_hash: challenge.next_root_hash,
      evidence_hash: challenge.evidence_hash,
      challenge_started_at: challenge.challenge_started_at,
      challenge_ends_at: challenge.challenge_ends_at,
    },
    "truth.trust.recovery.challenge",
  );

export const initiateRecoveryChallenge = (
  input: {
    readonly challengeId: string;
    readonly nonce: string;
    readonly nextRootHash: string;
    readonly evidenceBytes: Uint8Array;
    readonly initiationApproval: unknown;
  },
  bootstrap: TrustBootstrapV1,
  trustedNow: TruthIsoTimestamp,
  store: TrustedGenerationStoreService,
  challenges: RecoveryChallengeStoreService,
  compromisedKeyIds: ReadonlySet<string> = new Set(),
) =>
  Effect.gen(function* () {
    const environment = bootstrap.unsigned_bootstrap.environment;
    const current = yield* store.read(environment);
    if (current.unsigned_record.bootstrap_digest !== bootstrap.bundle_digest) {
      return yield* Effect.fail(
        trustFailure(
          "truth.trust.recovery",
          "recovery bootstrap does not match trusted state",
        ),
      );
    }
    const startedAt = new Date(trustedNow).getTime();
    const endsAt = new Date(startedAt + DAY_MS).toISOString() as TruthIsoTimestamp;
    const unsigned = {
      schema_version: 1,
      challenge_id: input.challengeId,
      environment,
      prior_generation: current.unsigned_record.generation,
      generation: (
        BigInt(current.unsigned_record.generation) + 1n
      ).toString(),
      prior_nonce: current.unsigned_record.recovery_nonce,
      nonce: input.nonce,
      current_root_hash: current.unsigned_record.trusted_root_hash,
      next_root_hash: input.nextRootHash,
      evidence_hash: sha256Hex(input.evidenceBytes),
      challenge_started_at: trustedNow,
      challenge_ends_at: endsAt,
      initiation_approval: input.initiationApproval,
      consumed_at: null,
    } as const;
    const payloadHash = yield* recoveryChallengePayloadHash(unsigned as never);
    const approval = yield* decodeStrict(
      TruthQuorumApprovalV1,
      "truth.trust.recovery.initiation",
      input.initiationApproval,
    ).pipe(
      Effect.mapError(() =>
        trustFailure(
          "truth.trust.recovery",
          "recovery initiation approval is invalid",
        ),
      ),
    );
    if (
      approval.unsigned_approval.action !== "RECOVER" ||
      approval.unsigned_approval.environment !== environment ||
      approval.unsigned_approval.generation !== unsigned.generation ||
      approval.unsigned_approval.nonce !== unsigned.nonce ||
      approval.unsigned_approval.payload_hash !== payloadHash
    ) {
      return yield* Effect.fail(
        trustFailure(
          "truth.trust.recovery",
          "recovery initiation is not bound to trusted state",
        ),
      );
    }
    yield* verifyQuorumApproval(
      approval,
      bootstrap.unsigned_bootstrap.governance_quorum,
      trustedNow,
      compromisedKeyIds,
    );
    const challenge = yield* decodeStrict(
      TrustRecoveryChallengeUnsignedV1,
      "truth.trust.recovery.challenge",
      {
        ...unsigned,
        initiation_approval: approval,
      },
    ).pipe(
      Effect.mapError(() =>
        trustFailure(
          "truth.trust.recovery",
          "recovery challenge is schema-invalid",
        ),
      ),
    );
    return yield* challenges.create(challenge);
  });

export const verifyRecoveryCeremony = (
  requestInput: unknown,
  bootstrap: TrustBootstrapV1,
  now: TruthIsoTimestamp,
  trustedState: {
    readonly generation: string;
    readonly recoveryNonce: string;
    readonly rootHash: string;
  },
  challenges: RecoveryChallengeStoreService,
  compromisedKeyIds: ReadonlySet<string> = new Set(),
): Effect.Effect<TrustRecoveryRequestV1, TruthTrustError | TruthIntegrityError> =>
  Effect.gen(function* () {
    const request = yield* decodeStrict(
      TrustRecoveryRequestV1,
      "truth.trust.recovery",
      requestInput,
    ).pipe(
      Effect.mapError(() =>
        trustFailure("truth.trust.recovery", "recovery request is invalid"),
      ),
    );
    const environment = bootstrap.unsigned_bootstrap.environment;
    const persisted = yield* challenges.read(
      environment,
      request.challenge_id,
    );
    const challenge = persisted.unsigned_challenge;
    const challengeStart = new Date(request.challenge_started_at).getTime();
    const challengeEnd = new Date(request.challenge_ends_at).getTime();
    if (
      request.environment !== environment ||
      challenge.consumed_at !== null ||
      challenge.challenge_id !== request.challenge_id ||
      challenge.prior_generation !== request.prior_generation ||
      challenge.generation !== request.generation ||
      challenge.prior_nonce !== request.prior_nonce ||
      challenge.nonce !== request.nonce ||
      challenge.current_root_hash !== request.current_root_hash ||
      challenge.next_root_hash !== request.next_root_hash ||
      challenge.evidence_hash !== request.evidence_hash ||
      challenge.challenge_started_at !== request.challenge_started_at ||
      challenge.challenge_ends_at !== request.challenge_ends_at ||
      request.prior_generation !== trustedState.generation ||
      request.prior_nonce !== trustedState.recoveryNonce ||
      request.current_root_hash !== trustedState.rootHash ||
      request.next_root_hash === trustedState.rootHash ||
      request.generation !== (BigInt(request.prior_generation) + 1n).toString() ||
      BigInt(request.nonce) <= BigInt(request.prior_nonce) ||
      challengeEnd - challengeStart < DAY_MS ||
      new Date(now).getTime() < challengeEnd
    ) {
      return yield* Effect.fail(
        trustFailure(
          "truth.trust.recovery",
          "recovery must preserve environment, monotonic state, and 24-hour challenge",
        ),
      );
    }
    const initiationHash = yield* recoveryChallengePayloadHash(challenge);
    if (
      challenge.initiation_approval.unsigned_approval.payload_hash !==
        initiationHash
    ) {
      return yield* Effect.fail(
        trustFailure(
          "truth.trust.recovery",
          "persisted recovery challenge authorization is invalid",
        ),
      );
    }
    yield* verifyQuorumApproval(
      challenge.initiation_approval,
      bootstrap.unsigned_bootstrap.governance_quorum,
      challenge.challenge_started_at,
      compromisedKeyIds,
    );
    const authorizationHash = yield* recoveryAuthorizationPayloadHash(request);
    for (const approval of [
      request.governance_approval,
      request.recovery_approval,
    ]) {
      if (
        approval.unsigned_approval.environment !== environment ||
        approval.unsigned_approval.action !== "RECOVER" ||
        approval.unsigned_approval.generation !== request.generation ||
        approval.unsigned_approval.nonce !== request.nonce ||
        approval.unsigned_approval.payload_hash !== authorizationHash
      ) {
        return yield* Effect.fail(
          trustFailure("truth.trust.recovery", "recovery approval is not bound to request"),
        );
      }
    }
    yield* verifyQuorumApproval(
      request.governance_approval,
      bootstrap.unsigned_bootstrap.governance_quorum,
      now,
      compromisedKeyIds,
    );
    yield* verifyQuorumApproval(
      request.recovery_approval,
      bootstrap.unsigned_bootstrap.recovery_quorum,
      now,
      compromisedKeyIds,
    );
    return request;
  });

export const recoveryAuthorizationPayloadHash = (
  request: Pick<
    TrustRecoveryRequestV1,
    | "schema_version"
    | "challenge_id"
    | "environment"
    | "prior_generation"
    | "generation"
    | "prior_nonce"
    | "nonce"
    | "current_root_hash"
    | "next_root_hash"
    | "evidence_hash"
    | "challenge_started_at"
    | "challenge_ends_at"
  >,
): Effect.Effect<string, TruthIntegrityError> =>
  hashCanonicalTruthJson(
    {
      schema_version: request.schema_version,
      challenge_id: request.challenge_id,
      environment: request.environment,
      prior_generation: request.prior_generation,
      generation: request.generation,
      prior_nonce: request.prior_nonce,
      nonce: request.nonce,
      current_root_hash: request.current_root_hash,
      next_root_hash: request.next_root_hash,
      evidence_hash: request.evidence_hash,
      challenge_started_at: request.challenge_started_at,
      challenge_ends_at: request.challenge_ends_at,
    },
    "truth.trust.recovery.authorization",
  );

export const applyRecoveryCeremony = (
  requestInput: unknown,
  bootstrap: TrustBootstrapV1,
  now: TruthIsoTimestamp,
  store: TrustedGenerationStoreService,
  challenges: RecoveryChallengeStoreService,
  compromisedKeyIds: ReadonlySet<string> = new Set(),
): Effect.Effect<
  "ACTIVE",
  TruthTrustError | TruthIntegrityError
> =>
  Effect.gen(function* () {
    const environment = bootstrap.unsigned_bootstrap.environment;
    const current = yield* store.read(environment);
    const request = yield* verifyRecoveryCeremony(
      requestInput,
      bootstrap,
      now,
      {
        generation: current.unsigned_record.generation,
        recoveryNonce: current.unsigned_record.recovery_nonce,
        rootHash: current.unsigned_record.trusted_root_hash,
      },
      challenges,
      compromisedKeyIds,
    );
    const persisted = yield* challenges.read(environment, request.challenge_id);
    yield* applyAuthorizedTrustedGenerationAdvance(store, {
      environment,
      expectedGeneration: current.unsigned_record.generation,
      nextGeneration: request.generation,
      expectedRecoveryNonce: current.unsigned_record.recovery_nonce,
      nextRecoveryNonce: request.nonce,
      expectedRootHash: current.unsigned_record.trusted_root_hash,
      nextRootHash: request.next_root_hash,
      bootstrapDigest: current.unsigned_record.bootstrap_digest,
      bootstrapBindingDigest:
        current.unsigned_record.bootstrap_binding_digest,
      bootstrapEquivocationSequence:
        current.unsigned_record.bootstrap_equivocation_sequence,
      bootstrapEquivocationDigest:
        current.unsigned_record.bootstrap_equivocation_digest,
      updatedAt: now,
    });
    yield* challenges.consume(
      environment,
      request.challenge_id,
      persisted.record_digest,
      now,
    );
    return "ACTIVE" as const;
  });

export const truthActivationSigningBytes = (
  environment: TruthEnvironmentId,
  generation: DecimalUint64,
  activationHash: string,
): Uint8Array =>
  encoder.encode(
    `sonar.truth-generation-activation.v1\0${environment}\0${generation}\0${activationHash}`,
  );

const verifyNestedRoot = (
  root: TruthGenerationActivationUnsignedV1["root"],
  signer: TruthSignerService,
  expectedEnvironment: TruthEnvironmentId,
  trustedGenerationHighWater: DecimalUint64,
  expectedGeneration: DecimalUint64,
  trustedNow: TruthIsoTimestamp,
): Effect.Effect<void, TruthTrustError | TruthIntegrityError> =>
  Effect.gen(function* () {
    yield* verifyTruthBundleRootWithSignatureService(root, {
      expectedEnvironment,
      expectedKeyId: signer.keyId,
      trustedGenerationHighWater,
      now: trustedNow,
      verifySignature: signer.verify,
    }).pipe(
      Effect.mapError((cause) =>
        cause._tag === "TruthDecodeError"
          ? trustFailure(
              "truth.trust.activation.root",
              "nested root schema is invalid",
            )
          : cause,
      ),
    );
    if (
      root.unsigned_root.generation !== expectedGeneration ||
      (trustedGenerationHighWater === "0"
        ? root.unsigned_root.supersedes_generation !== null
        : root.unsigned_root.supersedes_generation !==
          trustedGenerationHighWater)
    ) {
      return yield* Effect.fail(
        trustFailure(
          "truth.trust.activation.root",
          "nested root generation or supersession is untrusted",
        ),
      );
    }
  });

export const compileTruthGenerationActivation = (
  input: unknown,
  signer: TruthSignerService,
  trustedNow: TruthIsoTimestamp,
): Effect.Effect<
  TruthGenerationActivationV1,
  TruthTrustError | TruthIntegrityError
> =>
  Effect.gen(function* () {
    const unsigned = yield* decodeStrict(
      TruthGenerationActivationUnsignedV1,
      "truth.trust.activation",
      input,
    ).pipe(
      Effect.mapError(() =>
        trustFailure("truth.trust.activation", "activation schema is invalid"),
      ),
    );
    if (unsigned.issuer.key_id !== signer.keyId) {
      return yield* Effect.fail(
        trustFailure("truth.trust.activation", "activation issuer does not match signer"),
      );
    }
    if (
      unsigned.issuer.service_id !== unsigned.root.unsigned_root.issuer.service_id
    ) {
      return yield* Effect.fail(
        trustFailure(
          "truth.trust.activation",
          "activation and nested root service issuers differ",
        ),
      );
    }
    yield* verifyNestedRoot(
      unsigned.root,
      signer,
      unsigned.environment,
      unsigned.prior_generation,
      unsigned.generation,
      trustedNow,
    );
    const activationHash = yield* hashCanonicalTruthJson(
      unsigned,
      "truth.trust.activation.hash",
    );
    const signature = yield* signer.sign(
      unsigned.environment,
      truthActivationSigningBytes(
        unsigned.environment,
        unsigned.generation,
        activationHash,
      ),
    );
    return yield* decodeStrict(
      TruthGenerationActivationV1,
      "truth.trust.activation.signed",
      {
        unsigned_activation: unsigned,
        activation_hash: activationHash,
        signature,
      },
    ).pipe(
      Effect.mapError(() =>
        trustFailure("truth.trust.activation", "signed activation is invalid"),
      ),
    );
  });

export const verifyTruthGenerationActivationForAdvance = (
  activationInput: unknown,
  signer: TruthSignerService,
  expectedEnvironment: TruthEnvironmentId,
  trustedGenerationHighWater: DecimalUint64,
  trustedNow: TruthIsoTimestamp,
): Effect.Effect<
  TruthGenerationActivationV1,
  TruthTrustError | TruthIntegrityError
> =>
  Effect.gen(function* () {
    const activation = yield* decodeStrict(
      TruthGenerationActivationV1,
      "truth.trust.activation.verify",
      activationInput,
    ).pipe(
      Effect.mapError(() =>
        trustFailure("truth.trust.activation", "signed activation is invalid"),
      ),
    );
    const unsigned = activation.unsigned_activation;
    const actualHash = yield* hashCanonicalTruthJson(
      unsigned,
      "truth.trust.activation.verify_hash",
    );
    const expectedGeneration = (BigInt(trustedGenerationHighWater) + 1n).toString();
    if (
      unsigned.environment !== expectedEnvironment ||
      unsigned.root.unsigned_root.environment !== expectedEnvironment ||
      unsigned.issuer.key_id !== signer.keyId ||
      unsigned.issuer.service_id !== unsigned.root.unsigned_root.issuer.service_id ||
      unsigned.prior_generation !== trustedGenerationHighWater ||
      unsigned.generation !== expectedGeneration ||
      activation.activation_hash !== actualHash
    ) {
      return yield* Effect.fail(
        trustFailure(
          "truth.trust.activation",
          "activation environment, generation, issuer, or digest is untrusted",
        ),
      );
    }
    yield* verifyNestedRoot(
      unsigned.root,
      signer,
      expectedEnvironment,
      trustedGenerationHighWater,
      unsigned.generation,
      trustedNow,
    );
    yield* signer.verify(
      expectedEnvironment,
      truthActivationSigningBytes(
        expectedEnvironment,
        unsigned.generation,
        activation.activation_hash,
      ),
      activation.signature,
    );
    return activation;
  });

export const makeTruthActivationVerifier = (
  signer: TruthSignerService,
  trustedNow: TruthIsoTimestamp,
): TruthActivationVerifier => (
  environment,
  expectedGeneration,
  activation,
) =>
  verifyTruthGenerationActivationForAdvance(
    activation,
    signer,
    environment,
    expectedGeneration,
    trustedNow,
  ).pipe(Effect.asVoid);
