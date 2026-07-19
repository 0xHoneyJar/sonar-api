import { Effect, Either, Exit } from "effect";
import { describe, expect, it } from "vitest";

import {
  TRUTH_CONTRACT_PROTOCOL,
  TRUTH_NORMATIVE_OBJECT_KINDS,
  RevocationReader,
  SourceEvidenceReader,
  TruthClock,
  TruthIntegrityError,
  TruthRegistryError,
  TruthRegistryStore,
  TruthSigner,
  TruthTrustError,
  compileTruthBundleRoot,
  compileTruthAuditEvent,
  compileTruthGenerationActivation,
  makeHermeticTruthLayers,
  makeInMemoryTruthRegistryStore,
  makeFixtureTruthSigner,
  makeTruthActivationVerifier,
  makeTruthAuditVerifier,
  sourceEvidenceFixtureKey,
  inMemorySourceEvidenceReaderLayer,
} from "../src/truth-contract/index.js";
import {
  fixtureSigners,
  jcsCanonicalize,
  sha256Hex,
} from "../src/collection-resolver/trust-protocol.js";

const encoder = new TextEncoder();
const signer = fixtureSigners().sonarPrimary;
const signerService = makeFixtureTruthSigner(signer, signer.publicKeyHex());
const makeStore = () =>
  makeInMemoryTruthRegistryStore(
    makeTruthActivationVerifier(
      signerService,
      "2026-07-19T04:00:00.000Z" as never,
    ),
    makeTruthAuditVerifier(signerService),
  );

const expectFailure = <A, E>(effect: Effect.Effect<A, E>): E => {
  const exit = Effect.runSyncExit(effect);
  if (Exit.isSuccess(exit)) throw new Error("expected typed failure");
  if (exit.cause._tag !== "Fail") throw new Error(`expected Fail, got ${exit.cause._tag}`);
  return exit.cause.error;
};

const makeRoot = (generation: string, supersedes: string | null) => {
  const objects = TRUTH_NORMATIVE_OBJECT_KINDS.map((kind) => {
    const bytes = encoder.encode(`registry:${generation}:${kind}`);
    return {
      kind,
      media_type: "application/json",
      sha256: sha256Hex(bytes),
      byte_length: bytes.byteLength.toString(),
    };
  });
  const byKind = new Map(objects.map((object) => [object.kind, object]));
  return Effect.runSync(
    compileTruthBundleRoot(
      {
        schema_version: 1,
        protocol: TRUTH_CONTRACT_PROTOCOL,
        environment: "staging",
        generation,
        supersedes_generation: supersedes,
        objects,
        issuer: { service_id: "sonar-api", key_id: signer.keyId },
        issued_at: "2026-07-19T04:00:00.000Z",
        valid_from: "2026-07-19T04:00:00.000Z",
        compatibility_version: "sonar-score.v1",
        authority_matrix_hash: byKind.get("authority_matrix")!.sha256,
        security_profile_hash: byKind.get("security_profile")!.sha256,
      },
      signer,
    ),
  );
};

const makeActivation = (generation: string, prior: string): any => {
  const root = makeRoot(generation, prior === "0" ? null : prior);
  return Effect.runSync(
    compileTruthGenerationActivation(
      {
      schema_version: 1,
      protocol: TRUTH_CONTRACT_PROTOCOL,
      environment: "staging",
      prior_generation: prior,
      generation,
      root,
      audit_sequence: generation,
      audit_prior_record_sha256:
        prior === "0"
          ? null
          : sha256Hex(
              jcsCanonicalize(
                auditEventFor(
                  makeActivation(
                    prior,
                    (BigInt(prior) - 1n).toString(),
                  ),
                ),
              ),
            ),
      audit_recorded_at: "2026-07-19T04:00:00.000Z",
      prepared_at: "2026-07-19T04:00:00.000Z",
      issuer: { service_id: "sonar-api", key_id: signer.keyId },
      },
      signerService,
      "2026-07-19T04:00:00.000Z" as never,
    ),
  );
};

const auditEventFor = (activation: ReturnType<typeof makeActivation>) =>
  Effect.runSync(
    compileTruthAuditEvent(
      {
        schema_version: 1,
        protocol: TRUTH_CONTRACT_PROTOCOL,
        environment: "staging",
        sequence: activation.unsigned_activation.audit_sequence,
        kind: "GENERATION_ACTIVATED",
        generation: activation.unsigned_activation.generation,
        subject_hash: activation.activation_hash,
        prior_record_sha256:
          activation.unsigned_activation.audit_prior_record_sha256,
        recorded_at: activation.unsigned_activation.audit_recorded_at,
        issuer_key_id: signerService.keyId,
      },
      signerService,
    ),
  );

