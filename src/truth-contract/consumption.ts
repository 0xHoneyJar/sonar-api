import { Effect } from "effect";

import type { TrustEnvelopeSigner } from "../collection-resolver/trust-protocol.js";
import {
  jcsCanonicalize,
  sha256Hex,
  verifyEd25519Signature,
} from "../collection-resolver/trust-protocol.js";
import {
  TruthIntegrityError,
  TruthTrustError,
} from "./errors.js";
import {
  type ConsumedReceiptBodyV1,
  ConsumedReceiptV1,
  type NotConsumedReceiptBodyV1,
  NotConsumedReceiptV1,
  SCORE_AUTHORITY_ANCHOR_DOMAIN,
  SCORE_CONSUMED_RECEIPT_DOMAIN,
  ScoreAuthorityPolicyV1,
  type ScoreReceiptAuthorityKindV1,
  type ScoreReceiptTargetV1,
  ScoreReceiptV1,
  ScoreTrustedAuthorityAnchorV1,
  SONAR_NOT_CONSUMED_RECEIPT_DOMAIN,
} from "./schemas/consumption.js";
import {
  decodeStrict,
  type DecimalUint64,
  type Sha256Digest,
  type TruthEnvironmentId,
  type TruthIsoTimestamp,
} from "./schemas/common.js";

const encoder = new TextEncoder();
const SEVEN_DAYS_MILLISECONDS = 7 * 24 * 60 * 60 * 1_000;
const verifiedScoreAuthorityAnchors = new WeakSet<object>();
const verifiedScoreAuthorityAnchor = Symbol("VerifiedScoreAuthorityAnchorV1");

type ScoreReceiptBodyV1 =
  | NotConsumedReceiptBodyV1
  | ConsumedReceiptBodyV1;

export interface ScoreReceiptVerificationContextV1 {
  readonly target: ScoreReceiptTargetV1;
  readonly authorities: readonly ScoreAuthorityPolicyV1[];
  readonly authority_high_water: Readonly<
    Record<ScoreReceiptAuthorityKindV1, DecimalUint64>
  >;
  readonly revocation_high_water: DecimalUint64;
  readonly receipt_sequence_high_water: DecimalUint64;
  /**
   * Opaque proof that the decoded authority material matched an independently
   * supplied exact pin. It may be absent only while the result remains
   * fail-closed at NotConsumed.
   */
  readonly verified_anchor?: VerifiedScoreAuthorityAnchorV1;
  readonly handoff: {
    readonly receipt_hash: Sha256Digest;
    readonly sealed_at: TruthIsoTimestamp;
  };
  readonly now: TruthIsoTimestamp;
}

export type ScoreConsumptionStateV1 =
  | {
      readonly _tag: "NOT_CONSUMED";
      readonly receipt_hash: Sha256Digest;
      readonly receipt: ScoreReceiptV1;
      readonly owner: "bd-v54z.1";
      readonly deadline: TruthIsoTimestamp;
    }
  | {
      readonly _tag: "NOT_CONSUMED_OVERDUE";
      readonly receipt_hash: Sha256Digest;
      readonly receipt: ScoreReceiptV1;
      readonly owner: "bd-v54z.1";
      readonly deadline: TruthIsoTimestamp;
    }
  | {
      readonly _tag: "CONSUMED";
      readonly receipt_hash: Sha256Digest;
      readonly receipt: ScoreReceiptV1;
      readonly consumer_snapshot_hash: Sha256Digest;
    }
  | {
      readonly _tag: "SUSPENDED_CONFLICT";
      readonly sequence: DecimalUint64;
      readonly conflicting_receipt_hashes: readonly Sha256Digest[];
    };

const integrityFailure = (reason: string): TruthIntegrityError =>
  new TruthIntegrityError({
    boundary: "truth.score-consumption",
    reason,
  });

const trustFailure = (reason: string): TruthTrustError =>
  new TruthTrustError({
    boundary: "truth.score-consumption",
    reason,
  });

const receiptBodyHash = (body: ScoreReceiptBodyV1): Sha256Digest =>
  sha256Hex(jcsCanonicalize(body)) as Sha256Digest;

