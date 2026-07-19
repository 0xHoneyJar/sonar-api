import { Effect, Layer } from "effect";

import {
  fixtureSigners,
  verifyEd25519Signature,
  type TrustEnvelopeSigner,
} from "../collection-resolver/trust-protocol.js";
import { TruthIntegrityError, TruthTransportError, TruthTrustError } from "./errors.js";
import { makeInMemoryTruthRegistryStore } from "./registry-store.js";
import { makeTruthActivationVerifier } from "./trust-control-plane.js";
import { makeTruthAuditVerifier } from "./audit-control-plane.js";
import {
  RevocationConsumerBaselineStore,
} from "./revocation-control-plane.js";
import {
  makeFilesystemRevocationConsumerBaselineStore,
} from "./revocation-baseline-store.js";
import type {
  DecimalUint64,
  TruthEnvironmentId,
  TruthIsoTimestamp,
} from "./schemas/common.js";
import {
  RevocationReader,
  SourceEvidenceReader,
  TruthClock,
  TruthRegistryStore,
  TruthSigner,
  type RevocationReaderService,
  type SourceEvidenceReaderService,
  type TruthClockService,
  type TruthSignerService,
} from "./services.js";

export const inMemoryTruthRegistryLayer = () => {
  const signer = makeFixtureTruthSigner(
    fixtureSigners().sonarPrimary,
    fixtureSigners().sonarPrimary.publicKeyHex(),
  );
  return Layer.succeed(
    TruthRegistryStore,
    makeInMemoryTruthRegistryStore(
      makeTruthActivationVerifier(
        signer,
        "2026-07-19T04:00:00.000Z" as never,
      ),
      makeTruthAuditVerifier(signer),
    ),
  );
};

export const makeFixtureTruthSigner = (
  signer: TrustEnvelopeSigner,
  publicKeyHex: string,
): TruthSignerService => ({
  keyId: signer.keyId,
  sign: (_environment, payload) =>
    Effect.try({
      try: () => signer.sign(payload),
      catch: () =>
        new TruthTrustError({
          boundary: "truth.signer.fixture.sign",
          reason: "fixture signer failed",
        }),
    }),
  verify: (_environment, payload, signature) =>
    verifyEd25519Signature(publicKeyHex, payload, signature)
      ? Effect.void
      : Effect.fail(
          new TruthIntegrityError({
            boundary: "truth.signer.fixture.verify",
            reason: "signature verification failed",
          }),
        ),
});

export const fixtureTruthSignerLayer = () => {
  const signer = fixtureSigners().sonarPrimary;
  return Layer.succeed(
    TruthSigner,
    makeFixtureTruthSigner(signer, signer.publicKeyHex()),
  );
};

export const fixedTruthClockLayer = (
  now: TruthIsoTimestamp,
  unixMilliseconds: DecimalUint64,
) =>
  Layer.succeed(TruthClock, {
    now: Effect.succeed(now),
    unixMilliseconds: Effect.succeed(unixMilliseconds),
  } satisfies TruthClockService);

export const failingTruthClockLayer = (reason: string) => {
  const failure = new TruthTransportError({
    boundary: "truth.clock",
    reason,
    retryable: false,
  });
  return Layer.succeed(TruthClock, {
    now: Effect.fail(failure),
    unixMilliseconds: Effect.fail(failure),
  } satisfies TruthClockService);
};

export const filesystemRevocationConsumerBaselineLayer = (
  root: string,
  environment: TruthEnvironmentId,
) =>
  Layer.succeed(
    RevocationConsumerBaselineStore,
    makeFilesystemRevocationConsumerBaselineStore(root, environment),
  );

const sourceKey = (sourceId: string, snapshotId: string): string =>
  `${sourceId}\0${snapshotId}`;

export const inMemorySourceEvidenceReaderLayer = (
  fixtures: ReadonlyMap<string, ReadonlyArray<Uint8Array>>,
) =>
  Layer.succeed(SourceEvidenceReader, {
    read: (sourceId, snapshotId) => {
      const records = fixtures.get(sourceKey(sourceId, snapshotId));
      return records === undefined
        ? Effect.fail(
            new TruthTransportError({
              boundary: "truth.source_evidence.in_memory",
              reason: "source snapshot is not present",
              retryable: false,
            }),
          )
        : Effect.succeed(records.map((record) => Uint8Array.from(record)));
    },
  } satisfies SourceEvidenceReaderService);

export const sourceEvidenceFixtureKey = sourceKey;

export const inMemoryRevocationReaderLayer = (
  records: ReadonlyMap<TruthEnvironmentId, ReadonlyArray<Uint8Array>>,
  epoch: DecimalUint64,
) =>
  Layer.succeed(RevocationReader, {
    latestEpoch: Effect.succeed(epoch),
    readRange: (fromInclusive, toInclusive) => {
      if (BigInt(toInclusive) < BigInt(fromInclusive)) {
        return Effect.fail(
          new TruthTransportError({
            boundary: "truth.revocation.in_memory",
            reason: "invalid replay range",
            retryable: false,
          }),
        );
      }
      const all = [...records.values()].flat();
      const from = Number(BigInt(fromInclusive) - 1n);
      const to = Number(BigInt(toInclusive));
      return Effect.succeed(
        all.slice(from, to).map((record) => Uint8Array.from(record)),
      );
    },
  } satisfies RevocationReaderService);

export const makeHermeticTruthLayers = (
  now: TruthIsoTimestamp,
  unixMilliseconds: DecimalUint64,
) =>
  Layer.mergeAll(
    inMemoryTruthRegistryLayer(),
    fixtureTruthSignerLayer(),
    fixedTruthClockLayer(now, unixMilliseconds),
    inMemorySourceEvidenceReaderLayer(new Map()),
    inMemoryRevocationReaderLayer(new Map(), "0" as DecimalUint64),
  );
