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
  TRUTH_HIGH_RISK_RECONCILIATION_CLASSES,
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

const validateServingPolicy = (
  value: Extract<TruthNormativeObject, { readonly kind: "serving_policy" }>,
): Effect.Effect<void, TruthIntegrityError> => {
  if (!exactSet(value.rules.map((rule) => rule.failure_class), TRUTH_SERVING_FAILURE_CLASSES)) {
    return Effect.fail(semanticFailure("serving failure matrix is not total"));
  }
  const expected = (
    failureClass: (typeof TRUTH_SERVING_FAILURE_CLASSES)[number],
  ) => {
    const maximum = value.environment === "production" ? "900" : "1800";
    switch (failureClass) {
      case "temporary_source_transport_loss":
        return [
          "DEGRADED",
          "SAME_VERSION_WITHIN_TTL",
          maximum,
          "0",
          "degraded/stale timestamp",
          "fresh-source-and-readiness-evidence",
        ] as const;
      case "stale_projection_or_evidence":
        return [
          "EXPIRED",
          "SAME_VERSION_ONE_EXTRA_TTL",
          maximum,
          "0",
          "stale",
          "fresh-reconciliation-and-serving-observation",
        ] as const;
      case "source_cursor_not_advancing":
        return [
          "UNKNOWN",
          "PRIOR_PROJECTION_ONLY",
          maximum,
          "120",
          "delayed/unknown",
          "independent-head-cursor-and-coverage-proof",
        ] as const;
      case "reorg_behind_watermark":
        return [
          "NOT_READY",
          "FORBIDDEN",
          "0",
          "0",
          "temporarily unavailable",
          "replacement-watermark-and-all-dependent-receipts",
        ] as const;
      case "reconciliation_count_breach":
        return [
          "NOT_READY",
          "PRIOR_GENERATION_ONLY",
          "0",
          "0",
          "update held",
          "completed-census-pass",
        ] as const;
      default:
        return [
          "SUSPENDED",
          "FORBIDDEN",
          "0",
          "0",
          failureClass === "incompatible_producer_consumer"
            ? "update required"
            : "unavailable",
          failureClass === "semantic_provenance_mismatch"
            ? "corrected-bundle-and-new-score-receipt"
            : failureClass === "identity_revoked_or_contested"
              ? "identity-readmission-and-new-evidence"
              : failureClass === "signer_root_compromise"
                ? "recovered-root-and-fresh-evidence"
                : "compatible-build-and-receipt",
        ] as const;
    }
  };
  const invalid = value.rules.some((rule) => {
    const [status, lastGood, maximum, escalation, userLabel, recoveryEvidence] =
      expected(rule.failure_class);
    return (
      rule.effective_status !== status ||
      rule.last_good_policy !== lastGood ||
      String(rule.maximum_last_good_seconds) !== maximum ||
      String(rule.escalation_seconds) !== escalation ||
      rule.user_label !== userLabel ||
      rule.recovery_evidence.length !== 1 ||
      rule.recovery_evidence[0] !== recoveryEvidence ||
      rule.last_good_allowed !== (lastGood !== "FORBIDDEN") ||
      rule.graduation_eligible !== false
    );
  });
  return invalid
    ? Effect.fail(semanticFailure("serving failure rule weakens frozen policy"))
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

const hasSimultaneousIndependentQuorum = (
  providers: ReadonlyArray<Provider>,
  quorum: number,
  requireDistinctAsn: boolean,
  requireDistinctClient: boolean,
): boolean => {
  const choose = (start: number, selected: Array<Provider>): boolean => {
    if (selected.length === quorum) {
      const distinct = (field: (provider: Provider) => string): boolean =>
        new Set(selected.map(field)).size === quorum;
      return (
        distinct((provider) => String(provider.operator)) &&
        distinct((provider) => String(provider.control_domain)) &&
        (!requireDistinctAsn || distinct((provider) => String(provider.asn))) &&
        (!requireDistinctClient ||
          distinct((provider) => String(provider.client_family)))
      );
    }
    for (let index = start; index < providers.length; index += 1) {
      if (choose(index + 1, [...selected, providers[index]!])) return true;
    }
    return false;
  };
  return quorum > 0 && choose(0, []);
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
    const providerIds = network.providers.map((provider) => String(provider.provider_id));
    const providerKeyIds = network.providers.map((provider) => String(provider.key_id));
    const providerPublicKeys = network.providers.map((provider) =>
      String(provider.public_key_hex),
    );
    const operators = network.providers.map((provider) => String(provider.operator));
    const controlDomains = network.providers.map((provider) =>
      String(provider.control_domain),
    );
    const asns = network.providers.map((provider) => String(provider.asn));
    const clients = network.providers.map((provider) => String(provider.client_family));
    const methodInvalid =
      network.finality_method === "FINALIZED_TAG"
        ? network.finalized_tag !== "finalized" || network.minimum_block_depth !== null
        : network.finalized_tag !== null || network.minimum_block_depth === null;
    return (
      quorum === 0n ||
      quorum > BigInt(network.providers.length) ||
      quorum > BigInt(maximumIndependentProviderSet(network.providers)) ||
      !hasSimultaneousIndependentQuorum(
        network.providers,
        Number(quorum),
        network.require_distinct_asn,
        network.require_distinct_client_family,
      ) ||
      new Set(providerIds).size !== providerIds.length ||
      new Set(providerKeyIds).size !== providerKeyIds.length ||
      new Set(providerPublicKeys).size !== providerPublicKeys.length ||
      new Set(operators).size < Number(quorum) ||
      new Set(controlDomains).size < Number(quorum) ||
      (network.require_distinct_asn && new Set(asns).size < Number(quorum)) ||
      (network.require_distinct_client_family &&
        new Set(clients).size < Number(quorum)) ||
      methodInvalid
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
        new Date(profile.evidence_window_start).getTime() ||
      (profile.effective_until !== null &&
        new Date(profile.effective_until).getTime() <=
          new Date(profile.effective_from).getTime()),
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
  const invalidBinding = value.bindings.some((binding) => {
    const hasImplementation =
      binding.implementation_address !== null &&
      binding.implementation_code_hash !== null;
    const proxyComplete =
      (binding.proxy_kind === "NONE" &&
        binding.implementation_address === null &&
          binding.implementation_code_hash === null &&
        binding.upgrade_mechanism === "IMMUTABLE") ||
      (binding.proxy_kind === "MINIMAL" &&
        hasImplementation &&
        binding.upgrade_mechanism === "IMMUTABLE") ||
      (binding.proxy_kind === "EIP1967" &&
        hasImplementation &&
        binding.upgrade_mechanism === "ADMIN") ||
      (binding.proxy_kind === "BEACON" &&
        hasImplementation &&
        binding.upgrade_mechanism === "BEACON");
    const validity =
      binding.valid_until === null ||
      new Date(binding.valid_until).getTime() > new Date(binding.valid_from).getTime();
    const contestCoherent =
      binding.contest_state === "CLEAR"
        ? binding.effective_status._tag !== "SUSPENDED"
        : binding.effective_status._tag !== "READY";
    return !proxyComplete || !validity || !contestCoherent;
  });
  const invalid =
    new Set(collectionIds).size !== collectionIds.length ||
    new Set(deployedIdentities).size !== deployedIdentities.length ||
    new Set(aliases).size !== aliases.length ||
    aliases.some((alias) => canonicalIds.has(alias)) ||
    invalidBinding;
  return invalid
    ? Effect.fail(semanticFailure("identity snapshot contains conflicting bindings"))
    : Effect.void;
};

const validateEventVocabulary = (
  value: Extract<TruthNormativeObject, { readonly kind: "event_vocabulary" }>,
): Effect.Effect<void, TruthIntegrityError> => {
  const eventKinds = value.events.map((event) => String(event.event_kind));
  const denominatorKeys = value.denominator_members.map((member) =>
    [
      member.canonical_collection_id,
      member.chain_id,
      member.canonical_address,
      member.event_signature,
    ].join("\0"),
  );
  const invalidLegs = value.events.some((event) => {
    const kinds = event.semantic_legs.map((leg) => String(leg.leg_kind));
    const precedence = event.semantic_legs.map((leg) => String(leg.precedence));
    return (
      new Set(kinds).size !== kinds.length ||
      new Set(precedence).size !== precedence.length ||
      event.semantic_legs.some((leg) => !leg.denominator_member)
    );
  });
  return new Set(eventKinds).size !== eventKinds.length ||
    new Set(denominatorKeys).size !== denominatorKeys.length ||
    invalidLegs
    ? Effect.fail(
        semanticFailure("event vocabulary or closed denominator is ambiguous"),
      )
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
      return validateEventVocabulary(value);
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
    case "statistical_policy":
      return exactSet(
        value.high_risk_classes,
        TRUTH_HIGH_RISK_RECONCILIATION_CLASSES,
      )
        ? Effect.void
        : Effect.fail(semanticFailure("statistical high-risk classes are not total"));
    case "serving_policy":
      return validateServingPolicy(value);
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

const validateProducerObjectAgreement = (
  compiled: ReadonlyArray<CompiledNormativeObjectV1>,
): Effect.Effect<void, TruthIntegrityError> => {
  const identity = compiled.find((object) => object.value.kind === "identity_snapshot");
  const events = compiled.find((object) => object.value.kind === "event_vocabulary");
  const networks = compiled.find(
    (object) => object.value.kind === "network_finality_policy",
  );
  const activities = compiled.find(
    (object) => object.value.kind === "activity_profiles",
  );
  if (
    identity?.value.kind !== "identity_snapshot" ||
    events?.value.kind !== "event_vocabulary" ||
    networks?.value.kind !== "network_finality_policy" ||
    activities?.value.kind !== "activity_profiles"
  ) {
    return Effect.fail(closureFailure("producer closure object is missing"));
  }
  const bindings = new Map(
    identity.value.bindings.map((binding) => [
      String(binding.canonical_collection_id),
      binding,
    ]),
  );
  const members = new Map(
    events.value.denominator_members.map((member) => [
      String(member.canonical_collection_id),
      member,
    ]),
  );
  const profiles = new Map(
    activities.value.profiles.map((profile) => [
      String(profile.collection_id),
      profile,
    ]),
  );
  const networkPolicies = networks.value.networks;
  const ids = [...bindings.keys()];
  const exactCollections =
    exactSet([...members.keys()], ids) && exactSet([...profiles.keys()], ids);
  const mismatchedIdentity = ids.some((id) => {
    const binding = bindings.get(id)!;
    const member = members.get(id);
    return (
      member === undefined ||
      String(member.chain_id) !== String(binding.chain_id) ||
      member.canonical_address !== binding.canonical_address ||
      !networkPolicies.some(
        (network) => String(network.chain_id) === String(binding.chain_id),
      )
    );
  });
  return exactCollections && !mismatchedIdentity
    ? Effect.void
    : Effect.fail(
        closureFailure(
          "identity, denominator, network, and activity closure do not agree",
        ),
      );
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
    yield* validateProducerObjectAgreement(compiled);
    return sortCompiledClosure(compiled);
  });
