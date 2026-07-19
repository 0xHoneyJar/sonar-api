import { Context, Effect, Exit, Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  DecimalUint64,
  ReadyStatus,
  TRUTH_RESOURCE_LIMITS,
  TruthDecodeError,
  TruthEffectiveStatus,
  TruthRegistryStore,
  TruthSigner,
  decodeStrict,
  requireByteLimit,
} from "../src/truth-contract/index.js";

const expectFailure = <A, E>(effect: Effect.Effect<A, E>): E => {
  const exit = Effect.runSyncExit(effect);
  if (Exit.isSuccess(exit)) throw new Error("expected typed failure");
  if (exit.cause._tag !== "Fail") throw new Error(`expected Fail, got ${exit.cause._tag}`);
  return exit.cause.error;
};

describe("truth-contract strict schema boundary", () => {
  it.each(["01", "-1", "1.0", "1e3", "18446744073709551616"])(
    "rejects non-canonical uint64 value %s",
    (value) => {
      const failure = expectFailure(decodeStrict(DecimalUint64, "test.uint64", value));
      expect(failure).toBeInstanceOf(TruthDecodeError);
      expect(failure.boundary).toBe("test.uint64");
    },
  );

  it("accepts uint64 boundaries as strings and refuses unsafe JSON numbers", () => {
    expect(Effect.runSync(decodeStrict(DecimalUint64, "test.uint64", "9007199254740991"))).toBe(
      "9007199254740991",
    );
    expect(Effect.runSync(decodeStrict(DecimalUint64, "test.uint64", "9007199254740992"))).toBe(
      "9007199254740992",
    );
    expect(
      Effect.runSync(decodeStrict(DecimalUint64, "test.uint64", "18446744073709551615")),
    ).toBe("18446744073709551615");
    expectFailure(decodeStrict(DecimalUint64, "test.uint64", 9_007_199_254_740_992));
  });

  it("strict-decodes tagged status and refuses excess properties", () => {
    const valid = {
      _tag: "READY",
      reasons: ["coverage_complete"],
      evidence: [],
      evaluated_at: "2026-07-19T03:00:00.000Z",
      expires_at: "2026-07-19T04:00:00.000Z",
      invalidation_epoch: "1",
    };
    const decoded = Effect.runSync(
      decodeStrict(TruthEffectiveStatus, "test.status", valid),
    );
    expect(decoded).toBeInstanceOf(ReadyStatus);
    expectFailure(
      decodeStrict(TruthEffectiveStatus, "test.status", {
        ...valid,
        unexpected: true,
      }),
    );
    expectFailure(
      decodeStrict(TruthEffectiveStatus, "test.status", {
        ...valid,
        expires_at: valid.evaluated_at,
      }),
    );
  });

  it("returns a typed failure before oversized bytes reach deeper decoding", () => {
    expect(
      Effect.runSync(
        requireByteLimit(
          "root.bytes",
          TRUTH_RESOURCE_LIMITS.signedRootBytes,
          TRUTH_RESOURCE_LIMITS.signedRootBytes,
        ),
      ),
    ).toBeUndefined();
    const failure = expectFailure(
      requireByteLimit(
        "root.bytes",
        TRUTH_RESOURCE_LIMITS.signedRootBytes + 1,
        TRUTH_RESOURCE_LIMITS.signedRootBytes,
      ),
    );
    expect(failure).toBeInstanceOf(TruthDecodeError);
  });

  it("exports focused Effect service tags", () => {
    expect(Context.isTag(TruthRegistryStore)).toBe(true);
    expect(Context.isTag(TruthSigner)).toBe(true);
    expect(Schema.isSchema(TruthEffectiveStatus)).toBe(true);
  });
});
