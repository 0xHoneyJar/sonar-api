import {
  mkdtempSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Either, Exit } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import {
  TRUTH_CONTRACT_PROTOCOL,
  TRUTH_NORMATIVE_OBJECT_KINDS,
  TruthTrustError,
  applyRecoveryCeremony,
  applyTrustBootstrapReceipt,
  applyTrustRotation,
  bootstrapIdentityBindingDigest,
  bootstrapObservationSigningBytes,
  compileTruthBundleRoot,
  compileTruthGenerationActivation,
  compileTrustBootstrap,
  makeFilesystemBootstrapEquivocationLedger,
  makeFilesystemTrustedGenerationStore,
  makeFixtureTruthSigner,
  makeInMemoryBootstrapEquivocationLedger,
  makeInMemoryRecoveryChallengeStore,
  makeInMemoryTrustedGenerationStore,
  provisionFilesystemTrustedGenerationEnvironment,
  quorumApprovalSigningBytes,
  recoveryChallengePayloadHash,
  recoveryAuthorizationPayloadHash,
  rotationTransitionPayloadHash,
  truthRootSigningBytes,
  initiateRecoveryChallenge,
  verifyQuorumApproval,
  verifyRecoveryCeremony,
  verifyRotationApproval,
  verifyTruthGenerationActivationForAdvance,
  verifyTrustBootstrapReceipt,
} from "../src/truth-contract/index.js";
import {
  applyAuthorizedTrustedGenerationAdvance,
  applyAuthorizedTrustedGenerationBootstrap,
} from "../src/truth-contract/trust-state-store.js";
import {
  fixtureSigners,
  jcsCanonicalize,
  LocalEd25519TrustSigner,
  sha256Hex,
  type TrustEnvelopeSigner,
} from "../src/collection-resolver/trust-protocol.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const signers = fixtureSigners();
const recoverySecond = LocalEd25519TrustSigner.fromSeedHex(
  "4444444444444444444444444444444444444444444444444444444444444444",
  "recovery-fixture-second",
);
const channelSigners = new Map([
  ["credential-a", signers.sonarPrimary],
  ["credential-b", recoverySecond],
]);
const channelCredentials = new Map(
  [...channelSigners].map(([credentialId, signer], index) => [
    credentialId,
    {
      keyId: signer.keyId,
      publicKeyHex: signer.publicKeyHex(),
      channelId: `release-channel-${index === 0 ? "a" : "b"}`,
      operatorId: `operator-${index === 0 ? "a" : "b"}`,
    },
  ]),
);
const key = (signer: TrustEnvelopeSigner) => ({
  key_id: signer.keyId,
  algorithm: "Ed25519",
  public_key_hex: signer.publicKeyHex(),
  valid_from: "2026-07-19T04:00:00.000Z",
  valid_until: null,
});

const bootstrapInput = () => ({
  schema_version: 1,
  protocol: TRUTH_CONTRACT_PROTOCOL,
  environment: "staging",
  bootstrap_generation: "1",
  producer_root: key(signers.sonarPrimary),
  governance_quorum: {
    threshold: "2",
    keys: [key(signers.sonarRotated), key(signers.sonarRevoked)],
  },
  recovery_quorum: {
    threshold: "2",
    keys: [key(signers.orderingReplay), key(recoverySecond)],
  },
  issued_at: "2026-07-19T04:00:00.000Z",
});

const compileBootstrap = () => Effect.runSync(compileTrustBootstrap(bootstrapInput()));

const unsignedActivation = () => {
  const objects = TRUTH_NORMATIVE_OBJECT_KINDS.map((kind) => ({
    kind,
    media_type: "application/json",
    sha256: sha256Hex(`trust-activation:${kind}`),
    byte_length: "1",
  }));
  const byKind = new Map(objects.map((object) => [object.kind, object]));
  const root = Effect.runSync(
    compileTruthBundleRoot(
      {
        schema_version: 1,
        protocol: TRUTH_CONTRACT_PROTOCOL,
        environment: "staging",
        generation: "2",
        supersedes_generation: "1",
        objects,
        issuer: {
          service_id: "sonar-api",
          key_id: signers.sonarPrimary.keyId,
        },
        issued_at: "2026-07-19T04:00:00.000Z",
        valid_from: "2026-07-19T04:00:00.000Z",
        compatibility_version: "sonar-score.v1",
        authority_matrix_hash: byKind.get("authority_matrix")!.sha256,
        security_profile_hash: byKind.get("security_profile")!.sha256,
      },
      signers.sonarPrimary,
    ),
  );
  return {
    schema_version: 1,
    protocol: TRUTH_CONTRACT_PROTOCOL,
    environment: "staging",
    prior_generation: "1",
    generation: "2",
    root,
    audit_sequence: "2",
    audit_prior_record_sha256: sha256Hex("prior-audit-record"),
    audit_recorded_at: "2026-07-19T04:00:00.000Z",
    prepared_at: "2026-07-19T04:00:00.000Z",
    issuer: {
      service_id: "sonar-api",
      key_id: signers.sonarPrimary.keyId,
    },
  };
};

