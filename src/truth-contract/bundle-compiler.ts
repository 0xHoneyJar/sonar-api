import { Effect } from "effect";

import type { TrustEnvelopeSigner } from "../collection-resolver/trust-protocol.js";
import {
  TruthDecodeError,
  TruthIntegrityError,
  TruthTrustError,
} from "./errors.js";
import { assertAcyclicJson, canonicalizeTruthJson } from "./canonical.js";
import { signTruthRoot, verifyTruthRootSignature } from "./crypto.js";
import {
  TRUTH_RESOURCE_LIMITS,
  TRUTH_MAX_FUTURE_SKEW_MILLISECONDS,
  decodeStrict,
  requireByteLimit,
  type DecimalUint64,
  type Sha256Digest,
  type TruthEnvironmentId,
  type TruthIsoTimestamp,
  type TruthObjectRef,
} from "./schemas/common.js";
import {
  TRUTH_NORMATIVE_OBJECT_KINDS,
  TruthBundleRootUnsignedV1,
  TruthBundleRootV1,
} from "./schemas/bundle.js";
import {
  jcsCanonicalize,
  sha256Hex,
} from "../collection-resolver/trust-protocol.js";

const requiredKinds = new Set<string>(TRUTH_NORMATIVE_OBJECT_KINDS);

const integrityFailure = (reason: string): TruthIntegrityError =>
  new TruthIntegrityError({ boundary: "truth.bundle", reason });

const validateClosure = (
  objects: ReadonlyArray<TruthObjectRef>,
  requireCanonicalOrder: boolean,
): Effect.Effect<void, TruthIntegrityError> =>
  Effect.gen(function* () {
    // A root is authoritative only over the exact v1 object-kind closure.
    const kinds = objects.map((object) => object.kind as string);
    if (new Set(kinds).size !== kinds.length) {
      return yield* Effect.fail(integrityFailure("duplicate normative object kind"));
    }
    const unknown = kinds.filter((kind) => !requiredKinds.has(kind));
    if (unknown.length > 0) {
      return yield* Effect.fail(
        integrityFailure(`unknown normative object kind: ${unknown.sort().join(",")}`),
      );
    }
    const missing = TRUTH_NORMATIVE_OBJECT_KINDS.filter((kind) => !kinds.includes(kind));
    if (missing.length > 0) {
      return yield* Effect.fail(
        integrityFailure(`missing normative object kind: ${missing.join(",")}`),
      );
    }
    const closureBytes = objects.reduce(
      (total, object) => total + BigInt(object.byte_length),
      0n,
    );
    if (closureBytes > BigInt(TRUTH_RESOURCE_LIMITS.totalClosureBytes)) {
      return yield* Effect.fail(integrityFailure("normative object closure exceeds byte limit"));
    }
    if (
      objects.some(
        (object) => BigInt(object.byte_length) > BigInt(TRUTH_RESOURCE_LIMITS.objectBytes),
      )
    ) {
      return yield* Effect.fail(integrityFailure("normative object exceeds byte limit"));
    }
    if (requireCanonicalOrder) {
      const sorted = [...kinds].sort();
      if (kinds.some((kind, index) => kind !== sorted[index])) {
        return yield* Effect.fail(
          integrityFailure("normative object manifest is not sorted by kind"),
        );
      }
    }
  });

const validateRootPins = (
  root: TruthBundleRootUnsignedV1,
): Effect.Effect<void, TruthIntegrityError> => {
  // Security and authority pins are duplicated at the root for fail-fast trust checks.
  const hashes = new Map(
    root.objects.map((object) => [String(object.kind), String(object.sha256)]),
  );
  if (hashes.get("authority_matrix") !== root.authority_matrix_hash) {
    return Effect.fail(integrityFailure("authority matrix hash pin does not match closure"));
  }
  if (hashes.get("security_profile") !== root.security_profile_hash) {
    return Effect.fail(integrityFailure("security profile hash pin does not match closure"));
  }
  return Effect.void;
};

