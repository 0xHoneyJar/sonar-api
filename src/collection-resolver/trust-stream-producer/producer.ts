import type { StreamEpochBaseline, TrustEnvelope, TrustEnvelopeSigner } from "../trust-protocol.js";
import {
  digestEpochBaselineMaterial,
  emitTrustEnvelope,
  ServiceKeyRegistry,
  signStreamEpochBaseline,
} from "../trust-protocol.js";
import {
  CAPABILITY_EVIDENCE_CAPABILITY,
  OWNERSHIP_EVIDENCE_CAPABILITY,
  PUBLIC_TENANT_SCOPE_DIGEST,
  SONAR_PRODUCER_ID,
  SONAR_PUBLIC_CAPABILITY_STREAM_ID,
  SONAR_PUBLIC_OWNERSHIP_STREAM_ID,
} from "./constants.js";
import { TrustStreamProducerError } from "./errors.js";
import {
  createInMemoryTrustStreamOutboxStore,
  type TrustStreamOutboxStore,
  type TrustStreamSnapshot,
} from "./outbox-store.js";
import type { CapabilityEvidenceBody, OwnershipEvidenceBody } from "./schemas.js";

export interface PublicTrustStreamProducerConfig {
  readonly store?: TrustStreamOutboxStore;
  readonly signer: TrustEnvelopeSigner;
  readonly registry: ServiceKeyRegistry;
  readonly issuedAtMs: () => number;
  readonly tenantScopeDigest?: string;
}

export interface AppendEvidenceInput {
  readonly eventId: string;
  readonly body: CapabilityEvidenceBody | OwnershipEvidenceBody;
  readonly capability: typeof CAPABILITY_EVIDENCE_CAPABILITY | typeof OWNERSHIP_EVIDENCE_CAPABILITY;
  readonly streamId: typeof SONAR_PUBLIC_CAPABILITY_STREAM_ID | typeof SONAR_PUBLIC_OWNERSHIP_STREAM_ID;
}

export interface PublicTrustStreamProducer {
  readonly store: TrustStreamOutboxStore;
  appendEvidence(input: AppendEvidenceInput): TrustEnvelope;
  appendCapabilityEvidence(input: {
    readonly eventId: string;
    readonly body: CapabilityEvidenceBody;
  }): TrustEnvelope;
  appendOwnershipEvidence(input: {
    readonly eventId: string;
    readonly body: OwnershipEvidenceBody;
  }): TrustEnvelope;
  replayRange(input: {
    readonly streamId: string;
    readonly streamEpoch: number;
    readonly fromSequence: number;
    readonly toSequence: number;
  }): ReadonlyArray<TrustEnvelope>;
  signEpochBaseline(input: {
    readonly streamId: string;
    readonly streamEpoch: number;
    readonly issuedAtMs: number;
  }): StreamEpochBaseline;
  resetEpoch(input: {
    readonly streamId: string;
    readonly newEpoch: number;
    readonly baseline: StreamEpochBaseline;
  }): void;
  snapshot(streamId: string): TrustStreamSnapshot;
  failoverClone(): PublicTrustStreamProducer;
}

const assertSignerActive = (
  registry: ServiceKeyRegistry,
  signer: TrustEnvelopeSigner,
  acceptedAtMs: number,
): void => {
  const key = registry.resolve(signer.keyId);
  if (key === undefined) {
    throw new TrustStreamProducerError({
      reason: "unknown_signing_key",
      detail: signer.keyId,
    });
  }
  if (!registry.isActive(key, acceptedAtMs)) {
    throw new TrustStreamProducerError({
      reason: "signing_key_not_active",
      detail: signer.keyId,
    });
  }
};

