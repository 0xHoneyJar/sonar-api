import { Effect } from "effect";

import { assertAcyclicJson, canonicalizeTruthJson } from "./canonical.js";
import { TruthDecodeError, TruthIntegrityError } from "./errors.js";
import {
  TRUTH_RESOURCE_LIMITS,
  TruthObjectRef,
  decodeStrict,
} from "./schemas/common.js";
import {
  TRUTH_NORMATIVE_OBJECT_KINDS,
} from "./schemas/bundle.js";
import {
  TRUTH_AUTHORITY_ACTIONS,
  TRUTH_COMPATIBILITY_CHANGE_KINDS,
  TRUTH_SERVING_FAILURE_CLASSES,
  TruthNormativeObjectV1,
  type TruthNormativeObjectV1 as TruthNormativeObject,
} from "./schemas/normative.js";
import { sha256Hex } from "../collection-resolver/trust-protocol.js";

const encoder = new TextEncoder();
const semanticFailure = (reason: string): TruthIntegrityError =>
  new TruthIntegrityError({ boundary: "truth.normative-object", reason });
const closureFailure = (reason: string): TruthIntegrityError =>
  new TruthIntegrityError({ boundary: "truth.normative-closure", reason });

const exactSet = (
  actual: ReadonlyArray<string>,
  expected: ReadonlyArray<string>,
): boolean =>
  actual.length === expected.length &&
  new Set(actual).size === actual.length &&
  expected.every((value) => actual.includes(value));

const requireUnique = (
  values: ReadonlyArray<string>,
  reason: string,
): Effect.Effect<void, TruthIntegrityError> =>
  new Set(values).size === values.length
    ? Effect.void
    : Effect.fail(semanticFailure(reason));

const validateCompatibility = (
  value: Extract<TruthNormativeObject, { readonly kind: "compatibility_matrix" }>,
): Effect.Effect<void, TruthIntegrityError> => {
  if (!exactSet(value.rules.map((rule) => rule.change_kind), TRUTH_COMPATIBILITY_CHANGE_KINDS)) {
    return Effect.fail(semanticFailure("compatibility matrix is not total"));
  }
  const invalid = value.rules.some((rule) => {
    const additive =
      rule.change_kind === "OPTIONAL_FIELD_ADDED" ||
      rule.change_kind === "EVENT_KIND_ADDED";
    return additive
      ? rule.result !== "CONDITIONAL" || !rule.consumer_support_required
      : rule.result !== "BREAKING" || rule.consumer_support_required;
  });
  return invalid
    ? Effect.fail(semanticFailure("compatibility outcome contradicts v1 policy"))
    : Effect.void;
};

type Provider = Extract<
  TruthNormativeObject,
  { readonly kind: "network_finality_policy" }
>["networks"][number]["providers"][number];

const maximumIndependentProviderSet = (
  providers: ReadonlyArray<Provider>,
): number => {
  const domainsByOperator = new Map<string, Set<string>>();
  for (const provider of providers) {
    const domains = domainsByOperator.get(provider.operator) ?? new Set<string>();
    domains.add(provider.control_domain);
    domainsByOperator.set(provider.operator, domains);
  }
  const operatorByDomain = new Map<string, string>();
  const augment = (operator: string, seen: Set<string>): boolean => {
    for (const domain of domainsByOperator.get(operator) ?? []) {
      if (seen.has(domain)) continue;
      seen.add(domain);
      const incumbent = operatorByDomain.get(domain);
      if (incumbent === undefined || augment(incumbent, seen)) {
        operatorByDomain.set(domain, operator);
        return true;
      }
    }
    return false;
  };
  let matched = 0;
  for (const operator of domainsByOperator.keys()) {
    if (augment(operator, new Set())) matched += 1;
  }
  return matched;
};

