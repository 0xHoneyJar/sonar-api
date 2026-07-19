import type { TrustEnvelopeSigner } from "../collection-resolver/trust-protocol.js";
import {
  jcsCanonicalize,
  sha256Hex,
  verifyEd25519Signature,
} from "../collection-resolver/trust-protocol.js";

const encoder = new TextEncoder();
const EVENT_DOMAIN = "sonar.truth-lifecycle-event.v1";
const RECOVERY_EVIDENCE_VERIFICATION_DOMAIN =
  "sonar.truth-recovery-evidence-verification.v1";

export const DEPENDENCY_QUERY_LIMITS_V1 = Object.freeze({
  nodes: 10_000,
  edges: 50_000,
  depth: 32,
  fanoutBatch: 1_000,
  wallMilliseconds: 2_000,
  estimatedBytes: 256 * 1024 * 1024,
  dependenciesPerArtifact: 128,
});

export const INVALIDATION_RETRY_POLICY_V1 = Object.freeze({
  attempts: 5,
  backoff_seconds: [1, 2, 4, 8, 16] as const,
  owner: "sonar-truth-operations",
  dead_letter_escalation_seconds: 60,
});

export type ProjectionStatus =
  | "READY"
  | "DEGRADED"
  | "NOT_READY"
  | "UNKNOWN"
  | "EXPIRED"
  | "SUSPENDED";

/**
 * Sprint 4's normative monotonic order. The readiness engine retains its own
 * decision order; this table governs ancestor inheritance and invalidation.
 */
export const INVALIDATION_STATUS_PRECEDENCE: readonly ProjectionStatus[] = [
  "READY",
  "DEGRADED",
  "NOT_READY",
  "UNKNOWN",
  "EXPIRED",
  "SUSPENDED",
];

export type TruthLifecycleState =
  | "DRAFT"
  | "PRODUCED"
  | "RECONCILED"
  | "CONSUMED"
  | "LIVE_PROVEN"
  | "GRADUATED"
  | "SUPERSEDED"
  | "ROLLED_BACK";

export type LifecycleAuthority =
  | "PRODUCER"
  | "RECONCILER"
  | "SCORE"
  | "SERVING"
  | "RECOVERY"
  | "GOVERNANCE"
  | "REVOCATION";

export type ProjectionEventKind =
  | "ARTIFACT_ACTIVATED"
  | "LIFECYCLE_TRANSITION"
  | "RECOVERY"
  | "INVALIDATION"
  | "REVOCATION"
  | "DELIVERY_DEAD_LETTER";

export type RecoveryEvidenceKindV1 =
  | "FRESH_READINESS_EVIDENCE"
  | "REPLACEMENT_WATERMARK_AND_RECEIPTS"
  | "COMPLETED_CENSUS_PASS"
  | "CORRECTED_BUNDLE_AND_SCORE_RECEIPT"
  | "IDENTITY_READMISSION_EVIDENCE"
  | "RECOVERED_TRUST_ROOT"
  | "COMPATIBLE_CONSUMER_RECEIPT";

export interface RecoveryEvidenceItemV1 {
  readonly kind: RecoveryEvidenceKindV1;
  readonly artifact_hashes: readonly string[];
  readonly census_complete: boolean | null;
  readonly reconciliation_decision: "RECONCILED_STAGED" | null;
}

export interface RecoveryEvidenceV1 {
  readonly items: readonly RecoveryEvidenceItemV1[];
}

export interface RecoveryEvidenceVerificationBodyV1 {
  readonly schema_version: 1;
  readonly environment: "development" | "staging";
  readonly artifact_hash: string;
  readonly generation: string;
  readonly invalidation_epoch: string;
  readonly resolves_cause_event_ids: readonly string[];
  readonly evidence_hash: string;
  readonly evidence: RecoveryEvidenceV1;
  readonly verified_artifact_hashes: readonly string[];
  readonly verifier_service_id: string;
  readonly verified_at: string;
  readonly production_authority: false;
}

export interface SignedRecoveryEvidenceVerificationV1 {
  readonly _tag: "RecoveryEvidenceVerificationV1";
  readonly body: RecoveryEvidenceVerificationBodyV1;
  readonly signer_key_id: string;
  readonly signature: string;
}

export type VerifiedRecoveryEvidenceRegistryV1 = Readonly<
  Record<string, SignedRecoveryEvidenceVerificationV1>
>;

export const INVALIDATION_REASON_POLICY_V1 = Object.freeze({
  SOURCE_TRANSPORT_LOSS: {
    minimum_status: "DEGRADED",
    recovery_evidence_kind: "FRESH_READINESS_EVIDENCE",
    recovery_authorities: ["PRODUCER", "GOVERNANCE"],
  },
  STALE_EVIDENCE_EXPIRED: {
    minimum_status: "EXPIRED",
    recovery_evidence_kind: "FRESH_READINESS_EVIDENCE",
    recovery_authorities: ["PRODUCER", "GOVERNANCE"],
  },
  REORG_BEHIND_WATERMARK: {
    minimum_status: "NOT_READY",
    recovery_evidence_kind: "REPLACEMENT_WATERMARK_AND_RECEIPTS",
    recovery_authorities: ["PRODUCER", "GOVERNANCE"],
  },
  RECONCILIATION_COUNT_BREACH: {
    minimum_status: "NOT_READY",
    recovery_evidence_kind: "COMPLETED_CENSUS_PASS",
    recovery_authorities: ["RECONCILER", "GOVERNANCE"],
  },
  SEMANTIC_PROVENANCE_MISMATCH: {
    minimum_status: "SUSPENDED",
    recovery_evidence_kind: "CORRECTED_BUNDLE_AND_SCORE_RECEIPT",
    recovery_authorities: ["GOVERNANCE"],
  },
  IDENTITY_REVOKED_OR_CONTESTED: {
    minimum_status: "SUSPENDED",
    recovery_evidence_kind: "IDENTITY_READMISSION_EVIDENCE",
    recovery_authorities: ["REVOCATION", "GOVERNANCE"],
  },
  SIGNER_ROOT_COMPROMISE_REVOCATION: {
    minimum_status: "SUSPENDED",
    recovery_evidence_kind: "RECOVERED_TRUST_ROOT",
    recovery_authorities: ["REVOCATION", "GOVERNANCE"],
  },
  INCOMPATIBLE_PRODUCER_CONSUMER: {
    minimum_status: "SUSPENDED",
    recovery_evidence_kind: "COMPATIBLE_CONSUMER_RECEIPT",
    recovery_authorities: ["GOVERNANCE"],
  },
} as const satisfies Readonly<
  Record<
    string,
    {
      readonly minimum_status: ProjectionStatus;
      readonly recovery_evidence_kind: RecoveryEvidenceKindV1;
      readonly recovery_authorities: readonly LifecycleAuthority[];
    }
  >
>);

