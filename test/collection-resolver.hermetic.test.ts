import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";
import {
  HERMETIC_CAPABILITY_SNAPSHOT,
  MULTI_CHAIN_EVM_ADDRESS,
  PYTHIANS_COLLECTION_MINT,
  SCRIPT_EVM_ERC721,
  SCRIPT_MULTI_CHAIN_SAME_ADDRESS,
  SCRIPT_PARTIAL_TIMEOUT,
  SCRIPT_SOLANA_COLLECTION,
  SCRIPT_ZERO_CANDIDATES,
  ProbeAddressMismatchError,
  assertSolanaKeyCaseRetained,
  collectionProtocolFixturesRoot,
  createHermeticProbePort,
  decodeCollectionCandidate,
  normalizeDasCollectionProbe,
  normalizeSolanaAddress,
  resolveProbe,
  solanaRecognizeCapability,
  verifyVendoredCollectionProtocolDigest,
} from "../src/collection-resolver/index.js";
import { toRows } from "../src/svm/collection-nft-rows.js";
import {
  parseAsset,
  type CollectionSnapshot,
} from "../src/svm/nft-collection-source.js";

const expectSuccess = <A, E>(effect: Effect.Effect<A, E>): A => {
  const exit = Effect.runSyncExit(effect);
  if (Exit.isFailure(exit)) {
    throw new Error(`expected success, got ${String(exit.cause)}`);
  }
  return exit.value;
};

const expectFailure = <A, E>(effect: Effect.Effect<A, E>): E => {
  const exit = Effect.runSyncExit(effect);
  if (Exit.isSuccess(exit)) {
    throw new Error("expected failure");
  }
  const failure = exit.cause;
  if (failure._tag !== "Fail") {
    throw new Error(`expected Fail cause, got ${failure._tag}`);
  }
  return failure.error;
};

const readProtocolFixture = (name: string): unknown =>
  JSON.parse(readFileSync(join(collectionProtocolFixturesRoot(), name), "utf8"));