const validateNetworkPolicy = (
  value: Extract<TruthNormativeObject, { readonly kind: "network_finality_policy" }>,
): Effect.Effect<void, TruthIntegrityError> => {
  const networks = value.networks.map((network) => String(network.network));
  const chainIds = value.networks.map((network) => String(network.chain_id));
  if (
    new Set(networks).size !== networks.length ||
    new Set(chainIds).size !== chainIds.length
  ) {
    return Effect.fail(semanticFailure("duplicate network or chain id"));
  }
  const invalidQuorum = value.networks.some((network) => {
    const quorum = BigInt(network.required_provider_quorum);
    return (
      quorum === 0n ||
      quorum > BigInt(network.providers.length) ||
      quorum > BigInt(maximumIndependentProviderSet(network.providers))
    );
  });
  return invalidQuorum
    ? Effect.fail(semanticFailure("provider quorum is not independently satisfiable"))
    : Effect.void;
};

const validateActivityProfiles = (
  value: Extract<TruthNormativeObject, { readonly kind: "activity_profiles" }>,
): Effect.Effect<void, TruthIntegrityError> => {
  const ids = value.profiles.map((profile) => String(profile.collection_id));
  const invalidWindow = value.profiles.some(
    (profile) =>
      new Date(profile.evidence_window_end).getTime() <=
      new Date(profile.evidence_window_start).getTime(),
  );
  return new Set(ids).size !== ids.length || invalidWindow
    ? Effect.fail(
        semanticFailure("activity profile identity or evidence window is invalid"),
      )
    : Effect.void;
};

const validateIdentitySnapshot = (
  value: Extract<TruthNormativeObject, { readonly kind: "identity_snapshot" }>,
): Effect.Effect<void, TruthIntegrityError> => {
  const collectionIds = value.bindings.map((binding) =>
    String(binding.canonical_collection_id),
  );
  const deployedIdentities = value.bindings.map((binding) =>
    [binding.chain_family, binding.chain_id, binding.canonical_address].join("\0"),
  );
  const aliases = value.bindings.flatMap((binding) => binding.aliases.map(String));
  const canonicalIds = new Set(collectionIds);
  const invalid =
    new Set(collectionIds).size !== collectionIds.length ||
    new Set(deployedIdentities).size !== deployedIdentities.length ||
    new Set(aliases).size !== aliases.length ||
    aliases.some((alias) => canonicalIds.has(alias));
  return invalid
    ? Effect.fail(semanticFailure("identity snapshot contains conflicting bindings"))
    : Effect.void;
};

const validateObjectSemantics = (
  value: TruthNormativeObject,
): Effect.Effect<void, TruthIntegrityError> => {
  // Strict schemas prove shape; these checks prove each signed policy is total and coherent.
  switch (value.kind) {
    case "identity_snapshot":
      return validateIdentitySnapshot(value);
    case "event_vocabulary":
      return requireUnique(
        value.events.map((event) => String(event.event_kind)),
        "duplicate event vocabulary kind",
      );
    case "provenance_rules":
      return requireUnique(
        value.requirements.map((rule) => String(rule.event_kind)),
        "duplicate provenance event kind",
      );
    case "behavioral_invariants":
      return requireUnique(
        value.invariants.map((invariant) => String(invariant.invariant_id)),
        "duplicate behavioral invariant",
      );
    case "compatibility_matrix":
      return validateCompatibility(value);
    case "authority_matrix":
      return exactSet(value.grants.map((grant) => grant.action), TRUTH_AUTHORITY_ACTIONS)
        ? Effect.void
        : Effect.fail(semanticFailure("authority matrix is not total"));
    case "network_finality_policy":
      return validateNetworkPolicy(value);
    case "activity_profiles":
      return validateActivityProfiles(value);
    case "serving_policy":
      return exactSet(
        value.rules.map((rule) => rule.failure_class),
        TRUTH_SERVING_FAILURE_CLASSES,
      )
        ? Effect.void
        : Effect.fail(semanticFailure("serving failure matrix is not total"));
    default:
      return Effect.void;
  }
};

export interface CompiledNormativeObjectV1 {
  readonly value: TruthNormativeObject;
  readonly canonicalBytes: Uint8Array;
  readonly ref: TruthObjectRef;
}