const receipt = (digest: string) => {
  const observations = [
    {
      channel_id: "release-channel-a",
      operator_id: "operator-a",
      credential_id: "credential-a",
      bundle_digest: digest,
      observed_at: "2026-07-19T04:01:00.000Z",
    },
    {
      channel_id: "release-channel-b",
      operator_id: "operator-b",
      credential_id: "credential-b",
      bundle_digest: digest,
      observed_at: "2026-07-19T04:02:00.000Z",
    },
  ];
  return {
    schema_version: 1,
    environment: "staging",
    observations: observations.map((observation) => ({
      ...observation,
      signature: channelSigners
        .get(observation.credential_id)!
        .sign(
          bootstrapObservationSigningBytes(
            "staging",
            observation as never,
          ),
        ),
    })),
  };
};

const approval = (
  action: "ROTATE" | "RECOVER",
  payloadHash: string,
  selected: ReadonlyArray<TrustEnvelopeSigner>,
  approvedAt = "2026-07-20T04:00:00.000Z",
) => {
  const unsigned = {
    schema_version: 1,
    protocol: TRUTH_CONTRACT_PROTOCOL,
    environment: "staging",
    action,
    generation: "2",
    nonce: "1",
    payload_hash: payloadHash,
    approved_at: approvedAt,
  };
  const bytes = Effect.runSync(quorumApprovalSigningBytes(unsigned as never));
  return {
    unsigned_approval: unsigned,
    signatures: selected.map((signer) => ({
      key_id: signer.keyId,
      signature: signer.sign(bytes),
    })),
  };
};

const expectFailure = <A, E>(effect: Effect.Effect<A, E>): E => {
  const exit = Effect.runSyncExit(effect);
  if (Exit.isSuccess(exit)) throw new Error("expected typed failure");
  if (exit.cause._tag !== "Fail") throw new Error(`expected Fail, got ${exit.cause._tag}`);
  return exit.cause.error;
};

