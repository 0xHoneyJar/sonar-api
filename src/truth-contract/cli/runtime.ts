import {
  Cause,
  Effect,
  Exit,
  Layer,
  ManagedRuntime,
  Option,
} from "effect";

import {
  TruthCompatibilityError,
  TruthIntegrityError,
  TruthTransportError,
  TruthTrustError,
} from "../errors.js";
import {
  TruthInspector,
  type SonarTruthStatusV1,
  type TruthInspectorService,
} from "../status-reader.js";
import type {
  SonarTruthTargetState,
} from "../schemas/inspection.js";
import type {
  TruthEnvironmentId,
  TruthIsoTimestamp,
} from "../schemas/common.js";
import {
  SONAR_TRUTH_MAX_INPUT_BYTES,
  SONAR_TRUTH_MAX_OUTPUT_BYTES,
  SONAR_TRUTH_OPERATION_MILLISECONDS,
  encodedBytes,
  makeBoundaryEnvelope,
  makeEnvelope,
  type SonarTruthCommand,
  type SonarTruthEnvelopeV1,
  type SonarTruthResult,
} from "./contract.js";

export type SonarTruthInvocation =
  | {
      readonly command: "status";
      readonly collectionId: string;
      readonly environment: TruthEnvironmentId;
      readonly targetState: SonarTruthTargetState;
      readonly now: TruthIsoTimestamp;
    }
  | {
      readonly command: "verify";
      readonly rootRef: string;
      readonly targetState: SonarTruthTargetState;
      readonly now: TruthIsoTimestamp;
    }
  | {
      readonly command: "explain";
      readonly artifactHash: string;
      readonly targetState: SonarTruthTargetState;
      readonly now: TruthIsoTimestamp;
    }
  | {
      readonly command: "dependencies";
      readonly artifactHash: string;
      readonly targetState: SonarTruthTargetState;
      readonly now: TruthIsoTimestamp;
    }
  | {
      readonly command: "rebuild-status";
      readonly environment: TruthEnvironmentId;
      readonly targetState: SonarTruthTargetState;
      readonly now: TruthIsoTimestamp;
    };

class TruthBoundaryTimeout {
  readonly _tag = "TruthBoundaryTimeout";
}

export const makeSonarTruthRuntime = (
  layer: Layer.Layer<TruthInspectorService, never, never>,
) => ManagedRuntime.make(layer);

export type SonarTruthRuntime = ReturnType<typeof makeSonarTruthRuntime>;

const operationFor = (
  invocation: SonarTruthInvocation,
): Effect.Effect<
  {
    readonly target: SonarTruthStatusV1;
    readonly result:
      | SonarTruthStatusV1
      | Exclude<
          SonarTruthResult,
          { readonly cache_age_seconds: string } | null
        >;
  },
  unknown,
  TruthInspectorService
> =>
  Effect.gen(function* () {
    const inspector = yield* TruthInspector;
    const target =
      invocation.command === "status"
        ? yield* inspector.status(
            invocation.collectionId,
            invocation.environment,
            invocation.targetState,
            invocation.now,
          )
        : yield* inspector.evaluateTarget(
            invocation.targetState,
            invocation.now,
          );
    if (!target.target_ready || invocation.command === "status") {
      return { target, result: target };
    }
    switch (invocation.command) {
      case "verify":
        return { target, result: yield* inspector.verify(invocation.rootRef) };
      case "explain":
        return {
          target,
          result: yield* inspector.explain(invocation.artifactHash, invocation.now),
        };
      case "dependencies":
        return {
          target,
          result: yield* inspector.dependencies(
            invocation.artifactHash,
            invocation.now,
          ),
        };
      case "rebuild-status":
        return {
          target,
          result: yield* inspector.rebuild(invocation.environment),
        };
    }
  });

const findingsForStatus = (
  result: SonarTruthStatusV1,
) =>
  result.target_ready
    ? []
    : result.reason_codes.map((code) => ({
        code,
        owner: result.blocking_owner,
        deadline: result.blocking_deadline,
      }));

