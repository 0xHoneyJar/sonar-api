import { Context, Effect, Layer } from "effect";

import {
  jcsCanonicalize,
  sha256Hex,
  type TrustEnvelopeSigner,
  verifyEd25519Signature,
} from "../collection-resolver/trust-protocol.js";
import {
  rebuildTruthStatusProjectionV1,
  type LifecycleAuthority,
  type ProjectionAuthorityRegistryV1,
  type SignedProjectionEventV1,
} from "./invalidation.js";
import {
  TruthCompatibilityError,
  TruthIntegrityError,
  TruthTrustError,
} from "./errors.js";
import {
  type SonarTruthTargetState,
  type TruthInspectionArtifactV1,
  TruthInspectionEnvelopeUnsignedV1,
  TruthInspectionEnvelopeV1,
  type TruthInspectionProjectionAuthorityV1,
  type TruthInspectionProjectionEventV1,
  type TruthInspectionSnapshotV1,
  TRUTH_INSPECTION_ENVELOPE_DOMAIN,
} from "./schemas/inspection.js";
import {
  decodeStrict,
  type Sha256Digest,
  type TruthEnvironmentId,
  type TruthIsoTimestamp,
} from "./schemas/common.js";

const encoder = new TextEncoder();
const INSPECTION_SIGNING_DOMAIN = `${TRUTH_INSPECTION_ENVELOPE_DOMAIN}\0`;
const verifiedInspectionSource = Symbol("VerifiedTruthInspectionSourceV1");

export interface SonarTruthStatusV1 {
  readonly target_state: SonarTruthTargetState;
  readonly target_ready: boolean;
  readonly lifecycle: "PRODUCED" | "RECONCILED";
  readonly display_state:
    | "PRODUCED_STAGED"
    | "RECONCILED_STAGED"
    | "NOT_CONSUMED"
    | "NOT_CONSUMED_OVERDUE";
  readonly effective_status:
    | "READY"
    | "NOT_READY"
    | "SUSPENDED"
    | "EXPIRED";
  readonly reason_codes: readonly string[];
  readonly blocking_owner: "bd-v54z.1" | null;
  readonly blocking_deadline: TruthIsoTimestamp | null;
  readonly snapshot: TruthInspectionSnapshotV1;
}

export interface TruthArtifactExplanationV1 {
  readonly artifact: TruthInspectionArtifactV1;
  readonly transitive_dependency_count: number;
}

export interface TruthRebuildResultV1 {
  readonly environment: TruthEnvironmentId;
  readonly served_projection_digest: Sha256Digest;
  readonly rebuilt_projection_digest: Sha256Digest;
  readonly equal: boolean;
}

export interface TruthInspectorService {
  readonly evaluateTarget: (
    targetState: SonarTruthTargetState,
    now: TruthIsoTimestamp,
  ) => Effect.Effect<SonarTruthStatusV1, TruthTrustError | TruthIntegrityError>;
  readonly status: (
    collectionId: string,
    environment: TruthEnvironmentId,
    targetState: SonarTruthTargetState,
    now: TruthIsoTimestamp,
  ) => Effect.Effect<
    SonarTruthStatusV1,
    TruthCompatibilityError | TruthTrustError | TruthIntegrityError
  >;
  readonly verify: (
    rootRef: string,
  ) => Effect.Effect<
    { readonly root_hash: Sha256Digest; readonly verified: true },
    TruthTrustError
  >;
  readonly explain: (
    artifactHash: string,
    now: TruthIsoTimestamp,
  ) => Effect.Effect<
    TruthArtifactExplanationV1,
    TruthCompatibilityError | TruthIntegrityError
  >;
  readonly dependencies: (
    artifactHash: string,
    now: TruthIsoTimestamp,
  ) => Effect.Effect<
    readonly TruthInspectionArtifactV1[],
    TruthCompatibilityError | TruthIntegrityError
  >;
  readonly rebuild: (
    environment: TruthEnvironmentId,
  ) => Effect.Effect<
    TruthRebuildResultV1,
    TruthCompatibilityError | TruthIntegrityError
  >;
}

export interface TruthInspectionTrustPinV1 {
  readonly keyId: string;
  readonly publicKeyHex: string;
  readonly envelopeHash: Sha256Digest;
  readonly trustRootGeneration: string;
  readonly revocationSequence: string;
}

