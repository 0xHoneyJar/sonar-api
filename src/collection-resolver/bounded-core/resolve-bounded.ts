/**
 * CR-102 bounded resolver orchestration core.
 *
 * Pure, deterministic fanout over a strict CR-101 capability snapshot.
 * No user RPC/chain defs. Late adapters cannot mutate/cache after seal.
 *
 * Controlling tasks never directly await unbounded adapter promises — each
 * settlement is raced against per-network and global deadline timers.
 */
import { Effect, Schema } from "effect";
import type { ParseOptions } from "effect/SchemaAST";
import {
  buildCandidateFromHit,
  type ProbeHitEvidence,
  type ProbeOutcome,
  sortNetworkRefs,
} from "../candidate.js";
import {
  selectDefaultRecognizeNetworks,
  type DefaultSearchHit,
} from "../capability-registry/search.js";
import {
  isOperationEnabledAndHealthy,
  networkIdentityKey,
} from "../capability-registry/keys.js";
import type { NetworkCapability } from "../capability-registry/schemas.js";
import type { CapabilityRegistrySnapshot } from "../capability-registry/snapshot.js";
import { cloneFreeze } from "../capability-registry/immutable.js";
import type { RecognizeCapability } from "../identifier.js";
import {
  CapabilityRegistryVersion,
  decodeCollectionCandidate,
  type CollectionCandidate,
  type CollectionIdentifier,
  type NetworkRef,
} from "../protocol.js";
import { aggregateAndRank } from "./aggregate.js";
import {
  digestNegativeBinding,
  digestPositiveBinding,
  digestReadinessBinding,
  sha256Canonical,
  structuralIdentifierDigest,
} from "./caching/keys.js";
import { decodeBoundedResolverConfig } from "./config.js";
import {
  armDeadlineRace,
  classifyDeadlineBreach,
  createDeadlineController,
  linkAbort,
  isPastDeadline,
  raceSettlementAgainstDeadlines,
  raceSharedAgainstDeadline,
  type DeadlineKind,
} from "./deadlines.js";
import {
  NoHealthyCapabilityError,
  ResolverRateLimitedError,
  BoundedResolverDecodeError,
  StructuralPreflightError,
  type BoundedResolverError,
} from "./errors.js";
import type {
  BoundedResolverDeps,
  CoalesceSealedResult,
  InventoryEnrichmentHit,
  InventoryEnrichmentResult,
} from "./ports.js";
import { structuralPreflight } from "./preflight.js";
import { redactSafeMessage, safeErrorLabel } from "./redaction.js";
import {
  BoundedResolveRequest,
  BoundedResolveDiagnostics as BoundedResolveDiagnosticsSchema,
  PositiveCacheBinding,
  ReadinessCacheBinding,
  SafeDiagnosticEntry,
  type BoundedResolveDiagnostics,
  type BoundedResolveRequest as BoundedResolveRequestType,
  type BoundedResolverConfig,
  type NegativeCacheBinding,
  type SafeDiagnosticEntry as SafeDiagnosticEntryType,
} from "./schemas.js";

const strictOptions: ParseOptions = {
  errors: "all",
  onExcessProperty: "error",
};

const decodeRequest = Schema.decodeUnknown(BoundedResolveRequest, strictOptions);
const decodePositiveBinding = Schema.decodeUnknown(PositiveCacheBinding, strictOptions);
const decodeReadinessBinding = Schema.decodeUnknown(ReadinessCacheBinding, strictOptions);
const decodeSafeDiagnostic = Schema.decodeUnknown(SafeDiagnosticEntry, strictOptions);
const CoalescedResponseEnvelope = Schema.Struct({
  schema_version: Schema.Literal(1),
  capability_snapshot_version: CapabilityRegistryVersion,
  candidates: Schema.Array(Schema.Unknown),
  diagnostics: BoundedResolveDiagnosticsSchema,
  ranking_evidence: Schema.Array(
    Schema.Struct({
      deployment_key: Schema.String.pipe(Schema.minLength(1)),
      score: Schema.Number.pipe(
        Schema.filter((value) => Number.isFinite(value) || "score must be finite"),
      ),
      evidence_quality: Schema.Literal("high", "medium", "low"),
      ranking_reasons: Schema.Array(Schema.String),
    }),
  ),
});
const decodeCoalescedEnvelope = Schema.decodeUnknown(
  CoalescedResponseEnvelope,
  strictOptions,
);

const decodeCoalescedResponse = (
  value: unknown,
  expectedVersion: CapabilityRegistrySnapshot["version"],
): Effect.Effect<BoundedResolveResponse, BoundedResolverDecodeError> =>
  Effect.gen(function* () {
    const envelope = yield* decodeCoalescedEnvelope(value).pipe(
      Effect.mapError(
        (cause) =>
          new BoundedResolverDecodeError({
            reason: "coalesced leader response failed strict envelope decode",
            safe_cause: safeErrorLabel(cause),
            cause_digest: sha256Canonical(safeErrorLabel(cause)),
          }),
      ),
    );
    if (
      envelope.capability_snapshot_version.registry_epoch !==
        expectedVersion.registry_epoch ||
      envelope.capability_snapshot_version.registry_sequence !==
        expectedVersion.registry_sequence
    ) {
      return yield* Effect.fail(
        new BoundedResolverDecodeError({
          reason: "coalesced leader response capability snapshot mismatch",
          safe_cause: "snapshot_mismatch",
          cause_digest: sha256Canonical("snapshot_mismatch"),
        }),
      );
    }
    const candidates = yield* Effect.forEach(envelope.candidates, (candidate) =>
      decodeCollectionCandidate(candidate).pipe(
        Effect.mapError(
          (cause) =>
            new BoundedResolverDecodeError({
              reason: "coalesced leader candidate failed strict decode",
              safe_cause: safeErrorLabel(cause),
              cause_digest: sha256Canonical(safeErrorLabel(cause)),
            }),
        ),
      ),
    );
    return cloneFreeze({ ...envelope, candidates });
  });

