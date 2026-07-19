import { Cli, z } from "incur";

import type {
  TruthEnvironmentId,
  TruthIsoTimestamp,
} from "../schemas/common.js";
import type { SonarTruthTargetState } from "../schemas/inspection.js";
import {
  SONAR_TRUTH_COMMANDS,
  SonarTruthEnvelopeSchema,
  makeBoundaryEnvelope,
  normalizeTargetState,
  type SonarTruthCommand,
  type SonarTruthEnvelopeV1,
} from "./contract.js";
import {
  executeSonarTruthInvocation,
  type SonarTruthExecutionOptions,
  type SonarTruthInvocation,
  type SonarTruthRuntime,
} from "./runtime.js";

export interface TruthInvocationGuard {
  readonly acquire: (
    command: SonarTruthCommand,
  ) => (() => void) | null;
}

export interface SonarTruthCommandOptions {
  readonly execution?: SonarTruthExecutionOptions;
  readonly guard?: TruthInvocationGuard;
  readonly now?: () => TruthIsoTimestamp;
  readonly onEnvelope?: (envelope: SonarTruthEnvelopeV1) => void;
}

interface IncurRunContext {
  readonly options: Record<string, unknown>;
  readonly ok: (
    data: SonarTruthEnvelopeV1,
    meta?: unknown,
  ) => never;
}

interface IncurCommandDefinition {
  readonly description: string;
  readonly options: z.ZodObject<z.ZodRawShape>;
  readonly output: typeof SonarTruthEnvelopeSchema;
  readonly run: (context: IncurRunContext) => Promise<never>;
}

const looseOptions = <T extends z.ZodRawShape>(shape: T) =>
  z.object(shape).passthrough();

const targetStateFrom = (
  input: unknown,
): SonarTruthTargetState | SonarTruthEnvelopeV1 => {
  const targetState = normalizeTargetState(input);
  if (targetState !== null) return targetState;
  return makeBoundaryEnvelope(
    "status",
    1,
    "USAGE",
    input === undefined ? "TARGET_STATE_REQUIRED" : "INVALID_TARGET_STATE",
  );
};

const environmentFrom = (
  input: unknown,
): TruthEnvironmentId | null =>
  input === "development" || input === "staging" || input === "production"
    ? input
    : null;

const boundedString = (
  input: unknown,
  maximumLength = 512,
): string | null =>
  typeof input === "string" &&
  input.length > 0 &&
  input.length <= maximumLength
    ? input
    : null;

const hasUnexpectedOptions = (
  options: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
): boolean =>
  Object.keys(options).some((key) => !allowed.includes(key));

const digestString = (input: unknown): string | null =>
  typeof input === "string" && /^[0-9a-f]{64}$/.test(input)
    ? input
    : null;

const usage = (
  command: SonarTruthCommand,
  targetState: SonarTruthTargetState | null,
  code: string,
) =>
  makeBoundaryEnvelope(command, 1, "USAGE", code, targetState);

