/**
 * Mission 5 — coverage-aware readiness evidence (pure evaluator).
 *
 * Rows alone are never sufficient. A job is ready only when coverage of the
 * required floor (and config/capability binding) is proven. Zero-holder
 * collections may complete via sync_marker when coverage is proven.
 */

export type CoverageMode = "full_from_required_floor" | "partial_operator_approved";

export interface CoverageFloorRecord {
  chainId: number;
  contract: string;
  requiredFloor: number;
  coverageMode: CoverageMode;
  configDigest: string;
  capabilityId: string;
  capabilityVersion: string;
}

export interface CoverageObservation {
  physicalJobId: string;
  deploymentId: string;
  chainId: number;
  contract: string;
  configDigest: string;
  capabilityId: string;
  capabilityVersion: string;
  requiredFloor: number;
  coverageMode: CoverageMode;
  /** Latest processed block for the chain (or per-contract if available). */
  processedThroughBlock: number;
  /** Required end of the coverage window (tip or fixed golden end). */
  requiredThroughBlock: number;
  tokenRows: number;
  holderRows: number;
  observedAtMs: number;
  /** When true, Hasura/chain progress could not be read — never green. */
  sensorFailed?: boolean;
}

export type CoverageReadyDecision =
  | {
      ready: true;
      evidence: {
        state: "ready";
        kind: "sync_marker" | "indexed_rows";
        observedAtMs: number;
        coverage: {
          requiredFloor: number;
          processedThroughBlock: number;
          requiredThroughBlock: number;
          coverageMode: CoverageMode;
          configDigest: string;
          tokenRows: number;
          holderRows: number;
        };
      };
    }
  | {
      ready: false;
      reason:
        | "sensor_failed"
        | "wrong_config_digest"
        | "wrong_capability"
        | "insufficient_processed_through"
        | "partial_rows_without_coverage"
        | "coverage_mode_unsupported";
    };

export function evaluateCoverageReadiness(obs: CoverageObservation): CoverageReadyDecision {
  if (obs.sensorFailed) {
    return { ready: false, reason: "sensor_failed" };
  }

  if (obs.coverageMode !== "full_from_required_floor" && obs.coverageMode !== "partial_operator_approved") {
    return { ready: false, reason: "coverage_mode_unsupported" };
  }

  // Partial mode still requires an explicit operator-approved floor binding;
  // it must not complete from orphan rows alone.
  if (obs.processedThroughBlock < obs.requiredThroughBlock) {
    return { ready: false, reason: "insufficient_processed_through" };
  }

  if (obs.processedThroughBlock < obs.requiredFloor) {
    return { ready: false, reason: "insufficient_processed_through" };
  }

  const kind = obs.tokenRows > 0 || obs.holderRows > 0 ? "indexed_rows" : "sync_marker";

  return {
    ready: true,
    evidence: {
      state: "ready",
      kind,
      observedAtMs: obs.observedAtMs,
      coverage: {
        requiredFloor: obs.requiredFloor,
        processedThroughBlock: obs.processedThroughBlock,
        requiredThroughBlock: obs.requiredThroughBlock,
        coverageMode: obs.coverageMode,
        configDigest: obs.configDigest,
        tokenRows: obs.tokenRows,
        holderRows: obs.holderRows,
      },
    },
  };
}

/**
 * Bind a job's declared digests to a floor record. Mismatch → not ready.
 * Call before evaluateCoverageReadiness when digests are known.
 */
export function bindFloorToObservation(args: {
  floor: CoverageFloorRecord;
  observation: Omit<
    CoverageObservation,
    "requiredFloor" | "coverageMode" | "configDigest" | "capabilityId" | "capabilityVersion"
  > & {
    configDigest: string;
    capabilityId: string;
    capabilityVersion: string;
  };
}): CoverageReadyDecision | CoverageObservation {
  const { floor, observation } = args;
  if (floor.configDigest !== observation.configDigest) {
    return { ready: false, reason: "wrong_config_digest" };
  }
  if (
    floor.capabilityId !== observation.capabilityId ||
    floor.capabilityVersion !== observation.capabilityVersion
  ) {
    return { ready: false, reason: "wrong_capability" };
  }
  if (floor.chainId !== observation.chainId || floor.contract !== observation.contract) {
    return { ready: false, reason: "wrong_capability" };
  }

  return {
    ...observation,
    requiredFloor: floor.requiredFloor,
    coverageMode: floor.coverageMode,
    configDigest: floor.configDigest,
    capabilityId: floor.capabilityId,
    capabilityVersion: floor.capabilityVersion,
  };
}

/** Rows from an older partial index must not satisfy a new job without coverage. */
export function rejectOrphanRowsWithoutCoverage(args: {
  tokenRows: number;
  holderRows: number;
  processedThroughBlock: number;
  requiredFloor: number;
}): boolean {
  const hasRows = args.tokenRows > 0 || args.holderRows > 0;
  if (!hasRows) return false;
  return args.processedThroughBlock < args.requiredFloor;
}