describe("CR-003 hermetic resolve-probe", () => {
  it("returns one chain-qualified EVM ERC-721 candidate", () => {
    const response = expectSuccess(
      resolveProbe({
        request: {
          schema_version: 1,
          identifier: MULTI_CHAIN_EVM_ADDRESS,
          environment: "mainnet",
        },
        capabilitySnapshot: HERMETIC_CAPABILITY_SNAPSHOT,
        probePort: createHermeticProbePort(SCRIPT_EVM_ERC721),
      }),
    );

    expect(response.candidates).toHaveLength(1);
    const candidate = response.candidates[0]!;
    expect(candidate.identity.deployments).toHaveLength(1);
    expect(candidate.identity.deployments[0]!.network).toEqual({
      schema_version: 1,
      network_namespace: "eip155",
      network_reference: "1",
    });
    expect(candidate.token_standard.value).toBe("erc721");
    expect(candidate.identity.equivalence_basis.kind).toBe("single_deployment");
    expect(candidate.recognition).toBe("recognized");
    expect(response.diagnostics.searched.map((n) => `${n.network_namespace}:${n.network_reference}`)).toEqual([
      "eip155:1",
      "eip155:8453",
    ]);
  });

  it("returns one Solana collection candidate without lowercasing the mint", () => {
    const response = expectSuccess(
      resolveProbe({
        request: {
          schema_version: 1,
          identifier: PYTHIANS_COLLECTION_MINT,
          environment: "mainnet",
        },
        capabilitySnapshot: HERMETIC_CAPABILITY_SNAPSHOT,
        probePort: createHermeticProbePort(SCRIPT_SOLANA_COLLECTION),
      }),
    );

    expect(response.candidates).toHaveLength(1);
    const deployment = response.candidates[0]!.identity.deployments[0]!;
    expect(deployment.network.network_namespace).toBe("solana");
    expect(deployment.address).toBe(PYTHIANS_COLLECTION_MINT);
    expect(deployment.normalized_address).toBe(PYTHIANS_COLLECTION_MINT);
    expect(normalizeSolanaAddress(deployment.address)).toBe(PYTHIANS_COLLECTION_MINT);
    expect(response.candidates[0]!.index_status).toBe("missing");
    expect(response.candidates[0]!.report_readiness).toBe("preparation_required");
    expect(response.candidates[0]!.recognition).toBe("recognized");
  });

  it("treats the same EVM address on two networks as two deployments, not metadata equivalence", () => {
    const response = expectSuccess(
      resolveProbe({
        request: {
          schema_version: 1,
          identifier: MULTI_CHAIN_EVM_ADDRESS,
          environment: "mainnet",
        },
        capabilitySnapshot: HERMETIC_CAPABILITY_SNAPSHOT,
        probePort: createHermeticProbePort(SCRIPT_MULTI_CHAIN_SAME_ADDRESS),
      }),
    );

    expect(response.candidates).toHaveLength(2);
    const networks = response.candidates.map(
      (candidate) => candidate.identity.deployments[0]!.network.network_reference,
    );
    expect(networks.sort()).toEqual(["1", "8453"]);

    const deploymentIds = new Set(
      response.candidates.map((candidate) => candidate.identity.deployments[0]!.deployment_id.digest),
    );
    expect(deploymentIds.size).toBe(2);

    const collectionIds = new Set(
      response.candidates.map((candidate) => candidate.identity.collection_id.digest),
    );
    expect(collectionIds.size).toBe(2);

    for (const candidate of response.candidates) {
      expect(candidate.identity.name).toBe("Shared Metadata Name");
      expect(candidate.identity.symbol).toBe("SAME");
      expect(candidate.identity.equivalence_basis.kind).toBe("single_deployment");
      expect(candidate.identity.deployments).toHaveLength(1);
    }
  });

  it("returns partial candidates plus typed timeout diagnostics", () => {
    const response = expectSuccess(
      resolveProbe({
        request: {
          schema_version: 1,
          identifier: MULTI_CHAIN_EVM_ADDRESS,
          environment: "mainnet",
        },
        capabilitySnapshot: HERMETIC_CAPABILITY_SNAPSHOT,
        probePort: createHermeticProbePort(SCRIPT_PARTIAL_TIMEOUT),
      }),
    );

    expect(response.candidates).toHaveLength(1);
    expect(response.candidates[0]!.identity.deployments[0]!.network.network_reference).toBe("1");
    expect(response.diagnostics.timed_out).toEqual([
      {
        schema_version: 1,
        network_namespace: "eip155",
        network_reference: "8453",
      },
    ]);
    expect(response.diagnostics.unavailable).toEqual([]);
  });

  it("treats zero candidates as a successful empty result", () => {
    const response = expectSuccess(
      resolveProbe({
        request: {
          schema_version: 1,
          identifier: "0x0000000000000000000000000000000000000001",
          environment: "mainnet",
        },
        capabilitySnapshot: HERMETIC_CAPABILITY_SNAPSHOT,
        probePort: createHermeticProbePort(SCRIPT_ZERO_CANDIDATES),
      }),
    );

    expect(response.candidates).toEqual([]);
    expect(response.diagnostics.timed_out).toEqual([]);
    expect(response.capability_snapshot_version).toEqual(HERMETIC_CAPABILITY_SNAPSHOT.version);
  });

  it("keeps recognition orthogonal from index and readiness on Solana", () => {
    const response = expectSuccess(
      resolveProbe({
        request: {
          schema_version: 1,
          identifier: PYTHIANS_COLLECTION_MINT,
          environment: "mainnet",
        },
        capabilitySnapshot: HERMETIC_CAPABILITY_SNAPSHOT,
        probePort: createHermeticProbePort(SCRIPT_SOLANA_COLLECTION),
      }),
    );
    const candidate = response.candidates[0]!;
    expect(candidate.recognition).toBe("recognized");
    expect(candidate.index_status).not.toBe("indexed");
    expect(candidate.report_readiness).not.toBe("ready");
  });

  it("rejects adversarial probe hits that bind a different deployment address", () => {
    const wrongMint = "So11111111111111111111111111111111111111112";
    const error = expectFailure(
      resolveProbe({
        request: {
          schema_version: 1,
          identifier: PYTHIANS_COLLECTION_MINT,
          environment: "mainnet",
        },
        capabilitySnapshot: HERMETIC_CAPABILITY_SNAPSHOT,
        probePort: createHermeticProbePort({
          "solana:mainnet-beta": {
            kind: "hit",
            address: wrongMint,
            token_standard: "metaplex_collection",
            name: "Impostor",
            recognition: "recognized",
            index_status: "missing",
            report_readiness: "preparation_required",
            metadata_quality: "onchain",
            observed_at: "2026-07-16T08:00:00Z",
            ranking_reasons: ["supported_standard"],
            evidence_material: {
              adapter: "solana_das",
              collection_mint: wrongMint,
            },
          },
        }),
      }),
    );

    expect(error).toBeInstanceOf(ProbeAddressMismatchError);
    expect(error._tag).toBe("ProbeAddressMismatchError");
    if (!(error instanceof ProbeAddressMismatchError)) {
      throw new Error("expected ProbeAddressMismatchError");
    }
    expect(error.requested).toBe(PYTHIANS_COLLECTION_MINT);
    expect(error.probed).toBe(wrongMint);
    expect(error.network).toEqual({
      schema_version: 1,
      network_namespace: "solana",
      network_reference: "mainnet-beta",
    });
  });

  it("accepts EVM probe hits that differ only by case under CR-001 normalization", () => {
    const response = expectSuccess(
      resolveProbe({
        request: {
          schema_version: 1,
          identifier: MULTI_CHAIN_EVM_ADDRESS,
          environment: "mainnet",
        },
        capabilitySnapshot: HERMETIC_CAPABILITY_SNAPSHOT,
        probePort: createHermeticProbePort({
          "eip155:1": {
            kind: "hit",
            address: MULTI_CHAIN_EVM_ADDRESS.toLowerCase(),
            token_standard: "erc721",
            name: "Case Fold Ok",
            recognition: "recognized",
            index_status: "indexed",
            report_readiness: "ready",
            metadata_quality: "onchain",
            observed_at: "2026-07-16T08:00:00Z",
            ranking_reasons: ["supported_standard", "indexed"],
            evidence_material: { adapter: "evm_rpc", fixture: "case-ok" },
          },
        }),
      }),
    );
    expect(response.candidates).toHaveLength(1);
    expect(response.candidates[0]!.identity.deployments[0]!.address).toBe(MULTI_CHAIN_EVM_ADDRESS);
  });
});