const receiptSigningBytes = (
  body: ScoreReceiptBodyV1,
  bodyHash = receiptBodyHash(body),
): Uint8Array =>
  encoder.encode(
    `${body.domain}\0${body.authority_kind}\0${body.target.environment}\0${body.authority_generation}\0${body.sequence}\0${bodyHash}`,
  );

export const scoreReceiptHashV1 = (
  receipt: ScoreReceiptV1,
): Sha256Digest => receipt.body_hash;

export const scoreAuthorityKeysetHashV1 = (
  policy: Omit<ScoreAuthorityPolicyV1, "keyset_hash">,
): Sha256Digest =>
  sha256Hex(
    jcsCanonicalize({
      schema_version: policy.schema_version,
      authority_kind: policy.authority_kind,
      environment: policy.environment,
      generation: policy.generation,
      threshold: policy.threshold,
      keys: [...policy.keys].sort((left, right) =>
        left.key_id.localeCompare(right.key_id),
      ),
    }),
  ) as Sha256Digest;

export interface ScoreAuthorityAnchorMaterialV1 {
  readonly target: ScoreReceiptTargetV1;
  readonly authorities: readonly ScoreAuthorityPolicyV1[];
  readonly authority_high_water: Readonly<
    Record<ScoreReceiptAuthorityKindV1, DecimalUint64>
  >;
  readonly revocation_high_water: DecimalUint64;
  readonly anchor_generation: DecimalUint64;
}

export interface VerifiedScoreAuthorityAnchorV1 {
  readonly [verifiedScoreAuthorityAnchor]: true;
  readonly environment: TruthEnvironmentId;
  readonly generation: DecimalUint64;
  readonly digest: Sha256Digest;
}

export const scoreAuthorityAnchorDigestV1 = (
  material: ScoreAuthorityAnchorMaterialV1,
): Sha256Digest =>
  sha256Hex(
    jcsCanonicalize({
      schema_version: 1,
      domain: SCORE_AUTHORITY_ANCHOR_DOMAIN,
      environment: material.target.environment,
      target: material.target,
      anchor_generation: material.anchor_generation,
      authority_high_water: material.authority_high_water,
      revocation_high_water: material.revocation_high_water,
      authority_policy_set: [...material.authorities]
        .map((policy) => ({
          authority_kind: policy.authority_kind,
          generation: policy.generation,
          keyset_hash: policy.keyset_hash,
        }))
        .sort((left, right) =>
          left.authority_kind === right.authority_kind
            ? BigInt(left.generation) < BigInt(right.generation)
              ? -1
              : BigInt(left.generation) > BigInt(right.generation)
                ? 1
                : 0
            : left.authority_kind.localeCompare(right.authority_kind),
        ),
    }),
  ) as Sha256Digest;

export const verifyScoreAuthorityAnchorPinV1 = (
  material: ScoreAuthorityAnchorMaterialV1,
  exactPin: unknown,
): Effect.Effect<
  VerifiedScoreAuthorityAnchorV1,
  import("./errors.js").TruthDecodeError | TruthTrustError
> =>
  Effect.gen(function* () {
    const pin = yield* decodeStrict(
      ScoreTrustedAuthorityAnchorV1,
      "truth.score-consumption.authority-anchor-pin",
      exactPin,
    );
    const expectedDigest = scoreAuthorityAnchorDigestV1(material);
    if (
      pin.environment !== material.target.environment ||
      pin.generation !== material.anchor_generation ||
      pin.digest !== expectedDigest
    ) {
      return yield* Effect.fail(
        trustFailure(
          "authority material does not match the independently supplied exact anchor pin",
        ),
      );
    }
    const capability: VerifiedScoreAuthorityAnchorV1 = Object.freeze({
      [verifiedScoreAuthorityAnchor]: true as const,
      environment: pin.environment,
      generation: pin.generation,
      digest: pin.digest,
    });
    verifiedScoreAuthorityAnchors.add(capability);
    return capability;
  });

const compileSignatures = (
  body: ScoreReceiptBodyV1,
  signers: readonly TrustEnvelopeSigner[],
): Effect.Effect<
  readonly { readonly key_id: string; readonly signature: string }[],
  TruthTrustError