export const createPublicTrustStreamProducer = (
  config: PublicTrustStreamProducerConfig,
): PublicTrustStreamProducer => {
  const store = config.store ?? createInMemoryTrustStreamOutboxStore();
  const tenantScopeDigest = config.tenantScopeDigest ?? PUBLIC_TENANT_SCOPE_DIGEST;

  const appendEvidence = (input: AppendEvidenceInput): TrustEnvelope => {
    const issuedAtMs = config.issuedAtMs();
    assertSignerActive(config.registry, config.signer, issuedAtMs);

    if (store.hasEventId(input.streamId, input.eventId)) {
      throw new TrustStreamProducerError({
        reason: "duplicate_event_id",
        detail: input.eventId,
      });
    }

    const snapshot = store.snapshot(input.streamId);
    const envelope = emitTrustEnvelope({
      signer: config.signer,
      producer: SONAR_PRODUCER_ID,
      eventId: input.eventId,
      streamId: input.streamId,
      streamEpoch: snapshot.streamEpoch,
      sequence: snapshot.nextSequence,
      trustStream: true,
      issuedAtMs,
      tenantScopeDigest,
      capability: input.capability,
      body: input.body,
    });

    try {
      store.appendAtomic({
        streamId: input.streamId,
        eventId: input.eventId,
        envelope,
        committedAtMs: issuedAtMs,
      });
    } catch (cause) {
      if (cause instanceof Error && cause.message === "duplicate_event_id") {
        throw new TrustStreamProducerError({
          reason: "duplicate_event_id",
          detail: input.eventId,
        });
      }
      throw cause;
    }

    return envelope;
  };

  const producer: PublicTrustStreamProducer = {
    store,
    appendEvidence,
    appendCapabilityEvidence: (input) =>
      appendEvidence({
        ...input,
        capability: CAPABILITY_EVIDENCE_CAPABILITY,
        streamId: SONAR_PUBLIC_CAPABILITY_STREAM_ID,
      }),
    appendOwnershipEvidence: (input) =>
      appendEvidence({
        ...input,
        capability: OWNERSHIP_EVIDENCE_CAPABILITY,
        streamId: SONAR_PUBLIC_OWNERSHIP_STREAM_ID,
      }),
    replayRange: (input) => store.replayRange(input),
    signEpochBaseline: (input) => {
      const issuedAtMs = config.issuedAtMs();
      assertSignerActive(config.registry, config.signer, issuedAtMs);

      const envelopes = store
        .replayRange({
          streamId: input.streamId,
          streamEpoch: input.streamEpoch,
          fromSequence: 1,
          toSequence: Number.MAX_SAFE_INTEGER,
        })
        .filter((envelope) => envelope.header.stream_epoch === input.streamEpoch);

      if (envelopes.length === 0) {
        throw new TrustStreamProducerError({
          reason: "epoch_baseline_incomplete",
          detail: "no envelopes in epoch",
        });
      }

      const highestSequence = envelopes[envelopes.length - 1]!.header.sequence;
      const baselineDigest = digestEpochBaselineMaterial({
        stream_id: input.streamId,
        stream_epoch: input.streamEpoch,
        highest_sequence: highestSequence,
        envelope_count: envelopes.length,
        envelopes,
      });

      return signStreamEpochBaseline(config.signer, {
        schema_version: 1,
        schema_minor: 0,
        algorithm: "Ed25519",
        producer: SONAR_PRODUCER_ID,
        stream_id: input.streamId,
        stream_epoch: input.streamEpoch + 1,
        highest_sequence: highestSequence,
        envelope_count: envelopes.length,
        baseline_digest: baselineDigest,
        issued_at: new Date(input.issuedAtMs).toISOString(),
      });
    },
    resetEpoch: (input) => {
      store.recordEpochBaseline({
        streamId: input.streamId,
        baseline: input.baseline,
        committedAtMs: Date.parse(input.baseline.issued_at),
      });
      store.advanceEpoch({ streamId: input.streamId, newEpoch: input.newEpoch });
    },
    snapshot: (streamId) => store.snapshot(streamId),
    failoverClone: () => {
      const capabilitySnapshot = store.snapshot(SONAR_PUBLIC_CAPABILITY_STREAM_ID);
      const ownershipSnapshot = store.snapshot(SONAR_PUBLIC_OWNERSHIP_STREAM_ID);
      const clonedStore = createInMemoryTrustStreamOutboxStore();
      clonedStore.restore(capabilitySnapshot);
      clonedStore.restore(ownershipSnapshot);
      return createPublicTrustStreamProducer({ ...config, store: clonedStore });
    },
  };

  return producer;
};