export interface VerifiedTruthInspectionSourceV1 {
  readonly [verifiedInspectionSource]: true;
  readonly envelope: TruthInspectionEnvelopeV1;
  readonly snapshot: TruthInspectionSnapshotV1;
  readonly rebuiltArtifacts: readonly TruthInspectionArtifactV1[];
  readonly rebuiltProjectionDigest: Sha256Digest;
}

export const TruthInspector = Context.GenericTag<TruthInspectorService>(
  "sonar/truth-contract/TruthInspector",
);

const compatibilityFailure = (reason: string): TruthCompatibilityError =>
  new TruthCompatibilityError({
    boundary: "truth.inspection",
    reason,
  });

const integrityFailure = (reason: string): TruthIntegrityError =>
  new TruthIntegrityError({
    boundary: "truth.inspection",
    reason,
  });

const trustFailure = (reason: string): TruthTrustError =>
  new TruthTrustError({
    boundary: "truth.inspection",
    reason,
  });

const inspectionSigningBytes = (envelopeHash: string): Uint8Array =>
  encoder.encode(`${INSPECTION_SIGNING_DOMAIN}${envelopeHash}`);

const authorityRegistryFrom = (
  authorities: readonly TruthInspectionProjectionAuthorityV1[],
): ProjectionAuthorityRegistryV1 => {
  const registry: Record<
    string,
    {
      readonly public_key_hex: string;
      readonly authorities: readonly LifecycleAuthority[];
    }
  > = {};
  for (const authority of authorities) {
    if (registry[authority.key_id] !== undefined) {
      throw new Error("duplicate projection authority key");
    }
    if (new Set(authority.authorities).size !== authority.authorities.length) {
      throw new Error("duplicate projection authority grant");
    }
    registry[authority.key_id] = {
      public_key_hex: authority.public_key_hex,
      authorities: authority.authorities,
    };
  }
  return registry;
};

const rebuildInspectionArtifacts = (
  snapshot: TruthInspectionSnapshotV1,
  events: readonly TruthInspectionProjectionEventV1[],
  authorities: readonly TruthInspectionProjectionAuthorityV1[],
): readonly TruthInspectionArtifactV1[] => {
  if (snapshot.environment === "production") {
    throw new Error("staged projection events cannot rebuild production");
  }
  const projection = rebuildTruthStatusProjectionV1(
    snapshot.environment,
    events as readonly SignedProjectionEventV1[],
    authorityRegistryFrom(authorities),
  );
  const snapshotByHash = new Map(
    snapshot.artifacts.map((artifact) => [String(artifact.artifact_hash), artifact]),
  );
  const projectionHashes = Object.keys(projection.artifacts);
  if (
    projectionHashes.length !== snapshot.artifacts.length ||
    projectionHashes.some((hash) => !snapshotByHash.has(hash))
  ) {
    throw new Error("projection event closure does not match inspection artifacts");
  }
  return snapshot.artifacts.map((artifact) => {
    const rebuilt = projection.artifacts[artifact.artifact_hash];
    if (rebuilt === undefined) {
      throw new Error("projection event closure is incomplete");
    }
    return {
      ...artifact,
      effective_status: rebuilt.state_floor,
      reason_codes: [...rebuilt.reason_codes].sort() as unknown as TruthInspectionArtifactV1["reason_codes"],
      dependencies: [...rebuilt.depends_on] as unknown as TruthInspectionArtifactV1["dependencies"],
    } as TruthInspectionArtifactV1;
  });
};

export const compileTruthInspectionEnvelopeV1 = (
  snapshot: TruthInspectionSnapshotV1,
  projectionEvents: readonly TruthInspectionProjectionEventV1[],
  projectionAuthorities: readonly TruthInspectionProjectionAuthorityV1[],
  signer: TrustEnvelopeSigner,
): Effect.Effect<
  TruthInspectionEnvelopeV1,
  import("./errors.js").TruthDecodeError
> =>
  Effect.gen(function* () {
    const unsignedEnvelope = yield* decodeStrict(
      TruthInspectionEnvelopeUnsignedV1,
      "truth.inspection-envelope.unsigned",
      {
        schema_version: 1,
        domain: TRUTH_INSPECTION_ENVELOPE_DOMAIN,
        snapshot,
        projection_events: projectionEvents,
        projection_authorities: projectionAuthorities,
      },
    );
    const envelopeHash = sha256Hex(jcsCanonicalize(unsignedEnvelope));
    return yield* decodeStrict(
      TruthInspectionEnvelopeV1,
      "truth.inspection-envelope.signed",
      {
        unsigned_envelope: unsignedEnvelope,
        envelope_hash: envelopeHash,
        signature: signer.sign(inspectionSigningBytes(envelopeHash)),
      },
    );
  });