export interface ProjectionEventBodyV1 {
  readonly schema_version: 1;
  readonly event_id: string;
  readonly sequence: string;
  readonly previous_event_hash: string | null;
  readonly kind: ProjectionEventKind;
  readonly environment: "development" | "staging";
  readonly artifact_hash: string;
  readonly generation: string;
  readonly invalidation_epoch: string;
  readonly authority: LifecycleAuthority;
  readonly lifecycle_state: TruthLifecycleState;
  readonly local_status: ProjectionStatus;
  readonly state_floor: ProjectionStatus;
  readonly reason_code: string;
  readonly cause_event_id: string | null;
  readonly resolves_cause_event_ids: readonly string[];
  readonly replacement_evidence_hash: string | null;
  readonly replacement_evidence_kinds: readonly RecoveryEvidenceKindV1[] | null;
  readonly replacement_evidence: RecoveryEvidenceV1 | null;
  readonly depends_on: readonly string[];
  readonly occurred_at: string;
  readonly production_authority: false;
}

export interface SignedProjectionEventV1 {
  readonly _tag: "TruthProjectionEventV1";
  readonly body: ProjectionEventBodyV1;
  readonly signer_key_id: string;
  readonly signature: string;
}

export interface ArtifactProjectionV1 {
  readonly artifact_hash: string;
  readonly generation: string;
  readonly invalidation_epoch: string;
  readonly lifecycle_state: TruthLifecycleState;
  readonly local_status: ProjectionStatus;
  readonly state_floor: ProjectionStatus;
  readonly reason_codes: readonly string[];
  readonly active_causes: readonly {
    readonly event_id: string;
    readonly state_floor: ProjectionStatus;
    readonly reason_code: string;
    readonly authority: LifecycleAuthority;
    readonly signer_key_id: string;
  }[];
  readonly depends_on: readonly string[];
  readonly last_sequence: string;
}

export interface TruthStatusProjectionV1 {
  readonly environment: "development" | "staging";
  readonly last_sequence: string;
  readonly tail_event_hash: string | null;
  readonly invalidation_epoch: string;
  readonly artifacts: Readonly<Record<string, ArtifactProjectionV1>>;
  readonly applied_event_ids: readonly string[];
  readonly projection_digest: string;
  readonly production_authority: false;
}

export interface ProjectionAuthorityGrantV1 {
  readonly public_key_hex: string;
  readonly authorities: readonly LifecycleAuthority[];
}

export type ProjectionAuthorityRegistryV1 = Readonly<
  Record<string, ProjectionAuthorityGrantV1>
>;

export interface EffectiveStatusQueryResultV1 {
  readonly artifact_hash: string;
  readonly generation: string;
  readonly invalidation_epoch: string;
  readonly lifecycle_state: TruthLifecycleState;
  readonly effective_status: ProjectionStatus;
  readonly reason_codes: readonly string[];
  readonly ancestor_closure_digest: string;
  readonly visited_nodes: number;
}

export interface FanoutDeliveryV1 {
  readonly event_id: string;
  readonly artifact_hash: string;
  readonly batch: number;
  readonly state_floor: ProjectionStatus;
  readonly status: "DELIVERED" | "DEAD_LETTER";
  readonly attempts: number;
  readonly retry_owner: string;
}

export interface FanoutResultV1 {
  readonly origin: string;
  readonly invalidation_epoch: string;
  readonly deliveries: readonly FanoutDeliveryV1[];
  readonly batches: number;
  readonly converged: boolean;
}

const HEX_64 = /^[0-9a-f]{64}$/;
const UINT = /^(0|[1-9][0-9]*)$/;

const assert: (condition: unknown, reason: string) => asserts condition = (
  condition,
  reason,
) => {
  if (!condition) throw new Error(reason);
};

const parseUint = (value: string, field: string): bigint => {
  assert(UINT.test(value), `${field} is not a canonical unsigned integer`);
  return BigInt(value);
};

const statusRank = (status: ProjectionStatus): number =>
  INVALIDATION_STATUS_PRECEDENCE.indexOf(status);

const assertExactKeys = (
  value: object,
  expected: readonly string[],
  boundary: string,
): void => {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  assert(
    actual.length === wanted.length &&
      actual.every((key, index) => key === wanted[index]),
    `${boundary} contains missing or unknown fields`,
  );
};

const validateRecoveryEvidenceVerificationBodyV1 = (
  body: RecoveryEvidenceVerificationBodyV1,
): void => {
  assertExactKeys(
    body,
    [
      "schema_version",
      "environment",
      "artifact_hash",
      "generation",
      "invalidation_epoch",
      "resolves_cause_event_ids",
      "evidence_hash",
      "evidence",
      "verified_artifact_hashes",
      "verifier_service_id",
      "verified_at",
      "production_authority",
    ],
    "recovery evidence verification body",
  );
  assert(body.schema_version === 1, "unsupported recovery verification schema");
  assert(
    body.environment === "development" || body.environment === "staging",
    "production recovery verification is outside staged authority",
  );
  assert(body.production_authority === false, "recovery verification claimed authority");
  assert(HEX_64.test(body.artifact_hash), "invalid recovery target hash");
  assert(HEX_64.test(body.evidence_hash), "invalid recovery evidence hash");
  parseUint(body.generation, "recovery verification generation");
  parseUint(body.invalidation_epoch, "recovery verification epoch");
  assert(
    body.resolves_cause_event_ids.length > 0 &&
      new Set(body.resolves_cause_event_ids).size ===
        body.resolves_cause_event_ids.length,
    "recovery verification cause set is absent or duplicated",
  );
  assert(body.verifier_service_id.length > 0, "recovery verifier service is absent");
  assert(Number.isFinite(Date.parse(body.verified_at)), "invalid recovery verification time");
  assert(
    sha256Hex(jcsCanonicalize(body.evidence)) === body.evidence_hash,
    "recovery verification evidence hash mismatch",
  );
  const evidenceArtifactHashes = [
    ...new Set(body.evidence.items.flatMap((item) => item.artifact_hashes)),
  ].sort();
  assert(
    body.verified_artifact_hashes.every((hash) => HEX_64.test(hash)) &&
      new Set(body.verified_artifact_hashes).size ===
        body.verified_artifact_hashes.length &&
      [...body.verified_artifact_hashes].sort().join("\0") ===
        evidenceArtifactHashes.join("\0"),
    "recovery verifier did not attest the exact artifact set",
  );
};

