import { readFileSync } from "node:fs";

import { Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";

import {
  MIBERA_ADAPTER_BYTES_SHA256,
  MIBERA_CONFIG_BYTES_SHA256,
  MIBERA_DENOMINATOR_BYTES_SHA256,
  MIBERA_HANDLER_BYTES_SHA256,
  MIBERA_INITIAL_ADDRESS,
  MIBERA_INITIAL_CHAIN_ID,
  MIBERA_INITIAL_EVENT_SIGNATURE,
  MIBERA_INITIAL_EVENT_TOPIC0,
  MIBERA_INITIAL_START_HEIGHT,
  TRUTH_NORMATIVE_OBJECT_KINDS,
  compileMiberaFixtureGeneration,
  verifyTruthBundleRoot,
  verifyTruthReadinessEnvelope,
} from "../src/truth-contract/index.js";
import {
  fixtureSigners,
  sha256Hex,
} from "../src/collection-resolver/trust-protocol.js";
import { berachainMainnetCapability } from "../src/collection-resolver/capability-registry/fixtures.js";

const signer = fixtureSigners().sonarPrimary;
const now = "2026-07-19T06:00:00.000Z";
const denominatorPath =
  "test/fixtures/truth-contract/mibera-transfer-denominator-v1.json";

describe("hermetic Mibera producer generation", () => {
  it("removes the legacy Berachain block-depth fallback from the resolver policy", () => {
    expect(berachainMainnetCapability().finality_policy).toMatchObject({
      family: "evm",
      policy_version: "berachain-finalized.v1",
      confirmation: { kind: "finalized_tag", finalized_tag: "finalized" },
    });
  });

  it("byte-verifies the exact closed source slice before reaching PRODUCED", () => {
    const denominatorBytes = Uint8Array.from(readFileSync(denominatorPath));
    const generation = Effect.runSync(
      compileMiberaFixtureGeneration({ denominatorBytes, now }, signer),
    );

    expect(generation).toMatchObject({
      validity_class: "FIXTURE_VALID",
      lifecycle: "PRODUCED",
      production_authority: false,
      denominator_digest: MIBERA_DENOMINATOR_BYTES_SHA256,
    });
    expect(generation.closure.map((object) => object.ref.kind)).toEqual(
      [...TRUTH_NORMATIVE_OBJECT_KINDS].sort(),
    );
    const identity = generation.closure.find(
      (object) => object.value.kind === "identity_snapshot",
    )!.value;
    expect(identity).toMatchObject({
      bindings: [
        {
          canonical_collection_id: "mibera",
          chain_id: MIBERA_INITIAL_CHAIN_ID,
          canonical_address: MIBERA_INITIAL_ADDRESS,
          finality_policy_version: "berachain-finalized.v1",
          proxy_kind: "NONE",
          contest_state: "CLEAR",
        },
      ],
    });
    const vocabulary = generation.closure.find(
      (object) => object.value.kind === "event_vocabulary",
    )!.value;
    expect(vocabulary).toMatchObject({
      denominator_scope: "CLOSED",
      denominator_manifest_hash: MIBERA_DENOMINATOR_BYTES_SHA256,
      denominator_members: [
        {
          canonical_address: MIBERA_INITIAL_ADDRESS,
          event_signature: MIBERA_INITIAL_EVENT_SIGNATURE,
          topic0: MIBERA_INITIAL_EVENT_TOPIC0,
          start_height: MIBERA_INITIAL_START_HEIGHT,
        },
      ],
    });
    expect(generation.readiness.unsigned_envelope).toMatchObject({
      validity_class: "FIXTURE_VALID",
      target_lifecycle: "PRODUCED",
      source_digest: MIBERA_HANDLER_BYTES_SHA256,
      adapter_digest: MIBERA_ADAPTER_BYTES_SHA256,
      decision: { state: "READY" },
    });
  });

  it("verifies both signed artifacts and is deterministic for identical inputs", () => {
    const denominatorBytes = Uint8Array.from(readFileSync(denominatorPath));
    const first = Effect.runSync(
      compileMiberaFixtureGeneration({ denominatorBytes, now }, signer),
    );
    const second = Effect.runSync(
      compileMiberaFixtureGeneration({ denominatorBytes, now }, signer),
    );
    expect(second.root).toEqual(first.root);
    expect(second.readiness).toEqual(first.readiness);
    expect(
      Effect.runSync(
        verifyTruthBundleRoot(first.root, {
          expectedEnvironment: "development",
          expectedKeyId: signer.keyId,
          publicKeyHex: signer.publicKeyHex(),
          trustedGenerationHighWater: "1" as never,
          now: now as never,
        }),
      ),
    ).toEqual(first.root);
    expect(
      Effect.runSync(
        verifyTruthReadinessEnvelope(first.readiness, {
          expectedEnvironment: "development",
          expectedKeyId: signer.keyId,
          publicKeyHex: signer.publicKeyHex(),
          expectedValidityClass: "FIXTURE_VALID",
          expectedBundleHash: first.root.root_hash,
          expectedBundleGeneration: "1",
          now,
        }),
      ),
    ).toEqual(first.readiness);
  });

  it("fails closed if the denominator bytes or pinned source files drift", () => {
    const denominatorBytes = Uint8Array.from(readFileSync(denominatorPath));
    const tampered = Uint8Array.from([...denominatorBytes, 0x20]);
    expect(
      Exit.isFailure(
        Effect.runSyncExit(
          compileMiberaFixtureGeneration({ denominatorBytes: tampered, now }, signer),
        ),
      ),
    ).toBe(true);

    expect(sha256Hex(denominatorBytes)).toBe(MIBERA_DENOMINATOR_BYTES_SHA256);
    expect(sha256Hex(Uint8Array.from(readFileSync("config.mibera.yaml")))).toBe(
      MIBERA_CONFIG_BYTES_SHA256,
    );
    expect(
      sha256Hex(Uint8Array.from(readFileSync("src/handlers/mibera-collection.ts"))),
    ).toBe(MIBERA_HANDLER_BYTES_SHA256);
    expect(
      sha256Hex(
        Uint8Array.from(readFileSync("src/belts/mibera/EventHandlers.mibera.ts")),
      ),
    ).toBe(MIBERA_ADAPTER_BYTES_SHA256);
  });
});
