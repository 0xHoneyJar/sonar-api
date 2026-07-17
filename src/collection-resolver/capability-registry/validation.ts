import { Effect } from "effect";
import type { NetworkRef } from "../protocol.js";
import { CapabilityRegistryValidationError } from "./errors.js";
import {
  adapterOperationKey,
  isOperationEnabledAndActive,
  networkIdentityKey,
  operationKinds,
} from "./keys.js";
import type {
  CapabilityReasonClass,
  NetworkCapability,
  OperationCapability,
  OperationHealthState,
  OperationKind,
} from "./schemas.js";

const pathFor = (network: NetworkRef, suffix: string): string =>
  `networks[${networkIdentityKey(network)}].${suffix}`;

const expectedEffectsFor = (
  state: OperationHealthState,
  operation: OperationKind,
): OperationCapability["normative_effects"] => {
  switch (state) {
    case "available":
      return {
        new_work: "admit",
        queued_in_flight: "continue",
        existing_evidence: "reuse_if_fresh",
      };
    case "degraded":
      return {
        new_work: operation === "recognize" ? "partial_diagnostics" : "reject",
        queued_in_flight: "follow_drain",
        existing_evidence: "reuse_if_availability_degradation",
      };
    case "disabled":
      return {
        new_work: operation === "recognize" ? "exclude" : "reject",
        queued_in_flight: "finish_or_capability_disabled",
        existing_evidence: "freshness_policy",
      };
  }
};

/**
 * Compatible (state, drain, revocation, effects, reason_class) tuples.
 *
 * available + admitting: finish / none / admit… — never cancel/reject/revoke.
 * degraded: finish|capability_disabled / none|freshness_only — never cancel_and_reject / revoke_integrity.
 * disabled (policy): capability_disabled / freshness_only / freshness_policy evidence.
 * disabled (integrity): cancel_and_reject / revoke_integrity / revoke evidence.
 * kill_switch=true: integrity-strength only for every operation (no freshness/admit/continue mix).
 */