const recoveryVerificationSigningBytes = (
  body: RecoveryEvidenceVerificationBodyV1,
): Uint8Array =>
  encoder.encode(
    `${RECOVERY_EVIDENCE_VERIFICATION_DOMAIN}\0${body.environment}\0${body.artifact_hash}\0${body.invalidation_epoch}\0${body.evidence_hash}\0${sha256Hex(jcsCanonicalize(body))}`,
  );

export const compileRecoveryEvidenceVerificationV1 = (
  input: Omit<
    RecoveryEvidenceVerificationBodyV1,
    "schema_version" | "production_authority"
  >,
  signer: TrustEnvelopeSigner,
): SignedRecoveryEvidenceVerificationV1 => {
  const body: RecoveryEvidenceVerificationBodyV1 = {
    schema_version: 1,
    ...input,
    production_authority: false,
  };
  validateRecoveryEvidenceVerificationBodyV1(body);
  return {
    _tag: "RecoveryEvidenceVerificationV1",
    body,
    signer_key_id: signer.keyId,
    signature: signer.sign(recoveryVerificationSigningBytes(body)),
  };
};

export const verifyRecoveryEvidenceVerificationV1 = (
  verification: SignedRecoveryEvidenceVerificationV1,
  publicKeyHex: string,
): boolean => {
  try {
    assertExactKeys(
      verification,
      ["_tag", "body", "signer_key_id", "signature"],
      "recovery evidence verification",
    );
    assert(
      verification._tag === "RecoveryEvidenceVerificationV1",
      "wrong recovery verification tag",
    );
    validateRecoveryEvidenceVerificationBodyV1(verification.body);
    return verifyEd25519Signature(
      publicKeyHex,
      recoveryVerificationSigningBytes(verification.body),
      verification.signature,
    );
  } catch {
    return false;
  }
};

export const worseProjectionStatus = (
  left: ProjectionStatus,
  right: ProjectionStatus,
): ProjectionStatus => (statusRank(left) >= statusRank(right) ? left : right);

export type ProjectionStateEventReasonV1 =
  | "NO_EVENT"
  | keyof typeof INVALIDATION_REASON_POLICY_V1;

export interface ProjectionStateEventRowV1 {
  readonly local_status: ProjectionStatus;
  readonly ancestor_status: ProjectionStatus;
  readonly event_reason: ProjectionStateEventReasonV1;
  readonly event_floor: ProjectionStatus;
  readonly effective_status: ProjectionStatus;
}

const projectionEventFloors = [
  { reason: "NO_EVENT" as const, floor: "READY" as const },
  ...Object.entries(INVALIDATION_REASON_POLICY_V1).map(([reason, policy]) => ({
    reason: reason as keyof typeof INVALIDATION_REASON_POLICY_V1,
    floor: policy.minimum_status,
  })),
] as const;

/** Exhaustive local × ancestor × event policy table (6 × 6 × 9 = 324). */
export const PROJECTION_STATE_EVENT_TABLE_V1: readonly ProjectionStateEventRowV1[] =
  Object.freeze(
    INVALIDATION_STATUS_PRECEDENCE.flatMap((local_status) =>
      INVALIDATION_STATUS_PRECEDENCE.flatMap((ancestor_status) =>
        projectionEventFloors.map(({ reason, floor }) => ({
          local_status,
          ancestor_status,
          event_reason: reason,
          event_floor: floor,
          effective_status: worseProjectionStatus(
            worseProjectionStatus(local_status, ancestor_status),
            floor,
          ),
        })),
      ),
    ),
  );

const allowedLifecycleAuthorities: Readonly<
  Record<TruthLifecycleState, LifecycleAuthority>
> = {
  DRAFT: "PRODUCER",
  PRODUCED: "PRODUCER",
  RECONCILED: "RECONCILER",
  CONSUMED: "SCORE",
  LIVE_PROVEN: "SERVING",
  GRADUATED: "GOVERNANCE",
  SUPERSEDED: "GOVERNANCE",
  ROLLED_BACK: "GOVERNANCE",
};

const lifecycleRank: Readonly<Record<TruthLifecycleState, number>> = {
  DRAFT: 0,
  PRODUCED: 1,
  RECONCILED: 2,
  CONSUMED: 3,
  LIVE_PROVEN: 4,
  GRADUATED: 5,
  SUPERSEDED: 6,
  ROLLED_BACK: 6,
};

const eventSigningBytes = (body: ProjectionEventBodyV1): Uint8Array =>
  encoder.encode(
    `${EVENT_DOMAIN}\0${body.environment}\0${body.sequence}\0${sha256Hex(jcsCanonicalize(body))}`,
  );