const successEnvelope = (
  invocation: SonarTruthInvocation,
  execution: {
    readonly target: SonarTruthStatusV1;
    readonly result:
    | SonarTruthStatusV1
      | Exclude<SonarTruthResult, { readonly cache_age_seconds: string } | null>;
  },
): SonarTruthEnvelopeV1 => {
  const { target: status, result } = execution;
  if (!status.target_ready || invocation.command === "status") {
    const cacheAgeSeconds = Math.max(
      0,
      Math.floor(
        (new Date(invocation.now).getTime() -
          new Date(status.snapshot.cached_at).getTime()) /
          1_000,
      ),
    ).toString();
    const output = {
      ...status,
      cache_age_seconds: cacheAgeSeconds,
    };
    return makeEnvelope({
      schema_version: 1,
      protocol: "sonar-truth-cli/v1",
      command: invocation.command,
      target_state: invocation.targetState,
      outcome: status.target_ready ? "READY" : "FINDINGS",
      exit_code: status.target_ready ? 0 : 2,
      production_authority: false,
      data: output,
      findings: findingsForStatus(status),
    });
  }
  if (
    "target_ready" in result
  ) {
    return makeBoundaryEnvelope(
      invocation.command,
      6,
      "INVARIANT_FAILURE",
      "COMMAND_RESULT_MISMATCH",
      invocation.targetState,
    );
  }
  if (
    invocation.command === "rebuild-status" &&
    "equal" in result &&
    result.equal === false
  ) {
    return makeEnvelope({
      schema_version: 1,
      protocol: "sonar-truth-cli/v1",
      command: invocation.command,
      target_state: invocation.targetState,
      outcome: "INVARIANT_FAILURE",
      exit_code: 6,
      production_authority: false,
      data: result,
      findings: [
        {
          code: "PROJECTION_DIGEST_MISMATCH",
          owner: null,
          deadline: null,
        },
      ],
    });
  }
  return makeEnvelope({
    schema_version: 1,
    protocol: "sonar-truth-cli/v1",
    command: invocation.command,
    target_state: invocation.targetState,
    outcome: "READY",
    exit_code: 0,
    production_authority: false,
    data: result,
    findings: [],
  });
};

const failureEnvelope = (
  command: SonarTruthCommand,
  targetState: SonarTruthTargetState,
  failure: unknown,
): SonarTruthEnvelopeV1 => {
  if (failure instanceof TruthBoundaryTimeout) {
    return makeBoundaryEnvelope(
      command,
      6,
      "INVARIANT_FAILURE",
      "RESOURCE_LIMIT",
      targetState,
    );
  }
  if (failure instanceof TruthTrustError) {
    return makeBoundaryEnvelope(
      command,
      4,
      "TRUST_FAILURE",
      "TRUST_VERIFICATION_FAILED",
      targetState,
    );
  }
  if (failure instanceof TruthTransportError) {
    return makeBoundaryEnvelope(
      command,
      5,
      "TRANSPORT_FAILURE",
      "STATUS_SOURCE_UNAVAILABLE",
      targetState,
    );
  }
  if (failure instanceof TruthCompatibilityError) {
    const validFinding =
      command === "explain" || command === "dependencies";
    return makeBoundaryEnvelope(
      command,
      validFinding ? 2 : 3,
      validFinding ? "FINDINGS" : "UNSUPPORTED",
      validFinding ? "ARTIFACT_NOT_FOUND" : "UNSUPPORTED_CAPABILITY",
      targetState,
    );
  }
  if (failure instanceof TruthIntegrityError) {
    return makeBoundaryEnvelope(
      command,
      6,
      "INVARIANT_FAILURE",
      "INTEGRITY_INVARIANT_FAILED",
      targetState,
    );
  }
  return makeBoundaryEnvelope(
    command,
    6,
    "INVARIANT_FAILURE",
    "INTERNAL_INVARIANT_FAILED",
    targetState,
  );
};

export interface SonarTruthExecutionOptions {
  readonly maximumInputBytes?: number;
  readonly maximumOutputBytes?: number;
  readonly timeoutMilliseconds?: number;
}

export const executeSonarTruthInvocation = async (
  runtime: SonarTruthRuntime,
  invocation: SonarTruthInvocation,
  options: SonarTruthExecutionOptions = {},
): Promise<SonarTruthEnvelopeV1> => {
  const maximumInputBytes =
    options.maximumInputBytes ?? SONAR_TRUTH_MAX_INPUT_BYTES;
  const maximumOutputBytes =
    options.maximumOutputBytes ?? SONAR_TRUTH_MAX_OUTPUT_BYTES;
  if (encodedBytes(invocation) > maximumInputBytes) {
    return makeBoundaryEnvelope(
      invocation.command,
      6,
      "INVARIANT_FAILURE",
      "INPUT_RESOURCE_LIMIT",
      invocation.targetState,
    );
  }
  const bounded = operationFor(invocation).pipe(
    Effect.timeoutFail({
      duration:
        options.timeoutMilliseconds ?? SONAR_TRUTH_OPERATION_MILLISECONDS,
      onTimeout: () => new TruthBoundaryTimeout(),
    }),
  );
  const exit = await runtime.runPromiseExit(bounded);
  const envelope = Exit.isSuccess(exit)
    ? successEnvelope(invocation, exit.value)
    : (() => {
        const failure = Cause.failureOption(exit.cause);
        return failureEnvelope(
          invocation.command,
          invocation.targetState,
          Option.isSome(failure) ? failure.value : null,
        );
      })();
  if (encodedBytes(envelope) > maximumOutputBytes) {
    return makeBoundaryEnvelope(
      invocation.command,
      6,
      "INVARIANT_FAILURE",
      "OUTPUT_RESOURCE_LIMIT",
      invocation.targetState,
    );
  }
  return envelope;
};