> =>
  Effect.gen(function* () {
    const uniqueSigners = new Map(
      signers.map((signer) => [signer.keyId, signer]),
    );
    if (uniqueSigners.size !== 2 || signers.length !== 2) {
      return yield* Effect.fail(
        trustFailure("receipt compilation requires an exact 2-of-2 signer quorum"),
      );
    }
    const bytes = receiptSigningBytes(body);
    return [...uniqueSigners.values()]
      .sort((left, right) => left.keyId.localeCompare(right.keyId))
      .map((signer) => ({
        key_id: signer.keyId,
        signature: signer.sign(bytes),
      }));
  });

export const compileNotConsumedReceiptV1 = (
  input: unknown,
  signers: readonly TrustEnvelopeSigner[],
): Effect.Effect<
  NotConsumedReceiptV1,
  import("./errors.js").TruthDecodeError | TruthIntegrityError | TruthTrustError
> =>
  Effect.gen(function* () {
    const body = yield* decodeStrict(
      NotConsumedReceiptV1.fields.body,
      "truth.score-consumption.not-consumed-body",
      input,
    );
    const handoffTime = new Date(body.handoff_sealed_at).getTime();
    const expectedDeadline = new Date(
      handoffTime + SEVEN_DAYS_MILLISECONDS,
    ).toISOString();
    if (body.deadline !== expectedDeadline) {
      return yield* Effect.fail(
        integrityFailure(
          "NotConsumed deadline must be exactly seven days after the sealed handoff",
        ),
      );
    }
    if (new Date(body.issued_at).getTime() < handoffTime) {
      return yield* Effect.fail(
        integrityFailure("NotConsumed receipt issuance precedes its sealed handoff"),
      );
    }
    const bodyHash = receiptBodyHash(body);
    const signatures = yield* compileSignatures(body, signers);
    return yield* decodeStrict(
      NotConsumedReceiptV1,
      "truth.score-consumption.receipt",
      { body, body_hash: bodyHash, signatures },
    );
  });

export const compileConsumedReceiptV1 = (
  input: unknown,
  signers: readonly TrustEnvelopeSigner[],
): Effect.Effect<
  ConsumedReceiptV1,
  import("./errors.js").TruthDecodeError | TruthIntegrityError | TruthTrustError
> =>
  Effect.gen(function* () {
    const body = yield* decodeStrict(
      ConsumedReceiptV1.fields.body,
      "truth.score-consumption.consumed-body",
      input,
    );
    if (new Date(body.consumed_at).getTime() < new Date(body.issued_at).getTime()) {
      return yield* Effect.fail(
        integrityFailure("consumed_at precedes receipt issuance"),
      );
    }
    if (new Date(body.expires_at).getTime() <= new Date(body.consumed_at).getTime()) {
      return yield* Effect.fail(
        integrityFailure("Consumed receipt must expire after consumption"),
      );
    }
    const bodyHash = receiptBodyHash(body);
    const signatures = yield* compileSignatures(body, signers);
    return yield* decodeStrict(
      ConsumedReceiptV1,
      "truth.score-consumption.receipt",
      { body, body_hash: bodyHash, signatures },
    );
  });

const sameTarget = (
  left: ScoreReceiptTargetV1,
  right: ScoreReceiptTargetV1,
): boolean => jcsCanonicalize(left) === jcsCanonicalize(right);

const authorityKey = (
  authorityKind: ScoreReceiptAuthorityKindV1,
  generation: DecimalUint64,
): string => `${authorityKind}\0${generation}`;