const validateEventBody = (body: ProjectionEventBodyV1): void => {
  assertExactKeys(
    body,
    [
      "schema_version",
      "event_id",
      "sequence",
      "previous_event_hash",
      "kind",
      "environment",
      "artifact_hash",
      "generation",
      "invalidation_epoch",
      "authority",
      "lifecycle_state",
      "local_status",
      "state_floor",
      "reason_code",
      "cause_event_id",
      "resolves_cause_event_ids",
      "replacement_evidence_hash",
      "replacement_evidence_kinds",
      "replacement_evidence",
      "depends_on",
      "occurred_at",
      "production_authority",
    ],
    "projection event body",
  );
  assert(body.schema_version === 1, "unsupported projection event schema");
  assert(
    body.environment === "development" || body.environment === "staging",
    "production projection events are outside staged authority",
  );
  assert(body.production_authority === false, "projection event claimed production authority");
  assert(
    ["DRAFT", "PRODUCED", "RECONCILED"].includes(body.lifecycle_state),
    "Sprint 4 projection cannot assert post-reconciliation authority",
  );
  assert(HEX_64.test(body.artifact_hash), "invalid event artifact hash");
  assert(
    body.previous_event_hash === null || HEX_64.test(body.previous_event_hash),
    "invalid previous event hash",
  );
  for (const dependency of body.depends_on) {
    assert(HEX_64.test(dependency), "invalid dependency hash");
  }
  assert(
    body.depends_on.length <= DEPENDENCY_QUERY_LIMITS_V1.dependenciesPerArtifact,
    "artifact dependency limit exceeded",
  );
  assert(new Set(body.depends_on).size === body.depends_on.length, "duplicate dependency");
  assert(
    new Set(body.resolves_cause_event_ids).size === body.resolves_cause_event_ids.length,
    "duplicate resolved cause",
  );
  assert(
    body.replacement_evidence_hash === null ||
      HEX_64.test(body.replacement_evidence_hash),
    "invalid replacement evidence hash",
  );
  if (body.replacement_evidence !== null) {
    assertExactKeys(
      body.replacement_evidence,
      ["items"],
      "recovery evidence",
    );
    assert(
      body.replacement_evidence.items.length > 0,
      "recovery evidence items are absent",
    );
    for (const item of body.replacement_evidence.items) {
      assertExactKeys(
        item,
        [
          "kind",
          "artifact_hashes",
          "census_complete",
          "reconciliation_decision",
        ],
        "recovery evidence item",
      );
      assert(
        item.artifact_hashes.length > 0 &&
          item.artifact_hashes.every((hash) => HEX_64.test(hash)),
        "recovery evidence artifacts are absent or invalid",
      );
      assert(
        new Set(item.artifact_hashes).size === item.artifact_hashes.length,
        "recovery evidence contains duplicate artifacts",
      );
      if (item.kind === "COMPLETED_CENSUS_PASS") {
        assert(
          item.census_complete === true &&
            item.reconciliation_decision === "RECONCILED_STAGED",
          "census recovery does not prove a completed pass",
        );
      } else {
        assert(
          item.census_complete === null &&
            item.reconciliation_decision === null,
          "non-census recovery carries census assertions",
        );
      }
      if (item.kind === "REPLACEMENT_WATERMARK_AND_RECEIPTS") {
        assert(
          item.artifact_hashes.length >= 2,
          "reorg recovery requires watermark and dependent receipt evidence",
        );
      }
    }
  }
  assert(!body.depends_on.includes(body.artifact_hash), "self dependency");
  parseUint(body.sequence, "sequence");
  parseUint(body.generation, "generation");
  parseUint(body.invalidation_epoch, "invalidation_epoch");
  assert(Number.isFinite(Date.parse(body.occurred_at)), "invalid event timestamp");
  if (
    body.kind === "LIFECYCLE_TRANSITION" ||
    body.kind === "ARTIFACT_ACTIVATED"
  ) {
    assert(
      allowedLifecycleAuthorities[body.lifecycle_state] === body.authority,
      `authority ${body.authority} cannot create ${body.lifecycle_state}`,
    );
  }
  if (body.kind === "REVOCATION") {
    assert(body.authority === "REVOCATION", "revocation requires revocation authority");
    assert(body.state_floor === "SUSPENDED", "revocation must suspend");
  }
  // TC-001 (PR #221): only RECOVERY may carry cause-resolution or replacement
  // evidence. Without this fail-closed guard a LIFECYCLE_TRANSITION (or any
  // future kind) could smuggle resolves_cause_event_ids + evidence and reach
  // applyEvent's resolution path, clearing active causes while advancing
  // lifecycle — bypassing the RECOVERY-kind invariants below.
  if (body.kind !== "RECOVERY") {
    assert(
      body.resolves_cause_event_ids.length === 0,
      "only recovery may resolve causes",
    );
    assert(
      body.replacement_evidence_hash === null,
      "only recovery may carry replacement evidence",
    );
    assert(
      body.replacement_evidence_kinds === null,
      "only recovery may carry replacement evidence kinds",
    );
    assert(
      body.replacement_evidence === null,
      "only recovery may carry replacement evidence object",
    );
  }
  if (
    body.kind === "INVALIDATION" ||
    body.kind === "REVOCATION" ||
    body.kind === "DELIVERY_DEAD_LETTER"
  ) {
    assert(body.cause_event_id === body.event_id, "invalidation cause must bind event id");
    assert(body.resolves_cause_event_ids.length === 0, "invalidation cannot resolve causes");
    assert(body.replacement_evidence_hash === null, "invalidation cannot carry recovery evidence");
    assert(body.replacement_evidence_kinds === null, "invalidation cannot carry recovery type");
    assert(body.replacement_evidence === null, "invalidation cannot carry recovery object");
    const normalizedReason = body.reason_code.replace(/^DEAD_LETTER:/, "");
    const policy =
      INVALIDATION_REASON_POLICY_V1[
        normalizedReason as keyof typeof INVALIDATION_REASON_POLICY_V1
      ];
    assert(policy !== undefined, `unknown invalidation reason ${body.reason_code}`);
    assert(
      statusRank(body.state_floor) >= statusRank(policy.minimum_status),
      `reason ${body.reason_code} weakens required severity`,
    );
  } else if (body.kind === "ARTIFACT_ACTIVATED") {
    assert(body.cause_event_id === null, "activation cannot create cause");
    assert(body.resolves_cause_event_ids.length === 0, "activation cannot resolve cause");
  } else if (body.kind === "RECOVERY") {
    assert(body.cause_event_id === null, "recovery cannot create cause");
    assert(body.resolves_cause_event_ids.length > 0, "recovery must resolve causes");
    assert(body.replacement_evidence_hash !== null, "recovery evidence is required");
    assert(body.replacement_evidence_kinds !== null, "recovery evidence types are required");
    assert(body.replacement_evidence !== null, "recovery evidence object is required");
    assert(
      [...new Set(body.replacement_evidence_kinds)].sort().join("\0") ===
        body.replacement_evidence.items.map((item) => item.kind).sort().join("\0"),
      "recovery evidence kinds mismatch",
    );
    assert(
      sha256Hex(jcsCanonicalize(body.replacement_evidence)) ===
        body.replacement_evidence_hash,
      "recovery evidence hash mismatch",
    );
  }
};

export const compileProjectionEventV1 = (
  body: ProjectionEventBodyV1,
  signer: TrustEnvelopeSigner,
): SignedProjectionEventV1 => {
  validateEventBody(body);
  return {
    _tag: "TruthProjectionEventV1",
    body,
    signer_key_id: signer.keyId,
    signature: signer.sign(eventSigningBytes(body)),
  };
};

export const verifyProjectionEventV1 = (
  event: SignedProjectionEventV1,
  publicKeyHex: string,
): boolean => {
  try {
    assert(event._tag === "TruthProjectionEventV1", "wrong projection event tag");
    validateEventBody(event.body);
    return verifyEd25519Signature(
      publicKeyHex,
      eventSigningBytes(event.body),
      event.signature,
    );
  } catch {
    return false;
  }
};

const emptyProjection = (
  environment: TruthStatusProjectionV1["environment"],
): Omit<TruthStatusProjectionV1, "projection_digest"> => ({
  environment,
  last_sequence: "0",
  tail_event_hash: null,
  invalidation_epoch: "0",
  artifacts: {},
  applied_event_ids: [],
  production_authority: false,
});