export const makeSonarTruthCommandDefinitions = (
  runtime: SonarTruthRuntime,
  options: SonarTruthCommandOptions = {},
): ReadonlyMap<SonarTruthCommand, IncurCommandDefinition> => {
  const currentTime = () =>
    options.now?.() ?? (new Date().toISOString() as TruthIsoTimestamp);
  const emit = async (
    invocation: SonarTruthInvocation | SonarTruthEnvelopeV1,
  ): Promise<SonarTruthEnvelopeV1> => {
    if ("schema_version" in invocation) {
      options.onEnvelope?.(invocation);
      return invocation;
    }
    const release = options.guard?.acquire(invocation.command);
    if (options.guard !== undefined && release === null) {
      const rejected = makeBoundaryEnvelope(
        invocation.command,
        6,
        "INVARIANT_FAILURE",
        "MCP_TOOL_RATE_LIMIT",
        invocation.targetState,
      );
      options.onEnvelope?.(rejected);
      return rejected;
    }
    try {
      const envelope = await executeSonarTruthInvocation(
        runtime,
        invocation,
        options.execution,
      );
      options.onEnvelope?.(envelope);
      return envelope;
    } finally {
      release?.();
    }
  };

  const status: IncurCommandDefinition = {
    description:
      "Inspect one collection at an explicit lifecycle target using staged signed truth.",
    options: looseOptions({
      collection: z.unknown().optional(),
      environment: z.unknown().optional(),
      targetState: z.unknown().optional(),
    }),
    output: SonarTruthEnvelopeSchema,
    async run(c) {
      if (
        hasUnexpectedOptions(c.options, [
          "collection",
          "environment",
          "targetState",
        ])
      ) {
        return c.ok(usage("status", null, "UNKNOWN_OPTION"));
      }
      const target = targetStateFrom(c.options.targetState);
      if (typeof target !== "string") {
        return c.ok({
          ...target,
          command: "status",
        });
      }
      const collectionId = boundedString(c.options.collection, 128);
      const environment = environmentFrom(c.options.environment);
      return c.ok(
        await emit(
          collectionId === null
            ? usage("status", target, "COLLECTION_REQUIRED")
            : environment === null
              ? usage("status", target, "ENVIRONMENT_REQUIRED")
              : {
                  command: "status",
                  collectionId,
                  environment,
                  targetState: target,
                  now: currentTime(),
                },
        ),
      );
    },
  };

  const verify: IncurCommandDefinition = {
    description: "Verify a signed root reference without mutation.",
    options: looseOptions({
      root: z.unknown().optional(),
      targetState: z.unknown().optional(),
    }),
    output: SonarTruthEnvelopeSchema,
    async run(c) {
      if (hasUnexpectedOptions(c.options, ["root", "targetState"])) {
        return c.ok(usage("verify", null, "UNKNOWN_OPTION"));
      }
      const target = targetStateFrom(c.options.targetState);
      if (typeof target !== "string") {
        return c.ok({ ...target, command: "verify" });
      }
      const rootRef = boundedString(c.options.root);
      return c.ok(
        await emit(
          rootRef === null
            ? usage("verify", target, "ROOT_REQUIRED")
            : {
                command: "verify",
                rootRef,
                targetState: target,
                now: currentTime(),
              },
        ),
      );
    },
  };

  const explain: IncurCommandDefinition = {
    description: "Explain one artifact and its transitive dependency count.",
    options: looseOptions({
      artifact: z.unknown().optional(),
      targetState: z.unknown().optional(),
    }),
    output: SonarTruthEnvelopeSchema,
    async run(c) {
      if (hasUnexpectedOptions(c.options, ["artifact", "targetState"])) {
        return c.ok(usage("explain", null, "UNKNOWN_OPTION"));
      }
      const target = targetStateFrom(c.options.targetState);
      if (typeof target !== "string") {
        return c.ok({ ...target, command: "explain" });
      }
      const artifactHash = digestString(c.options.artifact);
      return c.ok(
        await emit(
          artifactHash === null
            ? usage("explain", target, "ARTIFACT_REQUIRED")
            : {
                command: "explain",
                artifactHash,
                targetState: target,
                now: currentTime(),
              },
        ),
      );
    },
  };

  const dependencies: IncurCommandDefinition = {
    description:
      "Return the bounded transitive dependency closure for one artifact.",
    options: looseOptions({
      artifact: z.unknown().optional(),
      targetState: z.unknown().optional(),
    }),
    output: SonarTruthEnvelopeSchema,
    async run(c) {
      if (hasUnexpectedOptions(c.options, ["artifact", "targetState"])) {
        return c.ok(usage("dependencies", null, "UNKNOWN_OPTION"));
      }
      const target = targetStateFrom(c.options.targetState);
      if (typeof target !== "string") {
        return c.ok({ ...target, command: "dependencies" });
      }
      const artifactHash = digestString(c.options.artifact);
      return c.ok(
        await emit(
          artifactHash === null
            ? usage("dependencies", target, "ARTIFACT_REQUIRED")
            : {
                command: "dependencies",
                artifactHash,
                targetState: target,
                now: currentTime(),
              },
        ),
      );
    },
  };

  const rebuild: IncurCommandDefinition = {
    description:
      "Rebuild the staged status projection and compare its canonical digest.",
    options: looseOptions({
      environment: z.unknown().optional(),
      targetState: z.unknown().optional(),
    }),
    output: SonarTruthEnvelopeSchema,
    async run(c) {
      if (hasUnexpectedOptions(c.options, ["environment", "targetState"])) {
        return c.ok(usage("rebuild-status", null, "UNKNOWN_OPTION"));
      }
      const target = targetStateFrom(c.options.targetState);
      if (typeof target !== "string") {
        return c.ok({ ...target, command: "rebuild-status" });
      }
      const environment = environmentFrom(c.options.environment);
      return c.ok(
        await emit(
          environment === null
            ? usage("rebuild-status", target, "ENVIRONMENT_REQUIRED")
            : {
                command: "rebuild-status",
                environment,
                targetState: target,
                now: currentTime(),
              },
        ),
      );
    },
  };

  return new Map([
    ["status", status],
    ["verify", verify],
    ["explain", explain],
    ["dependencies", dependencies],
    ["rebuild-status", rebuild],
  ]);
};

export const makeSonarTruthCli = (
  runtime: SonarTruthRuntime,
  options: SonarTruthCommandOptions = {},
) => {
  const definitions = makeSonarTruthCommandDefinitions(runtime, options);
  const cli = Cli.create("sonar-truth", {
    version: "1.0.0",
    format: "json",
    description:
      "Read-only Sonar truth inspection. Machine commands require --target-state.",
  });
  // Incur's command output type materializes arrays as mutable even when the
  // canonical Effect service returns readonly arrays. Runtime output is still
  // validated by SonarTruthEnvelopeSchema before it reaches this adapter.
  cli.command("status", definitions.get("status")! as never);
  cli.command("verify", definitions.get("verify")! as never);
  cli.command("explain", definitions.get("explain")! as never);
  cli.command("dependencies", definitions.get("dependencies")! as never);
  cli.command("rebuild-status", definitions.get("rebuild-status")! as never);
  return { cli, definitions };
};

export const isSonarTruthCommand = (
  input: string | undefined,
): input is SonarTruthCommand =>
  input !== undefined &&
  (SONAR_TRUTH_COMMANDS as readonly string[]).includes(input);
