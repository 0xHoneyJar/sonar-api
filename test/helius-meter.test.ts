import { beforeEach, describe, expect, it } from "vitest";
import {
  CREDIT_WEIGHTS,
  classifyRpcMethod,
  meter,
  meterSummary,
  resetMeter,
} from "../src/svm/helius-meter";

beforeEach(() => resetMeter());

describe("classifyRpcMethod", () => {
  it("classifies the DAS method family as das (10 credits), everything else as rpc (1 credit)", () => {
    expect(classifyRpcMethod("getAssetsByGroup")).toBe("das");
    expect(classifyRpcMethod("getAsset")).toBe("das");
    expect(classifyRpcMethod("searchAssets")).toBe("das");
    expect(classifyRpcMethod("getSlot")).toBe("rpc");
    expect(classifyRpcMethod("getAccountInfo")).toBe("rpc");
    expect(classifyRpcMethod("")).toBe("rpc");
  });
});

describe("meter + meterSummary", () => {
  it("counts calls per kind:method and prices them with the published weights", () => {
    meter("das", "getAssetsByGroup");
    meter("das", "getAssetsByGroup");
    meter("rpc", "getSlot");
    meter("enhanced", "address-history", 3);

    const s = meterSummary();
    expect(s.calls).toEqual({
      "das:getAssetsByGroup": 2,
      "rpc:getSlot": 1,
      "enhanced:address-history": 3,
    });
    expect(s.by_kind.das).toEqual({ calls: 2, estimated_credits: 2 * CREDIT_WEIGHTS.das });
    expect(s.by_kind.rpc).toEqual({ calls: 1, estimated_credits: 1 * CREDIT_WEIGHTS.rpc });
    expect(s.by_kind.enhanced).toEqual({ calls: 3, estimated_credits: 3 * CREDIT_WEIGHTS.enhanced });
    // 2×10 + 1×1 + 3×100 — Enhanced dominates even at low call counts (the KF-018 lesson)
    expect(s.estimated_credits).toBe(321);
  });

  it("starts empty and resets clean", () => {
    expect(meterSummary().estimated_credits).toBe(0);
    meter("das", "getAsset");
    expect(meterSummary().estimated_credits).toBe(CREDIT_WEIGHTS.das);
    resetMeter();
    expect(meterSummary()).toEqual({
      calls: {},
      by_kind: {
        rpc: { calls: 0, estimated_credits: 0 },
        das: { calls: 0, estimated_credits: 0 },
        enhanced: { calls: 0, estimated_credits: 0 },
      },
      estimated_credits: 0,
    });
  });

  it("never throws — pure counter (fail-soft is the contract for a meter inside a KF-018 crash path)", () => {
    expect(() => meter("rpc", "getSlot", 0)).not.toThrow();
    expect(() => meter("rpc", "weird/method:name")).not.toThrow();
    expect(meterSummary().calls["rpc:weird/method:name"]).toBe(1);
  });
});