const digestProjection = (
  projection: Omit<TruthStatusProjectionV1, "projection_digest">,
): TruthStatusProjectionV1 => ({
  ...projection,
  projection_digest: sha256Hex(jcsCanonicalize(projection)),
});

const validateGraph = (artifacts: Readonly<Record<string, ArtifactProjectionV1>>): void => {
  const nodes = Object.keys(artifacts);
  assert(nodes.length <= DEPENDENCY_QUERY_LIMITS_V1.nodes, "graph node limit exceeded");
  const edgeCount = nodes.reduce(
    (total, hash) => total + artifacts[hash]!.depends_on.length,
    0,
  );
  assert(edgeCount <= DEPENDENCY_QUERY_LIMITS_V1.edges, "graph edge limit exceeded");
  const estimatedBytes = encoder.encode(jcsCanonicalize(artifacts)).byteLength;
  assert(
    estimatedBytes <= DEPENDENCY_QUERY_LIMITS_V1.estimatedBytes,
    "graph estimated-memory limit exceeded",
  );
  const visiting = new Set<string>();
  const depthMemo = new Map<string, number>();
  const visit = (hash: string): number => {
    const memoized = depthMemo.get(hash);
    if (memoized !== undefined) return memoized;
    assert(!visiting.has(hash), "dependency graph is cyclic");
    const node = artifacts[hash];
    assert(node !== undefined, `missing dependency node ${hash}`);
    visiting.add(hash);
    const depth =
      node.depends_on.length === 0
        ? 0
        : 1 + Math.max(...node.depends_on.map((dependency) => visit(dependency)));
    assert(depth <= DEPENDENCY_QUERY_LIMITS_V1.depth, "graph depth limit exceeded");
    visiting.delete(hash);
    depthMemo.set(hash, depth);
    return depth;
  };
  for (const hash of nodes) visit(hash);
};

export const validateDependencyGraphV1 = (
  artifacts: Readonly<Record<string, ArtifactProjectionV1>>,
): void => validateGraph(artifacts);

