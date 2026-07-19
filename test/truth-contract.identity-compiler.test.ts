import { Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";

import {
  MIBERA_CONFIG_BYTES_SHA256,
  MIBERA_INITIAL_ADDRESS,
  MIBERA_INITIAL_CHAIN_ID,
  TruthTransportError,
  compileFinalizedEvmIdentity,
} from "../src/truth-contract/index.js";
import { sha256Hex } from "../src/collection-resolver/trust-protocol.js";

const now = "2026-07-19T06:00:00.000Z";
const digest = (value: string) => sha256Hex(`identity-compiler-test:${value}`);
const request = {
  canonicalCollectionId: "mibera",
  chainId: MIBERA_INITIAL_CHAIN_ID,
  canonicalAddress: MIBERA_INITIAL_ADDRESS,
  aliases: ["mibera-collection"],
  configDigest: MIBERA_CONFIG_BYTES_SHA256,
  configSource: "config.mibera.yaml",
  expectedFinalityPolicyVersion: "berachain-finalized.v1",
  validFrom: now,
  validUntil: "2026-07-19T07:00:00.000Z",
  statusExpiresAt: "2026-07-19T07:00:00.000Z",
};

const observation = () => {
  const blockHash = digest("block");
  const provider = (suffix: "a" | "b") => ({
    provider_id: `provider-${suffix}`,
    operator: `operator-${suffix}`,
    legal_entity: `entity-${suffix}`,
    control_domain: `domain-${suffix}`,
    network_path: `path-${suffix}`,
    asn: `asn-${suffix}`,
    client_family: suffix === "a" ? "reth" : "nethermind",
    upstream_source: `source-${suffix}`,
    finality_method: "FINALIZED_TAG",
    finalized_tag: "finalized",
    height: "19000001",
    block_hash: blockHash,
    observed_at: now,
    evidence: {
      evidence_id: `provider-${suffix}`,
      sha256: digest(`provider-${suffix}`),
    },
    source_error: false,
  });
  return {
    chain_id: MIBERA_INITIAL_CHAIN_ID,
    canonical_address: MIBERA_INITIAL_ADDRESS,
    observed_height: "19000001",
    observed_hash: blockHash,
    observed_at: now,
    finality_policy_version: "berachain-finalized.v1",
    providers: [provider("a"), provider("b")],
    deployed_identity_hash: digest("deployed-identity"),
    deployed_code_hash: digest("code"),
    proxy_kind: "NONE",
    implementation_address: null,
    implementation_code_hash: null,
    upgrade_mechanism: "IMMUTABLE",
    code_evidence_id: "code",
    code_evidence_sha256: digest("code-evidence"),
  };
};

describe("finality-qualified EVM identity compiler", () => {
  it("compiles an injected resolver observation into a canonical binding", () => {
    const result = Effect.runSync(
      compileFinalizedEvmIdentity(request, {
        resolve: () => Effect.succeed(observation()),
      }),
    );
    expect(result).toMatchObject({
      _tag: "VERIFIED",
      binding: {
        canonical_collection_id: "mibera",
        chain_id: "80094",
        canonical_address: MIBERA_INITIAL_ADDRESS,
        proxy_kind: "NONE",
        contest_state: "CLEAR",
        effective_status: { _tag: "READY" },
      },
    });
  });

  it("maps resolver transport failure to an unresolved identity", () => {
    const result = Effect.runSync(
      compileFinalizedEvmIdentity(request, {
        resolve: () =>
          Effect.fail(
            new TruthTransportError({
              boundary: "fixture.resolver",
              reason: "unavailable",
              retryable: true,
            }),
          ),
      }),
    );
    expect(result).toEqual({ _tag: "UNRESOLVED", reason: "SOURCE_FAILURE" });
  });

  it("rejects correlated or disagreeing finalized providers", () => {
    const correlated = observation();
    correlated.providers[1]!.operator = correlated.providers[0]!.operator;
    expect(
      Effect.runSync(
        compileFinalizedEvmIdentity(request, {
          resolve: () => Effect.succeed(correlated),
        }),
      ),
    ).toEqual({ _tag: "UNRESOLVED", reason: "PROVIDER_CORRELATED" });

    const disagreement = observation();
    disagreement.providers[1]!.block_hash = digest("other-block");
    expect(
      Effect.runSync(
        compileFinalizedEvmIdentity(request, {
          resolve: () => Effect.succeed(disagreement),
        }),
      ),
    ).toEqual({ _tag: "UNRESOLVED", reason: "FINALITY_UNPROVEN" });
  });

  it("rejects block-depth fallback and incomplete proxy evidence", () => {
    const depth = observation();
    depth.providers[0]!.finality_method = "BLOCK_DEPTH";
    depth.providers[0]!.finalized_tag = null;
    expect(
      Effect.runSync(
        compileFinalizedEvmIdentity(request, {
          resolve: () => Effect.succeed(depth),
        }),
      ),
    ).toEqual({ _tag: "UNRESOLVED", reason: "FINALITY_UNPROVEN" });

    const proxy = observation();
    proxy.proxy_kind = "EIP1967";
    proxy.upgrade_mechanism = "ADMIN";
    expect(
      Effect.runSync(
        compileFinalizedEvmIdentity(request, {
          resolve: () => Effect.succeed(proxy),
        }),
      ),
    ).toEqual({ _tag: "UNRESOLVED", reason: "PROXY_INCOMPLETE" });

    const minimal = observation();
    minimal.proxy_kind = "MINIMAL";
    minimal.implementation_address =
      "0x1111111111111111111111111111111111111111";
    minimal.implementation_code_hash = digest("minimal-implementation");
    expect(
      Effect.runSync(
        compileFinalizedEvmIdentity(request, {
          resolve: () => Effect.succeed(minimal),
        }),
      ),
    ).toMatchObject({
      _tag: "VERIFIED",
      binding: { proxy_kind: "MINIMAL", upgrade_mechanism: "IMMUTABLE" },
    });

    const metamorphic = observation();
    metamorphic.proxy_kind = "EIP1967";
    metamorphic.implementation_address = "0x1111";
    metamorphic.implementation_code_hash = digest("implementation");
    metamorphic.upgrade_mechanism = "METAMORPHIC";
    expect(
      Effect.runSync(
        compileFinalizedEvmIdentity(request, {
          resolve: () => Effect.succeed(metamorphic),
        }),
      ),
    ).toEqual({ _tag: "UNRESOLVED", reason: "PROXY_INCOMPLETE" });

    expect(
      Exit.isFailure(
        Effect.runSyncExit(
          compileFinalizedEvmIdentity(
            {
              ...request,
              validFrom: "2026-07-19T06:00:00.001Z",
            },
            { resolve: () => Effect.succeed(observation()) },
          ),
        ),
      ),
    ).toBe(true);

    expect(
      Effect.runSync(
        compileFinalizedEvmIdentity(
          { ...request, canonicalAddress: "0x1234" },
          { resolve: () => Effect.succeed(observation()) },
        ),
      ),
    ).toEqual({ _tag: "UNRESOLVED", reason: "OBSERVATION_INVALID" });
  });
});