export interface BoundedResolveResponse {
  readonly schema_version: 1;
  readonly capability_snapshot_version: CapabilityRegistrySnapshot["version"];
  readonly candidates: ReadonlyArray<CollectionCandidate>;
  readonly diagnostics: BoundedResolveDiagnostics;
  readonly ranking_evidence: ReadonlyArray<{
    readonly deployment_key: string;
    readonly score: number;
    readonly evidence_quality: "high" | "medium" | "low";
    readonly ranking_reasons: ReadonlyArray<string>;
  }>;
}

export type BoundedResolveFailure =
  | BoundedResolverError
  | StructuralPreflightError
  | NoHealthyCapabilityError
  | ResolverRateLimitedError
  | BoundedResolverDecodeError;

const toRecognizeCapability = (network: NetworkCapability): RecognizeCapability => {
  const recognize = network.operations.recognize;
  return {
    network: network.network,
    display_name: network.display.display_name,
    environment: "mainnet",
    probe_adapter: network.probe_adapter.adapter_id,
    recognize: recognize.enabled && recognize.state === "available",
    index: network.index_support && isOperationEnabledAndHealthy(network.operations.prepare),
    supported_standards: [...network.supported_standards],
    finality_policy_version: network.finality_policy.policy_version,
    health: "available",
  };
};

const pushUnique = (list: NetworkRef[], network: NetworkRef): void => {
  const key = networkIdentityKey(network);
  if (!list.some((n) => networkIdentityKey(n) === key)) {
    list.push(network);
  }
};

const selectBoundedTargets = (
  snapshot: CapabilityRegistrySnapshot,
  identifier: CollectionIdentifier,
  maxNetworks: number,
): ReadonlyArray<DefaultSearchHit> => {
  const hits = selectDefaultRecognizeNetworks(snapshot, identifier);
  return hits.slice(0, maxNetworks);
};

interface FanoutResult {
  readonly hits: Array<{
    readonly network: NetworkCapability;
    readonly outcome: Extract<ProbeOutcome, { kind: "hit" }>;
  }>;
  /** Networks that returned a conclusive miss / unsupported (authoritative negative). */
  readonly conclusive_misses: NetworkRef[];
  readonly timed_out: NetworkRef[];
  readonly unavailable: NetworkRef[];
  readonly cancelled: NetworkRef[];
  readonly circuit_open: NetworkRef[];
  readonly searched: NetworkRef[];
  readonly sealed: boolean;
  readonly global_deadline_exceeded: boolean;
  /** Declared healthy coverage keys that were never successfully concluded. */
  readonly unsearched_or_uncertain: ReadonlyArray<string>;
}

const TIMEOUT_OUTCOME: ProbeOutcome = { kind: "timeout" };

/**
 * Bounded parallel fanout with concurrency ceiling, per-network + global
 * deadline races, abort propagation, and late-result suppression after seal.
 *
 * Does NOT cancel the caller's global timer — Inventory enrichment stays inside
 * the same global deadline.
 */
