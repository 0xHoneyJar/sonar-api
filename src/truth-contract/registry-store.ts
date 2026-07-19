import { Effect, SynchronizedRef } from "effect";

import {
  jcsCanonicalize,
  sha256Hex,
} from "../collection-resolver/trust-protocol.js";
import { TruthIntegrityError, TruthRegistryError } from "./errors.js";
import type {
  DecimalUint64,
  Sha256Digest,
  TruthEnvironmentId,
} from "./schemas/common.js";
import type {
  TruthAuditEventV1,
  TruthGenerationActivationV1,
  TruthRevocationRecordV1,
} from "./schemas/registry.js";
import type { TruthRegistryStoreService } from "./services.js";
import type { TruthTrustError } from "./errors.js";
import type { TruthAuditVerifier } from "./audit-control-plane.js";

export type TruthActivationVerifier = (
  environment: TruthEnvironmentId,
  expectedGeneration: DecimalUint64,
  activation: TruthGenerationActivationV1,
) => Effect.Effect<void, TruthTrustError | TruthIntegrityError>;

interface RegistryState {
  readonly objects: ReadonlyMap<TruthEnvironmentId, ReadonlyMap<Sha256Digest, Uint8Array>>;
  readonly roots: ReadonlyMap<TruthEnvironmentId, TruthGenerationActivationV1>;
  readonly audits: ReadonlyMap<TruthEnvironmentId, ReadonlyArray<TruthAuditEventV1>>;
  readonly revocations: ReadonlyMap<
    TruthEnvironmentId,
    ReadonlyArray<TruthRevocationRecordV1>
  >;
}

const emptyState = (): RegistryState => ({
  objects: new Map(),
  roots: new Map(),
  audits: new Map(),
  revocations: new Map(),
});

const registryError = (
  boundary: string,
  reason: string,
  retryable = false,
): TruthRegistryError => new TruthRegistryError({ boundary, reason, retryable });

const integrityError = (boundary: string, reason: string): TruthIntegrityError =>
  new TruthIntegrityError({ boundary, reason });

const nextDecimal = (value: DecimalUint64): string => (BigInt(value) + 1n).toString();

const sameBytes = (left: Uint8Array, right: Uint8Array): boolean =>
  left.byteLength === right.byteLength &&
  left.every((value, index) => value === right[index]);

/**
 * Hermetic process-local reference implementation. All compound mutations pass
 * through one SynchronizedRef, so a two-publisher race has one linearization
 * point without pretending to prove cross-process durability.
 */