const validateRootLineage = (
  root: TruthBundleRootUnsignedV1,
): Effect.Effect<void, TruthIntegrityError> => {
  const generation = BigInt(root.generation);
  const supersedes =
    root.supersedes_generation === null ? null : BigInt(root.supersedes_generation);
  const contiguous =
    generation === 1n ? supersedes === null : supersedes === generation - 1n;
  if (!contiguous) {
    return Effect.fail(integrityFailure("root generation lineage is not contiguous"));
  }
  if (new Date(root.valid_from).getTime() < new Date(root.issued_at).getTime()) {
    return Effect.fail(integrityFailure("root valid_from precedes issued_at"));
  }
  return Effect.void;
};

const sortUnsignedRoot = (
  root: TruthBundleRootUnsignedV1,
): TruthBundleRootUnsignedV1 =>
  new TruthBundleRootUnsignedV1({
    ...root,
    objects: [...root.objects].sort((left, right) => {
      const leftKind = String(left.kind);
      const rightKind = String(right.kind);
      return leftKind < rightKind ? -1 : leftKind > rightKind ? 1 : 0;
    }),
  });

const signCompiledRoot = (
  unsignedRoot: TruthBundleRootUnsignedV1,
  signer: TrustEnvelopeSigner,
): Effect.Effect<
  TruthBundleRootV1,
  TruthDecodeError | TruthIntegrityError | TruthTrustError
> =>
  Effect.gen(function* () {
    const canonical = yield* canonicalizeTruthJson(
      unsignedRoot,
      "truth.bundle.unsigned",
    );
    const rootHash = sha256Hex(canonical);
    const signature = yield* Effect.try({
      try: () =>
        signTruthRoot(
          signer,
          unsignedRoot.environment,
          unsignedRoot.generation,
          rootHash as Sha256Digest,
        ),
      catch: () =>
        new TruthTrustError({
          boundary: "truth.bundle.sign",
          reason: "Ed25519 signer failed",
        }),
    });
    return yield* decodeStrict(TruthBundleRootV1, "truth.bundle.signed", {
      unsigned_root: unsignedRoot,
      root_hash: rootHash,
      signature,
    });
  });

export const compileTruthBundleRoot = (
  input: unknown,
  signer: TrustEnvelopeSigner,
): Effect.Effect<
  TruthBundleRootV1,
  TruthDecodeError | TruthIntegrityError | TruthTrustError
> =>
  Effect.gen(function* () {
    yield* assertAcyclicJson(input, "truth.bundle.unsigned");
    const decoded = yield* decodeStrict(
      TruthBundleRootUnsignedV1,
      "truth.bundle.unsigned",
      input,
    );
    yield* validateClosure(decoded.objects, false);
    yield* validateRootPins(decoded);
    yield* validateRootLineage(decoded);
    if (decoded.issuer.key_id !== signer.keyId) {
      return yield* Effect.fail(
        new TruthTrustError({
          boundary: "truth.bundle.issuer",
          reason: "unsigned issuer key does not match signer key",
        }),
      );
    }
    return yield* signCompiledRoot(sortUnsignedRoot(decoded), signer);
  });

export interface VerifyTruthBundleOptions {
  readonly expectedEnvironment: TruthEnvironmentId;
  readonly expectedKeyId: string;
  readonly publicKeyHex: string;
  readonly trustedGenerationHighWater: DecimalUint64;
  readonly now: TruthIsoTimestamp;
}