const validateCompatibleTuple = (
  network: NetworkCapability,
  kind: OperationKind,
  operation: OperationCapability,
): Effect.Effect<void, CapabilityRegistryValidationError> => {
  const path = pathFor(network.network, `operations.${kind}`);
  const { state, enabled, drain_policy, prior_evidence_revocation_policy, reason_class } =
    operation;

  if (enabled && state === "disabled") {
    return Effect.fail(
      new CapabilityRegistryValidationError({
        path,
        reason: "enabled=true is incompatible with state=disabled",
      }),
    );
  }

  if (!enabled && state === "available") {
    return Effect.fail(
      new CapabilityRegistryValidationError({
        path,
        reason: "enabled=false is incompatible with state=available",
      }),
    );
  }

  if (!enabled && state === "degraded") {
    return Effect.fail(
      new CapabilityRegistryValidationError({
        path,
        reason: "enabled=false is incompatible with state=degraded",
      }),
    );
  }

  const expected = expectedEffectsFor(state, kind);
  const actual = operation.normative_effects;
  const integrityDisabled =
    state === "disabled" &&
    prior_evidence_revocation_policy === "revoke_integrity" &&
    drain_policy === "cancel_and_reject" &&
    actual.new_work === expected.new_work &&
    actual.queued_in_flight === expected.queued_in_flight &&
    actual.existing_evidence === "revoke";

  if (
    !integrityDisabled &&
    (actual.new_work !== expected.new_work ||
      actual.queued_in_flight !== expected.queued_in_flight ||
      actual.existing_evidence !== expected.existing_evidence)
  ) {
    return Effect.fail(
      new CapabilityRegistryValidationError({
        path: `${path}.normative_effects`,
        reason: `normative_effects do not match state=${state} for ${kind}`,
      }),
    );
  }

  if (state === "available") {
    if (drain_policy !== "finish") {
      return Effect.fail(
        new CapabilityRegistryValidationError({
          path: `${path}.drain_policy`,
          reason: "available operations require drain_policy=finish",
        }),
      );
    }
    if (prior_evidence_revocation_policy !== "none") {
      return Effect.fail(
        new CapabilityRegistryValidationError({
          path: `${path}.prior_evidence_revocation_policy`,
          reason: "available operations require prior_evidence_revocation_policy=none",
        }),
      );
    }
    if (
      actual.new_work !== "admit" ||
      actual.queued_in_flight !== "continue" ||
      actual.existing_evidence !== "reuse_if_fresh"
    ) {
      return Effect.fail(
        new CapabilityRegistryValidationError({
          path: `${path}.normative_effects`,
          reason: "available/admitting operations cannot carry cancel/reject/revoke semantics",
        }),
      );
    }
    const allowedAvailableReasons: ReadonlyArray<CapabilityReasonClass> = [
      "healthy",
      "catalog_update",
      "operator_policy",
      "epoch_reset",
    ];
    if (!allowedAvailableReasons.includes(reason_class)) {
      return Effect.fail(
        new CapabilityRegistryValidationError({
          path: `${path}.reason_class`,
          reason: `available state incompatible with reason_class=${reason_class}`,
        }),
      );
    }
  }

  if (state === "degraded") {
    if (drain_policy === "cancel_and_reject") {
      return Effect.fail(
        new CapabilityRegistryValidationError({
          path: `${path}.drain_policy`,
          reason: "degraded operations cannot use drain_policy=cancel_and_reject",
        }),
      );
    }
    if (drain_policy !== "finish" && drain_policy !== "capability_disabled") {
      return Effect.fail(
        new CapabilityRegistryValidationError({
          path: `${path}.drain_policy`,
          reason: "degraded operations require drain_policy=finish|capability_disabled",
        }),
      );
    }
    if (prior_evidence_revocation_policy === "revoke_integrity") {
      return Effect.fail(
        new CapabilityRegistryValidationError({
          path: `${path}.prior_evidence_revocation_policy`,
          reason: "degraded operations cannot revoke_integrity",
        }),
      );
    }
    if (
      prior_evidence_revocation_policy !== "none" &&
      prior_evidence_revocation_policy !== "freshness_only"
    ) {
      return Effect.fail(
        new CapabilityRegistryValidationError({
          path: `${path}.prior_evidence_revocation_policy`,
          reason: "degraded operations require revocation none|freshness_only",
        }),
      );
    }
    if (
      reason_class !== "availability_degradation" &&
      reason_class !== "operator_policy"
    ) {
      return Effect.fail(
        new CapabilityRegistryValidationError({
          path: `${path}.reason_class`,
          reason: `degraded state incompatible with reason_class=${reason_class}`,
        }),
      );
    }
  }

  if (state === "disabled") {
    if (integrityDisabled) {
      if (reason_class !== "integrity_compromise" && reason_class !== "kill_switch") {
        return Effect.fail(
          new CapabilityRegistryValidationError({
            path: `${path}.reason_class`,
            reason:
              "integrity-disabled operations require reason_class=integrity_compromise|kill_switch",
          }),
        );
      }
    } else {
      if (drain_policy !== "capability_disabled") {
        return Effect.fail(
          new CapabilityRegistryValidationError({
            path: `${path}.drain_policy`,
            reason:
              "non-integrity disabled operations require drain_policy=capability_disabled",
          }),
        );
      }
      if (prior_evidence_revocation_policy !== "freshness_only") {
        return Effect.fail(
          new CapabilityRegistryValidationError({
            path: `${path}.prior_evidence_revocation_policy`,
            reason:
              "non-integrity disabled operations require prior_evidence_revocation_policy=freshness_only",
          }),
        );
      }
      if (actual.existing_evidence !== "freshness_policy") {
        return Effect.fail(
          new CapabilityRegistryValidationError({
            path: `${path}.normative_effects`,
            reason: "non-integrity disabled operations require existing_evidence=freshness_policy",
          }),
        );
      }
      // kill_switch is integrity-strength only — never a freshness/policy disabled reason.
      const allowed: ReadonlyArray<CapabilityReasonClass> = [
        "capability_unsupported",
        "operator_policy",
        "catalog_update",
        "epoch_reset",
      ];
      if (!allowed.includes(reason_class)) {
        return Effect.fail(
          new CapabilityRegistryValidationError({
            path: `${path}.reason_class`,
            reason: `disabled state incompatible with reason_class=${reason_class}`,
          }),
        );
      }
    }
  }

  return Effect.void;
};

const validateOperationShape = (
  network: NetworkCapability,
  kind: OperationKind,
  operation: OperationCapability,
): Effect.Effect<void, CapabilityRegistryValidationError> =>
  validateCompatibleTuple(network, kind, operation);