const prepareActivation = (
  store: ReturnType<typeof makeStore>,
  activation: ReturnType<typeof makeActivation>,
) => {
  const generation = activation.unsigned_activation.generation;
  for (const object of activation.unsigned_activation.root.unsigned_root.objects) {
    const bytes = encoder.encode(`registry:${generation}:${object.kind}`);
    Effect.runSync(store.putObjectIfAbsent("staging", object.sha256, bytes));
  }
  Effect.runSync(
    store.appendAuditEvent(auditEventFor(activation) as never),
  );
};

describe("in-memory truth registry", () => {
  it("keeps immutable content addressed objects and defensive read copies", () => {
    const store = makeStore();
    const bytes = encoder.encode('{"canonical":true}');
    const digest = sha256Hex(bytes) as never;

    Effect.runSync(store.putObjectIfAbsent("staging", digest, bytes));
    Effect.runSync(store.putObjectIfAbsent("staging", digest, bytes));
    const first = Effect.runSync(store.readObject("staging", digest));
    first[0] = 0;
    expect(Effect.runSync(store.readObject("staging", digest))).toEqual(bytes);

    expect(
      expectFailure(
        store.putObjectIfAbsent("staging", "0".repeat(64) as never, bytes),
      ),
    ).toBeInstanceOf(TruthIntegrityError);
  });

  it("requires contiguous audit and revocation sequences", () => {
    const store = makeStore();
    const event = Effect.runSync(
      compileTruthAuditEvent(
        {
          schema_version: 1,
          protocol: TRUTH_CONTRACT_PROTOCOL,
          environment: "staging",
          sequence: "1",
          kind: "GENERATION_PREPARED",
          generation: "1",
          subject_hash: "0".repeat(64),
          prior_record_sha256: null,
          recorded_at: "2026-07-19T04:00:00.000Z",
          issuer_key_id: signerService.keyId,
        },
        signerService,
      ),
    );
    Effect.runSync(store.appendAuditEvent(event));
    expect(Effect.runSync(store.readAuditEvents("staging"))).toEqual([event]);
    expect(expectFailure(store.appendAuditEvent(event))).toBeInstanceOf(
      TruthRegistryError,
    );
  });

  it("linearizes genesis races and advances only by exact contiguous CAS", async () => {
    const store = makeStore();
    const genesis = makeActivation("1", "0");
    prepareActivation(store, genesis);
    const [left, right] = await Promise.all([
      Effect.runPromise(Effect.either(store.compareAndSwapRoot("staging", "0" as never, genesis))),
      Effect.runPromise(Effect.either(store.compareAndSwapRoot("staging", "0" as never, genesis))),
    ]);
    const outcomes = [left, right];
    expect(outcomes.filter(Either.isRight)).toHaveLength(1);
    expect(outcomes.filter(Either.isLeft)).toHaveLength(1);
    expect(Effect.runSync(store.readActiveGeneration("staging"))).toBe("1");

    const generationTwo = makeActivation("2", "1");
    prepareActivation(store, generationTwo);
    Effect.runSync(
      store.compareAndSwapRoot("staging", "1" as never, generationTwo),
    );
    expect(Effect.runSync(store.readActiveGeneration("staging"))).toBe("2");

    const gap = makeActivation("4", "3");
    expect(
      expectFailure(
        store.compareAndSwapRoot("staging", "2" as never, gap),
      ),
    ).toBeInstanceOf(TruthTrustError);
  });
});

describe("truth service layers", () => {
  it("provides all five focused services through one hermetic boundary layer", () => {
    const program = Effect.gen(function* () {
      const store = yield* TruthRegistryStore;
      const fixtureSigner = yield* TruthSigner;
      const clock = yield* TruthClock;
      const source = yield* SourceEvidenceReader;
      const revocations = yield* RevocationReader;
      return {
        store,
        signerKey: fixtureSigner.keyId,
        now: yield* clock.now,
        source,
        epoch: yield* revocations.latestEpoch,
      };
    }).pipe(
      Effect.provide(
        makeHermeticTruthLayers(
          "2026-07-19T04:00:00.000Z" as never,
          "1784433600000" as never,
        ),
      ),
    );
    const result = Effect.runSync(program);
    expect(result.signerKey).toBe(signer.keyId);
    expect(result.now).toBe("2026-07-19T04:00:00.000Z");
    expect(result.epoch).toBe("0");
    expect(result.store).toBeDefined();
    expect(result.source).toBeDefined();
  });

  it("does not alias source evidence fixture bytes", () => {
    const bytes = encoder.encode("source-record");
    const key = sourceEvidenceFixtureKey("source-a", "snapshot-1");
    const effect = Effect.gen(function* () {
      const source = yield* SourceEvidenceReader;
      return yield* source.read("source-a", "snapshot-1");
    }).pipe(
      Effect.provide(
        inMemorySourceEvidenceReaderLayer(new Map([[key, [bytes]]])),
      ),
    );
    const result = Effect.runSync(effect);
    result[0]![0] = 0;
    expect(bytes[0]).not.toBe(0);
  });
});