describe("CR-003 DAS / SVM probe normalization projection", () => {
  it("feeds CollectionSnapshot through shared toRows and retains mint/owner/delegate case", () => {
    const logSurfaces: string[] = [];
    // Mixed-case fixtures that fold under toLowerCase — proves retention is load-bearing.
    const memberMint = "PtnMemberMint111111111111111111111111111111";
    const owner = "OwnerKeyABCDEFGHJKLMNPQRSTUVWXYZabcdefghijk";
    const delegate = "DelegateKeyABCDEFGHJKLMNPQRSTUVWXYZabcdef";
    const observedAt = "2026-07-16T08:00:00Z";

    // Real Sonar DAS path: DasAsset → parseAsset (refuses missing owner) → CollectionSnapshot.
    const parsed = parseAsset({
      id: memberMint,
      burnt: false,
      ownership: { owner, delegate },
      content: {
        metadata: { name: "Pythenians #1" },
        json_uri: "https://ipfs.pythenians.xyz/metadata/1.json",
        links: { image: "https://ipfs.pythenians.xyz/nft/abc.png" },
      },
      compression: { compressed: false },
    });
    expect(parsed).not.toBeNull();
    // parseAsset refuses missing owner — same seam the DAS source uses.
    expect(parseAsset({ id: memberMint, ownership: {} })).toBeNull();
    expect(parseAsset({ id: memberMint, ownership: { owner: "" } })).toBeNull();

    const snapshot: CollectionSnapshot = {
      collectionMint: PYTHIANS_COLLECTION_MINT,
      slot: 342_178_901,
      source: "das",
      members: [parsed!],
    };

    const expectedRows = toRows(snapshot, "pythians", observedAt);

    const surfaces = expectSuccess(
      normalizeDasCollectionProbe({
        capability: solanaRecognizeCapability(),
        collectionKey: "pythians",
        observation: {
          snapshot,
          interfaceName: "ProgrammableNFT",
          name: "Pythenians",
          symbol: "$PTN",
          observedAt,
          indexStatus: "missing",
          reportReadiness: "preparation_required",
        },
        log: {
          info: (message, fields) => {
            logSurfaces.push(message);
            if (fields !== undefined) {
              logSurfaces.push(JSON.stringify(fields));
            }
          },
        },
      }),
    );

    // Storage is the shared production projector — exact NftRow shape, no invented row.
    expect(surfaces.storage).toEqual(expectedRows);
    expect(surfaces.storage).toHaveLength(1);
    const row = surfaces.storage[0]!;
    expect(row).toEqual({
      id: memberMint,
      collection_key: "pythians",
      collection_mint: PYTHIANS_COLLECTION_MINT,
      nft_mint: memberMint,
      owner,
      delegate,
      name: "Pythenians #1",
      image: "https://ipfs.pythenians.xyz/nft/abc.png",
      uri: "https://ipfs.pythenians.xyz/metadata/1.json",
      compressed: false,
      slot: 342_178_901,
      source: "das",
      updated_at: observedAt,
    });
    expect(row.owner).not.toBe("");

    // Log projection
    expect(surfaces.log.event).toBe("das_probe_normalized");
    expect(surfaces.log.fields.collection_mint).toBe(PYTHIANS_COLLECTION_MINT);
    expect(surfaces.log.fields.sample_member_mint).toBe(memberMint);
    expect(surfaces.log.fields.sample_owner).toBe(owner);
    expect(surfaces.log.fields.sample_delegate).toBe(delegate);
    expect(surfaces.log.fields.slot).toBe("342178901");

    // Response candidate
    const deployment = surfaces.response.identity.deployments[0]!;
    expect(deployment.address).toBe(PYTHIANS_COLLECTION_MINT);
    expect(deployment.normalized_address).toBe(PYTHIANS_COLLECTION_MINT);
    expect(surfaces.response.token_standard.value).toBe("programmable_nft");

    const storageJson = JSON.stringify(surfaces.storage);
    const logJson = JSON.stringify(surfaces.log);
    const responseJson = JSON.stringify(surfaces.response);
    const sinkJson = JSON.stringify(logSurfaces);

    expectSuccess(
      assertSolanaKeyCaseRetained({
        original: PYTHIANS_COLLECTION_MINT,
        surfaces: [storageJson, logJson, responseJson, sinkJson],
      }),
    );
    expectSuccess(
      assertSolanaKeyCaseRetained({
        original: memberMint,
        surfaces: [storageJson, logJson, sinkJson],
      }),
    );
    expectSuccess(
      assertSolanaKeyCaseRetained({
        original: owner,
        surfaces: [storageJson, logJson, sinkJson],
      }),
    );
    expectSuccess(
      assertSolanaKeyCaseRetained({
        original: delegate,
        surfaces: [storageJson, logJson, sinkJson],
      }),
    );

    expect(storageJson).toContain(PYTHIANS_COLLECTION_MINT);
    expect(storageJson).toContain(memberMint);
    expect(storageJson).toContain(owner);
    expect(storageJson).toContain(delegate);
    expect(storageJson).not.toContain(PYTHIANS_COLLECTION_MINT.toLowerCase());
    expect(storageJson).not.toContain(memberMint.toLowerCase());
    expect(storageJson).not.toContain(owner.toLowerCase());
    expect(storageJson).not.toContain(delegate.toLowerCase());
  });
});