const validateAuthorityHistory = (
  policies: readonly ScoreAuthorityPolicyV1[],
  context: ScoreReceiptVerificationContextV1,
): Effect.Effect<ReadonlyMap<string, ScoreAuthorityPolicyV1>, TruthTrustError> =>
  Effect.gen(function* () {
    const policiesByKey = new Map<string, ScoreAuthorityPolicyV1>();
    for (const policy of policies) {
      if (policy.environment !== context.target.environment) {
        return yield* Effect.fail(
          trustFailure("receipt authority environment mismatch"),
        );
      }
      const key = authorityKey(policy.authority_kind, policy.generation);
      if (policiesByKey.has(key)) {
        return yield* Effect.fail(
          trustFailure("duplicate receipt authority generation"),
        );
      }
      if (
        policy.keys.length !== 2 ||
        new Set(policy.keys.map((candidate) => candidate.key_id)).size !== 2 ||
        new Set(policy.keys.map((candidate) => candidate.public_key_hex)).size !== 2
      ) {
        return yield* Effect.fail(
          trustFailure("receipt authority must contain two distinct keys"),
        );
      }
      if (scoreAuthorityKeysetHashV1(policy) !== policy.keyset_hash) {
        return yield* Effect.fail(
          trustFailure("receipt authority keyset hash mismatch"),
        );
      }
      policiesByKey.set(key, policy);
    }
    for (const kind of ["SONAR_HANDOFF", "SCORE_CONSUMER"] as const) {
      const highWater = BigInt(context.authority_high_water[kind]);
      if (highWater < 1n) {
        return yield* Effect.fail(
          trustFailure("receipt authority high-water must be positive"),
        );
      }
      const generations = policies
        .filter((policy) => policy.authority_kind === kind)
        .map((policy) => BigInt(policy.generation))
        .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
      if (
        BigInt(generations.length) !== highWater ||
        generations.some((generation, index) => generation !== BigInt(index + 1))
      ) {
        return yield* Effect.fail(
          trustFailure(
            `${kind} authority history does not reach its contiguous high-water`,
          ),
        );
      }
    }
    return policiesByKey;
  });

const verifyAuthority = (
  receipt: ScoreReceiptV1,
  policiesByKey: ReadonlyMap<string, ScoreAuthorityPolicyV1>,
  context: ScoreReceiptVerificationContextV1,
): Effect.Effect<void, TruthTrustError> =>
  Effect.gen(function* () {
    const body = receipt.body;
    if (
      body.authority_generation !==
      context.authority_high_water[body.authority_kind]
    ) {
      return yield* Effect.fail(
        trustFailure(
          `${body.authority_kind} receipt authority is not the active high-water generation`,
        ),
      );
    }
    const policy = policiesByKey.get(
      authorityKey(body.authority_kind, body.authority_generation),
    );
    if (
      policy === undefined ||
      policy.keyset_hash !== body.authority_keyset_hash
    ) {
      return yield* Effect.fail(
        trustFailure("receipt authority generation or keyset binding mismatch"),
      );
    }
    const signatures = new Map(
      receipt.signatures.map((signature) => [String(signature.key_id), signature]),
    );
    if (signatures.size !== 2 || receipt.signatures.length !== 2) {
      return yield* Effect.fail(
        trustFailure("receipt requires an exact 2-of-2 signature quorum"),
      );
    }
    const sequence = BigInt(body.sequence);
    let verified = 0;
    for (const [keyId, signature] of signatures) {
      const key = policy.keys.find((candidate) => candidate.key_id === keyId);
      if (key === undefined) {
        continue;
      }
      const valid =
        sequence >= BigInt(key.valid_from_sequence) &&
        (key.valid_through_sequence === null ||
          sequence <= BigInt(key.valid_through_sequence)) &&
        (key.compromised_from_sequence === null ||
          sequence < BigInt(key.compromised_from_sequence));
      if (
        valid &&
        verifyEd25519Signature(
          key.public_key_hex,
          receiptSigningBytes(body, receipt.body_hash),
          signature.signature,
        )
      ) {
        verified += 1;
      }
    }
    if (verified !== 2) {
      return yield* Effect.fail(
        trustFailure(`${body.authority_kind} receipt signer quorum is not satisfied`),
      );
    }
  });

const suspendedConflict = (
  sequence: DecimalUint64,
  hashes: readonly Sha256Digest[],
): ScoreConsumptionStateV1 => ({
  _tag: "SUSPENDED_CONFLICT",
  sequence,
  conflicting_receipt_hashes: [...new Set(hashes)].sort(),
});