export const verifyTruthInspectionEnvelopeV1 = (
  input: unknown,
  pin: TruthInspectionTrustPinV1,
): Effect.Effect<
  VerifiedTruthInspectionSourceV1,
  import("./errors.js").TruthDecodeError | TruthIntegrityError | TruthTrustError
> =>
  Effect.gen(function* () {
    const envelope = yield* decodeStrict(
      TruthInspectionEnvelopeV1,
      "truth.inspection-envelope",
      input,
    );
    const { unsigned_envelope: unsigned, envelope_hash: envelopeHash } = envelope;
    if (
      pin.keyId !== unsigned.snapshot.publisher_key_id ||
      pin.keyId.length === 0 ||
      !/^[0-9a-f]{64}$/.test(pin.publicKeyHex) ||
      !/^[0-9a-f]{64}$/.test(pin.envelopeHash) ||
      !/^[1-9][0-9]*$/.test(pin.trustRootGeneration) ||
      !/^(0|[1-9][0-9]*)$/.test(pin.revocationSequence)
    ) {
      return yield* Effect.fail(
        trustFailure("inspection publisher does not match the explicit trust pin"),
      );
    }
    const expectedHash = sha256Hex(jcsCanonicalize(unsigned));
    if (
      expectedHash !== envelopeHash ||
      pin.envelopeHash !== envelopeHash ||
      !verifyEd25519Signature(
        pin.publicKeyHex,
        inspectionSigningBytes(envelopeHash),
        envelope.signature,
      )
    ) {
      return yield* Effect.fail(
        trustFailure("inspection envelope signature or digest is invalid"),
      );
    }
    const snapshot = unsigned.snapshot;
    if (
      snapshot.trust_root_generation !== pin.trustRootGeneration ||
      snapshot.revocation_sequence !== pin.revocationSequence
    ) {
      return yield* Effect.fail(
        trustFailure(
          "inspection trust-root generation or revocation sequence does not match the explicit pin",
        ),
      );
    }
    if (
      (snapshot.score_state as string) === "CONSUMED" ||
      (snapshot.authority_validity as string) !== "STAGED_VALID" ||
      unsigned.projection_events.some(
        (event) =>
          ["CONSUMED", "LIVE_PROVEN", "GRADUATED"].includes(
            event.body.lifecycle_state as string,
          ) ||
          ["SCORE", "SERVING"].includes(event.body.authority as string),
      )
    ) {
      return yield* Effect.fail(
        trustFailure(
          "staged inspection envelope contains a Score, serving, or production-authority claim",
        ),
      );
    }
    const artifactHashes = snapshot.artifacts.map((artifact) =>
      String(artifact.artifact_hash),
    );
    const artifactKinds = snapshot.artifacts.map((artifact) =>
      String(artifact.artifact_kind),
    );
    const edgeCount = snapshot.artifacts.reduce(
      (total, artifact) => total + artifact.dependencies.length,
      0,
    );
    if (
      new Set(artifactHashes).size !== artifactHashes.length ||
      new Set(artifactKinds).size !== artifactKinds.length ||
      snapshot.artifacts.length > 10_000 ||
      edgeCount > 50_000
    ) {
      return yield* Effect.fail(
        integrityFailure("inspection dependency graph violates frozen limits"),
      );
    }
    let rebuiltArtifacts: readonly TruthInspectionArtifactV1[];
    try {
      rebuiltArtifacts = rebuildInspectionArtifacts(
        snapshot,
        unsigned.projection_events,
        unsigned.projection_authorities,
      );
    } catch {
      return yield* Effect.fail(
        integrityFailure("signed inspection projection did not rebuild"),
      );
    }
    const rebuiltProjectionDigest = projectionDigestForInspectionV1(
      rebuiltArtifacts,
    ) as Sha256Digest;
    if (
      projectionDigestForInspectionV1(snapshot.artifacts) !==
        snapshot.served_projection_digest ||
      rebuiltProjectionDigest !== snapshot.served_projection_digest ||
      rebuiltProjectionDigest !== snapshot.rebuilt_projection_digest
    ) {
      return yield* Effect.fail(
        integrityFailure("served inspection projection differs from signed replay"),
      );
    }
    return {
      [verifiedInspectionSource]: true,
      envelope,
      snapshot,
      rebuiltArtifacts,
      rebuiltProjectionDigest,
    };
  });