describe("trust bootstrap and quorum control plane", () => {
  it("signs activations over a distinct domain and requires exact-next high-water", () => {
    const service = makeFixtureTruthSigner(
      signers.sonarPrimary,
      signers.sonarPrimary.publicKeyHex(),
    );
    const signed = Effect.runSync(
      compileTruthGenerationActivation(
        unsignedActivation(),
        service,
        "2026-07-19T04:00:00.000Z" as never,
      ),
    );
    expect(
      Effect.runSync(
        verifyTruthGenerationActivationForAdvance(
          signed,
          service,
          "staging",
          "1" as never,
          "2026-07-19T04:00:00.000Z" as never,
        ),
      ),
    ).toEqual(signed);
    expectFailure(
      verifyTruthGenerationActivationForAdvance(
        signed,
        service,
        "staging",
        "2" as never,
        "2026-07-19T04:00:00.000Z" as never,
      ),
    );
    const tampered = structuredClone(signed);
    tampered.activation_hash = "0".repeat(64) as never;
    expectFailure(
      verifyTruthGenerationActivationForAdvance(
        tampered,
        service,
        "staging",
        "1" as never,
        "2026-07-19T04:00:00.000Z" as never,
      ),
    );

    const semanticallyInvalid = unsignedActivation();
    const invalidUnsignedRoot = {
      ...semanticallyInvalid.root.unsigned_root,
      objects: semanticallyInvalid.root.unsigned_root.objects.slice(1),
    };
    const invalidRootHash = sha256Hex(jcsCanonicalize(invalidUnsignedRoot));
    semanticallyInvalid.root = {
      unsigned_root: invalidUnsignedRoot,
      root_hash: invalidRootHash,
      signature: signers.sonarPrimary.sign(
        truthRootSigningBytes(
          "staging",
          "2" as never,
          invalidRootHash as never,
        ),
      ),
    } as never;
    expectFailure(
      compileTruthGenerationActivation(
        semanticallyInvalid,
        service,
        "2026-07-19T04:00:00.000Z" as never,
      ),
    );
  });

  it("requires exact two-channel agreement with independent identities", () => {
    const bootstrap = compileBootstrap();
    const equivocations = makeInMemoryBootstrapEquivocationLedger();
    expect(
      Effect.runSync(
        verifyTrustBootstrapReceipt(
          bootstrap,
          receipt(bootstrap.bundle_digest),
          "staging",
          channelCredentials,
          equivocations,
          "2026-07-19T04:02:00.000Z" as never,
        ),
      ),
    ).toEqual(bootstrap);
    expectFailure(
      verifyTrustBootstrapReceipt(
        bootstrap,
        receipt(bootstrap.bundle_digest),
        "staging",
        channelCredentials,
        equivocations,
        "2026-07-19T05:00:00.000Z" as never,
      ),
    );
    const expiredProducerInput = bootstrapInput();
    expiredProducerInput.producer_root.valid_until =
      "2026-07-19T04:01:00.000Z";
    const expiredProducerBootstrap = Effect.runSync(
      compileTrustBootstrap(expiredProducerInput),
    );
    expectFailure(
      verifyTrustBootstrapReceipt(
        expiredProducerBootstrap,
        receipt(expiredProducerBootstrap.bundle_digest),
        "staging",
        channelCredentials,
        makeInMemoryBootstrapEquivocationLedger(),
        "2026-07-19T04:02:00.000Z" as never,
      ),
    );
    const substituted = receipt(bootstrap.bundle_digest);
    substituted.observations[1]!.bundle_digest = "0".repeat(64);
    expect(
      expectFailure(
        verifyTrustBootstrapReceipt(
          bootstrap,
          substituted,
          "staging",
          channelCredentials,
          equivocations,
          "2026-07-19T04:02:00.000Z" as never,
        ),
      ),
    ).toBeInstanceOf(TruthTrustError);

    const aliased = receipt(bootstrap.bundle_digest);
    aliased.observations[1]!.operator_id = "operator-a";
    expectFailure(
      verifyTrustBootstrapReceipt(
        bootstrap,
        aliased,
        "staging",
        channelCredentials,
        equivocations,
        "2026-07-19T04:02:00.000Z" as never,
      ),
    );
    expectFailure(
      verifyTrustBootstrapReceipt(
        bootstrap,
        receipt(bootstrap.bundle_digest),
        "production",
        channelCredentials,
        equivocations,
        "2026-07-19T04:02:00.000Z" as never,
      ),
    );

    const conflictingBootstrap = Effect.runSync(
      compileTrustBootstrap({
        ...bootstrapInput(),
        issued_at: "2026-07-19T04:00:30.000Z",
      }),
    );
    expectFailure(
      verifyTrustBootstrapReceipt(
        conflictingBootstrap,
        receipt(conflictingBootstrap.bundle_digest),
        "staging",
        channelCredentials,
        equivocations,
        "2026-07-19T04:02:00.000Z" as never,
      ),
    );
    expect(Effect.runSync(equivocations.equivocations)).toHaveLength(1);

    const aliasedKeyObservations = [
      {
        channel_id: "release-channel-a",
        operator_id: "operator-a",
        credential_id: "credential-a",
        bundle_digest: bootstrap.bundle_digest,
        observed_at: "2026-07-19T04:01:00.000Z",
      },
      {
        channel_id: "release-channel-b",
        operator_id: "operator-b",
        credential_id: "credential-b",
        bundle_digest: bootstrap.bundle_digest,
        observed_at: "2026-07-19T04:02:00.000Z",
      },
    ];
    expectFailure(
      verifyTrustBootstrapReceipt(
        bootstrap,
        {
          schema_version: 1,
          environment: "staging",
          observations: aliasedKeyObservations.map((observation) => ({
            ...observation,
            signature: signers.sonarPrimary.sign(
              bootstrapObservationSigningBytes(
                "staging",
                observation as never,
              ),
            ),
          })),
        },
        "staging",
        new Map([
          [
            "credential-a",
            {
              keyId: signers.sonarPrimary.keyId,
              publicKeyHex: signers.sonarPrimary.publicKeyHex(),
              channelId: "release-channel-a",
              operatorId: "operator-a",
            },
          ],
          [
            "credential-b",
            {
              keyId: "aliased-key-id",
              publicKeyHex: signers.sonarPrimary.publicKeyHex(),
              channelId: "release-channel-b",
              operatorId: "operator-b",
            },
          ],
        ]),
        makeInMemoryBootstrapEquivocationLedger(),
        "2026-07-19T04:02:00.000Z" as never,
      ),
    );
  });

  it("persists bootstrap equivocation bindings and evidence across restarts", () => {
    const root = mkdtempSync(join(tmpdir(), "sonar-truth-equivocation-"));
    roots.push(root);
    const bootstrap = compileBootstrap();
    const trustedGenerations = makeInMemoryTrustedGenerationStore();
    const firstLedger = makeFilesystemBootstrapEquivocationLedger(
      root,
      "staging",
      trustedGenerations,
    );
    expect(
      Effect.runSync(
        verifyTrustBootstrapReceipt(
          bootstrap,
          receipt(bootstrap.bundle_digest),
          "staging",
          channelCredentials,
          firstLedger,
          "2026-07-19T04:02:00.000Z" as never,
        ),
      ),
    ).toEqual(bootstrap);
    Effect.runSync(
      applyAuthorizedTrustedGenerationBootstrap(trustedGenerations, {
        environment: "staging",
        generation: "1",
        recoveryNonce: "0",
        trustedRootHash: sha256Hex("equivocation-root"),
        bootstrapDigest: bootstrap.bundle_digest,
        bootstrapBindingDigest: bootstrapIdentityBindingDigest(
          receipt(bootstrap.bundle_digest),
        ),
        bootstrapEquivocationSequence: "0",
        bootstrapEquivocationDigest: null,
        updatedAt: "2026-07-19T04:02:00.000Z" as never,
      }),
    );

    const conflictingBootstrap = Effect.runSync(
      compileTrustBootstrap({
        ...bootstrapInput(),
        issued_at: "2026-07-19T04:00:30.000Z",
      }),
    );
    const restartedLedger = makeFilesystemBootstrapEquivocationLedger(
      root,
      "staging",
      trustedGenerations,
    );
    expectFailure(
      verifyTrustBootstrapReceipt(
        conflictingBootstrap,
        receipt(conflictingBootstrap.bundle_digest),
        "staging",
        channelCredentials,
        restartedLedger,
        "2026-07-19T04:02:00.000Z" as never,
      ),
    );
    expect(Effect.runSync(restartedLedger.equivocations)).toHaveLength(1);

    const acceptedReceipt = receipt(bootstrap.bundle_digest);
    const substitutedIdentities = structuredClone(acceptedReceipt);
    substitutedIdentities.observations[0]!.channel_id =
      "replacement-release-channel";
    substitutedIdentities.observations[0]!.operator_id =
      "replacement-operator";
    substitutedIdentities.observations[0]!.credential_id =
      "replacement-credential";
    expectFailure(
      restartedLedger.record(
        substitutedIdentities,
        "2026-07-19T04:02:00.000Z" as never,
      ),
    );
    expect(Effect.runSync(restartedLedger.equivocations)).toHaveLength(1);

    const productionLedger = makeFilesystemBootstrapEquivocationLedger(
      root,
      "production",
      trustedGenerations,
    );
    Effect.runSync(
      productionLedger.record(
        {
          ...acceptedReceipt,
          environment: "production",
        } as never,
        "2026-07-19T04:02:00.000Z" as never,
      ),
    );
    expect(
      statSync(
        join(
          root,
          "production",
          "bootstrap-equivocation-ledger.json",
        ),
      ).isFile(),
    ).toBe(true);
    expect(Effect.runSync(restartedLedger.equivocations)).toHaveLength(1);

    const originalBindings = Object.fromEntries(
      acceptedReceipt.observations.flatMap((observation) => [
        [
          `staging\0channel\0${observation.channel_id}`,
          observation.bundle_digest,
        ],
        [
          `staging\0operator\0${observation.operator_id}`,
          observation.bundle_digest,
        ],
        [
          `staging\0credential\0${observation.credential_id}`,
          observation.bundle_digest,
        ],
      ]),
    );
    writeFileSync(
      join(root, "staging", "bootstrap-equivocation-ledger.json"),
      jcsCanonicalize({ bindings: originalBindings, equivocations: [] }),
    );
    expectFailure(
      restartedLedger.record(
        acceptedReceipt,
        "2026-07-19T04:02:00.000Z" as never,
      ),
    );
    expectFailure(restartedLedger.equivocations);
    unlinkSync(
      join(root, "staging", "bootstrap-equivocation-ledger.json"),
    );
    expectFailure(
      makeFilesystemBootstrapEquivocationLedger(
        root,
        "staging",
        trustedGenerations,
      ).record(
        receipt(bootstrap.bundle_digest),
        "2026-07-19T04:02:00.000Z" as never,
      ),
    );
  });

  it("binds bootstrap installation to a pinned signed genesis activation", () => {
    const bootstrap = compileBootstrap();
    const producer = makeFixtureTruthSigner(
      signers.sonarPrimary,
      signers.sonarPrimary.publicKeyHex(),
    );
    const nonGenesisActivation = Effect.runSync(
      compileTruthGenerationActivation(
        unsignedActivation(),
        producer,
        "2026-07-19T04:00:00.000Z" as never,
      ),
    );
    expectFailure(
      applyTrustBootstrapReceipt(
        bootstrap,
        receipt(bootstrap.bundle_digest),
        "staging",
        channelCredentials,
        makeInMemoryBootstrapEquivocationLedger(),
        nonGenesisActivation,
        {
          now: Effect.succeed("2026-07-19T04:00:00.000Z" as never),
          unixMilliseconds: Effect.succeed("1784433600000" as never),
        },
        makeInMemoryTrustedGenerationStore(),
      ),
    );
  });

  it("fails closed on partial, duplicate, invalid, or compromised quorum", () => {
    const bootstrap = compileBootstrap();
    const hash = sha256Hex("rotation-evidence");
    const complete = approval("ROTATE", hash, [
      signers.sonarRotated,
      signers.sonarRevoked,
    ]);
    expect(
      Effect.runSync(
        verifyQuorumApproval(
          complete,
          bootstrap.unsigned_bootstrap.governance_quorum,
          "2026-07-20T04:00:00.000Z" as never,
        ),
      ),
    ).toEqual(complete);
    expect(
      Effect.runSync(
        verifyRotationApproval(
          complete,
          bootstrap,
          { generation: "1", nonce: "0" },
          hash,
          "2026-07-20T04:00:00.000Z" as never,
        ),
      ),
    ).toEqual(complete);
    expectFailure(
      verifyQuorumApproval(
        { ...complete, signatures: complete.signatures.slice(0, 1) },
        bootstrap.unsigned_bootstrap.governance_quorum,
        "2026-07-20T04:00:00.000Z" as never,
      ),
    );
    expectFailure(
      verifyQuorumApproval(
        complete,
        bootstrap.unsigned_bootstrap.governance_quorum,
        "2026-07-20T04:00:00.000Z" as never,
        new Set([signers.sonarRotated.keyId]),
      ),
    );
    expectFailure(
      verifyQuorumApproval(
        complete,
        bootstrap.unsigned_bootstrap.governance_quorum,
        "2026-07-20T04:01:00.001Z" as never,
      ),
    );
    const aliasedQuorum = bootstrapInput();
    aliasedQuorum.governance_quorum.keys[1] = {
      ...aliasedQuorum.governance_quorum.keys[1]!,
      public_key_hex: aliasedQuorum.governance_quorum.keys[0]!.public_key_hex,
    };
    expectFailure(compileTrustBootstrap(aliasedQuorum));

    const transitionStore = makeInMemoryTrustedGenerationStore();
    const currentRoot = sha256Hex("rotation-current-root");
    const nextRoot = sha256Hex("rotation-next-root");
    Effect.runSync(
      applyAuthorizedTrustedGenerationBootstrap(transitionStore, {
        environment: "staging",
        generation: "1",
        recoveryNonce: "0",
        trustedRootHash: currentRoot,
        bootstrapDigest: bootstrap.bundle_digest,
        bootstrapBindingDigest: sha256Hex("bindings"),
        bootstrapEquivocationSequence: "0",
        bootstrapEquivocationDigest: null,
        updatedAt: "2026-07-20T04:00:00.000Z" as never,
      }),
    );
    const transitionHash = Effect.runSync(
      rotationTransitionPayloadHash({
        environment: "staging",
        prior_generation: "1",
        generation: "2",
        current_root_hash: currentRoot,
        next_root_hash: nextRoot,
      }),
    );
    Effect.runSync(
      applyTrustRotation(
        approval("ROTATE", transitionHash, [
          signers.sonarRotated,
          signers.sonarRevoked,
        ]),
        bootstrap,
        nextRoot,
        "2026-07-20T04:00:00.000Z" as never,
        transitionStore,
      ),
    );
    expect(
      Effect.runSync(transitionStore.read("staging")).unsigned_record
        .trusted_root_hash,
    ).toBe(nextRoot);
  });

  it("requires a completed 24-hour recovery challenge and both disjoint quorums", () => {
    const bootstrap = compileBootstrap();
    const evidenceBytes = new TextEncoder().encode("recovery-evidence");
    const evidenceHash = sha256Hex(evidenceBytes);
    const currentRootHash = sha256Hex("recovery-root-current");
    const nextRootHash = sha256Hex("recovery-root-next");
    const store = makeInMemoryTrustedGenerationStore();
    const challenges = makeInMemoryRecoveryChallengeStore();
    Effect.runSync(
      applyAuthorizedTrustedGenerationBootstrap(store, {
        environment: "staging",
        generation: "1",
        recoveryNonce: "0",
        trustedRootHash: currentRootHash,
        bootstrapDigest: bootstrap.bundle_digest,
        bootstrapBindingDigest: sha256Hex("bindings"),
        bootstrapEquivocationSequence: "0",
        bootstrapEquivocationDigest: null,
        updatedAt: "2026-07-19T04:00:00.000Z" as never,
      }),
    );
    const challengeFields = {
      schema_version: 1,
      challenge_id: "recovery-challenge-1",
      environment: "staging",
      prior_generation: "1",
      generation: "2",
      prior_nonce: "0",
      nonce: "1",
      current_root_hash: currentRootHash,
      next_root_hash: nextRootHash,
      evidence_hash: evidenceHash,
      challenge_started_at: "2026-07-19T04:00:00.000Z",
      challenge_ends_at: "2026-07-20T04:00:00.000Z",
    };
    const challengeHash = Effect.runSync(
      recoveryChallengePayloadHash(challengeFields as never),
    );
    const initiationApproval = approval(
      "RECOVER",
      challengeHash,
      [signers.sonarRotated, signers.sonarRevoked],
      "2026-07-19T04:00:00.000Z",
    );
    Effect.runSync(
      initiateRecoveryChallenge(
        {
          challengeId: challengeFields.challenge_id,
          nonce: "1",
          nextRootHash,
          evidenceBytes,
          initiationApproval,
        },
        bootstrap,
        "2026-07-19T04:00:00.000Z" as never,
        store,
        challenges,
      ),
    );
    const unsignedRequest = {
      ...challengeFields,
    };
    const authorizationHash = Effect.runSync(
      recoveryAuthorizationPayloadHash(unsignedRequest as never),
    );
    const request = {
      ...unsignedRequest,
      governance_approval: approval("RECOVER", authorizationHash, [
        signers.sonarRotated,
        signers.sonarRevoked,
      ]),
      recovery_approval: approval("RECOVER", authorizationHash, [
        signers.orderingReplay,
        recoverySecond,
      ]),
    };
    expect(
      Effect.runSync(
        verifyRecoveryCeremony(
          request,
          bootstrap,
          "2026-07-20T04:00:00.000Z" as never,
          {
            generation: "1",
            recoveryNonce: "0",
            rootHash: currentRootHash,
          },
          challenges,
        ),
      ),
    ).toEqual(request);
    expectFailure(
      verifyRecoveryCeremony(
        request,
        bootstrap,
        "2026-07-20T03:59:59.999Z" as never,
        {
          generation: "1",
          recoveryNonce: "0",
          rootHash: currentRootHash,
        },
        challenges,
      ),
    );
    expectFailure(
      verifyRecoveryCeremony(
        request,
        bootstrap,
        "2026-07-20T04:00:00.000Z" as never,
        {
          generation: "1",
          recoveryNonce: "0",
          rootHash: currentRootHash,
        },
        challenges,
        new Set([signers.orderingReplay.keyId]),
      ),
    );

    const conflictStore = makeInMemoryTrustedGenerationStore();
    const conflictChallenges = makeInMemoryRecoveryChallengeStore();
    Effect.runSync(
      applyAuthorizedTrustedGenerationBootstrap(conflictStore, {
        environment: "staging",
        generation: "1",
        recoveryNonce: "0",
        trustedRootHash: currentRootHash,
        bootstrapDigest: bootstrap.bundle_digest,
        bootstrapBindingDigest: sha256Hex("bindings"),
        bootstrapEquivocationSequence: "0",
        bootstrapEquivocationDigest: null,
        updatedAt: "2026-07-19T04:00:00.000Z" as never,
      }),
    );
    Effect.runSync(
      initiateRecoveryChallenge(
        {
          challengeId: challengeFields.challenge_id,
          nonce: "1",
          nextRootHash,
          evidenceBytes,
          initiationApproval,
        },
        bootstrap,
        "2026-07-19T04:00:00.000Z" as never,
        conflictStore,
        conflictChallenges,
      ),
    );
    let challengeReads = 0;
    const conflictingChallengeStore = {
      ...conflictChallenges,
      read: (environment: never, challengeId: string) => {
        challengeReads += 1;
        const read = conflictChallenges.read(environment, challengeId);
        return challengeReads === 2
          ? applyAuthorizedTrustedGenerationAdvance(conflictStore, {
              environment: "staging",
              expectedGeneration: "1",
              nextGeneration: "2",
              expectedRecoveryNonce: "0",
              nextRecoveryNonce: "1",
              expectedRootHash: currentRootHash,
              nextRootHash,
              bootstrapDigest: bootstrap.bundle_digest,
              bootstrapBindingDigest: sha256Hex("bindings"),
              bootstrapEquivocationSequence: "0",
              bootstrapEquivocationDigest: null,
              updatedAt: "2026-07-20T04:00:00.000Z" as never,
            }).pipe(Effect.zipRight(read))
          : read;
      },
    };
    expectFailure(
      applyRecoveryCeremony(
        request,
        bootstrap,
        "2026-07-20T04:00:00.000Z" as never,
        conflictStore,
        conflictingChallengeStore,
      ),
    );
    expect(
      Effect.runSync(
        conflictChallenges.read("staging", challengeFields.challenge_id),
      ).unsigned_challenge.consumed_at,
    ).toBeNull();

    expect(
      Effect.runSync(
        applyRecoveryCeremony(
          request,
          bootstrap,
          "2026-07-20T04:00:00.000Z" as never,
          store,
          challenges,
        ),
      ),
    ).toBe("ACTIVE");
    expectFailure(
      applyRecoveryCeremony(
        request,
        bootstrap,
        "2026-07-20T04:00:00.000Z" as never,
        store,
        challenges,
      ),
    );
  });
});