export const verifyScoreConsumptionReceiptsV1 = (
  inputs: readonly unknown[],
  context: ScoreReceiptVerificationContextV1,
): Effect.Effect<
  ScoreConsumptionStateV1,
  import("./errors.js").TruthDecodeError | TruthIntegrityError | TruthTrustError
> =>
  Effect.gen(function* () {
    if (inputs.length === 0) {
      return yield* Effect.fail(
        integrityFailure("Score receipt set is empty"),
      );
    }
    const policies = yield* Effect.forEach(
      context.authorities,
      (input) =>
        decodeStrict(
          ScoreAuthorityPolicyV1,
          "truth.score-consumption.authority",
          input,
        ),
      { concurrency: 1 },
    );
    const policiesByKey = yield* validateAuthorityHistory(policies, context);
    const verifiedAnchor = context.verified_anchor;
    if (
      verifiedAnchor !== undefined &&
      !verifiedScoreAuthorityAnchors.has(verifiedAnchor)
    ) {
      return yield* Effect.fail(
        trustFailure(
          "Score authority anchor is not an opaque verified capability",
        ),
      );
    }
    const receipts = yield* Effect.forEach(
      inputs,
      (input) =>
        decodeStrict(
          ScoreReceiptV1,
          "truth.score-consumption.receipt",
          input,
        ),
      { concurrency: 1 },
    );
    for (const receipt of receipts) {
      if (receipt.body_hash !== receiptBodyHash(receipt.body)) {
        return yield* Effect.fail(
          integrityFailure("receipt body hash mismatch"),
        );
      }
      if (!sameTarget(receipt.body.target, context.target)) {
        return yield* Effect.fail(
          trustFailure("Score receipt target identity or producer binding mismatch"),
        );
      }
      if (
        new Date(receipt.body.issued_at).getTime() >
        new Date(context.now).getTime()
      ) {
        return yield* Effect.fail(
          trustFailure("receipt issuance exceeds the zero-skew verification time"),
        );
      }
      if (receipt.body.revocation_sequence !== context.revocation_high_water) {
        return yield* Effect.fail(
          trustFailure(
            "receipt revocation sequence does not match the trusted high-water",
          ),
        );
      }
      if (
        receipt.body._tag === "NotConsumedReceiptV1" &&
        (receipt.body.domain !== SONAR_NOT_CONSUMED_RECEIPT_DOMAIN ||
          receipt.body.authority_kind !== "SONAR_HANDOFF" ||
          receipt.body.handoff_receipt_hash !== context.handoff.receipt_hash ||
          receipt.body.handoff_sealed_at !== context.handoff.sealed_at)
      ) {
        return yield* Effect.fail(
          trustFailure("NotConsumed receipt is not bound to the sealed Sonar handoff"),
        );
      }
      if (
        receipt.body._tag === "ConsumedReceiptV1" &&
        (receipt.body.domain !== SCORE_CONSUMED_RECEIPT_DOMAIN ||
          receipt.body.authority_kind !== "SCORE_CONSUMER")
      ) {
        return yield* Effect.fail(
          trustFailure("Consumed receipt is not bound to the Score consumer domain"),
        );
      }
      yield* verifyAuthority(receipt, policiesByKey, context);
    }

    if (verifiedAnchor !== undefined) {
      if (
        verifiedAnchor.environment !== context.target.environment ||
        verifiedAnchor.digest !==
          scoreAuthorityAnchorDigestV1({
            target: context.target,
            authorities: policies,
            authority_high_water: context.authority_high_water,
            revocation_high_water: context.revocation_high_water,
            anchor_generation: verifiedAnchor.generation,
          })
      ) {
        return yield* Effect.fail(
          trustFailure(
            "authority and revocation high-waters do not match the trusted anchor",
          ),
        );
      }
    }

    const bySequence = new Map<string, Map<Sha256Digest, ScoreReceiptV1>>();
    for (const receipt of receipts) {
      const sequenceReceipts =
        bySequence.get(receipt.body.sequence) ??
        new Map<Sha256Digest, ScoreReceiptV1>();
      sequenceReceipts.set(receipt.body_hash, receipt);
      bySequence.set(receipt.body.sequence, sequenceReceipts);
    }
    for (const [sequence, sequenceReceipts] of bySequence) {
      if (sequenceReceipts.size > 1) {
        return suspendedConflict(
          sequence as DecimalUint64,
          [...sequenceReceipts.keys()],
        );
      }
    }

    const ordered = [...bySequence.values()]
      .map((sequenceReceipts) => [...sequenceReceipts.values()][0]!)
      .sort((left, right) =>
        BigInt(left.body.sequence) < BigInt(right.body.sequence) ? -1 : 1,
      );
    const highest = ordered.at(-1)!;
    if (
      highest.body.sequence !== context.receipt_sequence_high_water
    ) {
      return yield* Effect.fail(
        trustFailure("receipt log does not match its sequence high-water"),
      );
    }
    for (let index = 0; index < ordered.length; index += 1) {
      const receipt = ordered[index]!;
      const expectedSequence = BigInt(index + 1);
      if (BigInt(receipt.body.sequence) !== expectedSequence) {
        return yield* Effect.fail(
          integrityFailure("receipt sequence is not contiguous from one"),
        );
      }
      const prior = index === 0 ? null : ordered[index - 1]!.body_hash;
      if (receipt.body.prior_receipt_hash !== prior) {
        return yield* Effect.fail(
          integrityFailure("receipt prior hash does not form a contiguous chain"),
        );
      }
    }

    const first = ordered[0]!;
    if (first.body._tag !== "NotConsumedReceiptV1") {
      return yield* Effect.fail(
        integrityFailure("receipt sequence must begin with NotConsumed"),
      );
    }
    const expectedDeadline = new Date(
      new Date(first.body.handoff_sealed_at).getTime() +
        SEVEN_DAYS_MILLISECONDS,
    ).toISOString();
    if (
      first.body.deadline !== expectedDeadline ||
      first.body.expires_at !== null ||
      first.body.supersedes_receipt_hash !== null ||
      new Date(first.body.issued_at).getTime() <
        new Date(first.body.handoff_sealed_at).getTime()
    ) {
      return yield* Effect.fail(
        integrityFailure("NotConsumed SLA or non-expiring status is invalid"),
      );
    }
    if (ordered.length > 2) {
      return suspendedConflict(
        highest.body.sequence,
        [ordered[ordered.length - 2]!.body_hash, highest.body_hash],
      );
    }
    if (ordered.length === 2) {
      const consumed = ordered[1]!;
      if (verifiedAnchor === undefined) {
        return yield* Effect.fail(
          trustFailure(
            "Consumed receipt requires an independently supplied trusted authority anchor",
          ),
        );
      }
      if (
        consumed.body._tag !== "ConsumedReceiptV1" ||
        consumed.body.supersedes_receipt_hash !== first.body_hash
      ) {
        return suspendedConflict(consumed.body.sequence, [
          first.body_hash,
          consumed.body_hash,
        ]);
      }
      if (
        new Date(consumed.body.issued_at).getTime() <
          new Date(first.body.issued_at).getTime() ||
        new Date(consumed.body.consumed_at).getTime() <
          new Date(consumed.body.issued_at).getTime() ||
        new Date(consumed.body.consumed_at).getTime() >
          new Date(context.now).getTime() ||
        new Date(consumed.body.expires_at).getTime() <=
          new Date(consumed.body.consumed_at).getTime() ||
        new Date(consumed.body.expires_at).getTime() <=
          new Date(context.now).getTime()
      ) {
        return yield* Effect.fail(
          integrityFailure("Consumed receipt chronology or expiry is invalid"),
        );
      }
      return {
        _tag: "CONSUMED",
        receipt_hash: consumed.body_hash,
        receipt: consumed,
        consumer_snapshot_hash: consumed.body.consumer_snapshot_hash,
      };
    }

    const overdue =
      new Date(context.now).getTime() > new Date(first.body.deadline).getTime();
    return {
      _tag: overdue ? "NOT_CONSUMED_OVERDUE" : "NOT_CONSUMED",
      receipt_hash: first.body_hash,
      receipt: first,
      owner: first.body.owner,
      deadline: first.body.deadline,
    };
  });