const runFanout = (input: {
  readonly deps: BoundedResolverDeps;
  readonly config: BoundedResolverConfig;
  readonly targets: ReadonlyArray<DefaultSearchHit>;
  readonly address: string;
  readonly globalAbort: AbortSignal;
  readonly globalController: ReturnType<typeof createDeadlineController>;
  readonly global_deadline_at_ms: number;
}): Effect.Effect<FanoutResult, never> =>
  Effect.gen(function* () {
    const {
      deps,
      config,
      targets,
      address,
      globalAbort,
      globalController,
      global_deadline_at_ms: globalDeadlineAt,
    } = input;

    const timed_out: NetworkRef[] = [];
    const unavailable: NetworkRef[] = [];
    const cancelled: NetworkRef[] = [];
    const circuit_open: NetworkRef[] = [];
    const searched: NetworkRef[] = [];
    const conclusive_misses: NetworkRef[] = [];
    const hits: FanoutResult["hits"] = [];
    const declaredCoverage = targets.map((t) => networkIdentityKey(t.network.network));
    const concluded = new Set<string>();

    let sealed = false;
    let global_deadline_exceeded = false;
    let inFlight = 0;
    /** Generation token — late settlements after seal are ignored. */
    let sealGeneration = 0;

    const seal = (reason: string) => {
      if (!sealed) {
        sealed = true;
        sealGeneration += 1;
        if (reason === "global_deadline") global_deadline_exceeded = true;
        globalController.abort(reason);
      }
    };

    const queue = [...targets];
    const workers = Math.min(config.max_concurrent_probes, Math.max(queue.length, 1));

    const runOne = (hit: DefaultSearchHit): Effect.Effect<void, never> =>
      Effect.gen(function* () {
        const localGeneration = sealGeneration;
        if (sealed || globalAbort.aborted || isPastDeadline(deps.clock.nowMs(), globalDeadlineAt)) {
          seal(
            globalAbort.aborted || globalController.reason === "cancelled"
              ? "cancelled"
              : "global_deadline",
          );
          pushUnique(cancelled, hit.network.network);
          return;
        }

        const recognize = hit.network.operations.recognize;
        if (
          hit.network.kill_switch ||
          !recognize.enabled ||
          recognize.state === "disabled" ||
          recognize.prior_evidence_revocation_policy === "revoke_integrity"
        ) {
          pushUnique(unavailable, hit.network.network);
          return;
        }
        if (recognize.state !== "available") {
          pushUnique(unavailable, hit.network.network);
          return;
        }

        const networkKey = networkIdentityKey(hit.network.network);
        const gate = yield* deps.circuitBreaker.beforeCall({
          network_key: networkKey,
          operation: "recognize",
          now_ms: deps.clock.nowMs(),
        });
        if (!gate.allow) {
          pushUnique(circuit_open, hit.network.network);
          return;
        }

        pushUnique(searched, hit.network.network);
        const networkController = createDeadlineController();
        const unlink = linkAbort(globalAbort, networkController);
        const perNetworkDeadline =
          deps.clock.nowMs() +
          Math.min(
            config.per_network_deadline_ms,
            hit.network.operations.recognize.deadline.deadline_ms,
          );

        inFlight += 1;
        deps.metrics.observeConcurrency(inFlight);
        deps.metrics.incr("adapter_calls");

        const disarm = armDeadlineRace({
          clock: deps.clock,
          timer: deps.timer,
          controller: networkController,
          per_network_deadline_at_ms: perNetworkDeadline,
          global_deadline_at_ms: globalDeadlineAt,
        });

        let deadlineFired: DeadlineKind | undefined;

        // Never directly await the unbounded adapter promise as the controlling task.
        const outcome: ProbeOutcome = yield* raceSettlementAgainstDeadlines({
          effect: deps.adapter.probe({
            network: hit.network.network,
            network_capability: hit.network,
            address,
            abort: {
              signal: networkController.signal,
              get aborted() {
                return networkController.aborted;
              },
            },
            deadline_at_ms: Math.min(perNetworkDeadline, globalDeadlineAt),
          }),
          clock: deps.clock,
          timer: deps.timer,
          deadlines: [
            { at_ms: perNetworkDeadline, kind: "per_network_deadline" },
            { at_ms: globalDeadlineAt, kind: "global_deadline" },
          ],
          onDeadline: (kind) => {
            deadlineFired = kind;
            networkController.abort(kind);
            if (kind === "global_deadline") {
              seal("global_deadline");
            }
          },
          timeoutValue: TIMEOUT_OUTCOME,
        });

        disarm();
        unlink();
        inFlight -= 1;

        // Late settlement after seal: ignore — never cache/mutate.
        if (sealed || localGeneration !== sealGeneration || globalAbort.aborted) {
          if (deadlineFired === "global_deadline" || outcome.kind === "timeout") {
            deps.metrics.incr("timeouts");
            pushUnique(timed_out, hit.network.network);
          } else {
            pushUnique(cancelled, hit.network.network);
          }
          return;
        }

        // Check per-network + global deadlines both during race (abort) and after result.
        const breach =
          deadlineFired ??
          classifyDeadlineBreach({
            now_ms: deps.clock.nowMs(),
            per_network_deadline_at_ms: perNetworkDeadline,
            global_deadline_at_ms: globalDeadlineAt,
            abort_reason: networkController.reason,
          });
        if (breach === "global_deadline") {
          seal("global_deadline");
          deps.metrics.incr("timeouts");
          pushUnique(timed_out, hit.network.network);
          return;
        }
        if (breach === "per_network_deadline" || outcome.kind === "timeout") {
          deps.metrics.incr("timeouts");
          yield* deps.circuitBreaker.recordFailure({
            network_key: networkKey,
            operation: "recognize",
            now_ms: deps.clock.nowMs(),
          });
          pushUnique(timed_out, hit.network.network);
          return;
        }

        switch (outcome.kind) {
          case "hit":
            yield* deps.circuitBreaker.recordSuccess({
              network_key: networkKey,
              operation: "recognize",
              now_ms: deps.clock.nowMs(),
            });
            hits.push({ network: hit.network, outcome });
            concluded.add(networkKey);
            break;
          case "miss":
            yield* deps.circuitBreaker.recordSuccess({
              network_key: networkKey,
              operation: "recognize",
              now_ms: deps.clock.nowMs(),
            });
            pushUnique(conclusive_misses, hit.network.network);
            concluded.add(networkKey);
            break;
          case "unavailable":
            yield* deps.circuitBreaker.recordFailure({
              network_key: networkKey,
              operation: "recognize",
              now_ms: deps.clock.nowMs(),
            });
            pushUnique(unavailable, hit.network.network);
            break;
        }
      });

    const runPool = (): Effect.Effect<void, never> =>
      Effect.gen(function* () {
        const active: Array<Effect.Effect<void, never>> = [];
        while (queue.length > 0 || active.length > 0) {
          // Do not start new work after global deadline — return partial without awaiting late.
          if (
            sealed ||
            isPastDeadline(deps.clock.nowMs(), globalDeadlineAt) ||
            globalAbort.aborted
          ) {
            seal("global_deadline");
            while (queue.length > 0) {
              const leftover = queue.shift()!;
              pushUnique(cancelled, leftover.network.network);
            }
            // Drop remaining queued work; in-flight tasks settle via their own deadline race.
            active.length = 0;
            break;
          }
          while (queue.length > 0 && active.length < workers) {
            if (sealed || isPastDeadline(deps.clock.nowMs(), globalDeadlineAt)) {
              seal("global_deadline");
              while (queue.length > 0) {
                const leftover = queue.shift()!;
                pushUnique(cancelled, leftover.network.network);
              }
              break;
            }
            const next = queue.shift()!;
            active.push(runOne(next));
          }
          if (active.length === 0) break;
          const batch = active.splice(0, active.length);
          // Batch completes when every task is settled or timed out — not when
          // underlying ignored-abort promises eventually resolve.
          yield* Effect.forEach(
            batch,
            (eff) =>
              eff.pipe(
                Effect.tap(() => {
                  if (
                    isPastDeadline(deps.clock.nowMs(), globalDeadlineAt) ||
                    globalAbort.aborted
                  ) {
                    seal("global_deadline");
                  }
                  return Effect.void;
                }),
              ),
            { concurrency: workers },
          );
          if (sealed) {
            active.length = 0;
            while (queue.length > 0) {
              const leftover = queue.shift()!;
              pushUnique(cancelled, leftover.network.network);
            }
            break;
          }
        }
      });

    yield* runPool();

    if (isPastDeadline(deps.clock.nowMs(), globalDeadlineAt) || globalAbort.aborted) {
      seal("global_deadline");
    }

    const unsearched_or_uncertain = declaredCoverage.filter((key) => !concluded.has(key));

    return {
      hits,
      conclusive_misses: sortNetworkRefs(conclusive_misses),
      timed_out: sortNetworkRefs(timed_out),
      unavailable: sortNetworkRefs(unavailable),
      cancelled: sortNetworkRefs(cancelled),
      circuit_open: sortNetworkRefs(circuit_open),
      searched: sortNetworkRefs(searched),
      sealed,
      global_deadline_exceeded,
      unsearched_or_uncertain,
    };
  });