describe("CR-003 protocol conformance", () => {
  it("verifies the executable vendored protocol tarball against its committed digest", () => {
    const verified = verifyVendoredCollectionProtocolDigest();
    expect(verified.actual).toBe(verified.expected);
  });

  it("rejects a mixed surface containing both exact and lowercased Solana keys", () => {
    const key = "OwnerKeyABCDEFGHJKLMNPQRSTUVWXYZabcdefghijk";
    const error = expectFailure(
      assertSolanaKeyCaseRetained({
        original: key,
        surfaces: [`exact=${key};bad=${key.toLowerCase()}`],
      }),
    );
    expect(error._tag).toBe("DasCaseRetentionError");
  });

  it("strict-decodes CR-001 committed candidate fixtures through the Sonar adapter", () => {
    for (const name of [
      "evm-candidate.valid.json",
      "solana-candidate.valid.json",
      "multiple-deployments-unknown-standard.valid.json",
    ]) {
      const decoded = expectSuccess(decodeCollectionCandidate(readProtocolFixture(name)));
      expect(decoded.schema_version).toBe(1);
      for (const deployment of decoded.identity.deployments) {
        expect(deployment.network.network_namespace).toMatch(/^(eip155|solana)$/);
      }
    }
  });

  it("strict-decodes every hermetic resolver candidate through CR-001 schemas", () => {
    const scripts = [
      SCRIPT_EVM_ERC721,
      SCRIPT_SOLANA_COLLECTION,
      SCRIPT_MULTI_CHAIN_SAME_ADDRESS,
      SCRIPT_PARTIAL_TIMEOUT,
      SCRIPT_ZERO_CANDIDATES,
    ] as const;
    const identifiers = [
      MULTI_CHAIN_EVM_ADDRESS,
      PYTHIANS_COLLECTION_MINT,
      MULTI_CHAIN_EVM_ADDRESS,
      MULTI_CHAIN_EVM_ADDRESS,
      "0x0000000000000000000000000000000000000001",
    ];

    for (let index = 0; index < scripts.length; index += 1) {
      const response = expectSuccess(
        resolveProbe({
          request: {
            schema_version: 1,
            identifier: identifiers[index]!,
            environment: "mainnet",
          },
          capabilitySnapshot: HERMETIC_CAPABILITY_SNAPSHOT,
          probePort: createHermeticProbePort(scripts[index]!),
        }),
      );
      for (const candidate of response.candidates) {
        expectSuccess(decodeCollectionCandidate(candidate));
      }
    }
  });
});