export const makeInMemoryTruthRegistryStore = (
  verifyActivation: TruthActivationVerifier,
  verifyAudit: TruthAuditVerifier = () =>
    Effect.fail(
      integrityError(
        "truth.registry.audit_verifier",
        "audit verifier is not configured",
      ),
    ),
): TruthRegistryStoreService => {
  const state = SynchronizedRef.unsafeMake(emptyState());

  return {
    putObjectIfAbsent: (environment, digest, canonicalBytes) => {
      const actual = sha256Hex(canonicalBytes);
      if (actual !== digest) {
        return Effect.fail(
          integrityError(
            "truth.registry.put_object",
            `content digest mismatch: expected ${digest}, got ${actual}`,
          ),
        );
      }
      const bytes = Uint8Array.from(canonicalBytes);
      return SynchronizedRef.modifyEffect(state, (current) => {
        const environmentObjects = current.objects.get(environment) ?? new Map();
        const existing = environmentObjects.get(digest);
        if (existing !== undefined) {
          return sameBytes(existing, bytes)
            ? Effect.succeed([undefined, current] as const)
            : Effect.fail(
                integrityError(
                  "truth.registry.put_object",
                  "immutable digest key already contains different bytes",
                ),
              );
        }
        const nextEnvironmentObjects = new Map(environmentObjects);
        nextEnvironmentObjects.set(digest, bytes);
        const objects = new Map(current.objects);
        objects.set(environment, nextEnvironmentObjects);
        return Effect.succeed([undefined, { ...current, objects }] as const);
      });
    },

    readObject: (environment, digest) =>
      SynchronizedRef.get(state).pipe(
        Effect.flatMap((current) => {
          const value = current.objects.get(environment)?.get(digest);
          return value === undefined
            ? Effect.fail(
                registryError(
                  "truth.registry.read_object",
                  "content object is not present",
                ),
              )
            : Effect.succeed(Uint8Array.from(value));
        }),
      ),

    appendAuditEvent: (event) =>
      verifyAudit(event).pipe(
        Effect.flatMap(() =>
          SynchronizedRef.modifyEffect(state, (current) => {
        const events = current.audits.get(event.environment) ?? [];
        const expected = (events.length + 1).toString();
        if (event.sequence !== expected) {
          return Effect.fail(
            registryError(
              "truth.registry.append_audit",
              `audit sequence must be contiguous: expected ${expected}`,
            ),
          );
        }
        const expectedPrior =
          events.length === 0
            ? null
            : sha256Hex(jcsCanonicalize(events.at(-1)!));
        if (event.prior_record_sha256 !== expectedPrior) {
          return Effect.fail(
            registryError(
              "truth.registry.append_audit",
              "audit prior-record digest does not bind the current tail",
            ),
          );
        }
        const audits = new Map(current.audits);
        audits.set(event.environment, [...events, event]);
        return Effect.succeed([undefined, { ...current, audits }] as const);
          }),
        ),
      ),

    readAuditEvents: (environment) =>
      SynchronizedRef.get(state).pipe(
        Effect.flatMap((current) => {
          const events = [...(current.audits.get(environment) ?? [])];
          return Effect.forEach(events, verifyAudit, {
            concurrency: 1,
            discard: true,
          }).pipe(Effect.as(events));
        }),
      ),

    readRoot: (environment) =>
      SynchronizedRef.get(state).pipe(
        Effect.flatMap((current) => {
          const activation = current.roots.get(environment);
          return activation === undefined
            ? Effect.fail(
                registryError("truth.registry.read_root", "active root is not present"),
              )
            : verifyActivation(
                environment,
                activation.unsigned_activation.prior_generation,
                activation,
              ).pipe(
                Effect.as(structuredClone(activation)),
                Effect.mapError((cause) =>
                  registryError(
                    "truth.registry.read_root",
                    `active activation verification failed: ${cause.reason}`,
                  ),
                ),
              );
        }),
      ),

    compareAndSwapRoot: (environment, expectedGeneration, activation) =>
      verifyActivation(environment, expectedGeneration, activation).pipe(
        Effect.flatMap(() =>
          SynchronizedRef.modifyEffect(
            state,
            (
              current,
            ): Effect.Effect<
              readonly [undefined, RegistryState],
              TruthRegistryError | TruthIntegrityError
            > => {
        const active = current.roots.get(environment);
        const actualGeneration =
          active?.unsigned_activation.generation ?? ("0" as DecimalUint64);
        const unsigned = activation.unsigned_activation;
        if (actualGeneration !== expectedGeneration) {
          return Effect.fail(
            registryError(
              "truth.registry.compare_and_swap_root",
              `generation contention: expected ${expectedGeneration}, found ${actualGeneration}`,
              true,
            ),
          );
        }
        if (
          unsigned.environment !== environment ||
          unsigned.root.unsigned_root.environment !== environment
        ) {
          return Effect.fail(
            integrityError(
              "truth.registry.compare_and_swap_root",
              "activation, root, and store environment must match",
            ),
          );
        }
        const expectedNext = nextDecimal(expectedGeneration);
        if (
          unsigned.prior_generation !== expectedGeneration ||
          unsigned.generation !== expectedNext ||
          unsigned.root.unsigned_root.generation !== expectedNext
        ) {
          return Effect.fail(
            integrityError(
              "truth.registry.compare_and_swap_root",
              `activation must advance exactly to generation ${expectedNext}`,
            ),
          );
        }
        if (
          expectedGeneration === "0" &&
          unsigned.root.unsigned_root.supersedes_generation !== null
        ) {
          return Effect.fail(
            integrityError(
              "truth.registry.compare_and_swap_root",
              "genesis root must not supersede a generation",
            ),
          );
        }
        if (
          expectedGeneration !== "0" &&
          unsigned.root.unsigned_root.supersedes_generation !== expectedGeneration
        ) {
          return Effect.fail(
            integrityError(
              "truth.registry.compare_and_swap_root",
              "root supersession must match the active generation",
            ),
          );
        }
        const environmentObjects = current.objects.get(environment);
        for (const object of unsigned.root.unsigned_root.objects) {
          const bytes = environmentObjects?.get(object.sha256);
          if (
            bytes === undefined ||
            sha256Hex(bytes) !== object.sha256 ||
            BigInt(bytes.byteLength) !== BigInt(object.byte_length)
          ) {
            return Effect.fail(
              integrityError(
                "truth.registry.compare_and_swap_root",
                `activation closure object ${object.sha256} is absent or corrupt`,
              ),
            );
          }
        }
        const audit = current.audits
          .get(environment)
          ?.find(
            (event) =>
              event.kind === "GENERATION_ACTIVATED" &&
              event.sequence === unsigned.audit_sequence &&
              event.generation === unsigned.generation &&
              event.subject_hash === activation.activation_hash &&
              event.prior_record_sha256 ===
                unsigned.audit_prior_record_sha256 &&
              event.recorded_at === unsigned.audit_recorded_at,
          );
        if (audit === undefined) {
          return Effect.fail(
            integrityError(
              "truth.registry.compare_and_swap_root",
              "complete activation audit is absent",
            ),
          );
        }
        const roots = new Map(current.roots);
        roots.set(environment, structuredClone(activation));
        return Effect.succeed([undefined, { ...current, roots }] as const);
            },
          ),
        ),
      ),

    readActiveGeneration: (environment) =>
      SynchronizedRef.get(state).pipe(
        Effect.flatMap((current) => {
          const generation = current.roots.get(environment)?.unsigned_activation.generation;
          return generation === undefined
            ? Effect.fail(
                registryError(
                  "truth.registry.read_active_generation",
                  "active generation is not present",
                ),
              )
            : Effect.succeed(generation);
        }),
      ),

    appendRevocation: (revocation) =>
      SynchronizedRef.modifyEffect(state, (current) => {
        const records = current.revocations.get(revocation.environment) ?? [];
        const expected = (records.length + 1).toString();
        if (revocation.sequence !== expected) {
          return Effect.fail(
            registryError(
              "truth.registry.append_revocation",
              `revocation sequence must be contiguous: expected ${expected}`,
            ),
          );
        }
        const expectedPrior =
          records.length === 0
            ? null
            : sha256Hex(jcsCanonicalize(records.at(-1)!));
        if (revocation.prior_record_sha256 !== expectedPrior) {
          return Effect.fail(
            registryError(
              "truth.registry.append_revocation",
              "revocation prior-record digest does not bind the current tail",
            ),
          );
        }
        if (records.some((record) => record.event_id === revocation.event_id)) {
          return Effect.fail(
            registryError(
              "truth.registry.append_revocation",
              "revocation event ID must be unique",
            ),
          );
        }
        const revocations = new Map(current.revocations);
        revocations.set(revocation.environment, [...records, revocation]);
        return Effect.succeed([undefined, { ...current, revocations }] as const);
      }),

    readRevocations: (environment) =>
      SynchronizedRef.get(state).pipe(
        Effect.map((current) =>
          structuredClone([...(current.revocations.get(environment) ?? [])]),
        ),
      ),
  };
};
