import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Either, Exit } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import {
  TRUTH_CONTRACT_PROTOCOL,
  TRUTH_NORMATIVE_OBJECT_KINDS,
  TruthIntegrityError,
  TruthRegistryError,
  compileEmergencyRevocation,
  compileTruthAuditEvent,
  compileTruthBundleRoot,
  compileTruthGenerationActivation,
  makeFixtureTruthSigner,
  makeFilesystemRevocationConsumerBaselineStore,
  makeFilesystemTruthAuditTailBaselineStore,
  makeInMemoryTrustedGenerationStore,
  makeTruthActivationVerifier,
  makeTruthAuditVerifier,
  evaluateFilesystemCertification,
  makeUnqualifiedLocalFilesystemTruthRegistryStore,
  openCertifiedFilesystemTruthRegistryStore,
  provisionFilesystemRevocationConsumerBaseline,
  provisionFilesystemTruthAuditTailBaseline,
  rebuildTruthRegistryStatusProjection,
  verifyEmergencyRevocation,
} from "../src/truth-contract/index.js";
import {
  applyAuthorizedTrustedGenerationAdvance,
  applyAuthorizedTrustedGenerationBootstrap,
} from "../src/truth-contract/trust-state-store.js";
import {
  fixtureSigners,
  jcsCanonicalize,
  sha256Hex,
} from "../src/collection-resolver/trust-protocol.js";

const roots: string[] = [];
const trustedStores = new Map<
  string,
  ReturnType<typeof makeInMemoryTrustedGenerationStore>
>();
const auditBaselines = new Map<
  string,
  ReturnType<typeof makeFilesystemTruthAuditTailBaselineStore>
>();
const makeRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), "sonar-truth-registry-"));
  roots.push(root);
  return root;
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  trustedStores.clear();
  auditBaselines.clear();
});

const signer = fixtureSigners().sonarPrimary;
const signerService = makeFixtureTruthSigner(signer, signer.publicKeyHex());
const governanceSigner = fixtureSigners().sonarRotated;
const governanceSignerService = makeFixtureTruthSigner(
  governanceSigner,
  governanceSigner.publicKeyHex(),
);
const activationVerifier = makeTruthActivationVerifier(
  signerService,
  "2026-07-19T04:00:00.000Z" as never,
);
const auditVerifier = makeTruthAuditVerifier(
  signerService,
  governanceSignerService,
);