const applyEvent = (
  projection: Omit<TruthStatusProjectionV1, "projection_digest">,
  event: SignedProjectionEventV1,
  authorityRegistry: ProjectionAuthorityRegistryV1,
  recoveryEvidenceRegistry: VerifiedRecoveryEvidenceRegistryV1,
): Omit<TruthStatusProjectionV1, "projection_digest"> => {
  const body = event.body;
  assert(body.environment === projection.environment, "cross-environment event");
  assert(
    parseUint(body.sequence, "sequence") === parseUint(projection.last_sequence, "last") + 1n,
    "projection event sequence is not contiguous",
  );
  assert(
    body.previous_event_hash === projection.tail_event_hash,
    "projection event hash chain is broken",
  );
  assert(!projection.applied_event_ids.includes(body.event_id), "duplicate event id");
  const current = projection.artifacts[body.artifact_hash];
  if (body.kind === "ARTIFACT_ACTIVATED") {
    assert(current === undefined, "artifact activation is immutable");
    for (const dependency of body.depends_on) {
      assert(projection.artifacts[dependency] !== undefined, "activation dependency missing");
    }
  } else {
    assert(current !== undefined, "event targets unknown artifact");
    assert(
      parseUint(body.generation, "generation") >= parseUint(current.generation, "current generation"),
      "generation rollback",
    );
    assert(
      parseUint(body.invalidation_epoch, "invalidation epoch") >=
        parseUint(current.invalidation_epoch, "current invalidation epoch"),
      "invalidation epoch rollback",
    );
    if (body.kind === "LIFECYCLE_TRANSITION") {
      assert(
        lifecycleRank[body.lifecycle_state] === lifecycleRank[current.lifecycle_state] + 1 ||
          body.lifecycle_state === "SUPERSEDED" ||
          (body.lifecycle_state === "ROLLED_BACK" &&
            ["CONSUMED", "LIVE_PROVEN", "GRADUATED"].includes(current.lifecycle_state)),
        "invalid lifecycle transition",
      );
    } else if (body.kind === "RECOVERY") {
      assert(body.lifecycle_state === current.lifecycle_state, "recovery changed lifecycle");
    }
  }
  const previousFloor = current?.state_floor ?? "READY";
  const previousLocal = current?.local_status ?? "READY";
  const priorCauses = current?.active_causes ?? [];
  const sameEpoch =
    current !== undefined &&
    body.invalidation_epoch === current.invalidation_epoch;
  const isInvalidation =
    body.kind === "INVALIDATION" ||
    body.kind === "REVOCATION" ||
    body.kind === "DELIVERY_DEAD_LETTER";
  let activeCauses = priorCauses;
  if (isInvalidation) {
    assert(
      !priorCauses.some((cause) => cause.event_id === body.event_id),
      "conflicting invalidation cause event",
    );
    activeCauses = [
      ...priorCauses,
      {
        event_id: body.event_id,
        state_floor: body.state_floor,
        reason_code: body.reason_code,
        authority: body.authority,
        signer_key_id: event.signer_key_id,
      },
    ].sort((left, right) => left.event_id.localeCompare(right.event_id));
  } else if (body.kind === "RECOVERY") {
    assert(!sameEpoch, "same-epoch recovery is forbidden");
    assert(body.replacement_evidence_hash !== null, "recovery evidence is required");
    const activeIds = priorCauses.map((cause) => cause.event_id).sort();
    const resolvedIds = [...body.resolves_cause_event_ids].sort();
    assert(
      activeIds.join("\0") === resolvedIds.join("\0"),
      "recovery must resolve the complete active-cause set",
    );
    const causePolicies = priorCauses.map((cause) => {
        const normalizedReason = cause.reason_code.replace(/^DEAD_LETTER:/, "");
        const policy =
          INVALIDATION_REASON_POLICY_V1[
            normalizedReason as keyof typeof INVALIDATION_REASON_POLICY_V1
          ];
        assert(policy !== undefined, "active cause has unknown invalidation reason");
        return policy;
      });
    const requiredEvidenceKinds = new Set(
      causePolicies.map((policy) => policy.recovery_evidence_kind),
    );
    assert(
      [...requiredEvidenceKinds].sort().join("\0") ===
        [...(body.replacement_evidence_kinds ?? [])].sort().join("\0"),
      "recovery evidence types do not satisfy active causes",
    );
    const allowedRecoveryAuthorities = causePolicies
      .map(
        (policy) =>
          [...policy.recovery_authorities] as LifecycleAuthority[],
      )
      .reduce<LifecycleAuthority[]>(
        (intersection, authorities) =>
          intersection.filter((authority) => authorities.includes(authority)),
        [...causePolicies[0]!.recovery_authorities],
      );
    assert(
      allowedRecoveryAuthorities.includes(body.authority),
      "recovery authority does not satisfy every active cause",
    );
    const evidenceHash = body.replacement_evidence_hash;
    assert(evidenceHash !== null, "recovery evidence is required");
    const verifiedEvidence = recoveryEvidenceRegistry[evidenceHash];
    assert(
      verifiedEvidence !== undefined,
      "recovery evidence is absent from the verified registry",
    );
    const verifierGrant = authorityRegistry[verifiedEvidence.signer_key_id];
    assert(
      verifierGrant !== undefined &&
        verifierGrant.authorities.includes("RECOVERY") &&
        verifyRecoveryEvidenceVerificationV1(
          verifiedEvidence,
          verifierGrant.public_key_hex,
        ),
      "recovery evidence verification receipt is untrusted",
    );
    assert(
      verifiedEvidence.body.environment === body.environment &&
        verifiedEvidence.body.artifact_hash === body.artifact_hash &&
        verifiedEvidence.body.generation === body.generation &&
        verifiedEvidence.body.invalidation_epoch === body.invalidation_epoch &&
        [...verifiedEvidence.body.resolves_cause_event_ids].sort().join("\0") ===
          [...body.resolves_cause_event_ids].sort().join("\0") &&
        verifiedEvidence.body.evidence_hash === evidenceHash &&
        jcsCanonicalize(verifiedEvidence.body.evidence) ===
          jcsCanonicalize(body.replacement_evidence),
      "verified recovery evidence does not match the event",
    );
    const verifiedArtifactHashes = new Set(
      verifiedEvidence.body.verified_artifact_hashes,
    );
    for (const item of body.replacement_evidence?.items ?? []) {
      assert(
        item.artifact_hashes.every((hash) => verifiedArtifactHashes.has(hash)),
        "recovery references an unverified artifact",
      );
    }
    assert(
      Date.parse(verifiedEvidence.body.verified_at) <=
        Date.parse(body.occurred_at),
      "recovery evidence was verified after the recovery event",
    );
    activeCauses = [];
  }
  const activeCauseFloor = activeCauses.reduce<ProjectionStatus>(
    (floor, cause) => worseProjectionStatus(floor, cause.state_floor),
    "READY",
  );
  const next: ArtifactProjectionV1 = {
    artifact_hash: body.artifact_hash,
    generation: body.generation,
    invalidation_epoch:
      parseUint(body.invalidation_epoch, "epoch") >=
      parseUint(current?.invalidation_epoch ?? "0", "current epoch")
        ? body.invalidation_epoch
        : current!.invalidation_epoch,
    lifecycle_state:
      body.kind === "LIFECYCLE_TRANSITION" || body.kind === "ARTIFACT_ACTIVATED"
        ? body.lifecycle_state
        : current!.lifecycle_state,
    local_status:
      body.kind === "ARTIFACT_ACTIVATED"
        ? body.local_status
        : sameEpoch
          ? worseProjectionStatus(previousLocal, body.local_status)
          : body.kind === "LIFECYCLE_TRANSITION" || body.kind === "RECOVERY"
            ? body.local_status
            : worseProjectionStatus(previousLocal, body.local_status),
    state_floor:
      body.kind === "ARTIFACT_ACTIVATED"
        ? body.state_floor
        : sameEpoch
          ? worseProjectionStatus(previousFloor, body.state_floor)
          : body.kind === "LIFECYCLE_TRANSITION" || body.kind === "RECOVERY"
            ? body.state_floor
            : worseProjectionStatus(previousFloor, body.state_floor),
    reason_codes: [
      ...new Set([...(current?.reason_codes ?? []), body.reason_code]),
    ].sort(),
    active_causes: activeCauses,
    depends_on: current?.depends_on ?? [...body.depends_on],
    last_sequence: body.sequence,
  };
  const guardedNext: ArtifactProjectionV1 = {
    ...next,
    state_floor: worseProjectionStatus(next.state_floor, activeCauseFloor),
  };
  const artifacts = { ...projection.artifacts, [body.artifact_hash]: guardedNext };
  validateGraph(artifacts);
  return {
    ...projection,
    last_sequence: body.sequence,
    tail_event_hash: sha256Hex(jcsCanonicalize(event)),
    invalidation_epoch:
      parseUint(body.invalidation_epoch, "epoch") >
      parseUint(projection.invalidation_epoch, "projection epoch")
        ? body.invalidation_epoch
        : projection.invalidation_epoch,
    artifacts,
    applied_event_ids: [...projection.applied_event_ids, body.event_id],
  };
};

export const rebuildTruthStatusProjectionV1 = (
  environment: TruthStatusProjectionV1["environment"],
  events: readonly SignedProjectionEventV1[],
  authorityRegistry: ProjectionAuthorityRegistryV1,
  recoveryEvidenceRegistry: VerifiedRecoveryEvidenceRegistryV1 = {},
): TruthStatusProjectionV1 => {
  let projection = emptyProjection(environment);
  const byEventId = new Map<string, SignedProjectionEventV1>();
  for (const event of events) {
    const prior = byEventId.get(event.body.event_id);
    assert(
      prior === undefined || jcsCanonicalize(prior) === jcsCanonicalize(event),
      "conflicting duplicate event id",
    );
    byEventId.set(event.body.event_id, event);
  }
  const ordered = [...byEventId.values()].sort((left, right) => {
    const a = parseUint(left.body.sequence, "sequence");
    const b = parseUint(right.body.sequence, "sequence");
    return a < b ? -1 : a > b ? 1 : 0;
  });
  for (const event of ordered) {
    const grant = authorityRegistry[event.signer_key_id];
    assert(grant !== undefined, `untrusted event signer ${event.signer_key_id}`);
    assert(
      grant.authorities.includes(event.body.authority),
      `signer is not authorized for ${event.body.authority}`,
    );
    assert(
      verifyProjectionEventV1(event, grant.public_key_hex),
      "invalid projection event signature",
    );
    projection = applyEvent(
      projection,
      event,
      authorityRegistry,
      recoveryEvidenceRegistry,
    );
  }
  return digestProjection(projection);
};