const assertCandidatesDecode = (
  candidates: ReadonlyArray<CollectionCandidate>,
): Effect.Effect<ReadonlyArray<CollectionCandidate>, BoundedResolverDecodeError> =>
  Effect.forEach(candidates, (candidate) =>
    decodeCollectionCandidate(candidate).pipe(
      Effect.mapError(
        (cause) =>
          new BoundedResolverDecodeError({
            reason: "resolver candidate failed CR-001 strict decode",
            safe_cause: safeErrorLabel(cause),
            cause_digest: sha256Canonical(safeErrorLabel(cause)),
          }),
      ),
    ),
  );

const pushDiagnostic = (
  entries: SafeDiagnosticEntryType[],
  entry: SafeDiagnosticEntryType,
): Effect.Effect<void, BoundedResolverDecodeError> =>
  decodeSafeDiagnostic({
    ...entry,
    safe_message: redactSafeMessage(entry.safe_message).slice(0, 256),
  }).pipe(
    Effect.map((decoded) => {
      entries.push(decoded);
    }),
    Effect.mapError(
      (cause) =>
        new BoundedResolverDecodeError({
          reason: "diagnostic payload failed strict decode",
          safe_cause: safeErrorLabel(cause),
          cause_digest: sha256Canonical(safeErrorLabel(cause)),
        }),
    ),
  );

/**
 * Authoritative negative cache is allowed only when every declared covered
 * healthy target returned a conclusive not-found/unsupported miss — never on
 * timeout, transient, breaker-open, cancellation, or partial coverage.
 */
const mayWriteNegativeCache = (fanout: FanoutResult, declaredCount: number): boolean =>
  fanout.hits.length === 0 &&
  fanout.timed_out.length === 0 &&
  fanout.unavailable.length === 0 &&
  fanout.cancelled.length === 0 &&
  fanout.circuit_open.length === 0 &&
  !fanout.global_deadline_exceeded &&
  !fanout.sealed &&
  fanout.unsearched_or_uncertain.length === 0 &&
  fanout.conclusive_misses.length === declaredCount &&
  fanout.searched.length === declaredCount;

const followerTimeoutResponse = (input: {
  readonly capability_snapshot_version: CapabilityRegistrySnapshot["version"];
  readonly global_deadline_exceeded: boolean;
  readonly safe_code?: string;
  readonly safe_message?: string;
}): BoundedResolveResponse =>
  cloneFreeze({
    schema_version: 1 as const,
    capability_snapshot_version: input.capability_snapshot_version,
    candidates: [],
    diagnostics: {
      schema_version: 1 as const,
      searched: [],
      timed_out: [],
      unavailable: [],
      cancelled: [],
      circuit_open: [],
      partial: true,
      global_deadline_exceeded: input.global_deadline_exceeded,
      cache: {
        positive_hit: false,
        readiness_hit: false,
        negative_hit: false,
        coalesced: true,
      },
      entries: [
        {
          code: input.safe_code ?? "coalesce_follower_deadline",
          safe_message:
            input.safe_message ??
            "coalesced follower reached global deadline before leader sealed; typed partial",
        },
      ],
    },
    ranking_evidence: [],
  });

const markCoalesced = (
  response: BoundedResolveResponse,
  expectedVersion: CapabilityRegistrySnapshot["version"],
): Effect.Effect<BoundedResolveResponse, BoundedResolverDecodeError> =>
  decodeCoalescedResponse(cloneFreeze({
    ...response,
    diagnostics: {
      ...response.diagnostics,
      cache: {
        ...response.diagnostics.cache,
        coalesced: true,
      },
      entries: [
        ...response.diagnostics.entries.slice(0, 31),
        {
          code: "coalesced_inflight",
          safe_message: "identical demand coalesced; fanout not amplified",
        },
      ],
    },
  }), expectedVersion);

/**
 * Bounded collection resolve — the CR-102 orchestration entrypoint.
 * Strict-decodes config before cache / rate / adapters.
 */
