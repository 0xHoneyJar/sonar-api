import { Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";

import {
  TRUTH_CONTRACT_PROTOCOL,
  TRUTH_NORMATIVE_OBJECT_KINDS,
  TruthDecodeError,
  TruthIntegrityError,
  TruthTrustError,
  canonicalizeTruthJson,
  compileTruthBundleRoot,
  parseTruthBundleRootBytes,
  truthRootSigningBytes,
  verifyTruthBundleRoot,
  verifyTruthBundleRootBytes,
} from "../src/truth-contract/index.js";
import {
  fixtureSigners,
  jcsCanonicalize,
  sha256Hex,
  verifyVendoredTrustEnvelopeProtocolDigest,
} from "../src/collection-resolver/trust-protocol.js";
import golden from "./fixtures/truth-contract/golden-root-v1.json";

const expectFailure = <A, E>(effect: Effect.Effect<A, E>): E => {
  const exit = Effect.runSyncExit(effect);
  if (Exit.isSuccess(exit)) throw new Error("expected typed failure");
  if (exit.cause._tag !== "Fail") throw new Error(`expected Fail, got ${exit.cause._tag}`);
  return exit.cause.error;
};

const signer = fixtureSigners().sonarPrimary;
const rawUnsignedRoot = () => {
  const objects = [...TRUTH_NORMATIVE_OBJECT_KINDS].reverse().map((kind) => ({
    kind,
    media_type: "application/json",
    sha256: sha256Hex(`fixture:${kind}`),
    byte_length: "100",
  }));
  const byKind = new Map(objects.map((object) => [object.kind, object]));
  return {
    schema_version: 1,
    protocol: TRUTH_CONTRACT_PROTOCOL,
    environment: "staging",
    generation: "9007199254740992",
    supersedes_generation: "9007199254740991",
    objects,
    issuer: {
      service_id: "sonar-api",
      key_id: signer.keyId,
    },
    issued_at: "2026-07-19T03:00:00.000Z",
    valid_from: "2026-07-19T03:00:00.000Z",
    compatibility_version: "sonar-score.v1",
    authority_matrix_hash: byKind.get("authority_matrix")!.sha256,
    security_profile_hash: byKind.get("security_profile")!.sha256,
  };
};

const compileFixture = () =>
  Effect.runSync(compileTruthBundleRoot(rawUnsignedRoot(), signer));

const verifyOptions = {
  expectedEnvironment: "staging" as const,
  expectedKeyId: signer.keyId,
  publicKeyHex: signer.publicKeyHex(),
  trustedGenerationHighWater: "9007199254740991" as never,
  now: "2026-07-19T03:00:00.000Z" as never,
};

describe("truth bundle canonical compiler", () => {
  it("pins the vendored trust primitive bytes before using their vectors", () => {
    const pin = Effect.runSync(verifyVendoredTrustEnvelopeProtocolDigest());
    expect(pin.actual).toBe(pin.expected);
  });

  it("shares exact RFC 8785 Unicode and key-order bytes", () => {
    const left = Effect.runSync(canonicalizeTruthJson(golden.jcs_input));
    const right = Effect.runSync(canonicalizeTruthJson({ a: "é", z: "雪" }));
    expect(left).toBe(golden.jcs_canonical);
    expect(jcsCanonicalize(golden.jcs_input)).toBe(golden.jcs_canonical);
    expect(sha256Hex(left)).toBe(golden.jcs_sha256);
    expect(new TextEncoder().encode(left)).toEqual(new TextEncoder().encode(right));
  });

  it("compiles a closed, sorted, non-circular signed root with a stable vector", () => {
    const root = compileFixture();
    expect(root.unsigned_root.objects.map((object) => object.kind)).toEqual(
      [...TRUTH_NORMATIVE_OBJECT_KINDS].sort(),
    );
    expect(root.root_hash).toBe(golden.root_hash);
    expect(root.signature).toBe(golden.signature);
    expect(signer.publicKeyHex()).toBe(golden.fixture_public_key_hex);
    expect(
      Buffer.from(
        truthRootSigningBytes(
          root.unsigned_root.environment,
          root.unsigned_root.generation,
          root.root_hash,
        ),
      ).toString("hex"),
    ).toBe(golden.signing_domain_hex);
    expect(Effect.runSync(verifyTruthBundleRoot(root, verifyOptions))).toEqual(root);
  });

  it("rejects circular and self-hash inputs", () => {
    const circular: Record<string, unknown> = rawUnsignedRoot();
    circular.loop = circular;
    expect(expectFailure(compileTruthBundleRoot(circular, signer))).toBeInstanceOf(
      TruthIntegrityError,
    );
    expectFailure(
      compileTruthBundleRoot(
        { ...rawUnsignedRoot(), root_hash: "0".repeat(64) },
        signer,
      ),
    );
  });

  it("rejects missing, duplicate, and oversized closure objects", () => {
    const missing = rawUnsignedRoot();
    missing.objects.pop();
    expect(expectFailure(compileTruthBundleRoot(missing, signer))).toBeInstanceOf(
      TruthDecodeError,
    );

    const duplicate = rawUnsignedRoot();
    duplicate.objects[0] = { ...duplicate.objects[1] };
    expect(expectFailure(compileTruthBundleRoot(duplicate, signer))).toBeInstanceOf(
      TruthIntegrityError,
    );

    const oversized = rawUnsignedRoot();
    oversized.objects[0]!.byte_length = "4194305";
    expect(expectFailure(compileTruthBundleRoot(oversized, signer))).toBeInstanceOf(
      TruthIntegrityError,
    );

    const wrongPin = rawUnsignedRoot();
    wrongPin.authority_matrix_hash = "0".repeat(64);
    expect(expectFailure(compileTruthBundleRoot(wrongPin, signer))).toBeInstanceOf(
      TruthIntegrityError,
    );
  });

  it("rejects tamper, wrong environment, replay, issuer substitution, and signature changes", () => {
    const root = compileFixture();
    const tampered = structuredClone(root);
    tampered.unsigned_root.compatibility_version = "sonar-score.v2" as never;
    expect(expectFailure(verifyTruthBundleRoot(tampered, verifyOptions))).toBeInstanceOf(
      TruthIntegrityError,
    );

    expectFailure(
      verifyTruthBundleRoot(root, {
        ...verifyOptions,
        expectedEnvironment: "production",
      }),
    );
    expectFailure(
      verifyTruthBundleRoot(root, {
        ...verifyOptions,
        trustedGenerationHighWater: "9007199254740993" as never,
      }),
    );
    expectFailure(
      verifyTruthBundleRoot(root, {
        ...verifyOptions,
        expectedKeyId: "substituted-key",
      }),
    );

    const modifiedSignature = structuredClone(root);
    modifiedSignature.signature = `${root.signature[0] === "A" ? "B" : "A"}${root.signature.slice(1)}` as never;
    expect(
      expectFailure(verifyTruthBundleRoot(modifiedSignature, verifyOptions)),
    ).toBeInstanceOf(TruthTrustError);

    const futureInput = rawUnsignedRoot();
    futureInput.valid_from = "2026-07-19T04:00:01.000Z";
    const futureRoot = Effect.runSync(compileTruthBundleRoot(futureInput, signer));
    expect(
      expectFailure(verifyTruthBundleRoot(futureRoot, verifyOptions)),
    ).toBeInstanceOf(TruthTrustError);
  });

  it("checks signed-root bytes before parsing", () => {
    const root = compileFixture();
    const canonicalBytes = new TextEncoder().encode(jcsCanonicalize(root));
    expect(
      Effect.runSync(verifyTruthBundleRootBytes(canonicalBytes, verifyOptions)),
    ).toEqual(root);

    const oversized = new Uint8Array(256 * 1024 + 1);
    expect(expectFailure(parseTruthBundleRootBytes(oversized))).toBeInstanceOf(
      TruthDecodeError,
    );
    expectFailure(parseTruthBundleRootBytes(new TextEncoder().encode("{not-json")));
    expectFailure(
      parseTruthBundleRootBytes(
        new TextEncoder().encode(
          `{"unsigned_root":{},"root_hash":"${"0".repeat(64)}","root_hash":"${"1".repeat(64)}","signature":"${"A".repeat(86)}"}`,
        ),
      ),
    );
  });
});