export const queryEffectiveStatusV1 = (
  projection: TruthStatusProjectionV1,
  artifactHash: string,
  expectedGeneration: string,
  expectedInvalidationEpoch: string,
  options: {
    readonly monotonicNow?: () => number;
    readonly operationBudget?: number;
    readonly byteBudget?: number;
    readonly wallMilliseconds?: number;
  } = {},
): EffectiveStatusQueryResultV1 => {
  const monotonicNow = options.monotonicNow ?? (() => performance.now());
  const operationBudget = Math.min(
    options.operationBudget ?? DEPENDENCY_QUERY_LIMITS_V1.nodes,
    DEPENDENCY_QUERY_LIMITS_V1.nodes,
  );
  const byteBudget = Math.min(
    options.byteBudget ?? DEPENDENCY_QUERY_LIMITS_V1.estimatedBytes,
    DEPENDENCY_QUERY_LIMITS_V1.estimatedBytes,
  );
  const wallMilliseconds = Math.min(
    options.wallMilliseconds ?? DEPENDENCY_QUERY_LIMITS_V1.wallMilliseconds,
    DEPENDENCY_QUERY_LIMITS_V1.wallMilliseconds,
  );
  const started = monotonicNow();
  const root = projection.artifacts[artifactHash];
  assert(root !== undefined, "artifact not found");
  const { projection_digest: suppliedDigest, ...unsignedProjection } = projection;
  if (sha256Hex(jcsCanonicalize(unsignedProjection)) !== suppliedDigest) {
    return {
      artifact_hash: artifactHash,
      generation: expectedGeneration,
      invalidation_epoch: expectedInvalidationEpoch,
      lifecycle_state: root.lifecycle_state,
      effective_status: "UNKNOWN",
      reason_codes: ["PROJECTION_DIGEST_MISMATCH"],
      ancestor_closure_digest: sha256Hex("projection-digest-mismatch"),
      visited_nodes: 0,
    };
  }
  if (
    root.generation !== expectedGeneration ||
    projection.invalidation_epoch !== expectedInvalidationEpoch
  ) {
    return {
      artifact_hash: artifactHash,
      generation: expectedGeneration,
      invalidation_epoch: expectedInvalidationEpoch,
      lifecycle_state: root.lifecycle_state,
      effective_status: "UNKNOWN",
      reason_codes: ["STALE_GENERATION_OR_INVALIDATION_EPOCH"],
      ancestor_closure_digest: sha256Hex("stale"),
      visited_nodes: 0,
    };
  }
  const queue: Array<{ hash: string; depth: number }> = [{ hash: artifactHash, depth: 0 }];
  const visited = new Set<string>();
  let accountedBytes = 0;
  let effective = "READY" as ProjectionStatus;
  const reasons = new Set<string>();
  while (queue.length > 0) {
    if (monotonicNow() - started > wallMilliseconds) {
      return {
        artifact_hash: artifactHash,
        generation: expectedGeneration,
        invalidation_epoch: expectedInvalidationEpoch,
        lifecycle_state: root.lifecycle_state,
        effective_status: "UNKNOWN",
        reason_codes: ["RESOURCE_LIMIT"],
        ancestor_closure_digest: sha256Hex("resource-limit"),
        visited_nodes: visited.size,
      };
    }
    const current = queue.shift()!;
    if (visited.has(current.hash)) continue;
    if (
      current.depth > DEPENDENCY_QUERY_LIMITS_V1.depth ||
      visited.size >= operationBudget
    ) {
      return {
        artifact_hash: artifactHash,
        generation: expectedGeneration,
        invalidation_epoch: expectedInvalidationEpoch,
        lifecycle_state: root.lifecycle_state,
        effective_status: "UNKNOWN",
        reason_codes: ["RESOURCE_LIMIT"],
        ancestor_closure_digest: sha256Hex("resource-limit"),
        visited_nodes: visited.size,
      };
    }
    const node = projection.artifacts[current.hash];
    if (node === undefined) {
      return {
        artifact_hash: artifactHash,
        generation: expectedGeneration,
        invalidation_epoch: expectedInvalidationEpoch,
        lifecycle_state: root.lifecycle_state,
        effective_status: "UNKNOWN",
        reason_codes: ["MISSING_ANCESTOR"],
        ancestor_closure_digest: sha256Hex("missing-ancestor"),
        visited_nodes: visited.size,
      };
    }
    accountedBytes += encoder.encode(jcsCanonicalize(node)).byteLength;
    if (accountedBytes > byteBudget) {
      return {
        artifact_hash: artifactHash,
        generation: expectedGeneration,
        invalidation_epoch: expectedInvalidationEpoch,
        lifecycle_state: root.lifecycle_state,
        effective_status: "UNKNOWN",
        reason_codes: ["RESOURCE_LIMIT"],
        ancestor_closure_digest: sha256Hex("resource-limit"),
        visited_nodes: visited.size,
      };
    }
    visited.add(current.hash);
    if (node.generation !== expectedGeneration) {
      effective = worseProjectionStatus(effective, "UNKNOWN");
      reasons.add("STALE_ANCESTOR_GENERATION");
    }
    if (node.invalidation_epoch !== expectedInvalidationEpoch) {
      effective = worseProjectionStatus(effective, "UNKNOWN");
      reasons.add("STALE_ANCESTOR_INVALIDATION_EPOCH");
    }
    effective = worseProjectionStatus(
      effective,
      worseProjectionStatus(node.local_status, node.state_floor),
    );
    node.reason_codes.forEach((reason) => reasons.add(reason));
    node.depends_on.forEach((dependency) =>
      queue.push({ hash: dependency, depth: current.depth + 1 }),
    );
  }
  const closure = [...visited].sort();
  return {
    artifact_hash: artifactHash,
    generation: expectedGeneration,
    invalidation_epoch: expectedInvalidationEpoch,
    lifecycle_state: root.lifecycle_state,
    effective_status: effective,
    reason_codes: [...reasons].sort(),
    ancestor_closure_digest: sha256Hex(
      jcsCanonicalize({ closure, expectedGeneration, expectedInvalidationEpoch }),
    ),
    visited_nodes: visited.size,
  };
};