const validateFinalityFamily = (
  network: NetworkCapability,
): Effect.Effect<void, CapabilityRegistryValidationError> => {
  const ns = network.network.network_namespace;
  const family = network.finality_policy.family;
  if (ns === "eip155" && family !== "evm") {
    return Effect.fail(
      new CapabilityRegistryValidationError({
        path: pathFor(network.network, "finality_policy"),
        reason: "eip155 networks require family=evm finality policy",
      }),
    );
  }
  if (ns === "solana" && family !== "solana") {
    return Effect.fail(
      new CapabilityRegistryValidationError({
        path: pathFor(network.network, "finality_policy"),
        reason: "solana networks require family=solana finality policy",
      }),
    );
  }

  if (family === "evm" && network.finality_policy.freshness.clock !== "block_time") {
    return Effect.fail(
      new CapabilityRegistryValidationError({
        path: pathFor(network.network, "finality_policy.freshness.clock"),
        reason: "EVM freshness permits only clock=block_time",
      }),
    );
  }
  if (family === "solana" && network.finality_policy.freshness.clock !== "slot_time") {
    return Effect.fail(
      new CapabilityRegistryValidationError({
        path: pathFor(network.network, "finality_policy.freshness.clock"),
        reason: "Solana freshness permits only clock=slot_time",
      }),
    );
  }

  // Refuse inheriting ethereum finality version on non-ethereum EVM chains.
  if (
    ns === "eip155" &&
    network.network.network_reference !== "1" &&
    network.finality_policy.policy_version.startsWith("ethereum-")
  ) {
    return Effect.fail(
      new CapabilityRegistryValidationError({
        path: pathFor(network.network, "finality_policy.policy_version"),
        reason:
          "non-Ethereum EVM networks must not inherit ethereum-* finality policy versions",
      }),
    );
  }

  return Effect.void;
};