const validateVerifierBindings = (
  root: TruthBundleRootV1,
  options: VerifyTruthBundleOptions,
): Effect.Effect<void, TruthTrustError> => {
  if (root.unsigned_root.environment !== options.expectedEnvironment) {
    return Effect.fail(
      new TruthTrustError({
        boundary: "truth.bundle.environment",
        reason: "signed root environment does not match verifier environment",
      }),
    );
  }
  if (root.unsigned_root.issuer.key_id !== options.expectedKeyId) {
    return Effect.fail(
      new TruthTrustError({
        boundary: "truth.bundle.issuer",
        reason: "signed root issuer key does not match verifier key",
      }),
    );
  }
  if (
    BigInt(root.unsigned_root.generation) <
    BigInt(options.trustedGenerationHighWater)
  ) {
    return Effect.fail(
        new TruthTrustError({
          boundary: "truth.bundle.generation",
          reason: "signed root generation is a replay",
        }),
      );
  }
  const latestPermitted =
    new Date(options.now).getTime() + TRUTH_MAX_FUTURE_SKEW_MILLISECONDS;
  const premature =
    new Date(root.unsigned_root.issued_at).getTime() > latestPermitted ||
    new Date(root.unsigned_root.valid_from).getTime() > latestPermitted;
  return premature
    ? Effect.fail(
        new TruthTrustError({
          boundary: "truth.bundle.time",
          reason: "signed root is not yet valid for the trusted clock",
        }),
      )
    : Effect.void;
};

const verifyRootCryptography = (
  root: TruthBundleRootV1,
  publicKeyHex: string,
): Effect.Effect<void, TruthIntegrityError | TruthTrustError> =>
  Effect.gen(function* () {
    const canonical = yield* canonicalizeTruthJson(
      root.unsigned_root,
      "truth.bundle.unsigned",
    );
    if (sha256Hex(canonical) !== root.root_hash) {
      return yield* Effect.fail(
        integrityFailure("root hash does not match unsigned root"),
      );
    }
    const valid = verifyTruthRootSignature(
      publicKeyHex,
      root.unsigned_root.environment,
      root.unsigned_root.generation,
      root.root_hash,
      root.signature,
    );
    if (!valid) {
      return yield* Effect.fail(
        new TruthTrustError({
          boundary: "truth.bundle.signature",
          reason: "Ed25519 signature verification failed",
        }),
      );
    }
  });

export const verifyTruthBundleRoot = (
  input: unknown,
  options: VerifyTruthBundleOptions,
): Effect.Effect<
  TruthBundleRootV1,
  TruthDecodeError | TruthIntegrityError | TruthTrustError
> =>
  Effect.gen(function* () {
    yield* assertAcyclicJson(input, "truth.bundle.signed");
    const root = yield* decodeStrict(TruthBundleRootV1, "truth.bundle.signed", input);
    yield* validateClosure(root.unsigned_root.objects, true);
    yield* validateRootPins(root.unsigned_root);
    yield* validateRootLineage(root.unsigned_root);
    yield* validateVerifierBindings(root, options);
    yield* verifyRootCryptography(root, options.publicKeyHex);
    return root;
  });

export const parseTruthBundleRootBytes = (
  bytes: Uint8Array,
): Effect.Effect<unknown, TruthDecodeError> =>
  requireByteLimit(
    "truth.bundle.bytes",
    bytes.byteLength,
    TRUTH_RESOURCE_LIMITS.signedRootBytes,
  ).pipe(
    Effect.flatMap(() =>
      Effect.try({
        try: () => {
          const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
          const parsed: unknown = JSON.parse(source);
          if (jcsCanonicalize(parsed) !== source) {
            throw new Error("signed root bytes are not canonical JSON");
          }
          return parsed;
        },
        catch: () =>
          new TruthDecodeError({
            boundary: "truth.bundle.bytes",
            reason: "signed root is not valid UTF-8 JSON",
          }),
      }),
    ),
  );

export const verifyTruthBundleRootBytes = (
  bytes: Uint8Array,
  options: VerifyTruthBundleOptions,
): Effect.Effect<
  TruthBundleRootV1,
  TruthDecodeError | TruthIntegrityError | TruthTrustError
> =>
  parseTruthBundleRootBytes(bytes).pipe(
    Effect.flatMap((input) => verifyTruthBundleRoot(input, options)),
  );