const materializeAt = (
  source: VerifiedTruthInspectionSourceV1,
  now: TruthIsoTimestamp,
): TruthInspectionSnapshotV1 => {
  const nowTime = new Date(now).getTime();
  const scoreState =
    nowTime >= new Date(source.snapshot.score_deadline).getTime()
      ? "NOT_CONSUMED_OVERDUE"
      : "NOT_CONSUMED";
  return {
    ...source.snapshot,
    score_state: scoreState,
    artifacts: source.rebuiltArtifacts.map((artifact) => {
      const expired =
        artifact.expires_at !== null &&
        new Date(artifact.expires_at).getTime() <= nowTime;
      return expired
        ? {
            ...artifact,
            effective_status: "EXPIRED" as const,
            reason_codes: [
              ...new Set([...artifact.reason_codes, "ARTIFACT_EXPIRED"]),
            ].sort() as unknown as TruthInspectionArtifactV1["reason_codes"],
          }
        : artifact;
    }),
    rebuilt_projection_digest: source.rebuiltProjectionDigest,
  };
};

const transitiveDependencies = (
  snapshot: TruthInspectionSnapshotV1,
  artifactHash: string,
): Effect.Effect<readonly TruthInspectionArtifactV1[], TruthIntegrityError> =>
  Effect.gen(function* () {
    const byHash = new Map(
      snapshot.artifacts.map((artifact) => [String(artifact.artifact_hash), artifact]),
    );
    const visited = new Set<string>();
    const active = new Set<string>();
    const ordered: TruthInspectionArtifactV1[] = [];
    const visit = (hash: string, depth: number): void => {
      if (depth > 32) throw new Error("dependency depth exceeds frozen limit");
      if (active.has(hash)) throw new Error("dependency graph contains a cycle");
      if (visited.has(hash)) return;
      const artifact = byHash.get(hash);
      if (artifact === undefined) throw new Error("dependency graph references a missing artifact");
      active.add(hash);
      for (const dependency of artifact.dependencies) visit(dependency, depth + 1);
      active.delete(hash);
      visited.add(hash);
      ordered.push(artifact);
    };
    yield* Effect.try({
      try: () => visit(artifactHash, 0),
      catch: () => integrityFailure("dependency graph is cyclic, incomplete, or too deep"),
    });
    return ordered;
  });

const targetArtifactKind = (target: SonarTruthTargetState): string =>
  target === "produced"
    ? "producer_readiness"
    : target === "reconciled_staged"
      ? "reconciliation"
      : target === "consumed"
        ? "score_consumption"
        : target === "live_proven"
          ? "live_proof"
          : "graduation";

const evaluateTarget = (
  source: VerifiedTruthInspectionSourceV1,
  targetState: SonarTruthTargetState,
  now: TruthIsoTimestamp,
): Effect.Effect<SonarTruthStatusV1, TruthTrustError | TruthIntegrityError> =>
  Effect.gen(function* () {
    const snapshot = materializeAt(source, now);
    if (
      new Date(snapshot.observed_at).getTime() >
        new Date(snapshot.cached_at).getTime() ||
      new Date(snapshot.cached_at).getTime() > new Date(now).getTime() ||
      new Date(snapshot.cached_at).getTime() >=
        new Date(snapshot.expires_at).getTime()
    ) {
      return yield* Effect.fail(
        trustFailure("offline cache chronology is invalid"),
      );
    }
    if (new Date(snapshot.expires_at).getTime() <= new Date(now).getTime()) {
      return yield* Effect.fail(
        trustFailure("explicit offline staged snapshot is expired"),
      );
    }
    const target = snapshot.artifacts.find(
      (artifact) => artifact.artifact_kind === targetArtifactKind(targetState),
    );
    const endToEnd =
      targetState === "consumed" ||
      targetState === "live_proven" ||
      targetState === "graduated";
    if (target === undefined) {
      return {
        target_state: targetState,
        target_ready: false,
        lifecycle: targetState === "produced" ? "PRODUCED" : "RECONCILED",
        display_state:
          targetState === "produced"
            ? "PRODUCED_STAGED"
            : targetState === "reconciled_staged"
              ? "RECONCILED_STAGED"
              : snapshot.score_state,
        effective_status: "NOT_READY",
        reason_codes: [
          endToEnd ? snapshot.score_state : "TARGET_ARTIFACT_ABSENT",
        ],
        blocking_owner: endToEnd ? snapshot.score_owner : null,
        blocking_deadline: endToEnd ? snapshot.score_deadline : null,
        snapshot,
      };
    }
    const closure = yield* transitiveDependencies(snapshot, target.artifact_hash);
    const prerequisitesReady = closure.every(
      (artifact) => artifact.effective_status === "READY",
    );
    const authorityRefused = endToEnd;
    const endToEndBlocked = endToEnd;
    const targetReady =
      target.effective_status === "READY" &&
      prerequisitesReady &&
      !authorityRefused &&
      !endToEndBlocked;
    const closureExpired = closure.some(
      (artifact) => artifact.effective_status === "EXPIRED",
    );
    return {
      target_state: targetState,
      target_ready: targetReady,
      lifecycle:
        targetState === "produced"
          ? "PRODUCED"
          : "RECONCILED",
      display_state:
        targetState === "produced"
          ? "PRODUCED_STAGED"
          : endToEndBlocked
            ? snapshot.score_state
            : "RECONCILED_STAGED",
      effective_status: targetReady
        ? "READY"
        : authorityRefused
          ? "SUSPENDED"
          : closureExpired
            ? "EXPIRED"
            : "NOT_READY",
      reason_codes: [
        ...new Set([
          ...closure.flatMap((artifact) => artifact.reason_codes),
          ...(authorityRefused
            ? ["STAGED_INSPECTION_SCORE_AUTHORITY_REFUSED"]
            : []),
          ...(endToEndBlocked ? [snapshot.score_state] : []),
        ]),
      ].sort(),
      blocking_owner: endToEndBlocked ? snapshot.score_owner : null,
      blocking_deadline: endToEndBlocked ? snapshot.score_deadline : null,
      snapshot,
    };
  });