export const resolveBounded = (input: {
  readonly request: unknown;
  readonly config: unknown;
  readonly deps: BoundedResolverDeps;
}): Effect.Effect<BoundedResolveResponse, BoundedResolveFailure> =>
  Effect.gen(function* () {
    const started = input.deps.clock.nowMs();

    // 0. Strict-decode complete excess-property-free config BEFORE any effectful work.
    const config = yield* decodeBoundedResolverConfig(input.config);

    const request = yield* decodeRequest(input.request).pipe(
      Effect.mapError(
        (cause) =>
          new BoundedResolverDecodeError({
            reason: "bounded resolve request failed strict decode",
            safe_cause: safeErrorLabel(cause),
            cause_digest: sha256Canonical(safeErrorLabel(cause)),
          }),
      ),
    );

    // 1. Structural preflight — BEFORE rate limit, cache, coalesce, adapter.
    const { identifier } = yield* structuralPreflight(request.identifier);

    // 2. Rate limit debit (only after preflight).
    const rate = yield* input.deps.rateLimiter.tryAcquire({
      caller_bucket_id: request.caller.bucket_id,
      now_ms: input.deps.clock.nowMs(),
    });
    if (!rate.allowed) {
      input.deps.metrics.incr("rate_limited");
      return yield* Effect.fail(
        new ResolverRateLimitedError({
          scope: rate.scope,
          reason: `${rate.scope} resolver budget exceeded`,
          retry_after_ms: rate.retry_after_ms,
          limit: rate.limit,
          window_ms: rate.window_ms,
        }),
      );
    }

    const selectedTargets = selectBoundedTargets(
      input.deps.capabilitySnapshot,
      identifier,
      config.max_searched_networks,
    );

    if (selectedTargets.length === 0) {
      return yield* Effect.fail(
        new NoHealthyCapabilityError({
          reason: "no healthy mainnet recognize capabilities for identifier format",
          capability_snapshot_version: input.deps.capabilitySnapshot.version,
        }),
      );
    }

    const allowedNetworkKeys = selectedTargets.map((t) =>
      networkIdentityKey(t.network.network),
    );
    const structuralDigest = structuralIdentifierDigest({
      format: identifier.format,
      raw: identifier.raw,
    });
    const positiveHits = yield* input.deps.cache.findPositive({
      normalized_address:
        identifier.format === "evm_address"
          ? identifier.raw.toLowerCase()
          : identifier.raw,
      identifier_format: identifier.format,
      identifier_structural_digest: structuralDigest,
      capability_snapshot_version: input.deps.capabilitySnapshot.version,
      authorization_scope: request.caller.authorization_scope,
      adapter_policy_version: config.adapter_policy_version,
      allowed_network_keys: allowedNetworkKeys,
    });
    const readyPositiveHits: typeof positiveHits[number][] = [];
    let readinessHit = positiveHits.length > 0;
    if (positiveHits.length > 0) {
      for (const entry of positiveHits) {
        const candidate = entry.candidate;
        const deployment = candidate.identity.deployments[0];
        if (deployment === undefined) {
          readinessHit = false;
          continue;
        }
        const readinessBinding = {
          schema_version: 1 as const,
          namespace: "report_readiness" as const,
          capability_snapshot_version: entry.binding.capability_snapshot_version,
          deployment_id: deployment.deployment_id.digest,
          report_readiness: candidate.report_readiness,
          index_status: candidate.index_status,
          adapter_policy_version: entry.binding.adapter_policy_version,
          authorization_scope: entry.binding.authorization_scope,
        };
        const readinessKey = yield* digestReadinessBinding(readinessBinding);
        const ready = yield* input.deps.cache.getReadiness(readinessKey);
        if (
          ready === undefined ||
          ready.binding.adapter_policy_version !== config.adapter_policy_version
        ) {
          readinessHit = false;
        } else {
          readyPositiveHits.push(entry);
        }
      }
      input.deps.metrics.incr("cache_positive_hit", readyPositiveHits.length);
      if (readinessHit) {
        input.deps.metrics.incr("cache_readiness_hit", readyPositiveHits.length);
      }
    }

    // Recognition may outlive report readiness. Only a positive entry with a
    // live readiness binding covers its network; expired readiness must reprobe.
    const cachedCandidates = readyPositiveHits.map((entry) => entry.candidate);

    const cachedNetworkKeys = new Set(
      cachedCandidates
        .map((candidate) => candidate.identity.deployments[0]?.network)
        .filter((network): network is NetworkRef => network !== undefined)
        .map(networkIdentityKey),
    );
    const targets = selectedTargets.filter(
      (target) => !cachedNetworkKeys.has(networkIdentityKey(target.network.network)),
    );

    if (positiveHits.length > 0 && targets.length === 0) {
      input.deps.metrics.recordLatency(input.deps.clock.nowMs() - started);
      const decodedCachedCandidates = yield* assertCandidatesDecode(cachedCandidates);
      const { candidates, ranking_evidence } = aggregateAndRank(decodedCachedCandidates);
      return cloneFreeze({
        schema_version: 1 as const,
        capability_snapshot_version: input.deps.capabilitySnapshot.version,
        candidates,
        diagnostics: {
          schema_version: 1 as const,
          searched: [],
          timed_out: [],
          unavailable: [],
          cancelled: [],
          circuit_open: [],
          partial: false,
          global_deadline_exceeded: false,
          cache: {
            positive_hit: true,
            readiness_hit: readinessHit,
            negative_hit: false,
            coalesced: false,
          },
          entries: [],
        },
        ranking_evidence,
      });
    }

    const coverage = [...allowedNetworkKeys].sort();
    const negativeBinding: NegativeCacheBinding = {
      schema_version: 1,
      namespace: "negative_probe",
      identifier_format: identifier.format,
      identifier_structural_digest: structuralDigest,
      capability_snapshot_version: input.deps.capabilitySnapshot.version,
      adapter_policy_version: config.adapter_policy_version,
      authorization_scope: request.caller.authorization_scope,
      searched_coverage: coverage,
      claims_beyond_coverage: false,
    };
    const negativeKey = yield* digestNegativeBinding(negativeBinding);
    const scopeDigest = sha256Canonical(request.caller.authorization_scope);
    const configDigest = sha256Canonical(config);
    const coalesceKey = `demand:${negativeKey}:auth:${scopeDigest}:config:${configDigest}`;
    const globalDeadlineAt = started + config.global_deadline_ms;

    let coalesce = yield* input.deps.coalesce.begin(coalesceKey);
    if (coalesce.kind === "negative_cached") {
      input.deps.metrics.incr("coalesced");
      const neg = yield* input.deps.cache.getNegative(negativeKey);
      if (neg !== undefined) {
        input.deps.metrics.incr("cache_negative_hit");
        input.deps.metrics.recordLatency(input.deps.clock.nowMs() - started);
        const diagnostics: BoundedResolveDiagnostics = {
          schema_version: 1,
          searched: sortNetworkRefs(
            targets
              .filter((t) =>
                neg.binding.searched_coverage.includes(
                  networkIdentityKey(t.network.network),
                ),
              )
              .map((t) => t.network.network),
          ),
          timed_out: [],
          unavailable: [],
          cancelled: [],
          circuit_open: [],
          partial: false,
          global_deadline_exceeded: false,
          cache: {
            positive_hit: false,
            readiness_hit: false,
            negative_hit: true,
            coalesced: true,
          },
          entries: [
            {
              code: "negative_cache_hit",
              safe_message:
                "zero-result demand served from negative cache within searched coverage",
            },
          ],
        };
        return cloneFreeze({
          schema_version: 1 as const,
          capability_snapshot_version: input.deps.capabilitySnapshot.version,
          candidates: [],
          diagnostics,
          ranking_evidence: [],
        });
      }
      // Stale negative_cached hint — reconcile with cache and re-begin rather than
      // falling through into leaderBody with a forged empty-result path.
      coalesce = yield* input.deps.coalesce.begin(coalesceKey);
    }

    if (coalesce.kind === "follower") {
      input.deps.metrics.incr("coalesced");
      const sealed = yield* raceSharedAgainstDeadline({
        shared: coalesce.shared,
        clock: input.deps.clock,
        timer: input.deps.timer,
        deadline_at_ms: globalDeadlineAt,
        onDeadline: () => undefined,
        timeoutValue: {
          kind: "error" as const,
          safe_code: "coalesce_follower_deadline",
          safe_message:
            "coalesced follower reached global deadline before leader sealed; typed partial",
        },
      });
      input.deps.metrics.recordLatency(input.deps.clock.nowMs() - started);
      if (sealed.kind === "response") {
        const response = yield* decodeCoalescedResponse(
          sealed.response,
          input.deps.capabilitySnapshot.version,
        );
        return yield* markCoalesced(
          response,
          input.deps.capabilitySnapshot.version,
        );
      }
      return followerTimeoutResponse({
        capability_snapshot_version: input.deps.capabilitySnapshot.version,
        global_deadline_exceeded: sealed.safe_code === "coalesce_follower_deadline",
        safe_code: sealed.safe_code,
        safe_message: sealed.safe_message,
      });
    }

    // Leader path — complete coalesce exactly once with sealed result (or safe error).
    const completeCoalesce = (result: CoalesceSealedResult) =>
      input.deps.coalesce.complete(coalesceKey, result);

    input.deps.metrics.incr("cache_negative_miss");

    const globalController = createDeadlineController();
    // Global deadline stays armed through Inventory enrichment, ranking, seal, cache decision.
    const cancelGlobalTimer = input.deps.timer.scheduleAt(globalDeadlineAt, () => {
      globalController.abort("global_deadline");
    });

    const leaderBody = Effect.gen(function* () {
      const fanout = yield* runFanout({
        deps: input.deps,
        config,
        targets,
        address: identifier.raw,
        globalAbort: globalController.signal,
        globalController,
        global_deadline_at_ms: globalDeadlineAt,
      });

      if (fanout.global_deadline_exceeded || fanout.sealed) {
        globalController.abort("global_deadline");
      }

      const built: CollectionCandidate[] = [...cachedCandidates];
      const diagnosticEntries: SafeDiagnosticEntryType[] = [];
      let missingBindingEvidence = false;
      /** Required enrichment/binding arrived after seal — forbid positive/readiness writes. */
      let lateEnrichmentOrBinding = false;

      for (const { network, outcome } of fanout.hits) {
        const capability = toRecognizeCapability(network);
        const candidate = yield* buildCandidateFromHit({
          capability,
          address: identifier.raw,
          hit: outcome,
        }).pipe(
          Effect.mapError(
            (cause) =>
              new BoundedResolverDecodeError({
                reason: "failed to build candidate from adapter hit",
                safe_cause: safeErrorLabel(cause),
                cause_digest: sha256Canonical(safeErrorLabel(cause)),
              }),
          ),
        );
        built.push(candidate);
        if (outcome.binding_evidence === undefined) {
          missingBindingEvidence = true;
          yield* pushDiagnostic(diagnosticEntries, {
            code: "binding_evidence_absent",
            network: network.network,
            safe_message:
              "adapter hit lacked observed binding evidence; positive cache refused",
          });
        }
      }

      // Inventory enrichment — inside the SAME global deadline; race remaining time.
      const inventoryHits: InventoryEnrichmentHit[] = [];
      let inventoryDiag: BoundedResolveDiagnostics["inventory"];

      if (
        input.deps.inventory !== undefined &&
        built.length > 0 &&
        config.inventory_enrichment_budget_ms > 0
      ) {
        const invController = createDeadlineController();
        const unlinkInventoryAbort = linkAbort(globalController.signal, invController);
        const invBudgetDeadline =
          input.deps.clock.nowMs() + config.inventory_enrichment_budget_ms;
        const invDeadline = Math.min(invBudgetDeadline, globalDeadlineAt);

        if (
          isPastDeadline(input.deps.clock.nowMs(), globalDeadlineAt) ||
          globalController.aborted
        ) {
          globalController.abort("global_deadline");
          inventoryDiag = {
            attempted: false,
            outcome: "skipped",
            safe_message: "inventory enrichment skipped after global deadline",
          };
        } else {
          let invDeadlineFired = false;
          const results = yield* raceSettlementAgainstDeadlines({
            effect: input.deps.inventory!.enrich({
              deployment_ids: built
                .map((c) => c.identity.deployments[0]?.deployment_id.digest)
                .filter((d): d is string => d !== undefined),
              candidates: built,
              abort: {
                signal: invController.signal,
                get aborted() {
                  return invController.aborted;
                },
              },
              deadline_at_ms: invDeadline,
            }),
            clock: input.deps.clock,
            timer: input.deps.timer,
            deadlines: [
              { at_ms: invDeadline, kind: "per_network_deadline" },
              { at_ms: globalDeadlineAt, kind: "global_deadline" },
            ],
            onDeadline: (kind) => {
              invDeadlineFired = true;
              invController.abort(kind);
              if (kind === "global_deadline") {
                globalController.abort("global_deadline");
              }
            },
            timeoutValue: [
              {
                kind: "timeout" as const,
                safe_message: "inventory enrichment deadline exceeded",
              },
            ],
          }).pipe(Effect.ensuring(Effect.sync(unlinkInventoryAbort)));

          // Late Inventory settlement after deadline cannot mutate cache/candidates.
          if (
            invDeadlineFired ||
            isPastDeadline(input.deps.clock.nowMs(), globalDeadlineAt) ||
            globalController.aborted
          ) {
            lateEnrichmentOrBinding = true;
            if (
              globalController.aborted ||
              isPastDeadline(input.deps.clock.nowMs(), globalDeadlineAt)
            ) {
              globalController.abort("global_deadline");
            }
            inventoryDiag = {
              attempted: true,
              outcome: "timeout",
              safe_message: "inventory enrichment deadline exceeded",
            };
            yield* pushDiagnostic(diagnosticEntries, {
              code: "inventory_timeout",
              safe_message: "inventory enrichment deadline exceeded",
            });
          } else {
            let outcome: "enriched" | "miss" | "timeout" | "error" | "skipped" = "miss";
            for (const result of results as ReadonlyArray<InventoryEnrichmentResult>) {
              if (result.kind === "enriched") {
                inventoryHits.push(result);
                outcome = "enriched";
              } else if (result.kind === "error" || result.kind === "timeout") {
                outcome = result.kind;
                yield* pushDiagnostic(diagnosticEntries, {
                  code: `inventory_${result.kind}`,
                  safe_message: redactSafeMessage(result.safe_message),
                });
              }
            }
            inventoryDiag = { attempted: true, outcome };
          }
        }
      } else {
        inventoryDiag = { attempted: false, outcome: "skipped" };
      }

      // Re-check global deadline before ranking / seal / cache-write decision.
      if (isPastDeadline(input.deps.clock.nowMs(), globalDeadlineAt) || globalController.aborted) {
        globalController.abort("global_deadline");
      }

      const { candidates: ranked, ranking_evidence } = aggregateAndRank(built, inventoryHits);
      const candidates = yield* assertCandidatesDecode(ranked);

      const globalExceeded =
        fanout.global_deadline_exceeded ||
        globalController.aborted ||
        isPastDeadline(input.deps.clock.nowMs(), globalDeadlineAt);

      // Cache writes — refused after seal / global deadline / late enrichment / incomplete coverage.
      const acceptCacheWrites =
        !globalExceeded &&
        !fanout.sealed &&
        !lateEnrichmentOrBinding &&
        !globalController.aborted;

      const writeNegative =
        candidates.length === 0 &&
        acceptCacheWrites &&
        mayWriteNegativeCache(fanout, targets.length);

      // Positive / readiness cache — bind observed evidence only; never fabricate.
      // Forbidden when required enrichment/binding evidence arrives late.
      if (acceptCacheWrites && !missingBindingEvidence) {
        for (const candidate of candidates) {
          const deployment = candidate.identity.deployments[0];
          if (deployment === undefined) continue;
          const hit = fanout.hits.find(
            (h) =>
              networkIdentityKey(h.network.network) ===
              networkIdentityKey(deployment.network),
          );
          if (hit === undefined) continue;
          const evidence = hit.outcome as ProbeHitEvidence;
          const binding = evidence.binding_evidence;
          if (binding === undefined) {
            continue;
          }

          const networkCap = hit.network;
          const invForDeployment = inventoryHits.find(
            (inv) => inv.deployment_id === deployment.deployment_id.digest,
          );

          const positiveBindingInput = {
            schema_version: 1 as const,
            namespace: "positive_recognition" as const,
            identifier_format: identifier.format,
            identifier_structural_digest: structuralDigest,
            capability_snapshot_version: input.deps.capabilitySnapshot.version,
            capability_source_sequence: networkCap.operations.recognize.source_sequence,
            deployment_id: deployment.deployment_id.digest,
            account_digest: binding.account_digest,
            code_digest: binding.code_digest,
            observed_position: binding.observed_position,
            standard_evidence: binding.standard_evidence,
            proxy_evidence: binding.proxy_evidence,
            authorization_scope: request.caller.authorization_scope,
            adapter_policy_version: binding.adapter_policy_version,
            finality_policy_version: networkCap.finality_policy.policy_version,
            ...(invForDeployment?.enrichment_version !== undefined
              ? { inventory_enrichment_version: invForDeployment.enrichment_version }
              : {}),
            ...(invForDeployment?.equivalence_version !== undefined
              ? { inventory_equivalence_version: invForDeployment.equivalence_version }
              : {}),
          };

          const positiveBinding = yield* decodePositiveBinding(positiveBindingInput).pipe(
            Effect.mapError(
              (cause) =>
                new BoundedResolverDecodeError({
                  reason: "positive cache binding failed strict decode from observed evidence",
                  safe_cause: safeErrorLabel(cause),
                  cause_digest: sha256Canonical(safeErrorLabel(cause)),
                }),
            ),
          );

          const posKey = yield* digestPositiveBinding(positiveBinding);
          yield* input.deps.cache.setPositive(posKey, {
            binding: positiveBinding,
            candidate,
            stored_at_ms: input.deps.clock.nowMs(),
            expires_at_ms: input.deps.clock.nowMs() + config.positive_recognition_ttl_ms,
          });
          input.deps.metrics.incr("cache_positive_miss");

          const readinessBindingInput = {
            schema_version: 1 as const,
            namespace: "report_readiness" as const,
            capability_snapshot_version: input.deps.capabilitySnapshot.version,
            deployment_id: deployment.deployment_id.digest,
            report_readiness: candidate.report_readiness,
            index_status: candidate.index_status,
            adapter_policy_version: binding.adapter_policy_version,
            authorization_scope: request.caller.authorization_scope,
          };
          const readinessBinding = yield* decodeReadinessBinding(readinessBindingInput).pipe(
            Effect.mapError(
              (cause) =>
                new BoundedResolverDecodeError({
                  reason: "readiness cache binding failed strict decode",
                  safe_cause: safeErrorLabel(cause),
                  cause_digest: sha256Canonical(safeErrorLabel(cause)),
                }),
            ),
          );
          const readyKey = yield* digestReadinessBinding(readinessBinding);
          yield* input.deps.cache.setReadiness(readyKey, {
            binding: readinessBinding,
            stored_at_ms: input.deps.clock.nowMs(),
            expires_at_ms: input.deps.clock.nowMs() + config.report_readiness_ttl_ms,
          });
          input.deps.metrics.incr("cache_readiness_miss");
        }
      }

      if (writeNegative) {
        yield* input.deps.cache.setNegative(negativeKey, {
          binding: negativeBinding,
          stored_at_ms: input.deps.clock.nowMs(),
          expires_at_ms: input.deps.clock.nowMs() + config.negative_cache_ttl_ms,
        });
      }

      const partial =
        fanout.timed_out.length > 0 ||
        fanout.unavailable.length > 0 ||
        fanout.cancelled.length > 0 ||
        fanout.circuit_open.length > 0 ||
        globalExceeded ||
        missingBindingEvidence ||
        lateEnrichmentOrBinding ||
        inventoryDiag?.outcome === "error" ||
        inventoryDiag?.outcome === "timeout";

      if (partial) input.deps.metrics.incr("partials");
      input.deps.metrics.recordLatency(input.deps.clock.nowMs() - started);

      const diagnostics: BoundedResolveDiagnostics = {
        schema_version: 1,
        searched: fanout.searched,
        timed_out: fanout.timed_out,
        unavailable: fanout.unavailable,
        cancelled: fanout.cancelled,
        circuit_open: fanout.circuit_open,
        partial,
        global_deadline_exceeded: globalExceeded,
        inventory: inventoryDiag,
        entries: diagnosticEntries.slice(0, 32),
        cache: {
          positive_hit: positiveHits.length > 0,
          readiness_hit: readinessHit,
          negative_hit: false,
          coalesced: false,
        },
      };

      return cloneFreeze({
        schema_version: 1 as const,
        capability_snapshot_version: input.deps.capabilitySnapshot.version,
        candidates,
        diagnostics,
        ranking_evidence,
      });
    }).pipe(
      Effect.tap((response) => completeCoalesce({ kind: "response", response })),
      Effect.tapErrorCause((cause) =>
        completeCoalesce({
          kind: "error",
          safe_code: "bounded_resolver_failure",
          safe_message: redactSafeMessage(safeErrorLabel(cause)),
        }),
      ),
      Effect.ensuring(Effect.sync(() => cancelGlobalTimer())),
    );

    return yield* leaderBody;
  }).pipe(
    Effect.catchAllDefect((defect) =>
      Effect.fail(
        new BoundedResolverDecodeError({
          reason: "bounded resolver defect suppressed",
          safe_cause: safeErrorLabel(defect),
          cause_digest: sha256Canonical(safeErrorLabel(defect)),
        }),
      ),
    ),
  );

export type { BoundedResolveRequestType };