describe("trusted-generation high-water", () => {
  it("never converts cache loss into trust reset and advances exactly once", () => {
    const store = makeInMemoryTrustedGenerationStore();
    expect("bootstrap" in store).toBe(false);
    expect("advance" in store).toBe(false);
    const digest = sha256Hex("bootstrap");
    const rootOne = sha256Hex("root-1");
    const rootTwo = sha256Hex("root-2");
    expectFailure(store.read("staging"));
    Effect.runSync(
      applyAuthorizedTrustedGenerationBootstrap(store, {
        environment: "staging",
        generation: "1",
        recoveryNonce: "0",
        trustedRootHash: rootOne,
        bootstrapDigest: digest,
        bootstrapBindingDigest: sha256Hex("bindings"),
        bootstrapEquivocationSequence: "0",
        bootstrapEquivocationDigest: null,
        updatedAt: "2026-07-19T04:00:00.000Z" as never,
      }),
    );
    Effect.runSync(
      applyAuthorizedTrustedGenerationAdvance(store, {
        environment: "staging",
        expectedGeneration: "1",
        nextGeneration: "2",
        expectedRecoveryNonce: "0",
        nextRecoveryNonce: "0",
        expectedRootHash: rootOne,
        nextRootHash: rootTwo,
        bootstrapDigest: digest,
        bootstrapBindingDigest: sha256Hex("bindings"),
        bootstrapEquivocationSequence: "0",
        bootstrapEquivocationDigest: null,
        updatedAt: "2026-07-19T05:00:00.000Z" as never,
      }),
    );
    expect(Effect.runSync(store.read("staging")).unsigned_record.generation).toBe(
      "2",
    );
    expectFailure(
      applyAuthorizedTrustedGenerationAdvance(store, {
        environment: "staging",
        expectedGeneration: "1",
        nextGeneration: "2",
        expectedRecoveryNonce: "0",
        nextRecoveryNonce: "0",
        expectedRootHash: rootOne,
        nextRootHash: rootTwo,
        bootstrapDigest: digest,
        bootstrapBindingDigest: sha256Hex("bindings"),
        bootstrapEquivocationSequence: "0",
        bootstrapEquivocationDigest: null,
        updatedAt: "2026-07-19T05:00:00.000Z" as never,
      }),
    );
    expectFailure(
      applyAuthorizedTrustedGenerationAdvance(store, {
        environment: "staging",
        expectedGeneration: "2",
        nextGeneration: "4",
        expectedRecoveryNonce: "0",
        nextRecoveryNonce: "0",
        expectedRootHash: rootTwo,
        nextRootHash: sha256Hex("root-4"),
        bootstrapDigest: digest,
        bootstrapBindingDigest: sha256Hex("bindings"),
        bootstrapEquivocationSequence: "0",
        bootstrapEquivocationDigest: null,
        updatedAt: "2026-07-19T05:00:00.000Z" as never,
      }),
    );
  });

  it("persists with owner-only permissions and treats deletion as UNKNOWN", () => {
    const root = mkdtempSync(join(tmpdir(), "sonar-high-water-"));
    roots.push(root);
    Effect.runSync(
      provisionFilesystemTrustedGenerationEnvironment(root, "staging"),
    );
    const store = makeFilesystemTrustedGenerationStore(root);
    const digest = sha256Hex("bootstrap");
    const trustedRootHash = sha256Hex("root-1");
    Effect.runSync(
      applyAuthorizedTrustedGenerationBootstrap(store, {
        environment: "staging",
        generation: "1",
        recoveryNonce: "0",
        trustedRootHash,
        bootstrapDigest: digest,
        bootstrapBindingDigest: sha256Hex("bindings"),
        bootstrapEquivocationSequence: "0",
        bootstrapEquivocationDigest: null,
        updatedAt: "2026-07-19T04:00:00.000Z" as never,
      }),
    );
    const path = join(root, "staging.high-water.json");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(Effect.runSync(store.read("staging")).unsigned_record.generation).toBe(
      "1",
    );
    unlinkSync(path);
    expect(expectFailure(store.read("staging"))).toBeInstanceOf(TruthTrustError);
    expect(expectFailure(store.bootstrapStatus("staging"))).toBeInstanceOf(
      TruthTrustError,
    );
    expectFailure(
      applyAuthorizedTrustedGenerationBootstrap(store, {
        environment: "staging",
        generation: "1",
        recoveryNonce: "0",
        trustedRootHash,
        bootstrapDigest: digest,
        bootstrapBindingDigest: sha256Hex("bindings"),
        bootstrapEquivocationSequence: "0",
        bootstrapEquivocationDigest: null,
        updatedAt: "2026-07-19T04:00:00.000Z" as never,
      }),
    );
  });

  it("allows exactly one bootstrap winner across two filesystem store instances", async () => {
    const root = mkdtempSync(join(tmpdir(), "sonar-high-water-race-"));
    roots.push(root);
    Effect.runSync(
      provisionFilesystemTrustedGenerationEnvironment(root, "staging"),
    );
    const left = makeFilesystemTrustedGenerationStore(root);
    const right = makeFilesystemTrustedGenerationStore(root);
    const input = {
      environment: "staging",
      generation: "1",
      recoveryNonce: "0",
      trustedRootHash: sha256Hex("root-1"),
      bootstrapDigest: sha256Hex("bootstrap"),
      bootstrapBindingDigest: sha256Hex("bindings"),
      bootstrapEquivocationSequence: "0",
      bootstrapEquivocationDigest: null,
      updatedAt: "2026-07-19T04:00:00.000Z",
    } as const;
    const outcomes = await Promise.all([
      Effect.runPromise(
        Effect.either(
          applyAuthorizedTrustedGenerationBootstrap(left, input as never),
        ),
      ),
      Effect.runPromise(
        Effect.either(
          applyAuthorizedTrustedGenerationBootstrap(right, input as never),
        ),
      ),
    ]);
    expect(outcomes.filter(Either.isRight)).toHaveLength(1);
    expect(outcomes.filter(Either.isLeft)).toHaveLength(1);
    expect(Effect.runSync(left.read("staging")).unsigned_record.generation).toBe(
      "1",
    );
  });
});