const validateNetworkInvariants = (
  network: NetworkCapability,
): Effect.Effect<void, CapabilityRegistryValidationError> =>
  Effect.gen(function* () {
    for (const kind of operationKinds) {
      yield* validateOperationShape(network, kind, network.operations[kind]);
    }

    const recognize = network.operations.recognize;
    const prepare = network.operations.prepare;
    const readEvidence = network.operations.read_evidence;

    if (
      !isOperationEnabledAndActive(recognize) &&
      (isOperationEnabledAndActive(prepare) || isOperationEnabledAndActive(readEvidence))
    ) {
      return yield* Effect.fail(
        new CapabilityRegistryValidationError({
          path: pathFor(network.network, "operations"),
          reason:
            "recognize disabled/inactive while prepare or read_evidence is enabled/active",
        }),
      );
    }

    // Kill-switch forces all operations off; index_support must also be false so the
    // row does not claim prepare capacity while prepare is disabled.
    if (!network.kill_switch) {
      if (network.index_support && !prepare.enabled) {
        return yield* Effect.fail(
          new CapabilityRegistryValidationError({
            path: pathFor(network.network, "index_support"),
            reason: "index_support=true requires prepare.enabled=true",
          }),
        );
      }
      if (!network.index_support && prepare.enabled && prepare.state === "available") {
        return yield* Effect.fail(
          new CapabilityRegistryValidationError({
            path: pathFor(network.network, "index_support"),
            reason:
              "index_support=false is incompatible with prepare available; declare prepare disabled or unsupported honestly",
          }),
        );
      }
    } else if (network.index_support) {
      return yield* Effect.fail(
        new CapabilityRegistryValidationError({
          path: pathFor(network.network, "index_support"),
          reason: "kill_switch=true requires index_support=false",
        }),
      );
    }

    if (
      operationKinds.some((kind) => isOperationEnabledAndActive(network.operations[kind])) &&
      !network.finality_policy.policy_version
    ) {
      return yield* Effect.fail(
        new CapabilityRegistryValidationError({
          path: pathFor(network.network, "finality_policy"),
          reason: "enabled operation requires finality_policy.policy_version",
        }),
      );
    }

    if (
      network.finality_policy.family === "evm" &&
      operationKinds.some((kind) => isOperationEnabledAndActive(network.operations[kind]))
    ) {
      if (
        network.finality_policy.confirmation.kind === "block_depth" &&
        network.finality_policy.confirmation.min_depth === 0
      ) {
        return yield* Effect.fail(
          new CapabilityRegistryValidationError({
            path: pathFor(network.network, "finality_policy.confirmation.min_depth"),
            reason: "active EVM capability requires a positive block confirmation depth",
          }),
        );
      }
      if (network.finality_policy.reorg.invalidation_depth === 0) {
        return yield* Effect.fail(
          new CapabilityRegistryValidationError({
            path: pathFor(network.network, "finality_policy.reorg.invalidation_depth"),
            reason: "active EVM capability requires a positive reorg invalidation depth",
          }),
        );
      }
    }

    if (network.kill_switch) {
      for (const kind of operationKinds) {
        const op = network.operations[kind];
        const killPath = pathFor(network.network, `kill_switch.operations.${kind}`);
        if (op.enabled || op.state !== "disabled") {
          return yield* Effect.fail(
            new CapabilityRegistryValidationError({
              path: killPath,
              reason:
                "kill_switch=true requires every operation enabled=false and state=disabled",
            }),
          );
        }
        if (op.drain_policy !== "cancel_and_reject") {
          return yield* Effect.fail(
            new CapabilityRegistryValidationError({
              path: killPath,
              reason:
                "kill_switch=true requires integrity-strength drain_policy=cancel_and_reject (freshness-only / complete-existing-work refused)",
            }),
          );
        }
        if (op.prior_evidence_revocation_policy !== "revoke_integrity") {
          return yield* Effect.fail(
            new CapabilityRegistryValidationError({
              path: killPath,
              reason:
                "kill_switch=true requires prior_evidence_revocation_policy=revoke_integrity (freshness_only / retained evidence refused)",
            }),
          );
        }
        if (op.normative_effects.existing_evidence !== "revoke") {
          return yield* Effect.fail(
            new CapabilityRegistryValidationError({
              path: killPath,
              reason:
                "kill_switch=true requires existing_evidence=revoke (retained / freshness evidence refused)",
            }),
          );
        }
        if (
          op.normative_effects.new_work === "admit" ||
          op.normative_effects.queued_in_flight === "continue"
        ) {
          return yield* Effect.fail(
            new CapabilityRegistryValidationError({
              path: killPath,
              reason: "kill_switch=true refuses admit/continue operation tuples",
            }),
          );
        }
        if (
          op.reason_class !== "kill_switch" &&
          op.reason_class !== "integrity_compromise"
        ) {
          return yield* Effect.fail(
            new CapabilityRegistryValidationError({
              path: killPath,
              reason:
                "kill_switch=true requires reason_class=kill_switch|integrity_compromise",
            }),
          );
        }
      }
    }

    if (
      network.probe_adapter.adapter_id === "evm_rpc" &&
      network.network.network_namespace !== "eip155"
    ) {
      return yield* Effect.fail(
        new CapabilityRegistryValidationError({
          path: pathFor(network.network, "probe_adapter"),
          reason: "evm_rpc adapter requires eip155 network",
        }),
      );
    }
    if (
      network.probe_adapter.adapter_id === "solana_das" &&
      network.network.network_namespace !== "solana"
    ) {
      return yield* Effect.fail(
        new CapabilityRegistryValidationError({
          path: pathFor(network.network, "probe_adapter"),
          reason: "solana_das adapter requires solana network",
        }),
      );
    }

    yield* validateFinalityFamily(network);

    const forbidden = [
      "rpc_url",
      "rpcUrl",
      "endpoint",
      "endpoints",
      "chain_definition",
      "adapter_config",
      "credentials",
      "api_key",
      "apiKey",
    ] as const;
    for (const key of forbidden) {
      if (Object.prototype.hasOwnProperty.call(network, key)) {
        return yield* Effect.fail(
          new CapabilityRegistryValidationError({
            path: pathFor(network.network, key),
            reason: `forbidden registry field refused: ${key}`,
          }),
        );
      }
    }
  });

export const validateNetworkSet = (
  networks: ReadonlyArray<NetworkCapability>,
): Effect.Effect<void, CapabilityRegistryValidationError> =>
  Effect.gen(function* () {
    const seenNetworks = new Set<string>();
    const seenAdapterOps = new Set<string>();

    for (const network of networks) {
      const netKey = networkIdentityKey(network.network);
      if (seenNetworks.has(netKey)) {
        return yield* Effect.fail(
          new CapabilityRegistryValidationError({
            path: `networks[${netKey}]`,
            reason: "duplicate network identity",
          }),
        );
      }
      seenNetworks.add(netKey);

      for (const kind of operationKinds) {
        const opKey = adapterOperationKey(
          network.network,
          network.probe_adapter.adapter_id,
          kind,
        );
        if (seenAdapterOps.has(opKey)) {
          return yield* Effect.fail(
            new CapabilityRegistryValidationError({
              path: `networks[${netKey}].operations.${kind}`,
              reason: "duplicate adapter-operation identity",
            }),
          );
        }
        seenAdapterOps.add(opKey);

      }

      yield* validateNetworkInvariants(network);
    }
  });