export const makeTruthInspector = (
  source: VerifiedTruthInspectionSourceV1,
): TruthInspectorService => ({
  evaluateTarget: Effect.fn("TruthInspector.evaluateTarget")(function* (
    targetState,
    now,
  ) {
    return yield* evaluateTarget(source, targetState, now);
  }),

  status: Effect.fn("TruthInspector.status")(function* (
    collectionId,
    environment,
    targetState,
    now,
  ) {
    if (
      collectionId !== source.snapshot.collection_id ||
      environment !== source.snapshot.environment
    ) {
      return yield* Effect.fail(
        compatibilityFailure("collection or environment is unsupported"),
      );
    }
    return yield* evaluateTarget(source, targetState, now);
  }),

  verify: Effect.fn("TruthInspector.verify")(function* (rootRef) {
    if (rootRef !== `sha256:${source.snapshot.producer_root_hash}`) {
      return yield* Effect.fail(
        trustFailure("root reference does not match the verified inspection root"),
      );
    }
    return {
      root_hash: source.snapshot.producer_root_hash,
      verified: true as const,
    };
  }),

  explain: Effect.fn("TruthInspector.explain")(function* (artifactHash, now) {
    const snapshot = materializeAt(source, now);
    const artifact = snapshot.artifacts.find(
      (candidate) => candidate.artifact_hash === artifactHash,
    );
    if (artifact === undefined) {
      return yield* Effect.fail(compatibilityFailure("artifact is not present"));
    }
    const closure = yield* transitiveDependencies(snapshot, artifactHash);
    return {
      artifact,
      transitive_dependency_count: Math.max(0, closure.length - 1),
    };
  }),

  dependencies: Effect.fn("TruthInspector.dependencies")(function* (
    artifactHash,
    now,
  ) {
    return yield* transitiveDependencies(materializeAt(source, now), artifactHash);
  }),

  rebuild: Effect.fn("TruthInspector.rebuild")(function* (environment) {
    if (environment !== source.snapshot.environment) {
      return yield* Effect.fail(
        compatibilityFailure("environment is unsupported"),
      );
    }
    return {
      environment,
      served_projection_digest: source.snapshot.served_projection_digest,
      rebuilt_projection_digest: source.rebuiltProjectionDigest,
      equal:
        source.snapshot.served_projection_digest ===
        source.rebuiltProjectionDigest,
    };
  }),
});

export const truthInspectorLayer = (source: VerifiedTruthInspectionSourceV1) =>
  Layer.succeed(TruthInspector, makeTruthInspector(source));

export const projectionDigestForInspectionV1 = (
  artifacts: readonly TruthInspectionArtifactV1[],
): string =>
  sha256Hex(
    jcsCanonicalize(
      [...artifacts].sort((left, right) =>
        String(left.artifact_hash).localeCompare(String(right.artifact_hash)),
      ),
    ),
  );
