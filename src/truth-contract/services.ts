import { Context, Effect } from "effect";

import type {
  DecimalUint64,
  Sha256Digest,
  TruthEnvironmentId,
  TruthIsoTimestamp,
} from "./schemas/common.js";
import type {
  TruthIntegrityError,
  TruthRegistryError,
  TruthTransportError,
  TruthTrustError,
} from "./errors.js";
import type {
  TruthAuditEventV1,
  TruthGenerationActivationV1,
  TruthRevocationRecordV1,
} from "./schemas/registry.js";

export interface TruthRegistryStoreService {
  readonly putObjectIfAbsent: (
    environment: TruthEnvironmentId,
    digest: Sha256Digest,
    canonicalBytes: Uint8Array,
  ) => Effect.Effect<void, TruthRegistryError | TruthIntegrityError>;
  readonly readObject: (
    environment: TruthEnvironmentId,
    digest: Sha256Digest,
  ) => Effect.Effect<Uint8Array, TruthRegistryError>;
  readonly appendAuditEvent: (
    event: TruthAuditEventV1,
  ) => Effect.Effect<
    void,
    TruthRegistryError | TruthIntegrityError | TruthTrustError
  >;
  readonly readAuditEvents: (
    environment: TruthEnvironmentId,
  ) => Effect.Effect<
    ReadonlyArray<TruthAuditEventV1>,
    TruthRegistryError | TruthIntegrityError | TruthTrustError
  >;
  readonly readRoot: (
    environment: TruthEnvironmentId,
  ) => Effect.Effect<TruthGenerationActivationV1, TruthRegistryError>;
  readonly compareAndSwapRoot: (
    environment: TruthEnvironmentId,
    expectedGeneration: DecimalUint64,
    activation: TruthGenerationActivationV1,
  ) => Effect.Effect<
    void,
    TruthRegistryError | TruthIntegrityError | TruthTrustError
  >;
  readonly readActiveGeneration: (
    environment: TruthEnvironmentId,
  ) => Effect.Effect<DecimalUint64, TruthRegistryError>;
  readonly appendRevocation: (
    revocation: TruthRevocationRecordV1,
  ) => Effect.Effect<void, TruthRegistryError>;
  readonly readRevocations: (
    environment: TruthEnvironmentId,
  ) => Effect.Effect<ReadonlyArray<TruthRevocationRecordV1>, TruthRegistryError>;
}

export const TruthRegistryStore = Context.GenericTag<TruthRegistryStoreService>(
  "sonar/truth-contract/TruthRegistryStore",
);

export interface TruthSignerService {
  readonly keyId: string;
  readonly sign: (
    environment: TruthEnvironmentId,
    payload: Uint8Array,
  ) => Effect.Effect<string, TruthTrustError>;
  readonly verify: (
    environment: TruthEnvironmentId,
    payload: Uint8Array,
    signature: string,
  ) => Effect.Effect<void, TruthTrustError | TruthIntegrityError>;
}

export const TruthSigner = Context.GenericTag<TruthSignerService>(
  "sonar/truth-contract/TruthSigner",
);

export interface TruthClockService {
  readonly now: Effect.Effect<TruthIsoTimestamp, TruthTransportError>;
  readonly unixMilliseconds: Effect.Effect<DecimalUint64, TruthTransportError>;
}

export const TruthClock = Context.GenericTag<TruthClockService>(
  "sonar/truth-contract/TruthClock",
);

export interface SourceEvidenceReaderService {
  readonly read: (
    sourceId: string,
    snapshotId: string,
  ) => Effect.Effect<ReadonlyArray<Uint8Array>, TruthTransportError>;
}

export const SourceEvidenceReader = Context.GenericTag<SourceEvidenceReaderService>(
  "sonar/truth-contract/SourceEvidenceReader",
);

export interface RevocationReaderService {
  readonly latestEpoch: Effect.Effect<DecimalUint64, TruthTransportError | TruthTrustError>;
  readonly readRange: (
    fromInclusive: DecimalUint64,
    toInclusive: DecimalUint64,
  ) => Effect.Effect<ReadonlyArray<Uint8Array>, TruthTransportError | TruthTrustError>;
}

export const RevocationReader = Context.GenericTag<RevocationReaderService>(
  "sonar/truth-contract/RevocationReader",
);