const activation = (generation: string, prior: string): any => {
  const objects = TRUTH_NORMATIVE_OBJECT_KINDS.map((kind) => {
    const bytes = new TextEncoder().encode(`filesystem:${generation}:${kind}`);
    return {
      kind,
      media_type: "application/json",
      sha256: sha256Hex(bytes),
      byte_length: bytes.byteLength.toString(),
    };
  });
  const byKind = new Map(objects.map((object) => [object.kind, object]));
  const root = Effect.runSync(
    compileTruthBundleRoot(
      {
        schema_version: 1,
        protocol: TRUTH_CONTRACT_PROTOCOL,
        environment: "staging",
        generation,
        supersedes_generation: prior === "0" ? null : prior,
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
                  activation(
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

const auditEventFor = (value: ReturnType<typeof activation>) =>
  Effect.runSync(
    compileTruthAuditEvent(
      {
        schema_version: 1,
        protocol: TRUTH_CONTRACT_PROTOCOL,
        environment: "staging",
        sequence: value.unsigned_activation.audit_sequence,
        kind: "GENERATION_ACTIVATED",
        generation: value.unsigned_activation.generation,
        subject_hash: value.activation_hash,
        prior_record_sha256:
          value.unsigned_activation.audit_prior_record_sha256,
        recorded_at: value.unsigned_activation.audit_recorded_at,
        issuer_key_id: signerService.keyId,
      },
      signerService,
    ),
  );

const revocation = (
  sequence: string,
  targetId = `artifact-${sequence}`,
): any =>
  Effect.runSync(
    compileEmergencyRevocation(
      {
        schema_version: 1,
        protocol: TRUTH_CONTRACT_PROTOCOL,
        environment: "staging",
        sequence,
        prior_record_sha256:
          sequence === "1"
            ? null
            : sha256Hex(
                jcsCanonicalize(
                  revocation(
                    (BigInt(sequence) - 1n).toString(),
                  ),
                ),
              ),
        event_id: `revocation-${sequence}`,
        target_kind: "artifact",
        target_id: targetId,
        compromised_from: "2026-07-19T04:00:00.000Z",
        revoked_at: "2026-07-19T04:01:00.000Z",
        reason: "filesystem log fixture",
        issuer_key_id: signerService.keyId,
        epoch: "1",
      },
      signerService,
      new Set(),
    ),
  );

const trustedStoreFor = (root: string) => {
  const existing = trustedStores.get(root);
  if (existing !== undefined) return existing;
  const created = makeInMemoryTrustedGenerationStore();
  trustedStores.set(root, created);
  return created;
};

const auditBaselineFor = (root: string) => {
  const existing = auditBaselines.get(root);
  if (existing !== undefined) return existing;
  const baselineRoot = makeRoot();
  provisionFilesystemTruthAuditTailBaseline(baselineRoot, {
    environment: "staging",
    sequence: "0" as never,
    recordSha256: null,
  });
  const created = makeFilesystemTruthAuditTailBaselineStore(
    baselineRoot,
    "staging",
  );
  auditBaselines.set(root, created);
  return created;
};

const makeStore = (root: string, afterAuditChainVerified?: () => void) =>
  makeUnqualifiedLocalFilesystemTruthRegistryStore(
    root,
    activationVerifier,
    trustedStoreFor(root),
    auditVerifier,
    auditBaselineFor(root),
    afterAuditChainVerified,
  );

const bootstrapTrustedGeneration = (
  root: string,
  value: ReturnType<typeof activation>,
) =>
  Effect.runSync(
    applyAuthorizedTrustedGenerationBootstrap(trustedStoreFor(root), {
      environment: "staging",
      generation: value.unsigned_activation.generation,
      recoveryNonce: "0",
      trustedRootHash: value.unsigned_activation.root.root_hash,
      bootstrapDigest: "b".repeat(64),
      bootstrapBindingDigest: "c".repeat(64),
      bootstrapEquivocationSequence: "0",
      bootstrapEquivocationDigest: null,
      updatedAt: "2026-07-19T04:00:00.000Z" as never,
    }),
  );

const advanceTrustedGeneration = (
  root: string,
  prior: ReturnType<typeof activation>,
  value: ReturnType<typeof activation>,
) =>
  Effect.runSync(
    applyAuthorizedTrustedGenerationAdvance(trustedStoreFor(root), {
      environment: "staging",
      expectedGeneration: prior.unsigned_activation.generation,
      nextGeneration: value.unsigned_activation.generation,
      expectedRecoveryNonce: "0",
      nextRecoveryNonce: "0",
      expectedRootHash: prior.unsigned_activation.root.root_hash,
      nextRootHash: value.unsigned_activation.root.root_hash,
      bootstrapDigest: "b".repeat(64),
      bootstrapBindingDigest: "c".repeat(64),
      bootstrapEquivocationSequence: "0",
      bootstrapEquivocationDigest: null,
      updatedAt: "2026-07-19T04:00:00.000Z" as never,
    }),
  );

const prepareActivation = (
  store: ReturnType<typeof makeStore>,
  value: ReturnType<typeof activation>,
) => {
  const generation = value.unsigned_activation.generation;
  for (const object of value.unsigned_activation.root.unsigned_root.objects) {
    const bytes = new TextEncoder().encode(
      `filesystem:${generation}:${object.kind}`,
    );
    Effect.runSync(store.putObjectIfAbsent("staging", object.sha256, bytes));
  }
  Effect.runSync(
    store.appendAuditEvent(auditEventFor(value) as never),
  );
};

const certificate = (
  filesystemType: string,
  overrides: Record<string, unknown> = {},
) => ({
  schema_version: 1,
  status: "QUALIFIED",
  validity: "STAGED_VALID",
  runner_id: "dedicated-runner-1",
  dedicated_runner: true,
  fingerprint: {
    os: filesystemType === "apfs" ? "darwin" : "linux",
    kernel: "fixture-kernel",
    mount_point: "/fixture",
    mount_identity: "fixture-device",
    filesystem_type: filesystemType,
    mount_options: ["local", "journaled"],
    storage_topology: "fixture topology",
  },
  adapter_sha256: "a".repeat(64),
  probes: {
    exclusive_create: true,
    advisory_lock: true,
    same_directory_rename: true,
    file_fsync: true,
    directory_fsync: true,
    stale_lock_recovery: true,
    genesis_race: true,
    process_crash_injection: true,
    full_fsync: filesystemType === "apfs",
    block_layer_fault_injection: filesystemType === "ext4",
  },
  qualified_at: "2026-07-19T04:00:00.000Z",
  reasons: [],
  ...overrides,
});

const expectFailure = <A, E>(effect: Effect.Effect<A, E>): E => {
  const exit = Effect.runSyncExit(effect);
  if (Exit.isSuccess(exit)) throw new Error("expected typed failure");
  if (exit.cause._tag !== "Fail") throw new Error(`expected Fail, got ${exit.cause._tag}`);
  return exit.cause.error;
};

describe("unqualified local filesystem registry fixture", () => {
  it("durably writes immutable objects and a complete prepared activation before pointer", () => {
    const root = makeRoot();
    const store = makeStore(root);
    const bytes = new TextEncoder().encode('{"fixture":true}');
    const digest = sha256Hex(bytes) as never;
    Effect.runSync(store.putObjectIfAbsent("staging", digest, bytes));
    expect(Effect.runSync(store.readObject("staging", digest))).toEqual(bytes);

    const genesis = activation("1", "0");
    prepareActivation(store, genesis);
    Effect.runSync(
      store.compareAndSwapRoot("staging", "0" as never, genesis),
    );
    bootstrapTrustedGeneration(root, genesis);
    expect(Effect.runSync(store.readActiveGeneration("staging"))).toBe("1");
    expect(Effect.runSync(store.readRoot("staging"))).toEqual(genesis);
    expect(
      JSON.parse(
        readFileSync(join(root, "environments/staging/current.json"), "utf8"),
      ).generation,
    ).toBe("1");
  });

  it("allows exactly one genesis winner and rejects gaps", async () => {
    const root = makeRoot();
    const leftStore = makeStore(root);
    const rightStore = makeStore(root);
    const genesis = activation("1", "0");
    prepareActivation(leftStore, genesis);
    const results = await Promise.all([
      Effect.runPromise(
        Effect.either(
          leftStore.compareAndSwapRoot("staging", "0" as never, genesis),
        ),
      ),
      Effect.runPromise(
        Effect.either(
          rightStore.compareAndSwapRoot("staging", "0" as never, genesis),
        ),
      ),
    ]);
    expect(results.filter(Either.isRight)).toHaveLength(1);
    expect(results.filter(Either.isLeft)).toHaveLength(1);
    expect(
      expectFailure(
        leftStore.compareAndSwapRoot(
          "staging",
          "1" as never,
          activation("3", "2"),
        ),
      ),
    ).toBeDefined();
  });

  it("keeps concurrent identical object puts idempotent", async () => {
    const root = makeRoot();
    const leftStore = makeStore(root);
    const rightStore = makeStore(root);
    const bytes = new TextEncoder().encode('{"same":"object"}');
    const digest = sha256Hex(bytes) as never;
    await Promise.all([
      Effect.runPromise(leftStore.putObjectIfAbsent("staging", digest, bytes)),
      Effect.runPromise(rightStore.putObjectIfAbsent("staging", digest, bytes)),
    ]);
    expect(Effect.runSync(leftStore.readObject("staging", digest))).toEqual(
      bytes,
    );
  });

  it("fails closed when a pointer is corrupt or its prepared activation is absent", () => {
    const root = makeRoot();
    const store = makeStore(root);
    const genesis = activation("1", "0");
    prepareActivation(store, genesis);
    Effect.runSync(
      store.compareAndSwapRoot("staging", "0" as never, genesis),
    );
    bootstrapTrustedGeneration(root, genesis);
    writeFileSync(
      join(root, "environments/staging/current.json"),
      '{"activation_sha256":"bad","generation":"2"}',
    );
    expect(expectFailure(store.readRoot("staging"))).toBeInstanceOf(
      TruthRegistryError,
    );
  });

  it("detects audit gaps and re-verifies active activation signatures on read", () => {
    const root = makeRoot();
    const store = makeStore(root);
    const genesis = activation("1", "0");
    prepareActivation(store, genesis);
    Effect.runSync(
      store.compareAndSwapRoot("staging", "0" as never, genesis),
    );
    bootstrapTrustedGeneration(root, genesis);
    writeFileSync(
      join(root, "environments/staging/audit/3.json"),
      JSON.stringify({
        schema_version: 1,
        protocol: TRUTH_CONTRACT_PROTOCOL,
        environment: "staging",
        sequence: "3",
        kind: "TRUST_UPDATED",
        generation: "1",
        subject_hash: "0".repeat(64),
        prior_record_sha256: null,
        recorded_at: "2026-07-19T04:00:00.000Z",
      }),
    );
    expect(expectFailure(store.readAuditEvents("staging"))).toBeInstanceOf(
      TruthRegistryError,
    );
    rmSync(join(root, "environments/staging/audit/3.json"));

    const forged = structuredClone(genesis);
    forged.signature = "A".repeat(86) as never;
    const activationBytes = new TextEncoder().encode(jcsCanonicalize(forged));
    writeFileSync(
      join(root, "environments/staging/prepared/1.json"),
      activationBytes,
    );
    writeFileSync(
      join(root, "environments/staging/current.json"),
      jcsCanonicalize({
        activation_sha256: sha256Hex(activationBytes),
        generation: "1",
      }),
    );
    expect(expectFailure(store.readRoot("staging"))).toBeInstanceOf(
      TruthRegistryError,
    );
  });

  it("rejects pointer rollback against the trusted generation and root", () => {
    const root = makeRoot();
    const store = makeStore(root);
    const genesis = activation("1", "0");
    prepareActivation(store, genesis);
    Effect.runSync(store.compareAndSwapRoot("staging", "0" as never, genesis));
    bootstrapTrustedGeneration(root, genesis);
    const genesisPointer = readFileSync(
      join(root, "environments/staging/current.json"),
      "utf8",
    );

    const next = activation("2", "1");
    prepareActivation(store, next);
    Effect.runSync(store.compareAndSwapRoot("staging", "1" as never, next));
    advanceTrustedGeneration(root, genesis, next);
    expect(Effect.runSync(store.readActiveGeneration("staging"))).toBe("2");

    writeFileSync(
      join(root, "environments/staging/current.json"),
      genesisPointer,
    );
    expect(expectFailure(store.readRoot("staging"))).toBeInstanceOf(
      TruthRegistryError,
    );
    expect(
      expectFailure(store.readActiveGeneration("staging")),
    ).toBeInstanceOf(TruthRegistryError);
  });

  it("rechecks the full closure after CAS and detects object deletion", () => {
    const root = makeRoot();
    const store = makeStore(root);
    const genesis = activation("1", "0");
    prepareActivation(store, genesis);
    Effect.runSync(store.compareAndSwapRoot("staging", "0" as never, genesis));
    bootstrapTrustedGeneration(root, genesis);
    const object = genesis.unsigned_activation.root.unsigned_root.objects[0]!;
    rmSync(join(root, "environments/staging/objects", object.sha256));
    expect(expectFailure(store.readRoot("staging"))).toBeInstanceOf(
      TruthRegistryError,
    );
  });

  it("detects post-CAS audit tail deletion and replacement", () => {
    const deletedRoot = makeRoot();
    const deletedStore = makeStore(deletedRoot);
    const deletedGenesis = activation("1", "0");
    prepareActivation(deletedStore, deletedGenesis);
    Effect.runSync(
      deletedStore.compareAndSwapRoot(
        "staging",
        "0" as never,
        deletedGenesis,
      ),
    );
    bootstrapTrustedGeneration(deletedRoot, deletedGenesis);
    rmSync(join(deletedRoot, "environments/staging/audit/1.json"));
    expect(expectFailure(deletedStore.readRoot("staging"))).toBeInstanceOf(
      TruthRegistryError,
    );

    const replacedRoot = makeRoot();
    const replacedStore = makeStore(replacedRoot);
    const replacedGenesis = activation("1", "0");
    prepareActivation(replacedStore, replacedGenesis);
    Effect.runSync(
      replacedStore.compareAndSwapRoot(
        "staging",
        "0" as never,
        replacedGenesis,
      ),
    );
    bootstrapTrustedGeneration(replacedRoot, replacedGenesis);
    writeFileSync(
      join(replacedRoot, "environments/staging/audit/1.json"),
      jcsCanonicalize({
        schema_version: 1,
        protocol: TRUTH_CONTRACT_PROTOCOL,
        environment: "staging",
        sequence: "1",
        kind: "GENERATION_ACTIVATED",
        generation: "1",
        subject_hash: "0".repeat(64),
        recorded_at: "2026-07-19T04:00:00.000Z",
      }),
    );
    expect(expectFailure(replacedStore.readRoot("staging"))).toBeInstanceOf(
      TruthRegistryError,
    );
  });

  it("rejects coordinated audit-tail and adjacent-head rollback against the signed active generation", () => {
    const root = makeRoot();
    const store = makeStore(root);
    const genesis = activation("1", "0");
    prepareActivation(store, genesis);
    Effect.runSync(store.compareAndSwapRoot("staging", "0" as never, genesis));
    bootstrapTrustedGeneration(root, genesis);
    const next = activation("2", "1");
    prepareActivation(store, next);
    Effect.runSync(store.compareAndSwapRoot("staging", "1" as never, next));
    advanceTrustedGeneration(root, genesis, next);

    rmSync(join(root, "environments/staging/audit/2.json"));
    const firstBytes = readFileSync(
      join(root, "environments/staging/audit/1.json"),
    );
    writeFileSync(
      join(root, "environments/staging/audit-head.json"),
      jcsCanonicalize({
        sequence: "1",
        record_sha256: sha256Hex(firstBytes),
      }),
    );
    expect(expectFailure(store.readRoot("staging"))).toBeInstanceOf(
      TruthRegistryError,
    );
  });

  it("accepts chained post-activation audits and rejects rewritten signed history", () => {
    const root = makeRoot();
    const store = makeStore(root);
    const genesis = activation("1", "0");
    prepareActivation(store, genesis);
    Effect.runSync(store.compareAndSwapRoot("staging", "0" as never, genesis));
    bootstrapTrustedGeneration(root, genesis);
    const activationAuditBytes = readFileSync(
      join(root, "environments/staging/audit/1.json"),
    );
    const trustUpdate = Effect.runSync(
      compileTruthAuditEvent(
        {
          schema_version: 1,
          protocol: TRUTH_CONTRACT_PROTOCOL,
          environment: "staging",
          sequence: "2",
          kind: "TRUST_UPDATED",
          generation: "1",
          subject_hash: sha256Hex("trust-update"),
          prior_record_sha256: sha256Hex(activationAuditBytes),
          recorded_at: "2026-07-19T04:01:00.000Z",
          issuer_key_id: governanceSignerService.keyId,
        },
        governanceSignerService,
      ),
    );
    Effect.runSync(
      store.appendAuditEvent(
        trustUpdate,
      ),
    );
    expect(Effect.runSync(store.readRoot("staging"))).toEqual(genesis);

    const activationAuditPath = join(
      root,
      "environments/staging/audit/1.json",
    );
    writeFileSync(
      activationAuditPath,
      jcsCanonicalize({
        ...auditEventFor(genesis),
        recorded_at: "2026-07-19T04:00:01.000Z",
      }),
    );
    expect(expectFailure(store.readRoot("staging"))).toBeInstanceOf(
      TruthRegistryError,
    );
    writeFileSync(activationAuditPath, activationAuditBytes);

    rmSync(join(root, "environments/staging/audit/2.json"));
    writeFileSync(
      join(root, "environments/staging/audit-head.json"),
      jcsCanonicalize({
        sequence: "1",
        record_sha256: sha256Hex(activationAuditBytes),
      }),
    );
    expect(expectFailure(store.readRoot("staging"))).toBeInstanceOf(
      TruthRegistryError,
    );
  });

  it("rejects a forged audit suffix and a structural baseline imposter", () => {
    const root = makeRoot();
    const baselineImposter = {
      read: () => ({
        environment: "staging",
        sequence: "0",
        recordSha256: null,
      }),
      advance: () => undefined,
    } as never;
    expect(() =>
      makeUnqualifiedLocalFilesystemTruthRegistryStore(
        root,
        activationVerifier,
        trustedStoreFor(root),
        auditVerifier,
        baselineImposter,
      ),
    ).toThrow(/module-provisioned filesystem capability/);

    const store = makeStore(root);
    const genesis = activation("1", "0");
    const signed = auditEventFor(genesis);
    expect(
      expectFailure(
        store.appendAuditEvent({
          ...signed,
          subject_hash: sha256Hex("storage-writer-forgery"),
        }),
      ),
    ).toBeInstanceOf(TruthRegistryError);
  });

  it("rejects an alternate signed audit prefix with a valid signed suffix", () => {
    const root = makeRoot();
    const store = makeStore(root);
    const genesis = activation("1", "0");
    prepareActivation(store, genesis);

    const alternateFirst = Effect.runSync(
      compileTruthAuditEvent(
        {
          schema_version: 1,
          protocol: TRUTH_CONTRACT_PROTOCOL,
          environment: "staging",
          sequence: "1",
          kind: "GENERATION_PREPARED",
          generation: "1",
          subject_hash: sha256Hex("alternate-signed-prefix"),
          prior_record_sha256: null,
          recorded_at: "2026-07-19T04:00:01.000Z",
          issuer_key_id: signerService.keyId,
        },
        signerService,
      ),
    );
    const alternateFirstBytes = new TextEncoder().encode(
      jcsCanonicalize(alternateFirst),
    );
    const alternateSecond = Effect.runSync(
      compileTruthAuditEvent(
        {
          schema_version: 1,
          protocol: TRUTH_CONTRACT_PROTOCOL,
          environment: "staging",
          sequence: "2",
          kind: "TRUST_UPDATED",
          generation: "1",
          subject_hash: sha256Hex("alternate-signed-suffix"),
          prior_record_sha256: sha256Hex(alternateFirstBytes),
          recorded_at: "2026-07-19T04:01:00.000Z",
          issuer_key_id: governanceSignerService.keyId,
        },
        governanceSignerService,
      ),
    );
    const alternateSecondBytes = new TextEncoder().encode(
      jcsCanonicalize(alternateSecond),
    );
    writeFileSync(
      join(root, "environments/staging/audit/1.json"),
      alternateFirstBytes,
    );
    writeFileSync(
      join(root, "environments/staging/audit/2.json"),
      alternateSecondBytes,
    );
    writeFileSync(
      join(root, "environments/staging/audit-head.json"),
      jcsCanonicalize({
        sequence: "2",
        record_sha256: sha256Hex(alternateSecondBytes),
      }),
    );

    expect(
      expectFailure(store.readAuditEvents("staging")),
    ).toBeInstanceOf(TruthRegistryError);
  });

  it("binds audit verification and baseline advancement to one byte snapshot", () => {
    const root = makeRoot();
    let mutationArmed = false;
    let alternateFirstBytes = new Uint8Array();
    let alternateSecondBytes = new Uint8Array();
    const store = makeStore(root, () => {
      if (!mutationArmed) return;
      writeFileSync(
        join(root, "environments/staging/audit/1.json"),
        alternateFirstBytes,
      );
      writeFileSync(
        join(root, "environments/staging/audit/2.json"),
        alternateSecondBytes,
      );
      writeFileSync(
        join(root, "environments/staging/audit-head.json"),
        jcsCanonicalize({
          sequence: "2",
          record_sha256: sha256Hex(alternateSecondBytes),
        }),
      );
    });
    const genesis = activation("1", "0");
    prepareActivation(store, genesis);
    const originalFirstBytes = readFileSync(
      join(root, "environments/staging/audit/1.json"),
    );
    const originalSecond = Effect.runSync(
      compileTruthAuditEvent(
        {
          schema_version: 1,
          protocol: TRUTH_CONTRACT_PROTOCOL,
          environment: "staging",
          sequence: "2",
          kind: "TRUST_UPDATED",
          generation: "1",
          subject_hash: sha256Hex("original-signed-suffix"),
          prior_record_sha256: sha256Hex(originalFirstBytes),
          recorded_at: "2026-07-19T04:01:00.000Z",
          issuer_key_id: governanceSignerService.keyId,
        },
        governanceSignerService,
      ),
    );
    const originalSecondBytes = new TextEncoder().encode(
      jcsCanonicalize(originalSecond),
    );
    writeFileSync(
      join(root, "environments/staging/audit/2.json"),
      originalSecondBytes,
    );
    writeFileSync(
      join(root, "environments/staging/audit-head.json"),
      jcsCanonicalize({
        sequence: "2",
        record_sha256: sha256Hex(originalSecondBytes),
      }),
    );

    const alternateFirst = Effect.runSync(
      compileTruthAuditEvent(
        {
          schema_version: 1,
          protocol: TRUTH_CONTRACT_PROTOCOL,
          environment: "staging",
          sequence: "1",
          kind: "GENERATION_PREPARED",
          generation: "1",
          subject_hash: sha256Hex("racing-alternate-prefix"),
          prior_record_sha256: null,
          recorded_at: "2026-07-19T04:00:01.000Z",
          issuer_key_id: signerService.keyId,
        },
        signerService,
      ),
    );
    alternateFirstBytes = new TextEncoder().encode(
      jcsCanonicalize(alternateFirst),
    );
    const alternateSecond = Effect.runSync(
      compileTruthAuditEvent(
        {
          schema_version: 1,
          protocol: TRUTH_CONTRACT_PROTOCOL,
          environment: "staging",
          sequence: "2",
          kind: "TRUST_UPDATED",
          generation: "1",
          subject_hash: sha256Hex("racing-alternate-suffix"),
          prior_record_sha256: sha256Hex(alternateFirstBytes),
          recorded_at: "2026-07-19T04:01:01.000Z",
          issuer_key_id: governanceSignerService.keyId,
        },
        governanceSignerService,
      ),
    );
    alternateSecondBytes = new TextEncoder().encode(
      jcsCanonicalize(alternateSecond),
    );
    mutationArmed = true;

    expect(
      expectFailure(store.readAuditEvents("staging")),
    ).toBeInstanceOf(TruthRegistryError);
    expect(auditBaselineFor(root).read()).toEqual({
      environment: "staging",
      sequence: "1",
      recordSha256: sha256Hex(originalFirstBytes),
    });
  });

  it("strict-decodes audit input on append and again during CAS", () => {
    const root = makeRoot();
    const store = makeStore(root);
    expect(
      expectFailure(
        store.appendAuditEvent({
          schema_version: 1,
          protocol: TRUTH_CONTRACT_PROTOCOL,
          environment: "staging",
          sequence: "1",
          kind: "GENERATION_ACTIVATED",
          generation: "1",
          subject_hash: "not-a-digest",
          prior_record_sha256: null,
          recorded_at: "2026-07-19T04:00:00.000Z",
        } as never),
      ),
    ).toBeInstanceOf(TruthRegistryError);

    const genesis = activation("1", "0");
    prepareActivation(store, genesis);
    writeFileSync(
      join(root, "environments/staging/audit/1.json"),
      '{"schema_version":1,"unexpected":true}',
    );
    expect(
      expectFailure(
        store.compareAndSwapRoot("staging", "0" as never, genesis),
      ),
    ).toBeInstanceOf(TruthRegistryError);
  });

  it("detects revocation tail deletion, replacement, and sequence reuse", () => {
    const deletedRoot = makeRoot();
    const deletedStore = makeStore(deletedRoot);
    Effect.runSync(deletedStore.appendRevocation(revocation("1")));
    Effect.runSync(deletedStore.appendRevocation(revocation("2")));
    rmSync(join(deletedRoot, "environments/staging/revocations/2.json"));
    expect(
      expectFailure(deletedStore.readRevocations("staging")),
    ).toBeInstanceOf(TruthRegistryError);
    expect(
      expectFailure(
        deletedStore.appendRevocation(revocation("2", "replacement")),
      ),
    ).toBeInstanceOf(TruthRegistryError);

    const replacedRoot = makeRoot();
    const replacedStore = makeStore(replacedRoot);
    Effect.runSync(replacedStore.appendRevocation(revocation("1")));
    const second = revocation("2");
    Effect.runSync(replacedStore.appendRevocation(second));
    writeFileSync(
      join(replacedRoot, "environments/staging/revocations/2.json"),
      jcsCanonicalize({
        ...second,
        reason: "schema-valid tail replacement",
      }),
    );
    expect(
      expectFailure(replacedStore.readRevocations("staging")),
    ).toBeInstanceOf(TruthRegistryError);
  });

  it("rejects coordinated revocation-tail and adjacent-head rollback against an independent baseline", () => {
    const root = makeRoot();
    const store = makeStore(root);
    const genesis = activation("1", "0");
    prepareActivation(store, genesis);
    Effect.runSync(store.compareAndSwapRoot("staging", "0" as never, genesis));
    bootstrapTrustedGeneration(root, genesis);
    const first = revocation("1");
    const second = revocation("2");
    Effect.runSync(store.appendRevocation(first));
    Effect.runSync(store.appendRevocation(second));
    const expectedBaseline = {
      environment: "staging",
      generation: "1",
      revocationEpoch: "1",
      revocationSequence: "2",
      revocationRecordSha256: sha256Hex(jcsCanonicalize(second)),
    } as never;
    const baselineRoot = makeRoot();
    Effect.runSync(
      provisionFilesystemRevocationConsumerBaseline(
        baselineRoot,
        expectedBaseline,
      ),
    );
    const baselineStore = makeFilesystemRevocationConsumerBaselineStore(
      baselineRoot,
      "staging",
    );
    const rebuild = () =>
      rebuildTruthRegistryStatusProjection(
        store,
        "staging",
        baselineStore,
        (
          record,
          expectedSequence,
          expectedPriorRecordSha256,
          minimumEpoch,
        ) =>
          verifyEmergencyRevocation(
            record,
            signerService,
            "staging",
            expectedSequence,
            expectedPriorRecordSha256,
            minimumEpoch,
            new Set(),
          ),
      );
    expect(Effect.runSync(rebuild()).projection.revocation_sequence).toBe("2");

    writeFileSync(
      join(root, "environments/staging/revocations/1.json"),
      jcsCanonicalize(revocation("1", "alternate-artifact")),
    );
    expect(expectFailure(rebuild())).toBeInstanceOf(TruthRegistryError);
    writeFileSync(
      join(root, "environments/staging/revocations/1.json"),
      jcsCanonicalize(first),
    );

    rmSync(join(root, "environments/staging/revocations/2.json"));
    const firstBytes = readFileSync(
      join(root, "environments/staging/revocations/1.json"),
    );
    writeFileSync(
      join(root, "environments/staging/revocation-head.json"),
      jcsCanonicalize({
        sequence: "1",
        record_sha256: sha256Hex(firstBytes),
      }),
    );
    expect(expectFailure(rebuild())).toBeInstanceOf(TruthIntegrityError);
  });
});

describe("filesystem deployment certification gate", () => {
  it("rejects unsafe, unknown, and incompletely tested filesystems", () => {
    expect(
      expectFailure(evaluateFilesystemCertification(certificate("overlay"))),
    ).toBeInstanceOf(TruthRegistryError);
    expect(
      expectFailure(
        evaluateFilesystemCertification(
          certificate("ext4", {
            probes: {
              ...certificate("ext4").probes,
              block_layer_fault_injection: false,
            },
          }),
        ),
      ),
    ).toBeInstanceOf(TruthRegistryError);
    expect(
      expectFailure(
        evaluateFilesystemCertification({
          ...certificate("ext4"),
          validity: "FIXTURE_VALID",
        }),
      ),
    ).toBeInstanceOf(TruthRegistryError);
    const selfAttested = expectFailure(
      evaluateFilesystemCertification(certificate("ext4")),
    );
    expect(selfAttested).toBeInstanceOf(TruthRegistryError);
    if (!(selfAttested instanceof TruthRegistryError)) {
      throw new Error("expected TruthRegistryError");
    }
    expect(selfAttested.reason).toContain(
      "self-attested certification input is only an untrusted candidate",
    );
  });

  it("still refuses APFS because the Node adapter cannot issue F_FULLFSYNC", () => {
    const input = certificate("apfs");
    const root = makeRoot();
    const result = openCertifiedFilesystemTruthRegistryStore(
      root,
      input,
      input.fingerprint as never,
      input.adapter_sha256,
      activationVerifier,
      trustedStoreFor(root),
    );
    expect(expectFailure(result)).toBeInstanceOf(TruthRegistryError);
  });

  it("refuses even a shape-valid ext4 certificate without authenticated runner integration", () => {
    const input = certificate("ext4");
    const root = makeRoot();
    expect(
      expectFailure(
        openCertifiedFilesystemTruthRegistryStore(
          root,
          input,
          input.fingerprint as never,
          input.adapter_sha256,
          activationVerifier,
          trustedStoreFor(root),
        ),
      ),
    ).toBeInstanceOf(TruthRegistryError);
    const mismatchedRoot = makeRoot();
    expectFailure(
      openCertifiedFilesystemTruthRegistryStore(
        mismatchedRoot,
        input,
        { ...input.fingerprint, kernel: "different" } as never,
        input.adapter_sha256,
        activationVerifier,
        trustedStoreFor(mismatchedRoot),
      ),
    );
  });
});
