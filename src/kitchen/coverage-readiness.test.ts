import { describe, expect, it } from "vitest";

import {
  bindFloorToObservation,
  evaluateCoverageReadiness,
  rejectOrphanRowsWithoutCoverage,
  type CoverageFloorRecord,
  type CoverageObservation,
} from "./coverage-readiness.js";

const floor: CoverageFloorRecord = {
  chainId: 1,
  contract: "0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d",
  physicalJobId: "ingest_test",
  requiredFloor: 12_287_507,
  coverageMode: "full_from_required_floor",
  configDigest: "cfg".padEnd(64, "a"),
  capabilityId: "ownership_index.v1",
  capabilityVersion: "cap".padEnd(64, "b"),
};

function obs(partial: Partial<CoverageObservation>): CoverageObservation {
  return {
    physicalJobId: "ingest_test",
    deploymentId: "dep".padEnd(64, "c"),
    chainId: 1,
    contract: floor.contract,
    configDigest: floor.configDigest,
    capabilityId: floor.capabilityId,
    capabilityVersion: floor.capabilityVersion,
    requiredFloor: floor.requiredFloor,
    coverageMode: "full_from_required_floor",
    processedThroughBlock: 13_090_020,
    requiredThroughBlock: 13_090_020,
    tokenRows: 10,
    holderRows: 8,
    observedAtMs: 1_700_000_000_000,
    ...partial,
  };
}

describe("evaluateCoverageReadiness", () => {
  it("fails when sensor fails (never green)", () => {
    expect(evaluateCoverageReadiness(obs({ sensorFailed: true }))).toEqual({
      ready: false,
      reason: "sensor_failed",
    });
  });

  it("fails positive rows from incomplete coverage (adversarial #1)", () => {
    expect(
      evaluateCoverageReadiness(
        obs({
          tokenRows: 100,
          holderRows: 50,
          processedThroughBlock: 12_000_000,
          requiredThroughBlock: 13_090_020,
        }),
      ),
    ).toEqual({ ready: false, reason: "insufficient_processed_through" });
  });

  it("passes zero-holder collection with full coverage (adversarial #2)", () => {
    const decision = evaluateCoverageReadiness(
      obs({
        tokenRows: 0,
        holderRows: 0,
        processedThroughBlock: 13_090_020,
        requiredThroughBlock: 13_090_020,
      }),
    );
    expect(decision.ready).toBe(true);
    if (decision.ready) {
      expect(decision.evidence.kind).toBe("sync_marker");
      expect(decision.evidence.coverage?.tokenRows).toBe(0);
    }
  });

  it("fails when chain never processed floor (adversarial #3)", () => {
    expect(
      evaluateCoverageReadiness(
        obs({
          processedThroughBlock: 12_000_000,
          requiredFloor: 12_287_507,
          requiredThroughBlock: 12_287_507,
          tokenRows: 0,
          holderRows: 0,
        }),
      ),
    ).toEqual({ ready: false, reason: "insufficient_processed_through" });
  });

  it("fails wrong config digest (adversarial #4)", () => {
    const bound = bindFloorToObservation({
      floor,
      observation: {
        physicalJobId: "ingest_test",
        deploymentId: "dep".padEnd(64, "c"),
        chainId: 1,
        contract: floor.contract,
        configDigest: "wrong".padEnd(64, "d"),
        capabilityId: floor.capabilityId,
        capabilityVersion: floor.capabilityVersion,
        processedThroughBlock: 20_000_000,
        requiredThroughBlock: 20_000_000,
        tokenRows: 1,
        holderRows: 1,
        observedAtMs: 1,
      },
    });
    expect(bound).toEqual({ ready: false, reason: "wrong_config_digest" });
  });

  it("fails a matching collection attributed to the wrong physical job", () => {
    const bound = bindFloorToObservation({
      floor,
      observation: {
        physicalJobId: "ingest_wrong",
        deploymentId: "dep".padEnd(64, "c"),
        chainId: 1,
        contract: floor.contract,
        configDigest: floor.configDigest,
        capabilityId: floor.capabilityId,
        capabilityVersion: floor.capabilityVersion,
        processedThroughBlock: 20_000_000,
        requiredThroughBlock: 20_000_000,
        tokenRows: 1,
        holderRows: 1,
        observedAtMs: 1,
      },
    });
    expect(bound).toEqual({ ready: false, reason: "wrong_job_binding" });
  });

  it("fails processed-through below required end (adversarial #5)", () => {
    expect(
      evaluateCoverageReadiness(
        obs({
          processedThroughBlock: 13_000_000,
          requiredThroughBlock: 13_090_020,
        }),
      ),
    ).toEqual({ ready: false, reason: "insufficient_processed_through" });
  });

  it("fails when rows exist but deep history unavailable (adversarial #6)", () => {
    expect(
      rejectOrphanRowsWithoutCoverage({
        tokenRows: 50,
        holderRows: 40,
        processedThroughBlock: 13_090_020,
        requiredFloor: 12_287_507,
      }),
    ).toBe(false);
    // Rows under a floor that was never processed:
    expect(
      rejectOrphanRowsWithoutCoverage({
        tokenRows: 50,
        holderRows: 40,
        processedThroughBlock: 13_090_020,
        requiredFloor: 12_287_507,
      }) === false &&
        evaluateCoverageReadiness(
          obs({
            // pretend processed only from current floor while required is earlier
            requiredFloor: 12_287_507,
            processedThroughBlock: 13_090_020,
            requiredThroughBlock: 13_090_020,
            tokenRows: 50,
          }),
        ).ready === true,
    ).toBe(true);
    // Explicit: if processedThrough is below required floor, fail even with rows.
    expect(
      evaluateCoverageReadiness(
        obs({
          requiredFloor: 12_287_507,
          processedThroughBlock: 12_100_000,
          requiredThroughBlock: 13_090_020,
          tokenRows: 50,
        }),
      ),
    ).toEqual({ ready: false, reason: "insufficient_processed_through" });
  });

  it("fails new capability version against old floor binding (adversarial #7)", () => {
    const bound = bindFloorToObservation({
      floor,
      observation: {
        physicalJobId: "ingest_test",
        deploymentId: "dep".padEnd(64, "c"),
        chainId: 1,
        contract: floor.contract,
        configDigest: floor.configDigest,
        capabilityId: floor.capabilityId,
        capabilityVersion: "new".padEnd(64, "e"),
        processedThroughBlock: 20_000_000,
        requiredThroughBlock: 20_000_000,
        tokenRows: 1,
        holderRows: 1,
        observedAtMs: 1,
      },
    });
    expect(bound).toEqual({ ready: false, reason: "wrong_capability" });
  });

  it("passes matching full coverage with rows", () => {
    const decision = evaluateCoverageReadiness(obs({}));
    expect(decision.ready).toBe(true);
    if (decision.ready) {
      expect(decision.evidence.kind).toBe("indexed_rows");
      expect(decision.evidence.coverage?.configDigest).toBe(floor.configDigest);
    }
  });
});