export const planInvalidationFanoutV1 = (
  projection: TruthStatusProjectionV1,
  origin: string,
  invalidationEpoch: string,
  stateFloor: ProjectionStatus,
  sourceCauseEventId: string,
  failDeliveryFor: ReadonlySet<string> = new Set(),
): FanoutResultV1 => {
  const originNode = projection.artifacts[origin];
  assert(originNode !== undefined, "fanout origin not found");
  assert(
    invalidationEpoch === projection.invalidation_epoch &&
      projection.artifacts[origin]!.invalidation_epoch === invalidationEpoch,
    "fanout must follow a persisted origin invalidation in the same epoch",
  );
  const sourceCause = originNode.active_causes.find(
    (cause) => cause.event_id === sourceCauseEventId,
  );
  assert(sourceCause !== undefined, "fanout source cause is not active");
  assert(
    statusRank(stateFloor) >= statusRank(sourceCause.state_floor),
    "fanout state floor weakens source cause",
  );
  const reverse = new Map<string, string[]>();
  for (const node of Object.values(projection.artifacts)) {
    for (const dependency of node.depends_on) {
      reverse.set(dependency, [...(reverse.get(dependency) ?? []), node.artifact_hash].sort());
    }
  }
  const queue = [origin];
  const visited = new Set<string>();
  const deliveries: FanoutDeliveryV1[] = [];
  while (queue.length > 0) {
    const artifactHash = queue.shift()!;
    if (visited.has(artifactHash)) continue;
    visited.add(artifactHash);
    const failed = failDeliveryFor.has(artifactHash);
    deliveries.push({
      event_id: sha256Hex(
        `invalidation\0${invalidationEpoch}\0${origin}\0${artifactHash}\0${stateFloor}\0${sourceCause.event_id}\0${sourceCause.reason_code}\0${sourceCause.authority}`,
      ),
      artifact_hash: artifactHash,
      batch: Math.floor((deliveries.length) / DEPENDENCY_QUERY_LIMITS_V1.fanoutBatch) + 1,
      state_floor: failed ? worseProjectionStatus(stateFloor, "UNKNOWN") : stateFloor,
      status: failed ? "DEAD_LETTER" : "DELIVERED",
      attempts: failed ? INVALIDATION_RETRY_POLICY_V1.attempts : 1,
      retry_owner: INVALIDATION_RETRY_POLICY_V1.owner,
    });
    queue.push(...(reverse.get(artifactHash) ?? []));
  }
  return {
    origin,
    invalidation_epoch: invalidationEpoch,
    deliveries,
    batches: Math.ceil(deliveries.length / DEPENDENCY_QUERY_LIMITS_V1.fanoutBatch),
    converged: deliveries.every((delivery) => delivery.status === "DELIVERED"),
  };
};

export interface ExecutedInvalidationFanoutV1 extends FanoutResultV1 {
  readonly signed_events: readonly SignedProjectionEventV1[];
}

export const executeInvalidationFanoutV1 = (
  projection: TruthStatusProjectionV1,
  origin: string,
  invalidationEpoch: string,
  stateFloor: ProjectionStatus,
  sourceCauseEventId: string,
  signer: TrustEnvelopeSigner,
  occurredAt: string,
  failDeliveryFor: ReadonlySet<string> = new Set(),
): ExecutedInvalidationFanoutV1 => {
  const sourceCause = projection.artifacts[origin]?.active_causes.find(
    (cause) => cause.event_id === sourceCauseEventId,
  );
  assert(sourceCause !== undefined, "fanout source cause is not active");
  assert(
    signer.keyId === sourceCause.signer_key_id,
    "fanout signer differs from persisted source cause",
  );
  const plan = planInvalidationFanoutV1(
    projection,
    origin,
    invalidationEpoch,
    stateFloor,
    sourceCauseEventId,
    failDeliveryFor,
  );
  let previousHash = projection.tail_event_hash;
  let sequence = parseUint(projection.last_sequence, "last sequence");
  const signedEvents: SignedProjectionEventV1[] = [];
  for (const delivery of plan.deliveries.filter(
    (candidate) => candidate.artifact_hash !== origin,
  )) {
    const node = projection.artifacts[delivery.artifact_hash]!;
    sequence += 1n;
    const body: ProjectionEventBodyV1 = {
      schema_version: 1,
      event_id: delivery.event_id,
      sequence: String(sequence),
      previous_event_hash: previousHash,
      kind:
        delivery.status === "DEAD_LETTER"
          ? "DELIVERY_DEAD_LETTER"
          : "INVALIDATION",
      environment: projection.environment,
      artifact_hash: delivery.artifact_hash,
      generation: node.generation,
      invalidation_epoch: invalidationEpoch,
      authority: sourceCause.authority,
      lifecycle_state: node.lifecycle_state,
      local_status: delivery.state_floor,
      state_floor: delivery.state_floor,
      reason_code:
        delivery.status === "DEAD_LETTER"
          ? `DEAD_LETTER:${sourceCause.reason_code}`
          : sourceCause.reason_code,
      cause_event_id: delivery.event_id,
      resolves_cause_event_ids: [],
      replacement_evidence_hash: null,
      replacement_evidence_kinds: null,
      replacement_evidence: null,
      depends_on: [],
      occurred_at: new Date(
        Date.parse(occurredAt) + signedEvents.length,
      ).toISOString(),
      production_authority: false,
    };
    const event = compileProjectionEventV1(body, signer);
    signedEvents.push(event);
    previousHash = sha256Hex(jcsCanonicalize(event));
  }
  return { ...plan, signed_events: signedEvents };
};

export const assertProjectionDigestEqualityV1 = (
  served: TruthStatusProjectionV1,
  rebuilt: TruthStatusProjectionV1,
): void => {
  assert(
    served.projection_digest === rebuilt.projection_digest &&
      jcsCanonicalize(served) === jcsCanonicalize(rebuilt),
    "projection rebuild is not byte-identical",
  );
};

/**
 * Hermetic CAS journal used to prove concurrent fan-out batches cannot both
 * append from one stale projection tail. Production durability remains outside
 * the staged Sprint 4 authority boundary.
 */
export class ProjectionEventJournalV1 {
  readonly #events: SignedProjectionEventV1[] = [];

  appendBatch(
    expectedTailEventHash: string | null,
    batch: readonly SignedProjectionEventV1[],
  ): void {
    const currentTail =
      this.#events.length === 0
        ? null
        : sha256Hex(jcsCanonicalize(this.#events.at(-1)!));
    assert(currentTail === expectedTailEventHash, "projection journal CAS conflict");
    let priorHash = currentTail;
    let sequence = BigInt(this.#events.length);
    for (const event of batch) {
      sequence += 1n;
      assert(event.body.sequence === String(sequence), "journal sequence gap");
      assert(event.body.previous_event_hash === priorHash, "journal hash-chain mismatch");
      priorHash = sha256Hex(jcsCanonicalize(event));
    }
    this.#events.push(...batch);
  }

  readAll(): readonly SignedProjectionEventV1[] {
    return [...this.#events];
  }
}