const validateClosureShape = (
  compiled: ReadonlyArray<CompiledNormativeObjectV1>,
): Effect.Effect<void, TruthIntegrityError> => {
  const kinds = compiled.map((object) => String(object.ref.kind));
  const missing = TRUTH_NORMATIVE_OBJECT_KINDS.filter((kind) => !kinds.includes(kind));
  const unknown = kinds.filter(
    (kind) => !(TRUTH_NORMATIVE_OBJECT_KINDS as ReadonlyArray<string>).includes(kind),
  );
  if (new Set(kinds).size !== kinds.length) {
    return Effect.fail(closureFailure("duplicate normative object kind"));
  }
  if (missing.length > 0 || unknown.length > 0) {
    return Effect.fail(
      closureFailure(
        `closure mismatch; missing=${missing.join(",")}; unknown=${unknown.join(",")}`,
      ),
    );
  }
  const totalBytes = compiled.reduce(
    (total, object) => total + object.canonicalBytes.byteLength,
    0,
  );
  return totalBytes > TRUTH_RESOURCE_LIMITS.totalClosureBytes
    ? Effect.fail(closureFailure("normative object closure exceeds byte limit"))
    : Effect.void;
};

const validateEventProvenanceAgreement = (
  compiled: ReadonlyArray<CompiledNormativeObjectV1>,
): Effect.Effect<void, TruthIntegrityError> => {
  const events = compiled.find((object) => object.value.kind === "event_vocabulary");
  const provenance = compiled.find((object) => object.value.kind === "provenance_rules");
  if (
    events?.value.kind !== "event_vocabulary" ||
    provenance?.value.kind !== "provenance_rules"
  ) {
    return Effect.fail(closureFailure("event or provenance object is missing"));
  }
  const eventRequirements = new Map(
    events.value.events.map((event) => [
      String(event.event_kind),
      [...event.required_provenance].map(String).sort().join("\0"),
    ]),
  );
  const provenanceRequirements = new Map(
    provenance.value.requirements.map((rule) => [
      String(rule.event_kind),
      [...rule.required_fields].map(String).sort().join("\0"),
    ]),
  );
  const mismatched =
    !exactSet([...eventRequirements.keys()], [...provenanceRequirements.keys()]) ||
    [...eventRequirements].some(
      ([kind, fields]) => provenanceRequirements.get(kind) !== fields,
    );
  return mismatched
    ? Effect.fail(closureFailure("event vocabulary and provenance rules do not agree"))
    : Effect.void;
};

const sortCompiledClosure = (
  compiled: ReadonlyArray<CompiledNormativeObjectV1>,
): ReadonlyArray<CompiledNormativeObjectV1> =>
  [...compiled].sort((left, right) => {
    const leftKind = String(left.ref.kind);
    const rightKind = String(right.ref.kind);
    return leftKind < rightKind ? -1 : leftKind > rightKind ? 1 : 0;
  });

export const compileNormativeObject = (
  input: unknown,
): Effect.Effect<
  CompiledNormativeObjectV1,
  TruthDecodeError | TruthIntegrityError
> =>
  Effect.gen(function* () {
    yield* assertAcyclicJson(input, "truth.normative-object");
    const value = yield* decodeStrict(
      TruthNormativeObjectV1,
      "truth.normative-object",
      input,
    );
    yield* validateObjectSemantics(value);
    const canonical = yield* canonicalizeTruthJson(value, "truth.normative-object");
    const canonicalBytes = encoder.encode(canonical);
    if (canonicalBytes.byteLength > TRUTH_RESOURCE_LIMITS.objectBytes) {
      return yield* Effect.fail(
        new TruthIntegrityError({
          boundary: "truth.normative-object",
          reason: "normative object exceeds byte limit",
        }),
      );
    }
    const ref = yield* decodeStrict(TruthObjectRef, "truth.normative-object.ref", {
      kind: value.kind,
      media_type: "application/json",
      sha256: sha256Hex(canonicalBytes),
      byte_length: String(canonicalBytes.byteLength),
    });
    return { value, canonicalBytes, ref };
  });

export const compileNormativeClosure = (
  inputs: ReadonlyArray<unknown>,
): Effect.Effect<
  ReadonlyArray<CompiledNormativeObjectV1>,
  TruthDecodeError | TruthIntegrityError
> =>
  Effect.gen(function* () {
    const compiled: Array<CompiledNormativeObjectV1> = [];
    for (const input of inputs) compiled.push(yield* compileNormativeObject(input));
    yield* validateClosureShape(compiled);
    yield* validateEventProvenanceAgreement(compiled);
    return sortCompiledClosure(compiled);
  });
